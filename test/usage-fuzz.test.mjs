/**
 * 召回账本（usage.js）的随机化健壮性测试。
 *
 * 为什么要有这个文件：线上喂给 `summarizeUsage` / `minScoreCurve` 的从来不是教科书输入 ——
 * 是半年积累的 JSONL，里面混着升级前的老行（没有 scores）、写坏的行、被截断的行、
 * 同一秒落盘的行、被反复 read 的同一篇。这里用**确定性**伪随机（自写 LCG，不用
 * Math.random）成批造这种输入，然后钉住四类真实不变量：
 *
 *   1. 账目恒等式：pointers / injectRounds / scopes / positions / notes 之间必须自洽
 *      （不是「没抛异常」，是把汇总结果与独立重算的期望逐项对比）；
 *   2. 分位数单调有界：p10 ≤ 中位 ≤ p90，min ≤ 中位 ≤ p90 ≤ max，且全部落在观测值里；
 *   3. 曲线自洽：每个门槛 `injected + cut === n`、cut 与 lost 随门槛非降、freeCap 就是
 *      「lost === 0 且 cut > 0」里最后那一点、全砍那一行永远在；
 *   4. 判据永远是人话：n = 0 时返回字符串（不是抛异常），真数据里不会印出 NaN/undefined。
 *
 * 两组数据刻意分开：
 *   - **脏数据**（`dirtyLines`）随便乱来，只断言对任意输入都成立的不变量
 *     （同一篇可以被 used 多次 ⇒ used 可能大于 pointers，那是账本语义，不是 bug）；
 *   - **纪律数据**（`disciplinedLog`）按真实写盘纪律生成：注入的 id 全局唯一、一次注入
 *     最多一次 used ⇒ 于是可以把 positions / scopes / 曲线逐点与生成时的地面真值对账。
 *
 * 种子固定：第 run 轮的种子 = `SEED + run * 7919`，断言消息里都带着它 —— 复制出来
 * `lcg(那个数)` 就能复现同一批数据。全部落在 mkdtemp，不联网、不碰真实记忆库。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  USAGE_FILE,
  appendUsage,
  budgetVerdict,
  minScoreCurve,
  readUsage,
  reasonVerdict,
  scoreCurveVerdict,
  summarizeUsage,
  usageVerdict,
} from '../usage.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'engramory-'));
const withDir = (fn) => {
  const dir = tmp();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── 确定性伪随机 ─────────────────────────────────────────────────────────

/** 全局种子。改它 = 换一批数据；不改 = 永远可复现。 */
const SEED = 20261016;
const RUNS = 8;
const seedOf = (run) => (SEED + Math.imul(run, 7919)) >>> 0;

/** 32 位 LCG（Numerical Recipes 常数），返回 [0,1)。不用 Math.random：随机化测试必须可复现。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (rand, p) => rand() < p;

/** 与 usage.js 同一句定义：`ids` 里那些 String() 之后仍为真的元素才是指针。 */
const idsOf = (line) => (Array.isArray(line?.ids) ? line.ids.map(String).filter(Boolean) : []);
/** 同一套 nearest-rank 取低分位数（全仓共用），用来独立重算中位/p90。 */
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0);
const round3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : 0);
const sortedNums = (arr) => [...arr].sort((a, b) => a - b);

/** 递归收集所有 number 叶子：面板/判据不该拿到 NaN/Infinity。 */
function numericLeaves(value, path = '$', out = []) {
  if (typeof value === 'number') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numericLeaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) numericLeaves(v, `${path}.${k}`, out);
  return out;
}

// ── 脏数据生成器 ─────────────────────────────────────────────────────────

const KINDS = ['hit', 'hit', 'sediment', 'skip', 'empty', 'used', 'opened', 'deny', 'deny-error', 'wat', '', null, 42, 'HIT'];
const ID_POOL = ['a.md', 'b.md', 'a.md', 'c.md', 'd.md', 0, 1, null, undefined, '', { }, 'x.txt', 'b.md'];
const SCORE_POOL = [9, 6, 4.5, 0, -1.5, 'NaN', null, '3', NaN, 1e9, 0.001];
const REASON_POOL = ['chitchat', 'too-short', 'duplicate', 'no-hits', 'below-min-score', '', 7, null, '原因码-未知', 'chitchat'];
const QUERY_POOL = ['继续', '', null, 42, '代理节点怎么部署', 'x'.repeat(40)];

/**
 * 240 行随机脏日志：kind / 时间戳 / ids / scores / scope / reason / 预算字段全部乱来。
 * 时间戳故意乱序、重复、为 0、为负、在未来；ids 与 scores 长度不匹配、混入非数字与缺字段。
 */
function dirtyLines(rand, n = 240) {
  const base = 1_700_000_000_000;
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const line = {
      ts: pick(rand, [base + int(rand, -86_400_000, 86_400_000), base, int(rand, -5_000, 0), 0, base + 4e9]),
      kind: pick(rand, KINDS),
    };
    if (chance(rand, 0.35)) line.scope = pick(rand, ['main', 'subagent', 'unknown', 'MAIN', null, 7]);
    if (chance(rand, 0.75)) line.ids = Array.from({ length: int(rand, 0, 6) }, () => pick(rand, ID_POOL));
    if (chance(rand, 0.5)) line.scores = Array.from({ length: int(rand, 0, 6) }, () => pick(rand, SCORE_POOL));
    if (chance(rand, 0.3)) line.reason = pick(rand, REASON_POOL);
    if (chance(rand, 0.25)) line.query = pick(rand, QUERY_POOL);
    if (chance(rand, 0.2)) line.id = pick(rand, ID_POOL);
    if (chance(rand, 0.2)) line.collapsed = pick(rand, [0, 1, 3, '2', -1, null, NaN]);
    if (chance(rand, 0.2)) line.dropped = pick(rand, [0, 2, '1', -4, null, 1e3]);
    if (chance(rand, 0.2)) line.lagMs = pick(rand, [0, 1200, -1, '5', null, NaN]);
    if (chance(rand, 0.1)) line.bytes = pick(rand, [0, 1234, '999', null, -1]);
    lines.push(line);
  }
  return lines;
}

/** 两种形态：内存对象，以及「盘上读回来」（undefined 字段消失、NaN 变 null）。 */
const variantsOf = (lines) => [
  ['内存对象', lines],
  ['JSON 往返', JSON.parse(JSON.stringify(lines))],
];

// ── 独立重算 ─────────────────────────────────────────────────────────────

/**
 * 按「注入 = 有 ids 的行」这条定义把汇总结果重算一遍（与实现同一定义、不同一实现）。
 * 纪律数据那一组不用它：那组的期望值来自生成器本身。
 */
function expectedCounts(lines) {
  const out = {
    injectRounds: 0, pointers: 0, scoreRows: 0, used: 0, coldOpens: 0, lagSamples: 0,
    skip: 0, empty: 0, sediment: 0, deny: 0,
    collapsed: 0, collapsedRounds: 0, dropped: 0, droppedRounds: 0, truncatedRounds: 0,
    roundSizes: [], topScores: [], spreads: [], tses: [], notesById: new Map(),
    positionInjected: [0, 0, 0, 0, 0, 0, 0, 0], // 缺省 positions=8：位置账只数每轮 ids 的**前 8 条**，不是「整轮不算」
    scopePointers: { main: 0, subagent: 0, unknown: 0 },
    scopeInjectRounds: { main: 0, subagent: 0, unknown: 0 },
  };
  for (const line of lines) {
    const ts = Number(line?.ts ?? 0);
    if (ts) out.tses.push(ts);
    const kind = String(line?.kind ?? '');
    if (kind === 'skip') out.skip += 1;
    else if (kind === 'empty') out.empty += 1;
    else if (kind === 'sediment') out.sediment += 1;
    else if (kind === 'deny' || kind === 'deny-error') out.deny += 1;

    const ids = idsOf(line);
    if (ids.length) {
      out.injectRounds += 1;
      out.pointers += ids.length;
      out.roundSizes.push(ids.length);
      ids.forEach((_, i) => { if (i < out.positionInjected.length) out.positionInjected[i] += 1; });
      const scope = line?.scope === 'main' || line?.scope === 'subagent' ? line.scope : 'unknown';
      out.scopeInjectRounds[scope] += 1;
      out.scopePointers[scope] += ids.length;
      const scores = Array.isArray(line?.scores) ? line.scores.map(Number).filter(Number.isFinite) : [];
      if (scores.length) {
        out.scoreRows += 1;
        out.topScores.push(scores[0]);
        if (scores.length > 1) out.spreads.push(scores[0] - scores[scores.length - 1]);
      }
      const collapsed = Math.max(0, Number(line?.collapsed) || 0);
      const dropped = Math.max(0, Number(line?.dropped) || 0);
      if (collapsed > 0) { out.collapsed += collapsed; out.collapsedRounds += 1; }
      if (dropped > 0) { out.dropped += dropped; out.droppedRounds += 1; }
      if (collapsed > 0 || dropped > 0) out.truncatedRounds += 1;
      for (const id of ids) out.notesById.set(id, (out.notesById.get(id) ?? 0) + 1);
    }
    if (kind === 'used' && line?.id) {
      out.used += 1;
      const lag = Number(line?.lagMs);
      if (Number.isFinite(lag) && lag >= 0) out.lagSamples += 1;
    } else if (kind === 'opened' && line?.id) out.coldOpens += 1;
  }
  out.firstAt = out.tses.length ? Math.min(...out.tses) : 0;
  out.lastAt = out.tses.length ? Math.max(...out.tses) : 0;
  return out;
}

/** 曲线层的分轮口径：能配对的 / 老日志（没 scores）/ 对不上号的。 */
function expectedCurve(lines) {
  let legacy = 0;
  let unaligned = 0;
  let rounds = 0;
  let n = 0;
  for (const line of lines) {
    if (String(line?.kind ?? '') === 'used' && line?.id) continue;
    const ids = idsOf(line);
    if (!ids.length) continue;
    const scores = Array.isArray(line?.scores) ? line.scores.map(Number) : null;
    if (!scores || !scores.length) { legacy += 1; continue; }
    if (scores.length !== ids.length || !scores.every(Number.isFinite)) { unaligned += 1; continue; }
    rounds += 1;
    n += ids.length;
  }
  return { legacy, unaligned, rounds, n };
}

// ── 纪律数据生成器（期望值来自生成过程，不是汇总层） ─────────────────────

/** 三位小数池：显示值（round3）与过滤值完全一致，曲线才能逐点对账。 */
const SCORES_3DP = [9.001, 6.5, 4.25, 3.333, 1.5, 0.5, 0.001, 12.75, 7.125, 2.25];

/**
 * 43 行「按纪律写出来」的日志（40 轮注入 + 若干 used）：
 *   - 每轮注入 1~6 篇，id 全局唯一（一篇只可能被注入一次，因此最多被 used 一次）；
 *   - used 行故意带上（可能相反的）scope：归属必须跟着「命中它的那次注入」走；
 *   - ts 单调推进，used 的时刻 = 注入时刻 + lag（lag ≥ 0），所以归属一定找得到。
 * 返回的 positions / scopes / pairs 就是地面真值。
 */
function disciplinedLog(rand, n = 40) {
  const lines = [];
  const positions = Array.from({ length: 6 }, (_, i) => ({ position: i + 1, injected: 0, opened: 0 }));
  const scopes = {
    main: { injectRounds: 0, pointers: 0, used: 0 },
    subagent: { injectRounds: 0, pointers: 0, used: 0 },
    unknown: { injectRounds: 0, pointers: 0, used: 0 },
  };
  const pairs = [];
  const openedIds = new Set();
  let pointers = 0;
  let used = 0;
  let ts = 1_700_000_000_000;
  for (let r = 0; r < n; r += 1) {
    ts += int(rand, 1, 5_000);
    const scope = pick(rand, ['main', 'subagent', undefined]);
    const key = scope === 'main' || scope === 'subagent' ? scope : 'unknown';
    const len = int(rand, 1, 6);
    const ids = Array.from({ length: len }, (_, i) => `r${r}-p${i}.md`);
    const scores = ids.map(() => pick(rand, SCORES_3DP));
    lines.push({ ts, kind: pick(rand, ['hit', 'hit', 'hit', 'sediment']), ...(scope ? { scope } : {}), ids, scores });

    scopes[key].injectRounds += 1;
    scopes[key].pointers += len;
    pointers += len;
    ids.forEach((id, i) => {
      if (i < positions.length) positions[i].injected += 1;
      pairs.push({ id, score: scores[i], opened: false });
    });

    if (chance(rand, 0.45)) {
      const p = int(rand, 0, len - 1);
      const lag = int(rand, 0, 90_000);
      lines.push({ ts: ts + lag, kind: 'used', id: ids[p], via: pick(rand, ['read', 'edit']), lagMs: lag, scope: pick(rand, ['main', 'subagent', 'unknown']) });
      used += 1;
      scopes[key].used += 1; // 归属 = 注入那一轮的 scope，与 used 行自己的 scope 无关
      if (p < positions.length) positions[p].opened += 1;
      pairs.find((q) => q.id === ids[p]).opened = true;
      openedIds.add(ids[p]);
    }
    ts += 1_000; // 下一轮一定在这轮之后
  }
  const withRate = Object.fromEntries(
    Object.entries(scopes).map(([k, v]) => [k, { ...v, openRate: v.pointers ? v.used / v.pointers : 0 }]),
  );
  return { lines, positions, scopes: withRate, pointers, used, pairs, openedIds, rounds: n };
}

// ── 脏数据 fuzz ──────────────────────────────────────────────────────────

test('脏数据 fuzz：注入/指针/分数/分区的账目恒等式（8 轮 × 240 行 × 两种形态）', () => {
  let sawPointers = 0;
  let sawUsed = 0;
  let sawUsedCounted = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const lines = dirtyLines(lcg(seed));
    for (const [form, variant] of variantsOf(lines)) {
      const at = `run=${run} seed=${seed} 形态=${form}`;
      const want = expectedCounts(variant);
      const s = summarizeUsage(variant);
      sawPointers += s.pointers;
      sawUsed += s.used;

      assert.equal(s.injectRounds, want.injectRounds, `${at}：有 ids 的行才算一轮注入`);
      assert.equal(s.pointers, want.pointers, `${at}：指针数 = 各轮 ids 长度之和`);
      assert.ok(s.pointers >= s.injectRounds, `${at}：每轮至少一条指针`);
      assert.equal(s.used, want.used, `${at}：used 行 = kind === 'used' 且有 id`);
      assert.equal(s.coldOpens, want.coldOpens, at);
      // openRate 的分子是「按（轮 + 指针）去重后」的打开条数，不是原始 used 行数：同一轮里同一篇被
      // read 完再 edit 会落两条 used，拿 used 直接相除能算出 150%（判据还会据此说「窗口可以放宽」，
      // 结论正好反了）。这个去重口径与 minScoreCurve 的「每轮一个 Set」是同一套。
      assert.ok(s.usedCounted <= s.used, `${at}：去重后的打开条数 ≤ 原始 used 行数`);
      assert.ok(s.usedCounted <= s.pointers, `${at}：usedCounted=${s.usedCounted} 不该超过指针数 ${s.pointers}`);
      assert.equal(s.openRate, s.pointers ? s.usedCounted / s.pointers : 0, `${at}：openRate = usedCounted / pointers（pointers 为 0 时是 0）`);
      assert.ok(s.openRate <= 1, `${at}：去重之后打开率不可能超过 1（旧口径会算出 1.5）`);
      sawUsedCounted += s.usedCounted;
      assert.equal(s.firstAt, want.firstAt, `${at}：firstAt = 最小非零 ts`);
      assert.equal(s.lastAt, want.lastAt, `${at}：lastAt = 最大非零 ts`);
      assert.ok(s.firstAt <= s.lastAt, at);

      // 笔记级：injected 之和必须回到指针数，且按 injected 降序
      assert.equal(s.uniqueNotes, want.notesById.size, at);
      assert.equal(s.notes.length, s.uniqueNotes, at);
      assert.equal(s.notes.reduce((sum, note) => sum + note.injected, 0), s.pointers, `${at}：笔记级 injected 之和 = 指针数`);
      assert.ok(s.notes.every((note) => note.injected >= 1 && note.opened >= 0 && note.opened <= s.used), at);
      assert.ok(s.notes.every((note, i, arr) => i === 0 || arr[i - 1].injected >= note.injected), `${at}：notes 按 injected 降序`);
      assert.ok(s.notes.every((note) => typeof note.id === 'string'), `${at}：笔记 id 一律是字符串`);

      // 只统计前 8 个位置
      assert.deepEqual(s.positions.map((p) => p.injected), want.positionInjected, at);
      assert.ok(s.positions.reduce((sum, p) => sum + p.injected, 0) <= s.pointers, `${at}：位置级 injected 之和 ≤ 指针数`);
      assert.ok(s.positions.reduce((sum, p) => sum + p.opened, 0) <= s.used, `${at}：一次 used 最多落在一个位置上`);
      assert.deepEqual(s.positions.map((p) => p.position), [1, 2, 3, 4, 5, 6, 7, 8], at);

      // 分区：三个桶之和必须回到总数，不是 main/subagent 的都进 unknown
      assert.equal(s.scopes.main.pointers + s.scopes.subagent.pointers + s.scopes.unknown.pointers, s.pointers, at);
      assert.equal(s.scopes.unknown.pointers, s.pointers - s.scopes.main.pointers - s.scopes.subagent.pointers, `${at}：不是 main/subagent 的都进 unknown`);
      assert.equal(s.scopes.main.injectRounds + s.scopes.subagent.injectRounds + s.scopes.unknown.injectRounds, s.injectRounds, at);
      assert.ok(s.scopes.main.used + s.scopes.subagent.used + s.scopes.unknown.used <= s.used, `${at}：没有归属的 used 不进任何桶`);
      for (const bucket of Object.values(s.scopes)) {
        assert.equal(bucket.openRate, bucket.pointers ? bucket.used / bucket.pointers : 0, at);
      }

      // 分数统计的行数上限：没有 ids 的行不参与
      assert.equal(s.scoreStats.n, want.scoreRows, at);
      assert.ok(s.scoreStats.n <= s.injectRounds, `${at}：注入分的样本数不会超过注入轮数`);

      // 面板/判据不该拿到 NaN/Infinity
      for (const [path, value] of numericLeaves(s)) {
        assert.ok(Number.isFinite(value), `${at}：${path} 是 ${value}`);
      }
    }
  }
  // 防空转：这组数据必须真的产出过注入与打开，否则上面每一条都是空断言
  assert.ok(sawPointers > 0 && sawUsed > 0, `8 轮合计 pointers=${sawPointers} used=${sawUsed}`);
  assert.ok(sawUsedCounted > 0, `8 轮合计有归属的打开 usedCounted=${sawUsedCounted}：否则上面那条「去重后 ≤ used」是空断言`);
});

test('脏数据 fuzz：原因码、预算截断、打开延迟的计数恒等式', () => {
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const lines = dirtyLines(lcg(seed));
    for (const [form, variant] of variantsOf(lines)) {
      const at = `run=${run} seed=${seed} 形态=${form}`;
      const want = expectedCounts(variant);
      const s = summarizeUsage(variant);
      const sum = (obj) => Object.values(obj).reduce((acc, n) => acc + n, 0);

      assert.equal(s.skipRounds, want.skip, at);
      assert.equal(s.dedupeRounds, s.skipRounds, `${at}：skip 同时记 skipRounds 与 dedupeRounds`);
      assert.equal(s.zeroRounds, want.empty, at);
      assert.equal(s.emptyRounds, want.empty, at);
      assert.equal(s.sedimentRounds, want.sediment, at);
      assert.equal(s.denyRounds, want.deny, `${at}：deny 与 deny-error 都算拒绝`);
      assert.equal(sum(s.skipReasons), s.skipRounds, `${at}：原因码计数之和 = skip 轮数`);
      assert.equal(sum(s.emptyReasons), s.emptyRounds, at);
      assert.ok(Object.keys(s.skipReasons).every((key) => typeof key === 'string'), at);

      assert.equal(s.collapsed, want.collapsed, at);
      assert.equal(s.collapsedRounds, want.collapsedRounds, at);
      assert.equal(s.dropped, want.dropped, at);
      assert.equal(s.droppedRounds, want.droppedRounds, at);
      assert.equal(s.truncatedRounds, want.truncatedRounds, at);
      assert.ok(s.truncatedRounds <= s.injectRounds, `${at}：被截断的轮数是注入轮的子集`);
      assert.ok(s.collapsedRounds <= s.injectRounds && s.droppedRounds <= s.injectRounds, at);

      assert.equal(s.openLag.n, want.lagSamples, `${at}：只有 lagMs 为非负有限数的 used 行进样本`);
      assert.ok(s.openLag.n <= s.used, at);
      assert.ok(s.openLag.median <= s.openLag.p90, at);
      assert.ok(s.openLag.median >= 0 && s.openLag.p90 >= 0, `${at}：负 lagMs 不进样本，分位数不该为负`);

      // toCounts 的排序契约：先按次数降序，次数相同按 key 升序。
      // 例外来自 JS 语言本身（不是 usage.js 的 bug）：`'7'` 这种「数组下标样式」的键在对象里
      // 永远排在最前、且按数值升序 —— 随机脏数据里混进数字 reason 就能看到这个现象。
      for (const map of [s.skipReasons, s.emptyReasons]) {
        const isIndexKey = (key) => String(Number(key)) === key && Number(key) >= 0 && Number(key) < 2 ** 32 - 1;
        const named = Object.entries(map).filter(([key]) => !isIndexKey(key));
        assert.deepEqual(named, [...named].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))), at);
        const indexed = Object.keys(map).filter(isIndexKey).map(Number);
        assert.deepEqual(indexed, sortedNums(indexed), `${at}：数组下标样式的键被 JS 对象按数值排在前面`);
      }
    }
  }
});

test('脏数据 fuzz：分位数单调有界，perRound 与 maxPointers 口径一致', () => {
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const rand = lcg(seed);
    const lines = dirtyLines(rand);
    const window = int(rand, 1, 6);
    for (const [form, variant] of variantsOf(lines)) {
      const at = `run=${run} seed=${seed} 形态=${form} 窗口=${window}`;
      const want = expectedCounts(variant);
      const s = summarizeUsage(variant, { maxPointers: window });

      const sizes = sortedNums(want.roundSizes);
      assert.equal(s.perRound.windowLimit, window, at);
      assert.equal(s.perRound.min, sizes[0] ?? 0, at);
      assert.equal(s.perRound.median, quantile(sizes, 0.5), at);
      assert.equal(s.perRound.p90, quantile(sizes, 0.9), at);
      assert.equal(s.perRound.max, sizes.length ? sizes[sizes.length - 1] : 0, at);
      assert.ok(s.perRound.min <= s.perRound.median && s.perRound.median <= s.perRound.p90 && s.perRound.p90 <= s.perRound.max,
        `${at}：min ≤ 中位 ≤ p90 ≤ max`);
      assert.equal(s.perRound.fullRounds, want.roundSizes.filter((n) => n >= window).length, `${at}：用满窗口的轮数`);
      assert.ok(s.perRound.fullRounds <= s.injectRounds, at);

      // 不给 maxPointers 就不猜别人的窗口
      const bare = summarizeUsage(variant);
      assert.equal(bare.perRound.windowLimit, 0, at);
      assert.equal(bare.perRound.fullRounds, 0, at);
      assert.deepEqual(
        [bare.perRound.min, bare.perRound.median, bare.perRound.p90, bare.perRound.max],
        [s.perRound.min, s.perRound.median, s.perRound.p90, s.perRound.max],
        `${at}：窗口上限不影响每轮条数的分布`,
      );

      // 注入分的分位数：p10 ≤ 中位 ≤ p90，且都在观测值里
      const tops = sortedNums(want.topScores);
      const spreads = sortedNums(want.spreads);
      assert.deepEqual(s.scoreStats, {
        n: tops.length,
        median: round3(quantile(tops, 0.5)),
        p10: round3(quantile(tops, 0.1)),
        p90: round3(quantile(tops, 0.9)),
        spreadMedian: round3(quantile(spreads, 0.5)),
      }, at);
      assert.ok(s.scoreStats.p10 <= s.scoreStats.median && s.scoreStats.median <= s.scoreStats.p90, `${at}：p10 ≤ 中位 ≤ p90`);
      if (tops.length) {
        assert.ok(s.scoreStats.p10 >= tops[0] && s.scoreStats.p90 <= tops[tops.length - 1], `${at}：分位数落在观测区间内`);
      }
    }
  }
});

test('脏数据 fuzz：minScore 曲线的记账恒等式、单调性与零代价上限', () => {
  let sawLegacy = false;
  let sawUnaligned = false;
  let sawCurve = false;
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const rand = lcg(seed);
    const lines = dirtyLines(rand);
    const steps = int(rand, 3, 20);
    for (const [form, variant] of variantsOf(lines)) {
      const at = `run=${run} seed=${seed} 形态=${form} steps=${steps}`;
      const want = expectedCurve(variant);
      const curve = minScoreCurve(variant, { steps });
      sawLegacy = sawLegacy || want.legacy > 0;
      sawUnaligned = sawUnaligned || want.unaligned > 0;
      sawCurve = sawCurve || curve.n > 0;

      assert.equal(curve.legacy, want.legacy, `${at}：没有 scores 的老行只进 legacy 计数`);
      assert.equal(curve.unaligned, want.unaligned, `${at}：scores 与 ids 对不上号的轮只进 unaligned 计数`);
      assert.equal(curve.rounds, want.rounds, at);
      assert.equal(curve.n, want.n, `${at}：曲线上的配对总数`);
      assert.ok(curve.opened >= 0 && curve.opened <= curve.n, at);

      assert.equal(curve.points.length === 0, curve.n === 0, `${at}：有配对才有门槛网格`);
      assert.ok(curve.points.length <= steps + 1, at);
      let prev = null;
      for (const point of curve.points) {
        assert.equal(point.injected + point.cut, curve.n, `${at}：留下的 + 砍掉的 = 全部配对`);
        assert.ok(point.injected >= 0 && point.cut >= 0, at);
        assert.ok(point.lost <= point.cut, `${at}：丢掉的必然是被砍掉的那一部分`);
        assert.ok(point.lost <= curve.opened, `${at}：丢掉的不会超过被打开过的总数`);
        assert.ok(point.cutRate >= 0 && point.cutRate <= 1, at);
        assert.equal(point.cutRate, curve.n ? round3(point.cut / curve.n) : 0, at);
        if (prev) {
          assert.ok(point.minScore >= prev.minScore, `${at}：门槛按升序给出（round3 之后可能显示成同一个值）`);
          assert.ok(point.cut >= prev.cut, `${at}：抬门槛只会砍得更多`);
          assert.ok(point.lost >= prev.lost, `${at}：lost 单调不减`);
          assert.ok(point.injected <= prev.injected, at);
        }
        prev = point;
      }

      const free = curve.points.filter((p) => p.lost === 0 && p.cut > 0);
      assert.deepEqual(curve.freeCap, free.length ? free[free.length - 1] : null,
        `${at}：零代价上限 = 最后一个「砍得掉又不丢」的门槛`);
      assert.equal(curve.note === '', curve.opened >= 5, `${at}：样本不足时才留那句人话`);

      if (curve.n) {
        const last = curve.points.at(-1);
        assert.equal(last.injected, 0, `${at}：网格末尾永远有「全砍」那一行（最高分 + 0.001）`);
        assert.equal(last.cut, curve.n, at);
        assert.equal(last.lost, curve.opened, at);
      }
    }
  }
  // 防空转：老日志、对不上号、能配对这三种形态都要被这组数据覆盖到
  assert.ok(sawLegacy && sawUnaligned && sawCurve, `覆盖 legacy=${sawLegacy} unaligned=${sawUnaligned} 曲线=${sawCurve}`);
});

test('脏数据 fuzz：四句判据永远是人话（非空字符串，不印 NaN/undefined）', () => {
  const textsOf = (summary) => [
    usageVerdict(summary),
    budgetVerdict(summary),
    reasonVerdict(summary),
    scoreCurveVerdict(summary.scoreCurve),
  ];
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const rand = lcg(seed);
    const lines = dirtyLines(rand);
    const window = int(rand, 1, 6);
    for (const [form, variant] of variantsOf(lines)) {
      const at = `run=${run} seed=${seed} 形态=${form} 窗口=${window}`;
      const summary = summarizeUsage(variant, { maxPointers: window });
      const texts = textsOf(summary);
      assert.equal(texts.length, 4);
      for (const text of texts) {
        assert.equal(typeof text, 'string', at);
        assert.ok(text.length > 0, at);
        assert.doesNotMatch(text, /NaN|undefined|Infinity/, `${at}：判据里印出了脏值 → ${text}`);
        assert.doesNotMatch(text, /\[object/, at);
      }
    }
  }

  // n = 0 / 空输入：也要给人话，不是抛异常，也不是 NaN
  for (const empty of [[], [null, undefined, {}], [{}], [null], undefined]) {
    const summary = summarizeUsage(empty);
    assert.equal(summary.pointers, 0);
    for (const text of textsOf(summary)) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /NaN|undefined/);
    }
  }
});

// ── 纪律数据 fuzz：期望值来自生成器 ──────────────────────────────────────

test('纪律数据 fuzz：位置级归属、分区账目、代价曲线逐点对账（used ≤ pointers）', () => {
  for (let run = 0; run < RUNS; run += 1) {
    const seed = seedOf(run);
    const truth = disciplinedLog(lcg(seed));
    const at = `run=${run} seed=${seed}`;
    const s = summarizeUsage(truth.lines, { positions: 6 });

    assert.equal(s.injectRounds, truth.rounds, at);
    assert.equal(s.pointers, truth.pointers, at);
    assert.equal(s.used, truth.used, at);
    assert.ok(s.used <= s.pointers, `${at}：一次注入最多贡献一次 used ⇒ used 不会超过 pointers`);
    assert.equal(s.openRate, s.used / s.pointers, at);
    assert.ok(s.openRate >= 0 && s.openRate <= 1, `${at}：openRate 必须落在 [0,1]`);
    assert.deepEqual(s.positions, truth.positions, `${at}：位置级 injected/opened 与生成时一致`);
    assert.deepEqual(s.scopes, truth.scopes, `${at}：分区账目（used 归到「命中它的那次注入」的 scope）`);
    assert.equal(s.scopes.main.used + s.scopes.subagent.used + s.scopes.unknown.used, s.used, `${at}：每条 used 都有归属`);
    assert.ok(s.scopes.main.used <= s.scopes.main.pointers && s.scopes.subagent.used <= s.scopes.subagent.pointers, at);
    assert.ok(s.positions.reduce((sum, p) => sum + p.opened, 0) <= s.pointers, `${at}：位置级 opened 之和 ≤ 指针数`);

    assert.equal(s.uniqueNotes, truth.pointers, `${at}：id 全局唯一 ⇒ 笔记数 = 指针数`);
    assert.equal(s.neverOpened.length, Math.min(truth.pointers - truth.used, 12), at);
    for (const note of s.notes) {
      assert.equal(note.injected, 1, at);
      assert.equal(note.opened, truth.openedIds.has(note.id) ? 1 : 0, `${at}：${note.id} 的打开次数`);
    }
    assert.ok(s.neverOpened.every((note) => note.opened === 0), at);

    // 曲线：每一对的分数与「有没有被打开」都是生成时就知道的 ⇒ 逐点验算
    const curve = minScoreCurve(truth.lines, { positions: 6 });
    assert.equal(curve.n, truth.pairs.length, at);
    assert.equal(curve.opened, truth.used, at);
    assert.equal(curve.legacy, 0, at);
    assert.equal(curve.unaligned, 0, at);
    assert.equal(curve.rounds, truth.rounds, at);
    assert.ok(curve.points.length > 0, at);
    for (const point of curve.points) {
      const kept = truth.pairs.filter((pair) => pair.score >= point.minScore);
      assert.equal(point.injected, kept.length, `${at}：门槛 ${point.minScore} 留下的条数`);
      assert.equal(point.cut, curve.n - kept.length, at);
      assert.equal(point.lost, truth.pairs.filter((pair) => pair.opened && pair.score < point.minScore).length, `${at}：门槛 ${point.minScore} 丢掉的条数`);
    }
  }
});

// ── 定向脏数据用例 ───────────────────────────────────────────────────────

test('scores 与 ids 长度不一致：汇总层只看首分，曲线层整轮排除', () => {
  const lines = [
    { ts: 1, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'], scores: [9, 5] },
    { ts: 2, kind: 'hit', ids: ['d.md', 'e.md'], scores: [4, 3, 2, 1] },
    { ts: 3, kind: 'hit', ids: ['f.md'], scores: ['x'] },
  ];
  const s = summarizeUsage(lines);
  assert.equal(s.pointers, 6);
  assert.equal(s.scoreStats.n, 2, '汇总层不校验对齐：只看 scores 过滤后的第一个有限数');
  assert.equal(s.scoreStats.median, 4, '首分是 9 与 4 ⇒ 中位取低 = 4');

  const curve = minScoreCurve(lines);
  assert.equal(curve.unaligned, 3, '对不上号的轮一律排除');
  assert.equal(curve.rounds, 0);
  assert.equal(curve.n, 0);
  assert.deepEqual(curve.points, []);
  assert.equal(curve.freeCap, null);
  assert.equal(curve.opened, 0);
  assert.match(scoreCurveVerdict(curve), /还没有能校准 minScore 的日志/);

  // scores 里有非数字 ⇒ 整轮 unaligned（注意 score 先过 Number()：null → 0 是「合法」的 0 分）
  const bad = minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [7, 'x'] }]);
  assert.equal(bad.unaligned, 1);
  assert.equal(bad.n, 0);
  // 为什么这里 0 才对：scores 在落盘前已经过 Number.isFinite 过滤（index.js:362），插件自己写不出 null 分，
  // null 只可能来自手改或半截文件；而它经 Number() 就是一个合法的 0 分，长度也对得上，不存在「静默少算」。
  // 真·非数字（NaN，JSON 往返之前）仍然算 unaligned —— 上面 'x' 那条钉的就是这个。
  const nullish = minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [7, null] }]);
  assert.equal(nullish.unaligned, 0, 'Number(null) === 0 是有限数 ⇒ 这轮算「对得上」');
  assert.equal(nullish.n, 2);
  assert.deepEqual(nullish.points.map((p) => p.minScore), [0, 7, 7.001], 'null 分被当成 0 分参与选门槛');
  // scores 是空数组 / 不是数组 ⇒ legacy（老日志），不是 unaligned
  assert.equal(minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md'], scores: [] }]).legacy, 1);
  assert.equal(minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md'], scores: '9' }]).legacy, 1);
});

test('同一 ts 的多行：按文件顺序稳定排列，归属给最后那一次注入', () => {
  const lines = [
    { ts: 5, kind: 'hit', ids: ['a.md', 'b.md'] },
    { ts: 5, kind: 'hit', ids: ['c.md', 'a.md'] }, // 同一时刻的第二次注入：稳定排序下它在后面
    { ts: 6, kind: 'used', id: 'a.md', via: 'read' },
  ];
  const s = summarizeUsage(lines);
  assert.equal(s.injectRounds, 2);
  assert.equal(s.pointers, 4);
  assert.equal(s.used, 1);
  assert.equal(s.positions[0].opened, 0, '第 1 位的 a.md 不该被算账');
  assert.equal(s.positions[1].opened, 1, '归属给同一 ts 里后出现的那一轮');
  assert.equal(s.openRate, 0.25);

  // 时间倒序的文件与正序文件必须给出同一份账
  const forward = [
    { ts: 10, kind: 'hit', ids: ['a.md', 'b.md'], scores: [9, 5], scope: 'main' },
    { ts: 20, kind: 'used', id: 'b.md', via: 'read', lagMs: 10 },
    { ts: 30, kind: 'hit', ids: ['c.md'], scores: [3], collapsed: 1 },
    { ts: 40, kind: 'empty', reason: 'no-hits' },
    { ts: 50, kind: 'hit', ids: ['c.md', 'd.md'], scores: [8, 2], scope: 'subagent' },
    { ts: 60, kind: 'used', id: 'c.md', via: 'edit', lagMs: 20 },
    { ts: 70, kind: 'skip', reason: 'chitchat' },
  ];
  assert.deepEqual(summarizeUsage([...forward].reverse()), summarizeUsage(forward), '汇总与顺序无关（内部先按 ts 排）');
  assert.deepEqual(minScoreCurve([...forward].reverse()), minScoreCurve(forward), '曲线同样与顺序无关');
});

test('未知 kind / 缺字段 / 空输入：结构合法，且判据是「有没有 ids」而不是 kind', () => {
  for (const input of [[], [null, undefined, {}], [{}], [null], []]) {
    const s = summarizeUsage(input);
    assert.equal(s.injectRounds, 0);
    assert.equal(s.pointers, 0);
    assert.equal(s.used, 0);
    assert.equal(s.coldOpens, 0);
    assert.equal(s.openRate, 0);
    assert.equal(s.uniqueNotes, 0);
    assert.deepEqual(s.notes, []);
    assert.deepEqual(s.neverOpened, []);
    assert.deepEqual(s.perRound, { min: 0, median: 0, p90: 0, max: 0, windowLimit: 0, fullRounds: 0 });
    assert.deepEqual(s.openLag, { n: 0, median: 0, p90: 0 });
    assert.deepEqual(s.scoreStats, { n: 0, median: 0, p10: 0, p90: 0, spreadMedian: 0 });
    assert.deepEqual(s.skipReasons, {});
    assert.deepEqual(s.emptyReasons, {});
    assert.equal(s.scoreCurve.n, 0);
    assert.equal(s.firstAt, 0);
    assert.equal(s.lastAt, 0);
    assert.equal(s.positions.length, 8);
    assert.ok(s.positions.every((p) => p.injected === 0 && p.opened === 0));
  }

  const weird = summarizeUsage([{ ts: 1, kind: 'wat', ids: ['a.md'] }]);
  assert.equal(weird.injectRounds, 1, '新 kind 只要带 ids 就仍然算一轮注入');
  assert.equal(weird.skipRounds + weird.emptyRounds + weird.sedimentRounds + weird.denyRounds, 0);
  const noIds = summarizeUsage([{ ts: 1, kind: 'hit' }, { ts: 2, kind: 'hit', ids: [] }, { ts: 3, kind: 'hit', ids: 'a.md' }]);
  assert.equal(noIds.injectRounds, 0, 'ids 不是非空数组就不算注入');
  assert.equal(noIds.pointers, 0);

  // 时间戳是字符串/NaN/对象：不算 firstAt/lastAt，但也不能炸
  const junkTs = summarizeUsage([
    { ts: '2026-01-01', kind: 'hit', ids: ['a.md'] },
    { ts: null, kind: 'hit', ids: ['b.md'] },
    { ts: {}, kind: 'hit', ids: ['c.md'] },
    { ts: 1234, kind: 'hit', ids: ['d.md'] },
  ]);
  assert.equal(junkTs.injectRounds, 4);
  assert.equal(junkTs.firstAt, 1234);
  assert.equal(junkTs.lastAt, 1234);
  assert.equal(typeof junkTs.openRate, 'number');
});

test('options.positions / neverOpenedLimit 的边界（小数 positions 按 floor 取整，不再越界）', () => {
  const one = [{ ts: 1, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'] }];
  assert.equal(summarizeUsage(one).positions.length, 8, '缺省 8 个位置');
  assert.equal(summarizeUsage(one, { positions: 12 }).positions.length, 12);
  assert.equal(summarizeUsage(one, { positions: 0 }).positions.length, 8, '0 当缺省（Number(0) || 8）');
  assert.equal(summarizeUsage(one, { positions: 'x' }).positions.length, 8);
  assert.equal(summarizeUsage(one, { positions: -3 }).positions.length, 1, '负数被 Math.max(1, …) 抬到 1，且不会踩空');

  // 小数 positions 曾是产品 bug（0.13.8 已修；最小复现就是下面这行 `{ positions: 2.5 }`）：
  // 旧代码两侧都没取整 —— 库 `Math.max(1, Number(v) || 8)`（usage.js:105）、CLI
  // `Math.max(1, Number(opt('--positions')) || 5)`（scripts/recall-stats.mjs:31，HEAD 里还没有 floor），
  // 于是 2.5 被原样留下，而 `Array.from({ length: 2.5 })` 只建 2 格、`i < 2.5` 又能走到下标 2
  // ⇒ positions[2] 是 undefined ⇒ TypeError: Cannot set properties of undefined；
  // `npm run recall:stats -- --positions 2.5` 过去确实会崩。现在两边都 Math.floor（面板 index.js:1149
  // 只传 maxPointers、positions 走缺省，不受影响）。
  const frac = summarizeUsage(one, { positions: 2.5 });
  assert.equal(frac.positions.length, 2, 'Math.floor(2.5) = 2 个位置');
  assert.deepEqual(frac.positions.map((p) => p.position), [1, 2]);
  assert.equal(frac.positions.reduce((acc, p) => acc + p.injected, 0), 2, '第 3 条指针超出这 2 个位置：位置账不收它，笔记账照收');
  assert.equal(summarizeUsage(one, { positions: 1.5 }).positions.length, 1);
  assert.equal(summarizeUsage(one, { positions: 0.5 }).positions.length, 8, '取整后是 0 ⇒ Number(0) || 8 回落到缺省 8 格');

  // neverOpenedLimit 只用于 slice，小数/负数都不会炸
  const notes = ['a.md', 'b.md', 'c.md', 'd.md'];
  const lines = [{ ts: 1, kind: 'hit', ids: notes }];
  assert.equal(summarizeUsage(lines).neverOpened.length, 4);
  assert.equal(summarizeUsage(lines, { neverOpenedLimit: 2 }).neverOpened.length, 2);
  assert.equal(summarizeUsage(lines, { neverOpenedLimit: 2.5 }).neverOpened.length, 2);
  assert.equal(summarizeUsage(lines, { neverOpenedLimit: -1 }).neverOpened.length, 1, '负数抬到 1');
  assert.equal(summarizeUsage(lines, { neverOpenedLimit: 0 }).neverOpened.length, 4, '0 当缺省 12；这里只有 4 篇没打开过，给不满 12 条');
});

test('minScore 曲线的 steps 钳制在 3..40，网格形状可预期', () => {
  const many = [{
    ts: 1,
    kind: 'hit',
    ids: Array.from({ length: 60 }, (_, i) => `n${i}.md`),
    scores: Array.from({ length: 60 }, (_, i) => i + 1),
  }];
  assert.equal(minScoreCurve(many, { steps: 40 }).points.length, 41, '40 个分位点 + 一行全砍');
  assert.equal(minScoreCurve(many, { steps: 1000 }).points.length, 41, '上限 40：再多也还是 40 个点');
  assert.ok(minScoreCurve(many, { steps: 3 }).points.length <= 4);
  for (const steps of [0, -0, 'x', null, undefined, NaN]) {
    assert.equal(minScoreCurve(many, { steps }).points.length, 13, `steps=${String(steps)} 回落到缺省 12 个分位点 + 全砍`);
  }
  for (const steps of [1, 3, -5]) {
    assert.equal(minScoreCurve(many, { steps }).points.length, 4, `steps=${steps} 被抬到下限 3（3 个分位点 + 全砍）`);
  }
  assert.deepEqual(minScoreCurve([]).points, [], '没有配对就没有网格');
  assert.deepEqual(minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md'] }]).points, []);
});

test('写实：同一轮里反复打开同一篇只算一次（usedCounted ≤ pointers，openRate ≤ 1）', () => {
  // 线上真实形态：一次注入之后同一篇被 read 了好几次（read 完再 edit 就是两条 used），
  // 注入表不会因为「用过一次」就删掉，所以每次打开都落一行 used。
  // 于是 used 是「打开次数」而 pointers 是「注入条数」，两者不同量纲：直接相除会得到 150%，
  // 判据还会反过来说「打开率偏高：窗口可以放宽」—— 正好把结论说反。现在分子换成
  // usedCounted（按「轮 + 指针」去重后的打开条数），used 仍原样保留原始行数供人核对。
  const ids = Array.from({ length: 20 }, (_, i) => `n${i}.md`);
  const lines = [
    { ts: 1, kind: 'hit', ids, scores: ids.map((_, i) => round3(10 - i * 0.1)), scope: 'main' },
    ...Array.from({ length: 30 }, (_, i) => ({ ts: 2 + i, kind: 'used', id: 'n0.md', via: 'read', lagMs: i })),
  ];
  const s = summarizeUsage(lines);
  assert.equal(s.pointers, 20);
  assert.equal(s.used, 30, '原始 used 行数照旧，不因为去重而变小');
  assert.equal(s.usedCounted, 1, '30 条 used 全落在同一个「第 1 轮 × n0.md」键上');
  assert.equal(s.openRate, 0.05, '1 / 20，而不是 30 / 20');
  assert.equal(s.positions[0].injected, 1);
  assert.equal(s.positions[0].opened, 1, '位置级同样按「轮 + 指针」去重，否则位置级也会超过 100%');
  assert.equal(s.notes.find((note) => note.id === 'n0.md').opened, 1);
  assert.match(usageVerdict(s), /打开率 5\.0%/);
  assert.match(usageVerdict(s), /偏低/, '20 条指针的 5% ⇒ 该收窄窗口，方向不再被重复计数带反');

  // 去重键是「轮 + 指针」，不是「指针」：下一轮重新注入了同一篇、又被打开，就该再算一次打开 ——
  // 否则「把同一篇反复塞进窗口」会被算成越来越低的打开率（用重复注入刷低分）。
  const again = summarizeUsage([
    ...lines,
    { ts: 40, kind: 'hit', ids: ['n0.md'] },
    { ts: 41, kind: 'used', id: 'n0.md', via: 'read', lagMs: 1 },
  ]);
  assert.equal(again.pointers, 21);
  assert.equal(again.used, 31);
  assert.equal(again.usedCounted, 2);
  assert.equal(again.openRate, 2 / 21, '同一个 id 在新的一轮里被打开，算第二次');
});

// ── readUsage 的脏文件 ───────────────────────────────────────────────────

test('readUsage：半行 JSON 与「从多字节字符中间截断」都不炸', () => {
  withDir((dir) => {
    appendUsage(dir, { kind: 'hit', ids: ['a.md'], query: '中文查询' });
    appendUsage(dir, { kind: 'used', id: 'a.md', via: 'read', lagMs: 12 });
    const text = readFileSync(join(dir, USAGE_FILE), 'utf8');

    writeFileSync(join(dir, USAGE_FILE), `${text}{"kind":"hit","ids":["b`);
    const rows = readUsage(dir);
    assert.equal(rows.length, 2, '半截行跳过，前面的行照读');
    assert.equal(rows[0].kind, 'used');
    assert.equal(rows[1].query, '中文查询');

    // 更狠：砍在多字节字符的字节中间（断电/写到一半就是这个形态）
    const valid = `${JSON.stringify({ ts: 1, kind: 'hit', ids: ['a.md'], query: '中文' })}\n`;
    const buf = Buffer.from(valid, 'utf8');
    const cutAt = buf.indexOf(Buffer.from('中', 'utf8')) + 1;
    writeFileSync(join(dir, USAGE_FILE), buf.subarray(0, cutAt));
    assert.deepEqual(readUsage(dir), [], '半个多字节字符 ⇒ 这行解不出来，丢掉即可');

    // 坏行后面还有好行：只丢坏的那一行
    writeFileSync(join(dir, USAGE_FILE), Buffer.concat([
      buf.subarray(0, cutAt),
      Buffer.from(`\n${JSON.stringify({ ts: 2, kind: 'used', id: 'a.md' })}\n`),
    ]));
    assert.deepEqual(readUsage(dir).map((row) => row.ts), [2]);
  });
});

test('readUsage：limit 切的是文件行序（不是时间序），undefined 字段不落盘', () => {
  withDir((dir) => {
    for (let i = 1; i <= 12; i += 1) appendUsage(dir, { kind: 'hit', ids: [`n${i}.md`], ts: 1000 - i }); // ts 递减
    const all = readUsage(dir, 1000);
    assert.deepEqual(all.map((row) => row.ids[0]), Array.from({ length: 12 }, (_, i) => `n${12 - i}.md`), '新的在前 = 文件尾部在前');
    // 文件里是 ts 递减的，readUsage 只按「文件行序倒排」，不按 ts 排序 ⇒ 读回来反而成了 ts 递增
    assert.ok(all.every((row, i, arr) => i === 0 || row.ts >= arr[i - 1].ts), 'readUsage 不排序，也不看 ts');
    assert.deepEqual(readUsage(dir, 3).map((row) => row.ids[0]), ['n12.md', 'n11.md', 'n10.md']);
    assert.equal(readUsage(dir).length, 12, '默认上限 2000 用不着');
    assert.equal(readUsage(dir, 0).length, 12, 'slice(-0) 即 slice(0)：limit=0 不是「一条都不要」');

    appendUsage(dir, { kind: 'used', id: 'x.md', lagMs: undefined, via: 'read' });
    const [head] = readUsage(dir);
    assert.equal(head.kind, 'used');
    assert.equal('lagMs' in head, false, 'undefined 被 JSON.stringify 丢掉，读回来就是缺字段');
  });
});

test('readUsage：storePath 是文件、或 USAGE_FILE 是个目录，都返回空数组且不抛', () => {
  withDir((dir) => {
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x');
    assert.deepEqual(readUsage(asFile), []);
    assert.deepEqual(readUsage(join(dir, 'nope')), []);

    mkdirSync(join(dir, USAGE_FILE)); // 有人把日志路径建成了目录
    assert.deepEqual(readUsage(dir), [], 'EISDIR 被吞掉');
    appendUsage(dir, { kind: 'hit', ids: ['a.md'] }); // EISDIR 同样被吞掉
    assert.deepEqual(readUsage(dir), []);
    assert.equal(readFileSync(asFile, 'utf8'), 'x', '无关文件不被碰');
  });
});
