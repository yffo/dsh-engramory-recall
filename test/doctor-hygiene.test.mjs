// doctor.js 两项「记忆卫生」结论（`never-used` / `stale-project`）的契约测试。
//
// 这两项与前 12 项有个根本区别：前 12 项只看文件本身，这两项要读**台账**
// （`.engramory-recall.jsonl` 的携带/使用记录 + `.engramory-audit.jsonl` 的写入记录）。
// 所以每个用例不只问「报了什么」，还要问「账本不在时体检闭不闭嘴」——
// 把「不知道」说成「没问题」，比漏报一条更坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditStore } from '../doctor.js';
import { GATE_DEFAULTS } from '../confidence.js';
import { appendUsage, readUsage } from '../usage.js';
import { appendAudit, readAudit } from '../audit.js';

const NOW = Date.parse('2026-10-16T00:00:00Z');
const DAY = 86400000;
const MIN = 60000;

/** 一行「这一轮把 ids 带进了上下文」——与 `index.js#record()` 落盘的形状一致。 */
const hit = (ts, ids) => ({ ts, kind: 'hit', ids, injected: ids.length });
/** 一行「模型读了被注入过的笔记」：门控只认这个才算「被用上」。 */
const used = (ts, id) => ({ ts, kind: 'used', id, via: 'read', lagMs: 1000 });
/** 同一篇被携带 n 次（每次一个不同的时刻，模拟n 个不同的轮）。 */
const carriedN = (n, id) => Array.from({ length: n }, (_, i) => hit(NOW - DAY - i * MIN, [id]));

function makeStore(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-doctor-hygiene-'));
  for (const [file, text] of Object.entries(notes)) writeFileSync(join(dir, file), text);
  writeFileSync(join(dir, 'MEMORY.md'), `${Object.keys(notes).map((f) => `- [${f}](${f})`).join('\n')}\n`);
  return dir;
}

function note(name, opts = {}) {
  const { description = '一句话说明', type = 'reference', updated = '2026-10-16', body = '正文内容' } = opts;
  return `---
name: ${name}
description: ${description}
type: ${type}
created: 2026-01-01
updated: ${updated}
---

${body}
`;
}

/** 把文件的 mtime 往回拨 `days` 天 —— 过期判据量的是「这个文件多久没被写过」。 */
const setAge = (dir, file, days) => utimesSync(join(dir, file), new Date(NOW), new Date(NOW - days * DAY));

const codes = (r) => r.findings.map((f) => f.code);
const ofCode = (r, code) => r.findings.filter((f) => f.code === code);

test('a. 携带 20 次一次没用 → warn never-used；只带过 3 次的不出（样本不够）', (t) => {
  const dir = makeStore({ 'reference-hot.md': note('reference-hot'), 'reference-thin.md': note('reference-thin') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, {
    now: NOW,
    usageLines: [...carriedN(20, 'reference-hot.md'), ...carriedN(3, 'reference-thin.md')],
  });
  const hits = ofCode(r, 'never-used');
  assert.equal(hits.length, 1, `只该报证据够多的那一篇：${JSON.stringify(hits.map((f) => f.files))}`);
  assert.deepEqual(hits[0].files, ['reference-hot.md']);
  assert.equal(hits[0].severity, 'warn');
  // 文案逐字钉住：数字必须是账本里的真数字，且要指出去哪改
  assert.equal(
    hits[0].message,
    '被带进上下文 20 次、一次都没被用上—— 它每轮都在占预算：改写 description 让它更容易被认出来，或合并进相关笔记',
  );
  // 没有自我触碰时不许提那一句（提了就是在编数字）
  assert.doesNotMatch(hits[0].message, /写完自己马上读回/);
});

test('a2. 「样本够不够」的线取自 GATE_DEFAULTS.minEvidence，不是体检自己抄的一个数', (t) => {
  const dir = makeStore({ 'reference-edge.md': note('reference-edge') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = (n) => auditStore(dir, { now: NOW, usageLines: carriedN(n, 'reference-edge.md') });
  const under = GATE_DEFAULTS.minEvidence - 1;
  assert.ok(!codes(at(under)).includes('never-used'), `${under} 次（差一次）就该忍住`);
  assert.ok(codes(at(GATE_DEFAULTS.minEvidence)).includes('never-used'), `${GATE_DEFAULTS.minEvidence} 次（到线）就该报`);
});

test('b. 写完 2 分钟又读回来的那一次不算用上 → 仍然 never-used，且文案如实说明', (t) => {
  const dir = makeStore({
    'reference-echo.md': note('reference-echo'),
    'reference-independent.md': note('reference-independent'),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const readAt = NOW - 2 * DAY;
  const r = auditStore(dir, {
    now: NOW,
    usageLines: [
      ...carriedN(20, 'reference-echo.md'),
      ...carriedN(20, 'reference-independent.md'),
      used(readAt, 'reference-echo.md'),
      used(readAt, 'reference-independent.md'),
    ],
    auditLines: [
      // 刚写完（2 分钟前）又读回来：这是自我触碰，不能算「这篇被独立用上了」
      { ts: readAt - 2 * MIN, file: 'reference-echo.md', verdict: 'allow', tool: 'write' },
      // 半小时前写的，早出了自我触碰窗口：这一读是真·独立使用，不该被扣掉
      { ts: readAt - 30 * MIN, file: 'reference-independent.md', verdict: 'allow', tool: 'write' },
    ],
  });
  const hits = ofCode(r, 'never-used');
  assert.deepEqual(hits.map((f) => f.files[0]), ['reference-echo.md'], '只有「写完自己马上读回」的那篇该被报');
  assert.equal(
    hits[0].message,
    '被带进上下文 20 次、一次都没被用上（另有 1 次是写完自己马上读回，不算用上）—— 它每轮都在占预算：改写 description 让它更容易被认出来，或合并进相关笔记',
  );
});

test('c. stale-project：400 天没更新的 project- 报 info，同样 400 天的 reference- 不报', (t) => {
  const dir = makeStore({
    'project-ancient.md': note('project-ancient', { type: 'project' }),
    'reference-ancient.md': note('reference-ancient'),
    'project-mid.md': note('project-mid', { type: 'project' }),
    'project-archived-history.md': note('project-archived-history', { type: 'project' }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setAge(dir, 'project-ancient.md', 400);
  setAge(dir, 'reference-ancient.md', 400);
  setAge(dir, 'project-mid.md', 90);
  setAge(dir, 'project-archived-history.md', 400);
  const usageLines = carriedN(1, 'project-ancient.md');
  const r = auditStore(dir, { now: NOW, usageLines });
  const hits = ofCode(r, 'stale-project');
  assert.equal(hits.length, 1, `reference 不是「正在做的事」，90 天的 project 也没到线：${JSON.stringify(hits)}`);
  assert.deepEqual(hits[0].files, ['project-ancient.md']);
  // 过期只提醒、不当过错：它是「往后排」，不是「库坏了」
  assert.equal(hits[0].severity, 'info');
  assert.equal(hits[0].message, '这份「正在做的事」已经 400 天没更新（还活着吗）：要么更新、要么归档');
  // 归档产物是冻结的派生文件：同样 400 天，但它既不「正在做」也无从「更新」，
  // 报它只会每年给每份归档刷一条动不了的提醒（duplicate-topic 踩过同一个坑）
  assert.ok(
    !ofCode(r, 'stale-project').some((f) => f.files.includes('project-archived-history.md')),
    '归档产物不该被当成「正在做的事」',
  );
  // 阈值可调（`options.staleDays`）：门槛降到 60 天，90 天那篇就该冒出来
  // （顺序 = 逐篇循环的顺序，也就是文件名排序）
  assert.deepEqual(ofCode(auditStore(dir, { now: NOW, usageLines, staleDays: 60 }), 'stale-project').map((f) => f.files[0]), [
    'project-ancient.md',
    'project-mid.md',
  ]);
});

test('d. 完全没有账本 → 两项新结论一项都不出，原有检查照常工作', (t) => {
  const dir = makeStore({
    'reference-no-desc.md': note('reference-no-desc', { description: '' }),
    'project-ancient.md': note('project-ancient', { type: 'project' }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setAge(dir, 'project-ancient.md', 400);
  const r = auditStore(dir, { now: NOW });
  assert.ok(!codes(r).includes('never-used'), '没有账本还说「它从没被用上」就是编的');
  assert.ok(!codes(r).includes('stale-project'), '两项卫生结论统一挂在「有账本」上（旧库输出逐字不变）');
  assert.ok(codes(r).includes('missing-description'), '原有检查不受影响');

  // 账本文件在、但一行都没有：同样是「没有记录」，一样闭嘴
  writeFileSync(join(dir, '.engramory-recall.jsonl'), '');
  const empty = auditStore(dir, { now: NOW });
  assert.ok(!codes(empty).includes('never-used'));
  assert.ok(!codes(empty).includes('stale-project'));
  // 显式注入空数组（测试注入路径的「空」）也必须一样
  const injectedEmpty = auditStore(dir, { now: NOW, usageLines: [], auditLines: [] });
  assert.ok(!codes(injectedEmpty).includes('never-used'));
  assert.ok(!codes(injectedEmpty).includes('stale-project'));
});

test('e. 注入 usageLines/auditLines 与「自己读库里的账本」结果逐条一致', (t) => {
  const dir = makeStore({ 'project-ancient.md': note('project-ancient', { type: 'project' }), 'reference-hot.md': note('reference-hot') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setAge(dir, 'project-ancient.md', 400);
  // 用**真正的写入方**造账本：写进去的与读出来的就是同一套格式，
  // 将来账本字段改名/换文件，这个用例会跟着红，而不是悄悄变成空转。
  for (const line of [...carriedN(20, 'reference-hot.md'), ...carriedN(4, 'project-ancient.md')]) appendUsage(dir, line);
  appendAudit(dir, { tool: 'write', file: 'reference-hot.md', verdict: 'allow', ts: NOW - DAY });

  const selfRead = auditStore(dir, { now: NOW });
  const injected = auditStore(dir, { now: NOW, usageLines: readUsage(dir), auditLines: readAudit(dir) });
  // 先确认「自己读账本」这条路真的出了结论，否则下面的相等只是两个空数组相等
  assert.ok(codes(selfRead).includes('never-used'), `自己读账本这条路要能出 never-used：${JSON.stringify(codes(selfRead))}`);
  assert.ok(codes(selfRead).includes('stale-project'));
  assert.deepEqual(injected.findings, selfRead.findings);
});
