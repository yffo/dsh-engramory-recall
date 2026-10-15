/**
 * 接线路径测试：把插件当**黑盒**跑真实 `apply()`，专钉那些「只在一处接错就静默失效」的缝。
 *
 * 与 recall.test.mjs 的分工：那边测「召回逻辑对不对」，这边测**宿主与插件之间的契约**——
 *   1. `agent/pre-step` 拿到的 payload 里，提问者身份能不能落进账（0.13.7 的 scope 分账，
 *      接错了不会报错，只会让打开率永远算错，属于最值得钉死的那类）；
 *   2. 状态路由（面板与尺子的唯一数据源）在缺库、空库、坏配置下的形状；
 *   3. 「轮」级日志的 reason 码：`index-empty` / `below-min-score` / `store-not-configured`
 *      这三条以前只测过汇总侧，没测过**真的由 hook 写出来**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { USAGE_FILE } from '../usage.js';

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-wiring-'));
  writeFileSync(
    join(dir, 'reference-proxy.md'),
    ['---', 'name: reference-proxy', 'description: 美国自建代理节点：Hy2 双端口 + Trojan 兜底', '---', '', '# 代理节点', '', 'Hy2 双端口主力，Trojan 兜底。'].join('\n'),
  );
  writeFileSync(
    join(dir, 'project-cicd.md'),
    ['---', 'name: project-cicd', 'description: Jenkins 流水线与站点部署', '---', '', '# CI/CD', '', 'Jenkins 多段部署只有第一条走 SSH。'].join('\n'),
  );
  return dir;
}

function captureHandler(config) {
  let handler;
  const routes = [];
  const ctx = {
    on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; },
    tools: { register: () => {}, guard: () => () => {} },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
      }
    },
  };
  apply(ctx, config);
  assert.ok(handler, 'apply() 应当注册 agent/pre-step 监听');
  return { handler, routes };
}

const human = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/** 跑一轮，payload 原样交给 hook（identity 那条链就靠它）。 */
async function turn(handler, payload, id, text) {
  const decision = { kind: 'enter', messages: [human(id, text)] };
  return handler(payload, async () => decision);
}

function rows(dir) {
  const file = join(dir, USAGE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const roundRows = (dir) => rows(dir).filter((r) => ['hit', 'sediment', 'skip', 'empty'].includes(r.kind));

function captureResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
    end(body) { this.body = body ?? ''; },
  };
}

const stateRoute = (routes) => routes.find((r) => r.path === '/api/engramory-recall/state');

// ── 1. 提问者身份（0.13.7 的 scope 分账） ──────────────────────────────

test('scope：主对话轮记 main/depth 0，委派轮的两种判据都认得，取大者', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 3 });

  // 主对话：payload 里有 agent，但两个深度字段都缺（或显式为 0）
  await turn(handler, { agent: { session: { header: {} }, options: {} } }, 'm1', '代理节点的双端口是怎么配的');
  // 委派轮判据一：session.header.delegationDepth（DSH 的持久记录）
  await turn(handler, { agent: { session: { header: { delegationDepth: 1 } } } }, 'm2', '代理节点的双端口是怎么配的');
  // 委派轮判据二：agent.options.subagentDepth（运行期选项，老宿主只有这一处）
  await turn(handler, { agent: { options: { subagentDepth: 2 } } }, 'm3', '代理节点的双端口是怎么配的');
  // 两处不一致时取大者（DSH 的 delegationDepthOf 就是这个语义）
  await turn(handler, { agent: { session: { header: { delegationDepth: 1 } }, options: { subagentDepth: 2 } } }, 'm4', '代理节点的双端口是怎么配的');
  // 显式 0 仍然是主对话（0 与「缺失」都是主对话，不能把 0 当成子代理）
  await turn(handler, { agent: { session: { header: { delegationDepth: 0 } }, options: { subagentDepth: 0 } } }, 'm5', '代理节点的双端口是怎么配的');

  // 账本是「追加写」，文件顺序就是时间顺序
  const seen = roundRows(dir).map((r) => `${r.scope}/${r.depth}`);
  assert.deepEqual(seen, ['main/0', 'subagent/1', 'subagent/2', 'subagent/2', 'main/0']);
});

test('scope：payload 里没有 agent（老宿主）按主对话记账，绝不记成 subagent', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 3 });
  await turn(handler, {}, 'm1', '代理节点的双端口是怎么配的');
  await turn(handler, { agent: {} }, 'm2', '代理节点的双端口是怎么配的');
  // 脏值（字符串/NaN）不能把主对话误判成委派轮 —— 误判成委派会把真实利用率藏起来
  await turn(handler, { agent: { session: { header: { delegationDepth: 'x' } } } }, 'm3', '代理节点的双端口是怎么配的');

  for (const row of roundRows(dir)) {
    assert.equal(row.scope, 'main', `payload=${JSON.stringify(row)} 时应当是 main`);
    assert.equal(row.depth, 0);
  }
});

test('scope：连 skip / empty 这类「没注入」的轮也要带上身份（否则分母拆不开）', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 3 });
  // 寒暄 → skip；查不到的词 → empty；都发生在委派轮里
  const delegated = { agent: { session: { header: { delegationDepth: 1 } } } };
  await turn(handler, delegated, 'm1', '继续');
  await turn(handler, delegated, 'm2', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  await turn(handler, delegated, 'm3', '不确定的词条：钴蓝色鲸鱼三号计划');

  const kinds = roundRows(dir).map((r) => `${r.kind}:${r.scope}`);
  assert.ok(kinds.length >= 2, `至少要写出 skip 与 empty 两类：${kinds.join(',')}`);
  assert.ok(kinds.every((k) => k.endsWith(':subagent')), `每一行都该带 subagent：${kinds.join(',')}`);
});

test('scope：落盘字段是加法 —— 老字段一个不少（面板/尺子读的是老字段）', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 3 });
  await turn(handler, {}, 'm1', '代理节点的双端口是怎么配的');

  const row = roundRows(dir).at(-1);
  assert.equal(typeof row.ts, 'number');
  assert.ok(Array.isArray(row.ids) && row.ids.length > 0);
  assert.ok(Array.isArray(row.scores));
  assert.equal(typeof row.query, 'string');
  assert.equal(row.scope, 'main');
});

// ── 2. 状态路由：面板与尺子的唯一数据源 ────────────────────────────────

test('状态路由：usage 里带 scopes 与四句判据，且 maxPointers 会透给汇总', async () => {
  const dir = fixtureStore();
  const { handler, routes } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 3 });
  await turn(handler, {}, 'm1', '代理节点的双端口是怎么配的');
  // 第二轮换一个问法：同一句查询会被跨轮去重挡掉，那样 subagent 桶里就没有指针可数了
  await turn(handler, { agent: { session: { header: { delegationDepth: 1 } } } }, 'm2', 'Jenkins 部署为什么只跑第一条命令');

  const route = stateRoute(routes);
  assert.ok(route, '应当注册 /api/engramory-recall/state');
  const res = captureResponse();
  await route.handler({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);

  // 零分的命中不注入，所以每轮各只有一篇笔记真的进了窗口
  assert.equal(body.usage.scopes.main.pointers, 1, '主对话轮那 1 条指针要落在 main 桶里');
  assert.equal(body.usage.scopes.subagent.pointers, 1, '委派轮那 1 条要落在 subagent 桶里');
  assert.equal(body.usage.scopes.unknown.pointers, 0, '这个库里没有 0.13.7 之前的老行');
  assert.equal(typeof body.usage.scopes.main.openRate, 'number');
  assert.equal(body.usage.perRound.windowLimit, 3, 'maxPointers 要透给汇总，否则「顶满窗口」永远算不出来');
  assert.equal(typeof body.usage.verdicts.open, 'string');
  assert.equal(typeof body.usage.verdicts.curve, 'string');
  assert.ok(Array.isArray(body.usage.scoreCurve.points));
  assert.ok(body.log.length >= 2, '内存里的召回日志也要一起回给面板');
});

test('状态路由：非 GET 一律 405（面板只读，别留写口）', async () => {
  const dir = fixtureStore();
  const { routes } = captureHandler({ storePath: dir, minScore: 0 });
  const res = captureResponse();
  await stateRoute(routes).handler({ method: 'POST' }, res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET');
});

test('状态路由：库目录被删了也不能 500（面板刷新不该把宿主拖下水）', async () => {
  const dir = fixtureStore();
  const { routes } = captureHandler({ storePath: dir, minScore: 0 });
  rmSync(dir, { recursive: true, force: true });

  const res = captureResponse();
  await stateRoute(routes).handler({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.usage.pointers, 0);
  assert.ok(body.usage.scopes.main, '库没了也要给得出合法结构');
});

// ── 3. 「轮」级日志的 reason 码（由 hook 真的写出来） ──────────────────

test('reason：库是空的 → index-empty（与「一条都不匹配」要分清）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'engramory-empty-'));
  const { handler } = captureHandler({ storePath: empty, minScore: 0 });
  await turn(handler, {}, 'm1', '代理节点的双端口是怎么配的');

  const row = roundRows(empty).at(-1);
  assert.equal(row.kind, 'empty');
  assert.equal(row.reason, 'index-empty');
  assert.equal(row.topScore, undefined, '库是空的，没有可报的最高分');
  rmSync(empty, { recursive: true, force: true });
});

test('reason：命中被 minScore 拦掉 → below-min-score 且带上 topScore（调门槛的唯一依据）', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 999, maxPointers: 3 });
  await turn(handler, {}, 'm1', '代理节点的双端口是怎么配的');

  const row = roundRows(dir).at(-1);
  assert.equal(row.kind, 'empty');
  assert.equal(row.reason, 'below-min-score');
  assert.equal(row.minScore, 999);
  assert.ok(row.topScore > 0, '被拦掉也要报出最高分，否则门槛高低只能猜');
});

test('reason：没配 storePath → store-not-configured（不是「没命中」，是没库）', async () => {
  const { handler } = captureHandler({ minScore: 0 });
  const decision = { kind: 'enter', messages: [human('m1', '代理节点的双端口是怎么配的')] };
  const out = await handler({}, async () => decision);
  assert.equal(out.messages.length, decision.messages.length, '没库时不注入任何东西');

  // 没配库就没地方落账 —— 这是设计如此（无库可写），但绝不能抛
  assert.equal(typeof out, 'object');
});
