/**
 * `scripts/recall-stats.mjs`（打开率尺子）的输出契约。
 *
 * 这一条是被真数据咬出来的：0.13.10 把判据的口径改成「去重后的打开**条数**」，
 * 尺子的「分子」一节却还在印 `summary.used`（原始打开**次数**）——
 * 同一份报告里于是出现两套互相打架的打开率（12.6% vs 4.7%），
 * 而这一节恰恰是「窗口该收窄还是放宽」的唯一依据。
 *
 * 要钉的契约：
 *   1. 「注入后被打开」与「打开率」用**去重后**的条数（同一条指针在同一轮反复读只算一次）；
 *   2. 原始次数不丢，单列一行写明「未去重」；
 *   3. 没有打开记录时两个数字都是 0，不出现 NaN/undefined；
 *   4. `--json` 里 `usedCounted` / `used` / `openRate` 三个字段同时在场（口径可核对）。
 *
 * 用例全是真跑子进程 + 临时库，不碰真实记忆库。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { USAGE_FILE } from '../usage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULER = join(root, 'scripts', 'recall-stats.mjs');

/** 把给定的账行写成临时库，跑一次尺子，返回 stdout。 */
function runRuler(lines, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-ruler-'));
  try {
    if (lines.length) {
      writeFileSync(join(dir, USAGE_FILE), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    }
    return execFileSync(process.execPath, [RULER, '--store', dir, ...extraArgs], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('尺子的分子与判据同一口径：同一轮里反复打开只算一条，原始次数另列一行', () => {
  const out = runRuler([
    { ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [5, 4], scope: 'main', depth: 0 },
    { ts: 2, kind: 'used', id: 'a.md', via: 'read' },
    { ts: 3, kind: 'used', id: 'a.md', via: 'read' },
    { ts: 4, kind: 'used', id: 'a.md', via: 'edit' },
  ]);

  assert.match(out, /\| 注入后被打开 \| 1 \|/, '分子是去重后的条数');
  assert.match(out, /\| \*\*打开率\*\* \| \*\*50\.0%\*\* \|/, '2 条指针里打开过 1 条');
  assert.match(out, /\| 打开次数（未去重[^|]*\| 3 \|/, '原始 3 次照样看得见，只是不冒充打开率');
  assert.doesNotMatch(out, /12\.6%|150\.0%|NaN|undefined/, '不能出现两套打架的打开率，也不能有脏值');
});

test('一条都没打开：两个数字都是 0（不是 NaN、也不是空）', () => {
  const out = runRuler([{ ts: 1, kind: 'hit', ids: ['a.md'], scores: [5], scope: 'main', depth: 0 }]);
  assert.match(out, /\| 注入后被打开 \| 0 \|/);
  assert.match(out, /\| \*\*打开率\*\* \| \*\*0\.0%\*\* \|/);
  assert.match(out, /\| 打开次数（未去重[^|]*\| 0 \|/);
});

test('还没有日志：给一句人话（不是空表、不是 NaN），也不抛', () => {
  const out = runRuler([]);
  assert.match(out, /还没有这份日志/);
  assert.match(out, /0\.13\.1 起才落的盘/);
  assert.doesNotMatch(out, /NaN|undefined/);
});

test('--json：summary 里 usedCounted / used / openRate 三个字段同时在场，口径可核对', () => {
  const out = runRuler(
    [
      { ts: 1, kind: 'hit', ids: ['a.md', 'b.md'], scores: [5, 4], scope: 'main', depth: 0 },
      { ts: 2, kind: 'used', id: 'a.md', via: 'read' },
      { ts: 3, kind: 'used', id: 'a.md', via: 'read' },
    ],
    ['--json'],
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.summary.used, 2, '原始次数');
  assert.equal(parsed.summary.usedCounted, 1, '去重后的条数');
  assert.equal(parsed.summary.openRate, 0.5);
});

test('预算用量：有 budget/spent 就印出「用掉多少」，老行如实说「还没有」', () => {
  const withFields = runRuler([
    { ts: 1, kind: 'hit', ids: ['a.md'], scores: [5], budget: 600, spent: 570, collapsed: 1, scope: 'main', depth: 0 },
  ]);
  assert.match(withFields, /\| 预算用掉（中位 \/ p90） \| 95% \/ 95%（1 轮有记录） \|/);
  assert.match(withFields, /\| 顶到 95% 以上的轮 \| 1\/1 \|/);

  const legacy = runRuler([{ ts: 1, kind: 'hit', ids: ['a.md'], scores: [5], scope: 'main', depth: 0 }]);
  assert.match(legacy, /预算用掉 \| —（这些行没有 budget\/spent：0\.13\.13 起才落盘） \|/);
  assert.match(legacy, /被缩的条数 \/ 其中被打开 \| —（没有记着名单的截断轮/, '没名单时如实印「—」，不冒充 0');
  assert.doesNotMatch(legacy, /NaN|undefined/);
});

test('截断的代价：有名单时印出「被缩 vs 完整列出」两行对照，判据也跟上', () => {
  const collapsedIds = ['c1.md', 'c2.md'];
  const fullIds = ['f1.md', 'f2.md'];
  const lines = [
    { ts: 1, kind: 'hit', ids: [...collapsedIds, ...fullIds], scores: [9, 8, 7, 6], collapsed: 2, collapsedIds, budget: 600, spent: 600, scope: 'main', depth: 0 },
    ...[...collapsedIds, ...fullIds].map((id, i) => ({ ts: 10 + i, kind: 'used', id, lagMs: 100 })),
  ];
  const out = runRuler(lines);
  assert.match(out, /\| 被缩的条数 \/ 其中被打开 \| 2 \/ 2（100\.0%） \|/);
  assert.match(out, /\| 作对照：完整列出的 \/ 其中被打开 \| 2 \/ 2（100\.0%） \|/);
  assert.match(out, /- 被缩成裸文件名的 2 条里被打开过 2 条（100\.0%）/);
  assert.doesNotMatch(out, /NaN|undefined/);
});
