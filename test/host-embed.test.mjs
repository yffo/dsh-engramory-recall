// `host-embed` 的测试：把「复用 DSH 设置页里那条路由」这件事拆开验。
//
// 这里不碰真 DSH、也不联网：宿主侧只提供三个服务（settings / credentials / agentDefaultModel），
// embedding 接口用一个本地假服务器顶替。要证明的是这几条：
//   1. 路由 → baseURL → 模型 → 密钥 四步都能从宿主读到，并且真的带着 Bearer 头发请求；
//   2. 每一步缺失都给出**可照做**的失败信息，且**降级回词面结果**（绝不抛、绝不返回空）；
//   3. 失败信息里没有密钥。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { buildIndex } from '../bm25.js';
import { semanticSearch } from '../semantic.js';

const KEY = 'sk-test-host-embed-0123456789';

// 主题标签：假向量器只看这个标签，于是「语义对不对」完全由测试说了算，不受关键词巧合影响。
const DOCS = [
  {
    id: 'cache.md',
    title: '缓存',
    description: '',
    body: `npm publish 缓存 cache 缓存 缓存 缓存 笔记 笔记 笔记 #topic:cache#`,
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'publish.md',
    title: '发布',
    description: '',
    body: 'npm publish 的次序与 token 笔记 #topic:publish#',
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'pref.md',
    title: '偏好',
    description: '',
    body: '表达偏好 preference 的中文短句 笔记 #topic:preference#',
    aliases: [],
    mtimeMs: 0,
  },
];
const index = buildIndex(DOCS);
// 词面：cache.md 靠重复拿到第一，publish.md 第二、pref.md 第三；
// 语义（标签）：真正该排第一的是 publish.md —— 这正是「词面够不着、语义顶上来」的形状。
const QUERY = 'npm publish 缓存 cache 笔记 #topic:publish#';

/** 假 embeddings 服务：主题维 one-hot（命中哪个主题给哪一维 1，都不命中给「其它」维）。 */
async function fakeServer() {
  const requests = [];
  const TOPICS = ['cache', 'publish', 'preference'];
  const vectors = (text) => {
    const hit = /#topic:(\w+)#/.exec(text)?.[1] ?? '';
    const row = TOPICS.map((topic) => (hit === topic ? 1 : 0));
    row.push(hit ? 0 : 1); // 没打标签的文本落在「其它」维：与任何查询都正交
    return row;
  };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: request.url, headers: request.headers, body });
      const rows = (body.input ?? []).map((text, i) => ({ embedding: vectors(String(text ?? '')), index: i }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: rows, model: body.model }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 宿主运行时的最小替身：runtime.ctx.get(name) 就是三个假服务。 */
function fakeRuntime({ profile, key = KEY, defaultProvider = '', describeImpl } = {}) {
  const services = {
    settings: {
      describe:
        describeImpl ??
        (() => [
          {
            ns: 'llm-pi-ai',
            revision: 1,
            user: { providers: { openai: profile ?? {} } },
            value: { providers: { openai: profile ?? {} } },
            base: {},
          },
        ]),
    },
    credentials: {
      resolve: async (ref) => (key && ref ? { value: key, source: 'file' } : undefined),
      describe: async (ref) => ({ configured: Boolean(key && ref), source: 'file', writable: true }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: defaultProvider, model: 'gpt-4o' }) },
  };
  return {
    ctx: { get: (name) => services[name] },
    config: { provider: '', model: '', timeoutMs: 30000 },
  };
}

test('host-embed：路由 / baseURL / 模型 / 密钥四步都从宿主读出来，并真的带上 Bearer 头', async () => {
  const server = await fakeServer();
  try {
    const runtime = fakeRuntime({
      defaultProvider: 'openai',
      profile: { baseURL: server.baseUrl, apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'text-embedding-3-small' }] },
    });
    const result = await semanticSearch({
      index,
      query: QUERY,
      limit: 2,
      config: { provider: 'host-embed', pool: 3, fusion: 'trust', timeoutMs: 5000 },
      runtime,
    });

    assert.equal(result.used, true, '接缝应该真的生效');
    assert.equal(result.code, 'reranked');
    assert.equal(result.fusion, 'trust');
    assert.equal(result.pool, 3);
    assert.equal(result.hits[0].id, 'publish.md', '语义上对的那条要被顶到第一（词面它是第二）');
    assert.ok(!JSON.stringify(result).includes(KEY), '结果里不许出现密钥');

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/v1/embeddings');
    assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(server.requests[0].body.model, 'text-embedding-3-small');
  } finally {
    await server.close();
  }
});

test('host-embed：宿主没有密钥时降到词面，并说清 ref 名字与去哪填', async () => {
  const server = await fakeServer();
  try {
    const runtime = fakeRuntime({
      key: '',
      defaultProvider: 'openai',
      profile: { baseURL: server.baseUrl, apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'text-embedding-3-small' }] },
    });
    const result = await semanticSearch({
      index,
      query: QUERY,
      limit: 2,
      config: { provider: 'host-embed', pool: 3, timeoutMs: 5000 },
      runtime,
    });
    assert.equal(result.used, false);
    assert.equal(result.code, 'no-key');
    assert.match(result.message, /OPENAI_API_KEY/, '要说清缺的是哪个 ref');
    assert.match(result.message, /设置/, '要指出去哪填密钥');
    assert.equal(server.requests.length, 0, '没密钥就不许发请求');
    assert.equal(result.hits[0].id, 'cache.md', '降级后就是词面结果');
  } finally {
    await server.close();
  }
});

test('host-embed：目录自带路由没有 baseURL 时，给出可照做的提示而不是一句「配置错误」', async () => {
  const runtime = fakeRuntime({ defaultProvider: 'deepseek', profile: {} });
  const result = await semanticSearch({
    index,
    query: QUERY,
    limit: 2,
    config: { provider: 'host-embed', pool: 3, timeoutMs: 5000 },
    runtime,
  });
  assert.equal(result.code, 'no-base-url');
  assert.match(result.message, /deepseek/);
  assert.match(result.message, /自定义模型 API/, '要告诉用户在哪加一条路由');
  assert.equal(result.hits[0].id, 'cache.md');
});

test('host-embed：宿主没有设置服务（MCP 那种场景）就明确说没宿主', async () => {
  const result = await semanticSearch({
    index,
    query: QUERY,
    limit: 2,
    config: { provider: 'host-embed', pool: 3, timeoutMs: 5000 },
  });
  assert.equal(result.code, 'no-host');
  assert.match(result.message, /ctx\.settings/);
  assert.match(result.message, /本地模块提供方/, '要给出替代路径');
  assert.equal(result.hits[0].id, 'cache.md');
});

test('host-embed：显式 hostRoute 优先于宿主默认模型；模型按 /embed/ 挑，单个模型的路由直接用', async () => {
  const server = await fakeServer();
  try {
    const rows = [
      {
        ns: 'llm-pi-ai',
        revision: 1,
        user: { providers: {} },
        value: {
          providers: {
            zai: { baseURL: server.baseUrl, models: [{ id: 'glm-4' }, { id: 'embedding-3' }] },
          },
        },
      },
    ];
    const runtime = fakeRuntime({ describeImpl: () => rows, defaultProvider: 'openai' });
    const result = await semanticSearch({
      index,
      query: QUERY,
      limit: 2,
      // hostRoute 指到 zai：默认模型是 openai，但这里必须走 zai；模型要从两个里挑出 embedding-3
      config: { provider: 'host-embed', hostRoute: 'zai', pool: 3, fusion: 'trust', timeoutMs: 5000 },
      runtime,
    });
    assert.equal(result.used, true);
    assert.equal(server.requests[0].body.model, 'embedding-3', '两个模型时按 /embed/ 挑，不猜');
    assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`, '路由没写 apiKeyEnv 时按 <ROUTE>_API_KEY 派生');
  } finally {
    await server.close();
  }
});
