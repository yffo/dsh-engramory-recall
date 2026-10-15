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
  noteIdFromPath,
  pickInjected,
  readUsage,
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

test('召回汇总：判据在样本太小时不下结论', () => {
  assert.match(usageVerdict({ pointers: 4, openRate: 0.9 }), /样本太小/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.1 }), /偏低/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.9 }), /放宽/);
  assert.match(usageVerdict({ pointers: 100, openRate: 0.45 }), /中间档/);
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
