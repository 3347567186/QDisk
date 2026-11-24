/* 高级规则页：规则文件编辑、校验、预演与执行 */
(function () {
  const { h, T, toast, icon, fmtCount, busy, confirm, card, table, skeleton, empty, attachMenu, setActions } = UI;

  // 右键菜单用：复制文本到剪贴板。
  const copyText = UI.copy;

  const PREVIEW_ROWS = 300;
  const MAX_READ = 4 * 1024 * 1024;

  const TEMPLATE = [
    '# 规则文件示例（organize YAML 格式）',
    '# locations 相对下方「目标目录」解析，也可以写绝对路径；路径含空格时用单引号包裹',
    'rules:',
    "  - name: '把 PDF 归档到 PDF 子目录'",
    "    locations: '.'",
    '    filters:',
    '      - extension: pdf',
    '    actions:',
    "      - move: 'PDF'",
    "  - name: '把图片归档到 Images 子目录'",
    "    locations: '.'",
    '    filters:',
    '      - extension:',
    '          - jpg',
    '          - png',
    '    actions:',
    "      - move: 'Images'",
    ''
  ].join('\n');

  function mkBtn(zh, en, kind, iconName, onclick) {
    const label = h('span', null, T(zh, en));
    const b = h('button', { class: 'btn' + (kind ? ' ' + kind : ''), onclick },
      iconName ? icon(iconName) : null, label);
    b._label = label;
    b._zh = zh;
    b._en = en;
    return b;
  }

  function setBtnBusy(b, on, text) {
    b.disabled = on;
    b._label.textContent = on ? text : T(b._zh, b._en);
  }

  function fileName(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /* 助手起草的桥：规则页没打开时先把草稿存着，
     打开后自动填进编辑器——不然点了「填入规则编辑器」像没反应 */
  let liveFill = null;
  let liveJump = null;
  let pendingDraft = '';

  window.AIRulesDraft = {
    fill: function (text) {
      const s = String(text || '').trim();
      if (!s) return false;
      if (liveFill) return liveFill(s);
      pendingDraft = s;
      return true;
    }
  };

  async function mount(root) {
    const S = {
      diskPath: '',
      savedText: '',
      validated: null,
      preview: null,
      run: null
    };

    /* ---------------- 规则文件 ---------------- */
    const pathInput = h('input', {
      class: 'input grow mono',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('规则文件路径，例如 D:\\整理规则\\rules.yaml', 'Rule file path, e.g. D:\\rules\\rules.yaml')
    });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadFile();
      }
    });

    const dirtyBadge = h('span', { class: 'badge warn' }, T('未保存', 'Unsaved'));

    const btnLoad = mkBtn('载入', 'Load', 'ghost', 'folder', loadFile);
    const btnSave = mkBtn('保存', 'Save', 'primary', 'export', () => saveFile(false));
    const btnTemplate = mkBtn('插入示例', 'Insert sample', 'ghost', 'file', insertTemplate);
    const btnDraft = mkBtn('让助手起草', 'Draft with AI', 'ghost', 'spark', draftRules);

    /* ---------------- 顶部命令条（文件 + 目标目录 + 核心动作） ---------------- */
    const editor = h('textarea', {
      class: 'textarea',
      rows: 20,
      spellcheck: 'false',
      placeholder: T('在此粘贴或编辑 organize YAML 规则…', 'Paste or edit organize YAML rules here…')
    });
    editor.value = TEMPLATE;
    editor.addEventListener('input', () => {
      updateDirty(true);
      S.validated = null;
      renderValidation(null);
    });

    const folderInput = h('input', {
      class: 'input grow mono',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('规则作用的目标目录（必须是已存在的目录）', 'Target folder (must already exist)')
    });
    const btnBrowse = mkBtn('选择目录', 'Browse', 'ghost', 'folder', async () => {
      try {
        const picked = await API.pickFolder(folderInput.value.trim());
        if (picked) folderInput.value = String(picked);
      } catch (e) {
        toast(e.message || String(e), 'error');
      }
    });

    const btnValidate = mkBtn('校验', 'Validate', 'ghost', 'check', () => validate(false));
    const btnPreview = mkBtn('预览', 'Preview', 'ghost', 'scan', preview);
    const btnRun = mkBtn('执行规则', 'Run rules', 'danger', 'play', runRules);

    // 目标目录一改，之前的预览就不再对应当前路径：清掉，避免「按 A 的清单在 B 执行」
    folderInput.addEventListener('input', () => {
      if (S.preview) { S.preview = null; renderPreview(null); }
    });

    const cmdCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('规则工作台', 'Rules workbench')),
        dirtyBadge,
        h('span', { class: 'spacer' }),
        btnValidate, btnPreview, btnRun
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted small', style: { minWidth: '58px' } }, T('规则文件', 'Rule file')),
        pathInput, btnLoad, btnSave, btnTemplate, btnDraft
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted small', style: { minWidth: '58px' } }, T('目标目录', 'Target folder')),
        folderInput, btnBrowse
      )
    );

    /* ---------------- 规则内容（左栏） ---------------- */
    const lineBadge = h('span', { class: 'badge' }, '');
    const editorCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('规则内容', 'Rule content')),
        lineBadge
      ),
      editor
    );

    /* ---------------- 校验 + 预演 + 执行结果（右栏） ---------------- */
    const valBox = h('div', { class: 'stack' });
    const valCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('校验结果', 'Validation'))
      ),
      valBox
    );

    const previewSummary = h('div', { class: 'muted small' });
    const previewBox = h('div', { class: 'stack' });
    const previewCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('预演结果', 'Preview')),
        previewSummary
      ),
      previewBox
    );
    previewCard.classList.add('stretch-card');

    const runBox = h('div', { class: 'stack' });
    const runCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('执行结果', 'Run result'))
      ),
      runBox
    );
    runCard.hidden = true;

    root.appendChild(cmdCard);
    root.appendChild(h('div', { class: 'split-wb' },
      h('div', { class: 'split-left' }, editorCard),
      h('div', { class: 'split-right', style: { gap: '12px' } }, valCard, previewCard, runCard)
    ));

    updateDirty(false);
    renderValidation(null);
    renderPreview(null);

    /* ---------------- 状态显示 ---------------- */
    function updateDirty(clearPreview) {
      const dirty = editor.value !== S.savedText;
      dirtyBadge.textContent = dirty ? T('未保存', 'Unsaved') : T('已保存', 'Saved');
      dirtyBadge.className = 'badge ' + (dirty ? 'warn' : 'ok');
      const lines = editor.value ? editor.value.split('\n').length : 0;
      lineBadge.textContent = T('共 ' + fmtCount(lines) + ' 行', fmtCount(lines) + ' lines');
      if (clearPreview && S.preview) {
        S.preview = null;
        renderPreview(null);
      }
    }

    function renderValidation(r) {
      valBox.innerHTML = '';
      if (!r) {
        valBox.appendChild(h('div', { class: 'muted small' }, T('尚未校验', 'Not validated yet')));
        return;
      }
      if (r.ok) {
        valBox.appendChild(h('div', { class: 'toolbar' },
          h('span', { class: 'badge ok' }, T('校验通过', 'Valid')),
          h('span', { class: 'badge accent' }, fmtCount(r.rule_count) + T(' 条规则', ' rules'))
        ));
        return;
      }
      valBox.appendChild(h('div', { class: 'toolbar' },
        h('span', { class: 'badge danger' }, T('校验未通过', 'Invalid'))
      ));
      const errs = Array.isArray(r.errors) ? r.errors : [];
      if (!errs.length) {
        valBox.appendChild(h('div', { class: 'mono small' }, String(r.message || '')));
        return;
      }
      errs.forEach((err) => {
        const lines = String(err.message || '').split('\n').filter((l) => l.trim());
        valBox.appendChild(h('div', { class: 'stack' },
          err.line
            ? h('div', { class: 'small mono' }, T('第 ' + err.line + ' 行', 'Line ' + err.line))
            : null,
          ...lines.map((l) => h('div', { class: 'mono small' }, l))
        ));
      });
    }

    function renderPreview(r) {
      previewBox.innerHTML = '';
      previewSummary.textContent = '';
      if (!r) {
        previewBox.appendChild(empty(T('尚未预览', 'Not previewed yet'),
          T('选择目标目录后点「预览」，查看将要移动的文件', 'Choose a target folder and click Preview')));
        return;
      }
      const moves = Array.isArray(r.moves) ? r.moves : [];
      const skipped = Number(r.skipped) || 0;
      previewSummary.textContent = T(
        '共 ' + fmtCount(r.total) + ' 项将被移动' + (skipped ? '，跳过 ' + fmtCount(skipped) + ' 项' : ''),
        fmtCount(r.total) + ' item(s) to move' + (skipped ? ', ' + fmtCount(skipped) + ' skipped' : '')
      );
      if (!moves.length) {
        previewBox.appendChild(empty(T('没有文件会被移动', 'Nothing to move'),
          T('目标目录中没有文件匹配这些规则', 'No files in the target folder match these rules')));
        return;
      }
      const rows = moves.slice(0, PREVIEW_ROWS);
      const tbl = table({
        columns: [
          {
            key: 'src',
            label: T('源文件', 'Source'),
            render: (it) => h('span', { class: 'mono ellipsis', title: it.src || '' }, it.src || '')
          },
          {
            key: 'dst',
            label: T('目标', 'Destination'),
            render: (it) => h('span', { class: 'mono ellipsis', title: it.dst || '' }, it.dst || '')
          },
          {
            key: 'reason',
            label: T('说明', 'Detail'),
            width: '200px',
            render: (it) => h('span', { class: 'small ellipsis', title: it.reason || '' }, it.reason || '')
          }
        ],
        rows: rows,
        rowKey: (row, i) => String(i)
      });
      const wrap = h('div', { class: 'table-wrap tall' }, tbl);
      previewBox.appendChild(wrap);
      // 预演结果也支持右键：定位源文件 / 复制路径
      Array.from(tbl.querySelectorAll('tbody tr')).forEach((tr, i) => {
        const it = rows[i];
        if (!it) return;
        attachMenu(tr, [
          { label: T('在软件内定位源文件', 'Locate source in app'), icon: 'scan', action: () => it.src && (window.AIEntries && window.AIEntries.open ? window.AIEntries.open(it.src) : API.reveal(it.src).catch(() => {})) },
          { label: T('在系统文件管理器中定位', 'Reveal in system file manager'), icon: 'external', action: () => it.src && API.reveal(it.src).catch((e) => toast(errText(e), 'error')) },
          { label: T('复制源路径', 'Copy source path'), icon: 'copy', action: () => copyText(it.src || '') },
          { label: T('复制目标路径', 'Copy destination'), icon: 'copy', action: () => copyText(it.dst || '') }
        ]);
      });
      if (moves.length > PREVIEW_ROWS) {
        previewSummary.textContent += T('（仅显示前 ' + PREVIEW_ROWS + ' 项）', ' (first ' + PREVIEW_ROWS + ' shown)');
      }
    }

    function renderRun(r) {
      runCard.hidden = false;
      runBox.innerHTML = '';
      if (!r) {
        runBox.appendChild(empty(T('执行失败', 'Run failed'), T('请检查规则文件与目标目录', 'Check the rule file and target folder')));
        return;
      }
      const moved = Number(r.moved) || 0;
      const failed = Array.isArray(r.failed) ? r.failed : [];
      runBox.appendChild(h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtCount(moved)), h('div', { class: 'k' }, T('已移动', 'Moved'))),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtCount(failed.length)), h('div', { class: 'k' }, T('失败', 'Failed'))),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtCount(r.total || moved + failed.length)), h('div', { class: 'k' }, T('总计', 'Total'))),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, r.dry_run ? T('预演', 'Dry run') : T('已执行', 'Applied')), h('div', { class: 'k' }, T('模式', 'Mode')))
      ));
      if (!failed.length) {
        runBox.appendChild(h('div', { class: 'muted small' }, T('没有失败项。', 'No failures.')));
        return;
      }
      runBox.appendChild(h('div', { class: 'list' },
        ...failed.slice(0, PREVIEW_ROWS).map((f) => h('div', { class: 'list-item' },
          h('div', { class: 'mono ellipsis', style: { flex: '1' }, title: f.src || '' },
            f.src || T('（未知路径）', '(unknown path)')),
          h('div', { class: 'small', style: { color: 'var(--danger)' } }, f.why || '')
        ))
      ));
      if (failed.length > PREVIEW_ROWS) {
        runBox.appendChild(h('div', { class: 'muted small' },
          T('仅显示前 ' + PREVIEW_ROWS + ' 项失败', 'First ' + PREVIEW_ROWS + ' failures shown')));
      }
    }

    /* ---------------- 文件读写 ---------------- */
    async function loadFile() {
      const p = pathInput.value.trim();
      if (!p) {
        toast(T('请先填写规则文件路径', 'Enter a rule file path first'), 'warn');
        pathInput.focus();
        return;
      }
      setBtnBusy(btnLoad, true, T('载入中…', 'Loading…'));
      try {
        const text = await API.readText(p, MAX_READ);
        if (typeof text !== 'string') throw new Error(T('读取结果不是文本', 'The file is not readable text'));
        editor.value = text;
        S.diskPath = p;
        S.savedText = text;
        S.preview = null;
        renderPreview(null);
        updateDirty(false);
        toast(T('已载入规则文件', 'Rule file loaded'), 'ok');
        await validate(true);
      } catch (e) {
        toast(T('载入失败：', 'Load failed: ') + (e.message || String(e)), 'error');
      } finally {
        setBtnBusy(btnLoad, false);
      }
    }

    async function saveFile(silent) {
      setBtnBusy(btnSave, true, T('保存中…', 'Saving…'));
      try {
        const picked = await API.saveText(fileName(pathInput.value) || 'rules.yaml', editor.value);
        if (!picked) return false;
        const p = String(picked);
        pathInput.value = p;
        S.diskPath = p;
        S.savedText = editor.value;
        updateDirty(false);
        if (!silent) toast(T('规则已保存', 'Rules saved'), 'ok');
        return true;
      } catch (e) {
        toast(e.message || String(e), 'error');
        return false;
      } finally {
        setBtnBusy(btnSave, false);
      }
    }

    async function ensureOnDisk() {
      const p = pathInput.value.trim();
      if (!p) {
        toast(T('请先填写或选择规则文件路径', 'Enter or choose a rule file path first'), 'warn');
        pathInput.focus();
        return false;
      }
      if (S.diskPath !== p || editor.value !== S.savedText) {
        const yes = await confirm({
          title: T('内容尚未保存', 'Unsaved content'),
          body: T('校验、预览和执行读取的是磁盘上的规则文件，当前编辑内容还没有保存到该路径。是否先保存？',
            'Validate, preview and run read the rule file from disk, but the current content is not saved there. Save it first?'),
          ok: T('保存并继续', 'Save and continue')
        });
        if (!yes) return false;
        return await saveFile(true);
      }
      return true;
    }

    function insertTemplate() {
      const replace = async () => {
        editor.value = TEMPLATE;
        updateDirty(true);
        S.validated = null;
        renderValidation(null);
      };
      if (editor.value.trim() && editor.value.trim() !== TEMPLATE.trim()) {
        confirm({
          title: T('插入示例', 'Insert sample'),
          body: T('示例会覆盖编辑器中现有的内容，是否继续？', 'The sample will replace the current content. Continue?'),
          ok: T('覆盖', 'Replace')
        }).then((yes) => { if (yes) replace(); });
      } else {
        replace();
      }
    }

    /* ---------------- 助手起草 ---------------- */
    /* 助手产出的 YAML 只落到编辑器里，绝不自动写盘：
       规则文件一旦落盘就会被「执行规则」按下去，草稿必须先过人的眼 */
    function applyDraft(text) {
      const s = String(text || '').trim();
      if (!s) return false;
      editor.value = s + (s.endsWith('\n') ? '' : '\n');
      updateDirty(true);
      S.validated = null;
      renderValidation(null);
      editor.focus();
      editor.scrollTop = 0;
      toast(T('已填入编辑器，先点「校验」确认再保存', 'Loaded into the editor — validate before saving'), 'ok');
      return true;
    }

    liveFill = applyDraft;

    if (pendingDraft) {
      const d = pendingDraft;
      pendingDraft = '';
      applyDraft(d);
    }

    function draftRules() {
      if (!window.AIDrawer) {
        toast(T('助手还没就绪', 'Assistant is not ready yet'), 'warn');
        return;
      }
      const folder = folderInput.value.trim();
      const n = (editor.value.match(/^\s*-\s+name:/gm) || []).length;
      window.AIDrawer.open({
        title: T('问助手 · 起草规则', 'Ask AI · Draft rules'),
        question: T('帮我起草一份 organize YAML 规则：把「' + (folder || '目标目录') +
          '」里的文件按类型分到各自的子目录。只输出一个 ```yaml 代码块，不要解释。',
          'Draft an organize YAML rule set that sorts files in "' + (folder || 'the target folder') +
          '" into per-type subfolders. Output only one ```yaml code block, no prose.'),
        ctx: () => ({
          page: '高级规则',
          dir: folder,
          note: T('当前规则共 ' + fmtCount(n) + ' 条', 'Current rules: ' + fmtCount(n))
        })
      });
    }

    /* ---------------- 校验 / 预览 / 执行 ---------------- */
    /* 校验和预览直接读编辑器里的文本，不必先存盘：
       草稿阶段就存盘会让磁盘上多出一堆半成品规则文件 */
    async function validate(silent) {
      if (!editor.value.trim()) {
        toast(T('编辑器还是空的，先写规则或插入示例', 'Editor is empty — write rules or insert the sample first'), 'warn');
        return false;
      }
      setBtnBusy(btnValidate, true, T('校验中…', 'Checking…'));
      try {
        const r = await API.engine('rules.validate', { text: editor.value });
        S.validated = r;
        renderValidation(r);
        if (r.ok) {
          if (!silent) {
            toast(T('校验通过：共 ' + fmtCount(r.rule_count) + ' 条规则',
              'Valid: ' + fmtCount(r.rule_count) + ' rule(s)'), 'ok');
          }
          return true;
        }
        toast(T('规则校验未通过', 'Validation failed'), 'error');
        return false;
      } catch (e) {
        S.validated = null;
        renderValidation(null);
        toast(e.message || String(e), 'error');
        return false;
      } finally {
        setBtnBusy(btnValidate, false);
      }
    }

    async function preview() {
      const folder = folderInput.value.trim();
      if (!folder) {
        toast(T('请选择目标目录', 'Choose a target folder'), 'warn');
        folderInput.focus();
        return;
      }
      if (!editor.value.trim()) {
        toast(T('编辑器还是空的，先写规则或插入示例', 'Editor is empty — write rules or insert the sample first'), 'warn');
        return;
      }
      setBtnBusy(btnPreview, true, T('预览中…', 'Previewing…'));
      try {
        const r = await API.engine('rules.preview', { text: editor.value, folder: folder });
        S.preview = r;
        renderPreview(r);
        toast(T('预演完成：' + fmtCount(r.total) + ' 项将被移动', 'Preview: ' + fmtCount(r.total) + ' item(s) to move'), 'ok');
      } catch (e) {
        S.preview = null;
        renderPreview(null);
        toast(e.message || String(e), 'error');
      } finally {
        setBtnBusy(btnPreview, false);
      }
    }

    async function runRules() {
      const folder = folderInput.value.trim();
      if (!folder) {
        toast(T('请选择目标目录', 'Choose a target folder'), 'warn');
        folderInput.focus();
        return;
      }
      if (!(await ensureOnDisk())) return;
      const path = pathInput.value.trim();
      if (S.preview && S.preview.folder && S.preview.folder !== folder) {
        toast(T('目标目录已改，请重新预览再执行', 'Folder changed — preview again first'), 'warn');
        return;
      }
      const yes = await confirm({
        title: T('执行规则', 'Run rules'),
        body: T('将按规则移动「' + folder + '」中匹配的文件。\n\n此操作会真实修改磁盘文件，执行后无法通过本页撤销。建议先点「预览」确认结果。',
          'Files matching the rules in "' + folder + '" will be moved.\n\nThis really changes files on disk and cannot be undone from this page. Preview first.'),
        ok: T('执行', 'Run'),
        danger: true
      });
      if (!yes) return;
      setBtnBusy(btnRun, true, T('执行中…', 'Running…'));
      const r = await busy(
        () => API.engine('rules.run', { path: path, folder: folder, confirm: true }),
        T('正在按规则移动文件…', 'Moving files by rules…'), 'rules'
      );
      setBtnBusy(btnRun, false);
      if (!r) return;
      renderRun(r);
      const failed = Array.isArray(r.failed) ? r.failed.length : 0;
      if (!failed) {
        toast(T('执行完成：移动 ' + fmtCount(r.moved) + ' 项', 'Done: ' + fmtCount(r.moved) + ' moved'), 'ok');
      } else {
        toast(T('执行完成：移动 ' + fmtCount(r.moved) + ' 项，失败 ' + fmtCount(failed) + ' 项',
          'Done: ' + fmtCount(r.moved) + ' moved, ' + fmtCount(failed) + ' failed'), 'warn');
      }
      S.preview = null;
      renderPreview(null);
    }

    setActions();

    liveJump = function (payload) {
      const p = payload || {};
      if (p.folder || p.dir) {
        folderInput.value = String(p.folder || p.dir).trim();
        S.preview = null;
        renderPreview(null);
      }
      if (p.yaml) applyDraft(String(p.yaml));
    };

    /* 切页后编辑器和函数都成了孤儿：清掉桥，草稿改为挂起等下次挂载 */
    return function () {
      liveFill = null;
      liveJump = null;
      setActions();
    };
  }

  window.Pages = window.Pages || {};
  window.Pages.rules = {
    title: ['高级规则', 'Rules'],
    subtitle: ['用 organize YAML 规则批量移动文件，先校验与预演再执行', 'Batch-move files with organize YAML rules: validate and preview first'],
    mount: mount,
    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
