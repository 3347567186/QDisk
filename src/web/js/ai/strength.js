/* AI 推理强度与温度策略层
   ------------------------------------------------------------------
   为什么单独一层：强度和温度是两件事，不能串成一根轴。

     强度 = 愿意花多少算力（想多深、查几轮、要不要回头验算）
     温度 = 答案有多发散（同一个问题能有几种说法）

   把温度绑死在强度上会得到荒谬结果：「想更认真」变成「更容易胡说」。
   所以这里的分工是：

     强度：由用户的档位决定，映射到厂商原生字段（reasoning_effort /
           thinking.budget_tokens / thinking.type / enable_thinking），
           并给出查证轮数上限与回复长度上限。
     温度：由「任务是什么」决定（查文件要稳、写文案要活），
           用户手填的数字优先于任务默认，强度档位只在识别不出任务时兜底。

   这一层只做决策，不发请求、不碰 DOM。agent 拿 extra 原样并进请求体，
   chatui 拿 note 写进上下文行与右下角用量。 */
(function (root) {
  'use strict';

  const T = (zh, en) => (root.UILang && root.UILang.pick ? root.UILang.pick(zh, en) : zh);

  /* ---------------- 强度档位 ----------------
     think：给厂商原生字段用的思考 token 预算（0 = 不思考）
     steps：本轮最多查证几轮（防「无限思考」的硬闸）
     band ：没有任务信息时的默认温度区间（不是强制夹取，
            任务说要 0.2 就 0.2——正确性优先于档位面子） */
  const LEVELS = {
    off: {
      id: 'off',
      label: ['关闭', 'Off'],
      icon: 'feather',
      think: 0,
      steps: 6,
      /* 480 太窄：用户问「什么最占空间」，答案要交代「这是什么东西、占多少、
         能不能清」，480 字符装不下，只能砍成一句话。省的是推理步数，不是答案内容。 */
      replyMax: 640,
      band: [0, 0.3],
      hint: ['不思考，但结论要给全', 'No thinking, still a complete answer']
    },
    low: {
      id: 'low',
      label: ['低', 'Low'],
      icon: 'feather',
      think: 0,
      steps: 8,
      replyMax: 520,
      band: [0, 0.3],
      hint: ['少走弯路，一步到位', 'Few steps, straight to the point']
    },
    medium: {
      id: 'medium',
      label: ['中', 'Medium'],
      icon: 'bulb',
      think: 1600,
      steps: 10,
      replyMax: 700,
      band: [0.4, 0.6],
      hint: ['默认：先想清楚再动手', 'Think first, then act']
    },
    high: {
      id: 'high',
      label: ['高', 'High'],
      icon: 'brain',
      think: 4000,
      steps: 14,
      replyMax: 900,
      band: [0.6, 0.9],
      hint: ['多路径验算，必要时回头重查', 'Cross-check and revisit when needed']
    }
  };

  const ORDER = ['off', 'low', 'medium', 'high'];
  const DEFAULT_LEVEL = 'medium';

  /* ---------------- 任务类型 ----------------
     顺序即优先级。这个助手的主场景是动文件，所以认不出时按 tool 处理，
     而不是按「问答」处理——按问答处理会让温度飘到 0.2 以上。 */
  const TASKS = [
    {
      id: 'code',
      label: ['代码', 'code'],
      temp: 0.2,
      re: /代码|函数|报错|异常|堆栈|脚本|正则|sql|编译|依赖|接口|重构|变量|api/i
    },
    {
      id: 'math',
      label: ['计算', 'math'],
      temp: 0.0,
      re: /算一下|计算|换算|百分比|比例|总共|平均|公式|几倍|等于多少/
    },
    {
      id: 'tool',
      label: ['动手', 'action'],
      temp: 0.1,
      re: /文件|目录|文件夹|磁盘|空间|清理|删除|回收站|整理|归档|压缩|截图|重复|占用|大文件|缓存|卸载/i
    },
    {
      id: 'creative',
      label: ['创作', 'writing'],
      temp: 0.85,
      re: /写一段|写个|文案|广告|标题|起名|故事|诗|润色|改写|邮件|朋友圈|宣传/
    },
    {
      id: 'qa',
      label: ['问答', 'q&a'],
      temp: 0.2,
      re: /是什么|为什么|怎么|如何|介绍|区别|原理|建议|能不能/
    }
  ];

  const TASK_DEFAULT = 'tool';

  /* ---------------- 厂商原生字段 ----------------
     一个模型认不认这些字段，端点说了算：不认就 4xx，agent 的 downgrade
     会学到 caps.noThinking / noReasoningEffort 并把字段摘掉重试，
     不会因为一次 400 就把整轮对话废掉。 */
  function word(level) {
    if (level === 'off') return 'minimal';
    if (level === 'low') return 'low';
    if (level === 'medium') return 'medium';
    return 'high';
  }

  function thinkTokens(level, think) {
    const n = Number(think) || 0;
    if (!n) return 0;
    /* Anthropic 要求 budget_tokens >= 1024，其余家也都不喜欢太小的值 */
    return Math.max(1024, Math.min(32000, Math.round(n)));
  }

  const FAMILIES = [
    {
      id: 'openai',
      label: 'OpenAI',
      re: /api\.openai\.com|azure\.com|\/openai\/|^gpt-|^o[1-4](?:-|$)|chatgpt/i,
      build(level) { return { reasoning_effort: word(level) }; }
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      re: /openrouter\.ai/i,
      build(level, think) {
        if (level === 'off') return { reasoning: { enabled: false } };
        return { reasoning: { effort: word(level), max_tokens: thinkTokens(level, think) } };
      }
    },
    {
      id: 'anthropic',
      label: 'Claude',
      re: /anthropic|\/v1\/messages|^claude/i,
      build(level, think) {
        if (level === 'off') return { thinking: { type: 'disabled' } };
        return { thinking: { type: 'enabled', budget_tokens: thinkTokens(level, think) } };
      }
    },
    {
      id: 'gemini',
      label: 'Gemini',
      re: /generativelanguage|googleapis|gemini/i,
      build(level) { return { reasoning_effort: word(level) }; }
    },
    {
      id: 'qwen',
      label: '通义千问',
      re: /dashscope|aliyuncs|qwen|tongyi/i,
      build(level) { return { enable_thinking: level !== 'off' }; }
    },
    {
      id: 'zhipu',
      label: '智谱',
      re: /bigmodel|zhipu|glm/i,
      build(level) { return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }; }
    },
    {
      id: 'moonshot',
      label: 'Kimi',
      re: /moonshot|kimi/i,
      build(level) { return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }; }
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      re: /deepseek/i,
      build(level) { return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }; }
    },
    {
      id: 'xai',
      label: 'xAI',
      re: /x\.ai|grok/i,
      build(level) { return { reasoning_effort: word(level) }; }
    },
    {
      id: 'local',
      label: '本地',
      re: /127\.0\.0\.1|localhost|:11434|:1234|ollama|lmstudio/i,
      build() { return null; }
    }
  ];

  /* 温度被厂商锁死的模型：o 系列、gpt-5 系、deepseek 推理版。
     对它们发 temperature 只会换来一次 400，不如不发。 */
  const TEMP_LOCKED = /^o[1-4](?:-|$)|gpt-5|deepseek[-_ ]?(r1|reasoner|v4-reasoner)|qwq|glm[-_ ]?z1/i;

  function familyOf(endpoint, model) {
    const hay = String(endpoint || '') + ' ' + String(model || '');
    if (TEMP_LOCKED.test(String(model || ''))) {
      /* 推理专用模型仍可能认 reasoning_effort，先照厂商匹配 */
      for (let i = 0; i < FAMILIES.length; i += 1) {
        if (FAMILIES[i].re.test(hay)) return FAMILIES[i];
      }
      return FAMILIES[0];
    }
    for (let i = 0; i < FAMILIES.length; i += 1) {
      if (FAMILIES[i].re.test(hay)) return FAMILIES[i];
    }
    return null;
  }

  function detectTask(text) {
    const s = String(text || '');
    if (!s.trim()) return null;
    for (let i = 0; i < TASKS.length; i += 1) {
      if (TASKS[i].re.test(s)) return TASKS[i];
    }
    for (let i = 0; i < TASKS.length; i += 1) {
      if (TASKS[i].id === TASK_DEFAULT) return TASKS[i];
    }
    return null;
  }

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  /* 温度留两位：0.85 这类任务默认值不该被四舍五入成 0.9，
     否则「写文案」和「更发散」之间的差别会被抹平 */
  function round1(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  /* 温度来源优先级：用户手填 > 任务默认 > 档位区间中点。
     只在真的开了 JSON 模式时才压 0.7 的闸——没开就别动手，
     否则「写文案」永远拿不到它该有的高温。 */
  function temperatureFor(levelDef, task, manual, jsonMode) {
    let t;
    let src;
    if (manual !== null && manual !== undefined && manual !== '' && Number.isFinite(Number(manual))) {
      t = clamp(manual, 0, 2);
      src = 'manual';
    } else if (task && typeof task.temp === 'number') {
      t = task.temp;
      src = 'task';
    } else {
      const band = levelDef.band;
      t = round1((band[0] + band[1]) / 2);
      src = 'level';
    }
    if (jsonMode === true && t > 0.7) t = 0.7;
    return { t: round1(t), src: src };
  }

  /**
   * 算出一轮请求的策略。
   * @param {object} o { level, text, temperature, endpoint, model, jsonMode, stepCap }
   * @returns {object} 决策结果（temperature 为 null 表示这家不让调）
   */
  function resolve(o) {
    const opts = o || {};
    const level = LEVELS[opts.level] ? opts.level : DEFAULT_LEVEL;
    const L = LEVELS[level];
    const task = detectTask(opts.text);
    const fam = familyOf(opts.endpoint, opts.model);
    const locked = TEMP_LOCKED.test(String(opts.model || ''));
    const temp = temperatureFor(L, task, opts.temperature, opts.jsonMode);
    const cap = Number(opts.stepCap) || 0;
    const think = L.think;
    return {
      level: level,
      levelDef: L,
      task: task ? task.id : null,
      taskLabel: task ? task.label : null,
      temperature: locked ? null : temp.t,
      tempSrc: locked ? 'locked' : temp.src,
      think: think,
      steps: cap > 0 ? Math.min(L.steps, cap) : L.steps,
      replyMax: L.replyMax,
      family: fam ? fam.id : null,
      familyLabel: fam ? fam.label : null,
      extra: fam && fam.build ? fam.build(level, think) : null
    };
  }

  /* 给「预算已用/剩余」用的思考 token：只有服务端真给了才是真数字，
     没给就是 null，界面必须显示「未上报」而不是编一个 0。 */
  function thinkUsed(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const cands = [
      usage.reasoning_tokens,
      usage.reasoning,
      usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens,
      usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens
    ];
    for (let i = 0; i < cands.length; i += 1) {
      const n = Number(cands[i]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    return null;
  }

  /* 「估算」口径：模型没上报思考 token 时，用「占了几成输出」粗估。
     返回值带 estimated 标记，界面照这个文案写「约」，不许冒充精确值。 */
  function thinkEstimate(policy, usage) {
    const real = thinkUsed(usage);
    if (real !== null) return { tokens: real, estimated: false, budget: policy ? policy.think : 0 };
    if (!policy || !policy.think) return { tokens: 0, estimated: false, budget: 0 };
    const out = Number(usage && usage.completion_tokens) || 0;
    /* 经验值：带思考的模型，思考约占输出的 0.6–1.5 倍，取 0.9 保守估 */
    return { tokens: Math.round(out * 0.9), estimated: true, budget: policy.think };
  }

  /* 一行摘要：「高 · 温度 0.2（任务）」，给上下文行和界面共用。
     policy 可能来自历史回放（只剩 level/温度这几个字段），
     所以档位名按 id 现查，不假设 levelDef 一定在。 */
  function line(policy) {
    if (!policy) return '';
    const def = LEVELS[policy.level] || LEVELS[DEFAULT_LEVEL];
    const name = T(def.label[0], def.label[1]);
    if (policy.temperature === null || policy.temperature === undefined) {
      return name + ' · ' + T('温度由模型固定', 'temperature fixed by model');
    }
    const src = {
      manual: T('手填', 'manual'),
      task: T('任务', 'task'),
      level: T('档位', 'level'),
      locked: T('模型固定', 'fixed')
    }[policy.tempSrc] || '';
    return name + ' · ' + T('温度 ', 'temp ') + policy.temperature + (src ? '（' + src + '）' : '');
  }

  function stops() {
    return ORDER.map((id) => ({
      id: id,
      label: LEVELS[id].label,
      icon: LEVELS[id].icon,
      think: LEVELS[id].think,
      steps: LEVELS[id].steps,
      hint: LEVELS[id].hint
    }));
  }

  /* 老版本存的 simple / deep 迁到新档位，别让用户的习惯被一次升级吃掉 */
  function migrateLevel(v) {
    if (v === 'simple') return 'low';
    if (v === 'deep') return 'high';
    return LEVELS[v] ? v : DEFAULT_LEVEL;
  }

  root.AIStrength = {
    LEVELS: LEVELS,
    ORDER: ORDER,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    TASKS: TASKS,
    FAMILIES: FAMILIES,
    resolve: resolve,
    detectTask: detectTask,
    familyOf: familyOf,
    thinkUsed: thinkUsed,
    thinkEstimate: thinkEstimate,
    temperatureFor: temperatureFor,
    line: line,
    stops: stops,
    migrateLevel: migrateLevel,
    isLockedTemp: (model) => TEMP_LOCKED.test(String(model || ''))
  };
})(typeof window !== 'undefined' ? window : globalThis);
