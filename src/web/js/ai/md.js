/* AI 助手 · 轻量 Markdown 渲染（零依赖、纯字符串拼接）
   ------------------------------------------------------------
   AIMd.render(text, { breaks })  -> HTML 字符串
   AIMd.escape(s)                 -> HTML 转义
   AIMd.inline(s)                 -> 只处理行内语法
   AIMd.blocks(text)              -> 块数组（调试 / 测试用）
   AIMd.hasMarkup(text)           -> 这段文本是否真含 Markdown 语法

   安全模型：所有用户文本先 escape() 再拼标签，用户内容不会以原文进入
   HTML；链接只放行 http / https / mailto，其余协议降级成纯文本；代码块
   与行内代码在转义后立刻被「占位」，不再经过任何行内解析。

   本地路径（1.35）：`file:///` 链接、独占一段的行内代码、正文里的裸路径
   （D:\… 与 \\server\…）都渲染成 <a class="md-path" data-path="…">，
   由 AIEntries 这层接管点击——回答里写「打开 D:\Downloads 看看」时，
   那句话才是真的能点的。这里不做任何文件操作，只产出一个带路径的标签。

   支持的语法：标题 1-6、段落、无序 / 有序列表（一层嵌套）、围栏代码块、
   行内代码、粗体 / 斜体 / 删除线、链接、分隔线、引用、表格。
   未闭合或畸形的写法按普通文本处理，不抛异常。 */
(function (root) {
  'use strict';

  /* ---------------- 转义 ---------------- */

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escape(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  }

  /* 占位符：控制字符 + 序号。escape() 与强调正则都不会碰它，
     代码里的 ** 因此不会被二次解析。 */
  const SLOT_RE = /\u0000(\d+)\u0000/g;

  const LINK_RE = /\[([^\[\]\n]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
  const SAFE_URL = /^(?:https?:|mailto:)/i;

  /* ---------------- 本地路径 ----------------
     只产标签，不做任何文件操作：点击由 AIEntries 接管。
     路径从「已转义的文本」里认出来，属性值因此天然安全（引号已变成 &quot;）。
     排除 & 是为了不吞掉 &amp; / &quot; 这类实体；
     排除全角开闭标点与路径体里的冒号，并用前瞻 (?![A-Za-z]:[\\/]) 防止
     「D:\Temp和C:\Logs」被粘成一条坏路径。 */
  const PATH_STOP_CHARS = '<>\\s&"\'`|?*，。；：！？、（）【】「」『』《》〈〉—…·';
  const RE_ABS_PATH = new RegExp(
    '(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\s\\\\<>"\':])(?:&amp;|[^' + PATH_STOP_CHARS + ':])*'
  );
  /* 裸路径识别（1.45 增强）：
     1. 放行 HTML 实体 &amp;（还原真实 & 目录如 D:\R&D\file.txt，仍拦截 &lt;/&gt;/&quot; 防 XSS）；
     2. 支持带空格的中间目录（含中英文空格目录，但禁止跨中文连词粘连第二条路径）；
     3. 支持末段含空格的真实文件名（如 屏幕截图 2026-06-09 115005.png、My Report (2).pdf）
        及常见含空格系统/应用目录末段（如 Program Files、Program Files (x86)、User Data、Common Files），
        同时拒吞英文介词/连词或中文自然语言。 */
  const RE_INLINE_PATH = new RegExp(
    '(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\s\\\\<>"\'&:])'
    + '(?:'
      + '(?![A-Za-z]:[\\\\/])(?:&amp;|[^' + PATH_STOP_CHARS + ':])'
      + '|(?![ ](?:和|与|或|及|跟|到|至|在|的|里|中|下|是|有|共|约|把|将|给|让|可|已|未|请|看|删|清|打开|清理|删除|检查))(?:[ ][A-Za-z0-9\\u4e00-\\u9fff._()+-]+)+[\\\\/]'
    + ')*'
    + '(?:'
      + '(?![ ](?:and|or|to|for|in|on|at|of|with|from|is|are|was|has|have|can|will|not|by|as|the|this|that)\\b)'
      + '(?:[ ][A-Za-z0-9._()+-]+){1,4}\\.(?:7z|3gp|3ds|[A-Za-z][A-Za-z0-9]{0,7})(?![A-Za-z0-9_])'
      + '|[ ](?:Files(?: \\(x86\\))?|Data|Menu|Games|Folder|Documents|Downloads|Pictures|Videos|Music|Desktop|Settings|Cache|Temp|Logs|Backup|App|Apps|ProgramData|LocalLow|WebView|EdgeWebView)(?=$|[\\s,.;:!?，。；：！？、（）【】「」『』《》〈〉—…·<])'
    + ')?'
  );
  /* 标签 | 路径：只处理标签之外的文本段，且用负向后行断言代替捕获前缀，
     这样「D:\Temp和C:\Logs」拆掉前段「和」后，紧跟的 C:\Logs 也能紧接着匹配。 */
  const RE_TEXT_PATH = new RegExp('(<[^>]*>)|(?<![A-Za-z0-9_.\\u0000])(' + RE_INLINE_PATH.source + ')', 'g');
  const CJK_TAIL = /[.,;:!?，。；：、]+$/;
  const CJK_PUNCT_SPLIT_RE = /[（【「『《》〈〉—…·，。；：！？、）\]」』]/;
  /* 完整文件名扩展名判定：避免误切 v2中文版.zip、2026.11报告.docx */
  const LEAF_ENDS_WITH_EXT_RE = /\.(?:7z|3gp|3ds|[A-Za-z][A-Za-z0-9]{0,7})$/;
  /* 扩展名后紧跟中文自然语言：如 setup.exe是否可删、报告.pdf里的内容、a.7z压缩包 */
  const EXT_CJK_TAIL_RE = /^(.*?\.(?:7z|3gp|3ds|[A-Za-z][A-Za-z0-9]{0,7}))([\u4e00-\u9fff].*)$/;
  /* 盘符根目录或尾斜杠后紧跟自然语言：如 D:\里的文件、D:\Downloads\目录下；保留 D:\下载、D:\工作 */
  const ROOT_PROSE_RE = /^(?:里的|中的|下的|上的|内的|里面|下面|上面|内部|里有|中有|下有|上有|内有|里共|中共|下共|盘里|盘中|盘上|盘下|盘共|盘占|盘约|盘有|盘剩|盘可用|根目录|目录里|目录下|目录中|目录内|文件夹里|文件夹下|文件夹中|文件夹内|路径下|路径中|路径里|共有|一共|合计|总共|约有|大约|大概|超过|占用|占据|占了|剩余|可用|空间|包含|含有|存有|发现|找到|已经|尚未|没有|无法|不能|可以|可能|需要|建议|是否|应该|正在|释放|清理|清空|删除|移除|移动|复制|打开|定位|查看|以及$|和$|与$|或$|及$|等$|里$|中$|下$|上$|内$|盘$|目录$|文件夹$|路径$)/;
  /* ASCII 目录末段后紧跟中文自然语言：如 Downloads里的文件、Temp目录、AppData下、Temp和；
     保留合法混名如 PDF报告、Vue项目、PPT模板、AI工具、PDF中文版 */
  const ASCII_LEAF_CJK_RE = /^([A-Za-z][A-Za-z0-9._()+-]*)([\u4e00-\u9fff].*)$/;
  const ASCII_PROSE_START_RE = /^(?:里的|中的|下的|上的|内的|里面|下面|上面|内部|里有|中有|下有|上有|内有|里共|中共|下共|目录下|目录中|目录里|目录内|目录|文件夹下|文件夹中|文件夹里|文件夹内|文件夹|路径下|路径中|路径里|路径|位置下|位置里|位置|根目录|分区|磁盘|盘里|盘中|盘上|盘下|盘$|共有|一共|合计|总共|约有|大约|大概|超过|不到|至少|最多|占用|占据|占了|占到|剩余|可用|空间|大小|体积|包含|含有|存有|存在|放着|放了|发现|找到|检测到|扫描到|显示|提示|已经|尚未|还没|没有|无法|不能|不可|可以|可能|需要|建议|推荐|请|是否|应该|最好|尽量|正在|已被|将被|用于|属于|位于|来自|指向|释放|清理|清空|删除|移除|移到|移至|复制到|移动到|备份到|解压到|压缩到|打开|定位|查看|检查|确认|保留|跳过|缓存|日志|备份|文件|压缩包|安装包|大文件|垃圾|残留|碎片|数据|列表|详情|内容|总数|数量|以及|等等|[里中下上内](?:$|[的有面共约存含包找发清删移全都很太占大小多少已未无可谓需是为还也就只0-9])|的|是|有|为|在|了|呢|吗|吧|啊|和|与|或|及|跟|同|到|至|等|共|约|占|可|已|未|无|需|要|会|能|被|把|将|从|向|往|对|给|让|比|较|最|很|都|也|还|就|才|只|并|且|但|而|因|若|如)/;
  /* 中文目录末段尾部粘连自然语言：如 D:\下载\旧文件目录下、D:\工作资料里的文件；
     要求前方至少留有目录主体，不误伤 新建文件夹、临时目录、内部资料、清理工具、和平精英 */
  const CJK_LEAF_PROSE_RE = /^(.+?)((?:目录下|目录中|目录里|目录内|目录共|目录占|目录约|目录有|目录是|目录为|目录可|目录需|目录已|目录含|目录包|文件夹下|文件夹中|文件夹里|文件夹内|文件夹共|文件夹占|文件夹约|文件夹有|文件夹是|路径下|路径中|路径里|路径内|路径是|位置下|位置里|位置中|里的|中的|下的|上的|内的|里面|下面|上面|里有|中有|下有|上有|内有|里共|中共|下共|共有|一共|合计|总共|约有|大约|大概|超过|占用|占据|占了|剩余|可用|包含|含有|存有|放着|放了|发现|找到|已经|尚未|还没|没有|无法|不能|可以|可能|需要|建议|推荐|是否|应该|正在|已被|将被|释放|清理|清空|删除|移除|移到|移至|复制到|移动到|打开|定位|查看|检查|确认|以及|等等).*|[里中下上内]$|[和与或及跟至等])$/;

  function splitPathTail(raw) {
    let s = String(raw || '');
    let tail = '';
    const cutAt = (idx) => {
      if (idx < 0 || idx >= s.length) return;
      tail = s.slice(idx) + tail;
      s = s.slice(0, idx);
    };

    /* 1. 遇到全角开/闭标点（如 （约 2 GB）、【桌面】、——）立刻截断 */
    const pIdx = s.search(CJK_PUNCT_SPLIT_RE);
    if (pIdx > 0) cutAt(pIdx);

    /* 2. 去掉末尾 ASCII / 中文句末标点与不成对的右括号，并保留到 tail */
    const tp = s.match(CJK_TAIL);
    if (tp) cutAt(s.length - tp[0].length);
    while (/[)\]}]$/.test(s)) {
      const open = (s.match(/[(\[{]/g) || []).length;
      const close = (s.match(/[)\]}]/g) || []).length;
      if (close <= open) break;
      cutAt(s.length - 1);
    }

    /* 3. 只针对末段路径做中英文自然语言边界剥离，保护中间目录名 */
    const lastSep = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (lastSep >= 0) {
      const prefix = s.slice(0, lastSep + 1);
      const leaf = s.slice(lastSep + 1);
      if (leaf) {
        /* 3a. 盘符根目录或尾斜杠后紧跟中文自然语言：D:\里的文件、D:\Downloads\目录下 */
        if (ROOT_PROSE_RE.test(leaf)) {
          cutAt(lastSep + 1);
          if (s.length > 3 && /[\\/]$/.test(s)) {
            /* 保留盘符根 D:\ 的反斜杠；非根目录去尾斜杠让链接更干净 */
            s = s.replace(/[\\/]+$/, '');
          }
        } else if (!LEAF_ENDS_WITH_EXT_RE.test(leaf)) {
          /* 3b. 扩展名后紧跟中文：D:\a\setup.exe是否可删、报告.pdf里的内容 */
          const extM = leaf.match(EXT_CJK_TAIL_RE);
          if (extM) {
            cutAt(prefix.length + extM[1].length);
          } else {
            /* 3c. ASCII 末段后紧跟中文自然语言：Downloads里的文件、Temp目录、AppData下 */
            const ascM = leaf.match(ASCII_LEAF_CJK_RE);
            if (ascM && ASCII_PROSE_START_RE.test(ascM[2])) {
              cutAt(prefix.length + ascM[1].length);
            } else {
              /* 3d. 中文末段后粘连自然语言：D:\工作资料里的文件、D:\下载\旧文件目录下 */
              const cjkM = leaf.match(CJK_LEAF_PROSE_RE);
              if (cjkM) {
                cutAt(prefix.length + cjkM[1].length);
              }
            }
          }
        }
      }
    }

    /* 4. 二次清理剥离后暴露出的句末标点或多余空格 */
    const tp2 = s.match(CJK_TAIL);
    if (tp2) cutAt(s.length - tp2[0].length);
    return { path: s, tail };
  }

  function trimPath(p) {
    return splitPathTail(p).path;
  }

  function cleanPath(p) {
    return splitPathTail(String(p || '').trim()).path;
  }

  const EXT_BTN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  function pathAnchor(p, inner) {
    const T = root.UI && typeof root.UI.T === 'function' ? root.UI.T : (zh) => zh;
    const openTip = escape(T('优先在软件内打开：', 'Open in app: ')) + p;
    const extTip = escape(T('在系统文件管理器中打开', 'Open in system file manager'));
    return '<span class="md-path-wrap">'
      + '<a class="md-path" href="#" data-path="' + p + '" title="' + openTip + '">'
      + (inner || p) + '</a>'
      + '<button type="button" class="md-path-ext" data-path="' + p + '" title="' + extTip + '" aria-label="' + extTip + '">'
      + EXT_BTN_SVG + '</button>'
      + '</span>';
  }

  function asPath(text) {
    const t = String(text || '').trim();
    if (/^[A-Za-z]:[\\/]$/.test(t)) return t;
    if (t.length < 4) return '';
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(t)) return '';
    if (/\s{2,}|[<>"|?*]/.test(t)) return '';
    /* 整段就是一个路径：允许中间有空格（Program Files），但不允许空段 */
    if (/[\\/]{2,}$/.test(t) && t.length < 5) return '';
    return t;
  }

  function fileUrlToPath(href) {
    let s = String(href || '').replace(/^file:\/{2,}/i, '');
    /* file:///D:/x -> /D:/x；file://server/share/x -> server/share/x（补回 UNC 前缀） */
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    else if (/^[A-Za-z0-9._-]+\//.test(s) && !/^[A-Za-z]:/.test(s)) s = '\\\\' + s;
    try { s = decodeURIComponent(s); } catch (e) { /* 非法编码就原样用 */ }
    s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return s.replace(/\//g, '\\');
  }

  /* 强调：bold -> del -> em(*)，顺序不能反，否则 ** 会被单个 * 规则拆坏。
     * 规则要求左边界不是单词字符，数学式 2*3*4 不会被当成斜体。 */
  function emphasis(s) {
    return s
      .replace(/\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^\s~](?:[^~]*?[^\s~])?)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>');
  }

  /* ---------------- 行内 ---------------- */

  function inlineHTML(raw, breaks) {
    if (raw === null || raw === undefined) return '';
    let src = escape(String(raw).replace(/\r\n?/g, '\n')).replace(/\u0000/g, '');

    const slots = [];
    const put = (html) => {
      slots.push(html);
      return '\u0000' + (slots.length - 1) + '\u0000';
    };
    const resolve = (s) => s.replace(SLOT_RE, (m, i) => {
      const html = slots[Number(i)];
      return html === undefined ? '' : html;
    });

    /* 1. 行内代码：先转义再占位，内部不再解析任何语法。
       整段就是一个路径时，包成可点标签——安装命令那是代码，路径不是。
       若模型把自然语言写进了反引号（如 `D:\Downloads目录`），剥离尾部汉字留在链接外。 */
    src = src.replace(/`([^`\n]*)`/g, (m, code) => {
      const sp = splitPathTail(code);
      const p = asPath(sp.path);
      if (p) {
        if (sp.tail) return put(pathAnchor(p, '<code>' + p + '</code>')) + sp.tail;
        return put(pathAnchor(p, '<code>' + code + '</code>'));
      }
      return put('<code>' + code + '</code>');
    });

    /* 2. 链接：label 先做强调（此时仍是占位符，不会误伤代码内容） */
    src = src.replace(LINK_RE, (m, label, url, offset) => {
      if (offset > 0 && src.charAt(offset - 1) === '!') return m; /* 图片不支持，原样留字 */
      const href = String(url).trim();
      /* file:// 链接 = 用户/AI 明确指的本地位置，交给我们自己打开，
         而不是交给浏览器（WebView2 里那一步什么都不会发生） */
      if (/^file:/i.test(href)) {
        const p = cleanPath(fileUrlToPath(href));
        if (asPath(p)) {
          // fileUrlToPath 做了解码与反转义，拼回 HTML 属性前必须重新转义，防二次反转义 XSS
          const safeP = escape(p);
          return put(pathAnchor(safeP, resolve(emphasis(label)) || safeP));
        }
        return label;
      }
      if (!SAFE_URL.test(href)) {
        /* [看看](D:\Downloads) 这种写法也常出现：目标是本地位置就做成入口，
           其它协议（javascript:/data:/vbscript:）仍然降级成纯文本 */
        if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(href)) {
          const p = cleanPath(href);
          if (asPath(p)) {
            return put(pathAnchor(p, resolve(emphasis(label)) || p));
          }
        }
        return label;
      }
      return put('<a class="md-link" href="' + href + '" rel="noopener noreferrer" target="_blank">'
        + resolve(emphasis(label)) + '</a>');
    });

    /* 3. 强调：此时文本已全部转义、代码已占位 */
    src = emphasis(src);

    /* 3.5 正文里的裸路径：只在标签之外的文本段里认，
       剥离出的中文后缀/标点原样留作普通正文，不吞字也不污染 data-path。 */
    src = src.replace(RE_TEXT_PATH, (m, tag, path) => {
      if (tag) return tag;
      const sp = splitPathTail(path);
      if (!asPath(sp.path)) return m;
      return pathAnchor(sp.path, sp.path) + sp.tail;
    });

    /* 4. 硬换行：只作用在占位符之外，代码里的换行保持原样 */
    src = breaks ? src.replace(/\n/g, '<br>') : src.replace(/\n/g, ' ');

    return resolve(src);
  }

  function inline(s) {
    return inlineHTML(s, false);
  }

  /* ---------------- 块解析 ---------------- */

  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
  const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const RE_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*?))?[ \t]*$/;
  const RE_ALIGN = /^:?-+:?$/;

  function indentWidth(ws) {
    let n = 0;
    for (let i = 0; i < ws.length; i++) n += ws.charAt(i) === '\t' ? 4 : 1;
    return n;
  }

  function matchItem(line) {
    const m = RE_ITEM.exec(line);
    if (!m) return null;
    const ordered = /\d/.test(m[2]);
    return {
      indent: indentWidth(m[1]),
      ordered,
      start: ordered ? parseInt(m[2], 10) || 1 : 1,
      text: m[3] || ''
    };
  }

  /* 表格行：按 | 切，支持 \| 转义，去掉首尾装饰性竖线 */
  function splitRow(line) {
    let s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.length && s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function sepAlign(line) {
    if (line.indexOf('|') < 0) return null;
    const cells = splitRow(line);
    if (!cells.length) return null;
    const align = [];
    for (const cell of cells) {
      if (!RE_ALIGN.test(cell)) return null;
      const left = cell.charAt(0) === ':';
      const right = cell.charAt(cell.length - 1) === ':';
      align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    }
    return align;
  }

  function fitRow(cells, width) {
    const out = cells.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  }

  /* 在 lines[i] 处试着读一张表；不是表返回 null */
  function tableAt(lines, i) {
    if (i + 1 >= lines.length) return null;
    const headLine = lines[i];
    if (headLine.indexOf('|') < 0) return null;
    const sep = sepAlign(lines[i + 1]);
    if (!sep) return null;
    const head = splitRow(headLine);
    if (!head.length) return null;

    const align = [];
    for (let k = 0; k < head.length; k++) align.push(k < sep.length ? sep[k] : null);

    const rows = [];
    let j = i + 2;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim() || line.indexOf('|') < 0) break;
      if (RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line)) break;
      rows.push(fitRow(splitRow(line), head.length));
      j++;
    }
    return { block: { type: 'table', head, align, rows }, next: j };
  }

  function parseList(lines, i) {
    const first = matchItem(lines[i]);
    const base = first.indent;
    const ordered = first.ordered;
    const items = [];
    let cur = null;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        /* 空行后仍是本列表（缩进不减）就继续，否则结束 */
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? matchItem(lines[j]) : null;
        if (next && next.indent >= base) { i = j; continue; }
        break;
      }

      const m = matchItem(line);
      if (m) {
        if (m.indent >= base + 2) {
          /* 一层嵌套：都挂到当前项下面，再深也不再分层 */
          if (!cur) { cur = { text: m.text, sub: null }; items.push(cur); i++; continue; }
          if (!cur.sub) cur.sub = { ordered: m.ordered, items: [] };
          cur.sub.items.push({ text: m.text });
          i++;
          continue;
        }
        if (m.ordered !== ordered) break; /* 换列表类型 -> 另起一块 */
        cur = { text: m.text, sub: null };
        items.push(cur);
        i++;
        continue;
      }

      /* 缩进的续行并进上一项 */
      if (cur && /^[ \t]+/.test(line)) { cur.text += ' ' + line.trim(); i++; continue; }
      break;
    }

    return {
      block: { type: 'list', ordered, start: ordered ? first.start : 1, items },
      next: i
    };
  }

  function isBlockStart(lines, i) {
    const line = lines[i];
    if (!line.trim()) return true;
    if (RE_FENCE.test(line)) return true;
    if (RE_HEADING.test(line)) return true;
    if (RE_HR.test(line)) return true;
    if (RE_QUOTE.test(line)) return true;
    if (RE_ITEM.test(line)) return true;
    if (tableAt(lines, i)) return true;
    return false;
  }

  function parseBlocks(text) {
    const src = text === null || text === undefined ? '' : String(text);
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      /* 围栏代码块：没闭合就一直吃到结尾（降级成代码，不抛异常） */
      const fence = RE_FENCE.exec(line);
      if (fence) {
        const mark = fence[1].charAt(0);
        const width = fence[1].length;
        const lang = (fence[2] || '').trim().split(/[ \t]+/)[0] || '';
        const code = [];
        i++;
        while (i < lines.length) {
          const close = RE_FENCE_CLOSE.exec(lines[i]);
          if (close && close[1].charAt(0) === mark && close[1].length >= width) { i++; break; }
          code.push(lines[i]);
          i++;
        }
        out.push({ type: 'code', lang, code: code.join('\n') });
        continue;
      }

      const heading = RE_HEADING.exec(line);
      if (heading) {
        out.push({ type: 'heading', level: heading[1].length, text: heading[2] || '' });
        i++;
        continue;
      }

      if (RE_HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }

      const table = tableAt(lines, i);
      if (table) { out.push(table.block); i = table.next; continue; }

      if (RE_QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length) {
          const m = RE_QUOTE.exec(lines[i]);
          if (!m) break;
          inner.push(m[1]);
          i++;
        }
        out.push({ type: 'blockquote', blocks: parseBlocks(inner.join('\n')) });
        continue;
      }

      if (RE_ITEM.test(line)) {
        const list = parseList(lines, i);
        out.push(list.block);
        i = list.next;
        continue;
      }

      /* 段落：读到空行或下一个块起始为止 */
      const buf = [line];
      i++;
      while (i < lines.length && !isBlockStart(lines, i)) { buf.push(lines[i]); i++; }
      out.push({ type: 'paragraph', text: buf.join('\n') });
    }

    return out;
  }

  /* ---------------- 渲染 ---------------- */

  function cellAttr(align) {
    return align ? ' style="text-align:' + align + '"' : '';
  }

  function renderList(block, nested) {
    const tag = block.ordered ? 'ol' : 'ul';
    const cls = nested ? ' class="md-list md-list-sub"' : ' class="md-list"';
    const start = block.ordered && block.start !== 1 ? ' start="' + block.start + '"' : '';
    const body = block.items.map((item) => {
      let html = '<li>' + inlineHTML(item.text, false);
      if (item.sub && item.sub.items.length) {
        html += renderList({ ordered: item.sub.ordered, start: 1, items: item.sub.items }, true);
      }
      return html + '</li>';
    }).join('\n');
    return '<' + tag + cls + start + '>\n' + body + '\n</' + tag + '>';
  }

  function renderTable(block) {
    const head = block.head.map((cell, k) =>
      '<th' + cellAttr(block.align[k]) + '>' + inlineHTML(cell, false) + '</th>').join('');
    const rows = block.rows.map((row) =>
      '<tr>' + row.map((cell, k) =>
        '<td' + cellAttr(block.align[k]) + '>' + inlineHTML(cell, false) + '</td>').join('') + '</tr>').join('\n');
    return '<table class="md-table">\n<thead>\n<tr>' + head + '</tr>\n</thead>\n<tbody>'
      + (rows ? '\n' + rows + '\n' : '') + '</tbody>\n</table>';
  }

  function renderBlock(block, opts) {
    switch (block.type) {
      case 'heading':
        return '<h' + block.level + '>' + inlineHTML(block.text, false) + '</h' + block.level + '>';
      case 'paragraph':
        return '<p>' + inlineHTML(block.text, opts.breaks) + '</p>';
      case 'code': {
        const lang = String(block.lang || '').toLowerCase().replace(/[^\w+#.-]/g, '');
        return '<pre class="md-pre"><code class="md-code' + (lang ? ' lang-' + lang : '') + '">'
          + escape(block.code) + '</code></pre>';
      }
      case 'list':
        return renderList(block, false);
      case 'table':
        return renderTable(block);
      case 'blockquote': {
        const inner = block.blocks.map((b) => renderBlock(b, opts)).join('\n');
        return '<blockquote class="md-quote">' + (inner ? '\n' + inner + '\n' : '') + '</blockquote>';
      }
      case 'hr':
        return '<hr class="md-hr">';
      default:
        return '';
    }
  }

  function render(text, opts) {
    if (text === null || text === undefined) return '';
    const options = opts || {};
    const src = String(text);
    if (!src.trim()) return '';
    const list = parseBlocks(src);
    const breaks = options.breaks !== false; /* 默认 true */
    return list.map((block) => renderBlock(block, { breaks })).join('\n');
  }

  /* ---------------- 是否真含 Markdown ---------------- */

  const MARK_RE = {
    fence: /(^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/,
    heading: /(^|\n)[ \t]{0,3}#{1,6}[ \t]+\S/,
    quote: /(^|\n)[ \t]{0,3}>[ \t]?\S/,
    hr: /(^|\n)[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*(?=\n|$)/,
    ul: /(^|\n)[ \t]{0,3}[-*+][ \t]+\S/,
    ol: /(^|\n)[ \t]{0,3}\d{1,9}[.)][ \t]+\S/,
    bold: /\*\*[^\s*](?:[^*]*?[^\s*])?\*\*/,
    del: /~~[^\s~](?:[^~]*?[^\s~])?~~/,
    code: /`[^`\n]+`/,
    link: /\[[^\[\]\n]+\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*\)/,
    emStar: /(^|[^\w*])\*(?![\s*])[^*\n]+?\*(?![\w*])/,
    emUnderscore: /(^|[^\w_])_(?![\s_])[^_\n]+?_(?![\w_])/,
    /* 本地路径：只有它也要走渲染，否则「打开 D:\x 看看」整段还是死文字 */
    path: /(^|[\s(（"'「【>])(?:[A-Za-z]:[\\/]|\\\\[^\s\\])/
  };

  function hasMarkup(text) {
    const src = text === null || text === undefined ? '' : String(text);
    if (!src.trim()) return false;

    /* 块级：用真正的解析器兜底，避免「只有表头没有分隔行」被误判 */
    if (MARK_RE.fence.test(src)) return true;
    if (MARK_RE.heading.test(src)) return true;
    if (MARK_RE.quote.test(src)) return true;
    if (MARK_RE.hr.test(src)) return true;
    if (MARK_RE.ul.test(src)) return true;
    if (MARK_RE.ol.test(src)) return true;
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
      if (tableAt(lines, i)) return true;
    }

    /* 行内 */
    if (MARK_RE.code.test(src)) return true;
    if (MARK_RE.bold.test(src)) return true;
    if (MARK_RE.del.test(src)) return true;
    if (MARK_RE.link.test(src)) return true;
    if (MARK_RE.emStar.test(src)) return true;
    if (MARK_RE.emUnderscore.test(src)) return true;
    if (MARK_RE.path.test(src)) return true;
    return false;
  }

  const AIMd = {
    render,
    escape,
    inline,
    blocks: parseBlocks,
    hasMarkup,
    splitPathTail,
    cleanPath
  };

  root.AIMd = AIMd;
  if (typeof module !== 'undefined' && module.exports) module.exports = AIMd;
})(typeof window !== 'undefined' ? window : globalThis);
