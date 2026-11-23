use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;

use super::undo::{self, UndoTracker};
use super::util::{self, Overwrite, PerfProfile, Progress, TaskControl};
use super::{rar, sevenz_impl, tar_impl, zip_impl, ArchiveInfo, CreateReport, ExtractReport, Kind, UndoReport};

pub const CAPABILITIES_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
    pub can_read: bool,
    pub can_extract: bool,
    pub can_create: bool,
    pub supports_password: bool,
    pub supports_multi_thread: bool,
    pub needs_external_dll: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeSpec {
    pub id: &'static str,
    pub threads: usize,
    pub buf_size: usize,
    pub block_size: usize,
    pub zip_level: u32,
    pub sevenz_level: u32,
    pub gzip_level: u32,
    pub io_duty_pct: u8,
    pub cpu_duty_pct: u8,
    pub smart_store: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLimits {
    pub max_unpacked_bytes: u64,
    pub max_entries: usize,
    pub max_undo_records: usize,
    pub same_drive_backup_cap: u64,
    pub cross_drive_backup_cap: u64,
    pub cross_drive_single_file_cap: u64,
    pub max_tracked_files: usize,
    pub max_tracked_dirs: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCapabilities {
    pub schema_version: u32,
    pub cpu_cores: usize,
    pub formats: Vec<FormatSpec>,
    pub modes: Vec<ModeSpec>,
    pub limits: ArchiveLimits,
    pub rar_ready: bool,
}

/// 归档编解码器扩展契约：未来接入新格式（如 `.zst` / `.tar.zst` / `.iso` / `.cab`）
/// 只需实现此 trait 并在 `codec_for` / `format_specs` 中注册，无需改动上层调用链。
#[allow(dead_code)]
pub trait ArchiveCodec: Send + Sync {
    fn kind(&self) -> Kind;
    fn spec(&self) -> FormatSpec;
    fn list(&self, path: &Path, password: Option<&str>) -> Result<ArchiveInfo>;
    #[allow(clippy::too_many_arguments)]
    fn extract(
        &self,
        path: &Path,
        out_dir: &Path,
        selected: &HashSet<usize>,
        password: Option<&str>,
        policy: Overwrite,
        profile: PerfProfile,
        dir_map: &HashMap<String, String>,
        undo: Option<&Arc<UndoTracker>>,
        progress: &Arc<Progress>,
        control: &Arc<TaskControl>,
    ) -> Result<ExtractReport>;
}

/// 可扩展解压请求选项结构（预留未来扩展字段如 `strip_components` / `preserve_mtime` / `verify_crc`）。
#[allow(dead_code)]
pub struct ExtractOptions<'a> {
    pub indices: Option<Vec<usize>>,
    pub password: Option<&'a str>,
    pub policy: Overwrite,
    pub mode: &'a str,
}

impl Default for ExtractOptions<'_> {
    fn default() -> Self {
        Self {
            indices: None,
            password: None,
            policy: Overwrite::Rename,
            mode: "balanced",
        }
    }
}

/// 可扩展压缩请求选项结构（预留未来扩展字段如自定义级别、过滤规则、分卷体积）。
#[allow(dead_code)]
pub struct CreateOptions<'a> {
    pub format: &'a str,
    pub mode: &'a str,
    pub password: Option<&'a str>,
}

impl Default for CreateOptions<'_> {
    fn default() -> Self {
        Self {
            format: "zip",
            mode: "balanced",
            password: None,
        }
    }
}

/// 生命周期观察者扩展钩子（预留给未来审计日志、AI 助手任务回执或插件系统订阅）。
#[allow(dead_code)]
pub trait TaskObserver: Send + Sync {
    fn on_extract_done(&self, _report: &ExtractReport) {}
    fn on_create_done(&self, _report: &CreateReport) {}
    fn on_undo_done(&self, _report: &UndoReport) {}
}

pub fn spec_for_kind(kind: Kind) -> FormatSpec {
    match kind {
        Kind::Zip => FormatSpec {
            id: "zip",
            label: "ZIP",
            extensions: &[".zip", ".zipx", ".cbz"],
            can_read: true,
            can_extract: true,
            can_create: true,
            supports_password: true,
            supports_multi_thread: true,
            needs_external_dll: false,
        },
        Kind::SevenZ => FormatSpec {
            id: "7z",
            label: "7Z",
            extensions: &[".7z", ".cb7"],
            can_read: true,
            can_extract: true,
            can_create: true,
            supports_password: true,
            supports_multi_thread: true,
            needs_external_dll: false,
        },
        Kind::Tar => FormatSpec {
            id: "tar",
            label: "TAR",
            extensions: &[".tar"],
            can_read: true,
            can_extract: true,
            can_create: true,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::TarGz => FormatSpec {
            id: "tgz",
            label: "TAR.GZ",
            extensions: &[".tar.gz", ".tgz"],
            can_read: true,
            can_extract: true,
            can_create: true,
            supports_password: false,
            supports_multi_thread: true,
            needs_external_dll: false,
        },
        Kind::TarBz2 => FormatSpec {
            id: "tbz2",
            label: "TAR.BZ2",
            extensions: &[".tar.bz2", ".tbz2", ".tbz"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::TarXz => FormatSpec {
            id: "txz",
            label: "TAR.XZ",
            extensions: &[".tar.xz", ".txz"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::Gz => FormatSpec {
            id: "gz",
            label: "GZ",
            extensions: &[".gz"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::Bz2 => FormatSpec {
            id: "bz2",
            label: "BZ2",
            extensions: &[".bz2"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::Xz => FormatSpec {
            id: "xz",
            label: "XZ",
            extensions: &[".xz"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: false,
            supports_multi_thread: false,
            needs_external_dll: false,
        },
        Kind::Rar => FormatSpec {
            id: "rar",
            label: "RAR",
            extensions: &[".rar", ".cbr"],
            can_read: true,
            can_extract: true,
            can_create: false,
            supports_password: true,
            supports_multi_thread: false,
            needs_external_dll: true,
        },
    }
}

pub fn format_specs() -> Vec<FormatSpec> {
    [
        Kind::Zip,
        Kind::SevenZ,
        Kind::Tar,
        Kind::TarGz,
        Kind::TarBz2,
        Kind::TarXz,
        Kind::Gz,
        Kind::Bz2,
        Kind::Xz,
        Kind::Rar,
    ]
    .into_iter()
    .map(spec_for_kind)
    .collect()
}

pub fn capabilities(data_dir: &Path) -> ArchiveCapabilities {
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(1);
    let modes = ["saver", "balanced", "performance", "hyper"]
        .into_iter()
        .map(|id| {
            let p = PerfProfile::from_mode_with_cores(id, cpu_cores);
            ModeSpec {
                id: p.mode,
                threads: p.threads,
                buf_size: p.buf_size,
                block_size: p.block_size,
                zip_level: p.zip_level,
                sevenz_level: p.sevenz_level,
                gzip_level: p.gzip_level,
                io_duty_pct: p.io_duty_pct,
                cpu_duty_pct: p.cpu_duty_pct,
                smart_store: p.smart_store,
            }
        })
        .collect();
    let rar_ready = rar::status(data_dir).map(|s| s.ready).unwrap_or(false);
    ArchiveCapabilities {
        schema_version: CAPABILITIES_SCHEMA_VERSION,
        cpu_cores,
        formats: format_specs(),
        modes,
        limits: ArchiveLimits {
            max_unpacked_bytes: util::MAX_TOTAL_UNPACKED,
            max_entries: util::MAX_ARCHIVE_ENTRIES,
            max_undo_records: undo::MAX_UNDO_RECORDS,
            same_drive_backup_cap: undo::SAME_DRIVE_BACKUP_CAP,
            cross_drive_backup_cap: undo::CROSS_DRIVE_BACKUP_CAP,
            cross_drive_single_file_cap: undo::CROSS_DRIVE_SINGLE_FILE_CAP,
            max_tracked_files: undo::MAX_TRACKED_FILES,
            max_tracked_dirs: undo::MAX_TRACKED_DIRS,
        },
        rar_ready,
    }
}

struct BuiltinCodec(Kind);

impl ArchiveCodec for BuiltinCodec {
    fn kind(&self) -> Kind {
        self.0
    }

    fn spec(&self) -> FormatSpec {
        spec_for_kind(self.0)
    }

    fn list(&self, path: &Path, password: Option<&str>) -> Result<ArchiveInfo> {
        match self.0 {
            Kind::Zip => super::list_zip(path),
            Kind::SevenZ => sevenz_impl::list(path, password),
            Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => {
                tar_impl::list(path, self.0, password)
            }
            Kind::Gz | Kind::Bz2 | Kind::Xz => tar_impl::list_single(path, self.0),
            Kind::Rar => rar::list(path, password),
        }
    }

    fn extract(
        &self,
        path: &Path,
        out_dir: &Path,
        selected: &HashSet<usize>,
        password: Option<&str>,
        policy: Overwrite,
        profile: PerfProfile,
        dir_map: &HashMap<String, String>,
        undo: Option<&Arc<UndoTracker>>,
        progress: &Arc<Progress>,
        control: &Arc<TaskControl>,
    ) -> Result<ExtractReport> {
        match self.0 {
            Kind::Zip => zip_impl::extract(
                path, out_dir, selected, password, policy, profile, dir_map, undo, progress,
                control,
            ),
            Kind::SevenZ => sevenz_impl::extract(
                path, out_dir, selected, password, policy, profile, dir_map, undo, progress,
                control,
            ),
            Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => tar_impl::extract(
                path, out_dir, self.0, selected, password, policy, profile, dir_map, undo,
                progress, control,
            ),
            Kind::Gz | Kind::Bz2 | Kind::Xz => tar_impl::extract_single(
                path, out_dir, self.0, selected, policy, profile, undo, progress, control,
            ),
            Kind::Rar => rar::extract(
                path, out_dir, selected, password, policy, profile, dir_map, undo, progress,
                control,
            ),
        }
    }
}

pub fn codec_for(kind: Kind) -> Box<dyn ArchiveCodec> {
    Box::new(BuiltinCodec(kind))
}
