// 索引遍历器：把「走目录、读大小与时间」这段从 Python 搬到 Rust。
//
// 只做遍历，不碰数据库。stdout 按行输出制表符分隔的记录，Python 那边边读边落库：
//   D \t mtime \t 目录路径
//   F \t 字节数 \t mtime \t 文件名
//   E \t 原因 \t 路径
// 文件名里不会出现 \t 和换行（Windows 禁止 0x00-0x1F），所以不需要转义。
//
// 为什么值得搬到 Rust：Python 版主要成本是逐个文件 stat。这里多线程并发枚举
// 目录，把同一卷上的元数据查询摊到多核；每个目录整块交给写线程，确保 D 记录
// 后面紧跟它自己的 F 记录。

use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::UNIX_EPOCH;

/// 与 tidy.py 的 INDEX_SKIP 保持一致：这些目录整棵跳过，不索引。
const SKIP: &[&str] = &[
    ".git", ".svn", "node_modules", "__pycache__", "venv", ".venv",
    "site-packages", "windows", "winsxs", "system32", "$recycle.bin",
    "system volume information", "programdata",
];

fn mtime_of(md: &fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn skipped(name: &str) -> bool {
    if name.starts_with('$') {
        return true;
    }
    let low = name.to_ascii_lowercase();
    SKIP.contains(&low.as_str())
}

struct Queue {
    dirs: VecDeque<PathBuf>,
    active: usize,
}

struct Block {
    text: String,
    dirs: u64,
    files: u64,
    subs: Vec<PathBuf>,
}

fn worker_count() -> usize {
    thread::available_parallelism()
        .map(|v| v.get())
        .unwrap_or(4)
        .clamp(2, 12)
}

fn main() -> ExitCode {
    let root = match std::env::args().nth(1) {
        Some(r) => r,
        None => {
            eprintln!("usage: indexwalk <root>");
            return ExitCode::from(2);
        }
    };

    let q = Arc::new((
        Mutex::new(Queue {
            dirs: VecDeque::from(vec![PathBuf::from(&root)]),
            active: 0,
        }),
        Condvar::new(),
    ));

    // 目录块通过 channel 交给写线程，避免多线程争 stdout
    let (tx, rx) = mpsc::channel::<Block>();
    let workers = worker_count();
    let mut handles = Vec::with_capacity(workers);

    for _ in 0..workers {
        let q = Arc::clone(&q);
        let tx = tx.clone();
        handles.push(thread::spawn(move || {
            let (lock, cv) = &*q;
            loop {
                let dir = {
                    let mut g = lock.lock().unwrap();
                    loop {
                        if let Some(d) = g.dirs.pop_front() {
                            g.active += 1;
                            break d;
                        }
                        if g.active == 0 {
                            return; // 队列空且没有人在跑 → 全部收工
                        }
                        g = cv.wait(g).unwrap();
                    }
                };

                let block = scan_dir(&dir);

                {
                    // 子目录入队与「我还活着」的计数在同一个锁里更新，
                    // 否则可能出现「队列空但实际还有子目录没入队」的假收工。
                    let mut g = lock.lock().unwrap();
                    g.dirs.extend(block.subs.iter().cloned());
                    g.active -= 1;
                }
                cv.notify_all();

                if tx.send(block).is_err() {
                    return;
                }
            }
        }));
    }
    drop(tx);

    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    let mut files: u64 = 0;
    let mut dirs: u64 = 0;
    let mut failed = false;

    for block in rx {
        dirs += block.dirs;
        files += block.files;
        if !failed && out.write_all(block.text.as_bytes()).is_err() {
            failed = true;
        }
    }
    for h in handles {
        let _ = h.join();
    }
    let _ = out.flush();

    if failed {
        return ExitCode::from(1);
    }
    eprintln!("indexwalk: {} 目录 / {} 文件 / {} 线程", dirs, files, workers);
    ExitCode::SUCCESS
}

/// 扫描一个目录：返回整块待写文本（D 行 + 若干 F 行）与待入队的子目录。
fn scan_dir(dir: &Path) -> Block {
    let mut block = Block {
        text: String::with_capacity(4096),
        dirs: 0,
        files: 0,
        subs: Vec::new(),
    };

    let md = match fs::metadata(dir) {
        Ok(m) => m,
        Err(e) => {
            block
                .text
                .push_str(&format!("E\t{}\t{}\n", e.kind(), dir.display()));
            return block;
        }
    };

    let mut files: Vec<(String, u64, f64)> = Vec::new();

    match fs::read_dir(dir) {
        Ok(rd) => {
            for ent in rd {
                let ent = match ent {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                // file_type() 不跟随链接；Windows 上额外检查 FILE_ATTRIBUTE_REPARSE_POINT，
                // 彻底拦截 NTFS Junction 防止循环目录联接导致遍历死循环或重复计数。
                let ft = match ent.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if ft.is_symlink() {
                    continue;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
                    if let Ok(lm) = fs::symlink_metadata(ent.path()) {
                        if lm.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                            continue;
                        }
                    }
                }
                let name = ent.file_name();
                let name = name.to_string_lossy();
                if ft.is_dir() {
                    if skipped(&name) {
                        continue;
                    }
                    block.subs.push(ent.path());
                } else if ft.is_file() {
                    if let Ok(m) = ent.metadata() {
                        files.push((name.into_owned(), m.len(), mtime_of(&m)));
                    }
                }
            }
        }
        Err(e) => {
            block
                .text
                .push_str(&format!("E\t{}\t{}\n", e.kind(), dir.display()));
            return block;
        }
    }

    block
        .text
        .push_str(&format!("D\t{:.3}\t{}\n", mtime_of(&md), dir.display()));
    block.dirs = 1;
    block.files = files.len() as u64;
    for (name, size, mt) in &files {
        block
            .text
            .push_str(&format!("F\t{}\t{:.3}\t{}\n", size, mt, name));
    }
    block
}
