use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};

use super::util::{decode_ansi, is_probably_text, safe_relative, MAX_PREVIEW_BYTES};
use super::{sevenz_impl, tar_impl, zip_impl, Kind, PreviewData};

const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// 十六进制视图只需要首屏。以前按 4 MiB 全量转储，会在内存里拼出约 20 MB 的
/// 单个字符串，WebView 渲染进程要把它排成 26 万行 <pre>，实测卡死 35 秒、
/// 峰值内存 1.4 GB，内存紧张时渲染进程直接被杀（闪退）。
const HEX_LIMIT: u64 = 64 * 1024;

pub fn read_entry(
    kind: Kind,
    path: &Path,
    index: usize,
    password: Option<&str>,
    preview_dir: &Path,
    hint: Option<(&str, u64)>,
) -> Result<PreviewData> {
    // 前端已经知道条目名与大小，传进来就不用为了拿个名字把整个包再列一遍
    // （tar.gz / 7z 列表要完整解流，大包会明显拖慢双击响应）。
    let (name, size) = match hint {
        Some((n, s)) => (n.to_string(), s),
        None => {
            let info = super::list_archive(path, password)?;
            let entry = info
                .entries
                .get(index)
                .with_context(|| format!("条目索引超出范围: {index}"))?;
            if entry.is_dir {
                bail!("这是文件夹，无法预览");
            }
            (entry.name.clone(), entry.size)
        }
    };
    let ext = extension(&name);

    if is_text_ext(&ext) {
        let bytes = read_bytes(kind, path, index, password, TEXT_LIMIT)?;
        let truncated = bytes.len() as u64 >= TEXT_LIMIT && size > TEXT_LIMIT;
        let text = decode_text(&bytes);
        return Ok(PreviewData {
            kind: "text".into(),
            name,
            text,
            file: String::new(),
            mime: "text/plain".into(),
            size,
            truncated,
        });
    }

    if is_media_ext(&ext) {
        let bytes = read_bytes(kind, path, index, password, MAX_PREVIEW_BYTES)?;
        let file = write_preview(preview_dir, index, &name, &bytes)?;
        let truncated = bytes.len() as u64 >= MAX_PREVIEW_BYTES && size > MAX_PREVIEW_BYTES;
        return Ok(PreviewData {
            kind: media_kind(&ext).into(),
            name,
            text: String::new(),
            file: file.display().to_string(),
            mime: mime_of(&ext).into(),
            size,
            truncated,
        });
    }

    // 未知扩展名：先看内容是文本还是二进制，再决定用哪种视图。
    //
    // 这一条以前是缺的 —— LICENSE、Makefile、.gitignore、README（无扩展名）这类
    // 纯文本会被当成二进制丢进十六进制视图，屏幕上是一屏 00 41 42。判据在
    // util::is_probably_text（含 NUL 即非文本、控制字符占比超 5% 即非文本）。
    //
    // 先只读 HEX_LIMIT（64 KiB）嗅探，是因为这里绝大多数情况下结果是二进制，
    // 而二进制分支本来也只要 64 KiB；判成文本才补读一次到 TEXT_LIMIT。反过来
    // 先按 TEXT_LIMIT 读，等于给每个 .dll、.png 白读 2 MB。
    let sniff = read_bytes(kind, path, index, password, HEX_LIMIT)?;
    if maybe_text(&sniff) {
        let bytes = if size > HEX_LIMIT {
            read_bytes(kind, path, index, password, TEXT_LIMIT)?
        } else {
            sniff
        };
        let truncated = bytes.len() as u64 >= TEXT_LIMIT && size > TEXT_LIMIT;
        return Ok(PreviewData {
            kind: "text".into(),
            name,
            text: decode_text(&bytes),
            file: String::new(),
            mime: "text/plain".into(),
            size,
            truncated,
        });
    }

    let truncated = size > HEX_LIMIT;
    Ok(PreviewData {
        kind: "hex".into(),
        name,
        text: hex_dump(&sniff),
        file: String::new(),
        mime: "application/octet-stream".into(),
        size,
        truncated,
    })
}

fn read_bytes(
    kind: Kind,
    path: &Path,
    index: usize,
    password: Option<&str>,
    limit: u64,
) -> Result<Vec<u8>> {
    match kind {
        Kind::Zip => zip_impl::read_entry(path, index, password, limit),
        Kind::SevenZ => sevenz_impl::read_entry(path, index, password, limit),
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => {
            tar_impl::read_entry(path, kind, index, limit)
        }
        Kind::Rar => super::rar::read_entry(path, index, password, limit),
        Kind::Gz | Kind::Bz2 | Kind::Xz => {
            let mut data = Vec::new();
            let mut r = tar_impl::single_reader_pub(path, kind)?;
            std::io::Read::take(&mut r, limit).read_to_end(&mut data)?;
            Ok(data)
        }
    }
}

/// 每次落盘用一个递增序号，保证同一进程里不同预览的文件名不重复：
/// 换个包再预览同名同序号条目时，URL 若不变，WebView 可能直接命中旧图。
static PREVIEW_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_preview(dir: &Path, index: usize, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let base = safe_relative(name)
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "preview.bin".to_string());
    let seq = PREVIEW_SEQ.fetch_add(1, Ordering::Relaxed);
    let file = dir.join(format!("{index}-{seq}-{base}"));
    fs::write(&file, bytes)?;
    Ok(file)
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "md" | "markdown" | "log" | "json" | "xml" | "html" | "htm" | "css" | "js"
            | "ts" | "jsx" | "tsx" | "rs" | "py" | "c" | "h" | "cpp" | "hpp" | "cs" | "java"
            | "go" | "rb" | "php" | "sh" | "bat" | "ps1" | "ini" | "cfg" | "conf" | "toml"
            | "yaml" | "yml" | "sql" | "csv" | "tsv" | "srt" | "ass" | "lrc" | "nfo" | "diff"
            | "patch"
    )
}

fn is_media_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "avif"
            | "pdf" | "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "opus" | "mp4" | "mkv"
            | "webm" | "mov" | "avi" | "wmv" | "srt"
    )
}

fn media_kind(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "avif" => {
            "image"
        }
        "pdf" => "pdf",
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "opus" => "audio",
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "wmv" => "video",
        _ => "file",
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        _ => "application/octet-stream",
    }
}

/// 去掉尾部被截断的多字节 UTF-8 序列（最多 3 字节）。不这么做时，按 2 MiB
/// 截断的 UTF-8 文本会因为末尾半个汉字而整体校验失败，整篇被当成 GBK 解——
/// 用户看到的就是满屏乱码。
fn trim_utf8_tail(bytes: &[u8]) -> &[u8] {
    let n = bytes.len();
    for back in 1..=3usize {
        if n < back {
            break;
        }
        let idx = n - back;
        let b = bytes[idx];
        if b < 0x80 {
            return bytes; // 尾部是完整 ASCII
        }
        if b >= 0xC0 {
            let need = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            return if back < need { &bytes[..idx] } else { bytes };
        }
        // 0x80..=0xBF 是续字节，继续往前找首字节。
    }
    bytes
}

fn decode_text(bytes: &[u8]) -> String {
    let bytes = trim_utf8_tail(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim_start_matches('\u{feff}').to_string();
    }
    decode_ansi(bytes)
}

fn hex_dump(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 5 + 64);
    for (offset, chunk) in bytes.chunks(16).enumerate() {
        let _ = write!(out, "{:08X}  ", offset * 16);
        for (i, b) in chunk.iter().enumerate() {
            let _ = write!(out, "{b:02X} ");
            if i == 7 {
                out.push(' ');
            }
        }
        for _ in chunk.len()..16 {
            out.push_str("   ");
        }
        out.push_str(" |");
        for b in chunk {
            out.push(if b.is_ascii_graphic() || *b == b' ' {
                *b as char
            } else {
                '.'
            });
        }
        out.push_str("|\n");
    }
    out
}

/// 未知扩展名时用来判「这条目是不是其实是一段文本」。
///
/// 判据本身在 `util::is_probably_text`，这里只是转调。之所以留着这层壳而不是
/// 直接在 read_entry 里调 util：这条判据和预览策略是一件事，将来若要按视图
/// 需求调整（比如媒体先看魔数再退回文本），改这里比改通用 util 更合适。
///
/// 阅读变更记录 1.16.5：预览路径上曾按 4 MiB 读 + hex_dump 生成 20.7 MB 字符串，
/// Chromium 渲染 26 万行文本节点，CPU 跑满 35 秒、渲染进程内存峰值 1413 MB、窗口
/// 假死。所以这里嗅探只读 HEX_LIMIT（64 KiB），判成文本才补读到 TEXT_LIMIT，
/// 任何改动都要用真包实测（大文本 + 无扩展名 + 中文），不能只过编译。
pub fn maybe_text(bytes: &[u8]) -> bool {
    is_probably_text(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    /// 造一个真 zip 包。这组测试刻意不用假的 bytes 直连 maybe_text ——
    /// 要验的是 read_entry 把「扩展名 → 读多少 → 走哪条视图」串起来的结果，
    /// 而 1.16.5 那次事故正是这条路线上生成的字符串太大把渲染进程压死。
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let f = File::create(path).unwrap();
        let mut w = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut w, data).unwrap();
        }
        w.finish().unwrap();
    }

    fn temp_root(tag: &str) -> PathBuf {
        let base = std::env::var_os("TIDY_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("D:\\Builds\\tidy-preview-tests"));
        let dir = base.join(format!("{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 无扩展名的纯文本走文本视图，不再是一屏十六进制。
    #[test]
    fn unknown_extension_text_uses_text_view() {
        let root = temp_root("pv_text");
        let zip = root.join("a.zip");
        let body = "这是 LICENSE 的内容\n第二行\n".repeat(20);
        make_zip(&zip, &[("LICENSE", body.as_bytes())]);

        let pv = read_entry(Kind::Zip, &zip, 0, None, &root.join("pv"), None).unwrap();
        assert_eq!(pv.kind, "text", "无扩展名纯文本应该走文本视图");
        assert!(pv.text.contains("LICENSE"), "文本内容不对：{:?}", pv.text);
        assert!(pv.text.contains("第二行"), "中文被截断了：{:?}", pv.text);
        assert!(!pv.truncated);
    }

    /// 无扩展名的二进制仍走十六进制，没有被误判成文本。
    #[test]
    fn unknown_extension_binary_stays_hex() {
        let root = temp_root("pv_bin");
        let zip = root.join("b.zip");
        // NUL + 高位字节，is_probably_text 必判非文本；体积故意超过 HEX_LIMIT，
        // 这样 truncated 才有意义（小于 64 KiB 时它是 false）。
        let mut blob = vec![0u8, 0xFF, 0xFE, 0x00, 0x89, 0x50];
        blob.extend((0u8..=255).cycle().take(70_000));
        make_zip(&zip, &[("payload.bin", &blob)]);

        let pv = read_entry(Kind::Zip, &zip, 0, None, &root.join("pv"), None).unwrap();
        assert_eq!(pv.kind, "hex", "二进制不该被当成文本");
        assert!(pv.truncated, "超过 HEX_LIMIT 应该标成截断");
        assert!(
            pv.text.len() < HEX_LIMIT as usize * 6,
            "十六进制视图只该给首屏（约 {} 字节的转储），实际 {} 字节 —— \
             这正是 1.16.5 卡死的成因",
            HEX_LIMIT as usize * 5,
            pv.text.len()
        );
    }

    /// 大文本：超过 HEX_LIMIT 但仍按文本给，且截断标记正确。
    ///
    /// 这一条钉的是「判成文本后补读到 TEXT_LIMIT」那段：只读 64 KiB 就在
    /// 这里下结论的话，用户看到的是被腰斩的文本，而且 truncated 还会是 false。
    #[test]
    fn large_unknown_text_reads_past_sniff_window() {
        let root = temp_root("pv_big");
        let zip = root.join("c.zip");
        let body = "ABCDEFGHIJ".repeat(20_000); // 200 KB，远超 HEX_LIMIT(64 KiB)
        make_zip(&zip, &[("README", body.as_bytes())]);

        let pv = read_entry(Kind::Zip, &zip, 0, None, &root.join("pv"), None).unwrap();
        assert_eq!(pv.kind, "text");
        assert!(
            pv.text.len() > HEX_LIMIT as usize,
            "只读了嗅探窗口：{} 字节，应该补读到 TEXT_LIMIT",
            pv.text.len()
        );
        assert!(pv.text.len() <= TEXT_LIMIT as usize, "超过了 TEXT_LIMIT");
    }

    /// hint 传了名字和大小就不该再列一遍包（双击响应的关键）。
    ///
    /// 用 hint 给一个不存在的条目名 + 正确大小，能拿到 text 就说明
    /// 它确实没走 list_archive。
    #[test]
    fn hint_skips_listing() {
        let root = temp_root("pv_hint");
        let zip = root.join("d.zip");
        let make = "hello 文本".repeat(10);
        make_zip(&zip, &[("notes", make.as_bytes())]);

        let pv = read_entry(
            Kind::Zip,
            &zip,
            0,
            None,
            &root.join("pv"),
            Some(("notes", make.len() as u64)),
        )
        .unwrap();
        assert_eq!(pv.kind, "text");
        assert_eq!(pv.name, "notes");
        assert!(pv.text.contains("hello"));
    }
}
