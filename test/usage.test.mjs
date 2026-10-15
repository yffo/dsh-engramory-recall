/**
 * 召回日志（usage.js）测试：模块本身 + 插件里的两处挂点。
 *
 * 这条链此前完全不存在，所以两层都要钉：
 *   1. 模块层：落盘/截断/永不抛异常/纯函数汇总（打开率、位置级、从未被打开）；
 *   2. 插件层：**注入写一行、之后 read 那篇写一行 `used`、读库外文件什么都不写**。
 *      插件层用假 ctx 跑真实 apply()——它是唯一能在不重启 DSH 的情况下证明接线成立的办法。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import {
  MAX_USAGE_BYTES,
  USAGE_FILE,
  appendUsage,
  budgetVerdict,
  noteIdFromPath,
  minScoreCurve,
  pickInjected,
  reasonVerdict,
  readUsage,
  scoreCurveVerdict,
  summarizeUsage,
  usageVerdict,
} from '../usage.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'engramory-usage-'));

// ── 模块层 ────────────────────────────────────────────────────────────────

test('召回日志：写一行读一行，新的在前，坏行跳过', () => {
  const dir = tmp();
  try {
    appendUsage(dir, { kind: 'hit', query: '代理', ids: ['a.md', 'b.md'], injected: 2 });
    appendUsage(dir, { kind: 'used', id: 'a.md', via: 'read', lagMs: 1200 });
    const lines = readUsage(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, 'used');
    assert.equal(lines[1].ids.length, 2);
    assert.ok(Number.isFinite(lines[0].ts), '每行都该带时间戳');

    // 半截行（写到一半被杀）不能让整份日志读不出来
    writeFileSync(join(dir, USAGE_FILE), `${readFileSync(join(dir, USAGE_FILE), 'utf8')}{"kind":"hit"\n`);
    const survivors = readUsage(dir);
    assert.equal(survivors.length, 2, '半截行解析失败就跳过，不吞掉别的行');
    assert.equal(readUsage(join(dir, '不存在的目录')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('召回日志：超出上限就半量截断，且永不抛异常', () => {
  const dir = tmp();
  try {
    const file = join(dir, USAGE_FILE);
    const filler = `${JSON.stringify({ ts: 1, kind: 'hit', ids: ['x.md'], pad: 'y'.repeat(400) })}\n`;
    writeFileSync(file, filler.repeat(Math.ceil((MAX_USAGE_BYTES + 4096) / filler.length)));
    const before = statSync(file).size;
    assert.ok(before > MAX_USAGE_BYTES);
    appendUsage(dir, { kind: 'used', id: 'x.md', via: 'read' });
    const after = statSync(file).size;
    assert.ok(after < before / 2 + 1024, `截断后应只剩后半（${before} → ${after}）`);
    assert.equal(readUsage(dir)[0].kind, 'used');

    // storePath 指向一个文件（mkdir 必失败）也不能抛
    const bogus = join(dir, 'not-a-dir');
    writeFileSync(bogus, 'x');
    appendUsage(bogus, { kind: 'hit', ids: ['a.md'] });
    assert.equal(readUsage(bogus).length, 0);
    appendUsage('', { kind: 'hit', ids: ['a.md'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('召回日志：认得路径、只认注入过的笔记', () => {
  assert.equal(noteIdFromPath('/x/y/reference-a.md'), 'reference-a.md');
  assert.equal(noteIdFromPath('reference-b.md'), 'reference-b.md');
  assert.equal(noteIdFromPath('/x/y/notes.txt'), '', '只有 .md 才是笔记');
  assert.equal(noteIdFromPath(''), '');
  assert.equal(noteIdFromPath(undefined), '');

  const injectedAt = new Map([['a.md', 1000]]);
  assert.deepEqual(pickInjected('a.md', injectedAt), { id: 'a.md', at: 1000 });
  assert.equal(pickInjected('b.md', injectedAt), null);
  assert.equal(pickInjected('a.md', null), null, '没有记账表时一律算没注入过');
});

test('召回汇总：打开率、位置级曲线、从未被打开', () => {
  const t = 1_700_000_000_000;
  const summary = summarizeUsage([
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'], injected: 3 },
    { ts: t + 10, kind: 'used', id: 'a.md', via: 'read', lagMs: 10 },
    { ts: t + 20, kind: 'empty' },
    { ts: t + 30, kind: 'skip', reason: 'duplicate' },
    { ts: t + 40, kind: 'opened', id: 'z.md', via: 'read' },
    { ts: t + 50, kind: 'hit', ids: ['a.md', 'd.md'], injected: 2 },
    { ts: t + 60, kind: 'used', id: 'd.md', via: 'edit', lagMs: 10 },
  ]);
  assert.equal(summary.injectRounds, 2);
  assert.equal(summary.pointers, 5);
  assert.equal(summary.used, 2);
  assert.equal(summary.coldOpens, 1);
  assert.equal(summary.zeroRounds, 1);
  assert.equal(summary.dedupeRounds, 1);
  assert.equal(summary.openRate, 0.4);
  assert.equal(summary.positions[0].injected, 2, 'a.md 两次都在第 1 位');
  assert.equal(summary.positions[0].opened, 1);
  assert.equal(summary.positions[1].injected, 2, '第 2 位：第一轮的 b.md + 第二轮的 d.md');
  assert.equal(summary.positions[1].opened, 1, 'd.md 在第 2 轮第 2 位被打开');
  assert.equal(summary.positions[2].injected, 1, '第 3 位只有第一轮的 c.md');
  assert.deepEqual(
    summary.notes.map((n) => [n.id, n.injected, n.opened]),
    [['a.md', 2, 1], ['d.md', 1, 1], ['b.md', 1, 0], ['c.md', 1, 0]],
  );
  assert.deepEqual(summary.neverOpened.map((n) => n.id).sort(), ['b.md', 'c.md']);

  // 归属规则：一次打开算到「它之前最近一次注入过这条」的那一轮，而不是最早那轮
  const late = summarizeUsage([
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md'] },
    { ts: t + 10, kind: 'hit', ids: ['b.md', 'a.md'] },
    { ts: t + 20, kind: 'used', id: 'a.md', via: 'read' },
  ]);
  assert.equal(late.positions[0].opened, 0, '第二次注入 a.md 在第 2 位，不该算到第 1 位头上');
  assert.equal(late.positions[1].opened, 1);
});

test('召回汇总：预算压力与打开延迟（窗口调宽了、字跟没跟上）', () => {
  const t = 1_700_000_000_000;
  const summary = summarizeUsage([
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], injected: 5, collapsed: 1, dropped: 2 },
    { ts: t + 1000, kind: 'used', id: 'a.md', via: 'read', lagMs: 1000 },
    { ts: t + 60_000, kind: 'hit', ids: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], injected: 5 },
    { ts: t + 61_000, kind: 'used', id: 'c.md', via: 'read', lagMs: 1000 },
    { ts: t + 120_000, kind: 'hit', ids: ['a.md', 'b.md'], injected: 2, collapsed: 0, dropped: 1 },
  ], { maxPointers: 5 });
  assert.equal(summary.injectRounds, 3);
  assert.equal(summary.collapsed, 1, '只有第一轮缩了一条');
  assert.equal(summary.collapsedRounds, 1);
  assert.equal(summary.dropped, 3);
  assert.equal(summary.droppedRounds, 2);
  assert.equal(summary.truncatedRounds, 2, '有截断的轮数：第一轮与第三轮');
  assert.deepEqual(
    [summary.perRound.min, summary.perRound.median, summary.perRound.p90, summary.perRound.max],
    [2, 5, 5, 5],
  );
  assert.equal(summary.perRound.windowLimit, 5);
  assert.equal(summary.perRound.fullRounds, 2, '两轮顶到 5 条');
  assert.equal(summary.openLag.n, 2);
  assert.equal(summary.openLag.median, 1000);
  // 不给 maxPointers 就不算「用满了几轮」（别瞎猜别人的窗口）
  const bare = summarizeUsage([{ ts: t, kind: 'hit', ids: ['a.md'] }]);
  assert.equal(bare.perRound.windowLimit, 0);
  assert.equal(bare.perRound.fullRounds, 0);
});

test('预算判据：截断多了先抬 maxChars，窗口顶满了才谈放宽', () => {
  assert.match(budgetVerdict({ injectRounds: 0 }), /还没有注入行/);
  assert.match(
    budgetVerdict({ injectRounds: 10, truncatedRounds: 4, collapsed: 5, dropped: 3, perRound: { windowLimit: 5, fullRounds: 2 } }),
    /预算在砍内容.*先抬 maxChars/,
  );
  assert.match(
    budgetVerdict({ injectRounds: 10, truncatedRounds: 0, collapsed: 0, dropped: 0, perRound: { windowLimit: 5, fullRounds: 9 } }),
    /窗口基本用满.*只需动 maxPointers/,
  );
  assert.match(
    budgetVerdict({ injectRounds: 10, truncatedRounds: 0, collapsed: 0, dropped: 0, perRound: { windowLimit: 5, fullRounds: 1 } }),
    /没有明显压力/,
  );
});

test('召回汇总：判据在样本太小时不下结论', () => {
  assert.match(usageVerdict({ pointers: 4, openRate: 0.9 }), /样本太小/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.1 }), /偏低/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.9 }), /放宽/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.45 }), /中间档/);
});

test('minScore 代价曲线：零代价上限 = 砍得掉、又没丢过「被打开过」的那道最高门槛', () => {
  const t = 1_700_000_000_000;
  const lines = [
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'], scores: [9, 6, 2], injected: 3 },
    { ts: t + 10, kind: 'used', id: 'b.md', via: 'read', lagMs: 10 },
    { ts: t + 20, kind: 'hit', ids: ['d.md', 'e.md'], scores: [4, 3.5], injected: 2 },
    { ts: t + 30, kind: 'hit', ids: ['f.md'], injected: 1 },
    { ts: t + 40, kind: 'hit', ids: ['g.md', 'h.md'], scores: [5], injected: 2 },
  ];
  const curve = minScoreCurve(lines);
  assert.equal(curve.n, 5, '只有 a~e 五条能配对（f 是没分数的老日志、g/h 对不上号）');
  assert.equal(curve.rounds, 2);
  assert.equal(curve.legacy, 1);
  assert.equal(curve.unaligned, 1);
  assert.equal(curve.opened, 1, 'b.md 是唯一被打开过的配对');
  // 「≥ 6」恰好留下 b.md（门槛是 `score >= minScore` 保留，不是 >）⇒ 零代价上限就是 6
  assert.deepEqual(curve.freeCap, { minScore: 6, injected: 2, cut: 3, cutRate: 0.6, lost: 0 });
  const at6 = curve.points.find((p) => p.minScore === 6);
  assert.equal(at6.lost, 0, 'b.md 的分数正好是 6，抬到 6 还留着它');
  assert.equal(at6.injected, 2, '只剩 a(9) 与 b(6)');
  const last = curve.points.at(-1);
  assert.equal(last.minScore, 9.001, '网格末尾补一行「最高分 + 0.001」，保证「全砍掉」那一行总在');
  assert.equal(last.injected, 0);
  assert.equal(last.lost, 1, 'b.md 也丢了');
});

test('minScore 代价曲线：没分数、没打开都给人话，不是 NaN', () => {
  const blank = minScoreCurve([]);
  assert.equal(blank.n, 0);
  assert.equal(blank.rounds, 0);
  assert.equal(blank.opened, 0);
  assert.deepEqual(blank.points, []);
  assert.equal(blank.freeCap, null);
  assert.match(blank.note, /只能看形状/, '空数据也要带一句人话（面板/尺子直接印它）');
  const onlyLegacy = minScoreCurve([{ ts: 1, kind: 'hit', ids: ['a.md'] }]);
  assert.equal(onlyLegacy.n, 0);
  assert.equal(onlyLegacy.legacy, 1);
  assert.match(scoreCurveVerdict(onlyLegacy), /还没有能校准 minScore 的日志/);

  const noOpens = minScoreCurve([
    { ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [5, 1] },
  ]);
  assert.equal(noOpens.opened, 0);
  assert.match(scoreCurveVerdict(noOpens), /只能看形状/, '样本太小时不下结论');
});

test('minScore 判据：有零代价上限 / 没有零代价 两种话术', () => {
  const t = 1_700_000_000_000;
  // 五条被打开的都排在前面，低分那头全是没人看的 ⇒ 抬门槛有零代价的空间
  const cheap = minScoreCurve([
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md', 'x.md'], scores: [9, 6, 1] },
    { ts: t + 1, kind: 'hit', ids: ['d.md', 'e.md', 'y.md'], scores: [8, 7, 1.5] },
    { ts: t + 2, kind: 'hit', ids: ['f.md', 'z.md'], scores: [5, 2] },
    ...['a.md', 'b.md', 'd.md', 'e.md', 'f.md'].map((id, i) => ({ ts: t + 10 + i, kind: 'used', id, via: 'read' })),
  ]);
  assert.equal(cheap.opened, 5);
  assert.equal(cheap.freeCap.minScore, 5, '门槛 5 能砍掉 x(1)、y(1.5)、z(2) 而不碰任何被打开过的（f 正好是 5，留着）');
  assert.equal(cheap.freeCap.cut, 3);
  assert.match(scoreCurveVerdict(cheap), /零代价上限：minScore ≥ 5 能砍掉 3 条注入/);

  // 被打开过的就在最低分那头 ⇒ 抬一点就丢真的，没有零代价的门槛
  const costly = minScoreCurve([
    { ts: t, kind: 'hit', ids: ['x.md', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md'], scores: [9, 1.8, 1.5, 1.2, 1.1, 1.05] },
    ...['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((id, i) => ({ ts: t + 10 + i, kind: 'used', id, via: 'read' })),
  ]);
  assert.equal(costly.opened, 5);
  assert.equal(costly.freeCap, null);
  assert.match(scoreCurveVerdict(costly), /没有「砍掉又不丢」的门槛/);
});

test('按提问者分账：委派轮的指针不算进主对话的打开率，归因跟着「命中它的最后一次注入」', () => {
  const t = 1_700_000_000_000;
  const s = summarizeUsage([
    { ts: t, kind: 'hit', ids: ['a.md', 'b.md'], scores: [9, 5], scope: 'main' },
    { ts: t + 10, kind: 'used', id: 'a.md', via: 'read' },
    { ts: t + 20, kind: 'hit', ids: ['c.md', 'd.md'], scope: 'subagent' },
    { ts: t + 30, kind: 'used', id: 'c.md', via: 'read' },
    { ts: t + 40, kind: 'hit', ids: ['e.md'], scores: [4], scope: 'main' },
    { ts: t + 50, kind: 'skip', reason: 'chitchat' },
  ]);
  assert.equal(s.pointers, 5);
  assert.equal(s.used, 2);
  assert.equal(s.scopes.main.pointers, 3);
  assert.equal(s.scopes.main.used, 1);
  assert.equal(s.scopes.main.openRate, 1 / 3);
  assert.equal(s.scopes.subagent.pointers, 2);
  assert.equal(s.scopes.subagent.used, 1);
  assert.equal(s.scopes.unknown.pointers, 0, '没标 scope 的行进 unknown，不能混进 main');

  // 同一篇被注入了两次（先委派、后主对话），之后被打开 —— 归「最后一次命中它的那次注入」
  const repeated = summarizeUsage([
    { ts: 1, kind: 'hit', ids: ['x.md'], scope: 'subagent' },
    { ts: 2, kind: 'hit', ids: ['x.md'], scope: 'main' },
    { ts: 3, kind: 'used', id: 'x.md', via: 'read' },
  ]);
  assert.equal(repeated.scopes.main.used, 1);
  assert.equal(repeated.scopes.subagent.used, 0);
});

test('第一句判据：委派轮占大头时改用「只看主对话」的口径，不够多时不换', () => {
  const main = { injectRounds: 5, pointers: 25, used: 9, openRate: 9 / 25 };
  const sub = { injectRounds: 10, pointers: 50, used: 0, openRate: 0 };
  const diluted = usageVerdict({ pointers: 75, used: 9, openRate: 9 / 75, scopes: { main, subagent: sub, unknown: { injectRounds: 0, pointers: 0, used: 0, openRate: 0 } } });
  assert.match(diluted, /只看主对话轮的 25 条指针/, '委派轮占到 2/3 时要换口径');
  assert.match(diluted, /另有 50 条来自子代理轮/);
  assert.match(diluted, /在中间档/, '36% 是中间档（换口径前 12% 会被误判成偏低）');

  const small = usageVerdict({ pointers: 75, used: 9, openRate: 0.12, scopes: { main, subagent: { injectRounds: 1, pointers: 4, used: 0, openRate: 0 }, unknown: { injectRounds: 9, pointers: 46, used: 0, openRate: 0 } } });
  assert.match(small, /打开率 12\.0% 偏低/, '委派轮只有 4 条指针时不该换口径');
});

// ── 插件层：注入 → 打开 的完整链路 ─────────────────────────────────────────

function fixtureStore() {
  const dir = tmp();
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory Index\n\n- [代理节点](reference-proxy.md) — Hy2 双端口\n');
  const shared = '本地记忆库的检索只在这台机器上跑';
  writeFileSync(
    join(dir, 'reference-proxy.md'),
    ['---', 'name: reference-proxy', 'description: 美国自建代理节点架构', 'type: reference', '---', '', '# 代理节点', '', `${shared}。Hy2 双端口主力。`].join('\n'),
  );
  writeFileSync(
    join(dir, 'reference-other.md'),
    ['---', 'name: reference-other', 'description: 无关的别的笔记', 'type: reference', '---', '', '# 别的', '', '这条与本轮问题无关。'].join('\n'),
  );
  return dir;
}

function captureHandler(config) {
  let handler;
  const guards = [];
  const ctx = {
    on: (event, fn) => {
      if (event === 'agent/pre-step') handler = fn;
    },
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    tools: { register: () => {}, guard: (fn) => { guards.push(fn); return () => {}; } },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ webServer: { register: () => () => {} } });
      if (deps.includes('skills')) fn({ effect: (f) => f(), skills: { register: () => () => {} } });
    },
  };
  apply(ctx, config);
  return { handler, guards };
}

const human = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

test('插件接线：注入写一行，之后 read 那篇写一行 used，库外不记', async () => {
  const store = fixtureStore();
  try {
    const { handler, guards } = captureHandler({ storePath: store, minScore: 0, maxPointers: 2 });
    const decision = { kind: 'enter', messages: [human('h1', '代理节点是怎么部署的？')] };
    const out = await handler({}, async () => decision);
    const injectedIds = readUsage(store)
      .filter((line) => line.kind === 'hit')
      .flatMap((line) => line.ids ?? []);
    assert.ok(injectedIds.length >= 1, '自动召回该照常注入指针');
    assert.ok(out.messages.length > decision.messages.length);

    assert.ok(guards.length >= 1, '记账挂在工具守卫回调用');
    for (const guard of guards) {
      // 打开一篇注入过的笔记 → used（带 lagMs）
      assert.equal(guard({ name: 'read', arguments: { file_path: join(store, injectedIds[0]) } }), undefined);
      // 打开一篇没注入过的库内笔记 → opened（对照组）
      guard({ name: 'read', arguments: { file_path: join(store, 'reference-other.md') } });
      // 库外、非 .md、没有路径：一个字都不记
      guard({ name: 'read', arguments: { file_path: join(tmpdir(), 'elsewhere', 'x.md') } });
      guard({ name: 'read', arguments: { file_path: join(store, 'MEMORY.txt') } });
      guard({ name: 'grep', arguments: { pattern: 'x' } });
    }
    const lines = readUsage(store);
    const used = lines.filter((line) => line.kind === 'used');
    const opened = lines.filter((line) => line.kind === 'opened');
    assert.equal(used.length, guards.length, `每个守卫各记一次 used（实际 ${used.length}）`);
    assert.equal(used[0].id, injectedIds[0]);
    assert.equal(used[0].via, 'read');
    assert.ok(Number.isFinite(used[0].lagMs) && used[0].lagMs >= 0, 'lagMs 要能算出「距注入多久」');
    assert.deepEqual(opened.map((line) => line.id), ['reference-other.md']);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('插件接线：关掉 usageLog 就只留内存日志，一个字都不落盘', async () => {
  const store = fixtureStore();
  try {
    const { handler, guards } = captureHandler({ storePath: store, minScore: 0, maxPointers: 2, usageLog: false });
    const decision = { kind: 'enter', messages: [human('h1', '代理节点是怎么部署的？')] };
    await handler({}, async () => decision);
    for (const guard of guards) guard({ name: 'read', arguments: { file_path: join(store, 'reference-proxy.md') } });
    assert.equal(readUsage(store).length, 0);
    assert.equal(statSync(join(store, USAGE_FILE), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('原因分布：skip/empty 的原因码分类计数，没带码的归 unspecified', () => {
  const summary = summarizeUsage([
    { ts: 1, kind: 'skip', query: '继续', reason: 'chitchat' },
    { ts: 2, kind: 'skip', query: '嗯', reason: 'chitchat' },
    { ts: 3, kind: 'skip', query: '好的', reason: 'too-short' },
    { ts: 4, kind: 'skip', query: '旧日志这行', ids: [] },
    { ts: 5, kind: 'empty', reason: 'below-min-score', topScore: 0.4, minScore: 0.5 },
    { ts: 6, kind: 'empty', reason: 'no-hits' },
  ]);
  assert.equal(summary.skipRounds, 4);
  assert.equal(summary.emptyRounds, 2);
  assert.deepEqual(summary.skipReasons, { chitchat: 2, 'too-short': 1, unspecified: 1 });
  assert.deepEqual(summary.emptyReasons, { 'below-min-score': 1, 'no-hits': 1 });
  assert.match(reasonVerdict(summary), /没注入的 6 轮/);
});

test('原因判据：设计性的安静与真漏分开说；早期日志不下结论', () => {
  const quiet = summarizeUsage(
    Array.from({ length: 6 }, (_, i) => ({ ts: i + 1, kind: 'skip', query: '继续', reason: 'chitchat' })),
  );
  assert.match(reasonVerdict(quiet), /设计性的安静占大头/);

  const leaky = summarizeUsage([
    { ts: 1, kind: 'skip', query: '继续', reason: 'chitchat' },
    { ts: 2, kind: 'empty', reason: 'below-min-score', topScore: 1.2, minScore: 2 },
    { ts: 3, kind: 'empty', reason: 'no-hits' },
    { ts: 4, kind: 'empty', reason: 'below-min-score', topScore: 1.1, minScore: 2 },
  ]);
  assert.match(reasonVerdict(leaky), /才是真漏/);

  const legacy = summarizeUsage([{ ts: 1, kind: 'skip', query: '旧', ids: [] }]);
  assert.match(reasonVerdict(legacy), /没有原因码/);
});

test('分数分布：注入分的中位/p10/p90 与首尾落差', () => {
  // 分位数用的是全仓同一套 q()（nearest-rank 取低），所以给 5 行才看得出高低
  const summary = summarizeUsage([
    { ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [1, 1] },
    { ts: 2, kind: 'hit', ids: ['a.md', 'c.md'], scores: [2, 2] },
    { ts: 3, kind: 'hit', ids: ['a.md', 'd.md'], scores: [3, 1] },
    { ts: 4, kind: 'hit', ids: ['a.md', 'e.md'], scores: [4, 0] },
    { ts: 5, kind: 'hit', ids: ['a.md', 'f.md'], scores: [10, 0] },
  ]);
  assert.equal(summary.scoreStats.n, 5);
  assert.equal(summary.scoreStats.median, 3);
  assert.equal(summary.scoreStats.p10, 1);
  assert.equal(summary.scoreStats.p90, 4);
  assert.equal(summary.scoreStats.spreadMedian, 2); // [0,1,2,4,10] 的中位
  // 老的日志行没有 scores：不能当成 0 分参与统计
  const legacy = summarizeUsage([{ ts: 1, kind: 'hit', ids: ['a.md'] }]);
  assert.equal(legacy.scoreStats.n, 0);
  assert.equal(legacy.scoreStats.median, 0);
  assert.ok(summary.scoreCurve, '汇总里要带上 minScore 代价曲线（面板与尺子同一份）');
  assert.ok(Array.isArray(summary.scoreCurve.points));
});

test('预算用量：只有带 budget/spent 的轮才统计，老行不拿 0 冒充', () => {
  const summary = summarizeUsage([
    // 五轮：用掉 95% / 80% / 50% / 100%（花超了要夹到 1）/ 没带字段的老行
    { ts: 1, kind: 'hit', ids: ['a.md'], budget: 600, spent: 570 },
    { ts: 2, kind: 'hit', ids: ['a.md'], budget: 600, spent: 480 },
    { ts: 3, kind: 'hit', ids: ['a.md'], budget: 600, spent: 300 },
    { ts: 4, kind: 'hit', ids: ['a.md'], budget: 600, spent: 700 },
    { ts: 5, kind: 'hit', ids: ['a.md'] },
  ]);
  assert.equal(summary.budgetUse.n, 4, '老行（没有 budget/spent）不进分母');
  // q() 是 nearest-rank 取低：[0.5,0.8,0.95,1] 的中位取下标 1（0.8）、p90 取下标 2（0.95）
  assert.equal(summary.budgetUse.median, 0.8);
  assert.equal(summary.budgetUse.p90, 0.95);
  assert.equal(summary.budgetUse.full, 2, '570/600 与 700/600 都算「顶到 95% 以上」');

  const none = summarizeUsage([{ ts: 1, kind: 'hit', ids: ['a.md'] }]);
  assert.deepEqual(none.budgetUse, { n: 0, median: 0, p90: 0, full: 0 }, '没有数据时是干净的零，不是 NaN');

  // 判据要把用量说出来：光看「截断了几轮」看不出上限是不是真的不够
  const tight = summarizeUsage([
    { ts: 1, kind: 'hit', ids: ['a.md'], budget: 600, spent: 590, collapsed: 2 },
    { ts: 2, kind: 'hit', ids: ['b.md'], budget: 600, spent: 590, collapsed: 1 },
  ]);
  assert.match(budgetVerdict(tight), /预算在砍内容/);
  assert.match(budgetVerdict(tight), /预算中位用掉 98%/);
  assert.match(budgetVerdict(tight), /2\/2 轮顶到 95% 以上/);
  assert.doesNotMatch(budgetVerdict(tight), /NaN|undefined/);
});
