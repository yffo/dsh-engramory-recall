// MCP 服务器的进程级测试：把 mcp.js 真的当子进程拉起来，走 stdio 说 JSON-RPC。
//
// 为什么不在进程内直接调 handleMessage：这个文件最要紧的约束是「stdout 上只能有协议帧」
// 和「参数解析 / 退出码 / 只读边界」——那些只有真起进程才量得到。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, 'mcp.js');

const NOTES = {
  'reference-stdio-protocol.md': [
    '---',
    'name: stdio 协议帧',
    'description: JSON-RPC 2.0 走 stdio 的基本约束',
    'type: reference',
    '---',
    '',
    '# stdio 协议帧',
    '',
    'MCP 服务器用 JSON-RPC 2.0 走 stdio，stdout 上只能出现协议帧。',
    '日志必须写 stderr，否则客户端解析到一半就崩。',
  ].join('\n'),
  'project-restart-host.md': [
    '---',
    'name: 改完配置要重启宿主',
    'description: 客户端读不到新工具时的第一步排查',
    'type: project',
    '---',
    '',
    '# 改完配置要重启宿主',
    '',
    '工具列表是启动时拉的：改完配置不重启宿主，客户端看不到新工具。',
  ].join('\n'),
  'user-short-sentences.md': [
    '---',
    'name: 表达偏好',
    'description: 中文短句与表格',
    'type: user',
    '---',
    '',
    '# 表达偏好',
    '',
    '偏好中文短句，能用表格就用表格。',
  ].join('\n'),
};

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-store-'));
  for (const [file, text] of Object.entries(NOTES)) writeFileSync(join(dir, file), text);
  writeFileSync(join(dir, 'MEMORY.md'), '# 索引\n\n- [stdio 协议帧](reference-stdio-protocol.md) — 一行钩子。\n');
  return dir;
}

function startServer(store, entry = serverPath) {
  const child = spawn(process.execPath, [entry, '--store', store], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  const stdoutFrames = [];
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    const message = JSON.parse(text); // 解析失败就是「stdout 被污染」，测试应当直接炸
    stdoutFrames.push(message);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 5000).unref();
    });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const close = () =>
    new Promise((resolve) => {
      child.on('close', resolve);
      child.stdin.end();
    });
  return { child, request, notify, close, stderr, stdoutFrames };
}

test('MCP：initialize 回服务器名、工具能力与双方都支持的协议版本', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const reply = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.result.serverInfo.name, 'dsh-engramory-recall');
    assert.match(reply.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.equal(reply.result.protocolVersion, '2025-06-18');
    assert.ok(reply.result.capabilities.tools, '要声明 tools 能力');

    const older = await server.request('initialize', { protocolVersion: '不存在的版本' });
    assert.equal(older.result.protocolVersion, '2025-06-18', '客户端报的版本不认得时回我们最新的');
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }
});

test('MCP：tools/list 给出三个工具与可校验的 inputSchema', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const reply = await server.request('tools/list');
    const tools = reply.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['engramory_search', 'engramory_read', 'engramory_status'],
    );
    const search = tools.find((t) => t.name === 'engramory_search');
    assert.deepEqual(search.inputSchema.required, ['query']);
    assert.equal(search.inputSchema.properties.limit.maximum, 20);
    assert.equal(search.inputSchema.additionalProperties, false);
    assert.equal(tools.find((t) => t.name === 'engramory_status').inputSchema.properties && Object.keys(tools.find((t) => t.name === 'engramory_status').inputSchema.properties).length, 0);
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }
});

test('MCP：engramory_search 命中语料里的笔记，且 stdout 上没有杂物', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05' });
    server.notify('notifications/initialized');
    const reply = await server.request('tools/call', { name: 'engramory_search', arguments: { query: 'stdio 协议帧', limit: 3 } });
    assert.equal(reply.result.isError, false);
    const text = reply.result.content[0].text;
    assert.match(text, /reference-stdio-protocol\.md/, '该命中的笔记要出现在结果里');
    assert.match(text, /命中：/, '要给出命中词');
    assert.ok(reply.result.content[0].type === 'text');
    assert.equal(server.stdoutFrames.length, 2, '两问两答：通知按协议不回包，stdout 上不能多出东西');
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }
});

test('MCP：非法参数不炸进程，而是 isError 文本', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const empty = await server.request('tools/call', { name: 'engramory_search', arguments: { query: '   ' } });
    assert.equal(empty.result.isError, true);
    assert.match(empty.result.content[0].text, /非空/);

    const unknownTool = await server.request('tools/call', { name: 'engramory_drop_everything', arguments: {} });
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /没有这个工具/);

    const unknownMethod = await server.request('tools/definitely_not_real');
    assert.equal(unknownMethod.error.code, -32601);

    const stillAlive = await server.request('ping');
    assert.deepEqual(stillAlive.result, {}, '出过错之后进程还得活着');
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }
});

test('MCP：engramory_read 只认库根目录下的 .md，路径越界一律拒', async () => {
  const store = makeStore();
  const outside = join(dirname(store), 'secret.md');
  writeFileSync(outside, '这是库外文件，绝不该被读出来。');
  const server = startServer(store);
  try {
    const good = await server.request('tools/call', { name: 'engramory_read', arguments: { file: 'project-restart-host.md' } });
    assert.equal(good.result.isError, false);
    assert.match(good.result.content[0].text, /改完配置不重启宿主/);

    for (const file of ['../secret.md', 'secret.md', 'notes/deep.md', '.hidden.md', 'README.txt', '']) {
      const reply = await server.request('tools/call', { name: 'engramory_read', arguments: { file } });
      assert.equal(reply.result.isError, true, `${file} 应当被拒`);
      assert.ok(!reply.result.content[0].text.includes('绝不该被读出来'), `${file} 不能泄出库外内容`);
    }
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('MCP：resources/list 与 resources/read 往返，URI 不对就报错', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    const list = await server.request('resources/list');
    const uris = list.result.resources.map((r) => r.uri);
    assert.equal(uris.length, Object.keys(NOTES).length);
    assert.ok(uris.every((uri) => uri.startsWith('engramory://note/')));
    assert.ok(uris.includes('engramory://note/reference-stdio-protocol.md'));

    const read = await server.request('resources/read', { uri: 'engramory://note/user-short-sentences.md' });
    assert.match(read.result.contents[0].text, /偏好中文短句/);
    assert.equal(read.result.contents[0].mimeType, 'text/markdown');

    const wrong = await server.request('resources/read', { uri: 'file:///etc/passwd' });
    assert.equal(wrong.error.code, -32603);
    assert.match(wrong.error.message, /只认得/);
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }
});

test('MCP：库不存在时给的是「库在哪」的提示，不是崩', async () => {
  const missing = join(tmpdir(), `mcp-missing-${Date.now()}`);
  mkdirSync(missing, { recursive: true });
  const server = startServer(join(missing, '不存在的库'));
  try {
    const status = await server.request('tools/call', { name: 'engramory_status', arguments: {} });
    assert.equal(status.result.isError, false);
    assert.match(status.result.content[0].text, /笔记：0 篇/);
    assert.match(status.result.content[0].text, /没有 MEMORY\.md/);

    const searchReply = await server.request('tools/call', { name: 'engramory_search', arguments: { query: '随便' } });
    assert.equal(searchReply.result.isError, true);
    assert.match(searchReply.result.content[0].text, /库是空的或不存在/);
  } finally {
    await server.close();
    rmSync(missing, { recursive: true, force: true });
  }
});

test('MCP：日志只走 stderr；--print-config 与 --version 是纯文本', async () => {
  const store = makeStore();
  const server = startServer(store);
  try {
    await server.request('initialize', { protocolVersion: '2025-06-18' });
    assert.ok(server.stderr.some((line) => line.includes(store)), 'stderr 上要有「读的是哪个库」');
    assert.ok(
      server.stdoutFrames.every((frame) => frame.jsonrpc === '2.0'),
      'stdout 上每一行都必须是 JSON-RPC 帧',
    );
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
  }

  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [serverPath, ...args], { cwd: root });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);

  const config = await run(['--print-config', '--store', store]);
  assert.equal(config.code, 0);
  assert.equal(JSON.parse(config.stdout).store, store);

  const bad = await run(['--nonsense']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /听不懂的参数/);

  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /ENGRAMORY_STORE/);
});

test('MCP：通过符号链接调用也要能起来（npm 的 bin 就是链接）', async () => {
  const store = makeStore();
  const binDir = mkdtempSync(join(tmpdir(), 'mcp-bin-'));
  const link = join(binDir, 'engramory-recall-mcp');
  symlinkSync(serverPath, link);
  const server = startServer(store, link);
  try {
    const reply = await server.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(reply.result.serverInfo.name, 'dsh-engramory-recall');
    const search = await server.request('tools/call', { name: 'engramory_search', arguments: { query: 'stdio' } });
    assert.equal(search.result.isError, false);
  } finally {
    await server.close();
    rmSync(store, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
