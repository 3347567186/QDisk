/* 与 Rust 外壳通信 */
(function () {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) console.warn('Tauri 运行时不可用，API 调用会失败');

  const invoke = (cmd, args) => {
    if (!core) return Promise.reject(new Error('未在 Tauri 中运行'));
    return core.invoke(cmd, args);
  };

  const engine = async (method, params) => {
    try {
      return await invoke('engine_call', { method, params: params || {} });
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : (e && e.message) || '引擎调用失败');
    }
  };

  window.API = {
    engine,
    engineCall: engine,
    pickFolder: (start) => invoke('pick_folder', { start: start || null }),
    saveText: (name, content) => invoke('save_text', { name, content }),
    reveal: (path) => invoke('reveal', { path }),
    openPath: (path) => invoke('open_path', { path }),
    resolvePath: (path) => invoke('resolve_local_path', { path }),
    configGet: () => invoke('config_get'),
    configSet: (patch) => invoke('config_set', { patch }),
    appInfo: () => invoke('app_info'),
    appCapabilities: () => invoke('app_capabilities'),
    dataDirMigratePreview: (targetDir) => invoke('data_dir_migrate_preview', { targetDir }),
    dataDirMigrate: (targetDir) => invoke('data_dir_migrate', { targetDir }),
    engineCapabilities: () => engine('capabilities', {}),
    isAdmin: () => invoke('is_admin'),
    runAsAdmin: () => invoke('run_as_admin'),
    toggleFullscreen: () => invoke('toggle_fullscreen'),
    setWindowTheme: (theme) => invoke('set_window_theme', { theme }),
    engineInfo: () => invoke('engine_info'),
    engineRestart: () => invoke('engine_restart'),
  engineSleep: () => invoke('engine_sleep'),
    ping: () => engine('ping', {}),
    getAutostart: () => invoke('get_autostart'),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    scheduleSet: (enabled, time, days, cache, screenshots) => invoke('schedule_set', { enabled, time, days, cache, screenshots }),
    scheduleGet: () => invoke('schedule_get'),
    logList: () => invoke('log_list'),
    topFiles: (dir, limit) => invoke('top_files', { dir, limit }),
  scanEmptyDirs: (dir, max, depth) => invoke('scan_empty_dirs', { dir, max, depth }),
  fileSignals: (paths) => invoke('file_signals', { paths }),
  removeEmptyDirs: (paths) => invoke('remove_empty_dirs', { paths }),
  historyList: () => invoke('history_list'),
  storeApps: () => invoke('store_apps'),
  removeStoreApp: (pkg, confirm) => invoke('remove_store_app', { package: pkg, confirm }),
  readText: (path, maxBytes) => invoke('read_text', { path, maxBytes }),
    pickArchive: () => invoke('pick_archive'),
    pickFiles: () => invoke('pick_files'),
    pickArchiveSave: (defaultName) => invoke('pick_archive_save', { defaultName }),
    archiveOpen: (path, password) => invoke('archive_open', { path, password: password || null }),
    archiveExtract: (path, outDir, indices, password, overwrite, mode) =>
      invoke('archive_extract', { path, outDir, indices, password: password || null, overwrite, mode: mode || null }),
    archiveCreate: (sources, dest, format, mode, password) =>
      invoke('archive_create', { sources, dest, format, mode, password: password || null }),
    archiveCheckExtractConflicts: (path, outDir, indices, password, createSubfolder) =>
      invoke('archive_check_extract_conflicts', {
        path,
        outDir,
        indices,
        password: password || null,
        createSubfolder: !!createSubfolder
      }),
    archiveCheckCreateConflict: (dest) => invoke('archive_check_create_conflict', { dest }),
    archiveUndo: (undoId) => invoke('archive_undo', { undoId }),
    archiveUndoDiscard: (undoId) => invoke('archive_undo_discard', { undoId: undoId || null }),
    archivePause: () => invoke('archive_pause'),
    archiveResume: () => invoke('archive_resume'),
    archiveCancel: () => invoke('archive_cancel'),
    archivePreview: (path, index, password, name, size) => invoke('archive_preview', {
      path, index, password: password || null, name: name || null, size: size || null,
    }),
    archivePreviewClear: () => invoke('archive_preview_clear'),
    archiveCapabilities: () => invoke('archive_capabilities'),
    archiveRarStatus: () => invoke('archive_rar_status'),
    archiveRarInstall: () => invoke('archive_rar_install'),
    /* 在线更新（检查 / 下载 / 取消 / 安装 / 配置 / 缓存清理） */
    updaterStatus: () => invoke('updater_status'),
    updaterConfigGet: () => invoke('updater_config_get'),
    updaterConfigSet: (patch) => invoke('updater_config_set', { patch }),
    updaterCheck: (channel) => invoke('updater_check', {
      channel: channel || null
    }),
    updaterDownload: (opts) => invoke('updater_download', {
      url: opts.url,
      sha256: opts.sha256,
      size: Number(opts.size || 0),
      version: opts.version,
      fileName: opts.fileName,
      packageKind: opts.packageKind
    }),
    updaterCancel: () => invoke('updater_cancel'),
    updaterClearCache: () => invoke('updater_clear_cache'),
    updaterInstall: (silent) => invoke('updater_install', { silent: !!silent }),
  logRead: (path, maxBytes) => invoke('log_read', { path, maxBytes: maxBytes || null }),
    logClear: () => invoke('log_clear'),
    logLine: (level, msg) => invoke('log_line', { level, msg }),
    /* AI 助手：列目录 / 读文件 / 磁盘根 / 唯一网络出口 / 会话落盘 */
    listDir: (dir, limit, offset) => invoke('list_dir', {
      dir,
      limit: limit || null,
      offset: offset || null
    }),
    fileRead: (path, offset, maxChars) => invoke('agent_read', {
      path,
      offset: offset || null,
      maxChars: maxChars || null
    }),
    agentRoots: () => invoke('agent_roots'),
    aiHttp: (req) => invoke('ai_http', {
      req: {
        url: (req && req.url) || '',
        method: (req && (req.method || 'POST')) || 'POST',
        headers: (req && req.headers) || {},
        body: (req && req.body) || '',
        /* Rust 侧读的是 snake_case；这里统一收口，免得调用方两套写法 */
        timeout_ms: (req && (req.timeout_ms || req.timeoutMs)) || 20000
      }
    }),
    /* 流式版：onChunk 每收到一段就回调一次（完整 UTF-8 文本片段），
       返回值和 aiHttp 一样，是 {status, body, elapsed_ms}，body 为全文。
       运行时不支持 Channel 时返回 null，调用方据此退回 aiHttp。 */
    aiHttpStream: (req, onChunk) => {
      const Channel = core && core.Channel;
      if (!Channel) return null;
      const ch = new Channel();
      if (typeof onChunk === 'function') ch.onmessage = (piece) => onChunk(piece);
      return invoke('ai_http_stream', {
        req: {
          url: (req && req.url) || '',
          method: (req && (req.method || 'POST')) || 'POST',
          headers: (req && req.headers) || {},
          body: (req && req.body) || '',
          timeout_ms: (req && (req.timeout_ms || req.timeoutMs)) || 60000
        },
        onChunk: ch
      });
    },
    aiStore: (op, name, content) => invoke('ai_store', { op, name: name || null, content: content || null }),
    /* 停止正在进行的模型请求：Rust 侧置取消旗标，读响应循环下一片就退出。
       页面同时用逻辑取消（不等网络）兜住，这条只是把后台连接也断掉。 */
    aiCancel: () => invoke('ai_cancel')
  };
})();
