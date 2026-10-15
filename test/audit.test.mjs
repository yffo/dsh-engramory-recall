/**
 * 写入审计（audit.js）单测：JSONL 的行保持、容量轮转的边界、坏行与坏路径的容错。
 *
 * 要钉的契约（源码注释里写死的那几条）：
 *   1. 一条记录一行、字段原样保真 —— 中文/换行/引号都不能把一条记录拆成两行；
 *   2. `readAudit` 新的在前、默认 40 条、文件不存在或损坏返回空数组；
 *   3. 超过 512 KiB 只留后半，且**仍在行边界**（不能留半行）；
 *   4. `appendAudit` **永不抛异常**（目录不存在/只读挂载/磁盘满都不该让一次记忆写入失败）。
 *
 * 其它写实行为（同样在下面钉住，疑似 bug 的地方都写了「疑似 bug」）：
 *   5. entry 不做任何校验：字段类型不对也照写（`bytes: '420'`、`tool: null`），
 *      但显式 `ts: undefined` 会把默认的落盘时刻整个抹掉（它覆盖默认值，又被 JSON 丢掉）；
 *   6. 序列化失败（BigInt / 循环引用）⇒ 整条记录静默消失，调用方拿不到任何信号；
 *   7. limit 只要求「slice 能强转」：NaN / null / -0 都是全量，小数被截断，布尔被当成 0/1；
 *   8. 空行不占 limit 名额（`filter(Boolean)` 在 `slice` 之前），只有空格的「空白行」与坏行占名额；
 *   9. 轮转按**行数**减半而非字节减半：大行落在后半时，轮转完仍可能在上限之上。
 *
 * 全部落在 `mkdtempSync(join(tmpdir(), 'engramory-'))` 里 —— 不碰真实记忆库。
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('entry 不做校验：字段缺失/类型不对都原样落盘，但显式 ts:undefined 会把落盘时刻抹掉（疑似 bug）', () => {
  withDir((dir) => {
    appendAudit(dir, undefined); // 连 entry 都不给
    appendAudit(dir, {}); // 空对象：同上
    appendAudit(dir, { tool: null, bytes: '420', verdict: 0, extra: { a: [1, 2] } }); // 类型全不对
    appendAudit(dir, { ts: undefined, tool: 'edit' }); // 显式 undefined
    appendAudit(dir, { ts: 0, epoch: null, tool: 'edit' }); // 显式假值

    const rows = parseAll(rawLines(dir));
    assert.equal(rows.length, 5, '5 次调用 5 行 —— 没有一条因为「字段不对」被丢掉');
    for (const row of rows.slice(0, 2)) {
      assert.deepEqual(Object.keys(row).sort(), ['epoch', 'ts'], 'entry 缺什么就不写什么，不补 null');
      assert.equal(row.epoch, GUARD_EPOCH);
    }
    // 类型一概不校验：字符串的 bytes、null 的 tool、数字的 verdict、嵌套对象都原样进 JSON
    assert.deepEqual(rows[2], { ts: rows[2].ts, epoch: GUARD_EPOCH, tool: null, bytes: '420', verdict: 0, extra: { a: [1, 2] } });
    // 疑似 bug：`{ ...entry }` 里显式 undefined 覆盖掉默认 ts，JSON.stringify 又丢掉 undefined 键
    // ⇒ 这条记录**根本没有落盘时刻**，而审计的全部价值就是「什么时候发生了什么」。
    assert.deepEqual(rows[3], { epoch: GUARD_EPOCH, tool: 'edit' }, '现状：显式 ts:undefined 让记录没有 ts');
    assert.equal(Object.hasOwn(rows[3], 'ts'), false);
    // 而 0 / null 是「真的给了值」，照样赢过默认值（展开顺序：默认值在前）
    assert.deepEqual(rows[4], { ts: 0, epoch: null, tool: 'edit' });
  });
});

test('序列化失败（BigInt / 循环引用）：不抛，但整条记录静默消失（疑似 bug：审计会无声少一条）', () => {
  withDir((dir) => {
    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 1 });
    assert.equal(rawLines(dir).length, 1);

    // JSON.stringify 在 appendFileSync 之前求值 ⇒ 抛在外层 try 里被吞掉，调用方拿不到任何信号。
    const circular = { name: 'loop' };
    circular.self = circular;
    for (const bad of [{ bytes: 10n }, { nested: circular }, { big: BigInt(Number.MAX_SAFE_INTEGER) }]) {
      appendAudit(dir, { tool: 'edit', verdict: 'allow', ...bad }); // 不抛
    }

    assert.equal(rawLines(dir).length, 1, '三次失败一条都没落盘（也没有落半条）');
    assert.deepEqual(parseAll(rawLines(dir)).map((row) => row.seq), [1], '先前那条完好，文件仍是合法 JSONL');
    assert.deepEqual(readAudit(dir).map((row) => row.seq), [1], '读回来也看不出「刚才有三次审计丢了」');
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

test('AUDIT_FILE 的位置被目录占了、storePath 是真值非字符串：都不抛，读回空数组', () => {
  withDir((dir) => {
    mkdirSync(fileOf(dir)); // 审计文件的位置被一个目录占着（同步盘/备份工具留下的同名目录）
    assert.deepEqual(readAudit(dir), [], 'EISDIR 被吞掉：审计坏了也不能让调用方炸');
    appendAudit(dir, { tool: 'edit', verdict: 'allow' }); // appendFileSync 到目录必失败 → 吞掉
    assert.equal(statSync(fileOf(dir)).isDirectory(), true, '目录还在：没被删掉，也没被换成文件');
    assert.deepEqual(readAudit(dir), [], '失败之后依然是「读不回来」而不是抛');

    // storePath 的守卫只有 `!storePath`（真值判断）：数字/布尔/对象这些「真值但不是字符串」
    // 会在 mkdirSync / path.join 里抛 TypeError，同样被外层 catch 吞掉。
    for (const bogus of [1, true, NaN, {}]) {
      appendAudit(bogus, { tool: 'edit' });
      assert.deepEqual(readAudit(bogus), []);
    }
    assert.deepEqual(readAudit(Symbol('x')), [], 'Symbol 也一样：吞掉异常，返回空数组');
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

test('limit 的非数字语义：NaN / null / -0 都是「全量」，布尔被当成 0/1（写实）', () => {
  withDir((dir) => {
    for (let i = 1; i <= 5; i += 1) appendAudit(dir, { tool: 'edit', seq: i });
    const seqs = (limit) => readAudit(dir, limit).map((row) => row.seq);

    // `slice(-limit)` 先做 ToIntegerOrInfinity：NaN/null/-0 都算 0 ⇒ slice(-0) ⇒ slice(0) ⇒ 全量。
    // 面板/脚本想用 NaN 或 null 表达「不限制/没设置」时拿到的是整份日志，而不是空数组 —— 反直觉但稳。
    assert.deepEqual(seqs(NaN), [5, 4, 3, 2, 1]);
    assert.deepEqual(seqs(null), [5, 4, 3, 2, 1], 'null 不触发默认值（默认值只认 undefined）');
    assert.deepEqual(seqs(-0), [5, 4, 3, 2, 1]);
    assert.deepEqual(seqs(Infinity), [5, 4, 3, 2, 1]);
    assert.deepEqual(seqs(2.7), [5, 4], '小数被截断（ToIntegerOrInfinity 向零取整）');
    assert.deepEqual(seqs('3'), [5, 4, 3], '字符串也行：不是设计，是 slice 内部强转');
    assert.deepEqual(seqs(true), [5], '布尔被当成 1 —— 传错了不会报错，只会静默换个条数');
    // 只有 undefined 才走默认值（默认参数语义），这也是「没传」与「传了个假值」的唯一分界：
    assert.equal(readAudit(dir, undefined).length, 5);
  });
});

test('空行不占名额、空白行与坏行占名额：filter(Boolean) 在 slice 之前，JSON.parse 在 slice 之后', () => {
  withDir((dir) => {
    appendAudit(dir, { tool: 'edit', seq: 1 });
    appendFileSync(fileOf(dir), '\n\n'); // 两个真空行
    appendAudit(dir, { tool: 'edit', seq: 2 });
    assert.equal(readFileSync(fileOf(dir), 'utf8').split('\n').length, 5, '文件里确实多了 2 个空槽（外加末尾换行）');
    assert.deepEqual(readAudit(dir, 2).map((row) => row.seq), [2, 1], '空行在切之前就被滤掉，不吃名额');

    appendFileSync(fileOf(dir), '   \n'); // 只有空格：不是空串 ⇒ filter(Boolean) 留它下来
    assert.deepEqual(readAudit(dir, 2).map((row) => row.seq), [2], '空白行吃名额（切到了它，又解析不出对象，只能丢）');

    appendFileSync(fileOf(dir), '{半截\n'); // 坏行同理：切完才 parse
    assert.deepEqual(readAudit(dir, 3).map((row) => row.seq), [2], '坏行也吃名额');
    assert.deepEqual(readAudit(dir, 100).map((row) => row.seq), [2, 1], 'limit 够大时两条好行一条不少');
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

test('轮转按「行数减半」而非「字节减半」：大行落在后半时轮转完仍超上限（疑似 bug）', () => {
  withDir((dir) => {
    const HUGE = 'y'.repeat(600 * 1024); // 单行 600 KiB：已经超过 512 KiB 的上限
    const small = (n) => `${JSON.stringify({ ts: 1, tool: 'edit', verdict: 'allow', n })}\n`;
    writeFileSync(fileOf(dir), small(1) + small(2) + `${JSON.stringify({ ts: 1, tool: 'edit', verdict: 'allow', huge: HUGE })}\n` + small(4));
    assert.ok(statSync(fileOf(dir)).size > MAX_AUDIT_BYTES, '起点：4 行、已经超限');

    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'a' });
    // lines.length=4 ⇒ slice(-2) ⇒ 留下「后半」= [巨大行, n=4] —— 巨大行本身就在后半，原样留下
    const mid = parseAll(rawLines(dir));
    assert.equal(mid.length, 3, '留下的 2 行 + 刚写的 1 条');
    assert.equal(mid[0].huge.length, HUGE.length, '巨大行被留下：轮转只数行数，不看每行有多大');
    assert.equal(mid[1].n, 4, '留下来的确实是后半，顺序原样');
    assert.equal(mid[2].seq, 'a');
    assert.ok(statSync(fileOf(dir)).size > MAX_AUDIT_BYTES, '轮转之后仍在 512 KiB 之上 —— 这一轮没把体积收回来');

    appendAudit(dir, { tool: 'edit', verdict: 'allow', seq: 'b' });
    // lines.length=3 ⇒ slice(-1) ⇒ 只留最后一行，巨大行这次终于出局 ⇒ 体积自愈
    assert.deepEqual(readAudit(dir, 9).map((row) => row.seq), ['b', 'a']);
    assert.equal(rawLines(dir).length, 2, '轮到只剩 2 行');
    assert.ok(statSync(fileOf(dir)).size < MAX_AUDIT_BYTES, '下一次写入才回到上限以内');
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
