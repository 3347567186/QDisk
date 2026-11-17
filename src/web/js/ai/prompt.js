/* AI 助手 · 提示词与工具契约
   ------------------------------------------------------------
   两条硬规矩（对应方案 §6「稳定前缀字节不变」）：
   1. system 文本只依赖「启用了哪些工具」，同一页面内一个字节都不变；
   2. 变化的东西（当前目录、选中文件、时间）放在最后一条 user 消息里。
   改这里的措辞会让每次会话的第一段 prompt 缓存失效，非必要不动。 */
(function (root) {
  'use strict';

  /* 工具契约：描述限制在一行，参数带类型与上限，供提示词与校验共用 */
  const TOOLS = {
    list_dir: {
      desc: '列出一个目录里的条目（目录在前），给出名字/类型/大小/修改时间',
      params: { dir: 'string', limit: 'number≤200' },
      args: ['dir']
    },
    top_files: {
      desc: '列出目录下最大的文件（含扩展名与所在子目录）',
      params: { dir: 'string', limit: 'number≤50' },
      args: ['dir']
    },
    empty_dirs: {
      desc: '找出可以删除的空文件夹，标出哪些是受保护的重要目录',
      params: { dir: 'string', depth: 'number 1-3' },
      args: ['dir']
    },
    file_signals: {
      desc: '读文件的版本信息与数字签名：公司、产品名、签名状态、签名者',
      params: { paths: 'string[]≤20' },
      args: ['paths']
    },
    installed_apps: {
      desc: '列出已安装程序（名称 + 安装路径），用 filter 按名称过滤',
      params: { filter: 'string' },
      args: []
    },
    search_files: {
      desc: '按文件名在全盘索引里搜索（需要用户已建索引）',
      params: { q: 'string', limit: 'number≤20' },
      args: ['q']
    },
    organize_preview: {
      desc: '预演整理：给出会分到哪个类别目录、哪些文件被跳过及原因（不写盘）',
      params: { paths: 'string[]≤50', recursive: 'boolean' },
      args: ['paths']
    },
    last_organize: {
      desc: '读最近一次整理的记录：时间、目录、移动了多少个文件',
      params: {},
      args: []
    }
  };

  const RULES = [
    '你是「整理助手」内置的文件整理顾问，只回答与文件、磁盘空间、目录结构、已安装程序有关的问题。',
    '与这些无关的请求（写代码、闲聊、翻译、代写文案）一律拒绝，只用一句「我只管文件和空间这一块」，并给一个你能做的事作为引导。',
    '你没有任何写操作能力：不能删除、移动、重命名、清理、解压、卸载。不要声称你已经做了这些事，也不要给用户一段命令让他自己执行。',
    '你看不到文件内容。禁止说「这个文件里写着…」这类话；只能根据名字、大小、类型、时间、签名、所属软件来判断。',
    '所有数字必须来自工具返回：不要自己换算、不要估算、不要四舍五入成「大约」。没查到的就说没查到，并说明要用哪个工具查。',
    '需要信息时先调工具，不要凭常识猜。一次只调用一个工具。'
  ].join('\n');

  const FORMAT = [
    '【输出格式】每次只输出一个 JSON 对象，不要代码块、不要解释文字。二选一：',
    '需要查东西：{"thought":"一句话说明为什么查","tool":"工具名","args":{...}}',
    '能回答了：{"answer":"回答正文","evidence":[{"tool":"工具名"}],"suggest":[{"action":"delete|archive|check|none","paths":["完整路径"],"why":"理由"}]}',
    '回答要求：中文，不超过 300 字，结论先行，能用列表就用列表（每行以「· 」开头）。',
    'evidence 只能引用这一轮真正调用过的工具；suggest 只放你确实建议用户去处理的具体路径，没有就给空数组。'
  ].join('\n');

  /* 按页面裁剪工具（对应方案 §4：工具越多选得越差） */
  const PAGE_TOOLS = {
    ai: ['list_dir', 'top_files', 'empty_dirs', 'file_signals', 'installed_apps', 'search_files', 'organize_preview', 'last_organize'],
    tools: ['top_files', 'empty_dirs', 'file_signals', 'installed_apps'],
    organize: ['list_dir', 'organize_preview', 'last_organize', 'installed_apps'],
    search: ['search_files', 'list_dir', 'installed_apps'],
    apps: ['installed_apps', 'list_dir'],
    archive: ['list_dir', 'top_files']
  };

  function toolText(names) {
    return names.map((n) => {
      const t = TOOLS[n];
      if (!t) return '';
      const ps = Object.keys(t.params);
      const argText = ps.length
        ? ps.map((p) => `${p}: ${t.params[p]}`).join(', ')
        : '无参数';
      return `- ${n}（${argText}）：${t.desc}`;
    }).filter(Boolean).join('\n');
  }

  /* 稳定前缀：同一组工具拼出的字符串必须完全一致 */
  function systemPrompt(toolNames) {
    return [
      '你是整理助手的内置 AI 助手。',
      '',
      '【边界】',
      RULES,
      '',
      '【可用工具】只允许调用下面这些，工具名必须逐字一致：',
      toolText(toolNames),
      '',
      FORMAT
    ].join('\n');
  }

  /* 变化段：一行紧凑格式，不放原始 JSON */
  function contextLine(ctx) {
    if (!ctx) return '';
    const bits = [];
    if (ctx.page) bits.push('页面=' + ctx.page);
    if (ctx.dir) bits.push('当前目录=' + ctx.dir);
    if (ctx.count) bits.push('选中=' + ctx.count + ' 项');
    if (ctx.size) bits.push('合计=' + ctx.size);
    if (ctx.files && ctx.files.length) {
      const names = ctx.files.slice(0, 8).join('、');
      bits.push('文件=' + names + (ctx.files.length > 8 ? ' 等' : ''));
    }
    if (ctx.note) bits.push(ctx.note);
    if (ctx.permission) bits.push('权限=' + ctx.permission);
    if (ctx.thinking) bits.push('强度=' + ctx.thinking);
    return bits.length ? '【上下文】' + bits.join(' · ') : '';
  }

  const API = { TOOLS, PAGE_TOOLS, systemPrompt, contextLine, toolText };
  root.AIPrompt = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
