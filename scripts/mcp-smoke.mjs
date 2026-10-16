#!/usr/bin/env node
/**
 * 最小的 MCP 客户端：把 `mcp.js` 当子进程拉起来，走一遍真实对话
 * （initialize → tools/list → status → search → resources/read），
 * 把请求与响应按人类能读的格式打印出来。
 *
 * 用途有两个：
 * 1. 「这个服务器真的能当 MCP 用」的可复算证据 —— 它不依赖任何 MCP 客户端库；
 * 2. 接入手册：想知道某个宿主发的是什么、我们回的是什么，跑它就行。
 *
 * 用法：`node scripts/mcp-smoke.mjs [--store <路径>] [--query <文本>]`
 * 退出码：全部成功 0；任何一步失败或返回 isError 都非 0。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const readFlag = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const store = readFlag('--store', process.env.ENGRAMORY_STORE || '');
const query = readFlag('--query', '记忆库 索引 上限');

const child = spawn(process.execPath, [join(root, 'mcp.js'), ...(store ? ['--store', store] : [])], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stderrLines = [];
createInterface({ input: child.stderr }).on('line', (line) => stderrLines.push(line));
const stdout = createInterface({ input: child.stdout });

const pending = new Map();
let nextId = 1;
let failures = 0;

stdout.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    console.error(`✗ stdout 上出现了非协议内容（客户端会崩）：${text.slice(0, 120)}`);
    failures += 1;
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry.resolve(message);
});

function request(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  pending.set(id, { resolve: null });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超过 5 秒没回`));
      }
    }, 5000).unref();
  });
}

const show = (title, value) => {
  console.log(`\n── ${title} ──`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const tool = async (name, toolArgs) => {
  const reply = await request('tools/call', { name, arguments: toolArgs });
  const result = reply.result;
  const text = result?.content?.[0]?.text ?? JSON.stringify(reply.error ?? reply.result);
  if (reply.error || result?.isError) {
    failures += 1;
    show(`${name} ✗`, text);
  } else {
    show(`${name} ✓`, text);
  }
  return result;
};

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1' },
  });
  show('initialize', init.result ?? init.error);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const tools = await request('tools/list');
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  show('tools/list', names.join(' / '));
  // 名字写死是故意的：工具面是对外契约，少一个多一个都要有人看见。
  const expected = ['engramory_search', 'engramory_read', 'engramory_status', 'engramory_list', 'engramory_usage'];
  if (names.length !== expected.length || expected.some((n) => !names.includes(n))) failures += 1;

  await tool('engramory_status');
  await tool('engramory_search', { query, limit: 3 });
  await tool('engramory_list', { limit: 3 });
  await tool('engramory_usage', { top: 3 });

  const list = await request('resources/list');
  const resources = list.result?.resources ?? [];
  const first = resources[0];
  show('resources/list', `${resources.length} 个资源${first ? `，第一个：${first.uri}` : ''}`);
  if (!resources.some((r) => r.uri === 'engramory://index')) failures += 1;
  if (first) {
    const read = await request('resources/read', { uri: first.uri });
    const text = read.result?.contents?.[0]?.text ?? '';
    show('resources/read', `${first.uri} → ${text.length} 字符`);
    if (!text) failures += 1;
  }

  const prompts = await request('prompts/list');
  const promptNames = (prompts.result?.prompts ?? []).map((p) => p.name);
  show('prompts/list', promptNames.join(' / '));
  if (!promptNames.includes('recall') || !promptNames.includes('curate')) failures += 1;
  const prompt = await request('prompts/get', { name: 'recall', arguments: { query } });
  const promptText = prompt.result?.messages?.[0]?.content?.text ?? '';
  show('prompts/get', `recall → ${promptText.length} 字符`);
  if (!promptText.includes('engramory_search')) failures += 1;

  const bad = await request('tools/call', { name: 'engramory_read', arguments: { file: '../escaped.md' } });
  show('越界读被拒 ✓', bad.result?.content?.[0]?.text ?? JSON.stringify(bad.error));
  if (!bad.result?.isError) failures += 1;
} catch (error) {
  failures += 1;
  console.error(`✗ ${error.message}`);
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
}

console.log(`\n── stderr（日志只该出现在这里）──\n${stderrLines.join('\n') || '（空）'}`);
console.log(failures ? `\n✗ 有 ${failures} 处不对` : '\n✓ 全程走通：五个工具 + 索引资源 + 两个提示，越界读被拒');
process.exit(failures ? 1 : 0);
