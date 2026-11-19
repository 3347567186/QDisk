# AI 思考强度与温度：两个旋钮，不是一根轴

生效版本：1.36.20 · 相关代码：`src/web/js/ai/strength.js`（新增）、`prompt.js`、`agent.js`、`chatui.js`、`composer.js`、`effort.js`、`store.js`、`pages/settings.js`

---

## 1 原来的设计错在哪

旧实现把强度做成一件事，四个数字全绑在同一条轴上：

```js
// 旧 chatui.js
const THINKING = {
  simple: { steps: 3, replyMax: 320 },
  medium: { steps: 6, replyMax: 600 },
  deep:   { steps: 9, replyMax: 900 }
};
```

四个后果，全是用户能直接感受到的：

| 现象 | 真正的原因 |
|---|---|
| 调「深度」没感觉 | 档位只改了最多查几轮、答案最长多少字，模型本身拿不到任何「多想想」的信号 |
| 想更认真反而更容易胡说 | 旧逻辑里没有一个参数管住随机性；改档位时温度不变，改温度时档位不变，两者从没被区分 |
| 推理模型一开深度就 400 | 从没发过厂商原生字段（`reasoning_effort` / `thinking` / `enable_thinking`），也没在 400 后学过 |
| 深度档答案反而更短 | `replyMax` 与「思考多少」被当成同一件事，深思考被写死成「答得更长」 |

一句话：**强度是「愿意花多少算力」，温度是「答案发散到什么程度」。把两者串成一根轴，等于让「更认真」变成「更随机」。**

---

## 2 新的分工

```
强度（用户选）───→ 厂商原生思考字段 + 查证轮数上限 + 回复长度上限
                    off / low → 关思考    medium → 1.6K 思考预算    high → 4.0K
温度（任务定）───→ 查文件 0.1 · 算数字 0 · 改代码 0.2 · 写文案 0.85 · 问答 0.2
                    ↑ 用户在设置里手填的值优先于任务默认
```

两者正交：档位不动的时候，换一个问题类型，温度会自己变；温度锁死的时候，档位照常生效。

### 2.1 四档（`strength.js` 的 `LEVELS`）

| 档位 | 思考预算 | 最多查几轮 | 回复上限 | 没任务信息时的温度区间 |
|---|---|---|---|---|
| 关 off | 0 | 6 | 480 | 0 – 0.3 |
| 低 low | 0 | 8 | 520 | 0 – 0.3 |
| 中 medium（默认） | 1 600 | 10 | 700 | 0.4 – 0.6 |
| 高 high | 4 000 | 14 | 900 | 0.6 – 0.9 |

「温度区间」只在识别不出任务时兜底，**不是夹取**：任务说要 0.2，高档也照样 0.2。正确性优先于档位面子。

### 2.2 任务识别（`TASKS`，顺序即优先级）

| 任务 | 温度 | 触发词（节选） |
|---|---|---|
| code | 0.2 | 代码、函数、报错、堆栈、脚本、正则、编译、依赖、重构 |
| math | 0 | 算一下、计算、换算、百分比、平均、公式、几倍 |
| tool | 0.1 | 文件、目录、磁盘、空间、清理、删除、回收站、整理、归档、截图 |
| creative | 0.85 | 写一段、文案、广告、标题、起名、故事、诗、润色、改写 |
| qa | 0.2 | 兜底 |

认不出的问题落到 `tool`（这软件的默认场景就是查文件）。空输入不猜任务。

### 2.3 厂商原生字段（`FAMILIES`）

| 端点/模型 | 发送的字段 |
|---|---|
| OpenAI / xAI / Gemini 兼容 | `reasoning_effort: minimal \| low \| medium \| high` |
| OpenRouter | `reasoning: { enabled: false }` 或 `{ effort, max_tokens }` |
| Anthropic | `thinking: { type: 'disabled' }` 或 `{ type: 'enabled', budget_tokens }`（夹在 1024–32000） |
| 通义千问 / DashScope | `enable_thinking: true \| false` |
| 智谱 / Kimi / DeepSeek | `thinking: { type: 'enabled' \| 'disabled' }` |
| 本地（127.0.0.1 / ollama / lmstudio） | 不发 |

厂商不认这些字段时会回 4xx，`agent.js` 的 `downgrade()` 按报错文案逐条学：
`reasoning_effort` → `caps.noReasoningEffort`，`thinking`/`budget_tokens`/`enable_thinking` → `caps.noThinking`，
泛化的 `reasoning` → `caps.noReasoning`。学过一次就记住，下次不再发，也不再 400。

### 2.4 温度被锁的模型

```js
const TEMP_LOCKED = /^o[1-4](?:-|$)|gpt-5|deepseek[-_ ]?(r1|reasoner|v4-reasoner)|qwq|glm[-_ ]?z1/i;
```

命中就把 `policy.temperature` 设成 `null`：`agent.js` 只在 `typeof settings.temperature === 'number'` 时才把
`temperature` 放进请求体。**不硬拉温度的模型，我们就不发**，而不是发一个必然被拒的数字再降级重试。

---

## 3 提示词侧（`prompt.js` 的 `EFFORT`）

系统提示词里新增一段「【推理强度怎么用】」，把四档的行为约定写死：

- 关：不展开推理，直接给结论
- 低：一步到位，不绕路
- 中：看结构 → 查细节 → 给结论
- 高：多路径验算、交叉核对，必要时回头重查
- 强度高时不许为显得努力而空转（结论稳定就停）
- 温度由任务决定，不由强度决定
- 任务与温度冲突时按正确性走，不许因为温度高就猜
- **不要在回答里复述当前强度/温度**（界面已经显示了）

`contextLine()` 每轮把实际值写进【上下文】：`强度=高 · 温度=0.2（任务） · 任务=代码`。
模型能看见，用户看不见——不污染正文。

---

## 4 界面（用户能看见的四处）

1. **输入框里的四档滑块**：`关闭 / 低 / 中 / 高`，每档下面标思考预算（`不思考 / 不思考 / 1.6K / 4.0K`），
   `aria-valuetext` 与 title 同步说「思考预算多少 token · 最多查几轮」。
2. **重置**：滑到别处后标题右侧出现「重置」，点了回默认档（中）。本来就在「中」时这个按钮不显示。
3. **答案下方一行**：`高 · 温度 0.2（任务）`（`.ai-policy`），跟着时长/token/命中率/思考用量排在一起。
4. **设置 → 温度**：勾「按任务自动」时输入框置灰，提示写明「查文件 0.1 · 算数字 0 · 写文案 0.85」；
   取消勾选才用手填值（推理模型锁温时手填值不发送）。
   **查证轮数上限**改成 1–30 的数字输入，标明「与强度档位取小：关 6 / 低 8 / 中 10 / 高 14」。

### 4.1 「思考预算已用 / 剩余」

服务端**上报了**思考 token（`reasoning_tokens` / `completion_tokens_details.reasoning_tokens` 等四种字段）才算真值，
显示 `1200 思考/4000`；没上报就按 `completion_tokens × 0.9` 估一个并加「约」字，
悬停说明会写清「这是估算」。**不编 0，也不冒充精确值。**

---

## 5 数据

会话消息新增 `policy: { level, temperature, tempSrc, task, think }`，`store.js` 的 `slimMsg` 白名单放行；
`usage` 增加 `reasoning_tokens` / `reasoning_reported`。回看历史时，
`Strength.line(m.policy)` 按 level 现查档位名——档位表以后改了，旧记录也不会显示错名字。

老数据迁移：`migrateLevel()` 把 `simple → low`、`deep → high`，未知值回 `medium`。用户的习惯不会被一次升级吃掉。

---

## 6 验证

- 新增 `src/web/js/ai/strength.selftest.mjs`（28 条）：档位表、任务优先级、温度来源优先级、手填覆盖、
  JSON 模式压闸、锁温模型、四家原生字段、步数硬闸、读 token 的四种字段、估算标记、迁移、一行摘要。
- 既有三个自测仍全绿：`md` 33/33、`actions` 32/32、`agent` 33/33（token ≤ 8000）。
- `src/web/js` 全量 `node --check` 通过。

## 7 边界

- 强度**不改上下文窗口**：想得深不该记得少。窗口仍由模型能力决定，压缩阈值在 50/70/85% 自动踩。
- 强度**不等于答案长度**：`replyMax` 只是上限，不是目标。
- 步数上限是**安全闸**，不是强度本身：超了先给结论，不会无限查。
- 温度只影响采样，不保证「正确」；对着精确数字的任务（math/code）一律低温度，这条不受档位影响。
