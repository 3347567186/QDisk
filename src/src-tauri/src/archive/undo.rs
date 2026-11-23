use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;

use super::util::{is_reparse, metadata_filetime, safe_relative, Overwrite};

/// 仅保留最近 1 次操作的可撤回记录，杜绝多次大文件覆盖造成磁盘体积膨胀。
#[allow(dead_code)]
pub const MAX_UNDO_RECORDS: usize = 1;
/// 同盘覆盖走 O(1) rename（零拷贝开销），但总备份仍封顶 1 GiB，防止超大文件长期占满磁盘。
const SAME_DRIVE_BACKUP_CAP: u64 = 1024 * 1024 * 1024;
/// 跨盘覆盖需实际复制（如 D: -> C: AppData），严格封顶总计 128 MiB、单文件 64 MiB，兼顾性能与系统盘空间。
const CROSS_DRIVE_BACKUP_CAP: u64 = 128 * 1024 * 1024;
const CROSS_DRIVE_SINGLE_FILE_CAP: u64 = 64 * 1024 * 1024;
/// 内存账本上限：超过 5 万个新建文件或 2 万个新建目录自动放弃追踪，防极端巨包撑爆内存。
const MAX_TRACKED_FILES: usize = 50_000;
const MAX_TRACKED_DIRS: usize = 20_000;
static UNDO_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub op: String,
    pub removed_files: u64,
    pub removed_dirs: u64,
    pub restored_files: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
struct CreatedFile {
    path: PathBuf,
    size: u64,
    mtime_ft: u64,
}

#[derive(Clone, Debug)]
struct BackupItem {
    orig_path: PathBuf,
    backup_path: PathBuf,
}

#[derive(Debug)]
pub struct UndoRecord {
    pub id: String,
    pub op: String,
    pub root_dir: PathBuf,
    pub backup_dir: Option<PathBuf>,
    pub backup_bytes: u64,
    pub backup_incomplete: bool,
    created_files: Vec<CreatedFile>,
    created_dirs: Vec<PathBuf>,
    backups: Vec<BackupItem>,
}

impl UndoRecord {
    pub fn is_empty(&self) -> bool {
        self.created_files.is_empty() && self.created_dirs.is_empty() && self.backups.is_empty()
    }

    pub fn cleanup_backup_dir(&self) {
        if let Some(dir) = &self.backup_dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

struct UndoInner {
    created_files: Vec<PathBuf>,
    created_file_set: HashSet<String>,
    created_dirs: Vec<PathBuf>,
    created_dir_set: HashSet<String>,
    backups: Vec<BackupItem>,
    overwritten_set: HashSet<String>,
    backup_dir_created: bool,
    backup_counter: u64,
    same_drive_bytes: u64,
    cross_drive_bytes: u64,
    backup_bytes: u64,
    backup_incomplete: bool,
    tracking_overflow: bool,
}

/// 线程安全的归档操作账本：追踪本次解压/压缩真正新建的文件、新建目录与覆盖前备份，
/// 用于事后安全撤回或中途取消/报错回滚。受同盘/跨盘体积上限与条目数上限双重约束。
pub struct UndoTracker {
    id: String,
    op: &'static str,
    root_dir: PathBuf,
    backup_dir: PathBuf,
    same_drive_cap: u64,
    cross_drive_cap: u64,
    cross_drive_single_cap: u64,
    max_tracked_files: usize,
    max_tracked_dirs: usize,
    inner: Mutex<UndoInner>,
}

impl UndoTracker {
    pub fn new(op: &'static str, root_dir: PathBuf, data_dir: &Path) -> Self {
        Self::with_caps(
            op,
            root_dir,
            data_dir,
            SAME_DRIVE_BACKUP_CAP,
            CROSS_DRIVE_BACKUP_CAP,
            CROSS_DRIVE_SINGLE_FILE_CAP,
            MAX_TRACKED_FILES,
            MAX_TRACKED_DIRS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_caps(
        op: &'static str,
        root_dir: PathBuf,
        data_dir: &Path,
        same_drive_cap: u64,
        cross_drive_cap: u64,
        cross_drive_single_cap: u64,
        max_tracked_files: usize,
        max_tracked_dirs: usize,
    ) -> Self {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = UNDO_SEQ.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let id = format!("u-{pid}-{now_ms}-{seq}");
        let backup_dir = data_dir.join("archive_undo").join(&id);
        Self {
            id,
            op,
            root_dir,
            backup_dir,
            same_drive_cap,
            cross_drive_cap,
            cross_drive_single_cap,
            max_tracked_files,
            max_tracked_dirs,
            inner: Mutex::new(UndoInner {
                created_files: Vec::new(),
                created_file_set: HashSet::new(),
                created_dirs: Vec::new(),
                created_dir_set: HashSet::new(),
                backups: Vec::new(),
                overwritten_set: HashSet::new(),
                backup_dir_created: false,
                backup_counter: 0,
                same_drive_bytes: 0,
                cross_drive_bytes: 0,
                backup_bytes: 0,
                backup_incomplete: false,
                tracking_overflow: false,
            }),
        }
    }

    /// 原子检测并创建目录链：只把调用前确实不存在的目录记入 `created_dirs`，
    /// 绝不误记用户原本就存在的目录。
    pub fn ensure_dir(&self, dir: &Path) -> Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.tracking_overflow {
            fs::create_dir_all(dir)
                .with_context(|| format!("无法创建目录 {}", dir.display()))?;
            return Ok(());
        }
        let mut missing = Vec::new();
        let mut cur = Some(dir);
        let stop_at = self.root_dir.parent();
        while let Some(p) = cur {
            if stop_at.is_some_and(|s| p == s) {
                break;
            }
            if p.as_os_str().is_empty() {
                break;
            }
            if fs::symlink_metadata(p).is_ok() {
                break;
            }
            missing.push(p.to_path_buf());
            if p == self.root_dir {
                break;
            }
            cur = p.parent();
        }
        if !missing.is_empty() {
            fs::create_dir_all(dir)
                .with_context(|| format!("无法创建目录 {}", dir.display()))?;
            for m in missing {
                if g.created_dirs.len() >= self.max_tracked_dirs {
                    trip_overflow(&mut g);
                    break;
                }
                let key = norm_key(&m);
                if g.created_dir_set.insert(key) {
                    g.created_dirs.push(m);
                }
            }
        }
        Ok(())
    }

    /// 写入目标文件前准备：确保父目录存在；若为覆盖已有普通文件，在体积上限内先备份原文件。
    pub fn prepare_file_write(&self, target: &Path, policy: Overwrite) -> Result<()> {
        if let Some(parent) = target.parent() {
            self.ensure_dir(parent)?;
        }
        let Ok(meta) = fs::symlink_metadata(target) else {
            return Ok(());
        };
        if policy != Overwrite::Overwrite || meta.is_dir() || is_reparse(target) {
            return Ok(());
        }
        let key = norm_key(target);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.tracking_overflow || g.overwritten_set.contains(&key) || g.created_file_set.contains(&key) {
            // 超限后跳过后续备份 I/O；同一次任务内部已覆盖/创建过该路径则保留最初备份。
            return Ok(());
        }
        g.overwritten_set.insert(key);
        let file_len = meta.len();
        let same_vol = same_volume(target, &self.backup_dir);
        if same_vol {
            if g.same_drive_bytes.saturating_add(file_len) > self.same_drive_cap {
                g.backup_incomplete = true;
                return Ok(());
            }
        } else if file_len > self.cross_drive_single_cap
            || g.cross_drive_bytes.saturating_add(file_len) > self.cross_drive_cap
        {
            g.backup_incomplete = true;
            return Ok(());
        }
        if !g.backup_dir_created {
            if fs::create_dir_all(&self.backup_dir).is_err() {
                g.backup_incomplete = true;
                return Ok(());
            }
            g.backup_dir_created = true;
        }
        g.backup_counter += 1;
        let backup_path = self.backup_dir.join(format!("b_{}", g.backup_counter));
        let backed = if same_vol {
            if fs::rename(target, &backup_path).is_ok() {
                g.same_drive_bytes = g.same_drive_bytes.saturating_add(file_len);
                g.backup_bytes = g.backup_bytes.saturating_add(file_len);
                true
            } else {
                false
            }
        } else {
            match fs::copy(target, &backup_path) {
                Ok(copied) => {
                    g.cross_drive_bytes = g.cross_drive_bytes.saturating_add(copied);
                    g.backup_bytes = g.backup_bytes.saturating_add(copied);
                    true
                }
                Err(_) => {
                    let _ = fs::remove_file(&backup_path);
                    false
                }
            }
        };
        if backed {
            g.backups.push(BackupItem {
                orig_path: target.to_path_buf(),
                backup_path,
            });
        } else {
            g.backup_incomplete = true;
        }
        Ok(())
    }

    /// 文件写入成功后登记为本次新建文件（若属于覆盖已有文件，已在 backups 中登记，不再重复记为新建）。
    pub fn record_created_file(&self, path: &Path) {
        let key = norm_key(path);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.tracking_overflow || g.overwritten_set.contains(&key) {
            return;
        }
        if g.created_files.len() >= self.max_tracked_files {
            trip_overflow(&mut g);
            return;
        }
        if g.created_file_set.insert(key) {
            g.created_files.push(path.to_path_buf());
        }
    }

    /// 任务中途取消或失败时：还原已备份的被覆盖原文件，并清理暂存目录。
    pub fn rollback_on_error(&self) {
        let (backups, has_dir) = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let b = std::mem::take(&mut g.backups);
            let d = g.backup_dir_created;
            g.backup_dir_created = false;
            (b, d)
        };
        for item in backups.into_iter().rev() {
            if item.backup_path.exists() {
                let _ = restore_file(&item.backup_path, &item.orig_path);
            }
        }
        if has_dir {
            let _ = fs::remove_dir_all(&self.backup_dir);
        }
    }

    /// 任务成功完成后固化为不可变 `UndoRecord`，捕获新建文件的大小与修改时间指纹。
    /// 若条目数超上限（`tracking_overflow`），则立即清空备份目录并返回空记录，确保不留残留且不给半成品撤回。
    pub fn finalize(&self) -> UndoRecord {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.tracking_overflow {
            let had_dir = g.backup_dir_created;
            g.backup_dir_created = false;
            g.backups.clear();
            g.created_files.clear();
            g.created_dirs.clear();
            if had_dir {
                let _ = fs::remove_dir_all(&self.backup_dir);
            }
            return UndoRecord {
                id: self.id.clone(),
                op: self.op.to_string(),
                root_dir: self.root_dir.clone(),
                backup_dir: None,
                backup_bytes: 0,
                backup_incomplete: false,
                created_files: Vec::new(),
                created_dirs: Vec::new(),
                backups: Vec::new(),
            };
        }
        let mut created_files = Vec::with_capacity(g.created_files.len());
        for p in g.created_files.drain(..) {
            if let Ok(meta) = fs::symlink_metadata(&p) {
                if !meta.is_dir() && !is_reparse(&p) {
                    created_files.push(CreatedFile {
                        path: p,
                        size: meta.len(),
                        mtime_ft: metadata_filetime(&meta),
                    });
                }
            }
        }
        let mut created_dirs: Vec<PathBuf> = g.created_dirs.drain(..).collect();
        // 按路径深度倒序排列，撤回时从最深层子目录逐级安全删除空目录。
        created_dirs.sort_by(|a, b| {
            b.components()
                .count()
                .cmp(&a.components().count())
                .then_with(|| b.as_os_str().len().cmp(&a.as_os_str().len()))
        });
        let backups = std::mem::take(&mut g.backups);
        let backup_dir = if g.backup_dir_created {
            Some(self.backup_dir.clone())
        } else {
            None
        };
        UndoRecord {
            id: self.id.clone(),
            op: self.op.to_string(),
            root_dir: self.root_dir.clone(),
            backup_dir,
            backup_bytes: g.backup_bytes,
            backup_incomplete: g.backup_incomplete,
            created_files,
            created_dirs,
            backups,
        }
    }
}

fn trip_overflow(g: &mut UndoInner) {
    g.tracking_overflow = true;
    g.created_files.clear();
    g.created_files.shrink_to_fit();
    g.created_file_set.clear();
    g.created_file_set.shrink_to_fit();
    g.created_dirs.clear();
    g.created_dirs.shrink_to_fit();
    g.created_dir_set.clear();
    g.created_dir_set.shrink_to_fit();
}

pub fn execute_undo(record: UndoRecord) -> Result<UndoReport> {
    let mut report = UndoReport {
        op: record.op.clone(),
        removed_files: 0,
        removed_dirs: 0,
        restored_files: 0,
        skipped: 0,
        warnings: Vec::new(),
    };
    if record.backup_incomplete {
        report
            .warnings
            .push("部分超大覆盖文件超出撤回备份上限（同盘 1 GB / 跨盘 128 MB），已保留现状以防数据丢失".into());
    }

    // 1. 还原被覆盖的原文件
    for item in record.backups.iter().rev() {
        if !is_under_root(&item.orig_path, &record.root_dir) {
            report.skipped += 1;
            report
                .warnings
                .push(format!("跳过越界路径: {}", item.orig_path.display()));
            continue;
        }
        if is_reparse(&item.orig_path) {
            report.skipped += 1;
            report
                .warnings
                .push(format!("跳过符号链接: {}", item.orig_path.display()));
            continue;
        }
        if !item.backup_path.exists() {
            report.skipped += 1;
            report
                .warnings
                .push(format!("备份已不存在，无法还原: {}", item.orig_path.display()));
            continue;
        }
        match restore_file(&item.backup_path, &item.orig_path) {
            Ok(()) => report.restored_files += 1,
            Err(e) => {
                report.skipped += 1;
                report
                    .warnings
                    .push(format!("还原失败 {}: {e}", item.orig_path.display()));
            }
        }
    }

    // 2. 删除本次新建且未被用户修改的文件
    for cf in &record.created_files {
        if !is_under_root(&cf.path, &record.root_dir) {
            report.skipped += 1;
            report
                .warnings
                .push(format!("跳过越界路径: {}", cf.path.display()));
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&cf.path) else {
            report.skipped += 1;
            continue;
        };
        if meta.is_dir() || is_reparse(&cf.path) {
            report.skipped += 1;
            continue;
        }
        let cur_mtime = metadata_filetime(&meta);
        if meta.len() != cf.size || cur_mtime != cf.mtime_ft {
            report.skipped += 1;
            let label = cf
                .path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| cf.path.display().to_string());
            report
                .warnings
                .push(format!("文件已被修改，已保留以防丢失: {label}"));
            continue;
        }
        match fs::remove_file(&cf.path) {
            Ok(()) => report.removed_files += 1,
            Err(e) => {
                report.skipped += 1;
                report
                    .warnings
                    .push(format!("无法删除 {}: {e}", cf.path.display()));
            }
        }
    }

    // 3. 按深度从深到浅安全删除本次新建的空目录（绝不用 remove_dir_all）
    for dir in &record.created_dirs {
        if !is_under_root(dir, &record.root_dir) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(dir) else {
            continue;
        };
        if !meta.is_dir() || is_reparse(dir) {
            continue;
        }
        match fs::remove_dir(dir) {
            Ok(()) => report.removed_dirs += 1,
            Err(_) => {
                // 目录非空（用户新增了文件或保留了已修改文件），静默安全保留。
                report.skipped += 1;
            }
        }
    }

    record.cleanup_backup_dir();
    Ok(report)
}

/// 启动时清理历史进程遗留的 archive_undo 备份目录。
pub fn sweep_stale_undo_dirs(data_dir: &Path) {
    let base = data_dir.join("archive_undo");
    let me_prefix = format!("u-{}-", std::process::id());
    let Ok(rd) = fs::read_dir(&base) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name.starts_with(&me_prefix) {
            continue;
        }
        let _ = fs::remove_dir_all(&path);
    }
}

/// 顶层同名文件夹并存映射：在 `Overwrite::Rename` 模式下，将归档内已存在于 `out_dir` 的
/// 顶层目录段（例如 `proj/` 或 TAR 的 `./proj/`）统一重命名为 `proj (2)/`，使其与已有文件夹干净并存，
/// 同时避开归档内原本就存在的同名兄弟项（如归档内同时含 `proj/` 与 `proj (2)/`）。
pub fn build_dir_rename_map<S: AsRef<str>>(
    out_dir: &Path,
    entry_names: impl IntoIterator<Item = (S, bool)>,
) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut allocated: HashSet<String> = HashSet::new();
    let mut top_dirs: Vec<String> = Vec::new();
    let mut seen_top: HashSet<String> = HashSet::new();

    for (raw, is_dir) in entry_names {
        let Ok(rel) = safe_relative(raw.as_ref()) else {
            continue;
        };
        let mut comps = rel.components();
        let Some(Component::Normal(first_os)) = comps.next() else {
            continue;
        };
        let first = first_os.to_string_lossy().to_string();
        if first.is_empty() {
            continue;
        }
        let low = first.to_lowercase();
        // 无论文件还是目录，先占住归档内既有顶层名，防止重命名后的目录撞上包内兄弟项。
        allocated.insert(low.clone());
        let has_nested = comps.next().is_some();
        if (is_dir || has_nested) && seen_top.insert(low) {
            top_dirs.push(first);
        }
    }

    for seg in top_dirs {
        let candidate = out_dir.join(&seg);
        if fs::symlink_metadata(&candidate).is_ok() {
            let new_seg = unique_sibling_name(out_dir, &seg, &allocated);
            allocated.insert(new_seg.to_lowercase());
            map.insert(seg.to_lowercase(), new_seg);
        }
    }
    map
}

fn unique_sibling_name(parent: &Path, name: &str, allocated: &HashSet<String>) -> String {
    for i in 2..10000 {
        let cand_name = format!("{name} ({i})");
        if allocated.contains(&cand_name.to_lowercase()) {
            continue;
        }
        if fs::symlink_metadata(parent.join(&cand_name)).is_err() {
            return cand_name;
        }
    }
    format!("{name} (copy)")
}

fn restore_file(backup: &Path, orig: &Path) -> Result<()> {
    if let Some(p) = orig.parent() {
        fs::create_dir_all(p)?;
    }
    if fs::symlink_metadata(orig).is_ok() {
        fs::remove_file(orig)?;
    }
    if fs::rename(backup, orig).is_ok() {
        return Ok(());
    }
    fs::copy(backup, orig)?;
    let _ = fs::remove_file(backup);
    Ok(())
}

fn norm_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn same_volume(a: &Path, b: &Path) -> bool {
    let prefix_of = |p: &Path| -> Option<String> {
        for c in p.components() {
            if let Component::Prefix(pr) = c {
                return Some(pr.as_os_str().to_string_lossy().to_lowercase());
            }
        }
        None
    };
    match (prefix_of(a), prefix_of(b)) {
        (Some(pa), Some(pb)) => pa == pb,
        _ => false,
    }
}

fn is_under_root(path: &Path, root: &Path) -> bool {
    let np = norm_key(path);
    let nr = norm_key(root);
    let nr_clean = nr.trim_end_matches('\\');
    if np == nr_clean {
        return true;
    }
    let prefix = format!("{nr_clean}\\");
    np.starts_with(&prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = PathBuf::from("D:\\Builds\\tidy-undo-tests")
            .join(format!("{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn undo_preserves_preexisting_and_modified_and_restores_overwritten() {
        let root = temp_dir("safety");
        let data = root.join("_data");
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();

        // 预先存在的老文件与被覆盖文件
        let keep_old = out.join("preexisting.txt");
        let will_overwrite = out.join("shared.txt");
        fs::write(&keep_old, b"do-not-touch").unwrap();
        fs::write(&will_overwrite, b"original-v1").unwrap();

        let tracker = UndoTracker::new("extract", out.clone(), &data);
        // 1. 覆盖已有文件
        tracker
            .prepare_file_write(&will_overwrite, Overwrite::Overwrite)
            .unwrap();
        fs::write(&will_overwrite, b"overwritten-v2").unwrap();
        tracker.record_created_file(&will_overwrite);

        // 2. 新建目录与文件
        let new_file = out.join("new_sub/deep/clean.txt");
        tracker
            .prepare_file_write(&new_file, Overwrite::Rename)
            .unwrap();
        fs::write(&new_file, b"brand-new").unwrap();
        tracker.record_created_file(&new_file);

        // 3. 新建文件随后被用户手动修改 -> 撤回时不得删除
        let edited_file = out.join("keep_sub/edited.txt");
        tracker
            .prepare_file_write(&edited_file, Overwrite::Rename)
            .unwrap();
        fs::write(&edited_file, b"initial").unwrap();
        tracker.record_created_file(&edited_file);

        let record = tracker.finalize();
        // 模拟用户在解压完成后编辑了 edited.txt
        fs::write(&edited_file, b"user-edited-longer-content").unwrap();

        let rep = execute_undo(record).unwrap();
        assert_eq!(rep.restored_files, 1, "被覆盖原文件应完整还原");
        assert_eq!(rep.removed_files, 1, "仅应删除未修改的新建文件");
        assert_eq!(rep.removed_dirs, 2, "仅应删除空的新建子目录 new_sub/deep 与 new_sub");
        assert_eq!(fs::read(&keep_old).unwrap(), b"do-not-touch");
        assert_eq!(fs::read(&will_overwrite).unwrap(), b"original-v1");
        assert!(!new_file.exists());
        assert!(!out.join("new_sub").exists());
        assert_eq!(fs::read(&edited_file).unwrap(), b"user-edited-longer-content");
        assert!(out.join("keep_sub").exists(), "含用户修改文件的目录必须安全保留");
        assert!(rep.warnings.iter().any(|w| w.contains("已被修改")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_on_error_restores_overwritten_files() {
        let root = temp_dir("rollback");
        let data = root.join("_data");
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let target = out.join("important.dat");
        fs::write(&target, b"precious-data").unwrap();

        let tracker = UndoTracker::new("extract", out.clone(), &data);
        tracker
            .prepare_file_write(&target, Overwrite::Overwrite)
            .unwrap();
        fs::write(&target, b"partial-corrupt").unwrap();

        // 模拟任务中途取消回滚
        tracker.rollback_on_error();
        assert_eq!(fs::read(&target).unwrap(), b"precious-data");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_rename_map_renames_conflicting_top_folder() {
        let root = temp_dir("dirmap");
        fs::create_dir_all(root.join("proj")).unwrap();
        let map = build_dir_rename_map(
            &root,
            [
                ("proj/", true),
                ("proj/a.txt", false),
                ("fresh/b.txt", false),
                ("standalone.txt", false),
            ],
        );
        assert_eq!(map.get("proj").map(|s| s.as_str()), Some("proj (2)"));
        assert!(!map.contains_key("fresh"));
        assert!(!map.contains_key("standalone.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_rename_map_handles_dot_prefix_and_archive_sibling_collision() {
        let root = temp_dir("dir_map_dot");
        fs::create_dir_all(root.join("proj")).unwrap();
        // TAR 常见 ./ 前缀 + 归档内同时存在 proj/ 与 proj (2)/：proj 必须避开 proj (2) 选到 proj (3)
        let map = build_dir_rename_map(
            &root,
            [
                ("./proj/a.txt", false),
                ("./proj (2)/b.txt", false),
                ("./readme.txt", false),
            ],
        );
        assert_eq!(map.get("proj").map(String::as_str), Some("proj (3)"));
        assert!(!map.contains_key("proj (2)"));
        assert!(!map.contains_key("."));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn same_drive_cap_and_tracking_overflow_protect_disk_and_ram() {
        // 子场景 A：同盘覆盖体积超过上限 -> 不产生备份文件、标记 backup_incomplete，撤回保留被覆盖文件
        let root_a = temp_dir("cap_same");
        let data_a = root_a.join("_data");
        let out_a = root_a.join("out");
        fs::create_dir_all(&out_a).unwrap();
        let big = out_a.join("big.bin");
        fs::write(&big, vec![b'O'; 128]).unwrap();

        let tr_a = UndoTracker::with_caps(
            "extract",
            out_a.clone(),
            &data_a,
            64,   // same_drive_cap = 64B，小于 128B 的 big.bin
            64,
            32,
            100,
            100,
        );
        tr_a.prepare_file_write(&big, Overwrite::Overwrite).unwrap();
        fs::write(&big, vec![b'N'; 128]).unwrap();
        tr_a.record_created_file(&big);
        let rec_a = tr_a.finalize();
        assert!(rec_a.backup_incomplete, "超同盘上限必须标记 backup_incomplete");
        assert_eq!(rec_a.backup_bytes, 0, "超限文件不得写入备份目录");
        assert!(rec_a.backup_dir.is_none(), "未产生备份时不得创建备份目录");
        assert!(rec_a.is_empty(), "无其他可撤回项时记录应为空");
        // 即使强行执行撤回，也不得删除未备份的被覆盖文件
        let urep_a = execute_undo(rec_a).unwrap();
        assert_eq!(urep_a.removed_files, 0);
        assert_eq!(fs::read(&big).unwrap(), vec![b'N'; 128]);
        let _ = fs::remove_dir_all(&root_a);

        // 子场景 B：新建文件数量超出 max_tracked_files -> 触发 tracking_overflow，finalize 立刻清空备份目录返回空记录
        let root_b = temp_dir("cap_overflow");
        let data_b = root_b.join("_data");
        let out_b = root_b.join("out");
        fs::create_dir_all(&out_b).unwrap();
        let existing = out_b.join("exist.txt");
        fs::write(&existing, b"old-exist").unwrap();

        let tr_b = UndoTracker::with_caps(
            "extract",
            out_b.clone(),
            &data_b,
            1024 * 1024,
            1024 * 1024,
            1024 * 1024,
            2, // max_tracked_files = 2
            100,
        );
        tr_b.prepare_file_write(&existing, Overwrite::Overwrite).unwrap();
        fs::write(&existing, b"new-exist").unwrap();
        for i in 0..3 {
            let p = out_b.join(format!("f{i}.txt"));
            fs::write(&p, b"x").unwrap();
            tr_b.record_created_file(&p);
        }
        let rec_b = tr_b.finalize();
        assert!(rec_b.is_empty(), "超条目上限后 finalize 必须返回空记录以防半成品撤回");
        assert!(rec_b.backup_dir.is_none());
        assert_eq!(rec_b.backup_bytes, 0);
        assert!(
            !data_b.join("archive_undo").join(&rec_b.id).exists(),
            "超条目上限后必须立即删除已产生的备份目录"
        );
        let _ = fs::remove_dir_all(&root_b);
    }
}
