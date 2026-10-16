/**
 * `bench/recall-eval.mjs`（召回评测判分器）与 `bench/eval-tasks/*.tasks.json`（题集）的契约。
 *
 * 为什么单独铺这一份：前四把尺子量的是**召回本身**，这一把要量「回答有没有因为记忆变好」,
 * 而那是个**判分**动作。判分器判错的后果跟别的 bug 不一样 —— 错的是结论而不是数字，
 * 而且错得很安静（题集全过看起来就像「记忆很有效」）。所以这里钉两件事：
 *
 *   判分口径
 *     1. `expect` 每项是一个关键词组，**组内任一命中即算该项命中**，各项全中才算过
 *        （用户 m00001 明确的口径；计划 §11 原文写「组内全中」，偏差记在 docs/measuring.md）；
 *     2. 匹配前过 NFKC + 小写 + 折叠空白 —— 全角冒号、换行、大小写都不该让同一个短语失配；
 *     3. `forbid` 命中 ⇒ 该题**必失败**，一票否决而不是扣分；
 *     4. 题集字段缺失 / null / 类型不对 ⇒ 跳过该题并报告理由，**绝不抛**（题集是人手写的 JSON）；
 *     5. `hitSource` 只在产生过命中的档（push）上有值，别的档是 `null` = 未测，不是 `false`；
 *        没跑过的档在报表里印「未跑」，**不许印 0** —— 0 会被读成「跑了且全错」。
 *
 *   题集自身的纪律（防线在 `bench/eval-tasks/` 上，本机有真库时才真检查）
 *     6. 四类各 ≥6 题、总数 ≥30、id 唯一；
 *     7. 每条 `expect` 至少有一个候选写法能**逐字**追到 `source` 那篇笔记的正文
 *        （判据不能是编的）；`source` 必须指向库里真有的笔记；
 *     8. `prompt` 里不许出现 `expect` 关键词 —— 泄题会让无记忆的 agent 也答对，题就白出了；
 *     9. `forbid` 不许装中文：中文否定句包含肯定子串（「不建议开启 X」含「建议开启 X」），
 *        装自然语言主张会误杀正确答案。`forbid` 只装字面量（旧路径 / 旧专名 / 旧配置值）。
 *
 * 纪律：只碰 `mkdtempSync` 造的临时库与临时题集，`finally` 里删干净 —— **绝不省略 `--store`**
 * （省略会静默回落到真库 `~/memory/engramory`，CI 上还没有那个目录）；`main()` 一律带 `--out`
 * 指到临时路径，否则跑一次测试就会往 `bench/eval-results/` 里丢结果文件。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { pullHintText } from '../index.js';

import {
  ARMS,
  DEFAULT_TASKS_DIR,
  KINDS,
  estimateTokens,
  judge,
  loadAnswers,
  loadTasks,
  main,
  normalizeText,
  parseArgs,
  prepareCorpus,
  runArm,
  summarize,
  termAlternatives,
  validateTask,
} from '../bench/recall-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL = join(root, 'bench', 'recall-eval.mjs');
const REAL_STORE = join(homedir(), 'memory', 'engramory');
const hasRealStore = existsSync(REAL_STORE);
const skipNoStore = hasRealStore ? false : '本机没有 ~/memory/engramory';

/** 跑一次判分器（真子进程），返回 `{ status, stdout, stderr }` —— 任何参数组合都不该崩出栈。 */
function run(args) {
  const res = spawnSync(process.execPath, [EVAL, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 造一个临时目录，返回 `{ dir, cleanup }`；调用方负责在 `finally` 里 cleanup()。 */
function scratch(prefix = 'engramory-eval-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 原样落盘一份题集 —— 故意允许写坏数据，用来测「不许抛」。 */
function writeJson(dir, name, raw) {
  const path = join(dir, name);
  writeFileSync(path, typeof raw === 'string' ? raw : `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}

/** 一份最小可跑的库：一篇笔记。push 档要真有东西可召回，stderr 才不会冒出「库是空的」警告。 */
function writeNote(dir) {
  writeFileSync(join(dir, 'note-a.md'), '# 称呼\n\n用户称呼为「李工」，体现尊重与专业性。\n');
}

/** 一条最小合法题。题面把关键词重两遍，保证 push 档真能召回上面那篇笔记。 */
const oneTask = () => ({
  version: 1,
  tasks: [{
    id: 'T-1',
    kind: 'preference',
    prompt: '我该怎么称呼你？我该怎么称呼你？',
    expect: ['李工'],
    forbid: [],
    source: 'note-a.md',
  }],
});

/** 把 console 的输出收进数组，顺便让测试输出保持干净（`main()` 是要打印报表的）。 */
async function capture(fn) {
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { code: await fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const baseTask = (over = {}) => ({ ...oneTask().tasks[0], ...over });

// ── 判分口径 ────────────────────────────────────────────────────────────────

test('judge：expect 组内任一命中即算该项命中，各项全中才算过', () => {
  const task = baseTask({ expect: ['过儿|AI 私人秘书', '🫡'] });
  const all = judge(task, '我叫过儿，符号是 🫡。');
  assert.equal(all.pass, true);
  assert.deepEqual(all.hitExpect, ['过儿|AI 私人秘书', '🫡']);
  assert.deepEqual(all.missedExpect, []);

  // 少中一组 ⇒ 不过，且缺的那组被点名（报表要靠它说清「差在哪」）
  const some = judge(task, '我叫过儿。');
  assert.equal(some.pass, false);
  assert.deepEqual(some.missedExpect, ['🫡']);
});

test('judge：全角标点 / 全角竖线 / 大小写 / 换行都不算另一回事', () => {
  assert.equal(judge(baseTask({ expect: ['gate: off'] }), '把 gate： OFF 关掉即可。').pass, true);
  // 中文输入法打出全角竖线是很自然的事；只认半角会让整组关键词永远匹配不上且毫无声息
  assert.equal(judge(baseTask({ expect: ['minScore｜相关度门槛'] }), '看 minScore 就行。').pass, true);
  assert.equal(judge(baseTask({ expect: ['最多重试 2 次'] }), '规则是：最多重试  2\n次。').pass, true);
  assert.equal(normalizeText('Ａ Ｂ'), 'a b');
});

test('judge：forbid 命中即失败，哪怕 expect 全中', () => {
  const verdict = judge(baseTask({ expect: ['过儿'], forbid: ['梗图'] }), '我叫过儿，但梗图就别发了。');
  assert.equal(verdict.pass, false, 'forbid 是一票否决，不是扣分');
  assert.deepEqual(verdict.hitsForbid, ['梗图']);
  assert.deepEqual(verdict.hitExpect, ['过儿'], 'expect 照样记命中，报表要能看见「答对了但踩了禁令」');
});

test('judge：空答案 / 非字符串答案不抛，按「一条都没中」处理', () => {
  const task = baseTask({ expect: ['李工'] });
  for (const answer of ['', null, undefined, 42, {}, []]) {
    let verdict;
    assert.doesNotThrow(() => {
      verdict = judge(task, answer);
    }, `${JSON.stringify(answer)} 不该抛`);
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.missedExpect, ['李工']);
  }
  assert.equal(judge(task, undefined).pass, false, 'none 档的「地板」就是这么量出来的');
});

test('termAlternatives：`|` 与 `｜` 都是分隔符，全是分隔符时是空数组', () => {
  assert.deepEqual(termAlternatives('a|b｜c'), ['a', 'b', 'c']);
  assert.deepEqual(termAlternatives('|'), [], '空组不能静默当空串——那会匹配一切');
  assert.deepEqual(termAlternatives('｜'), []);
  assert.deepEqual(termAlternatives(''), []);
  assert.deepEqual(termAlternatives(' 过儿 '), ['过儿']);
});

test('estimateTokens：口径是 Math.ceil(字数 / 4)，坏输入归零而不是 NaN', () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(-10), 0);
  assert.equal(estimateTokens('abc'), 0, '不是数字就当 0，别让 NaN 污染合计');
});

// ── 题集读取：坏数据一律「判不了 + 报告」 ────────────────────────────────────

test('validateTask：字段缺失 / null / 类型不对都给出理由，不抛', () => {
  assert.ok(validateTask(baseTask()).task, '合法题返回 { task }');

  const cases = [
    [null, /不是一个对象/],
    [[], /不是一个对象/],
    ['x', /不是一个对象/],
    [baseTask({ id: '' }), /id 缺失/],
    [baseTask({ id: 7 }), /id 缺失/],
    [baseTask({ kind: 'nope' }), /kind/],
    [baseTask({ kind: null }), /kind/],
    [baseTask({ prompt: '' }), /prompt/],
    [baseTask({ prompt: 7 }), /prompt/],
    [baseTask({ expect: '李工' }), /expect 不是数组/],
    [baseTask({ expect: null, forbid: null }), /没有任何可判的判据/],
    [baseTask({ expect: [] }), /没有任何可判的判据/],
    [baseTask({ expect: [7] }), /expect\[0\]/],
    [baseTask({ expect: ['  '] }), /空字符串/],
    [baseTask({ expect: ['|'] }), /只有分隔符/],
    [baseTask({ forbid: {} }), /forbid 不是数组/],
    [baseTask({ forbid: [''] }), /forbid\[0\]/],
  ];
  for (const [raw, re] of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = validateTask(raw, 0, new Set());
    }, `${JSON.stringify(raw)} 不该抛`);
    assert.equal(result.task, undefined, `${JSON.stringify(raw)} 不该被判为合法`);
    assert.match(result.reason, re);
  }
});

test('validateTask：id 重复要挡住；source 缺失只警告不拦（它是出处，不影响判分）', () => {
  // `seen` 由调用方（loadTasks）记账，validateTask 只读不写 —— 所以这里手动播种。
  const dup = validateTask(baseTask({ id: 'A' }), 1, new Set(['A']));
  assert.equal(dup.task, undefined);
  assert.match(dup.reason, /id 重复/);
  assert.ok(validateTask(baseTask({ id: 'A' }), 1, new Set()).task, '同一个 id 在别的文件里没出现过就不该被挡');

  const noSource = validateTask(baseTask({ source: null }), 0, new Set());
  assert.ok(noSource.task, '§11 要求每题有出处，但缺出处是「提醒作者」，不是「判不了」');
  assert.equal(noSource.task.source, '');
  assert.ok(noSource.warnings.some((w) => /source/.test(w)));
});

test('loadTasks：坏 JSON / 顶层不是对象 / version 不对 / 目录不存在，全都变成可读的报告', () => {
  const { dir, cleanup } = scratch();
  try {
    writeJson(dir, 'broken.tasks.json', '{ 这不是 JSON');
    writeJson(dir, 'array.tasks.json', [1, 2]);
    writeJson(dir, 'no-tasks.tasks.json', { version: 1 });
    writeJson(dir, 'old-version.tasks.json', { version: 2, tasks: [baseTask({ id: 'V-2' })] });
    const result = loadTasks(dir);

    assert.deepEqual(result.tasks.map((t) => t.id), ['V-2'], 'version 不是 1 只警告，照 version 1 读');
    assert.equal(result.files.length, 4, '四份文件都要出现在 files 里，忽略哪个也要看得见');
    assert.equal(result.invalid.length, 3, '三份读不出来的各留一条理由');
    for (const item of result.invalid) {
      assert.ok(item.id && item.reason && item.file, '理由、文件名、id 缺一不可');
    }
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /version 不是 1/);

    const missing = loadTasks(join(dir, 'nope'));
    assert.deepEqual(missing.tasks, []);
    assert.match(missing.error, /读不了题集目录/);
  } finally {
    cleanup();
  }
});

test('loadTasks：好题与坏题混在一份文件里，好的照收、坏的逐条点名', () => {
  const { dir, cleanup } = scratch();
  try {
    writeJson(dir, 'mixed.tasks.json', {
      version: 1,
      tasks: [baseTask({ id: 'OK-1' }), { id: 'BAD-1' }, baseTask({ id: 'OK-2', kind: 'procedure' })],
    });
    const result = loadTasks(dir);
    assert.deepEqual(result.tasks.map((t) => t.id), ['OK-1', 'OK-2']);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.invalid[0].id, 'BAD-1');
    assert.match(result.invalid[0].reason, /kind/);
  } finally {
    cleanup();
  }
});

test('loadTasks：只认 *.tasks.json，同目录的答案集不会被当题集读', () => {
  const { dir, cleanup } = scratch();
  try {
    writeJson(dir, 'a.tasks.json', oneTask());
    writeJson(dir, 'restrained-answers.json', { version: 1, answers: { 'T-1': '李工' } });
    assert.deepEqual(loadTasks(dir).tasks.map((t) => t.id), ['T-1']);
  } finally {
    cleanup();
  }
});

test('loadAnswers：缺文件 / 坏 JSON / 形状不对都不抛；非字符串答案只警告', () => {
  const { dir, cleanup } = scratch();
  try {
    const missing = loadAnswers(join(dir, 'nope.json'));
    assert.equal(missing.answers.size, 0, '没有答案集就是空 Map，不是抛');
    assert.match(missing.error, /读不了答案文件/);

    writeJson(dir, 'broken.json', 'nope');
    assert.equal(loadAnswers(join(dir, 'broken.json')).answers.size, 0);
    writeJson(dir, 'shapeless.json', 42);
    assert.equal(loadAnswers(join(dir, 'shapeless.json')).answers.size, 0);

    writeJson(dir, 'mixed.json', { version: 1, answers: { 'T-1': '李工', 'T-2': null, 'T-3': 7 } });
    const mixed = loadAnswers(join(dir, 'mixed.json'));
    assert.deepEqual([...mixed.answers.keys()], ['T-1']);
    assert.equal(mixed.warnings.length, 2, '答不上来的答案要留痕，否则会被读成「模型没答对」');
  } finally {
    cleanup();
  }
});

// ── 三档：注入什么、花多少 ──────────────────────────────────────────────────

test('prepareCorpus：库不存在 / 是空目录都是空库，不抛', () => {
  const { dir, cleanup } = scratch();
  try {
    for (const path of [join(tmpdir(), 'engramory-eval-definitely-missing'), dir]) {
      let corpus;
      assert.doesNotThrow(() => {
        corpus = prepareCorpus(path, {});
      });
      assert.equal(corpus.docs.length, 0);
      assert.equal(corpus.files, 0);
      assert.equal(corpus.chars, 0);
      assert.equal(corpus.docMap.size, 0);
    }
  } finally {
    cleanup();
  }
});

test('runArm：none 不注入、pull 只注入一行提示、push 走真召回', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    const tasks = oneTask().tasks;
    const corpus = prepareCorpus(dir, { maxPointers: 4, maxChars: 480 });

    const none = runArm('none', tasks, { corpus, answerer: 'none' });
    assert.equal(none.rows[0].injectedChars, 0);
    assert.equal(none.rows[0].injectedTokens, 0);
    assert.equal(none.rows[0].answererCalls, 0, 'none 档不许偷偷调模型');
    assert.equal(none.rows[0].hitSource, null, 'none 档没产生命中 ⇒ 未测，不是 false');
    assert.equal(none.rows[0].judged, true, '空答案照样判：判出来就是「一条都没中」');
    assert.equal(none.rows[0].pass, false);

    const pull = runArm('pull', tasks, { corpus, answerer: 'none', storePath: dir });
    // 0.21.0 收口：pull 的文案取自插件本体（`pullHintText`），字数随库路径与命中条数变，
    // 所以这里跟插件算同一句，而不是钉一个写死的常量。
    assert.equal(pull.rows[0].injectedChars, pullHintText(1, dir).length);
    assert.equal(pull.rows[0].hitSource, null);

    const push = runArm('push', tasks, { corpus, answerer: 'none' });
    assert.ok(push.rows[0].injectedChars > 0, '库里就那一篇、题面还重了词，push 必须注进去');
    assert.deepEqual(push.rows[0].hits, ['note-a.md'], '命中的 id 要能对上 source');
    assert.equal(push.rows[0].hitSource, true, 'source 写的 `note-a.md`、命中 id 也带 .md，归一化后必须对上');
    assert.equal(push.rows[0].sourceRank, 1);
    assert.equal(push.recallHits, 1);
    assert.equal(push.recallRate, 1);
  } finally {
    cleanup();
  }
});

test('runArm：--dry 不判分（pass 是 null），但 push 的召回命中照样算得出来', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    const push = runArm('push', oneTask().tasks, { corpus: prepareCorpus(dir, {}), answerer: 'none', dry: true });
    const row = push.rows[0];
    assert.equal(row.judged, false);
    assert.equal(row.pass, null, 'dry 的「没判过」不能写成 false，那会被读成「判不过」');
    assert.equal(row.hitSource, true, '量成本的那一趟顺便把「答案那篇有没有被注入」也量了，这是免费的');
    assert.equal(row.answererCalls, 0);
    assert.equal(push.passRate, null);
  } finally {
    cleanup();
  }
});

test('runArm：--answerer file 缺答案集里的某一题时，该题按空答案算并留下 error', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    const result = runArm('none', oneTask().tasks, { corpus: null, answerer: 'file', answers: new Map() });
    assert.equal(result.rows[0].pass, false);
    assert.match(result.rows[0].answererError, /答案集里没有 T-1/);
    assert.equal(result.rows[0].answererCalls, 0);
  } finally {
    cleanup();
  }
});

test('summarize：一题都没判过时 passRate 是 null（报表才印得出「未跑」而不是 0）', () => {
  const rows = [
    { kind: 'preference', judged: true, pass: true, injectedChars: 10, injectedTokens: 3, answererCalls: 0, recallMs: 1, hitSource: true },
    { kind: 'preference', judged: true, pass: false, injectedChars: 10, injectedTokens: 3, answererCalls: 0, recallMs: 1, hitSource: false },
    { kind: 'procedure', judged: false, dry: true, injectedChars: 0, injectedTokens: 0, answererCalls: 0, recallMs: 0, hitSource: null },
  ];
  const summary = summarize(rows);
  assert.equal(summary.judged, 2);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.byKind.preference.judged, 2, '按类计数要落下来，报表的「每类通过率」就是从这两个数算的');
  assert.equal(summary.byKind.preference.passed, 1);
  assert.equal(summary.byKind.procedure.dry ?? true, true);
  assert.equal(summary.recallHits, 1);
  assert.equal(summary.recallTotal, 2, 'hitSource 为 null 的行不进召回率的分母');
  assert.equal(summary.recallRate, 0.5);

  const empty = summarize([]);
  assert.equal(empty.passRate, null, '分母为 0 ⇒ null，让报表印「未跑」');
  assert.equal(empty.recallRate, null);
});

// ── 命令行表面 ──────────────────────────────────────────────────────────────

test('parseArgs：三档可多选、= 形式、未知选项只记警告', () => {
  const def = parseArgs([]);
  assert.deepEqual(ARMS, ['none', 'push', 'pull']);
  assert.deepEqual(def.modes, [], '不给 --mode 时不在这里偷塞默认档，交给 main 决定');
  assert.deepEqual(def.warnings, []);
  assert.equal(def.answerer, undefined);
  assert.equal(def.dry, undefined);

  assert.deepEqual(parseArgs(['--mode', 'push,pull']).modes, ['push', 'pull']);
  assert.deepEqual(parseArgs(['--mode=push']).modes, ['push']);
  assert.equal(parseArgs(['--answerer', 'file']).answerer, 'file');
  assert.equal(parseArgs(['--answers=a.json']).answers, 'a.json');
  assert.equal(parseArgs(['--dry', '--json']).json, true);
  // 未知参数只记一句警告、不改变其它解析结果：CI 里多写一个 flag 不该让整轮跑不出结果
  const unknown = parseArgs(['--nope', 'x', '--dry']);
  assert.equal(unknown.dry, true);
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /未知选项 --nope/);
});

test('CLI：题集是空的 / 坏到一份都读不出来 ⇒ 退出码 2 + 人话，绝不吐栈', () => {
  const { dir, cleanup } = scratch();
  try {
    writeJson(dir, 'broken.tasks.json', '{');
    for (const tasks of [dir, join(dir, 'nope')]) {
      const res = run(['--dry', '--store', dir, '--tasks', tasks]);
      assert.equal(res.status, 2, `${tasks}：没题可跑不是成功`);
      assert.doesNotMatch(res.stderr, /\n\s+at /, '不许吐栈');
      assert.doesNotMatch(res.stdout, /\n\s+at /);
      assert.match(res.stderr, /题集|判不了|读不了/);
    }
  } finally {
    cleanup();
  }
});

test('CLI：多档同跑时，成本列按档分开印（别把 none 的 0 字挂在 push 旁边）', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    const answers = writeJson(dir, 'a.json', { version: 1, answers: { 'T-1': '李工。' } });
    // `--out` 必须给：不给就会往仓库真目录 `bench/eval-results/` 里丢结果文件。
    const out = join(dir, 'result.json');
    const res = run(['--mode', 'none,push', '--answerer', 'file', '--answers', answers, '--store', dir, '--tasks', dir, '--out', out]);
    assert.equal(res.status, 0);
    // 表头必须一档一列。曾经只印一列「平均注入字」，多档同跑时它悄悄取的是第一个档，
    // 于是 push 那一行的成本显示成 none 的 0 字 —— 报表读错方向比数字错更难发现。
    assert.match(res.stdout, /\| none 注入字 \| push 注入字 \|/);
    const row = res.stdout.split('\n').find((line) => line.startsWith('| 合计 |'));
    assert.ok(row, `该有合计行：\n${res.stdout}`);
    const cells = row.split('|').map((cell) => cell.trim());
    assert.equal(cells[3], '100.0% (1/1)', 'none 档：答案集自带事实 ⇒ 过');
    assert.equal(cells[4], '100.0% (1/1)', 'push 档：同上');
    assert.equal(cells[5], '0', 'none 档注入 0 字');
    assert.notEqual(cells[6], '0', 'push 档真注入了东西，不该是 0');
    // 题集里没有的类印「—」而不是「未跑」：后者会被读成「这一档没跑」，于是有人去重跑而不是去补题
    assert.match(res.stdout, /\| fact-recall \| 0 \| — \| — \| 0 \| 0 \|/);
    // 两档不能写进同一个文件：后一档覆盖前一档，读的人会拿着 none 的数当 push 的数。
    assert.ok(existsSync(join(dir, 'result-none.json')), '多档同跑要按档拆文件名');
    assert.ok(existsSync(join(dir, 'result-push.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'result-push.json'), 'utf8')).mode, 'push');
  } finally {
    cleanup();
  }
});

test('CLI：--answerer cmd 真起子进程（stdout 当答案、stdin 喂上下文、算一次调用）', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    const common = ['--answerer', 'cmd', '--store', dir, '--tasks', dir];

    // `echo` 是「不读 stdin 的回答器」：证明 stdout 真被当答案读回来
    const out1 = join(dir, 'r1.json');
    const res1 = run(['--mode', 'none', ...common, '--cmd', 'echo 李工', '--out', out1]);
    assert.equal(res1.status, 0);
    const row1 = JSON.parse(readFileSync(out1, 'utf8')).rows[0];
    assert.equal(row1.pass, true, `echo 出来的答案该判过：${res1.stderr}`);
    assert.equal(row1.answererCalls, 1, 'cmd 档每题算一次调用（成本要对得上）');

    // `cat` 是「把 stdin 原样吐回来」：证明「上下文 + 题面」真喂进了 stdin。
    // 这条要钉住，是因为 `--cmd "claude -p"` 这类 CLI 只从 stdin 读题面，喂不进去就永远是空答案。
    const out2 = join(dir, 'r2.json');
    const res2 = run(['--mode', 'push', ...common, '--cmd', 'cat', '--out', out2]);
    const row2 = JSON.parse(readFileSync(out2, 'utf8')).rows[0];
    assert.equal(row2.answererCalls, 1);
    assert.equal(row2.pass, true, `cat 该把注入的指针原样吐回来：${res2.stderr}`);

    // 回答器自己崩了 ⇒ 记成这条的 error，不许把回答器的故障读成「记忆没用」
    const out3 = join(dir, 'r3.json');
    const res3 = run(['--mode', 'none', ...common, '--cmd', 'exit 3', '--out', out3]);
    assert.equal(res3.status, 0, '回答器退出码非零不是评测程序崩');
    const row3 = JSON.parse(readFileSync(out3, 'utf8')).rows[0];
    assert.equal(row3.pass, false);
    // 字段名是 `answererError`：回答器挂了要能跟「答不出来」分开读（报表里也会单列一条警告）
    assert.match(String(row3.answererError ?? ''), /回答器退出码 3/);
  } finally {
    cleanup();
  }
});

test('CLI：坏文件与好文件混着放 ⇒ 好的照跑，坏的报「判不了」，退出码 0', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'broken.tasks.json', '{');
    writeJson(dir, 'ok.tasks.json', oneTask());
    const res = run(['--dry', '--store', dir, '--tasks', dir]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /判不了：broken\.tasks\.json/);
    assert.match(res.stdout, /T-1/);
  } finally {
    cleanup();
  }
});

test('CLI：--dry 默认三档全跑，没跑过的档不许印 0', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    const res = run(['--dry', '--store', dir, '--tasks', dir, '--json']);
    assert.equal(res.status, 0);
    // 单题题集必然会带一句「不足 30 题」的提示，那是有意为之；除此之外 stderr 不该有别的东西。
    assert.doesNotMatch(res.stderr, /警告|判不了|读不了/, `stderr 只该有题量提示：${res.stderr}`);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.reports.length, ARMS.length, '三档都要有一份报告，哪怕某些档没跑');
    for (const report of payload.reports) {
      assert.ok(ARMS.includes(report.mode));
      // 落盘的报告只属于「真跑过」的档，而它内部那份 arms 清单要如实标出每一档跑没跑。
      assert.deepEqual(report.arms.find((a) => a.arm === report.mode), { ...report.arms.find((a) => a.arm === report.mode), ran: true });
      assert.equal(report.passRate, null, 'dry 不出判分结论');
      for (const row of report.rows) {
        assert.equal(typeof row.injectedChars, 'number');
        assert.equal(typeof row.injectedTokens, 'number');
        assert.equal(typeof row.elapsedMs, 'number');
      }
    }
    // 没跑的档也得占个位置：结果文件里要看得见「这档没跑」，否则后来的人会把它读成 0 分
    const single = JSON.parse(run(['--dry', '--mode', 'none', '--store', dir, '--tasks', dir, '--json']).stdout);
    assert.deepEqual(single.reports.map((r) => r.mode), ['none'], '没跑的档不落盘（否则会留下一堆假结果文件）');
    assert.deepEqual(single.reports[0].arms.map((a) => [a.arm, a.ran]), [['none', true], ['push', false], ['pull', false]]);
  } finally {
    cleanup();
  }
});

test('CLI：--json 在任何能跑下去的组合里都是可 parse 的 JSON', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    writeJson(dir, 'answers.json', { version: 1, answers: { 'T-1': '称呼李工就好。' } });
    const combos = [
      ['--json', '--dry'],
      ['--json', '--dry', '--mode', 'push'],
      ['--json', '--dry', '--mode', 'pull'],
      ['--json', '--mode', 'none', '--answerer', 'file', '--answers', join(dir, 'answers.json')],
    ];
    for (const extra of combos) {
      const res = run([...extra, '--store', dir, '--tasks', dir, '--out', join(dir, 'out.json')]);
      assert.equal(res.status, 0, `${extra.join(' ')} 应当跑通：${res.stderr}`);
      let payload;
      assert.doesNotThrow(() => {
        payload = JSON.parse(res.stdout);
      }, `${extra.join(' ')} 的输出必须是 JSON`);
      assert.equal(payload.version, 1);
      assert.equal(payload.tool, 'bench/recall-eval.mjs');
    }
  } finally {
    cleanup();
  }
});

test('CLI：参数写错（未知档 / 缺 --cmd / 缺 --answers）⇒ 退出码 2 且不吐栈', () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    for (const args of [
      ['--mode', 'nope'],
      ['--answerer', 'nope'],
      ['--answerer', 'cmd'],
      ['--answerer', 'file'],
    ]) {
      const res = run([...args, '--store', dir, '--tasks', dir]);
      assert.equal(res.status, 2, `${args.join(' ')} 应当被挡住`);
      assert.doesNotMatch(res.stderr, /\n\s+at /, '不许吐栈');
      assert.ok(res.stderr.trim().length > 0, '被挡住要说清为什么');
    }
  } finally {
    cleanup();
  }
});

// ── main()：进程内跑一遍，钉住「三档都真跑」与落盘 ──────────────────────────

test('main：--mode none --answerer file 离线回放能出判分结论，并把结果落盘', async () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    writeJson(dir, 'answers.json', { version: 1, answers: { 'T-1': '称呼李工就好。' } });
    const out = join(dir, 'out.json');
    const { code } = await capture(() => main([
      '--mode', 'none', '--answerer', 'file', '--answers', join(dir, 'answers.json'),
      '--store', dir, '--tasks', dir, '--out', out,
    ]));
    assert.equal(code, 0);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.mode, 'none');
    assert.equal(report.answerer, 'file');
    assert.equal(report.passRate, 1, '答案里写了「李工」⇒ 这题在 none 档也得判过（判分器通路的正向验证）');
    assert.equal(report.injectedChars, 0, 'none 档不注入任何记忆');

    // 答案故意不写关键词 ⇒ 落回「判不过」，确认上面的 100% 不是恒真
    writeJson(dir, 'answers2.json', { version: 1, answers: { 'T-1': '随便叫都行。' } });
    const out2 = join(dir, 'out2.json');
    await capture(() => main([
      '--mode', 'none', '--answerer', 'file', '--answers', join(dir, 'answers2.json'),
      '--store', dir, '--tasks', dir, '--out', out2,
    ]));
    assert.equal(JSON.parse(readFileSync(out2, 'utf8')).passRate, 0);
  } finally {
    cleanup();
  }
});

test('main：三档都真能跑，且 push 真的读了库（none/pull 不读）', async () => {
  const { dir, cleanup } = scratch();
  try {
    writeNote(dir);
    writeJson(dir, 'ok.tasks.json', oneTask());
    const seen = new Map();
    for (const mode of ARMS) {
      const out = join(dir, `${mode}.json`);
      const { code } = await capture(() => main(['--dry', '--mode', mode, '--store', dir, '--tasks', dir, '--out', out]));
      assert.equal(code, 0, `${mode} 档应当跑通`);
      seen.set(mode, JSON.parse(readFileSync(out, 'utf8')));
    }
    assert.equal(seen.get('none').injectedChars, 0);
    assert.equal(seen.get('pull').injectedChars, pullHintText(1, dir).length);
    assert.ok(seen.get('push').injectedChars > 0);
    assert.equal(seen.get('push').store.read, true, 'push 要读库');
    assert.equal(seen.get('none').store.read, false, 'none 连库都不该读——否则「没碰过记忆」就是句谎话');
    // pull 现在也要读库（0.21.0）：它得先知道「本来会不会有命中」，才知道该不该开口 ——
    // 插件本体同样是先算 pushHits 再决定发不发那一行提示。
    assert.equal(seen.get('pull').store.read, true, 'pull 只注入一行，但它要先数一遍候选');
    assert.equal(seen.get('push').recallHits, 1, 'push 档顺带量「答案那篇有没有被注入」');
    assert.equal(seen.get('push').recallRate, 1);
    assert.equal(seen.get('none').injectedTokens, 0, 'none 档不花任何上下文');
    assert.equal(seen.get('pull').injectedChars, pullHintText(1, dir).length, 'pull 档的固定开销就是那一行提示（含库路径）');
  } finally {
    cleanup();
  }
});

test('main：--help 打印用法且不读库（没有库也不该报错）', async () => {
  const { dir, cleanup } = scratch();
  try {
    const { code, out } = await capture(() => main(['--help', '--store', dir, '--tasks', dir]));
    assert.equal(code, 0);
    assert.match(out, /用法|--mode/);
  } finally {
    cleanup();
  }
});

// ── 题集自身的纪律（读真文件，不是临时造的） ────────────────────────────────

const taskFiles = existsSync(DEFAULT_TASKS_DIR)
  ? readdirSync(DEFAULT_TASKS_DIR).filter((name) => name.endsWith('.tasks.json'))
  : [];
const loaded = taskFiles.length ? loadTasks(DEFAULT_TASKS_DIR) : { tasks: [], invalid: [], warnings: [] };
// ⚠️ 真题集**不入库**：它是从私人记忆库反向构题出来的，含真实路径、称呼与项目史
// （见 `.gitignore` 里「评测题集绝不入库」那段，与「记忆库绝不入库」同一条纪律）。
// 所以新克隆的机器上，下面守题集纪律的用例**跳过**而不是报错 —— 它们守的是本地那套题，
// 不是产品代码；产品代码的纪律由上面那些合成夹具的用例守。
const skipNoTasks = taskFiles.length ? false : '私有题集不在场（bench/eval-tasks/ 不入库）';

test('真题集：能读出来、没有读不出的文件、四类各 ≥6 题、总数 ≥30', { skip: skipNoTasks }, () => {
  assert.ok(taskFiles.length >= 1, `bench/eval-tasks 下应当有 *.tasks.json：${DEFAULT_TASKS_DIR}`);
  assert.deepEqual(loaded.invalid, [], `题集文件不该有读不出来的：${JSON.stringify(loaded.invalid)}`);
  assert.deepEqual(loaded.warnings, [], `题集不该有警告：${JSON.stringify(loaded.warnings)}`);

  const countByKind = new Map(KINDS.map((kind) => [kind, 0]));
  for (const task of loaded.tasks) countByKind.set(task.kind, countByKind.get(task.kind) + 1);
  for (const kind of KINDS) {
    assert.ok(countByKind.get(kind) >= 6, `${kind} 只有 ${countByKind.get(kind)} 题，计划 §11 要求每类 ≥6`);
  }
  assert.ok(loaded.tasks.length >= 30, `题集只有 ${loaded.tasks.length} 题，计划 §11 要求 ≥30`);
});

test('真题集：每题字段齐、id 唯一、prompt 短得像一句人话', { skip: skipNoTasks }, () => {
  const ids = new Set();
  for (const task of loaded.tasks) {
    assert.ok(task.prompt.length >= 6, `${task.id} 的 prompt 太短，不像用户会问的一句话`);
    assert.ok(task.source.length > 0, `${task.id} 缺 source：判据必须能追到某篇真笔记`);
    assert.ok(!ids.has(task.id), `${task.id} 重复`);
    ids.add(task.id);
  }
});

test('真题集：prompt 里不许出现 expect 关键词（泄题会让无记忆也答对）', { skip: skipNoTasks }, () => {
  for (const task of loaded.tasks) {
    const hay = normalizeText(task.prompt);
    for (const term of task.expect) {
      for (const alt of termAlternatives(term)) {
        const needle = normalizeText(alt);
        // ≤2 字的通用词（「李工」这种称呼）放过：它们泄不了题，是题面本身的正常用词。
        assert.ok(
          !hay.includes(needle) || needle.length <= 2,
          `${task.id} 的 prompt 里出现了 expect 关键词「${alt}」`,
        );
      }
    }
  }
});

test('真题集：forbid 只装字面量，不许装中文主张（中文否定句包含肯定子串）', { skip: skipNoTasks }, () => {
  for (const task of loaded.tasks) {
    for (const term of task.forbid) {
      assert.doesNotMatch(term, /[\u4e00-\u9fff]/, `${task.id} 的 forbid「${term}」含中文：一票否决的判据不能是自然语言主张`);
    }
  }
  // correction 类整体应当有用到 forbid（旧值答对了必须能被判失败），但不强制每一题都有：
  // 有些笔记本身就是用旧值来解释根因的，那些题的正确回答里会出现旧值。
  const corrections = loaded.tasks.filter((task) => task.kind === 'correction');
  assert.ok(
    corrections.some((task) => task.forbid.length > 0),
    'correction 类一条 forbid 都没有 ⇒ 「改过的事实必须用新的」根本没被测',
  );
});

test('真题集：source 指向的笔记真的在库里', { skip: skipNoTasks || skipNoStore }, () => {
  const names = new Set(readdirSync(REAL_STORE).filter((name) => name.endsWith('.md')));
  for (const task of loaded.tasks) {
    const file = task.source.split('#')[0].trim();
    assert.ok(names.has(file), `${task.id} 的 source「${task.source}」在库里找不到对应笔记`);
  }
});

test('真题集：每条 expect 至少有一个候选写法能逐字追到 source 笔记正文', { skip: skipNoTasks || skipNoStore }, () => {
  for (const task of loaded.tasks) {
    const file = task.source.split('#')[0].trim();
    const body = normalizeText(readFileSync(join(REAL_STORE, file), 'utf8'));
    for (const term of task.expect) {
      const hit = termAlternatives(term).some((alt) => body.includes(normalizeText(alt)));
      assert.ok(hit, `${task.id} 的 expect「${term}」在 ${file} 正文里逐字找不到 —— 判据是编的`);
    }
  }
});
