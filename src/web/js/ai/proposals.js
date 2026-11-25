/* AI 助手 · 提案与审批
   ------------------------------------------------------------
   这是整个「AI 能改文件」功能的安全核心。规则只有一条，但是硬的：

       模型只能「提议」，执行只发生在用户点了审批按钮之后。

   具体怎么落地：
   · commit() 不在工具表里，模型拿不到这个函数，所以它无法自我批准。
   · 每个提案带 params 哈希、过期时间（10 分钟）、单次使用；
     用过一次就作废，改一个参数就是另一个提案。
   · 提案落地前先用引擎自己的 dry-run 算真实数量/大小/被拒项；
     预演里被引擎拒绝的项，不会在批准后偷偷执行。
   · 预算：一个对话最多 N 次提案、每个提案最多 N 项 / 4GB；
     超了直接拒绝，让用户自己去界面做。
   · 审计：每次提议/批准/拒绝/过期/执行/撤销都写 journal-YYYYMM.jsonl，
     带滚动哈希（djb2，防误改，不是防篡改的密码学签名）。 */
(function (root) {
  'use strict';

  const TTL = 10 * 60 * 1000;
  const MAX_PENDING = 3;
  const MAX_REPLANS = 2;

  const MODES = ['off', 'confirm', 'auto', 'full'];
  const CATS = ['organize', 'files', 'archive', 'clean', 'apps', 'search', 'settings'];

  function defaultPolicy() {
    return {
      mode: 'off',
      cats: { organize: true, files: true, archive: true, clean: true, apps: true, search: true, settings: true },
      maxOpsPerTurn: 2,
      maxOpsPerSession: 30,
      maxItems: 200,
      maxBytes: 4 * 1024 * 1024 * 1024
    };
  }

  function normalizePolicy(p) {
    const d = defaultPolicy();
    const o = p && typeof p === 'object' ? p : {};
    const out = {
      mode: MODES.indexOf(o.mode) >= 0 ? o.mode : d.mode,
      cats: Object.assign({}, d.cats),
      maxOpsPerTurn: clamp(o.maxOpsPerTurn, 1, 10, d.maxOpsPerTurn),
      maxOpsPerSession: clamp(o.maxOpsPerSession, 1, 200, d.maxOpsPerSession),
      maxItems: clamp(o.maxItems, 10, 20000, d.maxItems),
      maxBytes: clamp(o.maxBytes, 100 * 1024 * 1024, 20 * 1024 * 1024 * 1024, d.maxBytes)
    };
    if (o.cats && typeof o.cats === 'object') {
      for (const c of CATS) {
        if (typeof o.cats[c] === 'boolean') out.cats[c] = o.cats[c];
      }
    }
    return out;
  }

  function clamp(v, lo, hi, def) {
    const n = Number(v);
    if (!isFinite(n)) return def;
    return Math.min(Math.max(n, lo), hi);
  }

  const hash = (s) => {
    let h = 5381;
    const t = String(s);
    for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  };

  const monthKey = () => {
    const d = new Date();
    return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2);
  };

  /* 哪些参数是路径：用来在执行前再过一次闸门 */
  const PATH_KEYS = ['dest', 'out_dir', 'destination', 'path', 'folder'];

  function create(deps) {
    const API = deps.API;
    const store = deps.store;
    const actions = deps.actions;

    let policy = normalizePolicy(deps.policy);
    let pending = [];      // 未处理提案
    let history = [];      // 已完结提案（含 undo 信息）
    let seq = 0;
    let execs = 0;
    let turnMsgs = 0;
    let denyStreak = {};
    let lastHash = '';
    let chainReady = null;
    const subs = new Set();

    const now = () => Date.now();

    /* 订阅：整页和抽屉是两个 chat 实例，但共用同一份提案队列，
       谁改了状态就通知所有人重画，免得一边执行完另一边还挂着「执行」按钮。 */
    function subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    }

    function notify() {
      subs.forEach((fn) => {
        try { fn(); } catch (e) { /* 某个视图画挂了不该影响别的视图 */ }
      });
    }

    /* 这个动作里「可以勾选的那一列」是哪一列：第一个能放多条的 paths 参数。
       没有就返回空串——例如 settings.set 只有一个键，没什么可挑的。 */
    function pickKeyOf(actionId) {
      const act = actions.get(actionId);
      if (!act || !act.schema) return '';
      for (const k of Object.keys(act.schema)) {
        const s = act.schema[k];
        if (s && s.type === 'paths' && (s.max || 0) > 1) return k;
      }
      return '';
    }

    function capItemsOf(actionId) {
      return actionId === 'organize.apply' ? 20000 : Math.min(policy.maxItems, actions.limits.items);
    }

    function capBytesNow() {
      return Math.min(policy.maxBytes, actions.limits.bytes);
    }

    /* 审计链：会话第一条先读回当天文件最后一行，保证跨会话也能对上 */
    function ready() {
      if (!chainReady) {
        chainReady = (async () => {
          try {
            const name = 'journal-' + monthKey() + '.jsonl';
            const text = await store.aiStore('read', name);
            if (text && typeof text === 'string') {
              const lines = text.trim().split('\n').filter(Boolean);
              if (lines.length) {
                try {
                  const last = JSON.parse(lines[lines.length - 1]);
                  lastHash = String(last.h || '');
                  seq = Number(last.n) || 0;
                } catch (e) { /* 文件被手工改坏：从当前状态重新起链 */ }
              }
            }
          } catch (e) { /* 读不到就从头开始，不影响功能 */ }
        })();
      }
      return chainReady;
    }

    async function journal(entry) {
      await ready();
      seq += 1;
      const body = {
        n: seq,
        at: new Date().toISOString(),
        phase: entry.phase,
        id: entry.id || '',
        action: entry.action || '',
        cat: entry.cat || '',
        items: entry.items || 0,
        bytes: entry.bytes || 0,
        hash: entry.hash || '',
        result: entry.result || '',
        why: entry.why || ''
      };
      body.p = lastHash;
      body.h = hash(lastHash + JSON.stringify(body));
      lastHash = body.h;
      try {
        await store.aiStore('append', 'journal-' + monthKey() + '.jsonl', JSON.stringify(body) + '\n');
      } catch (e) { /* 审计写失败不该阻断用户已经批准的动作 */ }
      return body;
    }

    function setPolicy(p) {
      policy = normalizePolicy(p);
      return policy;
    }

    function getPolicy() { return policy; }

    function startTurn() {
      turnMsgs = 0;
      denyStreak = {};
      sweep();
    }

    function newSession() {
      /* 待处理的提案不清：它是一张等用户点的卡，不是这一轮对话的中间状态。
         清掉它会让「整页开的卡」在抽屉里一开新对话就消失，用户以为丢了。 */
      history = [];
      execs = 0;
      turnMsgs = 0;
      denyStreak = {};
      notify();
    }

    /* 过期清扫：过期的提案一律标 expired，不再接受批准 */
    function sweep() {
      const t = now();
      for (const p of pending) {
        if (p.status === 'pending' && p.expires <= t) {
          p.status = 'expired';
          journal({ phase: 'expire', id: p.id, action: p.action, cat: p.cat });
        }
      }
      pending = pending.filter((p) => p.status === 'pending');
    }

    /* 自动执行的边界：只给「撤得回来」的动作放行。
       full 档放宽到风险 2，但仍然要求可逆——删空文件夹、删注册表项、清日志
       这些统统不可逆，哪怕在放手档也必须有人点一下。 */
    function canAuto(risk, reversible) {
      if (policy.mode === 'auto') return risk <= 1 && reversible === true;
      if (policy.mode === 'full') return risk <= 2 && (reversible === true || risk <= 1);
      return false;
    }

    function needsWord(risk) {
      return risk >= 3;
    }

    /* ------------------------------------------------------------ 提议 */
    async function propose(input) {
      const it = input || {};
      const id = 'p' + (now().toString(36)) + Math.floor(Math.random() * 1296).toString(36);
      sweep();

      if (policy.mode === 'off') {
        return { ok: false, error: '写入权限是关闭的（设置 → AI 助手 → 允许 AI 动手 设为关闭）。要让我动手，先让用户自己打开这一项。' };
      }
      const act = actions.get(it.action);
      if (!act) {
        return { ok: false, error: '没有这个动作：' + it.action + '。可用动作见「动作目录」。' };
      }
      if (!policy.cats[act.cat]) {
        return { ok: false, error: '「' + act.label + '」属于「' + act.cat + '」类别，用户把这个类别关掉了。' };
      }
      if (pending.length >= MAX_PENDING) {
        return { ok: false, error: '还有 ' + pending.length + ' 个提案等用户处理，等用户处理完再提新的。' };
      }
      if (turnMsgs >= policy.maxOpsPerTurn) {
        return { ok: false, error: '这一轮已经提了 ' + turnMsgs + ' 次，到上限了。先把现在的说清楚，剩下的让用户自己决定。' };
      }
      if (execs >= policy.maxOpsPerSession) {
        return { ok: false, error: '这个对话已经执行了 ' + execs + ' 次动作，到上限了。请让用户自己在界面里继续操作。' };
      }

      let args;
      try {
        args = actions.bind(act.schema, it.args);
      } catch (e) {
        return { ok: false, error: (e && e.message) || '参数不对' };
      }

      /* 路径闸门：模型给的路径先过第三道闸 */
      if (root.AIGuard) {
        const batches = [];
        for (const k of Object.keys(act.schema)) {
          const s = act.schema[k];
          if (s.type === 'paths' && Array.isArray(args[k])) batches.push(args[k]);
          else if (s.type === 'string' && PATH_KEYS.indexOf(k) >= 0 && args[k]) batches.push([args[k]]);
        }
        for (const b of batches) {
          const g = root.AIGuard.check(b);
          if (!g.ok) {
            return { ok: false, error: '有路径不能动：' + g.bad.slice(0, 3).map((x) => (x.path || '') + '（' + x.why + '）').join('；') };
          }
        }
      }

      /* 预演：拿真实数字，也拿真实拒绝原因 */
      let card;
      try {
        card = await act.plan(args);
      } catch (e) {
        return { ok: false, error: (e && e.message) || '预演失败' };
      }
      if (!card || !card.count) {
        const zero = (card && card.note) || '预演结果为空（没有可执行的内容）';
        return { ok: false, error: zero };
      }

      const capItems = capItemsOf(act.id);
      if (card.count > capItems) {
        return { ok: false, error: '这次有 ' + card.count + ' 项，超过单次上限 ' + capItems + ' 项。请缩小范围，或者让用户自己在界面里做。' };
      }
      const capBytes = capBytesNow();
      if (card.bytes > capBytes) {
        return {
          ok: false,
          error: '这次合计 ' + (card.bytes / 1073741824).toFixed(1) + ' GB，超过单次上限 ' +
            (capBytes / 1073741824).toFixed(1) + ' GB。请分批，或者让用户自己动手。'
        };
      }

      const streakKey = act.id + '|' + hash(JSON.stringify(args));
      if ((denyStreak[streakKey] || 0) >= MAX_REPLANS) {
        return { ok: false, error: '用户刚刚两次拒绝过完全相同的提案。换一种方式，或者直接问用户想怎么做。' };
      }

      /* 风险与可撤销由动作自己按参数决定：永久删除和「移入回收站」是同一个动作，
         但风险差一级，不在这里分开，full 档就会把永久删除也自动执行掉。 */
      const risk = card.riskNow !== undefined ? card.riskNow
        : (card.risk !== undefined ? card.risk : act.risk);
      const reversible = card.reversibleNow !== undefined ? card.reversibleNow
        : (card.reversible !== undefined ? card.reversible : act.reversible);
      const auto = canAuto(risk, reversible);
      /* 可勾选的那一列：卡片上默认全选，用户可以只留几条一起执行 */
      const pickKey = pickKeyOf(act.id);
      const picks = (pickKey && Array.isArray(args[pickKey])) ? args[pickKey].slice() : [];

      const p = {
        id,
        action: act.id,
        cat: act.cat,
        label: act.label,
        args,
        why: String(it.reason || '').slice(0, 200),
        card: Object.assign({}, card, {
          action: act.id, label: act.label, risk, reversible,
          undoKind: act.undoKind, cat: act.cat
        }),
        risk,
        reversible,
        pickKey,
        picks,
        hash: hash(JSON.stringify({ a: act.id, args })),
        at: now(),
        expires: now() + TTL,
        status: 'pending',
        auto,
        needsWord: needsWord(risk),
        undo: null
      };
      pending.push(p);
      turnMsgs += 1;
      await journal({
        phase: 'propose', id, action: act.id, cat: act.cat,
        items: card.count, bytes: card.bytes, hash: p.hash, why: p.why
      });
      notify();
      return { ok: true, proposal: p, auto };
    }

    /* ------------------------------------------------------------ 批准 */
    /* 只允许 UI 的用户手势调用。approvedBy 必须是 'user'，
       模型没有这个函数，也没有任何工具能间接调到它。
       opt.paths 是「批量确认」：用户在一张卡里勾掉了其中几条，
       这里只接受原提案里真实存在的子集，并且按子集重新预演、重新算账。 */
    async function commit(id, opt) {
      const o = opt || {};
      sweep();
      if (o.approvedBy !== 'user') {
        return { ok: false, error: '执行只能由用户点击确认触发' };
      }
      const p = pending.find((x) => x.id === id);
      if (!p) {
        const old = history.find((x) => x.id === id);
        if (old) return { ok: false, error: '这个提案已经处理过了（' + old.status + '）' };
        return { ok: false, error: '找不到这个提案，可能已经过期' };
      }
      if (p.status !== 'pending') return { ok: false, error: '这个提案已经不能执行了' };
      if (p.expires <= now()) {
        p.status = 'expired';
        await journal({ phase: 'expire', id, action: p.action, cat: p.cat });
        notify();
        return { ok: false, error: '提案超过 10 分钟，已经过期。让 AI 重新提一次。' };
      }
      if (policy.mode === 'off') return { ok: false, error: '写入权限已经被关闭，动作没有执行' };
      if (!policy.cats[p.cat]) return { ok: false, error: '这个类别已经被关闭，动作没有执行' };
      /* 参数被手工改过（理论上不可能，因为只有 UI 能拿到对象）→ 拒绝 */
      const h = hash(JSON.stringify({ a: p.action, args: p.args }));
      if (h !== p.hash) return { ok: false, error: '参数和提议时不一致，已拒绝执行' };

      /* 勾选：只能是原提案的子集，不能借这个口子加东西进来 */
      let args = p.args;
      let pick = 0;
      if (o.paths !== undefined && o.paths !== null) {
        if (!p.pickKey) return { ok: false, error: '这个动作没有可挑选的项' };
        const all = Array.isArray(p.args[p.pickKey]) ? p.args[p.pickKey] : [];
        const want = [];
        const given = Array.isArray(o.paths) ? o.paths : [];
        for (const x of given) {
          if (typeof x !== 'string') continue;
          if (all.indexOf(x) < 0) return { ok: false, error: '勾选的项不在原来的提案里，已拒绝执行' };
          if (want.indexOf(x) < 0) want.push(x);
        }
        if (!want.length) return { ok: false, error: '一项都没勾，什么也没做' };
        if (want.length < all.length) {
          args = Object.assign({}, p.args);
          args[p.pickKey] = want;
          pick = want.length;
        }
      }

      if (root.AIGuard) {
        const act0 = actions.get(p.action);
        const batches = [];
        for (const k of Object.keys(act0.schema)) {
          const s = act0.schema[k];
          if (s.type === 'paths' && Array.isArray(args[k])) batches.push(args[k]);
          else if (s.type === 'string' && PATH_KEYS.indexOf(k) >= 0 && args[k]) batches.push([args[k]]);
        }
        for (const b of batches) {
          const g = root.AIGuard.check(b);
          if (!g.ok) return { ok: false, error: '有路径现在不能动了：' + g.bad[0].why };
        }
      }

      const act = actions.get(p.action);
      /* 同步抢占状态锁：必须在任何 await 之前脱离 pending，彻底杜绝双击确认导致并发双执行 */
      p.status = 'running';
      /* 子集要重新预演：卡片上那串数字是「整批」的，勾掉一半还按整批记账就是骗人 */
      let card = p.card;
      if (pick) {
        try {
          card = await act.plan(args);
        } catch (e) {
          p.status = 'pending';
          return { ok: false, error: (e && e.message) || '预演失败' };
        }
        if (!card || !card.count) {
          p.status = 'pending';
          return { ok: false, error: '勾选的这几项已经没有可执行的内容了' };
        }
        if (card.count > capItemsOf(p.action)) {
          p.status = 'pending';
          return { ok: false, error: '勾选的这几项有 ' + card.count + ' 项，超过单次上限' };
        }
        if (card.bytes > capBytesNow()) {
          p.status = 'pending';
          return { ok: false, error: '勾选的这几项合计 ' + (card.bytes / 1073741824).toFixed(1) + ' GB，超过单次上限' };
        }
      }

      p.picked = pick || null;
      execs += 1;
      await journal({ phase: 'approve', id, action: p.action, cat: p.cat, items: card.count, bytes: card.bytes, hash: p.hash });
      let out;
      try {
        out = await act.run(args);
      } catch (e) {
        p.status = 'failed';
        p.error = (e && e.message) || '执行失败';
        pending = pending.filter((x) => x.id !== id);
        history.unshift(p);
        await journal({ phase: 'result', id, action: p.action, cat: p.cat, result: 'failed: ' + p.error });
        notify();
        return { ok: false, error: p.error, proposal: p };
      }
      p.status = 'done';
      p.args = args;
      p.card = Object.assign({}, card, { action: p.action, label: p.label, risk: p.risk, reversible: p.reversible });
      p.undo = out.undo || null;
      p.result = out.result || null;
      p.message = out.message || '已执行';
      p.doneAt = now();
      pending = pending.filter((x) => x.id !== id);
      history.unshift(p);
      await journal({
        phase: 'commit', id, action: p.action, cat: p.cat,
        items: card.count, bytes: card.bytes,
        result: p.message + (pick ? '（勾选 ' + pick + ' 项）' : '')
      });
      notify();
      return { ok: true, proposal: p, message: p.message, result: p.result };
    }

    /* 勾选变化时先算一遍再显示：卡片上的「N 项 / 多大」必须是真的。
       只读，不动队列，失败就当没算出来（界面上退回整批的数字）。 */
    async function preview(id, paths) {
      const p = pending.find((x) => x.id === id);
      if (!p) return { ok: false, error: '找不到这个提案' };
      if (!p.pickKey) return { ok: false, error: '这个动作没有可挑选的项' };
      const all = Array.isArray(p.args[p.pickKey]) ? p.args[p.pickKey] : [];
      const want = [];
      for (const x of (Array.isArray(paths) ? paths : [])) {
        if (typeof x === 'string' && all.indexOf(x) >= 0 && want.indexOf(x) < 0) want.push(x);
      }
      if (!want.length) return { ok: true, empty: true, count: 0, bytes: 0 };
      if (root.AIGuard) {
        const g = root.AIGuard.check(want);
        if (!g.ok) return { ok: false, error: '有路径不能动：' + g.bad[0].why };
      }
      const args = Object.assign({}, p.args);
      args[p.pickKey] = want;
      const act = actions.get(p.action);
      let card;
      try {
        card = await act.plan(args);
      } catch (e) {
        return { ok: false, error: (e && e.message) || '预演失败' };
      }
      return {
        ok: true,
        card,
        count: Number(card && card.count) || 0,
        bytes: Number(card && card.bytes) || 0,
        risk: card.riskNow !== undefined ? card.riskNow : p.risk,
        reversible: card.reversibleNow !== undefined ? card.reversibleNow : p.reversible
      };
    }

    /* ------------------------------------------------------------ 拒绝 */
    async function deny(id, why) {
      sweep();
      const p = pending.find((x) => x.id === id);
      if (!p) return { ok: false, error: '找不到这个提案' };
      p.status = 'denied';
      p.denyWhy = String(why || '');
      const key = p.action + '|' + hash(JSON.stringify(p.args));
      denyStreak[key] = (denyStreak[key] || 0) + 1;
      pending = pending.filter((x) => x.id !== id);
      history.unshift(p);
      await journal({ phase: 'deny', id, action: p.action, cat: p.cat, why: p.denyWhy });
      notify();
      return { ok: true };
    }

    /* ------------------------------------------------------ 模型自己撤回 */
    async function cancel(id) {
      sweep();
      const p = pending.find((x) => x.id === id);
      if (!p) return { ok: false, error: '没有这个待处理的提案（可能已经过期或被处理）' };
      p.status = 'cancelled';
      pending = pending.filter((x) => x.id !== id);
      history.unshift(p);
      await journal({ phase: 'deny', id, action: p.action, cat: p.cat, why: '模型撤回' });
      notify();
      return { ok: true };
    }

    async function undo(id) {
      const p = history.find((x) => x.id === id);
      if (!p) return { ok: false, error: '找不到这条执行记录' };
      if (p.status !== 'done') return { ok: false, error: '这个动作没有成功执行，没什么可撤销' };
      if (!p.undo) return { ok: false, error: '这个动作没有自动撤销' };
      if (p.undone) return { ok: false, error: '已经撤销过了' };
      const r = await actions.applyUndo(p.undo);
      if (r.ok) {
        p.undone = true;
        await journal({ phase: 'undo', id, action: p.action, cat: p.cat, result: r.message });
        notify();
      }
      return r;
    }

    function list() {
      sweep();
      return pending.slice();
    }

    function recent(n) {
      return history.slice(0, n || 5);
    }

    function stats() {
      return {
        mode: policy.mode,
        pending: pending.length,
        execs,
        limit: policy.maxOpsPerSession,
        turn: turnMsgs,
        turnLimit: policy.maxOpsPerTurn
      };
    }

    return {
      setPolicy, getPolicy, startTurn, newSession,
      propose, commit, deny, cancel, undo, list, recent, stats,
      preview, subscribe, notify,
      TTL, MAX_PENDING, MODES, CATS
    };
  }

  /* 全应用一份：整页的对话、抽屉里的对话、设置页看到的应该是同一队提案，
     各建一份会出现「这边执行完，那边还挂着执行按钮」。 */
  let shared = null;
  function sharedCreate(deps) {
    if (!shared) shared = create(deps);
    return shared;
  }

  const API = { create, shared: sharedCreate, defaultPolicy, normalizePolicy, hash, TTL, MODES, CATS };
  root.AIProposals = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
