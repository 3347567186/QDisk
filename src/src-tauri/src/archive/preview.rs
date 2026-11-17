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

    let bytes = read_bytes(kind, path, index, password, HEX_LIMIT)?;
    let truncated = size > HEX_LIMIT;
    Ok(PreviewData {
        kind: "hex".into(),
        name,
        text: hex_dump(&bytes),
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

// Keep this helper used by the "unknown extension but text content" path.
pub fn maybe_text(bytes: &[u8]) -> bool {
    is_probably_text(bytes)
}
