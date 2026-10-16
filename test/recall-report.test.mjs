/**
 * 记忆周报（`scripts/recall-report.mjs`）与它的两块地基：给人看的词表、宿主设置解析。
 *
 * 这份测试盯的是「报告会不会撒谎」这件事本身：
 *   1. 缺数据必须**说出来**（老账本没有「整篇字数」⇒ 明说算不出，而不是印 0 当成绩）；
 *   2. 「这一轮没注入任何记忆」必须是个**有位置的结论**，不是空白（coverage 分母含跳过轮）；
 *   3. 参数、判据只能来自活代码：引擎参数来 `bm25.js#scoringProfile()`、默认值来 `index.js#DEFAULTS`；
 *   4. 宿主设置从 profile 的 patch 里**读**出来（读不到就说没读到，不编数字）；
 *   5. 导入本文件不跑报告（入口守卫）—— 它以前是「一 import 就跑全套」那一类。
 *   6. 消费侧门控那一节的回放：抑制判据只能调 `confidence.js#suppressReady()`，回放自己抄一份阈值就红。
 *
 * 纪律：只碰 `mkdtempSync` 造的临时库与临时 HOME；**绝不给 `--store` 传空串或省略它**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildReport, findProfilePatches, main, parsePatchSettings, resolveSettings } from '../scripts/recall-report.mjs';
import { DEFAULTS } from '../index.js';
import { scoringProfile } from '../bm25.js';
import { GATE_DEFAULTS, gatePolicy, noteLedgerStats, suppressReady } from '../confidence.js';
import { readAudit, AUDIT_FILE } from '../audit.js';
import { TERM_WORDS, plainTerms, USAGE_FILE } from '../usage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 临时目录脚手架：跑完必删。 */
function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-report-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 账本行夹具 ────────────────────────────────────────────────────────────
const hit = (ts, ids, extra = {}) => ({
  ts,
  kind: 'hit',
  query: 'q',
  ids,
  scores: ids.map((_, i) => Number((5 - i * 0.5).toFixed(3))),
  injected: ids.length,
  budget: 600,
  spent: 300,
  topScore: 5,
  minScore: 0,
  ...extra,
});
const used = (ts, id) => ({ ts, kind: 'used', id, lagMs: 60000 });
const opened = (ts, id) => ({ ts, kind: 'opened', id, lagMs: 60000 });
const skip = (ts, reason) => ({ ts, kind: 'skip', reason });
const empty = (ts, reason) => ({ ts, kind: 'empty', reason });
// 一轮只带一条笔记的注入（回放的账本夹具：同一 id 连携带 N 次就是这么造的）
const carry = (ts, id) => hit(ts, [id]);

const capture = () => {
  const out = { stdout: '', stderr: '' };
  return { io: { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; } }, out };
};

// ── 1. 全字段：一件一件地算得出来 ──────────────────────────────────────────
test('全字段：分母含没注入的轮、省下的字数是「整篇 − 真正送出去的」、榜单按打开次数排', () => {
  const now = 1_700_000_000_000;
  const lines = [
    hit(now - 4000, ['a.md', 'b.md'], { noteChars: 9000, spent: 300 }),
    hit(now - 3000, ['b.md'], { noteChars: 4000, spent: 200 }),
    skip(now - 2000, 'chitchat'),
    empty(now - 1000, 'no-hits'),
    used(now - 3500, 'a.md'),
  ];
  const { text, json } = buildReport(lines, { days: 7, now, top: 3, store: '/tmp/store', ledger: '/tmp/store/x.jsonl' });

  // 分母：4 轮问过、2 轮带记忆、2 轮一个字都没进
  assert.equal(json.coverage.rounds, 4);
  assert.equal(json.coverage.injected, 2);
  assert.equal(json.coverage.zeroInjected, 2);
  assert.equal(json.coverage.injectedShare, 0.5);
  assert.match(text, /宿主问了 4 轮：\*\*2 轮真的带了记忆进上下文（50\.0%）\*\*/);
  assert.match(text, /另外 2 轮一个字都没进（这同样是结论，不是空白）/);
  assert.match(text, /- 寒暄 \/ 答话（设计如此）：1 轮/);

  // 省下的量：整篇 13000、送出去 500（两轮的 spent 之和）
  assert.equal(json.cost.rounds, 2);
  assert.equal(json.cost.noteChars, 13000);
  assert.equal(json.cost.pointerChars, 500);
  assert.equal(json.cost.savedChars, 12500);
  assert.match(text, /没进上下文的有 12,500 字/);
  assert.match(text, /96\.2% 的字留在了磁盘上/);

  // 分子：a.md 被打开过一次
  assert.equal(json.summary.usedCounted, 1);
  assert.match(text, /- a\.md — 1 \/ 1/);
  assert.match(text, /- b\.md — 带入 2 次/);

  // 明文：引擎参数与判据都来活代码，报告里没有第二个来源
  const profile = scoringProfile();
  assert.match(text, new RegExp(`k1=${profile.bm25.k1}`));
  assert.match(text, new RegExp(`同义键 ${profile.bridge.synonymKeys.toLocaleString('en-US')} 条`));
  assert.deepEqual(json.profile.bm25, profile.bm25, 'JSON 里的引擎参数必须与 scoringProfile() 逐字一致');
  assert.deepEqual(json.defaults, { maxPointers: DEFAULTS.maxPointers, maxChars: DEFAULTS.maxChars, minScore: DEFAULTS.minScore });
});

// ── 2. 缺数据就说缺数据 ───────────────────────────────────────────────────
test('老账本没有「整篇字数」：明说算不出省下多少，单列轮数，不拿 0 当成绩', () => {
  const now = 1_700_000_000_000;
  const lines = [hit(now - 3000, ['a.md']), hit(now - 2000, ['b.md']), hit(now - 1000, ['c.md'], { spent: 100 })];
  const { text, json } = buildReport(lines, { days: 7, now });

  assert.equal(json.cost.rounds, 0, '一条都没有「整篇字数」');
  assert.equal(json.cost.legacyRounds, 3, '三轮都得记成「没这一项」');
  assert.match(text, /还没有一轮账本记着「整篇字数」（0\.15\.0 起才落盘）/);
  assert.doesNotMatch(text, /留在磁盘上/, '没有数据时不许印「省了多少」这种成绩');
  assert.match(text, /只覆盖 0 轮/, '边界的写法也要跟着数据走');
  // 分母与分子照旧算得出来：缺的是这一项，不是整份报告
  assert.equal(json.coverage.injected, 3);
  assert.equal(json.summary.pointers, 3);
});

test('部分轮有、部分轮没有：比例只覆盖有数据的那几轮，且如实写出被漏掉的轮数', () => {
  const now = 1_700_000_000_000;
  const lines = [hit(now - 3000, ['a.md'], { noteChars: 1000, spent: 100 }), hit(now - 2000, ['b.md'])];
  const { text, json } = buildReport(lines, { days: 7, now });

  assert.equal(json.cost.rounds, 1);
  assert.equal(json.cost.legacyRounds, 1);
  assert.match(text, /共 1 轮记着这笔账/);
  assert.match(text, /另有 1 轮账本没有「整篇字数」这一项/);
});

// ── 3. 一个字都没进的账本 ─────────────────────────────────────────────────
test('整段账本一条都没注入：报告照常给结论，不出现 NaN、不印空表', () => {
  const now = 1_700_000_000_000;
  const lines = [skip(now - 3000, 'chitchat'), empty(now - 2000, 'below-min-score'), empty(now - 1000, 'no-hits')];
  const { text, json } = buildReport(lines, { days: 7, now });

  assert.equal(json.coverage.rounds, 3);
  assert.equal(json.coverage.injected, 0);
  assert.equal(json.coverage.zeroInjected, 3);
  assert.equal(json.coverage.injectedShare, 0);
  assert.match(text, /\*\*0 轮真的带了记忆进上下文（0\.0%）\*\*/);
  assert.match(text, /这窗口里还没有一条笔记被打开过/);
  assert.doesNotMatch(text, /NaN|undefined|Infinity/);
});

// ── 4. 空账本 / 窗口过滤 ──────────────────────────────────────────────────
test('空账本：给一页骨架也不抛（宿主刚装上、还没聊过就是这个形状）', () => {
  const { text } = buildReport([], { days: 7, now: 1_700_000_000_000, store: '/tmp/s', ledger: '/tmp/s/l' });
  assert.match(text, /# 记忆周报 · 最近 7 天/);
  assert.match(text, /宿主问了 0 轮/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test('窗口：--days 只留窗口内的行（days=0 = 全部）', () => {
  const now = 1_700_000_000_000;
  const lines = [hit(now - 10 * 86400000, ['old.md'], { noteChars: 1000 }), hit(now - 3600000, ['new.md'], { noteChars: 1000 })];
  const week = buildReport(lines, { days: 7, now });
  assert.equal(week.json.coverage.rounds, 1);
  assert.match(week.text, /new\.md|（账本共 2 行，落在窗口里 1 行）/);
  const all = buildReport(lines, { days: 0, now });
  assert.equal(all.json.coverage.rounds, 2, 'days=0 = 不设窗口');
});

// ── 5. 宿主设置：读出来，不编 ─────────────────────────────────────────────
const PATCH = `# 这个 profile 的 patch
- id: engramory-recall
  name: dsh-engramory-recall
  config:
    enabled: true
    storePath: ~/memory/engramory
    maxPointers: 5
    maxChars: 600   # 让第 5 条能完整显示
    minScore: 0
    nudge: false
    semanticFusion: guarded
    semanticGuard: 0.5
    semanticProvider: 'dsh-engramory-recall/providers/openai-embeddings'
- id: better-sidebar
  name: dsh-better-sidebar
  config:
    agentOpenTools: true
`;

test('parsePatchSettings：抠出那一段的标量键值，注释/引号/布尔/数字都归一', () => {
  const { values, found } = parsePatchSettings(PATCH);
  assert.equal(found, true);
  assert.deepEqual(values, {
    enabled: true,
    storePath: '~/memory/engramory',
    maxPointers: 5,
    maxChars: 600,
    minScore: 0,
    nudge: false,
    semanticFusion: 'guarded',
    semanticGuard: 0.5,
    semanticProvider: 'dsh-engramory-recall/providers/openai-embeddings',
  });
  assert.equal('agentOpenTools' in values, false, '下一个插件条目不许混进来');
  assert.equal('id' in values && 'name' in values, false, 'id/name 是定位用的，不是配置');
});

test('parsePatchSettings：没这一段就说没找到（报告里不许编数字）', () => {
  assert.deepEqual(parsePatchSettings('- id: other\n  config:\n    a: 1\n'), { values: {}, found: false });
  assert.deepEqual(parsePatchSettings(''), { values: {}, found: false });
  assert.deepEqual(parsePatchSettings(null), { values: {}, found: false });
});

test('resolveSettings：扫 profile 目录、挑真含这段配置的那份；--config 优先', () => {
  withTemp((home) => {
    const dir = join(home, '.dsh', 'profiles', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: something-else\n  config:\n    a: 1\n');
    const desktop = join(home, '.dsh', 'profiles', 'desktop');
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(desktop, 'cordis.patch.yml'), PATCH);

    const patches = findProfilePatches(home);
    assert.deepEqual(patches, [join(desktop, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml')], '按目录名排序、只列存在的');

    const auto = resolveSettings({ home });
    assert.equal(auto.source, join(desktop, 'cordis.patch.yml'), '不含这段的那份要跳过，不能拿它当来源');
    assert.equal(auto.values.maxPointers, 5);

    const explicit = resolveSettings({ config: join(dir, 'cordis.patch.yml'), home });
    assert.equal(explicit.source, null, '--config 指到不含这段的文件 ⇒ 如实说没找到，不悄悄回落');

    const none = resolveSettings({ home: join(home, 'nowhere') });
    assert.equal(none.source, null);
    assert.deepEqual(none.values, {});
  });
});

// ── 6. CLI 入口 ───────────────────────────────────────────────────────────
test('main：--help 打印用法、不读账本；缺账本给一句人话；未知参数只提示不改 stdout', () => {
  const help = capture();
  assert.equal(main(['--help'], help.io), 0);
  assert.match(help.out.stdout, /用法：node scripts\/recall-report\.mjs/);
  assert.match(help.out.stdout, /--days <N>/);

  withTemp((dir) => {
    const missing = capture();
    assert.equal(main(['--store', dir], missing.io), 0);
    assert.match(missing.out.stdout, /还没有账本/);

    writeFileSync(join(dir, USAGE_FILE), `${JSON.stringify(hit(Date.now(), ['a.md'], { noteChars: 1000, spent: 100 }))}\n`);
    const noisy = capture();
    assert.equal(main(['--store', dir, '--nope'], noisy.io), 0);
    assert.match(noisy.out.stderr, /不认识的参数：--nope/);
    assert.match(noisy.out.stdout, /# 记忆周报/, '未知参数不许改变报告本身');

    const jsonOut = capture();
    assert.equal(main(['--store', dir, '--json'], jsonOut.io), 0);
    const parsed = JSON.parse(jsonOut.out.stdout);
    assert.equal(parsed.coverage.injected, 1);
    assert.equal(typeof parsed.profile.bm25.k1, 'number');
    assert.equal(parsed.defaults.maxPointers, DEFAULTS.maxPointers);
  });
});

test('main：空账本（0 字节）当成「还没记过」，不抛栈', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, USAGE_FILE), '');
    const out = capture();
    assert.equal(main(['--store', dir], out.io), 0);
    assert.match(out.out.stdout, /宿主问了 0 轮/);
    assert.equal(out.out.stderr, '');
  });
});

// ── 7. 词表只有一份（Node 侧），面板那份由测试盯着 ────────────────────────
test('词表：usage.js 的 TERM_WORDS 是 Node 侧唯一一份，plainTerms 顺手收掉中文之间的空格', () => {
  assert.ok(TERM_WORDS.length >= 10);
  assert.equal(plainTerms('把 minScore 抬高只会丢线索'), '把相关度门槛抬高只会丢线索');
  assert.equal(plainTerms(''), '');
  assert.equal(plainTerms(undefined), undefined);
  assert.equal(plainTerms('没有任何键名'), '没有任何键名');
});

/**
 * 面板是客户端 bundle，**import 不到宿主的 usage.js**，只能照抄一份词表。
 * 照抄就会分叉（改了宿主忘了面板 ⇒ 面板上单独露出英文键名），所以抄写这件事由这条测试钉住：
 * 直接读面板源码里的字面量，与 `TERM_WORDS` 逐对比较。
 */
test('词表：面板里抄的那一份必须与 usage.js 逐对相同（分叉就红）', () => {
  const source = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8');
  const block = source.match(/const TERM_WORDS = \[([\s\S]*?)\];/);
  assert.ok(block, '面板里应有 `const TERM_WORDS = [...]` 字面量');
  const pairs = [...block[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, TERM_WORDS.map(([k, v]) => [k, v]));
});

// ── 8. 消费侧门控：档位、两份名单、负反馈回放 ─────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const lines = (...rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
/** 造一个真库（只有账本与审计，笔记元数据在需要时再放）：`main()` 的口径就是「读这个目录」。 */
const storeOf = (dir, rows, extra = {}) => {
  writeFileSync(join(dir, USAGE_FILE), lines(...rows));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
};
/** 直接调 buildReport（`main` 的读取口径），省掉自己拼一盘 IO。
 *  审计也照 `main()` 的做法从库里读：老账本没有 `selfTouch` 字段，自我触碰只能现算 ——
 *  绕开这一步，测试里的「自我触碰」永远不会发生，而报告看着一切正常。 */
const reportOf = (dir, options) => buildReport(readLedger(dir), {
  auditLines: existsSync(join(dir, AUDIT_FILE)) ? readAudit(dir, 500) : [],
  ...options,
});
/** 账本里的行（buildReport 要的就是这个）。 */
const ledgerRows = (dir) => readFileSync(join(dir, USAGE_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readLedger = (dir) => ledgerRows(dir);
/** 走 `main()` 验 CLI 路径（--top / --json 这类开关只有它还认）。 */
const cliReport = (dir, argv) => {
  const c = capture();
  assert.equal(main(['--store', dir, ...argv], c.io), 0);
  return c.out.stdout;
};
/** 报告里某一节（`### 6.1` 这种小标题）的原文：断言只在那一节里找，免得撞上前面榜单。 */
const block = (text, from, to) => {
  const at = text.indexOf(from);
  assert.ok(at >= 0, `报告里应有「${from}」这一节`);
  const end = to ? text.indexOf(to, at + from.length) : -1;
  return text.slice(at, end > 0 ? end : undefined);
};
/** 打印出来的名单行（`  - id — 携带 …`）的条数。 */
const rowsOf = (section) => section.split('\n').filter((l) => /^ {2}- \S/.test(l)).length;
const FIXED_SETTINGS = { source: null, values: {}, gate: { mode: 'assist', raw: null, default: GATE_DEFAULTS.mode } };

test('回放：同一 id 被携带 30 次（其间一次 used 都没有）、第 30 次之后才真被打开 ⇒ 够线 1 条、假杀 1 条', () => {
  // 门槛是**本库基础打开率**算出来的（`gatePolicy()`），不是写死的 12 ——
  // 所以测试也不写死数字：问一次 `suppressReady`，拿它的答案当预期。
  const threshold = gatePolicy(null).suppressAt;
  const carries = threshold; // 正好携带到「够线」的那一刻
  const base = 1_700_000_000_000;
  const lastCarryAt = base + 9 * DAY_MS; // 只过观察期（observeDays 天）不够，还得携带够多
  const readAt = lastCarryAt + DAY_MS; // 「之后」才有人真打开它
  const rows = [];
  for (let i = 0; i < carries - 1; i += 1) rows.push(hit(base + i * 3 * 60_000, ['x.md']));
  rows.push(hit(lastCarryAt, ['x.md']));
  rows.push(opened(readAt, 'x.md'));

  withTemp((dir) => {
    storeOf(dir, rows);
    const { text, json } = reportOf(dir, { days: 0, now: readAt + 1000, settings: FIXED_SETTINGS });
    assert.equal(json.replay.pointers.count, carries, '每轮注入 = 一条指针');
    assert.equal(json.replay.hitLine.count, 1, `只有最后那一次携带同时满足「携带 ≥${threshold}」与「观察 ≥${GATE_DEFAULTS.observeDays} 天」`);
    assert.equal(json.replay.falseKills.count, 1, '够线之后真被读了一次 = 一条假杀');
    assert.equal(json.replay.examples.length, 1);
    assert.equal(json.replay.examples[0].id, 'x.md');
    assert.equal(json.replay.examples[0].carried, carries);
    assert.ok(json.replay.examples[0].observedDays >= GATE_DEFAULTS.observeDays, '例子要带当时的观察天数');
    assert.ok(json.replay.examples[0].gapDays > 0, '例子要带「拦下之后多久才被读」');
    assert.match(text, /够到抑制线、后来又被读了的例子/);
    assert.match(text, new RegExp(`x\\.md — 够线时已携带 ${carries} 次`));

    // 口径的唯一性：回放判的那个点，必须与 confidence.js#suppressReady 说的一致。
    // （回放自己抄一份阈值，改阈值时就会与真门控分叉。）
    const hitRows = rows.filter((r) => r.kind === 'hit').sort((a, b) => a.ts - b.ts);
    assert.equal(suppressReady(noteLedgerStats(hitRows).get('x.md'), { now: base + 9 * DAY_MS }), true, '携带够多的那一刻已够抑制线');
    assert.equal(suppressReady(noteLedgerStats(hitRows.slice(0, -1)).get('x.md'), { now: base + 9 * DAY_MS }), false, '少一次就不够');
    assert.equal(suppressReady(noteLedgerStats(hitRows).get('x.md'), { now: base + 6 * DAY_MS }), false, '再早（观察不足）还不够');
  });
});

test('回放：携带次数不够（4 次）不判抑制 —— 是「样本不足」，不是「判过了没事」', () => {
  withTemp((dir) => {
    const base = 1_700_000_000_000;
    const rows = [];
    for (let i = 0; i < 4; i += 1) rows.push(hit(base + i * 3_600_000, ['y.md']));
    rows.push(opened(base + 5 * 3_600_000, 'y.md'));
    storeOf(dir, rows);

    const { json } = reportOf(dir, { days: 0, now: base + 6 * 3_600_000, settings: FIXED_SETTINGS });
    assert.equal(json.replay.pointers.count, 4);
    assert.equal(json.replay.hitLine.count, 0, `${GATE_DEFAULTS.suppressMinCarried} 次以下够不到抑制线`);
    assert.equal(json.replay.falseKills.count, 0);
  });
});

test('回放：刚写完 10 分钟内读回自己（自我触碰）不算「被用上」⇒ 携带够多仍判成假杀', () => {
  const base = 1_700_000_000_000;
  const carries = gatePolicy(null).suppressAt;
  const rows = [];
  // 携带要铺过观察期（observeDays 天）才谈得上「够线」：全挤在一小时里的话，
  // 到第 30 次携带那一刻观察天数还是 0，判据只会说「还没到能判的时候」。
  for (let i = 0; i < carries - 1; i += 1) rows.push(hit(base + i * 6.2 * 3_600_000, ['z.md']));
  rows.push(hit(base + (GATE_DEFAULTS.observeDays + 0.6) * DAY_MS, ['z.md']));
  // 写入之后 5 分钟读了一次自己：这一读落在自我触碰窗口（10 分钟）里，不算「被用上」，
  // 所以到 t+10 天它仍然是「携带够多、一次没被真用上」。
  const writeAt = base + 3_600_000;
  const selfReadAt = writeAt + 5 * 60_000;
  const openedAt = base + 10 * DAY_MS;
  rows.push(used(selfReadAt, 'z.md'));
  rows.push(opened(openedAt, 'z.md'));

  withTemp((dir) => {
    storeOf(dir, rows, { [AUDIT_FILE]: lines({ ts: writeAt, verdict: 'allow', file: 'z.md' }) });
    const { text, json } = reportOf(dir, { days: 0, now: openedAt + 1000, settings: FIXED_SETTINGS });
    assert.equal(json.replay.selfTouchSkips, 1, '那次自我触碰的读要被剔掉');
    assert.equal(json.replay.hitLine.count, 1);
    assert.equal(json.replay.falseKills.count, 1, '剔掉之后它还是「一次没被用上」，于是那次真打开就成了假杀');
    assert.equal(json.replay.examples[0].id, 'z.md');
    const ignored = json.gate.ignored.find((it) => it.id === 'z.md');
    assert.equal(ignored?.selfTouch, 1, '名单上也要看得见「自我触碰 1 次」，不然会被读成作者从来不看');
    assert.equal(ignored?.used, 0, '自我触碰的读不能算进「被读过」');
    assert.match(text, /自我触碰 1 次/);
  });
});

test('门控名单：ignored 按携带次数排、--top 只限打印条数（数据不截断）、stale 认 project- 的 mtime', () => {
  const base = 1_700_000_000_000;
  const rows = [];
  // 每篇都携带到「过门槛一次」以上：不到门槛只是「样本不足」，进不了「总也用不上」名单。
  // 全部挤在第 1 小时里，只比「谁被带得多」——观察天数不够线，排序才不被抑制线抢走。
  for (let i = 0; i < GATE_DEFAULTS.minEvidence + 1; i += 1) {
    for (let n = 0; n < 9; n += 1) rows.push(hit(base + n * 60_000, [`stale-src-${n}.md`]));
    rows.push(hit(base + 9 * 60_000, ['project-old.md']));
  }
  rows.push(hit(base + 9 * 60_000, ['project-old.md'])); // 比 stale-src-* 多一次 ⇒ 排最前

  withTemp((dir) => {
    storeOf(dir, rows);
    // 「过期」只认 project- 类，且要真读得到 mtime：老到阈值之外才上榜。
    const docs = new Map([
      ['project-old.md', { id: 'project-old.md', mtimeMs: base - (GATE_DEFAULTS.staleDays + 20) * DAY_MS }],
      ['reference-fresh.md', { id: 'reference-fresh.md', mtimeMs: base - 500 * DAY_MS }],
    ]);
    const { text, json } = reportOf(dir, { days: 0, now: base + 10 * 60_000, top: 3, settings: FIXED_SETTINGS, docs });
    assert.equal(json.gate.ignored.length, 10, '名单数据不按 --top 截断');
    assert.equal(json.gate.ignored[0].id, 'project-old.md', '按携带次数排（它比 stale-src-* 多带一次）');
    assert.deepEqual(json.gate.ignored.slice(1).map((it) => it.id),
      [...Array(9).keys()].map((n) => `stale-src-${n}.md`), '并列时按 id 排');
    assert.deepEqual(json.gate.stale.map((s) => s.id), ['project-old.md'], 'reference- 类再老也不叫「过期」');

    // 打印按 --top：10 条只露 3 条 + 一行「还有多少」
    const sec1 = block(text, '### 6.1', '### 6.2');
    assert.equal(rowsOf(sec1), 3, '--top=3 就只打 3 行');
    assert.match(sec1, /（共 10 条，这里按携带次数列前 3 条，--top 可调）/);
    assert.match(block(text, '### 6.2', '### 6.3'), /project-old\.md — \d+ 天没更新/);

    // CLI 那条路径也要吃 --top
    const cliJson = JSON.parse(cliReport(dir, ['--top', '2', '--json']));
    assert.equal(cliJson.gate.ignored.length, 10, '--top 只影响打印，不影响 JSON 里的数据');
    assert.equal(rowsOf(block(cliReport(dir, ['--top', '9']), '### 6.1', '### 6.2')), 9);
  });
});

test('门控名单：两份都空时给一句人话，不印 0 行占位', () => {
  withTemp((dir) => {
    const base = 1_700_000_000_000;
    // 携带次数都在门槛之下 ⇒ ignored 为空；没有 project 笔记 ⇒ stale 为空
    storeOf(dir, [hit(base, ['a.md']), hit(base + 60_000, ['b.md'])]);
    const { text, json } = reportOf(dir, { days: 0, now: base, settings: FIXED_SETTINGS });
    assert.equal(json.gate.ignored.length, 0);
    assert.equal(json.gate.stale.length, 0);
    assert.match(text, /目前没有需要留意的笔记/);
    for (const name of ['### 6.1', '### 6.2']) {
      const section = block(text, name, name === '### 6.1' ? '### 6.2' : '### 6.3');
      assert.equal(rowsOf(section), 0, '名单为空时不许留下空壳行');
      assert.equal(section.includes('目前没有需要留意的笔记'), true, '空名单的节里要有人话');
    }
  });
});

test('门控档位：patch 里写 enforce / shadow / off 都照读，垃圾值回落 assist 并说明回落', () => {
  withTemp((home) => {
    const dir = join(home, '.dsh', 'profiles', 'desktop');
    mkdirSync(dir, { recursive: true });
    const write = (gate) => writeFileSync(join(dir, 'cordis.patch.yml'),
      `- id: engramory-recall\n  config:\n    enabled: true\n${gate === undefined ? '' : `    gate: ${gate}\n`}`);
    const source = join(dir, 'cordis.patch.yml');

    // 一个字都没写 ⇒ 插件默认档，并且明说这是默认档（不许冒充用户设置）
    write(undefined);
    assert.equal(resolveSettings({ home }).gate.mode, GATE_DEFAULTS.mode);
    assert.equal(resolveSettings({ home }).gate.raw, null);
    withTemp((dir) => {
      storeOf(dir, [hit(1_700_000_000_000, ['a.md'])]);
      const plain = reportOf(dir, { days: 0, settings: resolveSettings({ home }) });
      assert.match(plain.text, new RegExp(`\\*\\*${GATE_DEFAULTS.mode}\\*\\*`));
      assert.match(plain.text, /里没写 gate ⇒ 用默认档/);
      // 宿主设置那一节是「人话（原字键名）」的写法（`总开关：开（enabled）`），
      // 所以这里断言的是「档位那一行印出了生效值」，不是 `gate: assist` 这种 YAML 长相。
      assert.match(plain.text, new RegExp(`消费侧门控档位[^\\n]*${GATE_DEFAULTS.mode}`), '缺省档位也要写进宿主设置那一节');
      assert.equal(plain.json.gate.mode, GATE_DEFAULTS.mode, 'JSON 里同步带 mode');
      assert.equal(plain.json.gate.raw, null, 'raw 保持 null：没写就是没写，别把默认值冒充成用户设置');
    });

    for (const gate of ['enforce', 'shadow', 'off']) {
      write(gate);
      const s = resolveSettings({ home });
      assert.equal(s.source, source);
      assert.equal(s.gate.mode, gate, `patch 里写 ${gate} 就得读成 ${gate}`);
      assert.equal(s.gate.raw, gate);
      withTemp((dir) => {
        storeOf(dir, [hit(1_700_000_000_000, ['a.md'])]);
        const r = reportOf(dir, { days: 0, settings: s });
        assert.match(r.text, new RegExp(`\\*\\*${gate}\\*\\*`));
        assert.match(r.text, new RegExp(`写的是 gate: ${gate}`));
        assert.equal(r.json.gate.mode, gate);
        assert.equal(r.json.gate.raw, gate);
      });
    }

    write('sometimes');
    const s = resolveSettings({ home });
    assert.equal(s.gate.mode, GATE_DEFAULTS.mode, '不认识的档位回落默认值');
    withTemp((dir) => {
      storeOf(dir, [hit(1_700_000_000_000, ['a.md'])]);
      const r = reportOf(dir, { days: 0, settings: s });
      assert.match(r.text, /（不认识）⇒ 回落默认档/, '回落必须写在脸上，不许静悄悄');
      assert.match(r.text, /"sometimes"/, '回落了也把原值带上，用户才知道自己写错了');
      assert.equal(r.json.gate.raw, 'sometimes');
    });
  });
});

test('配置读不到：档位行如实说「没读到宿主配置」，不编一个来源', () => {
  withTemp((dir) => {
    const base = 1_700_000_000_000;
    storeOf(dir, [hit(base, ['a.md'])]);
    const { text, json } = reportOf(dir, { days: 0, now: base, settings: resolveSettings({ home: join(dir, 'nowhere') }) });
    assert.equal(json.gate.source, null);
    assert.equal(json.gate.mode, GATE_DEFAULTS.mode);
    assert.match(text, /没读到宿主配置 ⇒ 用默认档/);
  });
});

test('回放：没有老账本 / 没有指针时如实写「数据还不够」，不把 0 印成结论', () => {
  const base = 1_700_000_000_000;
  withTemp((dir) => {
    // ① 空账本：一节骨架也不该出现数字结论，JSON 结构仍然稳定
    writeFileSync(join(dir, USAGE_FILE), '');
    const emptyReport = reportOf(dir, { days: 0, now: base, settings: FIXED_SETTINGS });
    assert.equal(emptyReport.json.replay.pointers.count, 0);
    assert.equal(emptyReport.json.replay.hitLine.count, 0);
    assert.deepEqual(emptyReport.json.replay.examples, []);
    assert.doesNotMatch(emptyReport.text, /正着扫了/, '没有指针就别摆「扫了 N 轮」这种成绩');
    assert.match(emptyReport.text, /数据还不够/);

    // ② 有账本但一条指针都没有（全是跳过/空白轮）
    storeOf(dir, [empty(base, 'no-hits'), skip(base + 1000, 'chitchat')]);
    const noPointers = reportOf(dir, { days: 0, now: base + 2000, settings: FIXED_SETTINGS });
    assert.equal(noPointers.json.replay.pointers.count, 0);
    assert.match(noPointers.text, /没有一条记录着「带进去了哪几条」的指针/);

    // ③ 有指针但窗口太短（本机账本只有几小时）：先说不够，再摆底子
    storeOf(dir, [hit(base, ['a.md']), hit(base + 2 * 3_600_000, ['b.md'])]);
    const tooShort = reportOf(dir, { days: 0, now: base + 3 * 3_600_000, settings: FIXED_SETTINGS });
    assert.equal(tooShort.json.replay.hitLine.count, 0);
    assert.equal(tooShort.json.replay.observeDays, GATE_DEFAULTS.observeDays);
    assert.match(tooShort.text, /数据还不够：账本只有 0\.1 天/);
    assert.match(tooShort.text, /现在判不出一条，不是判过了没事/);
    assert.equal(tooShort.json.replay.spanDays < GATE_DEFAULTS.observeDays, true);
    assert.match(tooShort.text, /扫过的底子（这些是分母，不是结论）/, '摆数字要标明那是分母');
    // ④ 时间够长、也有指针，但一条都没够到抑制线（真实库就长这样）：
    //    这时候缺的是「携带次数」，不能含糊成「都还差着」。
    storeOf(dir, [hit(base, ['a.md']), hit(base + 10 * DAY_MS, ['b.md']), opened(base + 20 * DAY_MS, 'b.md')]);
    const longEnough = reportOf(dir, { days: 0, now: base + 21 * DAY_MS, settings: FIXED_SETTINGS });
    assert.equal(longEnough.json.replay.spanDays > GATE_DEFAULTS.observeDays, true);
    assert.equal(longEnough.json.replay.pointers.count, 2);
    assert.equal(longEnough.json.replay.hitLine.count, 0);
    assert.equal(longEnough.json.replay.falseKills.count, 0);
    assert.doesNotMatch(longEnough.text, /正着扫了/, '一条都没够线就别摆「扫了 N 轮」这种成绩');
    assert.match(longEnough.text, /数据还不够：扫了 2 条指针，没有一条在当时就够到抑制线/);
    assert.match(longEnough.text, new RegExp(`携带 ≥${gatePolicy(null).suppressAt} 次且观察 ≥${GATE_DEFAULTS.observeDays} 天`),
      '缺的是哪个条件要写出来');
    assert.match(longEnough.text, /所以「开 enforce 会拦掉谁」现在还是未知数/);
  });
});

test('边界自陈：第⑤节说清「回放走判据、不是当时的档位」以及为什么假杀是保守估计', () => {
  withTemp((dir) => {
    const base = 1_700_000_000_000;
    storeOf(dir, [hit(base, ['a.md'])]);
    const { text } = reportOf(dir, { days: 0, now: base, settings: FIXED_SETTINGS });
    assert.match(text, /回放走的是\*\*判据\*\*、不是当时的档位/);
    assert.match(text, /suppressReady\(\)/);
    assert.match(text, /没有 `demoted` \/ `suppressed` 这两个字段/);
    assert.match(text, /保守估计/);
    // 节号顺着排（一…六），边界自陈那一节仍然收尾
    const atFive = text.indexOf('## 五、怎么读这份报告');
    const atSix = text.indexOf('## 六、消费侧门控');
    assert.ok(atFive > 0 && atSix > atFive, '第⑤节排在第⑥节之前');
    assert.equal(text.slice(atFive).includes('## 七、'), false);
  });
});
