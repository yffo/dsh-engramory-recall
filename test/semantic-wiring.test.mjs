/**
 * 接线测试：语义接缝（semantic.js）怎么挂进插件 —— 以及**关着的时候它到底在不在**。
 *
 * 这一层测的不是接缝自己的逻辑（那在 test/semantic.test.mjs），而是两条结构性保证：
 *   1. 默认关闭：检索工具走的是原来那条同步路径，提供方模块连 import 都不发生；
 *   2. 每轮自动注入那条路径**永远**不碰接缝 —— 自动召回每轮都跑，挂外部件等于给每个用户轮加税。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-semantic-wiring-'));
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory Index\n\n- [代理节点](reference-proxy.md) — Hy2 双端口\n');
  const shared = '本地记忆库的检索只在这台机器上跑';
  writeFileSync(
    join(dir, 'reference-proxy.md'),
    ['---', 'name: reference-proxy', 'description: 美国自建代理节点架构', 'type: reference', '---', '', '# 代理节点', '', `${shared}。Hy2 双端口主力 + Trojan 兜底。`].join('\n'),
  );
  writeFileSync(
    join(dir, 'project-cicd.md'),
    ['---', 'name: project-cicd', 'description: Jenkins 流水线与站点部署', '---', '', '# CI/CD', '', `${shared}。Jenkins 多段部署只有第一条走 SSH。`].join('\n'),
  );
  // 第三篇是「改顺序」那几条用例需要的：两条候选时「反转」在 RRF 下是平局（对称），
  // 名次分一模一样，最后按 id 排回去 —— 看起来就像提供方没生效。
  writeFileSync(
    join(dir, 'user-preferences.md'),
    ['---', 'name: user-preferences', 'description: 说话方式与格式偏好', 'type: user', '---', '', '# 表达偏好', '', `${shared}。偏好中文短句，能用表格就用表格。`].join('\n'),
  );
  return dir;
}

function captureHandler(config) {
  let handler;
  const tools = new Map();
  const ctx = {
    on: (event, fn) => {
      if (event === 'agent/pre-step') handler = fn;
    },
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    tools: { register: (definition) => tools.set(definition.name, definition), guard: () => () => {} },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ webServer: { register: () => () => {} } });
      if (deps.includes('skills')) fn({ effect: (f) => f(), skills: { register: () => () => {} } });
    },
  };
  apply(ctx, config);
  return { handler, tools };
}

const human = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/** 假提供方：import 时写一个标记文件，用来证明「关着的时候连 import 都没发生」。 */
function markerProvider(marker, body) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-provider-'));
  const file = join(dir, 'provider.mjs');
  writeFileSync(file, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '1');\n${body}\n`);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('语义接缝：默认关闭时检索工具不打标、不 import 提供方', async () => {
  const store = fixtureStore();
  const marker = join(tmpdir(), `engramory-seam-marker-${Date.now()}`);
  const provider = markerProvider(marker, 'export function rerank() { return []; }');
  try {
    const { tools } = captureHandler({ storePath: store });
    const tool = tools.get('engramory_search');
    const value = await tool.execute({ query: '记忆库' });
    assert.equal(value.semantic.used, false);
    assert.equal(value.semantic.code, 'off');
    assert.ok(value.hits.length >= 1);
    assert.equal(existsSync(marker), false, '默认路径绝不能 import 提供方（哪怕配置里写了别的开关）');

    // 提供方文件躺在磁盘上也不会被碰：配置里没写它。
    assert.ok(provider.file);
  } finally {
    provider.cleanup();
    rmSync(store, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test('语义接缝：配了提供方就真的融合，顺序变、条目不丢，并如实报 code', async () => {
  const store = fixtureStore();
  const marker = join(tmpdir(), `engramory-seam-marker2-${Date.now()}`);
  const provider = markerProvider(marker, `export const name = 'fake-reranker';\nexport function rerank({ docs }) { return [...docs].reverse().map((d) => ({ id: d.id })); }`);
  try {
    const lexicalOnly = captureHandler({ storePath: store });
    const before = await lexicalOnly.tools.get('engramory_search').execute({ query: '记忆库' });

    const { tools } = captureHandler({ storePath: store, semanticProvider: provider.file });
    const after = await tools.get('engramory_search').execute({ query: '记忆库' });
    assert.equal(existsSync(marker), true, '配了就该 import');
    assert.equal(after.semantic.used, true);
    assert.equal(after.semantic.code, 'reranked');
    assert.deepEqual(
      after.hits.map((h) => h.file).sort(),
      before.hits.map((h) => h.file).sort(),
      '融合不许丢命中',
    );
    assert.notDeepEqual(after.hits.map((h) => h.file), before.hits.map((h) => h.file), '顺序应当被提供方改掉');
  } finally {
    provider.cleanup();
    rmSync(store, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test('语义接缝：提供方卡住时工具照常返回词面结果，并报 timeout', async () => {
  const store = fixtureStore();
  const provider = markerProvider(join(tmpdir(), `engramory-seam-marker3-${Date.now()}`), 'export function rerank() { return new Promise(() => {}); }');
  try {
    const { tools } = captureHandler({ storePath: store, semanticProvider: provider.file, semanticTimeoutMs: 40 });
    const started = Date.now();
    const value = await tools.get('engramory_search').execute({ query: '记忆库' });
    assert.equal(value.semantic.used, false);
    assert.equal(value.semantic.code, 'timeout');
    assert.ok(value.hits.length >= 1, '降级之后词面结果必须在');
    assert.ok(Date.now() - started < 1000);
  } finally {
    provider.cleanup();
    rmSync(store, { recursive: true, force: true });
  }
});

test('语义接缝：每轮自动注入那条路径不碰接缝（配了也不碰）', async () => {
  const store = fixtureStore();
  const marker = join(tmpdir(), `engramory-seam-marker4-${Date.now()}`);
  const provider = markerProvider(marker, `export const name = 'fake-reranker';\nexport function rerank({ docs }) { return docs.map((d) => ({ id: d.id })); }`);
  try {
    const { handler } = captureHandler({ storePath: store, semanticProvider: provider.file, minScore: 0, maxPointers: 3 });
    const decision = { kind: 'enter', messages: [human('h1', '代理节点是怎么部署的？')] };
    const out = await handler({}, async () => decision);
    const injected = out.messages.slice(decision.messages.length);
    assert.ok(injected.length >= 1, '自动召回该照常注入指针');
    assert.equal(existsSync(marker), false, '自动注入是热路径：绝不许碰语义接缝');
  } finally {
    provider.cleanup();
    rmSync(store, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test('语义接缝：index.js 静态 import 的是 semantic.js，llm.js 依旧只能动态 import', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const staticImports = [...source.matchAll(/^\s*import\s[^;]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(staticImports.includes('./semantic.js'), '接缝模块可以静态引（它零依赖、不 import 宿主包）');
  assert.equal(staticImports.includes('./llm.js'), false, 'llm.js 仍然不许静态 import');
  assert.match(source, /await import\('\.\/llm\.js'\)/);
});
