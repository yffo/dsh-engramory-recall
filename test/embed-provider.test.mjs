// 参考提供方（OpenAI 兼容 embeddings）的测试：全部打本地假服务器，一个真接口都不碰，
// 也一个真密钥都不用（用 `sk-test-…` 这种一眼假的字符串，并断言它绝不出现在错误信息里）。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG_PATH,
  check,
  readConfig,
  readConfigFile,
  rerank,
} from '../providers/openai-embeddings.mjs';

/** 起一个假 embeddings 服务：记录每次请求，按文本给确定性向量。 */
async function fakeServer(options = {}) {
  const requests = [];
  // 四维 one-hot：命中哪个主题就给哪一维 1，什么都不命中给「其它」维 —— 与查询的余弦是干净的 0/1
  const vectors = (text) => {
    const cache = /缓存|cache/.test(text) ? 1 : 0;
    const publish = /发布|npm|publish/.test(text) ? 1 : 0;
    const preference = /偏好|preference/.test(text) ? 1 : 0;
    return [cache, publish, preference, cache + publish + preference ? 0 : 1];
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      if (options.failWith) {
        res.statusCode = options.failWith;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: '服务器说的原话' } }));
        return;
      }
      if (options.notJson) {
        res.setHeader('content-type', 'text/plain');
        res.end('<html>这不是 JSON</html>');
        return;
      }
      const texts = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      const rows = texts.map((text, index) => ({ embedding: vectors(text ?? ''), index }));
      if (options.reverseIndex) rows.reverse(); // 数组顺序打乱、index 仍然诚实：考验客户端按 index 归位
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: options.dropRow ? rows.slice(1) : rows }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 把进程环境变量换成给这个测试用的一套，返回还原函数。 */
function withEnv(values) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const KEY = 'sk-test-SECRET-must-not-leak';

test('参考提供方：配置优先级（环境变量 > 配置文件 > 默认），坏 JSON 要说清楚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-embed-cfg-'));
  const file = join(dir, 'embed.json');
  writeFileSync(file, JSON.stringify({ apiKey: 'sk-from-file', model: 'file-model', baseUrl: 'https://file.example/v1' }));

  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: file,
    ENGRAMORY_EMBED_API_KEY: undefined,
    ENGRAMORY_EMBED_MODEL: undefined,
    ENGRAMORY_EMBED_BASE_URL: undefined,
  });
  try {
    const cfg = readConfig();
    assert.equal(cfg.apiKey, 'sk-from-file');
    assert.equal(cfg.model, 'file-model');
    assert.equal(cfg.baseUrl, 'https://file.example/v1');
    assert.match(cfg.keySource, /配置文件/);

    const withEnvOverride = withEnv({ ENGRAMORY_EMBED_API_KEY: KEY, ENGRAMORY_EMBED_MODEL: 'env-model' });
    try {
      const merged = readConfig();
      assert.equal(merged.apiKey, KEY, '环境变量优先于配置文件');
      assert.equal(merged.model, 'env-model');
      assert.equal(merged.baseUrl, 'https://file.example/v1', '没被覆盖的字段仍来自文件');
      assert.equal(merged.keySource, 'ENGRAMORY_EMBED_API_KEY');
    } finally {
      withEnvOverride();
    }

    // 文件不存在 = 空配置，不是错误；默认值仍然成立
    const missing = readConfigFile({ ENGRAMORY_EMBED_CONFIG: join(dir, 'nope.json') });
    assert.deepEqual(missing.data, {});
    assert.equal(readConfig({ ENGRAMORY_EMBED_CONFIG: join(dir, 'nope.json') }).model, 'text-embedding-3-small');

    writeFileSync(file, '{ 坏 JSON');
    assert.throws(() => readConfigFile({ ENGRAMORY_EMBED_CONFIG: file }), /读不了/);
    assert.equal(DEFAULT_CONFIG_PATH, '~/.config/engramory/embed.json');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('参考提供方：按余弦排序、带上密钥头、按 maxChars 截断、按 index 归位', async () => {
  const server = await fakeServer({ reverseIndex: true });
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: KEY,
    ENGRAMORY_EMBED_BASE_URL: server.baseUrl,
    ENGRAMORY_EMBED_MODEL: 'fake-embed-3',
    ENGRAMORY_EMBED_MAX_CHARS: '80', // 提供方把 maxChars 下限钳在 64，测试用 80 才看得出截断
    ENGRAMORY_EMBED_DOC_PREFIX: 'passage: ',
    ENGRAMORY_EMBED_QUERY_PREFIX: 'query: ',
  });
  try {
    const docs = [
      { id: 'cache.md', snippet: '缓存 cache 的失效策略' },
      { id: 'publish.md', snippet: '发布 npm publish 的次序' },
      { id: 'pref.md', snippet: '表达偏好 preference 记录' },
    ];
    const ranked = await rerank({ query: '怎么发布', docs });
    assert.equal(ranked[0].id, 'publish.md', '与查询同主题的那篇必须排第一');
    assert.ok(ranked[0].score > 0.99, `第一条应该和查询几乎同向，实际 ${ranked[0].score}`);
    assert.ok(
      ranked.slice(1).every((row) => row.score < 0.01),
      '与查询正交的两篇必须拿 0 分（用于验证排序真的按余弦，而不是按原顺序）',
    );
    assert.deepEqual(
      ranked.map((row) => row.id),
      ['publish.md', 'cache.md', 'pref.md'],
      '同分时按文件名稳定排序',
    );

    assert.equal(server.requests.length, 1, '一次请求搞定（默认 batch=32）');
    const request = server.requests[0];
    assert.equal(request.url, '/v1/embeddings');
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.body.model, 'fake-embed-3');
    assert.equal(request.body.input.length, 4, '查询 + 3 篇');
    assert.equal(request.body.input[0], 'query: 怎么发布');
    assert.equal(request.body.input[1], 'passage: 缓存 cache 的失效策略');
    assert.ok(
      request.body.input.every((text) => text.length <= 80),
      '每段都要按 maxChars 截断（含前缀在内）',
    );

    const long = await rerank({ query: '怎么发布', docs: [{ id: 'x.md', snippet: '长'.repeat(200) }] });
    assert.deepEqual(
      server.requests.at(-1).body.input,
      [`passage: ${'长'.repeat(80 - 'passage: '.length)}`],
      '超长正文截到 maxChars=80（含前缀），且只送这一段（查询与前三篇都命中了缓存）',
    );
    assert.equal(long.length, 1);
  } finally {
    restore();
    await server.close();
  }
});

test('参考提供方：批大小与缓存（同一段文本不重复付费）', async () => {
  const server = await fakeServer();
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: KEY,
    ENGRAMORY_EMBED_BASE_URL: server.baseUrl,
    ENGRAMORY_EMBED_BATCH: '2',
  });
  try {
    const docs = [1, 2, 3, 4].map((n) => ({ id: `n${n}.md`, snippet: `发布 npm 笔记 ${n}` }));
    await rerank({ query: '发布', docs });
    assert.equal(server.requests.length, 3, '5 段文本 / batch=2 = 3 次请求');
    assert.deepEqual(
      server.requests.map((r) => r.body.input.length),
      [2, 2, 1],
    );

    await rerank({ query: '发布', docs });
    assert.equal(server.requests.length, 3, '同样的文本与模型：完全命中缓存，不再发请求');

    await rerank({ query: '发布', docs: [...docs, { id: 'n5.md', snippet: '缓存 cache 笔记' }] });
    assert.equal(server.requests.length, 4, '只给新出现的那一段付费');
  } finally {
    restore();
    await server.close();
  }
});

test('参考提供方：接口出错要说清状态码与服务端原话，且绝不泄漏密钥', async () => {
  const fail = await fakeServer({ failWith: 401 });
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: KEY,
    ENGRAMORY_EMBED_BASE_URL: fail.baseUrl,
  });
  try {
    await assert.rejects(
      () => rerank({ query: '发布', docs: [{ id: 'a.md', snippet: '发布 npm' }] }),
      (error) => {
        assert.match(error.message, /HTTP 401/);
        assert.match(error.message, /服务器说的原话/);
        assert.ok(!error.message.includes('SECRET'), '错误信息里绝不许出现密钥');
        return true;
      },
    );
  } finally {
    restore();
    await fail.close();
  }

  const notJson = await fakeServer({ notJson: true });
  const restore2 = withEnv({ ENGRAMORY_EMBED_API_KEY: KEY, ENGRAMORY_EMBED_BASE_URL: notJson.baseUrl });
  try {
    await assert.rejects(() => rerank({ query: '发布', docs: [{ id: 'a.md', snippet: 'x' }] }), /不是 JSON/);
  } finally {
    restore2();
    await notJson.close();
  }

  const short = await fakeServer({ dropRow: true });
  const restore3 = withEnv({ ENGRAMORY_EMBED_API_KEY: KEY, ENGRAMORY_EMBED_BASE_URL: short.baseUrl });
  try {
    await assert.rejects(() => rerank({ query: '发布', docs: [{ id: 'a.md', snippet: 'x' }] }), /条数不对/);
  } finally {
    restore3();
    await short.close();
  }
});

test('参考提供方：没配密钥时给出可照做的提示（两种自检路径都拦得住）', async () => {
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: undefined,
    ENGRAMORY_EMBED_API_KEY_FILE: undefined,
    ENGRAMORY_EMBED_BASE_URL: 'http://127.0.0.1:9/v1',
  });
  try {
    await assert.rejects(() => rerank({ query: '发布', docs: [{ id: 'a.md', snippet: 'x' }] }), /没配密钥/);
    await assert.rejects(() => check(), /没配密钥/);
  } finally {
    restore();
  }
});

test('参考提供方：自检返回维度与耗时（不含密钥）', async () => {
  const server = await fakeServer();
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: KEY,
    ENGRAMORY_EMBED_BASE_URL: server.baseUrl,
    ENGRAMORY_EMBED_MODEL: 'fake-embed-3',
  });
  try {
    const result = await check();
    assert.equal(result.ok, true);
    assert.equal(result.dimensions, 4, '假服务给的是四维 one-hot 向量');
    assert.equal(result.model, 'fake-embed-3');
    assert.equal(result.keySource, 'ENGRAMORY_EMBED_API_KEY');
    assert.ok(!JSON.stringify(result).includes('SECRET'), '自检结果里不许出现密钥');
    assert.ok(Number.isFinite(result.ms));
  } finally {
    restore();
    await server.close();
  }
});

test('参考提供方：走接缝的整条链（裸模块名 → 宽池 → 语义把正确笔记捞进窗口）', async () => {
  const server = await fakeServer();
  const restore = withEnv({
    ENGRAMORY_EMBED_CONFIG: '/nonexistent/embed.json',
    ENGRAMORY_EMBED_API_KEY: KEY,
    ENGRAMORY_EMBED_BASE_URL: server.baseUrl,
  });
  try {
    const { semanticSearch } = await import('../semantic.js');
    const docs = [
      { id: 'cache.md', snippet: '缓存 cache 的失效策略' },
      { id: 'noise1.md', snippet: '无关内容一' },
      { id: 'noise2.md', snippet: '无关内容二' },
      { id: 'publish.md', snippet: '发布 npm publish 的次序与 token' },
    ];
    // 词面只认「缓存」，把真正讲「发布」的那篇排在第 4 位（窗口外）
    const searchFn = (index, query, limit) => index.docs.map((doc, i) => ({ id: doc.id, snippet: doc.snippet, score: 9 - i })).slice(0, limit);
    const base = { index: { docs }, query: '怎么把插件发到 npm', limit: 2, searchFn };
    const provider = 'dsh-engramory-recall/providers/openai-embeddings';

    const off = await semanticSearch({ ...base, config: {} });
    assert.deepEqual(off.hits.map((h) => h.id), ['cache.md', 'noise1.md'], '关着就是词面前两名');

    const narrow = await semanticSearch({ ...base, config: { provider, pool: 2, fusion: 'trust', timeoutMs: 5000 } });
    assert.deepEqual(
      narrow.hits.map((h) => h.id).sort(),
      ['cache.md', 'noise1.md'],
      '池 = 窗口时只能在这两条里排（正确的那篇根本不在池子里，提供方无处发力）',
    );

    const wide = await semanticSearch({ ...base, config: { provider, pool: 50, fusion: 'trust', timeoutMs: 5000 } });
    assert.equal(wide.pool, 4, '池子放宽到全库');
    assert.equal(wide.hits[0].id, 'publish.md', '语义信号把窗口外的正确笔记捞了上来');

    const rrf = await semanticSearch({ ...base, config: { provider, pool: 50, fusion: 'rrf', timeoutMs: 5000 } });
    assert.equal(rrf.fusion, 'rrf');
    assert.ok(rrf.hits.length === 2);
  } finally {
    restore();
    await server.close();
  }
});
