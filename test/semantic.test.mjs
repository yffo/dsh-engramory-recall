// 语义接缝的测试：全部用「临时目录里的假提供方模块」驱动，一个真模型都不调。
//
// 这个文件最要紧的两条不变式：
//   1. 默认关闭时连 import 都不发生（用副作用文件证明，不是靠读代码）；
//   2. 提供方无论怎么坏（抛错 / 卡住 / 返回垃圾 / 编造文件名），词面结果都必须还在。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildIndex } from '../bm25.js';
import { describeSeam, mergeRRF, resolveProviderPath, semanticSearch, withTimeout } from '../semantic.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SHARED = '本地记忆库的检索只在这台机器上跑';

const DOCS = [
  {
    id: 'reference-npm-publish.md',
    title: '把插件发到 npm',
    description: '发版三步与 token 的坑',
    body: `${SHARED}。npm publish 之前先 npm test。granular token 不带 bypass 2FA 时只能读不能发。`,
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'project-pipeline.md',
    title: '构建流水线',
    description: 'CI 上跑什么',
    body: `${SHARED}。推 tag 之后 CI 跑测试与基准自检，两个 Node 版本。`,
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'user-preferences.md',
    title: '表达偏好',
    description: '说话方式',
    body: `${SHARED}。偏好中文短句，能用表格就用表格。`,
    aliases: [],
    mtimeMs: 0,
  },
];
const index = buildIndex(DOCS);
const ALL_HIT_QUERY = '本地记忆库';
const ids = (result) => result.hits.map((hit) => hit.id);

/** 每个用例都自己建临时目录、跑完删掉。 */
function providerCase(name, body) {
  const dir = mkdtempSync(join(tmpdir(), `semantic-${name}-`));
  const file = join(dir, 'provider.mjs');
  writeFileSync(file, body);
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('语义接缝：默认关闭时连 import 都不发生', async () => {
  const marker = join(tmpdir(), `semantic-marker-${Date.now()}`);
  const c = providerCase(
    'off',
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport function rerank() { return []; }\n`,
  );
  try {
    const result = await semanticSearch({ index, query: ALL_HIT_QUERY, limit: 3, config: { provider: '' } });
    assert.equal(result.used, false);
    assert.equal(result.code, 'off');
    assert.equal(existsSync(marker), false, '关着的时候模块绝不能被 import（副作用文件不该出现）');
    assert.equal(result.hits.length, 3, '词面结果照常返回');
  } finally {
    c.cleanup();
    rmSync(marker, { force: true });
  }
});

test('语义接缝：rerank 提供方能改顺序，但改不掉命中的东西', async () => {
  const c = providerCase(
    'rerank',
    `export const name = 'fake-reranker';\nexport function rerank({ docs }) { return [...docs].reverse().map((d) => ({ id: d.id, score: 1 })); }\n`,
  );
  try {
    const lexical = await semanticSearch({ index, query: ALL_HIT_QUERY, limit: 3, config: {} });
    assert.equal(lexical.hits.length, 3, '这个查询要能同时命中三篇，否则看不出顺序变化');
    const sem = await semanticSearch({ index, query: ALL_HIT_QUERY, limit: 3, config: { provider: c.file } });
    assert.equal(sem.used, true);
    assert.equal(sem.code, 'reranked');
    assert.equal(sem.provider, 'fake-reranker');
    assert.deepEqual([...ids(sem)].sort(), [...ids(lexical)].sort(), '融合不许删条（RRF 池子里还是原来那些）');
    assert.notDeepEqual(ids(sem), ids(lexical), '顺序应当被提供方影响');
    assert.ok(sem.ms >= 0);
  } finally {
    c.cleanup();
  }
});

test('语义接缝：提供方编造的文件名一律丢弃并报数', async () => {
  const c = providerCase(
    'invent',
    `export function rerank({ docs }) { return ['不存在-的笔记.md', ...docs.map((d) => ({ id: d.id }))]; }\n`,
  );
  try {
    const result = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: c.file } });
    assert.equal(result.used, true);
    assert.equal(result.dropped, 1, '编造的那一条要被丢掉，真实候选一条不少');
    assert.ok(!ids(result).includes('不存在-的笔记.md'));
  } finally {
    c.cleanup();
  }
});

test('语义接缝：提供方抛错 / 返回垃圾 / 读不到模块，全部降级且说明原因', async () => {
  const thrower = providerCase('throw', `export function rerank() { throw new Error('我不干了'); }\n`);
  const garbage = providerCase('garbage', `export function rerank() { return 42; }\n`);
  const noExport = providerCase('noexport', `export const name = '什么都没有';\n`);
  const missing = join(tmpdir(), 'semantic-不存在-的模块.mjs');
  try {
    const lexical = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: {} });

    const boom = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: thrower.file } });
    assert.equal(boom.used, false);
    assert.equal(boom.code, 'provider-error');
    assert.match(boom.message, /我不干了/);
    assert.deepEqual(ids(boom), ids(lexical));

    const junk = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: garbage.file } });
    assert.equal(junk.code, 'provider-empty');
    assert.deepEqual(ids(junk), ids(lexical));

    const wrong = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: noExport.file } });
    assert.equal(wrong.code, 'unsupported');
    assert.match(wrong.message, /rerank 或 expand/);

    const gone = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: missing } });
    assert.equal(gone.code, 'not-found');
    assert.deepEqual(ids(gone), ids(lexical));
  } finally {
    for (const c of [thrower, garbage, noExport]) c.cleanup();
  }
});

test('语义接缝：提供方卡住时必须按时收手，不能让检索等下去', async () => {
  const c = providerCase('hang', `export function rerank() { return new Promise(() => {}); }\n`);
  try {
    const started = Date.now();
    const result = await semanticSearch({ index, query: 'CI 跑测试', limit: 3, config: { provider: c.file, timeoutMs: 40 } });
    const elapsed = Date.now() - started;
    assert.equal(result.used, false);
    assert.equal(result.code, 'timeout');
    assert.match(result.message, /40ms/);
    assert.ok(elapsed < 1000, `该在超时附近返回，实际 ${elapsed}ms`);
  } finally {
    c.cleanup();
  }
});

test('语义接缝：词面占满 limit 时，expand 提供方一条都不许动（实测：融合会以多欺少）', async () => {
  const c = providerCase(
    'expand-order',
    `export const name = 'fake-expander';\nexport function expand({ query }) { return ['表达偏好 中文短句', query, '   ']; }\n`,
  );
  try {
    const lexical = await semanticSearch({ index, query: ALL_HIT_QUERY, limit: 3, config: {} });
    const expanded = await semanticSearch({ index, query: ALL_HIT_QUERY, limit: 3, config: { provider: c.file } });
    assert.equal(expanded.used, true);
    assert.equal(expanded.code, 'expanded');
    assert.deepEqual(expanded.expansions, ['表达偏好 中文短句'], '去空白、丢掉与原查询重复的那条（重跑一遍原查询没有意义）');
    assert.deepEqual(ids(expanded), ids(lexical), '词面已占满 limit：顺序与条目必须逐字相同');
    assert.equal(expanded.added, 0);
    assert.match(expanded.message, /没有可补的空位/);
  } finally {
    c.cleanup();
  }
});

test('语义接缝：词面不足 limit 时，expand 提供方补位（接在后面，不插队）', async () => {
  const c = providerCase(
    'expand-fill',
    `export const name = 'fake-expander';\nexport function expand() { return ['表达偏好 中文短句']; }\n`,
  );
  try {
    const lexical = await semanticSearch({ index, query: 'npm publish', limit: 3, config: {} });
    assert.ok(lexical.hits.length >= 1 && lexical.hits.length < 3, '夹具里这个查询只命中一部分文档');
    const filled = await semanticSearch({ index, query: 'npm publish', limit: 3, config: { provider: c.file } });
    assert.equal(filled.code, 'expanded');
    assert.ok(filled.added > 0, '有空位就该补上');
    assert.deepEqual(ids(filled).slice(0, lexical.hits.length), ids(lexical), '词面结果原样在前');
    assert.ok(ids(filled).includes('user-preferences.md'), '改写带来的新文档只能接在后面');
  } finally {
    c.cleanup();
  }
});

test('语义接缝：host-llm 只在真有宿主运行时时才启用', async () => {
  const noRuntime = await semanticSearch({ index, query: 'CI', limit: 3, config: { provider: 'host-llm' } });
  assert.equal(noRuntime.used, false);
  assert.equal(noRuntime.code, 'no-host');

  const brokenRuntime = await semanticSearch({
    index,
    query: 'CI',
    limit: 3,
    config: { provider: 'host-llm' },
    runtime: { ctx: { get: () => undefined }, config: {} },
  });
  assert.equal(brokenRuntime.used, false);
  assert.equal(brokenRuntime.code, 'no-route');
  assert.match(brokenRuntime.message, /没有可用的默认模型/);
});

test('语义接缝：RRF 融合按名次算分，且是确定的', () => {
  const merged = mergeRRF([['a', 'b', 'c'], ['c', 'a']], 3);
  assert.deepEqual(merged, ['a', 'c', 'b'], '两个列表里都靠前的排前面');
  assert.deepEqual(mergeRRF([['x', 'y'], ['y', 'x']], 2), ['x', 'y'], '同分时按 id 字典序，保证确定');
});

test('语义接缝：路径解析（~ 与相对路径）与 describeSeam', () => {
  assert.equal(resolveProviderPath('~/x.mjs'), join(process.env.HOME ?? '', 'x.mjs'));
  assert.equal(resolveProviderPath('./providers/a.mjs', '/base'), '/base/providers/a.mjs');
  assert.equal(resolveProviderPath('/abs/a.mjs', '/base'), '/abs/a.mjs');
  assert.equal(resolveProviderPath('', '/base'), '');
  assert.equal(describeSeam({}).enabled, false);
  assert.equal(describeSeam({ provider: 'host-llm' }).kind, 'host-llm');
  assert.equal(describeSeam({ provider: './a.mjs' }).kind, 'module');
});

test('语义接缝：withTimeout 对忽略 signal 的提供方也收得住', async () => {
  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), 30),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /30ms/);
      return true;
    },
  );
  const value = await withTimeout(async () => '按时回来', 1000);
  assert.equal(value, '按时回来');
});

test('语义接缝：module 形式不静态 import 宿主包，也不静态 import llm.js', () => {
  const source = readFileSync(join(root, 'semantic.js'), 'utf8');
  const staticImports = [...source.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.ok(!staticImports.some((spec) => spec.startsWith('@deepseek-ai/')), `不许静态 import 宿主包：${staticImports.join(', ')}`);
  assert.ok(!staticImports.includes('./llm.js'), 'llm.js 只能动态 import');
  assert.match(source, /await import\('\.\/llm\.js'\)/, 'host-llm 走动态 import');
  assert.deepEqual(staticImports.filter((spec) => spec.startsWith('.')), ['./bm25.js'], '本地静态依赖只有 bm25.js');
});
