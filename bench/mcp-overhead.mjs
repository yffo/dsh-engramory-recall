#!/usr/bin/env node
// MCP 这一层的「数字」：冷启动多贵、一次工具调用往返多少、协议帧多大。
// 目的不是跑分，而是给「跨宿主分发」这件事一个可复算的代价表 —— 以及一条回归线：
// stdout 上只准有 JSON-RPC 帧（任何一行解析不了就直接失败）。
//
//   node bench/mcp-overhead.mjs [--runs 5] [--store <路径>] [--json]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const RUNS = Number(flag('runs', 5));
const STORE = flag('store', path.join(os.homedir(), 'memory', 'engramory'));
const AS_JSON = argv.includes('--json');
const QUERY = '发布 token';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 起一个真进程、说完整的 MCP 对话，返回每一步的耗时与字节数。 */
function oneRun() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['mcp.js', '--store', STORE], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const steps = {};
    const pending = new Map();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let id = 0;
    let buffer = '';

    const send = (method, params) => {
      const requestId = ++id;
      const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) });
      const promise = new Promise((done, fail) => pending.set(requestId, { done, fail, method }));
      steps[`${method}:sent`] = Date.now();
      child.stdin.write(`${body}\n`);
      return promise;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          reject(new Error(`stdout 上出现了不是 JSON-RPC 的一行（协议被污染）：${line.slice(0, 120)}`));
          return;
        }
        if (message.id === null || message.id === undefined) continue; // 通知：客户端忽略
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.fail(new Error(`${waiter.method} 失败：${message.error.message}`));
        else waiter.done(message);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrBytes += Buffer.byteLength(chunk); });
    child.on('error', reject);

    (async () => {
      const init = await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bench/mcp-overhead', version: '1' },
      });
      steps.coldStartMs = Date.now() - started;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const at = () => Date.now();
      const toolsStart = at();
      const tools = await send('tools/list');
      steps.toolsListMs = at() - toolsStart;

      const searchStart = at();
      const search = await send('tools/call', { name: 'engramory_search', arguments: { query: QUERY, limit: 5 } });
      steps.searchMs = at() - searchStart;

      const statusStart = at();
      const status = await send('tools/call', { name: 'engramory_status', arguments: {} });
      steps.statusMs = at() - statusStart;

      const detail = {
        protocolVersion: init.result?.protocolVersion ?? '',
        serverVersion: init.result?.serverInfo?.version ?? '',
        tools: (tools.result?.tools ?? []).map((tool) => tool.name),
        hits: ((search.result?.content?.[0]?.text ?? '').match(/^\d+\./gm) ?? []).length,
        notes: Number((status.result?.content?.[0]?.text ?? '').match(/(\d+)\s*篇/)?.[1] ?? 0),
      };

      child.stdin.end();
      child.kill();
      resolve({ ...steps, stdoutBytes, stderrBytes, detail });
    })().catch(reject);
  });
}

const runs = [];
for (let i = 0; i < RUNS; i += 1) runs.push(await oneRun());

const pick = (key) => runs.map((run) => run[key]);
const table = {
  运行次数: RUNS,
  冷启动ms: median(pick('coldStartMs')),
  'tools/list_ms': median(pick('toolsListMs')),
  'search_ms': median(pick('searchMs')),
  'status_ms': median(pick('statusMs')),
  'stdout字节': median(pick('stdoutBytes')),
  'stderr字节': median(pick('stderrBytes')),
};
const last = runs.at(-1).detail;

if (AS_JSON) {
  console.log(JSON.stringify({ store: STORE, ...table, detail: last, runs }, null, 2));
} else {
  console.log(`库：${STORE}`);
  console.log(`\n| 指标 | 中位数（${RUNS} 次冷启动） |\n| --- | --- |`);
  for (const [key, value] of Object.entries(table)) console.log(`| ${key} | ${Math.round(value * 100) / 100} |`);
  console.log(`\n协议：${last.protocolVersion} · 服务器版本 ${last.serverVersion} · 工具 ${last.tools.join('/')}`);
  console.log(`一次对话：命中 ${last.hits} 条 · status 报 ${last.notes} 篇`);
  console.log('\n（延迟随机器变化；能跨机复算的是「帧数与字节数」和下面这条断言。）');
  console.log('stdout 只含 JSON-RPC 帧：✓（任何一行解析不了，这次运行就已经失败了）');
}
