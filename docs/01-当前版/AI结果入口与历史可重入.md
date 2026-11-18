# AI 结果入口与历史可重入（1.35.0）

这篇只讲一件事：**AI 说了「你去某处看看」，这句话必须点得动；关掉再回来，还得点得动。**

---

## 1. 用户报的是什么

原话：

> ai给出的结果和执行操作解决方法打开目录查看ai给的内容我点击跳转过去后其实什么用都没有，
> 相当于白给方法了根本没办法执行，并且历史记录也无法再次找到入口进入。

拆成三条可复现的缺陷：

| # | 现象 | 复现 |
|---|---|---|
| A | 回答里写着 `D:\Downloads`，鼠标放上去是普通文字，点不动 | 任何一次带路径的回答 |
| B | 建议卡片点「去清理」，页面切到工具页，路径没带过去，等于原地打转 | 有 `suggest` 卡片时 |
| C | 关掉应用再打开，历史会话只剩一段纯文本，当时的查证过程、位置入口全没了 | 左栏任一历史会话 |

A、B 是「给了方法却执行不了」，C 是「执行过的事再也找不回来」。三者同源。

---

## 2. 根因（四层，缺一层都复现不了）

1. **Markdown 白名单**：`md.js` 只把 `http/https/mailto` 渲染成链接，盘符路径、UNC、`file://`
   一律降级成纯文本。所以模型写得再准，用户也点不到。
2. **建议卡片只换页**：`suggestCards()` 的主按钮是 `location.hash = '#' + page`，
   切页但不带路径；路由又只有 `#page` 一个参数位，没有「带着路径跳页」的通道。
3. **会话落盘只留文字**：`AIStore.saveSession()` 只写 `{role, content}`，
   一轮回答的 `trace`（查证过程）、`evidence`（依据）、`suggest`（建议）、可点入口全部丢弃。
4. **没有执行记录**：提案与撤销只在内存活 10 分钟（`proposals.js` 的 TTL），
   过了就只剩 `journal.jsonl` 里的一行，前端没有任何入口能把「我当时清掉了什么」翻出来。

另外两个顺带发现的真缺陷：

- `open_path` 不校验存在性，路径不在也返回 `Ok` —— 用户看到的是「什么都没发生」。
- `document.title` 里残留两处调试代码（`DBG …`、`CLICKED`），点一次提案卡窗口标题就被改掉。

---

## 3. 设计原则

1. **一个动作只有一个实现**。打开位置全部走新模块 `js/ai/entries.js`，
   正文里的路径、结果位置带、建议卡片、依据行的定位按钮、执行记录里的路径，
   点下去都是同一个 `AIEntries.open()`。不做第二套，避免「这里能开、那里不能」。
2. **入口跟着结果走，不跟着模型的话走**。位置从 `trace`（工具真碰过什么）里收，
   不从回答正文里猜；正文里的路径只作为渲染层补充。模型没查过的地方，不给入口。
3. **历史要能重放「凭什么」**。会话落盘保留查证过程、依据、建议、入口、用量，
   回放时是只读的：能看、能点开位置，但不会再执行。
4. **失败要说清原因**。打不开就 toast 出「这个位置已经不在了：…」，
   不静默；可执行文件只定位不运行。

---

## 4. 实现

### 4.1 新模块 `src/web/js/ai/entries.js`

`window.AIEntries`，约 380 行，纯渲染 + 打开，不碰 AI 逻辑。

| 函数 | 作用 |
|---|---|
| `ready()` | 缓存 `agentRoots().home`、`appInfo().data_dir/exe_dir`，供 `%USERPROFILE%` 之类展开 |
| `expand(p)` | 去掉包裹引号，展开 `%USERPROFILE% / %LOCALAPPDATA% / %APPDATA% / %TEMP% / %TMP%` |
| `isAbs/isPathLike/entry/leafOf/parentOf/kindOf` | 路径判定与拆解（目录/文件按来源 hint 优先，猜只是兜底） |
| `open(p)` | 目录→资源管理器，文件→默认程序；`EXEC_EXT` 一律只定位不运行；失败 toast 真实原因 |
| `reveal(p)` / `copy(p)` / `menu(evt,p)` | 定位、复制路径、右键菜单（打开 / 在资源管理器中显示 / 复制路径 / 让助手看看这里） |
| `chip(p,opts)` / `bar(list,opts)` | 单个位置胶囊 / 「结果位置」整条带（超过 6 个折叠成「还有 N 个位置」） |
| `collect(trace, suggest)` | 从这一轮的工具轨迹里收绝对路径：suggest 优先 → 目录 → 文件，去重上限 16 |
| `fromText(text)` | 老会话只有纯文本时，从正文里认路径 |
| `bind(scope)` | 事件委托：`.md-path` → 打开；`a.md-link` 外链 → 系统浏览器 |

**为什么外链也走 `openPath`**：WebView2 里 `target="_blank"` 没有窗口处理器，
点外链同样「什么用都没有」。这是同一类缺陷的另一种长相。

### 4.2 `md.js`：路径变成可点

- 行内代码整段是路径、`file://` 链接、`[文字](C:\Windows)` 形式的链接 → `<a class="md-path" data-path="…">`。
- 正文里的裸路径（`[A-Za-z]:\` 或 `\\server\share`）也在标签外文本段里认，避免把
  `https://` 里的 `s:/` 误判成盘符。
- `trimPath()` 去尾部标点，右括号按配对计数才去 —— `C:\Program Files (x86)` 不会被削掉。
- 危险协议（`javascript:` / `data:`）仍然降级成纯文本。
- `hasMarkup()` 增加路径判定，否则「只含路径的回答」会走 `textContent` 分支，绕过渲染。

### 4.3 `chatui.js`

- `finishAnswer`：算出 `entries` 并挂「结果位置」带；历史回放不再渲染「重试」
  （回放时 `lastAsk` 是空的，那个按钮点了没反应）。
- `evidenceRow`：每个依据 chip 右边多一枚定位按钮，点它直接去那个位置。
- `suggestCards`：路径改用位置胶囊（可点、可右键）；主按钮直接打开第一个位置；
  原来的「跳页面」降级成次级按钮。
- 新增 `replayTrace(trace)`：历史里的「查证过程 N 步」折叠块，只读。
- 新增 `actsBar(acts)` / `recordAct()` / `markActUndone()`：会话级「执行记录」，
  记录执行与撤销。
- `loadSession()` 重写：清掉旧卡片与提案队列、重放 trace / 依据 / 建议 / 入口 / 用量 /
  执行记录，并且把历史消息补进 `state.history`（「继续」因此能接上下文）。
- 删掉两处 `document.title` 调试残留。

### 4.4 `store.js`：会话落盘白名单

`saveSession()` 不再原样存 `messages`，改为按 `LIMITS` 裁剪：

```js
LIMITS = { messages:60, trace:24, summary:300, error:200, result:600,
           suggest:6, evidence:8, entries:16, acts:40, paths:8 }
```

- assistant 消息保留 `trace / evidence / suggest / entries / usage`；
- 单步 `result` 只在 `JSON.stringify` 后 ≤ 600 字符时保留（一次 `list_dir` 可能几十 KB，
  留着只会让会话文件变慢变大）；
- payload 加 `version: 2`，老会话没有这些字段，回放时走 `fromText` 兜底。

### 4.5 `main.rs`：打开之前先确认存在

- `open_path`：去空白；拒绝空路径、含引号或控制字符；`http/https/mailto` 跳过存在性检查；
  本地路径 `exists()` 为假直接返回「这个位置已经不在了：…」；
  参数用 `raw_arg` 显式加引号，带空格的路径不会被 `cmd` 拆成两截。
- `reveal`：同样的校验；目录打开、文件 `/select,` 选中。

### 4.6 `styles.css`

`.md-path`（虚线下划线、悬停上色）、`.ai-entries / .ai-entry`（位置胶囊）、
`.ai-ev-open`（依据行定位按钮）、`.ai-replay*`（查证过程折叠块）、`.ai-acts*`（执行记录）。
全部走既有 token，进入/悬停/按下都有过渡，`prefers-reduced-motion` 下只留颜色变化。

顺带补上 `--card-max: 572px`：这个变量以前只被引用、从未定义，
等于卡片与折叠块的 `max-width` 被浏览器当无效值丢掉。

---

## 5. 边界与安全

- 可执行文件（exe/msi/bat/cmd/ps1/js/vbs/lnk/reg/hta…）只定位，不运行 ——
  路径来自模型，点一下就执行等于把「模型写的话」变成「用户执行的程序」。
- 入口只收**工具真的碰过**的绝对路径，相对路径一律不认（认了会在程序自己目录里瞎开）。
- 路径不存在时不打开任何东西，只报原因。
- 历史回放只读：能看、能点开位置，不会再触发任何动作。

---

## 6. 验证

自动化：

- `node src/web/js/ai/md.selftest.mjs` → 33/33 通过（含 3 条 XSS），新增 M13/M14/M15
  覆盖本地路径可点、裸路径/UNC/网址不误判、`hasMarkup` 路径判定。
- `node --check` 通过：`entries.js`、`chatui.js`、`store.js`、`md.js`、`proposals.js`、`pages/ai.js`。

真机（1.35.0，见变更记录同名条目）：点正文路径、点结果位置带、点建议卡片主按钮、
右键菜单四项、历史会话重放 + 点开入口、执行记录出现与撤销标记。

---

## 7. 跨页跳转：把路径带到目标页（1.36.5）

1.35.0 只把「跳页面」降级成次级按钮，没解决它：`onclick` 还是
`location.hash = '#' + page`，路由也没有第二个参数位。于是用户点「去工具页」，
到了工具页，输入框空着、列表是「还没有结果」——和没点一样。

用户原话（1.36.4 复测）：

> 我在AI给的链接结果点击去工具页后工具页并没有显示ai给的文件和内容，
> 这个问题你修复一下，没有这个功能的话就开发。

### 7.1 契约

| 位置 | 作用 |
|---|---|
| `App.jump(id, payload)` | 带载荷跳页。payload = `{ paths: [...], action, why }` |
| `navigate(id, hash, { force })` | 已在目标页时也要重挂载，否则页面留着上一次的结果 |
| `Pages[id].jump(payload)` | 目标页自己决定怎么接。切页后由 `App.jump` 调用 |

没有 `jump()` 的页面退回普通切页，不报错——所以旧页面不受影响。

### 7.2 空间工具页（`pages/tools.js`）

跳进来必须**看得见东西**，顺序写死：

1. 顶部横幅「助手提到的位置」：列出载荷里的每个路径（位置胶囊，可点可右键），
   右侧显示这次要用的目录，可收起；
2. 把目录填进扫描框并**立刻扫**，不用用户再点一次；
3. 扫到的行加左侧强调线 + 「助手提到」徽标，并滚到第一条；
4. `action = delete` 且全是目录时，走空文件夹那一块：展开它、收起大文件块、
   填目录、扫、标出命中的行。

失败兜底：扫描报错时横幅仍然列着路径，用户至少知道 AI 指的是哪。

### 7.3 压缩包页（`pages/archive.js`）

载荷里有 `.zip/.rar/.7z/.tar/.gz/.tgz/.bz2/.xz/.zst` 就直接打开那个包，
不停在「请选择压缩包」。

### 7.4 其它入口

位置胶囊的右键菜单新增「在空间工具里查看」：任何一个路径都能带着去工具页，
不用先回对话里找那张卡片。

### 7.5 验证

无头渲染（`D:\Tools\.tmp\jumpcheck\app.html`，真 `styles.css` + 真 `ui.js`
+ 真 `pages/tools.js`，API 用桩）：`check` 变体里横幅、自动扫描、
`a.iso` 的「助手提到」徽标与强调线都在；`delete` 变体里大文件块收起、
空文件夹块展开并标出命中的 `D:\Downloads\old`。真机见变更记录 1.36.5。
