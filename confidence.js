// 消费侧门控：把「这条指针后来有没有被用上」变成下一次注入的依据。
//
// 为什么需要它：检索只回答「这条和问题像不像」，回答不了「这条值不值得占上下文」。
// 真实账本里有一条笔记被带进上下文 53 次、一次都没被打开过 —— 它每一轮都在花预算，
// 而预算就是上下文（本机实测：注入轮的中位预算用量 93%）。这类笔记不是「不相关」，
// 而是**从来没用**，两者的区别只有账本知道。
//
// 三个必须守住的边界（每一版都有人在别处踩过，所以我们写在这里）：
//
// 1. **别用一次会话的偶然去否定一篇笔记。** 一次没被打开可能是模型当时不需要，
//    也可能是那一轮的话题只是擦边。所以要「携带次数够多 + 观察窗口够长」两个条件同时满足，
//    才允许说「它总也用不上」。`enforce` 档的抑制必须两条都满足；`assist` 档只降权不删。
//
// 2. **写完自己马上读回来，不算「被用上」。** 模型刚落盘一篇笔记、紧接着又读它一遍
//    （同一个话题里很常见），如果照记一次「used」，这篇笔记的置信度就被自己的动作喂大了 ——
//    这就是「自我强化」：模型写的结论反过来强化自己，越写越像真的。所以：一次
//    `used` / `opened` 事件，若同一篇笔记在 `selfTouchMs` 内被**写入**过，记为 `selfTouch`，
//    **不计入正反馈**（仍然留在账本里，报告会如实说有多少次是这种）。
//
// 3. **过期只降权，绝不抑制。** 一篇 `project-` 笔记（正在做的事）半年没更新，值得怀疑；
//    但它可能恰恰是那件「还没做完、所以没人动」的事。降权是「往后排」，抑制是「不让模型看到」，
//    后者错一次就是丢线索，所以过期永远只走降权。
//
// 所有函数都是纯函数：账本行 / 审计行 / 文档元数据进，判定出。没有 IO 也没有时间依赖
// （`now` 由调用方传），因此可以拿真实账本离线回放，也可以拿构造的边角数据单测。

import { NOTE_KINDS } from './doctor.js';

/**
 * 门控档位。
 * - `off`：不干预（旧行为，留着做对照）。
 * - `shadow`：算出来、记下来，但**一个字都不改**注入 —— 先看它想干什么，再决定开不开。
 * - `assist`：把「总也用不上」和「过期」的笔记降权（默认档：它只改排序，不删任何东西）。
 * - `enforce`：在 assist 之上，把证据确凿、观察够久的笔记**移出这一轮注入**。
 */
export const GATE_MODES = ['off', 'shadow', 'assist', 'enforce'];

/**
 * 门控阈值。**与 `DEFAULTS` 分开**：这些是算法参数（改它们要有数据支撑），
 * 而 `DEFAULTS` 是用户配置的默认值（改了要写 CHANGELOG）。报告与面板都从这里读，
 * 不许再抄一份。
 */
export const GATE_DEFAULTS = {
  mode: 'assist',
  /** 至少被带进上下文这么多次，才有资格被说「用不上」。低于它 = 样本不够，一律不判。 */
  minEvidence: 8,
  /** assist 档的降权系数（0.5 = 分数砍半，等于让它往后排但还看得见）。 */
  demote: 0.5,
  /** enforce 档抑制所需的最少携带次数（比 minEvidence 更严：删掉一条指针的代价更高）。 */
  suppressMinCarried: 12,
  /** 抑制前至少要观察这么多天（防「一次会话里连着十几轮」这种假证据）。 */
  observeDays: 7,
  /** `project-` 类笔记（正在做的事）多久没更新算过期。 */
  staleDays: 180,
  /** 写完多久内又读回，算「自我触碰」而不算「被用上」。 */
  selfTouchMs: 10 * 60 * 1000,
  /** Beta 后验的先验：α=1、β=9（先验均值 0.10，与本机实测的主对话轮打开率 7.7% 同量级）。 */
  prior: { alpha: 1, beta: 9 },
  /** 后验均值到多少算「确实在用」。 */
  trustedAt: 0.25,
  /**
   * 降权/抑制的门槛按**本库自己的基础打开率**算，而不是拍一个固定次数：
   * 「带过 8 次没被读」听着像证据，可在 5% 的基础率下，一条**和平均一样有用**的笔记
   * 也有 0.95^8 ≈ 66% 的概率一次没被读 —— 拿它判死刑是拿噪声当证据。
   * 所以门槛 = 期望被读到几次（见下两个旋钮）/ 基础率，再与前两个「最少次数」取大。
   */
  expectedReads: 1,
  suppressExpectedReads: 3,
  /** 样本太少的库（携带总数低于它）不用账本率，退回先验率。 */
  baseRateMinSamples: 50,
  /** 基础率下限：全库一次都没被读过时，别把门槛推成无穷（那会让门控永远静默）。 */
  baseRateFloor: 0.01,
};

/**
 * 本库的基础打开率：所有笔记的「被读过」次数 / 「被带进上下文」次数。
 *
 * 为什么要有它：门控要判断的是「这条**比别的**更没用」，而不是「它自己有没有被读」——
 * 在一个 5% 打开率的库里，绝大多数笔记都「没被读」。拿全库平均当尺子，
 * 才谈得上「显著低于平均」这件事。样本不够时退回先验率（与 `confidenceOf` 同一个先验，
 * 免得两处对「平均」的理解不一样）。
 *
 * @returns {{rate:number, source:'ledger'|'prior', carried:number, used:number}}
 */
export function baseReadRate(stats, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const { alpha, beta } = o.prior ?? GATE_DEFAULTS.prior;
  const priorRate = number(alpha) / (number(alpha) + number(beta));
  let carried = 0;
  let used = 0;
  for (const [, stat] of stats instanceof Map ? stats : []) {
    carried += number(stat?.carried);
    used += number(stat?.used);
  }
  if (carried < number(o.baseRateMinSamples)) return { rate: priorRate, source: 'prior', carried, used };
  const rate = Math.max(used / carried, number(o.baseRateFloor));
  return { rate, source: 'ledger', carried, used };
}

/**
 * 把基础率翻译成两个门槛（**唯一一份**）：降权线、抑制线。
 *
 * `gateDecision`（实时）、`suppressReady`（回放）、`gateReport`（面板/周报）都从这里取数，
 * 谁也不许自己乘一次。
 */
export function gatePolicy(stats, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const base = baseReadRate(stats, o);
  const demoteAt = Math.max(number(o.minEvidence), Math.ceil(number(o.expectedReads) / base.rate));
  const suppressAt = Math.max(number(o.suppressMinCarried), Math.ceil(number(o.suppressExpectedReads) / base.rate));
  return { baseRate: base.rate, baseSource: base.source, carriedSamples: base.carried, demoteAt, suppressAt };
}

/** 配置里写了个不认识的值时怎么办：回到默认档，而不是悄悄开或悄悄关。 */
export function normalizeGate(value, fallback = GATE_DEFAULTS.mode) {
  const mode = String(value ?? '').trim().toLowerCase();
  return GATE_MODES.includes(mode) ? mode : fallback;
}

const DAY = 86400000;
const number = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 把账本行汇总成「每篇笔记的履历」。
 *
 * 口径与 `usage.js#summarizeUsage` 的位置级打开率一致：一次 `used` 归到它之前**最近一次**
 * 注入过这条的那一轮 —— 这里是每篇笔记一行的汇总，不需要轮次维度，所以只数次数。
 *
 * @param {object[]} lines 账本行（`readUsage()` 的返回值，任意顺序）
 * @param {{historySuffix?: RegExp}} [options]
 * @returns {Map<string, {carried:number, used:number, opened:number, selfTouch:number,
 *   firstCarriedAt:number, lastCarriedAt:number, lastUsedAt:number, usedAt:number[], openedAt:number[]}>}
 */
export function noteLedgerStats(lines) {
  const stats = new Map();
  const of = (id) => {
    if (!stats.has(id)) {
      stats.set(id, {
        carried: 0,
        used: 0,
        opened: 0,
        selfTouch: 0,
        firstCarriedAt: 0,
        lastCarriedAt: 0,
        lastUsedAt: 0,
        usedAt: [],
        openedAt: [],
      });
    }
    return stats.get(id);
  };
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line !== 'object') continue;
    const at = number(line.ts);
    const kind = String(line.kind ?? '');
    // 携带：`hit` 行的 `ids` 就是这一轮真正注入的顺序（`index.js#record()` 的投影口径）。
    // 老账本里没有 `ids` 的行（极少）跳过 —— 宁少不多。
    if (kind === 'hit' && Array.isArray(line.ids)) {
      for (const id of line.ids) {
        if (typeof id !== 'string' || !id) continue;
        const s = of(id);
        s.carried += 1;
        if (!s.firstCarriedAt || at < s.firstCarriedAt) s.firstCarriedAt = at;
        if (at > s.lastCarriedAt) s.lastCarriedAt = at;
      }
      continue;
    }
    if ((kind === 'used' || kind === 'opened') && typeof line.id === 'string' && line.id) {
      const s = of(line.id);
      if (kind === 'used') {
        s.used += 1;
        s.usedAt.push(at);
        if (at > s.lastUsedAt) s.lastUsedAt = at;
      } else {
        s.opened += 1;
        s.openedAt.push(at);
      }
    }
  }
  return stats;
}

/**
 * 标出「自我触碰」：读完/用完之后紧接着又写它，或者刚写完就读回来。
 *
 * 两个方向都算 —— 判据是「这一读与这一写挨得太近（≤ `selfTouchMs`）」，
 * 谁在前谁在后不重要：模型在同一个话题里翻自己刚写的东西，不能算这篇笔记被独立使用了。
 *
 * @param {Map} stats `noteLedgerStats()` 的结果（就地修改）
 * @param {object[]} auditLines `readAudit()` 的结果（`{ts, file, verdict}`）
 * @param {{selfTouchMs?: number}} [options]
 * @returns {Set<string>} 有自我触碰的笔记 id
 */
export function markSelfTouches(stats, auditLines, options = {}) {
  const window = number(options.selfTouchMs ?? GATE_DEFAULTS.selfTouchMs);
  const touched = new Set();
  if (!(stats instanceof Map) || window <= 0) return touched;
  const writes = new Map(); // id → 写入时间戳数组
  for (const row of Array.isArray(auditLines) ? auditLines : []) {
    if (!row || row.verdict !== 'allow' || typeof row.file !== 'string' || !row.file) continue;
    if (!writes.has(row.file)) writes.set(row.file, []);
    writes.get(row.file).push(number(row.ts));
  }
  for (const [id, s] of stats) {
    const at = writes.get(id);
    if (!at || !at.length) continue;
    const near = (t) => at.some((w) => Math.abs(w - t) <= window);
    for (const t of s.usedAt) {
      if (near(t)) {
        s.selfTouch += 1;
        s.used -= 1;
        touched.add(id);
      }
    }
    for (const t of s.openedAt) {
      if (near(t)) {
        s.selfTouch += 1;
        s.opened -= 1;
        touched.add(id);
      }
    }
  }
  return touched;
}

/**
 * 一篇笔记的置信度：Beta 后验均值 = (used + α) / (carried + α + β)。
 *
 * 为什么不用「打开率」：0/3 与 0/30 的打开率都是 0，但说服力天差地别。后验把样本量
 * 揉进了同一个数里（0/3 → 0.077 仍接近先验，0/30 → 0.026 明显低于先验），
 * 于是「样本不够」这件事不需要额外的特判就自动成立了。
 *
 * @returns {{score:number, evidence:number, tier:'unknown'|'trusted'|'watch'|'ignored', reason:string}}
 */
export function confidenceOf(stat, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const carried = number(stat?.carried);
  const used = number(stat?.used);
  const { alpha, beta } = o.prior ?? GATE_DEFAULTS.prior;
  const score = (used + alpha) / (carried + alpha + beta);
  if (carried < number(o.minEvidence)) {
    return { score, evidence: carried, tier: 'unknown', reason: 'few-samples' };
  }
  if (used === 0) return { score, evidence: carried, tier: 'ignored', reason: 'never-used' };
  if (score >= number(o.trustedAt)) return { score, evidence: carried, tier: 'trusted', reason: 'used-often' };
  return { score, evidence: carried, tier: 'watch', reason: 'some-use' };
}

/**
 * 一篇笔记的「新鲜度」。`kind` 从文件名前缀取（Format v1 的纪律：前缀就是事实类型），
 * 时间取文件 mtime —— 与 `store.js` 读索引时用的是同一个数，不额外做 IO。
 *
 * 没有 mtime（0 / 缺失）时**不判过期**：宁可漏报也不要拿「不知道」当「很旧」。
 */
export function freshness(doc, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const id = String(doc?.id ?? '');
  const kind = NOTE_KINDS.includes(id.split('-')[0]) ? id.split('-')[0] : '';
  const mtime = number(doc?.mtimeMs);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  if (!mtime) return { kind, ageDays: null, stale: false };
  const ageDays = (now - mtime) / DAY;
  return { kind, ageDays, stale: kind === 'project' && ageDays > number(o.staleDays) };
}

/**
 * 抑制判据（**唯一一份**）：证据够多 + 观察够久 + 一次没被用上。
 *
 * 单独导出是因为它有两个调用方：实时门控（`gateDecision`）与账本回放
 * （周报要能回答「当时要是开了 enforce，会拦掉谁、拦对了吗」）。回放自己抄一份阈值，
 * 两份就会在改阈值时分叉，于是「回放说会拦 3 条」与「真开起来拦 5 条」对不上。
 */
export function suppressReady(stat, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const conf = confidenceOf(stat ?? { carried: 0, used: 0 }, o);
  const carried = number(stat?.carried);
  const first = number(stat?.firstCarriedAt);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedDays = first ? (now - first) / DAY : 0;
  // 没带 `policy` 的调用方（回放脚本常常只想问「这一条」）按先验率算门槛 —— 比账本率更保守，
  // 宁可少说一句「会拦掉」也不要凭空多拦。实时路径（`gateDecision`）一定会带上 policy。
  const gate = options.policy ?? gatePolicy(null, o);
  return conf.tier === 'ignored' && carried >= gate.suppressAt && observedDays >= number(o.observeDays);
}

/**
 * 对**一条命中**出裁决。返回 `{action, factor, reason, tier, carried, used}`。
 *
 * 三档的区别只在这一步之后怎么用（`applyGate` 负责）：`shadow` 算完不用，
 * `assist` 用 factor 降权，`enforce` 用 factor=0 移出注入。
 */
export function gateDecision(hit, context, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const id = String(hit?.id ?? '');
  const stat = context?.stats?.get?.(id) ?? null;
  const conf = confidenceOf(stat ?? { carried: 0, used: 0 }, o);
  const fresh = context?.docs?.get?.(id) ? freshness(context.docs.get(id), { ...o, now: context.now }) : null;
  const carried = number(stat?.carried);
  // 门槛只算一次（整批共用）：`gateDecision` 也可被单独调用，所以这里兜一层。
  const policy = context?.policy ?? options.policy ?? gatePolicy(context?.stats, o);

  // 抑制（只有 enforce 档会用）：证据够多 + 观察够久 + 一次没被用上。
  if (suppressReady(stat ?? { carried: 0, used: 0 }, { ...o, now: context.now, policy })) {
    return { action: 'suppress', factor: 0, reason: 'never-used', tier: conf.tier, carried, used: number(stat?.used), confidence: conf.score };
  }
  // 降权：总也用不上，或者该更新却半年没动的 project 笔记。过期只降权（见文件头第 3 条）。
  //
  // 「看着像没用」与「证据够判它没用」是两件事：携带次数够到 `demoteAt`
  // （= 基础率下期望被读过 `expectedReads` 次）才降权；在这之前一律不动，
  // 但把 `insufficient-evidence` 记进账本 —— 面板上「它已经开始可疑了」是可见的。
  if (conf.tier === 'ignored') {
    if (carried < policy.demoteAt) {
      return { action: 'keep', factor: 1, reason: 'insufficient-evidence', tier: conf.tier, carried, used: number(stat?.used), confidence: conf.score };
    }
    return { action: 'demote', factor: number(o.demote), reason: 'never-used', tier: conf.tier, carried, used: number(stat?.used), confidence: conf.score };
  }
  if (fresh?.stale) {
    return {
      action: 'demote',
      factor: number(o.demote),
      reason: 'stale-project',
      tier: conf.tier,
      carried,
      used: number(stat?.used),
      ageDays: fresh.ageDays,
      confidence: conf.score,
    };
  }
  return { action: 'keep', factor: 1, reason: '', tier: conf.tier, carried, used: number(stat?.used), confidence: conf.score };
}

/**
 * 对整批命中应用门控。
 *
 * 顺序很重要：门控跑在**预算分配之前**（`renderPointers()` 之前）—— 先把不值得的剔除，
 * 再把预算分给剩下的，否则被抑制的那条白白占掉一个片段额度。
 *
 * `shadow` 档返回的 `hits` 与输入**逐字段相同**（数组本身也原样返回），
 * 只在 `demoted` / `suppressed` 里说「本来会怎样」。这样「先看它想干什么」是真的没有副作用。
 *
 * @param {object[]} hits 已排序的命中（分数降序）
 * @param {{stats:Map, docs:Map, now:number}} context
 * @param {{mode?:string}} [options]
 */
export function applyGate(hits, context, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const mode = normalizeGate(options.mode);
  const list = Array.isArray(hits) ? hits : [];
  const demoted = [];
  const suppressed = [];
  if (mode === 'off') return { mode, hits: list, demoted, suppressed, ready: [], policy: gatePolicy(context?.stats, o) };
  // 门槛**一批算一次**：同一批命中里每条各自去乘一遍基础率，除了白算，还会因为
  // 「边裁决边改 stats」这种将来可能出现的写法而让同批的两条用上不同的门槛。
  // 调用方可以自己带一份 policy（回放要按「当时」的基础率重算，而不是按账本到今天的总率）。
  const policy = context?.policy ?? options.policy ?? gatePolicy(context?.stats, o);
  const decided = list.map((hit) => ({ hit, verdict: gateDecision(hit, { ...context, policy }, o) }));
  // 「证据已经够到抑制线」的那几条：与档位无关。`assist` 档里它们只被降权，
  // 但记账要留着 —— 否则没人能回答「要是我开 enforce，会拦掉谁、拦对了吗」。
  const ready = decided.filter((d) => d.verdict.action === 'suppress').map((d) => d.hit.id);
  const entryOf = ({ hit, verdict }) => ({ id: hit.id, score: number(hit.score), ...verdict });
  // 账目按**档位真正做了什么**记，不按「证据有多重」记 —— 否则 `assist` 档会把降权
  // 记成抑制，事后回放会以为那几条真的被拦掉了（账本是给未来的自己看的，不能含糊）。
  //
  // `shadow` 一分不改，所以它记的只能是**观察值**：一律进 `demoted`（`wouldSuppress` 标出
  // 「证据已够到抑制线」），`suppressed` 保持空 —— 那个字段的意思是「真被拦掉了」，
  // 只有 `enforce` 档配得上。想看「开了会拦谁」有 `ready`。
  if (mode === 'shadow') {
    for (const d of decided) {
      if (d.verdict.factor === 1) continue;
      demoted.push({ ...entryOf(d), wouldSuppress: d.verdict.action === 'suppress' });
    }
    return { mode, hits: list, demoted, suppressed, ready, policy };
  }
  const kept = [];
  for (const d of decided) {
    const { hit, verdict } = d;
    if (verdict.factor === 1) {
      kept.push(hit);
      continue;
    }
    // **档位决定「证据」怎么落地**：`enforce` 才允许移出注入；`assist` 只降权 ——
    // 哪怕证据已经够到抑制线，也只是往后排（这条笔记仍然看得见）。判据只有一份，
    // 档位只改后果，所以这里不需要第二套阈值。
    if (mode === 'enforce' && verdict.action === 'suppress') {
      suppressed.push(entryOf(d));
      continue;
    }
    demoted.push({ ...entryOf(d), wouldSuppress: verdict.action === 'suppress' });
    kept.push({ ...hit, score: number(hit.score) * number(o.demote), gated: verdict.reason });
  }
  // 与召回主流程同一套排序（分数降序，同分按 id）—— 降权之后「往后排」才真的成立。
  kept.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return { mode, hits: kept, demoted, suppressed, ready, policy };
}

/**
 * 给报告 / 面板用的汇总：真正会被门控盯上的笔记清单（按证据量排序）。
 * `state` 描述的是**现在**（账本 + 库的当下状态），不是历史某一轮。
 */
export function gateReport(stats, docs, options = {}) {
  const o = { ...GATE_DEFAULTS, ...options };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ignored = [];
  const stale = [];
  const policy = gatePolicy(stats, o);
  for (const [id, stat] of stats instanceof Map ? stats : []) {
    const conf = confidenceOf(stat, o);
    if (conf.tier === 'ignored') {
      ignored.push({
        id,
        carried: stat.carried,
        used: stat.used,
        selfTouch: stat.selfTouch,
        confidence: conf.score,
        firstCarriedAt: stat.firstCarriedAt,
        lastCarriedAt: stat.lastCarriedAt,
        // 两条线分开报：面板要说清「已经在降权了」与「还在观察、没动它」的区别，
        // 否则用户看到名单会以为这些条目已经被处理了。
        demoting: number(stat.carried) >= policy.demoteAt,
        readable: number(stat.carried) >= policy.suppressAt,
      });
    }
    const doc = docs?.get?.(id);
    const fresh = doc ? freshness(doc, { ...o, now }) : null;
    if (fresh?.stale) stale.push({ id, ageDays: fresh.ageDays, kind: fresh.kind });
  }
  ignored.sort((a, b) => b.carried - a.carried || String(a.id).localeCompare(String(b.id)));
  stale.sort((a, b) => b.ageDays - a.ageDays || String(a.id).localeCompare(String(b.id)));
  const mode = normalizeGate(options.mode);
  return {
    mode,
    minEvidence: o.minEvidence,
    // 阈值整份透出：面板与周报都要说「这套尺子现在怎么算」，各自抄一份迟早分叉
    // （抄错的那份会让用户按错的数字做决定）。多出来的几十字节换的是口径唯一。
    policy: {
      mode,
      baseRate: policy.baseRate,
      baseSource: policy.baseSource,
      carriedSamples: policy.carriedSamples,
      demoteAt: policy.demoteAt,
      suppressAt: policy.suppressAt,
      expectedReads: o.expectedReads,
      suppressExpectedReads: o.suppressExpectedReads,
      minEvidence: o.minEvidence,
      demote: o.demote,
      suppressMinCarried: o.suppressMinCarried,
      observeDays: o.observeDays,
      staleDays: o.staleDays,
      selfTouchMs: o.selfTouchMs,
      trustedAt: o.trustedAt,
    },
    counts: {
      notes: stats instanceof Map ? stats.size : 0,
      ignored: ignored.length,
      stale: stale.length,
    },
    ignored,
    stale,
  };
}
