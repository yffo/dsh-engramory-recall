import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  createSession, handleMessage, serveStdio, callTool, resolveStorePath, expandHome,
  MAX_OUTPUT_CHARS, DEFAULT_LIMIT, MAX_LIMIT, RESOURCE_TEMPLATE, SUPPORTED_PROTOCOL_VERSIONS,
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
