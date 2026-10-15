import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_MAX_INDEX_BYTES, DEFAULT_MAX_INDEX_LINES } from '../index-guard.js';
import {
  createSession, handleMessage, serveStdio, callTool, resolveStorePath, expandHome,
  listResources, readResource, parseArgs, main, McpError,
  MAX_OUTPUT_CHARS, DEFAULT_LIMIT, MAX_LIMIT, RESOURCE_TEMPLATE, SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION, DEFAULT_STORE,
} from '../mcp.js';

/** 一个临时记忆库；notes 为空表示「库是空目录」。 */
function tempStore(notes = { 'a.md': '# A\n\n代理节点走钻头螺栓这条线路。\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-proto-'));
  for (const [file, body] of Object.entries(notes)) writeFileSync(join(dir, file), body);
  return dir;
}

// 注意必须 await：不 await 的话 finally 会在异步用例还在跑时就把临时库删掉
// （症状是「第一次调用好好的、后面几次说库是空的」）。
const withStore = async (fn, notes) => {
  const dir = tempStore(notes);
  try {
    return await fn(createSession({ store: dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const textOf = (result) => (result?.content ?? []).map((c) => c.text).join('\n');

test('MCP：非法帧一律回 JSON-RPC 错误，不抛异常也不静默', async () => {
  await withStore(async (session) => {
    for (const bad of [null, [], 'not-an-object', 42, true]) {
      const res = await handleMessage(session, bad);
      assert.equal(res.error.code, -32600, `${JSON.stringify(bad)} 应当回 -32600`);
      assert.equal(res.id, null);
      assert.match(res.error.message, /Invalid Request/);
    }
    // method 必须是字符串；带 id 时报错，不带 id（通知）时安静
    assert.equal((await handleMessage(session, { id: 3 })).error.code, -32600);
    assert.equal((await handleMessage(session, { id: 3, method: 7 })).error.code, -32600);
    assert.equal(await handleMessage(session, { method: 'initialize' }), null, '已知方法的通知也不回包');
    assert.equal(await handleMessage(session, { method: 'tools/list' }), null);
    assert.equal(await handleMessage(session, { id: null, method: 'ping' }), null, 'id 为 null 也算通知');
    // 未知方法：带 id 报 -32601，通知则安静（协议规定通知不回包）
    const unknown = await handleMessage(session, { id: 4, method: 'tools/unknown' });
    assert.equal(unknown.error.code, -32601);
    assert.match(unknown.error.message, /tools\/unknown/);
    assert.equal(await handleMessage(session, { method: 'tools/unknown' }), null);
    assert.equal(await handleMessage(session, { id: 5, method: 'notifications/initialized' }), null);
  });
});

test('MCP：ping / prompts / templates 这些「有没有都行」的方法也给合规回包', async () => {
  await withStore(async (session) => {
    assert.deepEqual((await handleMessage(session, { id: 1, method: 'ping' })).result, {});
    assert.deepEqual((await handleMessage(session, { id: 2, method: 'prompts/list' })).result, { prompts: [] });
    const tpl = (await handleMessage(session, { id: 3, method: 'resources/templates/list' })).result;
    assert.deepEqual(tpl.resourceTemplates, [RESOURCE_TEMPLATE]);
    const list = (await handleMessage(session, { id: 4, method: 'resources/list' })).result;
    assert.ok(Array.isArray(list.resources), 'resources/list 要给数组');
  });
});

test('MCP：工具层的失败一律是 isError 文本（模型看得到，进程不死）', async () => {
  await withStore(async (session) => {
    const noTool = await callTool(session, { name: 'engramory_nope', arguments: {} });
    assert.equal(noTool.isError, true);
    assert.match(textOf(noTool), /没有这个工具：engramory_nope/);
    assert.match(textOf(noTool), /engramory_search/, '要顺带告诉模型有哪些工具');

    for (const file of ['../x.md', 'sub/x.md', '.hidden.md', 'x.txt', '']) {
      const res = await callTool(session, { name: 'engramory_read', arguments: { file } });
      assert.equal(res.isError, true, `${file} 应当被拒`);
    }
    const missing = await callTool(session, { name: 'engramory_read', arguments: { file: 'nope.md' } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /读不到这篇笔记/);

    const empty = await callTool(session, { name: 'engramory_search', arguments: { query: '   ' } });
    assert.equal(empty.isError, true);
    assert.match(textOf(empty), /需要非空的 query/);
  });
});

test('MCP：limit 乱填不炸（越界夹紧、非数字退回默认）', async () => {
  await withStore(async (session) => {
    const hit = await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓', limit: 'abc' } });
    assert.equal(hit.isError, false);
    assert.match(textOf(hit), /a\.md/);
    for (const limit of [0, -5, 999, 1.7]) {
      const res = await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓', limit } });
      assert.ok(!res.isError, `limit=${limit} 不该报错：${textOf(res)}`);
    }
    assert.ok(DEFAULT_LIMIT <= MAX_LIMIT);
  });
});

test('MCP：搜不到时不报错，而是给出「换个词」的下一步', async () => {
  await withStore(async (session) => {
    const res = await callTool(session, { name: 'engramory_search', arguments: { query: '完全不存在的词xyzzy' } });
    assert.ok(!res.isError, '搜不到不是错误');
    assert.match(textOf(res), /没有命中|换个词/);
  });
});

test('MCP：超长笔记截断，并在文里说明截到哪、原文在哪', async () => {
  const big = `# 大笔记\n\n${'废话。'.repeat((MAX_OUTPUT_CHARS / 3) + 200)}`;
  await withStore(async (session) => {
    const res = await callTool(session, { name: 'engramory_read', arguments: { file: 'big.md' } });
    const out = textOf(res);
    assert.ok(out.length < big.length, '必须真的截断');
    assert.match(out, /截断/);
    assert.match(out, /big\.md/, '要告诉读者原文在哪个文件');
  }, { 'big.md': big });
});

test('MCP：空库 / 不存在的库都给人话，不是崩', async () => {
  await withStore(async (session, dir) => {
    const res = await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓' } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /空|不存在/);
    assert.match(textOf(res), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '要说清它在找哪个库');
    const status = await callTool(session, { name: 'engramory_status', arguments: {} });
    assert.ok(!status.isError, '空库也要能查状态');
  }, {});
});

test('MCP：resources/read 的 URI 不对时走 JSON-RPC 错误（-32603），不是 isError', async () => {
  await withStore(async (session) => {
    const bad = await handleMessage(session, { id: 9, method: 'resources/read', params: { uri: 'http://example.com/a.md' } });
    assert.equal(bad.error.code, -32603);
    assert.match(bad.error.message, /只认得/);
    const good = await handleMessage(session, { id: 10, method: 'resources/read', params: { uri: 'engramory://note/a.md' } });
    assert.equal(good.error, undefined);
    assert.match(JSON.stringify(good.result), /钻头螺栓/);
  });
});

test('MCP：stdio 主循环——一条一行、按序回、通知与空行不回、坏 JSON 单独报 -32700', async () => {
  await withStore(async (session) => {
    const lines = [
      '',
      '   ',
      '这不是 JSON',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engramory_nope', arguments: {} } }),
    ];
    let out = '';
    await serveStdio(session, {
      input: Readable.from(`${lines.join('\n')}\n`),
      output: { write: (chunk) => { out += chunk; return true; } },
    });
    const frames = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(frames.length, 4, `空行与通知都不该产生帧，实际 ${frames.length} 帧`);
    assert.deepEqual(frames.map((f) => f.id), [null, 1, 2, 3], '响应顺序＝请求顺序（坏 JSON 那条 id 为 null）');
    assert.equal(frames[0].error.code, -32700);
    assert.match(frames[0].error.message, /Parse error/);
    assert.ok(Array.isArray(frames[2].result.tools), 'tools/list 要给出工具数组');
    assert.equal(frames[3].result.isError, true, '工具级失败要包在 result 里，而不是顶掉协议帧');
  });
});

test('MCP：~ 展开与库路径优先级（--store > 环境变量 > 默认）', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('  ~/y  '), join(homedir(), 'y'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(resolveStorePath('~/w'), join(homedir(), 'w'));

  const before = process.env.ENGRAMORY_STORE;
  try {
    process.env.ENGRAMORY_STORE = '~/tmp-env-store';
    assert.equal(createSession().store, join(homedir(), 'tmp-env-store'));
    assert.equal(createSession({ store: '/tmp/explicit' }).store, '/tmp/explicit', '显式 store 要压过环境变量');
    assert.equal(createSession().storeRaw, '~/tmp-env-store');
  } finally {
    if (before === undefined) delete process.env.ENGRAMORY_STORE;
    else process.env.ENGRAMORY_STORE = before;
  }
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.size >= 3, '至少要认得三个协议版本');
});

// ───────────────────────── 以下为协议层补厚 ─────────────────────────
// 这一批盯的是「帧里的具体内容」：字段、顺序、错误码、边界值。断言的是现状，
// 现状不合理的地方在注释里写清楚（带 ⚠️ 的是已知的糙点，不是漏测）。

/** 把 main 要写的三个标准流全换成桩（它直接写 process.stdout/stderr、默认读 process.stdin）。 */
async function runMain(argv) {
  const real = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const cap = { code: undefined, out: '', err: '' };
  const put = (key, value) => Object.defineProperty(process, key, { value, configurable: true, writable: true });
  put('stdin', Readable.from('')); // 立刻 EOF：真起服务也只是「读完了就退出」，不会挂住测试
  put('stdout', { write: (chunk) => { cap.out += chunk; return true; } });
  put('stderr', { write: (chunk) => { cap.err += chunk; return true; } });
  try {
    cap.code = await main(argv);
  } finally {
    put('stdin', real.stdin);
    put('stdout', real.stdout);
    put('stderr', real.stderr);
  }
  return cap;
}

/** 数一数搜索结果里有几条命中（命中行形如 `1. a.md · 0.53`）。 */
const countHits = (text) => (text.match(/^\d+\. /gm) ?? []).length;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('MCP：initialize 回显协议版本、声明 capabilities 与身份', async () => {
  await withStore(async (session) => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const frame = await handleMessage(session, { id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } });
    assert.equal(frame.jsonrpc, '2.0');
    assert.equal(frame.id, 1);
    assert.equal(frame.error, undefined);
    const result = frame.result;
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    // capabilities 要「明说不支持什么」：只读库不可能有变更通知，也不支持订阅
    assert.deepEqual(result.capabilities, { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } });
    assert.deepEqual(Object.keys(result.serverInfo).sort(), ['name', 'title', 'version']);
    assert.equal(result.serverInfo.name, SERVER_NAME);
    assert.equal(result.serverInfo.version, SERVER_VERSION);
    assert.equal(result.serverInfo.version, pkg.version, 'serverInfo.version 必须跟 package.json 一致');
    assert.match(result.instructions, /只读/);
    assert.match(result.instructions, /engramory_search/, 'instructions 要教客户端先用哪个工具');
    // 客户端报的版本在名单里就照它回；不认识的回我们最新的，缺参数/乱填也不炸
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const echo = await handleMessage(session, { id: 2, method: 'initialize', params: { protocolVersion: version } });
      assert.equal(echo.result.protocolVersion, version, `${version} 应当被回显`);
    }
    const future = await handleMessage(session, { id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(future.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal((await handleMessage(session, { id: 4, method: 'initialize' })).result.protocolVersion, PROTOCOL_VERSION);
    assert.equal((await handleMessage(session, { id: 5, method: 'initialize', params: { protocolVersion: 42 } })).result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(await handleMessage(session, { method: 'initialize' }), null, 'initialize 的通知不回包');
  });
});

test('MCP：tools/list 的 schema 与上限常量一致（模型看到的就是这些）', async () => {
  await withStore(async (session) => {
    const tools = (await handleMessage(session, { id: 1, method: 'tools/list' })).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['engramory_search', 'engramory_read', 'engramory_status']);
    const [searchTool, readTool, statusTool] = tools;
    for (const tool of tools) {
      assert.ok(tool.description.length > 20, `${tool.name} 得给模型一句人话`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false, '必须显式拒绝未知参数');
    }
    assert.deepEqual(searchTool.inputSchema.required, ['query']);
    assert.deepEqual(Object.keys(searchTool.inputSchema.properties), ['query', 'limit']);
    assert.equal(searchTool.inputSchema.properties.query.type, 'string');
    assert.equal(searchTool.inputSchema.properties.limit.type, 'integer');
    assert.equal(searchTool.inputSchema.properties.limit.minimum, 1);
    assert.equal(searchTool.inputSchema.properties.limit.maximum, MAX_LIMIT, 'schema 里的上限要跟代码里的夹紧一致');
    assert.match(searchTool.inputSchema.properties.limit.description, new RegExp(`默认 ${DEFAULT_LIMIT}`));
    assert.deepEqual(readTool.inputSchema.required, ['file']);
    assert.deepEqual(Object.keys(readTool.inputSchema.properties), ['file']);
    assert.equal(statusTool.inputSchema.required, undefined, 'status 没有必填参数');
    assert.deepEqual(statusTool.inputSchema.properties, {});
    // 帧只能过 JSON：schema 里不能有 undefined（序列化后会凭空少字段）
    const roundTrip = JSON.parse(JSON.stringify(tools));
    assert.equal(JSON.stringify(roundTrip).includes('undefined'), false);
    assert.deepEqual(roundTrip.map((t) => t.name), tools.map((t) => t.name));
  });
});

test('MCP：没实现的方法一律 -32601（prompts/get、logging、大小写），通知则静默', async () => {
  await withStore(async (session) => {
    const unimplemented = [
      ['prompts/get', { name: 'x' }],
      ['logging/setLevel', { level: 'debug' }],
      ['completion/complete', { ref: { type: 'ref/prompt', name: 'x' } }],
      ['tools/List', undefined],
    ];
    for (const [method, params] of unimplemented) {
      const frame = await handleMessage(session, { id: 7, method, params });
      assert.equal(frame.error.code, -32601, `${method} 应当是 -32601`);
      assert.equal(frame.error.message, `Method not found: ${method}`);
      assert.equal(frame.id, 7, '错误帧要带原样的 id');
      assert.equal(await handleMessage(session, { method, params }), null, `${method} 的通知必须静默`);
    }
    // 现状：prompts/list 回空数组，却没有 prompts/get（0 个 prompt，客户端不该去 get）
    assert.deepEqual((await handleMessage(session, { id: 8, method: 'prompts/list' })).result, { prompts: [] });
  });
});

test('MCP：resources/list 字段齐全、不含 MEMORY.md、标题回退文件名', async () => {
  const notes = {
    'bare.md': '没有标题的一行正文。\n',
    'fm.md': '---\nname: 别名标题\ndescription: 一句话描述\naliases: [桥接词]\n---\n\n# 正文标题\n\n内容正文标记。\n',
    'archived-2026-old.md': '# 归档笔记\n\n归档正文标记。\n',
    'MEMORY.md': '# 索引\n- 一行指针\n',
  };
  await withStore(async (session) => {
    const list = listResources(session).resources;
    assert.deepEqual(list.map((r) => r.name), ['archived-2026-old.md', 'bare.md', 'fm.md'], '按文件名排序；MEMORY.md 是索引不是笔记');
    for (const resource of list) {
      assert.deepEqual(Object.keys(resource), ['uri', 'name', 'title', 'description', 'mimeType']);
      assert.equal(resource.uri, `engramory://note/${resource.name}`);
      assert.equal(resource.mimeType, 'text/markdown');
    }
    const bare = list.find((r) => r.name === 'bare.md');
    assert.equal(bare.title, 'bare.md', '笔记没有一级标题时，title 回退成文件名');
    assert.equal(bare.description, undefined, '没有 frontmatter description 就是 undefined');
    const fm = list.find((r) => r.name === 'fm.md');
    assert.equal(fm.title, '正文标题', '现状：title 取正文一级标题，frontmatter 的 name 不参与');
    assert.equal(fm.description, '一句话描述');
    assert.ok(list.some((r) => r.name === 'archived-2026-old.md'), '归档笔记照样列出来（归档只是命名约定）');
    // 内存里的帧带着 description 键（值为 undefined）；一旦序列化成协议帧就被 JSON 丢掉 ——
    // 客户端看到的是「根本没有这个键」，不是 null
    const frame = await handleMessage(session, { id: 1, method: 'resources/list' });
    const frameBare = frame.result.resources.find((r) => r.name === 'bare.md');
    assert.equal('description' in frameBare, true);
    assert.equal(frameBare.description, undefined);
    assert.equal('description' in JSON.parse(JSON.stringify(frame)).result.resources.find((r) => r.name === 'bare.md'), false);
    // 别名虽然不进 title，但真的能靠它召回（借 frontmatter 的 aliases）
    const byAlias = await callTool(session, { name: 'engramory_search', arguments: { query: '桥接词' } });
    assert.match(textOf(byAlias), /^1\. fm\.md /m, '只有 aliases 里出现过的词也该召回这篇');
  }, notes);
  await withStore(async (session) => {
    assert.deepEqual(listResources(session), { resources: [] }, '空库就是空数组，不是 null');
  }, {});
});

test('MCP：resources/read 命中各种笔记（无标题、frontmatter、归档、中文名、MEMORY.md）', async () => {
  const notes = {
    'bare.md': '没有标题的一行正文。\n',
    'fm.md': '---\nname: 别名标题\ndescription: 一句话描述\naliases: [桥接词]\n---\n\n# 正文标题\n\nfrontmatter 正文标记。\n',
    'archived-2026-old.md': '# 归档笔记\n\n归档正文标记。\n',
    '中文.md': '# 中文笔记\n\n中文笔记正文标记。\n',
    'MEMORY.md': '# 索引\n- 一行指针\n',
  };
  await withStore(async (session) => {
    const hit = await handleMessage(session, { id: 1, method: 'resources/read', params: { uri: 'engramory://note/fm.md' } });
    assert.deepEqual(Object.keys(hit.result), ['contents']);
    const [content] = hit.result.contents;
    assert.deepEqual(Object.keys(content), ['uri', 'mimeType', 'text']);
    assert.equal(content.uri, 'engramory://note/fm.md', 'URI 原样回显');
    assert.equal(content.mimeType, 'text/markdown');
    assert.match(content.text, /frontmatter 正文标记/);
    assert.match(content.text, /^---/, '读的是原文，frontmatter 也照给');
    // 百分号编码的中文名：解一次码就能读到，但回显的 URI 保持请求里的样子
    const encoded = encodeURIComponent('中文.md');
    const zh = await handleMessage(session, { id: 2, method: 'resources/read', params: { uri: `engramory://note/${encoded}` } });
    assert.equal(zh.error, undefined);
    assert.match(zh.result.contents[0].text, /中文笔记正文标记/);
    assert.equal(zh.result.contents[0].uri, `engramory://note/${encoded}`);
    // 归档笔记、无标题笔记都能读
    assert.match(readResource(session, { uri: 'engramory://note/archived-2026-old.md' }).contents[0].text, /归档正文标记/);
    assert.match(readResource(session, { uri: 'engramory://note/bare.md' }).contents[0].text, /没有标题的一行正文/);
    // ⚠️ 现状：MEMORY.md 不在 resources/list 里，但 read 放行（工具与资源两条路都放）
    assert.match(readResource(session, { uri: 'engramory://note/MEMORY.md' }).contents[0].text, /一行指针/);
    assert.equal((await callTool(session, { name: 'engramory_read', arguments: { file: 'MEMORY.md' } })).isError, false);
    // 不存在的文件：资源级是 -32603 帧，工具级是 isError 人话
    const missing = await handleMessage(session, { id: 3, method: 'resources/read', params: { uri: 'engramory://note/nope.md' } });
    assert.equal(missing.error.code, -32603);
    assert.match(missing.error.message, /读不到这篇笔记：nope\.md/);
  }, notes);
});

test('MCP：resources/read 的路径穿越与坏编码一律被挡（钉住现状）', async () => {
  await withStore(async (session) => {
    const blocked = [
      ['engramory://note/../secret.md', /不是库里的笔记文件名/],
      ['engramory://note/..%2F..%2Fetc%2Fpasswd', /不是库里的笔记文件名/],
      ['engramory://note/%2Fetc%2Fpasswd', /不是库里的笔记文件名/],
      ['engramory://note/sub%2Fa.md', /不是库里的笔记文件名/],
      ['engramory://note/.hidden.md', /不是库里的笔记文件名/],
      ['engramory://note/a.txt', /不是库里的笔记文件名/],
      ['engramory://note/', /需要 file 参数/],
    ];
    for (const [uri, pattern] of blocked) {
      const frame = await handleMessage(session, { id: 2, method: 'resources/read', params: { uri } });
      assert.equal(frame.error.code, -32603, `${uri} 应当是 -32603`);
      assert.match(frame.error.message, pattern, uri);
      assert.equal(frame.result, undefined);
    }
    // ⚠️ 现状（见报告）：真正挡住穿越的是 safeNotePath 里的 basename 比较，
    // 不是那句 startsWith(store + sep)；后者只会在库根是 `/` 时误伤（见下一个用例）。
    // `%` 没编码好 → URIError，被兜成「内部错误」，进程不死
    const malformed = await handleMessage(session, { id: 3, method: 'resources/read', params: { uri: 'engramory://note/100%.md' } });
    assert.equal(malformed.error.code, -32603);
    assert.match(malformed.error.message, /内部错误/);
    assert.match(malformed.error.message, /URI malformed/);
    // 缺 params / 前缀不对 / uri 不是字符串：readResource 直接抛 McpError（同步 API 的约定）
    assert.throws(() => readResource(session, {}), McpError);
    assert.throws(() => readResource(session, { uri: 'engramory://notes/a.md' }), /只认得 engramory:\/\/note\//);
    assert.equal((await handleMessage(session, { id: 4, method: 'resources/read' })).error.code, -32603);
    assert.match((await handleMessage(session, { id: 5, method: 'resources/read', params: { uri: 42 } })).error.message, /收到的是：42/);
    assert.equal(await handleMessage(session, { method: 'resources/read', params: { uri: 'http://x/a.md' } }), null, '通知形式的失败静默');
  });
});

test('MCP：库根是 `/` 时任何文件名都被判越界（现状钉住，别当成穿越防护）', async () => {
  const session = createSession({ store: '/' });
  assert.equal(session.store, '/');
  for (const file of ['a.md', 'etc/hosts']) {
    const res = await callTool(session, { name: 'engramory_read', arguments: { file } });
    assert.equal(res.isError, true);
    // 'etc/hosts' 先在 basename 那关就被挡；纯文件名的 'a.md' 才会走到那句 startsWith
    assert.match(textOf(res), file === 'a.md' ? /拒绝越界路径：a\.md/ : /不是库里的笔记文件名/);
  }
  const frame = await handleMessage(session, { id: 1, method: 'resources/read', params: { uri: 'engramory://note/a.md' } });
  assert.equal(frame.error.code, -32603);
  assert.equal(frame.error.message, '拒绝越界路径：a.md');
});

test('MCP：tools/call 的参数组合与默认值（缺参、非字符串、目录冒充 .md、非 McpError）', async () => {
  await withStore(async (session, dir) => {
    // 没有 params / name 不是字符串 —— 都是「没有这个工具」，不是异常
    for (const params of [undefined, {}, { name: 42 }, { name: null }]) {
      const res = await callTool(session, params);
      assert.equal(res.isError, true);
      assert.match(textOf(res), /^没有这个工具：/);
      assert.match(textOf(res), /engramory_search \/ engramory_read \/ engramory_status$/);
    }
    // status：连 arguments 都不给也要能跑（params.arguments ?? {}）
    const status = await callTool(session, { name: 'engramory_status' });
    assert.equal(status.isError, false);
    assert.equal(status.content.length, 1);
    assert.equal(status.content[0].type, 'text');
    assert.equal(typeof status.content[0].text, 'string');

    // read：缺 file / 空白 file / 数字 file / 目录冒充 .md
    for (const args of [undefined, {}, { file: '   ' }]) {
      assert.match(textOf(await callTool(session, { name: 'engramory_read', arguments: args })), /需要 file 参数/);
    }
    assert.match(textOf(await callTool(session, { name: 'engramory_read', arguments: { file: 123 } })), /不是库里的笔记文件名：123/);
    assert.equal((await callTool(session, { name: 'engramory_read', arguments: { file: 'a.md' } })).isError, false);
    assert.equal((await callTool(session, { name: 'engramory_read', arguments: { file: ' a.md ' } })).isError, false, '文件名两端空白会被 trim');
    mkdirSync(join(dir, 'dir.md'));
    assert.match(textOf(await callTool(session, { name: 'engramory_read', arguments: { file: 'dir.md' } })), /读不到这篇笔记：dir\.md/);
    assert.match(textOf(await callTool(session, { name: 'engramory_read', arguments: { file: 'dir.md' } })), /engramory_status/);

    // search：缺 query / null query；数字 query 只是搜不到，不算参数错
    for (const args of [undefined, {}, { query: null }]) {
      assert.match(textOf(await callTool(session, { name: 'engramory_search', arguments: args })), /需要非空的 query/);
    }
    assert.equal((await callTool(session, { name: 'engramory_search', arguments: { query: 42 } })).isError, false);
    assert.equal(countHits(textOf(await callTool(session, { name: 'engramory_search', arguments: { query: 42 } }))), 0);

    // 非 McpError 的意外错误：包成「工具 X 出错：<原因>」，绝不让异常穿到协议层
    const broken = { get store() { throw new Error('坏库对象'); } };
    const brokenResult = await callTool(broken, { name: 'engramory_status' });
    assert.equal(brokenResult.isError, true);
    assert.equal(textOf(brokenResult), '工具 engramory_status 出错：坏库对象');
    const frame = await handleMessage(broken, { id: 5, method: 'tools/call', params: { name: 'engramory_status' } });
    assert.equal(frame.error, undefined, '工具级失败仍是一个正常帧');
    assert.equal(frame.id, 5);
    assert.equal(frame.result.isError, true);
  });
});

test('MCP：搜索的 limit 逐档语义、多条命中的排序/score/长笔记聚合', async () => {
  const notes = {};
  for (let i = 0; i < 6; i += 1) notes[`n${i}.md`] = `# N${i}\n\n钻头螺栓 编号 ${i}\n${'填充 '.repeat(5 + i)}\n`;
  notes['long.md'] = `# L\n\n## 段\n代理节点钻头螺栓${'废话。'.repeat(400)}\n\n## 又一段\n还是钻头螺栓\n${'尾。'.repeat(300)}\n`;
  notes['noise.md'] = '# 无关\n\n火星车与土豆。\n';
  await withStore(async (session, dir) => {
    // 默认 5；越界夹紧到 [1, MAX_LIMIT]、小数截断、非有限数退回默认；null→0→夹到 1
    const cases = [
      [undefined, DEFAULT_LIMIT], [0, 1], [-5, 1], [-0.5, 1], [1, 1], [1.7, 1],
      ['2.9', 2], ['3', 3], [MAX_LIMIT + 100, 7], [999, 7], [NaN, DEFAULT_LIMIT], ['abc', DEFAULT_LIMIT],
      [Infinity, DEFAULT_LIMIT], [null, 1],
    ];
    for (const [limit, expected] of cases) {
      const args = limit === undefined ? { query: '钻头螺栓' } : { query: '钻头螺栓', limit };
      const res = await callTool(session, { name: 'engramory_search', arguments: args });
      assert.equal(res.isError, false, `limit=${String(limit)}：${textOf(res)}`);
      assert.equal(countHits(textOf(res)), expected, `limit=${String(limit)} 应当回 ${expected} 条`);
    }
    const full = textOf(await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓', limit: 999 } }));
    const lines = full.split('\n');
    assert.equal(lines[0], `库：${dir}（8 篇）· 查询：钻头螺栓`);
    const hitLines = lines.filter((l) => /^\d+\. /.test(l));
    assert.deepEqual(hitLines.map((l) => l.split(' ')[1]), ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md', 'long.md']);
    assert.equal((full.match(/long\.md/g) ?? []).length, 1, '长笔记在索引里被切成多桶，命中里也只能算一篇');
    // 分数：两位小数字符串，按降序排
    const scores = hitLines.map((l) => Number(/ · (\d+\.\d{2})$/.exec(l)[1]));
    assert.ok(scores.every((s) => Number.isFinite(s)), '每条命中都要有 score');
    for (let i = 1; i < scores.length; i += 1) assert.ok(scores[i - 1] >= scores[i], '命中要按分数降序');
    // 一条命中＝三行：序号+文件名+分数 / 缩进摘要 / 命中词
    assert.equal(lines[1], `1. n0.md · ${scores[0].toFixed(2)}`);
    assert.match(lines[2], /^   \S/, '第二行是缩进的摘要');
    assert.match(lines[3], /^   命中：/);
    assert.match(lines[3], /钻头|头螺|螺栓/);
    assert.equal(lines.length, 1 + hitLines.length * 3, '命中块之间不能有别的行');
    // 搜不到：不报错，给出下一步
    const none = textOf(await callTool(session, { name: 'engramory_search', arguments: { query: '完全不存在的词xyzzy' } }));
    assert.equal(none, `库：${dir}（8 篇）· 查询：完全不存在的词xyzzy\n没有命中。换个词，或先用 engramory_status 确认库对不对。`);
  }, notes);
});

test('MCP：status 的五个字段与索引超限提示（无索引/正常/超限三态）', async () => {
  await withStore(async (session, dir) => {
    const lines = textOf(await callTool(session, { name: 'engramory_status' })).split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[0], `库：${dir}`);
    assert.equal(lines[1], '笔记：1 篇');
    assert.equal(lines[2], '索引：没有 MEMORY.md（召回仍可用，但宿主没有索引可读）');
    assert.match(lines[3], /^指纹：[0-9a-f]{12}$/);
    assert.equal(lines[4], `服务器：${SERVER_NAME} ${SERVER_VERSION} · 只读 · 零模型调用`);

    assert.equal(`${DEFAULT_MAX_INDEX_LINES}/${DEFAULT_MAX_INDEX_BYTES}`, '200/25600', '上限变了要在这儿看见（守卫按这个数拒写）');
    const index = '# 索引\n- 一行指针\n';
    writeFileSync(join(dir, 'MEMORY.md'), index);
    const normal = textOf(await callTool(session, { name: 'engramory_status' })).split('\n')[2];
    assert.equal(normal, `索引：2 行 / ${Buffer.byteLength(index)} 字节（上限 ${DEFAULT_MAX_INDEX_LINES} 行 / ${DEFAULT_MAX_INDEX_BYTES} 字节）`);

    writeFileSync(join(dir, 'MEMORY.md'), 'x\n'.repeat(250));
    const over = textOf(await callTool(session, { name: 'engramory_status' })).split('\n')[2];
    assert.equal(over, `索引：250 行 / 500 字节（上限 ${DEFAULT_MAX_INDEX_LINES} 行 / ${DEFAULT_MAX_INDEX_BYTES} 字节，已超限：250 行 > 200）`);
    // MEMORY.md 不是笔记：篇数不受影响
    assert.equal(textOf(await callTool(session, { name: 'engramory_status' })).split('\n')[1], '笔记：1 篇');
  });
});

test('MCP：库路径指向文件、目录不可读 —— 都收敛成同一句「库是空的或不存在」', async () => {
  const asFileDir = tempStore();
  try {
    const asFile = createSession({ store: join(asFileDir, 'a.md') });
    const res = await callTool(asFile, { name: 'engramory_search', arguments: { query: '钻头螺栓' } });
    assert.equal(res.isError, true);
    assert.equal(textOf(res), `库是空的或不存在：${join(asFileDir, 'a.md')}。用 --store <路径> 或环境变量 ENGRAMORY_STORE 指定。`);
    assert.equal(textOf(await callTool(asFile, { name: 'engramory_status' })).split('\n')[1], '笔记：0 篇');
    assert.equal((await callTool(asFile, { name: 'engramory_status' })).isError, false, '库坏掉也要能看状态');
  } finally {
    rmSync(asFileDir, { recursive: true, force: true });
  }

  const lockedDir = tempStore();
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    chmodSync(lockedDir, 0o000);
    const session = createSession({ store: lockedDir });
    const res = await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓' } });
    if (!root) {
      assert.equal(res.isError, true, '读不到目录要给人话，不是 EACCES 栈');
      assert.match(textOf(res), /库是空的或不存在/);
      assert.equal(textOf(await callTool(session, { name: 'engramory_status' })).split('\n')[1], '笔记：0 篇');
    } else {
      assert.equal(res.isError, false, 'root 无视权限位，这条在 root 下没有意义');
    }
  } finally {
    chmodSync(lockedDir, 0o755); // 还回权限，否则 finally 里的 rmSync 自己会 EACCES
    rmSync(lockedDir, { recursive: true, force: true });
  }
});

test('MCP：同一 session 反复调用——索引缓存复用、语料变了就重建', async () => {
  await withStore(async (session, dir) => {
    const cold = await callTool(session, { name: 'engramory_search', arguments: { query: '火星车' } });
    assert.match(textOf(cold), /没有命中/);
    assert.ok(session.index, '查过之后应当有索引');
    const cachedIndex = session.index;
    const cachedFingerprint = session.fingerprint;
    assert.match(cachedFingerprint, /\S/);
    await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓' } });
    assert.equal(session.index, cachedIndex, '库没变就不该重建索引');
    assert.equal(session.fingerprint, cachedFingerprint);

    writeFileSync(join(dir, 'new.md'), '# 新\n\n火星车 开过来了。\n');
    const again = await callTool(session, { name: 'engramory_search', arguments: { query: '火星车' } });
    assert.equal(again.isError, false);
    assert.match(textOf(again), /new\.md/, '同一个 session 里刚写的笔记也要看得见');
    assert.notEqual(session.fingerprint, cachedFingerprint, '语料变了指纹就要变');
    assert.notEqual(session.index, cachedIndex, '指纹变了就要重建索引');
    assert.equal(session.store, dir, 'store 不跟着语料走');
    // 前后两次调用互不串味
    assert.match(textOf(await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓' } })), /a\.md/);
  });
});

test('MCP：stdio 主循环——100 条不丢帧、写 stdout 坏掉时回 -32603 而不是静默', async () => {
  await withStore(async (session) => {
    // 一次灌 100 条（主循环里的 pending 上限是 64，会 shift 掉旧任务）也不能丢帧、不能乱序
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }));
    let out = '';
    await serveStdio(session, { input: Readable.from(`${lines.join('\n')}\n`), output: { write: (chunk) => { out += chunk; return true; } } });
    const frames = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(frames.length, 100, '100 条请求要回 100 帧');
    assert.deepEqual(frames.map((f) => f.id), Array.from({ length: 100 }, (_, i) => i), '响应顺序＝请求顺序');
    assert.ok(frames.every((f) => f.jsonrpc === '2.0' && f.error === undefined && f.result));

    // 第一次写 stdout 就抛（EPIPE 那类）：那一条的响应降级成 -32603，后续帧照常
    let writes = 0;
    const written = [];
    const flaky = { write: (chunk) => { writes += 1; if (writes === 1) throw new Error('EPIPE 假装的'); written.push(chunk); return true; } };
    const seq = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ].join('\n');
    await serveStdio(session, { input: Readable.from(`${seq}\n`), output: flaky });
    const two = written.map((l) => JSON.parse(l));
    assert.equal(two.length, 2);
    assert.deepEqual(two[0], { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'EPIPE 假装的' } });
    assert.deepEqual(two[1], { jsonrpc: '2.0', id: 2, result: {} });
  });
});

test('MCP：通知与请求交错——只回请求，id 原样回显（0/空串/false 都不是通知）', async () => {
  await withStore(async (session) => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', method: 7 }), // method 不是字符串的通知：安静
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'notifications/initialized' }), // 通知前缀 + 有 id：也不回
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'engramory_status' } }), // 工具通知
      '坏 JSON',
      JSON.stringify({ jsonrpc: '2.0', id: false, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 'str-1', method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: '', method: 'ping' }),
    ];
    let out = '';
    await serveStdio(session, { input: Readable.from(`${lines.join('\n')}\n`), output: { write: (chunk) => { out += chunk; return true; } } });
    const frames = out.trim().split('\n').map((l) => JSON.parse(l));
    // ⚠️ 现状：-32700 那一帧是在 line 回调里同步写的，而请求响应走的是 Promise 队列 ——
    // 输入一次性灌进来时它会插队到前面所有请求响应之前（逐行到达时顺序才正常）。
    // 协议上靠 id 匹配，不算违规，但「响应顺序＝请求顺序」这句注释只对请求之间成立。
    // 另外：只有 id 是 undefined/null 才算通知；id=0、''、false 都当请求回包。
    assert.deepEqual(frames.map((f) => f.id), [null, 0, false, 'str-1', '']);
    assert.ok(frames.every((f) => f.jsonrpc === '2.0'));
    assert.equal(frames[0].error.code, -32700, '坏 JSON 那一帧 id 为 null');
    assert.equal(frames[1].result && Object.keys(frames[1].result).length, 0);
    assert.deepEqual(frames[2].result, {});
    assert.deepEqual(frames[4].result, {});
  });
});

test('MCP：parseArgs 与 main 的纯查询路径（--print-config / --version / --help / 坏参数）', async () => {
  assert.deepEqual(parseArgs([]), { store: '', semantic: '', help: false, version: false, printConfig: false });
  assert.equal(parseArgs(['--store', '/x']).store, '/x');
  assert.equal(parseArgs(['--store=/y']).store, '/y');
  assert.equal(parseArgs(['--store']).store, '', '--store 后面没值就是空串，不抛');
  assert.equal(parseArgs(['--semantic', 'm.js']).semantic, 'm.js');
  assert.equal(parseArgs(['--semantic=m.js']).semantic, 'm.js');
  assert.equal(parseArgs(['--semantic']).semantic, '');
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['--print-config']).printConfig, true);
  assert.equal(parseArgs(['--nonsense']).error, '听不懂的参数：--nonsense');
  assert.equal(parseArgs(['   ']).error, undefined, '纯空白参数不算错误');
  // ⚠️ 现状：--store 会把紧跟的 --help 吞成路径（没做「看起来像选项就报错」的校验）
  const greedy = parseArgs(['--store', '--help']);
  assert.equal(greedy.store, '--help');
  assert.equal(greedy.help, false);

  const envBefore = { store: process.env.ENGRAMORY_STORE, semantic: process.env.ENGRAMORY_SEMANTIC_PROVIDER };
  const dir = tempStore();
  try {
    delete process.env.ENGRAMORY_STORE;
    delete process.env.ENGRAMORY_SEMANTIC_PROVIDER;

    const help = await runMain(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /^用法：node mcp\.js/);
    assert.match(help.out, /--print-config/);
    assert.match(help.out, new RegExp(escapeRe(DEFAULT_STORE)), '用法里要写清默认库在哪');
    assert.equal(help.err, '');

    const version = await runMain(['--version']);
    assert.equal(version.code, 0);
    assert.equal(version.out.trim(), SERVER_VERSION);
    assert.equal(version.err, '');

    const bad = await runMain(['--nonsense']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /^听不懂的参数：--nonsense\n\n用法：/);
    assert.equal(bad.out, '', '坏参数时 stdout 一个字节都不能有（客户端会当协议帧解析）');

    const config = await runMain(['--print-config', '--store', dir]);
    assert.equal(config.code, 0);
    assert.equal(config.err, '');
    assert.deepEqual(JSON.parse(config.out), { name: SERVER_NAME, version: SERVER_VERSION, store: dir });

    const fallback = await runMain(['--print-config', '--store', '']);
    assert.equal(JSON.parse(fallback.out).store, resolveStorePath(DEFAULT_STORE), '--store 给空串＝没给');

    process.env.ENGRAMORY_STORE = dir;
    assert.deepEqual(JSON.parse((await runMain(['--print-config'])).out).store, dir, '环境变量是第二优先级');

    // 真起服务（stdin 直接 EOF）：stderr 报库位置，stdout 依然一个字都没有
    const served = await runMain(['--store', dir, '--semantic', 'host-llm']);
    assert.equal(served.code, 0);
    assert.equal(served.out, '');
    assert.equal(served.err, `[${SERVER_NAME}] 库：${dir} · 只读 · 语义接缝：host-llm · 日志只走 stderr\n`);
    const plain = await runMain(['--store', dir]);
    assert.match(plain.err, /语义接缝：关闭（默认）/, '没开接缝时要说「关闭」而不是留空');
  } finally {
    for (const [key, value] of Object.entries({ ENGRAMORY_STORE: envBefore.store, ENGRAMORY_SEMANTIC_PROVIDER: envBefore.semantic })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP：路径与 session 的边角（空值、~/、~user、相对路径、默认库回退）', () => {
  assert.equal(expandHome(undefined), '');
  assert.equal(expandHome(null), '');
  assert.equal(expandHome(''), '');
  assert.equal(expandHome('   '), '');
  assert.equal(expandHome('~/'), homedir(), '~/ 展开成家目录本身（join 吃掉尾斜杠）');
  assert.equal(expandHome('~user'), '~user', '不猜别人的家目录，原样返回');
  assert.equal(expandHome('~notahome/x'), '~notahome/x');
  assert.equal(expandHome('relative/x'), 'relative/x', '相对路径不在这里解析');
  assert.equal(expandHome('/abs/x'), '/abs/x');
  assert.equal(expandHome(42), '42');

  assert.equal(DEFAULT_STORE, '~/memory/engramory');
  assert.equal(resolveStorePath(''), join(homedir(), 'memory', 'engramory'));
  assert.equal(resolveStorePath(), resolveStorePath(DEFAULT_STORE));
  assert.equal(resolveStorePath(''), resolveStorePath(DEFAULT_STORE));
  assert.equal(resolveStorePath('~/'), homedir());
  assert.equal(resolveStorePath('relative/x'), resolve('relative/x'), '相对路径按进程 cwd 解析');
  assert.equal(resolveStorePath('/tmp/x/'), '/tmp/x', 'resolve 归一化掉尾斜杠');

  const blank = createSession({ store: '' });
  assert.equal(blank.store, resolveStorePath(DEFAULT_STORE));
  assert.equal(blank.storeRaw, DEFAULT_STORE, 'store 给空串时 storeRaw 回退默认库（用户会看到它）');
  assert.equal(createSession({ store: '   ' }).storeRaw, DEFAULT_STORE);
  assert.equal(createSession({ store: '~/x' }).storeRaw, '~/x', 'storeRaw 保留用户写的样子');
  assert.equal(createSession({ store: '~/x' }).store, join(homedir(), 'x'));
  assert.equal(createSession({}).semantic, '', '默认不开语义接缝');
  assert.equal(createSession({ semantic: ' m.js ' }).semantic, 'm.js');
  assert.equal(createSession({}).semanticTimeoutMs, 2000);
  assert.equal(createSession({ semanticTimeoutMs: 50 }).semanticTimeoutMs, 50);
  assert.equal(createSession({ semanticTimeoutMs: 0 }).semanticTimeoutMs, 2000, '0 当作没给');
  assert.equal(createSession({ semanticTimeoutMs: 'abc' }).semanticTimeoutMs, 2000);
  assert.deepEqual([createSession({}).index, createSession({}).fingerprint], [null, '']);

  const envBefore = { store: process.env.ENGRAMORY_STORE, semantic: process.env.ENGRAMORY_SEMANTIC_PROVIDER };
  try {
    delete process.env.ENGRAMORY_STORE;
    assert.equal(createSession({}).store, resolveStorePath(DEFAULT_STORE), '没人给就是用默认库');
    assert.equal(createSession({}).storeRaw, DEFAULT_STORE);
    process.env.ENGRAMORY_STORE = '';
    assert.equal(createSession({}).store, resolveStorePath(DEFAULT_STORE), '环境变量给空串＝还是默认库');
    process.env.ENGRAMORY_SEMANTIC_PROVIDER = 'host-llm';
    assert.equal(createSession({}).semantic, 'host-llm');
    assert.equal(createSession({ semantic: 'mjs' }).semantic, 'mjs', '显式参数压过环境变量');
  } finally {
    for (const [key, value] of Object.entries({ ENGRAMORY_STORE: envBefore.store, ENGRAMORY_SEMANTIC_PROVIDER: envBefore.semantic })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('MCP：语义接缝开着但只有 host-llm 时，降级成词面检索（输出逐字相同）', async () => {
  await withStore(async (session, dir) => {
    const lexical = textOf(await callTool(session, { name: 'engramory_search', arguments: { query: '钻头螺栓' } }));
    const seamed = createSession({ store: dir, semantic: 'host-llm' });
    const withSeam = textOf(await callTool(seamed, { name: 'engramory_search', arguments: { query: '钻头螺栓' } }));
    assert.equal(withSeam, lexical, 'MCP 侧没有 DSH 宿主运行时：host-llm 必须降级成词面，而不是换一套说法或假装成功');
    assert.match(withSeam, /a\.md/);
    // 降级也不能把协议帧弄坏
    const frame = await handleMessage(seamed, { id: 1, method: 'tools/call', params: { name: 'engramory_search', arguments: { query: '钻头螺栓' } } });
    assert.equal(frame.error, undefined);
    assert.equal(frame.result.isError, false);
    // 本地模块不存在时同理：只降级，不报错
    const bogus = createSession({ store: dir, semantic: './不存在的语义模块.js' });
    assert.equal((await callTool(bogus, { name: 'engramory_search', arguments: { query: '钻头螺栓' } })).isError, false);
  });
});

test('MCP：入口判定——被 import 时绝不抢 stdin；当程序跑且 stdout 坏掉时不静默', () => {
  const mcpPath = fileURLToPath(new URL('../mcp.js', import.meta.url));
  const url = pathToFileURL(mcpPath).href;
  const env = { ...process.env };
  delete env.ENGRAMORY_STORE; // 别让跑测试的 shell 影响 print-config 的结果
  // 被 import（process.argv[1] 不是它）：不能进主循环，否则测试进程会挂在那儿读 stdin
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
    input: '', encoding: 'utf8', timeout: 20000, env,
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '', '被 import 时 stdout 不能有任何东西');
  assert.equal(imported.stderr, '');

  const box = mkdtempSync(join(tmpdir(), 'mcp-entry-'));
  try {
    // npm 装出来的 bin 是符号链接：Node 解析真实路径后 argv[1] 是链接、import.meta.url 是真实路径。
    // 0.8.0 就是在这儿坏的（两边只比 URL 字符串 → 判定 false → 进程安静地读 stdin 永不回包）。
    writeFileSync(join(box, 'package.json'), JSON.stringify({ type: 'module' }));
    const link = join(box, 'engramory-recall-mcp.js');
    symlinkSync(mcpPath, link);
    const viaLink = spawnSync(process.execPath, [link, '--print-config'], { encoding: 'utf8', timeout: 20000, env });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(viaLink.stderr, '');
    const config = JSON.parse(viaLink.stdout);
    assert.equal(config.name, SERVER_NAME);
    assert.equal(config.version, SERVER_VERSION);
    assert.equal(config.store, resolveStorePath(DEFAULT_STORE), '符号链接入口也要按默认库识别');

    // argv[1] 指向不存在的路径（入口被删/悬空软链）：realpathSync 抛错，不能因此误判成入口
    const dangling = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `process.argv[1] = ${JSON.stringify(join(box, '不存在.js'))};`,
      `await import(${JSON.stringify(url)});`,
    ].join('\n')], { input: '', encoding: 'utf8', timeout: 20000, env });
    assert.equal(dangling.status, 0, dangling.stderr);
    assert.equal(dangling.stdout, '');
    assert.equal(dangling.stderr, '');

    // 当程序跑、而 stdout 一写就坏（EPIPE 那类）：必须带栈退出，不能安静地假装没事
    const script = [
      `process.argv[1] = ${JSON.stringify(mcpPath)};`,
      'process.stdout.write = () => { throw new Error("stdout 坏掉了"); };',
      `await import(${JSON.stringify(url)});`,
    ].join('\n');
    const broken = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`, encoding: 'utf8', timeout: 20000, env,
    });
    assert.equal(broken.status, 1, '写不出帧就必须非 0 退出');
    assert.equal(broken.stdout, '', '⚠️ 现状：一个帧都没出去（客户端只会看到空响应）');
    assert.match(broken.stderr, /stdout 坏掉了/);
    assert.match(broken.stderr, /mcp\.js:\d+/, '栈要指到写 stdout 的那一行，方便查');

    // 同一件事走「入口 + main」这条路（--print-config 直接写 stdout）时，走的是 main 的 rejection 兜底：
    // stderr 里要有「退出：」前缀，退出码 1
    const breaker = join(box, 'break-stdout.cjs');
    writeFileSync(breaker, 'process.stdout.write = () => { throw new Error("stdout 坏掉了"); };\n');
    const refused = spawnSync(process.execPath, [mcpPath, '--print-config'], {
      encoding: 'utf8', timeout: 20000, env: { ...env, NODE_OPTIONS: `--require ${breaker}` },
    });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, new RegExp(`^\\[${SERVER_NAME}\\] 退出：`), '兜底必须写 stderr，且带前缀');
    assert.match(refused.stderr, /stdout 坏掉了/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
