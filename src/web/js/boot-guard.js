/* 前端崩溃兜底：把 JS 异常写进应用日志
    ------------------------------------------------------------
    WebView2 里脚本一挂，界面就是一片白，Rust 侧看不到任何东西，只能靠猜。
   这个守卫在其它脚本之前加载，把「首个异常」「脚本加载失败」「未处理的 Promise」
   都收集起来，等 API 就绪后写进 logs\app-*.log，并保留到 window.__BOOT_ERRORS__。

   约定：它自己绝不能抛异常，也绝不阻塞启动。 */
(function () {
  if (window.__BOOT_GUARD__) return;
  window.__BOOT_GUARD__ = true;

  const list = [];
  window.__BOOT_ERRORS__ = list;

  const where = (file, line, col) => {
    const name = String(file || '').split('/').pop() || '(inline)';
    return name + ':' + line + (col ? ':' + col : '');
  };

  const push = (kind, text) => {
    if (list.length >= 20) return;
    list.push(kind + ' ' + text);
  };

  window.addEventListener('error', (e) => {
    // 资源加载失败：<script>/<link> 的 error 只落在 target 上，没有 message
    const t = e && e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      push('R', t.tagName.toLowerCase() + ' 加载失败 ' + (t.src || t.href || ''));
      return;
    }
    push('E', ((e && e.message) || '脚本错误') + ' @ ' + where(e && e.filename, e && e.lineno, e && e.colno));
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    push('P', (r && (r.stack || r.message)) ? String(r.message || r) : String(r));
  });

  /* API 由 api.js 提供，它可能比本文件晚一点就绪 */
  let tries = 0;
  const flush = () => {
    if (!window.API || typeof window.API.logLine !== 'function') {
      if (++tries < 100) setTimeout(flush, 60);
      return;
    }
    list.forEach((line) => {
      try { window.API.logLine('error', '前端 ' + line); } catch (_) { /* 记不上就算了 */ }
    });
    if (list.length) {
      try { console.error('前端错误 ' + list.length + ' 条，已写入应用日志'); } catch (_) { /* ignore */ }
    }
  };
  const kick = () => setTimeout(flush, 300);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick);
  else kick();
})();
