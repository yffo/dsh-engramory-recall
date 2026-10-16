// 消费侧门控（`confidence.js`）的契约测试。
// 每个断言对应一条**行为**，不是实现细节：档位语义、先验算术、自我触碰、过期只降权、
// 抑制要两条证据同时成立、shadow 档不许有副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GATE_DEFAULTS,
  GATE_MODES,
  normalizeGate,
  noteLedgerStats,
  markSelfTouches,
  confidenceOf,
  freshness,
  gateDecision,
  gatePolicy,
  applyGate,
  gateReport,
} from '../confidence.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-16T10:00:00Z');

/** 造一行 `hit` 账本：携带 `ids` 里这些笔记。 */
const hit = (ts, ids) => ({ ts, kind: 'hit', ids, injected: ids.length });
const used = (ts, id) => ({ ts, kind: 'used', id, via: 'read', lagMs: 1000 });
const opened = (ts, id) => ({ ts, kind: 'opened', id, via: 'read' });

/** 造一条 doc（store.js 读出来的形状，只保留门控用得到的字段）。 */
const doc = (id, ageDays, over = {}) => ({ id, mtimeMs: NOW - ageDays * DAY, ...over });

test('账本统计：携带/用上/打开分开数，first/last 时间戳各就各位', () => {
  const lines = [
    hit(NOW - 3 * DAY, ['project-a.md', 'reference-b.md']),
    hit(NOW - 2 * DAY, ['project-a.md']),
    hit(NOW - DAY, ['project-a.md', 'reference-b.md']),
    used(NOW - 2 * DAY + 1000, 'project-a.md'),
    opened(NOW - DAY + 1000, 'feedback-c.md'),
  ];
  const stats = noteLedgerStats(lines);
  const a = stats.get('project-a.md');
  assert.equal(a.carried, 3);
  assert.equal(a.used, 1);
  assert.equal(a.opened, 0);
  assert.equal(a.firstCarriedAt, NOW - 3 * DAY);
  assert.equal(a.lastCarriedAt, NOW - DAY);
  const b = stats.get('reference-b.md');
  assert.equal(b.carried, 2);
  assert.equal(b.used, 0);
  const c = stats.get('feedback-c.md');
  assert.deepEqual({ carried: c.carried, opened: c.opened }, { carried: 0, opened: 1 });
});

test('账本统计：脏行一律跳过（半截行、缺 id、老格式），不把噪声算成证据', () => {
  const stats = noteLedgerStats([
    null,
    'not-an-object',
    { ts: NOW, kind: 'hit' }, // 老账本 / 投影缺字段：没有 ids 就不算携带
    { ts: NOW, kind: 'hit', ids: [null, '', 7, 'project-a.md'] },
    { ts: NOW, kind: 'used' }, // 没 id
    { ts: NOW, kind: 'opened', id: '' },
    { ts: NOW, kind: 'skip', reason: 'duplicate' },
  ]);
  assert.equal(stats.size, 1);
  assert.equal(stats.get('project-a.md').carried, 1);
});

test('先验算术：0/30 与 0/3 都不算被用上，但后验把它们分开了', () => {
  const { alpha, beta } = GATE_DEFAULTS.prior;
  const cold = confidenceOf({ carried: 30, used: 0 });
  const few = confidenceOf({ carried: 3, used: 0 });
  assert.equal(cold.score, (0 + alpha) / (30 + alpha + beta));
  assert.equal(cold.score, 0.025);
  assert.equal(few.score, 1 / 13);
  // 两者的**打开率都是 0**，后验却分得很开：样本越多越敢下结论，样本少就停在先验附近。
  assert.ok(few.score > cold.score * 2, `0/3 (${few.score}) 应当明显高于 0/30 (${cold.score})`);
  assert.ok(few.score < alpha / (alpha + beta), '样本不足时后验应当被先验拽住，而不是直接归零');
  assert.equal(few.tier, 'unknown'); // 样本不够：不判
  assert.equal(cold.tier, 'ignored');
  assert.equal(cold.reason, 'never-used');
});

test('置信度分档：样本不足 / 总用不上 / 有点用 / 确实在用', () => {
  assert.equal(confidenceOf({ carried: 7, used: 0 }).tier, 'unknown');
  assert.equal(confidenceOf({ carried: 8, used: 0 }).tier, 'ignored');
  assert.equal(confidenceOf({ carried: 30, used: 2 }).tier, 'watch');
  assert.equal(confidenceOf({ carried: 10, used: 4 }).tier, 'trusted');
  assert.equal(confidenceOf({ carried: 10, used: 4 }).reason, 'used-often');
  // 空统计不崩：等价于「一篇从没被携带过的笔记」
  assert.equal(confidenceOf(undefined).tier, 'unknown');
  assert.equal(confidenceOf(undefined).evidence, 0);
});

test('自我触碰：写完十分钟内读回来不算被用上，但账本里留痕', () => {
  const lines = [hit(NOW - DAY, ['project-a.md', 'reference-b.md']), used(NOW - 60000, 'project-a.md'), used(NOW - 60000, 'reference-b.md')];
  const stats = noteLedgerStats(lines);
  const touched = markSelfTouches(stats, [
    { ts: NOW - 60000 - 5 * 60 * 1000, verdict: 'allow', file: 'project-a.md' }, // 5 分钟前刚写过 a
    { ts: NOW - 60000 - 30 * 60 * 1000, verdict: 'allow', file: 'reference-b.md' }, // b 是 30 分钟前写的
  ]);
  const a = stats.get('project-a.md');
  const b = stats.get('reference-b.md');
  assert.equal(a.used, 0);
  assert.equal(a.selfTouch, 1);
  assert.equal(b.used, 1, '窗口外的那次读数仍然是正反馈');
  assert.equal(b.selfTouch, 0);
  assert.deepEqual([...touched], ['project-a.md']);
});

test('自我触碰：冷启动（opened）那条路也算自我触碰，也要从「被打开过」里扣掉', () => {
  // `markSelfTouches` 有两条路：usedAt（被用上）与 openedAt（冷启动读）。
  // 只扣 used 那条，会让「刚写完就自己读一遍」在面板上表现成「有人真需要它」。
  const now = NOW;
  const stats = new Map([
    ['reference-self.md', {
      carried: 5, used: 0, opened: 2, selfTouch: 0,
      firstCarriedAt: now - 3 * DAY, lastCarriedAt: now,
      lastUsedAt: 0, lastOpenedAt: now - 60_000,
      usedAt: [], openedAt: [now - 60_000, now - 40 * DAY],
    }],
  ]);
  const audit = [{ ts: now - 90_000, verdict: 'allow', file: 'reference-self.md' }];
  const touched = markSelfTouches(stats, audit, { now });
  assert.deepEqual([...touched], ['reference-self.md']);
  const s = stats.get('reference-self.md');
  assert.equal(s.selfTouch, 1, '窗口内的那一次冷启动读算自我触碰');
  assert.equal(s.opened, 1, '自我触碰要从「被打开过」里扣掉（剩下的是 40 天前那次真读）');
  assert.equal(s.used, 0, 'used 本来就没有，别被扣成负数');
});

test('自我触碰：只认放行的写入；窗口边界含、超出 1 毫秒就不算', () => {
  const stats = noteLedgerStats([
    hit(NOW - DAY, ['project-a.md', 'project-b.md', 'project-c.md']),
    used(NOW - 1000, 'project-a.md'),
    used(NOW - 1000, 'project-b.md'),
    used(NOW - 1000, 'project-c.md'),
  ]);
  const touched = markSelfTouches(stats, [
    { ts: NOW - 2000, verdict: 'deny', file: 'project-a.md' }, // 闸门拒了，库没变，不能算自我触碰
    { ts: NOW - (GATE_DEFAULTS.selfTouchMs + 1000), verdict: 'allow', file: 'project-b.md' }, // 正好在窗口上
    { ts: NOW - (GATE_DEFAULTS.selfTouchMs + 1001), verdict: 'allow', file: 'project-c.md' }, // 超出 1 毫秒
  ]);
  assert.deepEqual([...touched], ['project-b.md'], '边界是「含」，所以只有 b 被记成自我触碰');
  assert.equal(stats.get('project-b.md').used, 0);
  assert.equal(stats.get('project-b.md').selfTouch, 1);
  assert.equal(stats.get('project-a.md').used, 1, '被拒的写入不留痕，这次读仍是正反馈');
  assert.equal(stats.get('project-c.md').used, 1, '超窗的写入不算自我触碰');
  assert.equal(markSelfTouches(new Map(), [{ ts: NOW, verdict: 'allow', file: 'x.md' }]).size, 0);
});

test('新鲜度：只对 project 类判过期；没有 mtime 就不判', () => {
  const stale = freshness(doc('project-old.md', 200), { now: NOW, staleDays: 180 });
  assert.equal(stale.stale, true);
  assert.equal(stale.kind, 'project');
  assert.ok(Math.abs(stale.ageDays - 200) < 0.01);

  assert.equal(freshness(doc('reference-old.md', 400), { now: NOW }).stale, false, 'reference 是「不会腐烂的事实」，多久都不算过期');
  assert.equal(freshness(doc('project-fresh.md', 3), { now: NOW }).stale, false);
  assert.equal(freshness({ id: 'project-no-mtime.md', mtimeMs: 0 }, { now: NOW }).stale, false);
  assert.equal(freshness({ id: 'project-no-mtime.md', mtimeMs: 0 }, { now: NOW }).ageDays, null);
  assert.equal(freshness({ id: 'notes.md', mtimeMs: NOW - 400 * DAY }, { now: NOW }).kind, '');
});

test('裁决：抑制要「携带够多 + 观察够久 + 一次没用」三条同时成立', () => {
  const now = NOW;
  // 门槛的**算术**另有专门用例（gatePolicy）；这里只验裁决机制，所以直接给一条门槛。
  const POLICY = { demoteAt: 14, suppressAt: 14, baseRate: 0.07, baseSource: 'ledger', carriedSamples: 200 };
  const ctx = (stats, docs = new Map()) => ({ stats, docs, now, policy: POLICY });

  // 满足全部条件：携带 14 次、观察 20 天、一次没被用上
  const long = new Map([
    [
      'project-x.md',
      { carried: 14, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: now - 20 * DAY, lastCarriedAt: now - DAY, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
  ]);
  assert.equal(gateDecision({ id: 'project-x.md', score: 3 }, ctx(long)).action, 'suppress');

  // 携带够多但才观察了 1 天：只能降权（防一次会话里的偶然）
  const young = new Map([
    [
      'project-y.md',
      { carried: 20, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: now - DAY, lastCarriedAt: now, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
  ]);
  const youngVerdict = gateDecision({ id: 'project-y.md', score: 3 }, ctx(young));
  assert.equal(youngVerdict.action, 'demote');
  assert.equal(youngVerdict.reason, 'never-used');

  // 样本不够：不碰
  const few = new Map([
    ['project-z.md', { carried: 3, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: now - 90 * DAY, lastCarriedAt: now, lastUsedAt: 0, usedAt: [], openedAt: [] }],
  ]);
  assert.equal(gateDecision({ id: 'project-z.md', score: 3 }, ctx(few)).action, 'keep');
});

test('裁决：过期 project 只降权，绝不抑制（哪怕一次都没被用上）', () => {
  const stats = new Map([
    [
      'project-old.md',
      { carried: 30, used: 3, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 400 * DAY, lastCarriedAt: NOW - DAY, lastUsedAt: NOW - 2 * DAY, usedAt: [], openedAt: [] },
    ],
  ]);
  const docs = new Map([['project-old.md', doc('project-old.md', 300)]]);
  const verdict = gateDecision({ id: 'project-old.md', score: 2 }, { stats, docs, now: NOW });
  assert.equal(verdict.action, 'demote');
  assert.equal(verdict.reason, 'stale-project');
  assert.equal(verdict.factor, GATE_DEFAULTS.demote);
  assert.ok(verdict.ageDays > 299);
});

test('applyGate：off 原样返回，shadow 一分不改但如实记账', () => {
  const hits = [{ id: 'project-x.md', score: 4 }, { id: 'reference-a.md', score: 3 }];
  const stats = new Map([
    [
      'project-x.md',
      { carried: 20, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 30 * DAY, lastCarriedAt: NOW, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
  ]);
  const POLICY = { demoteAt: 20, suppressAt: 20, baseRate: 0.05, baseSource: 'ledger', carriedSamples: 400 };
  const context = { stats, docs: new Map(), now: NOW, policy: POLICY };

  const off = applyGate(hits, context, { mode: 'off' });
  assert.equal(off.hits, hits, 'off 档必须原样返回同一个数组（零拷贝、零副作用）');
  assert.deepEqual([off.demoted, off.suppressed], [[], []]);

  const shadow = applyGate(hits, context, { mode: 'shadow' });
  assert.equal(shadow.hits, hits);
  assert.deepEqual(shadow.hits.map((h) => h.score), [4, 3], 'shadow 不改分数');
  assert.equal(shadow.demoted.length + shadow.suppressed.length, 1);
  const recorded = shadow.suppressed[0] ?? shadow.demoted[0];
  assert.equal(recorded.id, 'project-x.md');
  assert.equal(recorded.carried, 20);
  assert.equal(recorded.reason, 'never-used');
});

test('applyGate：assist 降权并重排，enforce 才真的移出注入', () => {
  const hits = [{ id: 'project-x.md', score: 4 }, { id: 'reference-a.md', score: 3 }];
  const stats = new Map([
    [
      'project-x.md',
      { carried: 20, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 30 * DAY, lastCarriedAt: NOW, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
  ]);
  const POLICY = { demoteAt: 20, suppressAt: 20, baseRate: 0.05, baseSource: 'ledger', carriedSamples: 400 };
  const context = { stats, docs: new Map(), now: NOW, policy: POLICY };

  const assist = applyGate(hits, context, { mode: 'assist', demote: 0.5 });
  assert.equal(assist.hits.length, 2, 'assist 不删任何东西');
  assert.deepEqual(assist.hits.map((h) => h.id), ['reference-a.md', 'project-x.md'], '降权后要真的往后排');
  assert.equal(assist.hits[1].score, 2);
  assert.equal(assist.hits[1].gated, 'never-used');
  assert.equal(assist.demoted.length, 1);
  assert.equal(assist.suppressed.length, 0);
  assert.equal(assist.demoted[0].wouldSuppress, true, '账目要说清「证据够到抑制线，但 assist 档只降权」');
  assert.equal(hits[0].score, 4, '不许就地改调用方的命中对象');

  const enforce = applyGate(hits, context, { mode: 'enforce' });
  assert.deepEqual(enforce.hits.map((h) => h.id), ['reference-a.md']);
  assert.equal(enforce.suppressed.length, 1);
  assert.equal(enforce.suppressed[0].id, 'project-x.md');
  assert.equal(enforce.suppressed[0].score, 4, '账目里记的是它被拦下时的原分');
});

test('applyGate：档位写法不认识时回到默认档，不静默开也不静默关', () => {
  assert.equal(normalizeGate('ENFORCE'), 'enforce');
  assert.equal(normalizeGate('  shadow '), 'shadow');
  assert.equal(normalizeGate('assit'), GATE_DEFAULTS.mode);
  assert.equal(normalizeGate(undefined), GATE_DEFAULTS.mode);
  assert.equal(normalizeGate('off', 'enforce'), 'off');
  assert.equal(normalizeGate('bogus', 'enforce'), 'enforce');
  assert.deepEqual(GATE_MODES, ['off', 'shadow', 'assist', 'enforce']);
});

test('gateReport：给出「总也用不上」与「过期」两张清单，按证据量排序', () => {
  const stats = new Map([
    [
      'project-a.md',
      { carried: 53, used: 0, opened: 0, selfTouch: 2, firstCarriedAt: NOW - 40 * DAY, lastCarriedAt: NOW, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
    [
      'project-b.md',
      { carried: 9, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 10 * DAY, lastCarriedAt: NOW, lastUsedAt: 0, usedAt: [], openedAt: [] },
    ],
    [
      'reference-c.md',
      { carried: 30, used: 6, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 40 * DAY, lastCarriedAt: NOW, lastUsedAt: NOW - DAY, usedAt: [], openedAt: [] },
    ],
  ]);
  const docs = new Map([
    ['project-a.md', doc('project-a.md', 400)],
    ['project-b.md', doc('project-b.md', 5)],
    ['reference-c.md', doc('reference-c.md', 900)],
  ]);
  const report = gateReport(stats, docs, { now: NOW });
  assert.deepEqual(report.ignored.map((r) => r.id), ['project-a.md', 'project-b.md'], '按携带次数降序');
  assert.equal(report.ignored[0].selfTouch, 2);
  assert.deepEqual(report.stale.map((r) => r.id), ['project-a.md'], '过期的只有那篇 400 天没动的 project');
  assert.equal(report.mode, GATE_DEFAULTS.mode);
  assert.equal(report.minEvidence, GATE_DEFAULTS.minEvidence);
  // 空输入不崩
  const empty = gateReport(undefined, undefined, { now: NOW });
  assert.deepEqual([empty.ignored, empty.stale], [[], []]);
});

test('门槛算术：按本库自己的基础打开率算，而不是拍一个固定次数', () => {
  const many = new Map();
  // 500 次携带里 50 次真被用上 = 10% 基础率 → 降权线 = 期望被读 1 次 = 10 次携带，
  // 抑制线 = 期望被读 3 次 = 30 次携带（都比「最少次数」的地板高，所以地板不生效）。
  for (let i = 0; i < 50; i += 1) many.set(`n${i}.md`, { carried: 10, used: 1 });
  const policy = gatePolicy(many);
  assert.equal(policy.baseSource, 'ledger');
  assert.equal(policy.carriedSamples, 500);
  assert.ok(Math.abs(policy.baseRate - 0.1) < 1e-9, `基础率应约 10%，实得 ${policy.baseRate}`);
  assert.equal(policy.demoteAt, 10);
  assert.equal(policy.suppressAt, 30);
});

test('门槛算术：样本太少退回先验率，全库零打开时用下限而不是无穷', () => {
  // 携带总数低于 baseRateMinSamples(50)：不用账本率，退到先验 1/10 = 10% → 10 / 30
  const few = new Map([['a.md', { carried: 20, used: 0 }]]);
  const prior = gatePolicy(few);
  assert.equal(prior.baseSource, 'prior');
  assert.ok(Math.abs(prior.baseRate - 0.1) < 1e-9);
  assert.equal(prior.demoteAt, 10);
  assert.equal(prior.suppressAt, 30);

  // 样本够了但一次都没被读过：按 1% 下限算（100 / 300），绝不把门槛推成「永远不动手」
  const silent = new Map();
  for (let i = 0; i < 60; i += 1) silent.set(`s${i}.md`, { carried: 20, used: 0 });
  const floored = gatePolicy(silent);
  assert.equal(floored.baseSource, 'ledger');
  assert.equal(floored.baseRate, GATE_DEFAULTS.baseRateFloor);
  assert.equal(floored.demoteAt, 100);
  assert.equal(floored.suppressAt, 300);
});

test('裁决：看着像没用、但证据还没到降权线 → 一律不动，账本里留个「样本还不够」', () => {
  const stats = new Map();
  for (let i = 0; i < 60; i += 1) stats.set(`n${i}.md`, { carried: 20, used: 0 });
  stats.set('suspect.md', { carried: 9, used: 0, firstCarriedAt: NOW - 30 * DAY, lastCarriedAt: NOW });
  const context = { stats, docs: new Map(), now: NOW };
  const verdict = gateDecision({ id: 'suspect.md', score: 3 }, context);
  assert.equal(verdict.action, 'keep');
  assert.equal(verdict.reason, 'insufficient-evidence');
  assert.equal(verdict.factor, 1);
  // 同一批里携带 100 次的那条：过了线（100）才降权
  stats.set('tired.md', { carried: 100, used: 0, firstCarriedAt: NOW - 30 * DAY, lastCarriedAt: NOW });
  const demoted = gateDecision({ id: 'tired.md', score: 3 }, context);
  assert.equal(demoted.action, 'demote');
  assert.equal(demoted.reason, 'never-used');
});

test('门槛整份透出：applyGate 与 gateReport 都要说清「这套尺子现在怎么算」', () => {
  const stats = new Map();
  // 50 篇陪衬：携带 500、被用上 50 → 基础率 10%，加上 tired 那篇（携带 40）后是 50/540 ≈ 9.26%
  // → 降权线 ceil(1/0.0926) = 11、抑制线 ceil(3/0.0926) = 33；tired 的 40 次两头都过了。
  for (let i = 0; i < 50; i += 1) stats.set(`n${i}.md`, { carried: 10, used: 1 });
  stats.set('tired.md', { carried: 40, used: 0, opened: 0, selfTouch: 0, firstCarriedAt: NOW - 30 * DAY, lastCarriedAt: NOW });
  const context = { stats, docs: new Map(), now: NOW };
  const gated = applyGate([{ id: 'tired.md', score: 3 }], context, { mode: 'assist' });
  assert.equal(gated.policy.demoteAt, 11);
  assert.equal(gated.policy.suppressAt, 33);
  assert.equal(gated.demoted.length, 1);
  assert.equal(gated.demoted[0].wouldSuppress, true, '40 次携带已过抑制线（30），assist 只是降权');

  const report = gateReport(stats, new Map(), { now: NOW });
  assert.equal(report.policy.baseSource, 'ledger');
  assert.equal(report.policy.demoteAt, 11);
  assert.equal(report.policy.suppressAt, 33);
  const tired = report.ignored.find((n) => n.id === 'tired.md');
  assert.equal(tired.demoting, true, '名单要分清「已经在降权」与「还在观察」');
  assert.equal(tired.readable, true);
});
