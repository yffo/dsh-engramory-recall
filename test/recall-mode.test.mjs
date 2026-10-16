/**
 * 注入策略（`recallMode`，0.21.0）：push / hybrid / pull 三档各自往上下文里放什么、账本怎么记。
 *
 * 为什么这么测：
 *   1. `push` 是**默认档 = 现有行为**，所以它必须有黄金样本**逐字**对拍。样本是用 0.20.0
 *      （改动前的 HEAD，`git archive HEAD` 到仓外跑同一个桩）实测出来的，不是照改动后的
 *      输出抄的 —— 抄一遍只能证明「代码和它自己一致」，「没变」得靠外部基准作证；
 *   2. `hybrid` / `pull` 是新增行为，钉住「注入了几条」之外更要钉「**没有**注入什么」：
 *      pull 一旦漏推了指针，那是整档语义反了，而不是少了一行字；
 *   3. 账本单列一份口径：`hint` 不许冒充 `hit`（`hit` 是打开率的分母），`wouldInject` 要如实
 *      回答「本来会注入几条」—— 三档对照全靠它。
 *
 * 桩法与 `test/usage.test.mjs` / `test/recall.test.mjs` 一致：假 ctx 跑真实 `apply()`，
 * 库是临时目录里的 4 篇小笔记（3 篇与「代理节点」相关，1 篇刻意无关）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import { RECALL_HEADER } from '../render.js';
import { readUsage } from '../usage.js';

/** 0.20.0 实测的黄金注入文本（3 条命中，逐字，含换行）。 */
const GOLDEN_TEXT = [
  RECALL_HEADER,
  '- reference-proxy-b.md — Trojan 兜底端口。',
  '- reference-proxy-a.md — 美国自建代理节点的部署与切换都在这台机器上完成。',
  '- reference-proxy-c.md — 美国自建代理节点的部署与切换都在这台机器上完成。',
].join('\n');
const GOLDEN_SUMMARY = 'engramory 召回 3 条';
/** 0.20.0 实测的黄金账本行（`ts` 剥掉，那种东西没法比）。 */
const GOLDEN_LEDGER = {
  kind: 'hit',
  query: '代理节点是怎么搭的？',
  scope: 'main',
  depth: 0,
  ids: ['reference-proxy-b.md', 'reference-proxy-a.md', 'reference-proxy-c.md'],
  scores: [3.467, 2.298, 2.298],
  topScore: 3.467,
  injected: 3,
  collapsed: 0,
  dropped: 0,
  collapsedIds: [],
  budget: 480,
  spent: 218,
  noteChars: 350,
  gate: 'assist',
};

const QUERY = '代理节点是怎么搭的？';
/** 与假库里的任何一篇都不沾边的提问（零命中 → 三档都该保持沉默）。 */
const NO_HIT_QUERY = '晚饭吃什么比较好呢';

/** 建一个假库：4 篇笔记，其中 3 篇与「代理节点」相关（与黄金样本同一份 fixture）。 */
function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-mode-'));
  writeFileSync(
    join(dir, 'MEMORY.md'),
    [
      '# Memory Index',
      '',
      '- [代理节点 A](reference-proxy-a.md) — Hy2 双端口',
      '- [代理节点 B](reference-proxy-b.md) — Trojan 兜底',
      '- [代理节点 C](reference-proxy-c.md) — CDN 转发',
      '',
    ].join('\n'),
  );
  const shared = '美国自建代理节点的部署与切换都在这台机器上完成';
  writeFileSync(
    join(dir, 'reference-proxy-a.md'),
    ['---', 'name: reference-proxy-a', 'description: 代理节点架构 A', 'type: reference', '---', '', '# 代理节点 A', '', `${shared}。Hy2 双端口主力。`].join('\n'),
  );
  writeFileSync(
    join(dir, 'reference-proxy-b.md'),
    ['---', 'name: reference-proxy-b', 'description: 代理节点架构 B', 'type: reference', '---', '', '# 代理节点 B', '', `${shared}。Trojan 兜底端口。`].join('\n'),
  );
  writeFileSync(
    join(dir, 'reference-proxy-c.md'),
    ['---', 'name: reference-proxy-c', 'description: 代理节点架构 C', 'type: reference', '---', '', '# 代理节点 C', '', `${shared}。国内 CDN 转发不可行。`].join('\n'),
  );
  writeFileSync(
    join(dir, 'reference-unrelated.md'),
    ['---', 'name: reference-unrelated', 'description: 无关笔记', 'type: reference', '---', '', '# 无关', '', '这条笔记讲的是完全不相干的事情。'].join('\n'),
  );
  return dir;
}

function captureHandler(config) {
  let handler;
  const ctx = {
    on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; },
    get: () => undefined,
    tools: { register: () => {}, guard: () => () => {} },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ webServer: { register: () => () => {} } });
      if (deps.includes('skills')) fn({ effect: (f) => f(), skills: { register: () => () => {} } });
    },
  };
  apply(ctx, config);
  assert.ok(handler, 'apply() 应当注册 agent/pre-step 监听');
  return { handler };
}

const human = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/**
 * 跑一轮召回，回「注入了什么」与账本。库在返回前删掉 —— 调用方只需要文本与路径字符串。
 * `injected: false` 表示这一轮**什么都没往上下文里加**（宿主原样放行）。
 */
async function runRound(extra = {}, query = QUERY) {
  const store = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: store, minScore: 0, maxPointers: 4, ...extra });
    const decision = { kind: 'enter', messages: [human('h1', query)] };
    const out = await handler({}, async () => decision);
    const injected = out.messages.length > decision.messages.length ? out.messages[out.messages.length - 1] : null;
    return {
      store,
      injected: Boolean(injected),
      text: injected?.content?.[0]?.text ?? null,
      summary: injected?.source?.summary ?? null,
      ledger: readUsage(store).map(({ ts, ...rest }) => rest),
    };
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

test('push（默认档）：注入文本与账本行与 0.20.0 逐字相同，只多一个 mode', async () => {
  const dflt = await runRound();
  assert.equal(dflt.text, GOLDEN_TEXT, '默认档的注入文本必须一字不差');
  assert.equal(dflt.summary, GOLDEN_SUMMARY);
  assert.deepEqual(dflt.ledger, [{ ...GOLDEN_LEDGER, mode: 'push' }], 'push 行除 mode 外必须逐字段相同');

  // 显式写 push 与不写，走的是同一条路（默认档不能被配置写法分成两种行为）
  const explicit = await runRound({ recallMode: 'push' });
  assert.equal(explicit.text, GOLDEN_TEXT);
  assert.deepEqual(explicit.ledger, [{ ...GOLDEN_LEDGER, mode: 'push' }]);
});

test('hybrid：三命中只推最靠前的 1 条，其余照旧', async () => {
  const { text, summary, ledger } = await runRound({ recallMode: 'hybrid' });
  assert.equal(
    text,
    [RECALL_HEADER, '- reference-proxy-b.md — Trojan 兜底端口。'].join('\n'),
    'hybrid 只推第 1 条（分数最高的那条）',
  );
  assert.ok(!text.includes('reference-proxy-a.md') && !text.includes('reference-proxy-c.md'), '第 2、3 条不许再出现');
  assert.equal(summary, 'engramory 召回 1 条');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, 'hit', 'hybrid 仍然注入了指针 —— 账本记 hit');
  assert.equal(ledger[0].mode, 'hybrid');
  assert.deepEqual(ledger[0].ids, ['reference-proxy-b.md']);
  assert.deepEqual(ledger[0].scores, [3.467]);
  assert.equal(ledger[0].injected, 1);
  assert.equal(ledger[0].topScore, 3.467);
  assert.ok(!('wouldInject' in ledger[0]), 'wouldInject 是 pull 档的字段，别人不许有');
});

test('pull：本来有 3 条命中 → 只推一行提示，账本记 hint + wouldInject', async () => {
  const { store, text, summary, ledger } = await runRound({ recallMode: 'pull' });
  const hint = `[engramory] 记忆库里有 3 条可能相关的线索，需要时用 engramory_search 自己查（库：${store}）。`;
  assert.equal(text, hint, 'pull 这一轮注入的就是这一行，逐字');
  assert.ok(!text.includes('reference-proxy-'), 'pull 一条指针都不许推');
  assert.ok(!text.includes(RECALL_HEADER), '没推指针就不该带召回表头');
  assert.equal(summary, 'engramory 提示：库里有 3 条可能相关的线索');

  // 长度红线：提示正文 ≤ 80 字，**不含路径**（路径长度由用户环境决定，不该算进这句话）
  const body = hint.replace(store, '');
  assert.ok([...body].length <= 80, `提示正文该 ≤ 80 字，实际 ${[...body].length}`);

  assert.deepEqual(ledger, [{
    kind: 'hint',
    query: QUERY,
    mode: 'pull',
    scope: 'main',
    depth: 0,
    ids: [],
    scores: [],
    injected: 0,
    chars: hint.length,
    wouldInject: 3,
  }], 'hint 行的字段要如实：没注入指针、但记下本来会注入几条');
});

test('pull：一条都不匹配 → 什么都不注入（没命中就不出声）', async () => {
  const { injected, text, ledger } = await runRound({ recallMode: 'pull' }, NO_HIT_QUERY);
  assert.equal(injected, false, '把「一条都没有」变成一行提示，等于每轮都加噪音');
  assert.equal(text, null);
  // 空轮照 0.20.0 的规矩记 `empty`（这一轮为什么没注入，账本里仍要能查）
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, 'empty');
  assert.equal(ledger[0].mode, 'pull');
  assert.equal(ledger[0].reason, 'no-hits');
  assert.ok(!('wouldInject' in ledger[0]), '压根没有候选，就没有「本来会注入几条」这回事');
});

test('非法 recallMode 一律退回 push（默认档），不抛', async () => {
  // `'pull '` 带空格必须算非法：猜用户想选哪一档，代价是不对称的（见 index.js 的注释）
  for (const bad of [null, 'pull ', 42, {}, 'PULL', 'hybird', true, ['pull'], '']) {
    const { text, summary, ledger } = await runRound({ recallMode: bad });
    assert.equal(text, GOLDEN_TEXT, `recallMode=${JSON.stringify(bad)} 必须退回 push 的行为`);
    assert.equal(summary, GOLDEN_SUMMARY);
    assert.deepEqual(ledger, [{ ...GOLDEN_LEDGER, mode: 'push' }], `recallMode=${JSON.stringify(bad)} 的账本也要记 push`);
  }
});
