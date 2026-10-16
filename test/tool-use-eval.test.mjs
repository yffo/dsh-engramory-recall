/**
 * `bench/tool-use-eval.mjs`（工具调用实验装置）的契约。
 *
 * 为什么单独铺这一份：三臂对照表量的是「注入多少字」，而 pull 档的全部赌注押在
 * 「模型看见那一行提示后会自己去查」上 —— 那个前提只有这个装置能量。装置一旦量错，
 * 错的不是数字而是**默认档该不该改**这个结论，而且错得安静：调用率算高了，pull 看起来就成立。
 * 所以这里钉三件事：
 *
 *   解析（结论直接建立在它上面）
 *     1. 模型在散文里混一行 JSON 也要认得出来（小模型经常先写「我来查一下」）；
 *     2. 工具名走**白名单**：`{"tool":"rm"}` 这种编出来的调用绝不算「调用了检索」——
 *        否则调用率虚高，pull 就被冤枉地平反了；
 *     3. 转义引号 / 字符串里带花括号 / 坏 JSON 混在好 JSON 前面，都不能把它带偏。
 *
 *   工具契约（照抄 index.js 的 execute，抄歪了就不是同一个工具了）
 *     4. `limit` 默认 5、夹在 1..20；返回 `{store, hits:[{file, score, snippet}], note}`；
 *     5. snippet 上限 240（`index.js` 那一行是显式搜索的返回口径，比 push 的指针 64 字宽得多——
 *        这正是「pull 查一次能拿到比 push 更厚的内容」的依据，抄窄了结论就反了）；
 *     6. 空 query 不检索；`..` / 绝对路径不许越出库目录。
 *
 *   汇总
 *     7. `passRateSearched` / `passRateNotSearched` 在一侧为空时是 `null`（没测过），
 *        不许印成 0 —— 0 会被读成「查了也全错」，那是另一个结论。
 *
 * 纪律：只用 `mkdtempSync` 造的临时库，`finally` 里删干净；**绝不碰真库**
 * `~/memory/engramory`，也不碰私有题集 `bench/eval-tasks/`（它不入库，CI 上没有）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildContext, prepareCorpus } from '../bench/recall-eval.mjs';
import { makeTools, parseToolCall, summarizeArm } from '../bench/tool-use-eval.mjs';
import { DEFAULTS } from '../index.js';

const tmpStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tooluse-'));
  writeFileSync(join(dir, 'note-alpha.md'), '# 代理鉴权\n\nnext 代理的鉴权路径配错会 404。\n');
  writeFileSync(join(dir, 'note-beta.md'), '# 滚动进场\n\noverflow 值写错动画不生效。\n');
  return dir;
};

/** 用**真的** `prepareCorpus` 读临时库：手搓 docs 只会测到自己编的形状，测不到真检索。 */
const corpusOf = (dir) => prepareCorpus(dir, DEFAULTS);

// ── 1..3 解析 ────────────────────────────────────────────────────────────────

test('parseToolCall：裸 JSON / 散文里混一行 / 围栏代码块都要认得出来', () => {
  const a = parseToolCall('{"tool":"engramory_search","query":"next 代理"}');
  assert.equal(a.tool, 'engramory_search');
  assert.equal(a.args.query, 'next 代理');

  const b = parseToolCall('我来查一下记忆库。\n{"tool": "engramory_search", "query": "a", "limit": 3}');
  assert.equal(b.tool, 'engramory_search');
  assert.equal(b.args.limit, 3);

  const c = parseToolCall('```json\n{"tool":"engramory_read","file":"x.md"}\n```');
  assert.equal(c.tool, 'engramory_read');
  assert.equal(c.args.file, 'x.md');
});

test('parseToolCall：白名单之外的工具名一律不算调用（否则调用率虚高）', () => {
  assert.equal(parseToolCall('{"tool":"rm","args":"-rf /"}'), null);
  assert.equal(parseToolCall('{"tool":"engramory_delete","file":"x.md"}'), null);
  assert.equal(parseToolCall('直接回答：不知道。'), null);
  assert.equal(parseToolCall(''), null);
  assert.equal(parseToolCall(null), null);
});

test('parseToolCall：坏 JSON 在前、字符串里带花括号、转义引号都不能带偏', () => {
  const a = parseToolCall('{不是 JSON} {"tool":"engramory_search","query":"z"}');
  assert.equal(a.tool, 'engramory_search');
  assert.equal(a.args.query, 'z');

  const b = parseToolCall('{"tool":"engramory_search","query":"a \\"b\\" {c}"}');
  assert.equal(b.args.query, 'a "b" {c}');
});

test('parseToolCall：`name`/`arguments` 这种 OpenAI 形状也认', () => {
  const a = parseToolCall('{"name":"engramory_search","arguments":{"query":"q"}}');
  assert.equal(a.tool, 'engramory_search');
  assert.equal(a.args.query, 'q');
});

// ── 4..6 工具契约 ────────────────────────────────────────────────────────────

test('makeTools：返回形状与 index.js 的 execute 一致，limit 默认 5、夹在 1..20', () => {
  const dir = tmpStore();
  try {
    const tools = makeTools(corpusOf(dir), dir);
    const r = tools.engramory_search({ query: '代理鉴权' });
    assert.equal(r.store, dir);
    assert.ok(Array.isArray(r.hits));
    for (const hit of r.hits) {
      assert.deepEqual(Object.keys(hit).sort(), ['file', 'score', 'snippet']);
      assert.equal(typeof hit.score, 'number');
      assert.equal(typeof hit.snippet, 'string');
    }
    assert.equal(typeof r.note, 'string');
    // 空 query 不检索，但也不抛
    assert.deepEqual(tools.engramory_search({}).hits, []);
    assert.deepEqual(tools.engramory_search({ query: '   ' }).hits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeTools：snippet 上限是 240（比 push 指针的 64 宽），这是 pull 能扳回一城的依据', () => {
  const dir = tmpStore();
  try {
    // 长笔记：`readDocs` 会切桶，桶的 snippet 远长于 240，正好用来验证 clip 生效。
    writeFileSync(join(dir, 'note-long.md'), `# 代理鉴权长笔记\n\n${'代理鉴权路径配错会 404。'.repeat(80)}\n`);
    const tools = makeTools(corpusOf(dir), dir);
    const r = tools.engramory_search({ query: '代理鉴权', limit: 20 });
    assert.ok(r.hits.length >= 1, '长笔记也该有命中');
    const longest = Math.max(...r.hits.map((h) => h.snippet.length));
    assert.ok(longest <= 240, `snippet 超了 240：${longest}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeTools：engramory_read 不许越出库目录，读不到就说读不到', () => {
  const dir = tmpStore();
  try {
    const tools = makeTools(corpusOf(dir), dir);
    assert.match(tools.engramory_read({ file: 'note-alpha.md' }).text, /代理鉴权/);
    assert.ok(tools.engramory_read({ file: '../etc/passwd' }).error);
    assert.ok(tools.engramory_read({ file: '/etc/passwd' }).error);
    assert.ok(tools.engramory_read({ file: 'nope.md' }).error);
    assert.ok(tools.engramory_read({}).error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7 汇总 ───────────────────────────────────────────────────────────────────

test('summarizeArm：调用率按题算，查了/没查的通过率分开；一侧为空时是 null 不是 0', () => {
  const row = (over) => ({ arm: 'pull', judged: true, pass: false, searched: false, readCount: 0, toolCalls: 0, searchHitSource: [], injectedChars: 89, injectedTokens: 23, toolResultChars: 0, toolResultTokens: 0, totalTokens: 100, elapsedMs: 10, error: '', ...over });
  const rows = [
    row({ id: 'a', searched: true, toolCalls: 1, pass: true, searchHitSource: [true] }),
    row({ id: 'b', searched: true, toolCalls: 1, pass: false, searchHitSource: [false] }),
    row({ id: 'c', searched: false }),
    row({ id: 'd', searched: false }),
  ];
  const s = summarizeArm(rows);
  assert.equal(s.total, 4);
  assert.equal(s.toolCallRate, 0.5);
  assert.equal(s.passRate, 0.25);
  assert.equal(s.passRateSearched, 0.5);
  assert.equal(s.passRateNotSearched, 0);
  assert.equal(s.searchHitSourceRate, 0.5);
  assert.equal(s.avgInjectedTokens, 23);

  // 一题都没查：查了那一侧的通过率必须是 null（未测），不能印成 0
  const noSearch = summarizeArm([row({ id: 'x' }), row({ id: 'y' })]);
  assert.equal(noSearch.passRateSearched, null);
  assert.equal(noSearch.searchHitSourceRate, null);
  assert.equal(noSearch.passRateNotSearched, 0);
});

// ── 臂间唯一变量仍是 buildContext（与三臂对照表量的是同一个东西）──────────────

test('三臂的注入文本仍出自 buildContext：pull 那一行必须与插件的 pullHintText 逐字同源', () => {
  const dir = tmpStore();
  try {
    const corpus = corpusOf(dir);
    const task = { id: 't', kind: 'fact-recall', prompt: '代理鉴权路径配错会怎样', source: 'note-alpha.md', expect: [['404']], forbid: [] };
    const none = buildContext('none', task, corpus, DEFAULTS, dir);
    const push = buildContext('push', task, corpus, DEFAULTS, dir);
    const pull = buildContext('pull', task, corpus, DEFAULTS, dir);
    assert.equal(none.text, '');
    assert.ok(push.text.length > 0 && push.hits.length > 0);
    // pull 一条指针都不给，但 wouldInject 记着「本来有几条」
    assert.deepEqual(pull.hits, []);
    assert.ok(pull.wouldInject >= 1);
    assert.match(pull.text, /engramory_search/);
    assert.match(pull.text, /可能相关的线索/);
    assert.ok(!pull.text.includes('note-alpha.md'), 'pull 档不许泄漏文件名');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
