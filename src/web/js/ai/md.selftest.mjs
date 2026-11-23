/* AI 助手 · Markdown 渲染自测
   ------------------------------------------------------------
   跑法：node src/web/js/ai/md.selftest.mjs
   纯离线：require('./md.js') 后逐条断言字符串结果，不连网络、不碰磁盘。
   覆盖：标题、段落与 br、列表、代码块、行内代码、强调、链接白名单、
        表格与对齐、引用、分隔线、畸形输入、XSS、hasMarkup、空串、超长行。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AIMd = require('./md.js');

const results = [];
let seq = 0;

function test(name, fn) {
  seq += 1;
  const id = 'M' + String(seq).padStart(2, '0');
  const bad = [];
  const fail = (msg) => { bad.push(msg); };
  try {
    fn(fail);
  } catch (e) {
    fail('抛异常：' + ((e && e.message) || e));
  }
  results.push({ id, name, pass: bad.length === 0, why: bad.join('；') });
}

function has(hay, needle, fail, what) {
  if (String(hay).indexOf(needle) < 0) fail((what || '输出') + '缺少 ' + JSON.stringify(needle));
}
function lacks(hay, needle, fail, what) {
  if (String(hay).indexOf(needle) >= 0) fail((what || '输出') + '不应包含 ' + JSON.stringify(needle));
}
function eq(got, want, fail, what) {
  if (got !== want) fail((what ? what + '：' : '') + '期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
}
function count(hay, needle) {
  return String(hay).split(needle).length - 1;
}

/* ---------------- 块级 ---------------- */

test('标题层级 1-6', (fail) => {
  const html = AIMd.render('# 一级\n\n### 三级\n\n###### 六级');
  has(html, '<h1>一级</h1>', fail);
  has(html, '<h3>三级</h3>', fail);
  has(html, '<h6>六级</h6>', fail);
  const seven = AIMd.render('####### 七个井号');
  lacks(seven, '<h7>', fail);
  has(seven, '<p>####### 七个井号</p>', fail);
});

test('段落与硬换行 br', (fail) => {
  const html = AIMd.render('第一行\n第二行');
  has(html, '<p>第一行<br>第二行</p>', fail);
  const flat = AIMd.render('第一行\n第二行', { breaks: false });
  has(flat, '<p>第一行 第二行</p>', fail, 'breaks:false');
  lacks(flat, '<br>', fail, 'breaks:false');
});

test('空输入', (fail) => {
  eq(AIMd.render(''), '', fail, 'render("")');
  eq(AIMd.render(null), '', fail, 'render(null)');
  eq(AIMd.render(undefined), '', fail, 'render(undefined)');
  eq(AIMd.render('  \n\n  '), '', fail, 'render(空白)');
  eq(AIMd.inline(null), '', fail, 'inline(null)');
});

test('无序列表三种标记', (fail) => {
  const html = AIMd.render('- 甲\n* 乙\n+ 丙');
  has(html, '<ul class="md-list">', fail);
  eq(count(html, '<li>'), 3, fail, '列表项数');
  has(html, '<li>丙</li>', fail);
});

test('有序列表与起始编号', (fail) => {
  const html = AIMd.render('1. 一\n2. 二');
  has(html, '<ol class="md-list">', fail);
  eq(count(html, '<li>'), 2, fail, '有序项数');
  const from3 = AIMd.render('3. 三\n4. 四');
  has(from3, '<ol class="md-list" start="3">', fail, '起始编号');
});

test('一层嵌套列表', (fail) => {
  const html = AIMd.render('- 甲\n  - 甲一\n  - 甲二\n- 乙');
  has(html, '<li>甲<ul class="md-list md-list-sub">', fail, '嵌套入口');
  has(html, '<li>甲一</li>', fail);
  eq(count(html, '<li>'), 4, fail, '全部 li 数');
  has(html, '</ul></li>', fail, '嵌套闭合');
});

test('代码块语言名进 class', (fail) => {
  const js = AIMd.render('```js\nconst a = 1;\n```');
  has(js, '<pre class="md-pre"><code class="md-code lang-js">const a = 1;</code></pre>', fail);
  const none = AIMd.render('```\n纯文本\n```');
  has(none, '<code class="md-code">纯文本</code>', fail, '无语言名');
  lacks(none, 'lang-', fail, '无语言名');
});

test('代码块内不解析且转义', (fail) => {
  const html = AIMd.render('```html\n**粗** <img src=x onerror=alert(1)>\n```');
  has(html, '**粗**', fail, '原文保留');
  lacks(html, '<strong>', fail, '代码块内不解析粗体');
  has(html, '&lt;img src=x onerror=alert(1)&gt;', fail, '标签被转义');
  lacks(html, '<img', fail, '代码块内没有真标签');
});

test('行内代码不解析内部语法', (fail) => {
  const html = AIMd.render('用 `**x**` 与 `<script>` 测试');
  has(html, '<code>**x**</code>', fail);
  lacks(html, '<strong>', fail, '行内代码里不解析粗体');
  has(html, '<code>&lt;script&gt;</code>', fail, '行内代码内容被转义');
  lacks(html, '<script', fail, '行内代码里没有真标签');
});

test('粗体 / 斜体 / 删除线', (fail) => {
  const html = AIMd.render('**粗体** *斜体* _下划线_ ~~删除~~');
  has(html, '<strong>粗体</strong>', fail);
  has(html, '<em>斜体</em>', fail);
  has(html, '<em>下划线</em>', fail);
  has(html, '<del>删除</del>', fail);
});

test('链接只放行 http/https/mailto', (fail) => {
  const html = AIMd.render('[官网](https://example.com/a?b=1&c=2) [邮件](mailto:a@b.co) [明文](http://x.y)');
  has(html, '<a class="md-link" href="https://example.com/a?b=1&amp;c=2"', fail, 'https + & 转义');
  has(html, 'href="mailto:a@b.co"', fail, 'mailto');
  has(html, 'href="http://x.y"', fail, 'http');
  has(html, '>官网</a>', fail, '链接文本');
  eq(count(html, '<a '), 3, fail, '链接数量');
});

test('危险协议降级为纯文本', (fail) => {
  const html = AIMd.render('[x](javascript:alert(1)) [y](data:text/html;base64,PHNjcmlwdD4=)');
  lacks(html, '<a ', fail);
  eq(html, '<p>x y</p>', fail, '降级结果只剩文字');
  if (html.toLowerCase().indexOf('javascript:') >= 0) fail('输出里不该出现 javascript: 协议');
  if (html.toLowerCase().indexOf('data:') >= 0) fail('输出里不该出现 data: 协议');
  const upper = AIMd.render('[u](JaVaScRiPt:alert(1))');
  lacks(upper, '<a ', fail, '大小写混写');
});

test('本地路径：file:// 与盘符链接可点（1.35）', (fail) => {
  const html = AIMd.render('[看这里](file:///D:/Downloads)');
  has(html, 'class="md-path"', fail, 'file:// 变成路径入口');
  has(html, 'data-path="D:\\Downloads"', fail, '反解码成 Windows 路径');
  if (html.toLowerCase().indexOf('file:') >= 0) fail('输出里不该出现 file: 协议');
  const drive = AIMd.render('[z](C:\\Windows)');
  has(drive, 'data-path="C:\\Windows"', fail, '盘符链接');
});

test('本地路径：正文里的裸路径可点（1.35）', (fail) => {
  const one = AIMd.render('去 D:\\Downloads 看看大文件');
  has(one, '<a class="md-path" href="#" data-path="D:\\Downloads"', fail, '裸路径');
  has(one, 'data-path="D:\\Downloads"', fail);
  const code = AIMd.render('在 `D:\\Tools\\TidyAssistant` 下面');
  has(code, '<code>', fail, '代码保留为 code');
  has(code, 'data-path="D:\\Tools\\TidyAssistant"', fail, '行内代码路径');
  const unc = AIMd.render('共享在 \\\\nas\\media 里');
  has(unc, 'data-path="\\\\nas\\media"', fail, 'UNC 路径');
  /* 不能把网址里的 s:/ 当盘符 */
  const url = AIMd.render('见 https://example.com/a 和 ftp://x/y');
  lacks(url, 'md-path', fail, '网址不产生路径入口');
  /* 带空格的目录名要整段留下 */
  const spaced = AIMd.render('C:\\Program Files (x86)\\Steam');
  has(spaced, 'data-path="C:\\Program Files (x86)\\Steam"', fail, '带空格与括号');
});

test('hasMarkup：只含路径也算有语法（1.35）', (fail) => {
  eq(AIMd.hasMarkup('C:\\Users\\a\\b'), true, fail, '路径要触发渲染');
  eq(AIMd.hasMarkup('今天天气不错'), false, fail, '纯文字不触发');
});

/* ---------------- 表格 ---------------- */

test('表格结构：表头 / 单元格 / 行数', (fail) => {
  const html = AIMd.render('| 名称 | 大小 |\n| --- | --- |\n| a.iso | 3 GB |\n| b.txt | 1 KB |');
  has(html, '<table class="md-table">', fail);
  has(html, '<thead>', fail);
  has(html, '<th>名称</th>', fail);
  has(html, '<th>大小</th>', fail);
  has(html, '<td>a.iso</td>', fail);
  has(html, '<td>1 KB</td>', fail);
  eq(count(html, '<tr>'), 3, fail, '行数（表头 + 2 行）');
  eq(count(html, '<td>'), 4, fail, '单元格数');
});

test('表格对齐标记', (fail) => {
  const html = AIMd.render('| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |');
  has(html, '<th style="text-align:left">L</th>', fail, '左对齐表头');
  has(html, '<th style="text-align:center">C</th>', fail, '居中表头');
  has(html, '<th style="text-align:right">R</th>', fail, '右对齐表头');
  has(html, '<td style="text-align:right">3</td>', fail, '单元格继承对齐');
});

test('只有表头没有分隔行 -> 普通段落', (fail) => {
  const html = AIMd.render('| a | b |\n| c | d |');
  lacks(html, '<table', fail);
  lacks(html, '<th>', fail);
  has(html, '<p>| a | b |<br>| c | d |</p>', fail);
});

/* ---------------- 引用 / 分隔线 ---------------- */

test('引用可多行', (fail) => {
  const html = AIMd.render('> 第一行\n> 第二行');
  has(html, '<blockquote class="md-quote">', fail);
  has(html, '<p>第一行<br>第二行</p>', fail, '引用内段落');
  eq(count(html, '<blockquote'), 1, fail);
});

test('分隔线 --- 与 ***', (fail) => {
  eq(AIMd.render('---'), '<hr class="md-hr">', fail, '---');
  eq(AIMd.render('***'), '<hr class="md-hr">', fail, '***');
  const mid = AIMd.render('上\n\n---\n\n下');
  has(mid, '<hr class="md-hr">', fail);
  has(mid, '<p>上</p>', fail);
  has(mid, '<p>下</p>', fail);
});

/* ---------------- 畸形输入 ---------------- */

test('畸形 / 未闭合输入不抛异常', (fail) => {
  const inputs = [
    '`',
    '**奇数',
    '```js\n没闭合',
    '[x](',
    '>',
    '| a | b |',
    '| | |\n|---|',
    '#',
    '- ',
    '1. ',
    'a ** b ` c',
    '~~~~~~'
  ];
  for (const src of inputs) {
    let html;
    try {
      html = AIMd.render(src);
    } catch (e) {
      fail('render 抛异常：' + JSON.stringify(src) + ' -> ' + e.message);
      continue;
    }
    if (typeof html !== 'string') fail('render 没有返回字符串：' + JSON.stringify(src));
    try {
      AIMd.blocks(src);
    } catch (e) {
      fail('blocks 抛异常：' + JSON.stringify(src) + ' -> ' + e.message);
    }
  }
});

/* ---------------- XSS ---------------- */

test('XSS：原始标签被转义', (fail) => {
  const html = AIMd.render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n## <svg onload=alert(1)>');
  lacks(html, '<img', fail);
  lacks(html, '<script', fail);
  lacks(html, '<svg', fail);
  has(html, '&lt;img src=x onerror=alert(1)&gt;', fail);
  has(html, '&lt;script&gt;alert(1)&lt;/script&gt;', fail);
});

test('XSS：javascript: 链接不可执行', (fail) => {
  const html = AIMd.render('[点我](javascript:alert(1))');
  lacks(html, '<a ', fail);
  if (html.toLowerCase().indexOf('javascript') >= 0) fail('输出里仍出现 javascript');
  has(html, '点我', fail, '链接文字保留');
});

test('XSS：行内代码里的 script', (fail) => {
  const html = AIMd.render('`<script>alert(1)</script>`');
  has(html, '&lt;script&gt;alert(1)&lt;/script&gt;', fail);
  lacks(html, '<script', fail);
  has(html, '<code>', fail);
});

/* ---------------- hasMarkup ---------------- */

test('hasMarkup 正例', (fail) => {
  const yes = [
    '## 标题',
    '# 标题',
    '- 列表',
    '1. 有序',
    '**粗**',
    '`代码`',
    '~~删~~',
    '[x](https://a.b)',
    '> 引用',
    '---',
    '| a | b |\n| --- | --- |',
    '*斜体*'
  ];
  for (const s of yes) {
    if (!AIMd.hasMarkup(s)) fail('应判为含语法：' + JSON.stringify(s));
  }
});

test('hasMarkup 反例', (fail) => {
  const no = [
    '普通一句话。',
    '价格 3 * 4 = 12',
    '2*3*4',
    'a_b_c',
    'snake_case_name',
    'file.txt',
    '这是逗号，不是语法',
    '100% 完成',
    'a | b',
    '1.5 倍',
    'e=mc^2',
    '2026-11-18'
  ];
  for (const s of no) {
    if (AIMd.hasMarkup(s)) fail('不该判为含语法：' + JSON.stringify(s));
  }
});

test('hasMarkup 空白输入', (fail) => {
  eq(AIMd.hasMarkup(''), false, fail, '空串');
  eq(AIMd.hasMarkup('   '), false, fail, '空格');
  eq(AIMd.hasMarkup('\n\n'), false, fail, '换行');
  eq(AIMd.hasMarkup(null), false, fail, 'null');
});

/* ---------------- 性能 / 结构 ---------------- */

test('超长单行（>5000 字符）不卡死', (fail) => {
  const line = '长文本段落，包含 **粗体** 与 `代码`，还有 [链接](https://example.com)。'.repeat(150);
  if (line.length <= 5000) fail('用例构造有误：长度 ' + line.length);
  const t0 = Date.now();
  const html = AIMd.render(line);
  const ms = Date.now() - t0;
  if (typeof html !== 'string' || html.length < 5000) fail('超长行没有正常产出');
  if (ms > 2000) fail('超长行耗时 ' + ms + 'ms，疑似卡死');
  has(html, '<strong>', fail, '超长行里的粗体');
  has(html, '<code>', fail, '超长行里的行内代码');
  has(html, '<a class="md-link"', fail, '超长行里的链接');
});

test('escape 五个特殊字符', (fail) => {
  eq(AIMd.escape("&<>\"'"), '&amp;&lt;&gt;&quot;&#39;', fail, '五个特殊字符');
  eq(AIMd.escape('a & b'), 'a &amp; b', fail);
  eq(AIMd.escape(null), '', fail, 'null');
  eq(AIMd.escape(0), '0', fail, '数字');
});

test('blocks() 结构可读', (fail) => {
  const bs = AIMd.blocks('# 标题\n\n段落\n\n- a\n- b\n\n```js\nx\n```\n\n| a |\n| --- |\n| 1 |\n\n> q\n\n---');
  eq(bs.map((b) => b.type).join(','), 'heading,paragraph,list,code,table,blockquote,hr', fail, '块序列');
  if (bs.length !== 7) return;
  eq(bs[0].level, 1, fail, '标题层级');
  eq(bs[0].text, '标题', fail, '标题文本');
  eq(bs[2].items.length, 2, fail, '列表项数');
  eq(bs[3].lang, 'js', fail, '代码语言');
  eq(bs[4].head[0], 'a', fail, '表头');
  eq(bs[4].rows[0][0], '1', fail, '表格数据');
  eq(bs[5].blocks[0].type, 'paragraph', fail, '引用内块');
});

test('重复调用结果一致', (fail) => {
  const md = '# T\n\n- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n`c` **b**';
  const a = AIMd.render(md);
  const b = AIMd.render(md);
  eq(a, b, fail, '两次渲染');
  has(a, '<strong>b</strong>', fail);
});

test('数学式里的 * 不当强调', (fail) => {
  const html = AIMd.render('2 * 3 * 4 = 24，另一个 2*3*4 = 24');
  lacks(html, '<em>', fail);
  has(html, '2 * 3 * 4 = 24', fail);
});

test('代码块语言名不能注入', (fail) => {
  const html = AIMd.render('```"><script>alert(1)</script>\nx\n```');
  lacks(html, '<script', fail);
  lacks(html, 'lang-"><', fail);
  has(html, 'class="md-code lang-', fail);
  has(html, '<code', fail);
});

test('file:// 链接二次反转义不能注入属性或原始引号', (fail) => {
  const html = AIMd.render('[看](file:///D:/a%27onmouseover=alert(1)) 与 [](file:///D:/dir%26x)');
  lacks(html, "'onmouseover=", fail, 'file:// 单引号必须重新转义');
  has(html, '&#39;onmouseover=', fail, 'file:// 单引号应转为实体');
  has(html, 'dir&amp;x', fail, 'file:// & 应重新转义');
});

test('本地路径粘连汉字/全角标点时精准切分且不丢正文（1.43.16）', (fail) => {
  const c1 = AIMd.render('清理D:\\Downloads里的文件和C:\\Windows\\Temp目录');
  has(c1, 'data-path="D:\\Downloads"', fail, 'ASCII目录+里的文件');
  has(c1, '>D:\\Downloads</a>里的文件和', fail, '中文正文保留在链接外');
  has(c1, 'data-path="C:\\Windows\\Temp"', fail, '双路径紧邻中文连词时第二条也生效');
  has(c1, '>C:\\Windows\\Temp</a>目录', fail, '目录二字保留在链接外');

  const c2 = AIMd.render('大文件 D:\\a\\setup.exe是否可删，以及 D:\\data\\backup.zip（约 2 GB）');
  has(c2, 'data-path="D:\\a\\setup.exe"', fail, '扩展名后粘连汉字');
  has(c2, '>D:\\a\\setup.exe</a>是否可删', fail, '扩展名后的提问正文保留');
  has(c2, 'data-path="D:\\data\\backup.zip"', fail, '全角开括号截断');
  has(c2, '>D:\\data\\backup.zip</a>（约 2 GB）', fail, '全角括号注释保留');

  const c3 = AIMd.render('查看 D:\\工作资料目录下 的文件，以及 D:\\下载\\2026年报告.pdf里的内容');
  has(c3, 'data-path="D:\\工作资料"', fail, '中文目录后粘连目录下');
  has(c3, '>D:\\工作资料</a>目录下', fail, '目录下保留在链接外');
  has(c3, 'data-path="D:\\下载\\2026年报告.pdf"', fail, '中文文件名+扩展名后粘连汉字');
  has(c3, '>D:\\下载\\2026年报告.pdf</a>里的内容', fail, '中文文件名后正文保留');

  const c4 = AIMd.render('[打开](file:///D:/Downloads目录) 和 [看看](D:\\AppData下) 和 `D:\\Temp里的日志`');
  has(c4, 'data-path="D:\\Downloads"', fail, 'file:// 链接剥离粘连汉字');
  has(c4, 'data-path="D:\\AppData"', fail, 'Markdown 本地链接剥离粘连汉字');
  has(c4, 'data-path="D:\\Temp"', fail, '行内代码路径剥离粘连汉字');
  has(c4, '</code></a>里的日志', fail, '行内代码剥离出的后缀保留');

  const c5 = AIMd.render('保留真实中文与混排：D:\\下载、D:\\新建文件夹、D:\\Docs\\PDF报告、D:\\Docs\\PDF中文版、D:\\项目\\v1.2财务报表.xlsx、D:\\Games\\和平精英');
  has(c5, 'data-path="D:\\下载"', fail, '纯中文目录保留');
  has(c5, 'data-path="D:\\新建文件夹"', fail, '新建文件夹保留');
  has(c5, 'data-path="D:\\Docs\\PDF报告"', fail, 'PDF报告保留');
  has(c5, 'data-path="D:\\Docs\\PDF中文版"', fail, 'PDF中文版不被中字误切');
  has(c5, 'data-path="D:\\项目\\v1.2财务报表.xlsx"', fail, '带版本号点的中文文件名保留');
  has(c5, 'data-path="D:\\Games\\和平精英"', fail, '含和字的中文目录名保留');

  const c6 = AIMd.render('检查 D:\\里的文件 和 D:\\Downloads\\目录下 的日志');
  has(c6, 'data-path="D:\\"', fail, '盘符根目录后粘连中文');
  has(c6, '>D:\\</a>里的文件', fail, '盘符根目录后正文保留');
  has(c6, 'data-path="D:\\Downloads"', fail, '尾斜杠后粘连目录下');
});

/* ---------------- 汇总 ---------------- */

const pass = results.filter((r) => r.pass).length;
const lines = [];
lines.push('');
lines.push('Markdown 渲染模块 · 自测');
lines.push('─'.repeat(72));
for (const r of results) {
  lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}${r.why ? '\n        ↳ ' + r.why : ''}`);
}
lines.push('─'.repeat(72));
lines.push(`用例通过        ${pass}/${results.length}`);
lines.push(`XSS 用例        3 条（标签 / 协议 / 行内代码）`);
console.log(lines.join('\n'));

if (pass !== results.length) {
  console.log('\n结果：不达标');
  process.exit(1);
}
console.log('\n结果：全部通过');
