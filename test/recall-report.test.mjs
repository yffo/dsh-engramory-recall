/**
 * 记忆周报（`scripts/recall-report.mjs`）与它的两块地基：给人看的词表、宿主设置解析。
 *
 * 这份测试盯的是「报告会不会撒谎」这件事本身：
 *   1. 缺数据必须**说出来**（老账本没有「整篇字数」⇒ 明说算不出，而不是印 0 当成绩）；
 *   2. 「这一轮没注入任何记忆」必须是个**有位置的结论**，不是空白（coverage 分母含跳过轮）；
 *   3. 参数、判据只能来自活代码：引擎参数来 `bm25.js#scoringProfile()`、默认值来 `index.js#DEFAULTS`；
 *   4. 宿主设置从 profile 的 patch 里**读**出来（读不到就说没读到，不编数字）；
 *   5. 导入本文件不跑报告（入口守卫）—— 它以前是「一 import 就跑全套」那一类。
 *
 * 纪律：只碰 `mkdtempSync` 造的临时库与临时 HOME；**绝不给 `--store` 传空串或省略它**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildReport, findProfilePatches, main, parsePatchSettings, resolveSettings } from '../scripts/recall-report.mjs';
import { DEFAULTS } from '../index.js';
import { scoringProfile } from '../bm25.js';
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
const skip = (ts, reason) => ({ ts, kind: 'skip', reason });
const empty = (ts, reason) => ({ ts, kind: 'empty', reason });

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
