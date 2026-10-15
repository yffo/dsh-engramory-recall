/**
 * 写入审计（audit.js）单测：JSONL 的行保持、容量轮转的边界、坏行与坏路径的容错。
 *
 * 要钉的契约（源码注释里写死的那几条）：
 *   1. 一条记录一行、字段原样保真 —— 中文/换行/引号都不能把一条记录拆成两行；
 *   2. `readAudit` 新的在前、默认 40 条、文件不存在或损坏返回空数组；
 *   3. 超过 512 KiB 只留后半，且**仍在行边界**（不能留半行）；
 *   4. `appendAudit` **永不抛异常**（目录不存在/只读挂载/磁盘满都不该让一次记忆写入失败）。
 *
 * 全部落在 `mkdtempSync(join(tmpdir(), 'engramory-'))` 里 —— 不碰真实记忆库。
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AUDIT_FILE, GUARD_EPOCH, appendAudit, readAudit } from '../audit.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'engramory-'));

/** 每个用例自带一个临时库，跑完必删（断言失败也删）。 */
const withDir = (fn) => {
  const dir = tmp();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const fileOf = (dir) => join(dir, AUDIT_FILE);
const rawLines = (dir) => readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean);
const parseAll = (lines) => lines.map((line) => JSON.parse(line)); // 有一行半截就抛，正是我们要防的

/** `MAX_AUDIT_BYTES` 没有导出：从 audit.js:25 抄一份（512 KiB）。源码改了这里得跟着改。 */
const MAX_AUDIT_BYTES = 512 * 1024;

// ── 常量与落盘格式 ────────────────────────────────────────────────────────

test('审计常量：文件名固定，epoch 自带版本号', () => {
  assert.equal(AUDIT_FILE, '.engramory-audit.jsonl');
  assert.equal(typeof GUARD_EPOCH, 'string');
  assert.match(GUARD_EPOCH, /^guard-v\d+$/, 'epoch 要能一眼看出是哪一版闸门规则');
});

test('写入后读回：字段保真（中文/换行/引号），新的在前，每行带 ts 与 epoch', () => {
  withDir((dir) => {
    appendAudit(dir, { tool: 'edit', file: 'reference-proxy.md', bytes: 420, verdict: 'allow', reason: '正常写入' });
    const tricky = '缺 frontmatter\n第二行：中文 🫡 "引号" \\反斜杠\ttab';
    appendAudit(dir, { tool: 'write', file: 'naked.md', bytes: 13, verdict: 'deny', reason: tricky });

    const rows = readAudit(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tool, 'write', '新的在前');
    assert.equal(rows[1].tool, 'edit');
    assert.equal(rows[0].reason, tricky, '换行是真换行，不是字面量 \\n');
    assert.equal(rows[0].verdict, 'deny');
    assert.equal(rows[0].file, 'naked.md');
    assert.equal(rows[1].bytes, 420);
    for (const row of rows) {
      assert.equal(row.epoch, GUARD_EPOCH);
      assert.ok(Number.isFinite(row.ts) && row.ts > 1_600_000_000_000, '每行都该带落盘时刻');
    }
    // JSONL 的行数 === 写入次数：字段里的换行被转义，不会把一条记录拆成两行
    const raw = rawLines(dir);
    assert.equal(raw.length, 2, '一条记录一行');
    // 文件是追加序（老的在前），readAudit 才倒成「新的在前」：带换行的这条是文件里的第二行。
    assert.equal(raw[0].includes('\\n'), false, '普通记录不会被转义');
    assert.ok(raw[1].includes('\\n'), '换行在文件里是转义形式，不会把一条记录拆成两行');
  });
});

test('entry 里的 ts/epoch 覆盖默认值（展开顺序：默认值在前）', () => {
  withDir((dir) => {
    // 回放脚本要保留「当时的时刻」与「当时的规则版本」，所以显式给的值必须赢
    appendAudit(dir, { ts: 12345, epoch: 'guard-v0', tool: 'edit', verdict: 'allow' });
    const [row] = readAudit(dir);
    assert.equal(row.ts, 12345);
    assert.equal(row.epoch, 'guard-v0');
    assert.equal(row.tool, 'edit');

    appendAudit(dir, { tool: 'edit', verdict: 'allow' });
    assert.ok(readAudit(dir)[0].ts > 1_700_000_000_000, '没给才用 Date.now()');
    assert.equal(readAudit(dir)[1].ts, 12345);
  });
});

// ── 路径与容错：appendAudit 永不抛 ────────────────────────────────────────

test('appendAudit：目录不存在就建出来，照样落盘', () => {
  withDir((dir) => {
    const deep = join(dir, 'memory', 'engramory');
    appendAudit(deep, { tool: 'write', file: 'a.md', verdict: 'allow' });
    const rows = readAudit(deep);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file, 'a.md');
    assert.equal(statSync(join(deep, AUDIT_FILE)).isFile(), true);
  });
});

test('appendAudit：假 storePath 与「storePath 是个文件」都不抛，也不留副作用', () => {
  withDir((dir) => {
    for (const bogus of ['', null, undefined, 0]) {
      appendAudit(bogus, { tool: 'edit' }); // 一个字都不写，也不抛
    }
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x');
    appendAudit(asFile, { tool: 'edit', verdict: 'allow' }); // mkdirSync 必失败 → 被吞掉
    assert.equal(readFileSync(asFile, 'utf8'), 'x', '目标文件不被碰');
    assert.deepEqual(readAudit(asFile), [], '文件路径下没有审计文件，读回来是空数组');
  });
});

test('readAudit：文件/目录不存在都是空数组，不是抛异常', () => {
  withDir((dir) => {
    assert.deepEqual(readAudit(dir), [], '空目录（还没写过审计）');
    assert.deepEqual(readAudit(join(dir, 'missing')), []);
    assert.deepEqual(readAudit(join(dir, 'a', 'b', 'c')), []);
    assert.deepEqual(readAudit(''), [], '空 storePath：cwd 下没有这个文件');
    assert.deepEqual(readAudit(join(dir, '什么目录', '都没有')), []);
  });
});

// ── limit 语义 ───────────────────────────────────────────────────────────

test('limit：默认 40 条、取最近 N 条、新的在前', () => {
  withDir((dir) => {
    for (let i = 1; i <= 45; i += 1) appendAudit(dir, { tool: 'edit', seq: i });

    const all = readAudit(dir, 1000);
    assert.equal(all.length, 45);
    assert.equal(all[0].seq, 45);
    assert.equal(all.at(-1).seq, 1, '整体是「文件末尾 → 文件开头」的倒序');

    const def = readAudit(dir);
    assert.equal(def.length, 40, '默认 40 条');
    assert.deepEqual(def.map((row) => row.seq), Array.from({ length: 40 }, (_, i) => 45 - i), '取最近 40 条，仍是新的在前');
    assert.deepEqual(readAudit(dir, 3).map((row) => row.seq), [45, 44, 43]);
    assert.deepEqual(readAudit(dir, 1).map((row) => row.seq), [45]);
    assert.equal(readAudit(dir, 1e9).length, 45, 'limit 大于总数就全给');
  });
});

test('limit=0 的写实行为：slice(-0) 就是 slice(0)，返回全部（疑似 bug，见交付报告）', () => {
  withDir((dir) => {
    for (let i = 1; i <= 3; i += 1) appendAudit(dir, { tool: 'edit', seq: i });
    // 现状：`slice(-limit)` 里 limit=0 ⇒ `slice(-0)` ⇒ `slice(0)` ⇒ 全量。
    // 调用方想表达「一条都别显示」时会拿到整份日志（面板/脚本传 0 的语义陷阱）。
    assert.equal(readAudit(dir, 0).length, 3);
    // 负数 limit 也不是「不要」，而是「跳过开头 N 条再倒序」，同样反直觉：
    assert.deepEqual(readAudit(dir, -1).map((row) => row.seq), [3, 2]);
  });
});

// ── 坏行 ─────────────────────────────────────────────────────────────────

test('坏行：半截 JSON 跳过，合法但为假值的行丢掉，好行一个不少', () => {
  withDir((dir) => {
    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 1 });
    appendFileSync(fileOf(dir), '{"tool":"edit","verdict":"deny"\n'); // 写到一半被杀：半截行
    appendFileSync(fileOf(dir), 'null\n0\nfalse\n""\n'); // 合法 JSON 但假值：被 filter(Boolean) 丢掉
    appendFileSync(fileOf(dir), '{"tool":"write","verdict":"deny","seq":2}\n');

    assert.deepEqual(readAudit(dir).map((row) => row.seq), [2, 1], '坏行不影响别的行，也不占位置');
    assert.equal(rawLines(dir).length, 7, '坏行仍留在文件里（读的时候才跳过）');
    // limit 先按原始行切、再逐行解析 ⇒ 坏行白占名额：切 2 行只剩 1 条（写实）
    const tail = readAudit(dir, 2);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].seq, 2);

    writeFileSync(fileOf(dir), 'not json\n{"a":\n');
    assert.deepEqual(readAudit(dir), [], '整份都坏掉也只是空数组');
  });
});

// ── 体积上限与轮转 ────────────────────────────────────────────────────────

test('体积上限：只留后半、仍在行边界，且「恰好等于上限」不算超', () => {
  withDir((dir) => {
    // 每行正好 512 字节 ⇒ 1024 行正好 = 512 KiB = 上限
    const BASE_TS = 1_000_000_000; // 10 位，保证每行等长
    const PAD = 512 - `${JSON.stringify({ ts: BASE_TS, tool: 'edit', verdict: 'allow', pad: '' })}\n`.length;
    const lineOf = (i) => `${JSON.stringify({ ts: BASE_TS + i, tool: 'edit', verdict: 'allow', pad: 'y'.repeat(PAD) })}\n`;
    assert.equal(lineOf(0).length, 512, '先确认每行真的是 512 字节');

    const total = 1024;
    writeFileSync(fileOf(dir), Array.from({ length: total }, (_, i) => lineOf(i)).join(''));
    assert.equal(statSync(fileOf(dir)).size, MAX_AUDIT_BYTES);

    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'boundary' });
    assert.equal(rawLines(dir).length, total + 1, '恰好等于上限不轮转（判据是 size > MAX）');

    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'after-rotate' });
    const lines = rawLines(dir);
    assert.equal(lines.length, Math.floor((total + 1) / 2) + 1, '留后半（floor(1025/2)=512）再加刚写的那条');
    const parsed = parseAll(lines); // 任何一行半截都会在这里抛
    assert.equal(parsed[0].ts, BASE_TS + 513, '被留下的确实是「后半」的头一行');
    assert.equal(parsed.at(-2).seq, 'boundary', '刚写过的那条也在（它在后半里）');
    assert.equal(parsed.at(-1).seq, 'after-rotate');
    assert.ok(parsed.slice(0, -2).every((row, i, arr) => i === 0 || row.ts === arr[i - 1].ts + 1), '后半的顺序原样保留');
    assert.ok(statSync(fileOf(dir)).size < MAX_AUDIT_BYTES / 2 + 1024, '轮转后明显瘦下来');
  });
});

test('轮转的边界：单行就超过上限时 slice(-0) 让轮转空转（写实，疑似 bug）', () => {
  withDir((dir) => {
    // 单行超限 ⇒ lines.length === 1 ⇒ Math.floor(1/2) === 0 ⇒ slice(-0) === slice(0) ⇒ 整行留着。
    // 也就是说超大单行（比如一个巨大的 reason 字段）这一轮不会被削减。
    writeFileSync(fileOf(dir), `${JSON.stringify({ ts: 1, tool: 'edit', verdict: 'allow', reason: 'x'.repeat(MAX_AUDIT_BYTES + 16) })}\n`);
    const before = statSync(fileOf(dir)).size;
    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'after' });
    assert.equal(rawLines(dir).length, 2, '现状：单行文件不动刀，只多出刚写的那行');
    assert.ok(statSync(fileOf(dir)).size > before, '于是文件先涨过上限，要等下一次写入才收得回来');

    // 下一次写入时 lines.length === 2 ⇒ 只留 1 行，回到上限以内（自愈，但不是立刻）
    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'third' });
    assert.equal(rawLines(dir).length, 2);
    assert.equal(readAudit(dir)[0].seq, 'third');
    assert.ok(statSync(fileOf(dir)).size < MAX_AUDIT_BYTES, '自愈后回到上限以内');
  });
});

// ── epoch 变化 ───────────────────────────────────────────────────────────

test('GUARD_EPOCH 变化：旧行原样留着，不迁移、不过滤、不改写', () => {
  withDir((dir) => {
    // 旧规则（guard-v0）落下的行
    appendFileSync(fileOf(dir), `${JSON.stringify({ ts: 1, epoch: 'guard-v0', tool: 'edit', file: 'a.md', verdict: 'deny', reason: '老口径' })}\n`);
    appendAudit(dir, { tool: 'write', file: 'b.md', verdict: 'allow', reason: '新口径' });

    const rows = readAudit(dir);
    assert.equal(rows.length, 2, '两个版本的行都在：epoch 是给回放的人看的，读的时候不做筛选');
    assert.deepEqual(rows.map((row) => row.epoch), [GUARD_EPOCH, 'guard-v0'], '新的在前，各自带自己的 epoch');
    assert.equal(rows[1].verdict, 'deny', '旧裁决不会被今天的规则改写');
    assert.equal(rows[0].verdict, 'allow');
    // 想按 epoch 分开看是调用方的事（readAudit 不提供这个能力，也不该有）
    assert.equal(rows.filter((row) => row.epoch === GUARD_EPOCH).length, 1);
  });
});
