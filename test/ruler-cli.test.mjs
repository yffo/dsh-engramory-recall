/**
 * `scripts/recall-stats.mjs`（命令行尺子）的**参数处理与输出分支**契约。
 *
 * 为什么单独铺这一份：`test/ruler.test.mjs` 钉的是「分子分母同量纲」这条口径，
 * 而这把尺子还有个更容易出事的表面 —— 它读的是人手敲的参数（`--positions` / `--limit`
 * / `--store` / 未知参数），且账本可能根本不在、可能是空的、可能被写到一半杀了进程。
 * 尺子的口径已经错过两次真 bug，所以参数与分支要逐条钉死：
 *
 *   1. 账本缺失/是空文件/只有半截 JSON ⇒ 给人话、退出码 0、stderr 干净（绝不抛栈）；
 *   2. `--json` 任何情况下都可 `JSON.parse`，`summary` 关键字段在场（口径可核对）；
 *   3. 参数边界（`--positions 0|2.5|abc|-3`、`--limit 0|-1|abc|5`）按 0.13.14 的「不静默改输入」口径钉住；
 *   4. `--store` 指到没有账本的目录 / 不存在的目录 / 一个文件 ⇒ 一律当「没有账本」；
 *   5. 未知参数与多出来的位置参数被忽略（不报错、不改输出）；
 *   6. `--help` / `-h` 打印用法且不读账本；未知选项在 stderr 点一句、stdout 不变；
 *   7. 「多出来一个位置参数」与「`--max-pointers` 给不给」的两个输出分支。
 *
 * 纪律：全程只碰 `mkdtempSync` 造的临时库（在 `finally` 里删干净），
 * **绝不给 `--store` 传空串或省略它** —— 那会静默回落到真账本 `~/memory/engramory`
 * （见下面「空值参数」一节的注释）；不联网、不起 daemon、整文件秒级跑完。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { USAGE_FILE } from '../usage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULER = join(root, 'scripts', 'recall-stats.mjs');

/** 跑一次尺子（真子进程），返回 `{ status, stdout, stderr }` —— 任何参数组合都不该让它崩。 */
function run(args) {
  const res = spawnSync(process.execPath, [RULER, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * 造一个临时库（条目 = `[文件名, 内容]`），把 dir 交给回调，**finally 里删干净**。
 * 回调里可以跑多次尺子（比对两份输出时路径必须一致）。
 */
function withStore(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-ruler-cli-'));
  try {
    for (const [name, body] of entries) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 账本条目：把日志行写成 `.engramory-recall.jsonl`（空数组就写一个 0 字节文件）。 */
const ledger = (...lines) => [[USAGE_FILE, lines.length ? `${lines.map((line) => JSON.stringify(line)).join('\n')}\n` : '']];

/** 一次拿全「有注入、有打开、有跳过原因」的临时库跑一遍，返回 stdout；多数用例只要报告文本。 */
function report(lines, extraArgs = []) {
  return withStore(ledger(...lines), (dir) => run(['--store', dir, ...extraArgs]).stdout);
}

/** 报告里的位置级表格行（`| 第 N 条 | ... |`）。 */
const positionRows = (out) => out.match(/^\| 第 \d+ 条 \|.*$/gm) ?? [];

const HIT3 = { ts: 1000, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'], scores: [5, 4, 3], scope: 'main' };

// ── 1. 账本不在（三种「不在」）────────────────────────────────────────────────
test('账本不存在 / 目录不存在 / 路径是个文件：三种都当「没有账本」，给人话、退出码 0、stderr 干净', () => {
  const results = withStore([['afile', 'not a ledger\n']], (dir) => [
    run(['--store', dir]),                               // 目录在，账本还没落盘
    run(['--store', join(dir, 'nope', 'deeper')]),        // 目录不存在
    run(['--store', join(dir, 'afile')]),                 // 路径本身是个文件
  ]);

  for (const [i, res] of results.entries()) {
    assert.equal(res.status, 0, `场景 ${i} 必须退出码 0（缺账本不是错误）`);
    assert.match(res.stdout, /还没有这份日志/, `场景 ${i} 要给人话`);
    assert.match(res.stdout, /0\.13\.1 起才落的盘/, `场景 ${i} 要说明为什么没有（而不是空表）`);
    assert.equal(res.stderr, '', `场景 ${i} 不该往 stderr 写东西`);
    assert.doesNotMatch(`${res.stdout}${res.stderr}`, /Error|at .*:\d+:\d+|TypeError/, `场景 ${i} 不许抛栈`);
  }
});

// ── 2. 账本存在但空 / 只有坏行 ────────────────────────────────────────────────
test('空账本文件：走「0 行」报告 + 「还没有可用的配对」分支（不是「还没有这份日志」那条）', () => {
  const res = withStore(ledger(), (dir) => run(['--store', dir]));

  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /0 行 · — → —/, '空账本要知道：文件在，但没有可用行');
  assert.doesNotMatch(res.stdout, /还没有这份日志/, '文件存在时不能再说「还没有这份日志」——那是另一条分支');
  assert.match(res.stdout, /还没有可用的（分, 是否被打开）配对 —— 0 轮日志没有 scores 字段/, '曲线为空时要说明原因，不能印空表');
  assert.match(res.stdout, /\| （还没有带原因的记录） \| 0 \| — \|/, '没有原因记录时占位一行，别印空表');
  assert.doesNotMatch(res.stdout, /NaN|undefined|Infinity/, '空账本也不许出现脏值');
});

test('只有坏行（半截 JSON + 空行）：坏行被跳过，仍给完整报告、退出码 0、不抛', () => {
  // 写到一半被杀的账本：半截 JSON、非 JSON 文本、空行混在一起
  const broken = `{"ts":1,"kind":"hi\nnot json at all\n\n{"ts":2,"kind":"hit","ids":["a.md"]`;
  const res = withStore([[USAGE_FILE, broken]], (dir) => run(['--store', dir]));

  assert.equal(res.status, 0, '坏账本不能把尺子弄崩');
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /0 行 · — → —/, '坏行全被 JSON.parse 挡掉 ⇒ 等于 0 行');
  assert.match(res.stdout, /0 轮分数与文件名对不上号/, '照常走到曲线为空那条分支');
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /SyntaxError|Unexpected|at .*:\d+:\d+/, '不许把 JSON.parse 的异常漏到屏幕上');
});

// ── 3. --json ────────────────────────────────────────────────────────────────
test('--json：账本不在时也吐可解析 JSON（不吐人话），lines=0 且 file 指向那一份路径', () => {
  const res = withStore([], (dir) => run(['--store', dir, '--json']));

  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  assert.doesNotMatch(res.stdout, /还没有这份日志/, '--json 是给机器读的，不能混人话');
  const parsed = JSON.parse(res.stdout);
  assert.ok(Object.hasOwn(parsed, 'store') && Object.hasOwn(parsed, 'file') && Object.hasOwn(parsed, 'lines') && Object.hasOwn(parsed, 'summary'));
  assert.equal(parsed.lines, 0);
  assert.equal(parsed.summary.pointers, 0);
  assert.equal(parsed.summary.openRate, 0, '没有分母时打开率是 0，不是 NaN');
});

test('--json 的 summary 关键字段在场（尺子的每个数都要能核对口径）', () => {
  const out = report([
    { ts: 1000, kind: 'hit', ids: ['a.md', 'b.md', 'c.md'], scores: [9, 6, 3], scope: 'main', budget: 600, spent: 570, collapsed: 1 },
    { ts: 2000, kind: 'used', id: 'a.md', via: 'read', lagMs: 1500 },
    { ts: 3000, kind: 'skip', reason: 'chitchat' },
    { ts: 4000, kind: 'empty', reason: 'no-hits' },
    { ts: 5000, kind: 'sediment' },
    { ts: 6000, kind: 'deny' },
    { ts: 7000, kind: 'opened', id: 'z.md' },
  ], ['--json']);
  const { summary: s, lines } = JSON.parse(out);

  assert.equal(lines, 7, '7 行账目一条不少');
  assert.equal(s.injectRounds, 1);
  assert.equal(s.pointers, 3);
  assert.equal(s.used, 1, '原始打开次数');
  assert.equal(s.usedCounted, 1, '去重后的打开条数');
  assert.ok(Math.abs(s.openRate - 1 / 3) < 1e-9, '3 条指针打开 1 条 ⇒ 1/3');
  assert.equal(s.coldOpens, 1, '没注入也被打开的对照组');
  assert.equal(s.uniqueNotes, 3);
  assert.equal(s.collapsed, 1);
  assert.equal(s.budgetRounds, 1);
  assert.equal(s.denyRounds, 1);
  assert.equal(s.sedimentRounds, 1);
  assert.deepEqual(s.skipReasons, { chitchat: 1 });
  assert.deepEqual(s.emptyReasons, { 'no-hits': 1 });
  assert.equal(s.scopes.main.pointers, 3);
  assert.equal(s.scopes.subagent.pointers, 0);
  assert.equal(s.positions.length, 5, '默认 5 个位置');
  assert.deepEqual(
    [s.positions[0].injected, s.positions[0].opened, s.positions[3].injected],
    [1, 1, 0],
    '位置级：第 1 条注入 1 次、被打开 1 次；超出条数的位置是 0 而不是缺行',
  );
  assert.deepEqual(s.perRound, { min: 3, median: 3, p90: 3, max: 3, windowLimit: 0, fullRounds: 0 });
  assert.deepEqual(s.scoreCurve.legacy, 0);
  assert.deepEqual(s.scoreCurve.unaligned, 0);
  assert.equal(s.scoreCurve.n, 3);
  assert.equal(s.openLag.median, 1500, 'lagMs 原样进统计');
  assert.equal(s.scoreStats.median, 9);
  assert.equal(s.budgetUse.n, 1);
  assert.equal(s.firstAt, 1000);
  assert.equal(s.lastAt, 7000, '时间戳跨 7 行，末条为准');
});

// ── 4. --positions 边界 ──────────────────────────────────────────────────────
test('--positions 0：不是正整数 ⇒ 按默认 5 格算，并在 stderr 说清楚（0.13.14 起不再静默吞掉）', () => {
  const res = withStore(ledger(HIT3), (dir) => run(['--store', dir, '--positions', '0']));
  assert.equal(res.status, 0);
  assert.equal(positionRows(res.stdout).length, 5, '0 ⇒ 默认 5（不是 1、也不是 0 行）');
  assert.match(res.stdout, /^\| 第 5 条 \|/m);
  assert.match(res.stderr, /--positions 需要一个正整数（收到 "0"）——按默认 5 算/, '改了用户的输入就要说，别悄悄改');
});

test('--positions 2.5：向下取整成 2 格（小数不越界、不崩），指针总数仍按真实条数算', () => {
  const out = report([HIT3], ['--positions', '2.5']);

  assert.deepEqual(positionRows(out), ['| 第 1 条 | 1 | 0 | 0.0% |', '| 第 2 条 | 1 | 0 | 0.0% |'], 'floor(2.5)=2 格，两行都在');
  assert.equal(positionRows(out).length, 2, '第 2.5 格不存在：既不印第 3 条，也不写越界的空行');
  assert.match(out, /\| 注入指针 \| 3（平均 3\.0 条\/轮） \|/, '位置表格变窄不影响分母');
});

test('--positions abc（NaN）/ -3（负数）：都按默认 5 格算并各说一句，退出码 0', () => {
  const bad = withStore(ledger(HIT3), (dir) => run(['--store', dir, '--positions', 'abc']));
  const neg = withStore(ledger(HIT3), (dir) => run(['--store', dir, '--positions', '-3']));

  assert.equal(bad.status, 0, 'NaN 不该崩');
  assert.equal(positionRows(bad.stdout).length, 5, 'abc ⇒ 默认 5 格');
  assert.match(bad.stderr, /--positions 需要一个正整数（收到 "abc"）/);
  assert.equal(neg.status, 0, '负数不该崩');
  assert.equal(positionRows(neg.stdout).length, 5, '负数也是「不是正整数」⇒ 默认 5（过去会被 Math.max(1,…) 收敛成 1，口径不一致）');
  assert.match(neg.stderr, /--positions 需要一个正整数（收到 "-3"）/);
});

test('空值参数：`--positions ""` 按默认 5 格并提示；`--store ""` 直接退出 2（不许悄悄读真账本）', () => {
  const empty = withStore(ledger(HIT3), (dir) => run(['--store', dir, '--positions', '']));
  assert.equal(empty.status, 0);
  assert.equal(positionRows(empty.stdout).length, 5, '空串 = 没给 ⇒ 默认 5');
  assert.match(empty.stderr, /--positions 需要一个正整数（收到 ""）/);

  // 0.13.14 之前的真隐患：`--store ''` 静默回落到 `~/memory/engramory` —— 想读一个临时目录
  // 却读到线上账本，是最坏的那类「悄悄」。现在当场退出 2，绝不打开任何账本。
  const noStore = run(['--store', '', '--json']);
  assert.equal(noStore.status, 2, '空 store 是用法错误，不是「用默认库」');
  assert.equal(noStore.stdout, '', '一条报告都不许出：它连账本都没该打开');
  assert.match(noStore.stderr, /--store 需要一个目录/);
});

// ── 5. --limit 边界 ──────────────────────────────────────────────────────────
test('--limit 0 与 --limit abc：都按默认 2000 算（12 行全读进来），提示只走 stderr 不污染 JSON', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ ts: i + 1, kind: 'hit', ids: [`n${i}.md`], scores: [5], scope: 'main' }));
  const zero = withStore(ledger(...lines), (dir) => run(['--store', dir, '--limit', '0', '--json']));
  const nan = withStore(ledger(...lines), (dir) => run(['--store', dir, '--limit', 'abc', '--json']));

  assert.equal(JSON.parse(zero.stdout).lines, 12, '0 不是正整数 ⇒ 默认 2000');
  assert.match(zero.stderr, /--limit 需要一个正整数（收到 "0"）/);
  assert.equal(JSON.parse(nan.stdout).lines, 12, 'NaN ⇒ 默认 2000');
  assert.match(nan.stderr, /--limit 需要一个正整数（收到 "abc"）/);
});

test('--limit 负数按默认 2000；--limit 5 收到下限 10 —— 两种都当场说明按什么算的', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ ts: i + 1, kind: 'hit', ids: [`n${i}.md`], scores: [5], scope: 'main' }));
  const neg = withStore(ledger(...lines), (dir) => run(['--store', dir, '--limit', '-1', '--json']));
  const small = withStore(ledger(...lines), (dir) => run(['--store', dir, '--limit', '5', '--json']));

  assert.equal(neg.status, 0, '负数不该崩');
  assert.equal(JSON.parse(neg.stdout).lines, 12, '-1 不是正整数 ⇒ 默认 2000（12 行全读）');
  assert.match(neg.stderr, /--limit 需要一个正整数（收到 "-1"）/);
  assert.equal(JSON.parse(small.stdout).lines, 10, '--limit 5 拿到下限 10 —— 差值由那行提示交代，不再无声无息');
  assert.match(small.stderr, /--limit 5 低于下限 10——按下限 10 算/);
});

// ── 6. 未知参数 / 位置参数 / --help ──────────────────────────────────────────
test('未知参数：报告照旧（stdout 与不带时逐字节相同），但每个不认识的选项都在 stderr 点一句', () => {
  const [plain, noisy] = withStore(ledger(HIT3, { ts: 2000, kind: 'used', id: 'a.md', via: 'read' }), (dir) => [
    run(['--store', dir]),
    run(['--store', dir, '--bogus', '42', 'extra-note.md', '-x']),
  ]);

  assert.equal(noisy.status, 0, '未知参数不该变成错误退出');
  assert.equal(noisy.stdout, plain.stdout, '既不报错也不改口径：两份输出逐字节相同');
  assert.match(noisy.stderr, /不认识的参数：--bogus/, '打错的选项要说 —— 否则 `--strore` 会让人对着错误的账本看半天');
  assert.match(noisy.stderr, /不认识的参数：-x/);
  assert.doesNotMatch(noisy.stderr, /extra-note\.md/, '位置参数不抱怨（尺子不看位置参数）');
});

test('--help / -h：打印用法、退出 0，且**不去读账本**（0.13.14 起才有这条分支）', () => {
  for (const flag of ['--help', '-h']) {
    const res = run([flag]);
    assert.equal(res.status, 0, `${flag} 是正常退出`);
    assert.match(res.stdout, /用法：node scripts\/recall-stats\.mjs/);
    assert.match(res.stdout, /--store <目录>/);
    assert.match(res.stdout, /--json/);
    assert.doesNotMatch(res.stdout, /召回日志：/, `${flag} 不该顺手把真账本读一遍`);
    assert.equal(res.stderr, '');
  }
});

// ── 7. --max-pointers 的两个输出分支 ────────────────────────────────────────
test('--max-pointers 2：印出「（上限 2）」与「顶到上限的轮数 1/1」；不给就整行不印', () => {
  const hit2 = { ts: 1000, kind: 'hit', ids: ['a.md', 'b.md'], scores: [5, 4], scope: 'main' };
  const [capped, uncapped] = withStore(ledger(hit2), (dir) => [
    run(['--store', dir, '--max-pointers', '2']),
    run(['--store', dir]),
  ]);

  assert.match(capped.stdout, /\| 每轮注入条数 \| 最少 2 · 中位 2 · p90 2 · 最多 2（上限 2） \|/);
  assert.match(capped.stdout, /\| 顶到上限的轮数 \| 1\/1 \|/, '2 条指针顶到上限 2 ⇒ 1/1 轮用满');
  assert.doesNotMatch(uncapped.stdout, /顶到上限的轮数|（上限/, '不给 --max-pointers 就不冒充「用满了几轮」');
});

// ── 8. 「为什么没注入」的原因表 ──────────────────────────────────────────────
test('原因表：跳过与空手同一张表、已知码翻人话、未知码原样印、缺 reason 记「没记原因」', () => {
  const out = report([
    HIT3,
    { ts: 2000, kind: 'skip', reason: 'chitchat' },
    { ts: 3000, kind: 'skip', reason: 'weird-code' },
    { ts: 4000, kind: 'empty', reason: 'no-hits' },
    { ts: 5000, kind: 'empty' },
  ]);

  // 0.15.0 起这张表**只此一份**（usage.js 的 REASON_LABELS）：CLI 不再自带一套短文案，
  // 面板与周报说同一句话。所以这里钉的是 usage.js 的原文，而不是 CLI 自己的措辞。
  assert.match(out, /\| 寒暄 \/ 答话（设计如此） \| 1 \| 跳过 \|/, '已知码翻成 usage.js 那套人话');
  assert.match(out, /\| weird-code \| 1 \| 跳过 \|/, '没列过的码原样印出来，别把新码藏起来');
  assert.match(out, /\| 一条都不匹配 \| 1 \| 空手 \|/, '空手轮与跳过轮同一张表、靠「是哪一类」区分');
  assert.match(out, /\| 没记原因（早期日志） \| 1 \| 空手 \|/, '缺 reason 归 unspecified，不冒充设计性安静');

  // 只看这张表这一段：判据一节也会引用原因码，别把两处的位置混起来比。
  const table = out.slice(out.indexOf('## 为什么会没注入'), out.indexOf('\n注入分：'));
  const order = ['寒暄 / 答话（设计如此）', 'weird-code', '一条都不匹配', '没记原因'].map((label) => table.indexOf(label));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `轮数相同时：跳过行在前、空手行在后（顺序稳定不抖），实际位置 ${order.join(',')}`,
  );
});

// ── 9. 完整报告：每一个可选小节都在场 ────────────────────────────────────────
test('完整报告：按提问者拆开 / 打开延迟 / 预算用量 / 分曲线 / 从没打开过的注入，各节都印、都不出脏值', () => {
  const out = report([
    { ts: 1000, kind: 'hit', ids: ['a.md', 'b.md'], scores: [9, 3], scope: 'main', budget: 600, spent: 570 },
    { ts: 2000, kind: 'hit', ids: ['c.md'], scores: [7], scope: 'subagent' },
    { ts: 3000, kind: 'hit', ids: ['d.md', 'e.md'], scores: [8, 6] }, // 没有 scope = 0.13.7 之前的老行
    { ts: 4000, kind: 'used', id: 'a.md', via: 'read', lagMs: 100 },
    { ts: 5000, kind: 'used', id: 'a.md', via: 'read', lagMs: 500 },  // 同一轮重复读 ⇒ 分子只算一次
    { ts: 6000, kind: 'used', id: 'c.md', via: 'read', lagMs: 1500 },
    { ts: 7000, kind: 'used', id: 'd.md', via: 'read', lagMs: 2500 },
    { ts: 8000, kind: 'used', id: 'e.md', via: 'read', lagMs: 4000 },
  ]);

  assert.match(out, /## 按提问者拆开：主对话 vs 委派轮/);
  assert.match(out, /\| 主对话轮 \| 1 \| 2 \| 1 \| 50\.0% \|/, '主对话轮：2 条指针打开 1 条（重复读只算一次）');
  assert.match(out, /\| 子代理轮 \| 1 \| 1 \| 1 \| 100\.0% \|/);
  assert.match(out, /\| 未标记（0\.13\.7 前） \| 1 \| 2 \| 2 \| 100\.0% \|/, '没有 scope 的老行归「未标记」，不混进主对话轮');

  assert.match(out, /\| 打开得多快（距注入） \| 中位 1\.5 秒 · p90 2\.5 秒 \|/, '5 个 lag ⇒ 中位 1500ms、p90 2500ms');
  assert.match(out, /\| 预算用掉（中位 \/ p90） \| 95% \/ 95%（1 轮有记录） \|/);
  assert.match(out, /\| 顶到 95% 以上的轮 \| 1\/1 \|/);

  assert.match(out, /## 把 minScore 抬高会付出什么[\s\S]*\| ≥ 9\.001 \| 0 \| 5 \| 100\.0% \|/, '有配对就印门槛表，最高门槛那一行砍光 5 条');
  assert.match(out, /（配对 5 条指针 \/ 3 轮；进不了曲线的：0 轮老日志、0 轮对不上号）/);

  assert.match(out, /## 从没被打开过的注入（按注入次数排）[\s\S]*\| b\.md \| 1 \|/, '一次都没打开过的笔记要单独列出来');
  assert.equal((out.match(/\| a\.md \|/g) ?? []).length, 0, '被打开过的 a.md 不该出现在「从没被打开过」表里');
  assert.doesNotMatch(out, /NaN|undefined|Infinity/, '多节齐出也不许有脏值');
});

// ── 10. --store 的 ~ 展开 ────────────────────────────────────────────────────
test('--store 支持 ~ 展开：`~` ⇒ HOME、`~/x` ⇒ HOME/x（都不碰真账本）', () => {
  const home = homedir();
  // JSON 模式的断言只跟路径有关，不依赖 HOME 下那份文件存不存在（更不会去读 ~/memory/engramory）。
  const bare = run(['--store', '~', '--json']);
  const sub = run(['--store', '~/engramory-cli-test-missing-dir', '--json']);

  assert.equal(bare.status, 0);
  assert.equal(JSON.parse(bare.stdout).store, home, '`~` 展开成 HOME');
  assert.equal(JSON.parse(bare.stdout).file, join(home, USAGE_FILE));
  assert.equal(JSON.parse(sub.stdout).store, join(home, 'engramory-cli-test-missing-dir'), '`~/x` 展开成 HOME/x');
  assert.equal(JSON.parse(sub.stdout).lines, 0, '不存在的目录 ⇒ 0 行，不是崩');
});
