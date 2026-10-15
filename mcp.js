#!/usr/bin/env node
/**
 * 零依赖的 MCP（Model Context Protocol）服务器，走 stdio。
 *
 * 为什么有这个东西：检索内核（`bm25.js` + `store.js`）本来就不依赖 DSH ——
 * 记忆库就是一堆 markdown，索引就是词频。别的宿主（Claude Code、Codex、Cursor…）
 * 只要支持 MCP，就应该能用同一份库。插件不该被绑死在一个宿主上。
 *
 * 四条自我约束（改掉任何一条就等于换了个东西）：
 * 1. 只用 `node:` 内置模块：零依赖、零子进程、零网络、零模型调用；
 * 2. **只读**：没有任何写库的接口 —— 闸门、归档、体检那套留在 DSH 那一侧的家用版本里；
 * 3. 不 import 任何宿主包（`@deepseek-ai/*`）。所以它在别的宿主里最坏是「没被装上」，
 *    不会因为版本对不上而「装上就崩」；
 * 4. **stdout 只允许出现协议帧**：日志一律走 stderr，否则客户端解析到一半就崩。
 *
 * 用法：`node mcp.js [--store <路径>]`，或者看 README 里各宿主的配置片段。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex, search } from './bm25.js';
import { countLines, DEFAULT_MAX_INDEX_BYTES, DEFAULT_MAX_INDEX_LINES, measureIndex } from './index-guard.js';
import { describeSeam, semanticSearch } from './semantic.js';
import { corpusFingerprint, readDocs } from './store.js';

export const SERVER_NAME = 'dsh-engramory-recall';
/** 声明支持的 MCP 协议版本。客户端报的版本在名单里就照它回，否则回我们最新的。 */
export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
export const DEFAULT_STORE = '~/memory/engramory';
/** 单个工具结果的字符上限：MCP 客户端会把结果塞进上下文，给个天花板。 */
export const MAX_OUTPUT_CHARS = 40000;
export const MAX_LIMIT = 20;
export const DEFAULT_LIMIT = 5;

const pkg = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
})();
export const SERVER_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

/** 工具执行失败：message 会原样出现在 isError 的文本里，所以写人话。 */
export class McpError extends Error {}

export const TOOLS = [
  {
    name: 'engramory_search',
    description:
      '在本地 Engramory 记忆库里检索相关笔记（BM25 词面检索，含中文分词、同义桥与别名，本机执行、零模型调用）。返回文件名、分数与命中词。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '查询文本，中英文都行；口语说法会被同义表桥到技术词。' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `返回几条，默认 ${DEFAULT_LIMIT}。`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'engramory_read',
    description: '按文件名读出一篇笔记的完整 markdown 原文（只读库根目录下的 .md，不接受路径）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { file: { type: 'string', description: '库里的文件名，例如 reference-publish-plugin-to-npm.md' } },
      required: ['file'],
    },
  },
  {
    name: 'engramory_status',
    description: '汇报记忆库的位置、笔记数、索引用量与上限，用来确认客户端读的是不是你以为的那个库。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export const RESOURCE_TEMPLATE = {
  uriTemplate: 'engramory://note/{file}',
  name: '一篇笔记',
  description: '把 {file} 换成 <store> 下的文件名。',
  mimeType: 'text/markdown',
};

export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '~') return homedir();
  return text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
}

/** 库路径：命令行 > 环境变量 ENGRAMORY_STORE > 默认 `~/memory/engramory`。 */
export function resolveStorePath(raw) {
  const expanded = expandHome(raw);
  return expanded ? resolve(expanded) : resolve(expandHome(DEFAULT_STORE));
}

export function createSession(options = {}) {
  const raw = options.store ?? process.env.ENGRAMORY_STORE ?? DEFAULT_STORE;
  const semantic = String(options.semantic ?? process.env.ENGRAMORY_SEMANTIC_PROVIDER ?? '').trim();
  return {
    store: resolveStorePath(raw),
    storeRaw: String(raw ?? '').trim() || DEFAULT_STORE,
    semantic,
    semanticTimeoutMs: Number(options.semanticTimeoutMs) || 2000,
    index: null,
    fingerprint: '',
  };
}

/** 索引按语料指纹缓存：库被改过就重建，没改过就复用（readDocs 自己也有 mtime 缓存）。 */
function indexFor(session) {
  const docs = readDocs(session.store);
  const fingerprint = corpusFingerprint(docs);
  if (!session.index || session.fingerprint !== fingerprint) {
    session.index = buildIndex(docs);
    session.fingerprint = fingerprint;
  }
  return session.index;
}

/** 库里唯一的笔记（长笔记在索引里会切成多桶，这里按 id 折回一篇）。 */
function notesOf(session) {
  const notes = new Map();
  for (const doc of readDocs(session.store)) {
    const existing = notes.get(doc.id);
    if (!existing) notes.set(doc.id, { file: doc.id, title: doc.title || doc.id, description: doc.description || '' });
    else if (!existing.description && doc.description) existing.description = doc.description;
  }
  return [...notes.values()];
}

function safeNotePath(session, file) {
  const name = String(file ?? '').trim();
  if (!name) throw new McpError('需要 file 参数：库里的 markdown 文件名。');
  if (name !== basename(name) || name.startsWith('.') || !name.endsWith('.md')) {
    throw new McpError(`不是库里的笔记文件名：${name}。只接受 <store> 下直接的 .md 文件名，不接受路径。`);
  }
  const full = join(session.store, name);
  if (!resolve(full).startsWith(session.store + sep)) throw new McpError(`拒绝越界路径：${name}`);
  return full;
}

function readNote(session, file) {
  const name = String(file ?? '').trim() || basename(safeNotePath(session, file));
  const full = safeNotePath(session, name);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new McpError(`读不到这篇笔记：${name}。用 engramory_status 看库的位置，或 engramory_search 找回文件名。`);
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…（笔记超过 ${MAX_OUTPUT_CHARS} 字符，这里截断了；完整原文在 ${name}）`;
  }
  return text;
}

async function toolSearch(session, args) {
  const query = String(args?.query ?? '').trim();
  if (!query) throw new McpError('需要非空的 query。');
  const raw = Number(args?.limit);
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw))) : DEFAULT_LIMIT;
  const docs = readDocs(session.store);
  if (!docs.length) {
    throw new McpError(`库是空的或不存在：${session.store}。用 --store <路径> 或环境变量 ENGRAMORY_STORE 指定。`);
  }
  // 语义接缝在 MCP 侧同样可用，但只支持「本地模块」提供方：`host-llm` 需要 DSH 宿主运行时，
  // 这里没有（semanticSearch 会明确回 no-host 并降级，不假装成功）。
  const seam = session.semantic || '';
  const { hits } = seam
    ? await semanticSearch({ index: indexFor(session), query, limit, config: { provider: seam, timeoutMs: session.semanticTimeoutMs } })
    : { hits: searchLexical(indexFor(session), query, limit) };
  const header = `库：${session.store}（${notesOf(session).length} 篇）· 查询：${query}`;
  if (!hits.length) return `${header}\n没有命中。换个词，或先用 engramory_status 确认库对不对。`;
  const lines = hits.map((hit, i) => {
    const snippet = String(hit.snippet || '').replace(/\s+/g, ' ').trim();
    const matched = Array.isArray(hit.matched) && hit.matched.length ? hit.matched.join('、') : '—';
    return [`${i + 1}. ${hit.id} · ${Number(hit.score).toFixed(2)}`, `   ${snippet}`, `   命中：${matched}`].join('\n');
  });
  return [header, ...lines].join('\n');
}

function toolStatus(session) {
  const notes = notesOf(session);
  let indexText = '';
  try {
    indexText = readFileSync(join(session.store, 'MEMORY.md'), 'utf8');
  } catch {
    /* 索引缺失不是错误：没有索引也能按正文召回，只是宿主不会自动打开它。 */
  }
  // measureIndex 返回的是「超限时的人话描述 / 没超时 null」，行数与字节数得自己数。
  const over = measureIndex(indexText, DEFAULT_MAX_INDEX_LINES, DEFAULT_MAX_INDEX_BYTES);
  const indexLine = indexText
    ? `索引：${countLines(indexText)} 行 / ${Buffer.byteLength(indexText)} 字节（上限 ${DEFAULT_MAX_INDEX_LINES} 行 / ${DEFAULT_MAX_INDEX_BYTES} 字节${over ? `，已超限：${over}` : ''}）`
    : '索引：没有 MEMORY.md（召回仍可用，但宿主没有索引可读）';
  return [
    `库：${session.store}`,
    `笔记：${notes.length} 篇`,
    indexLine,
    `指纹：${corpusFingerprint(readDocs(session.store)).slice(0, 12) || '（空库）'}`,
    `服务器：${SERVER_NAME} ${SERVER_VERSION} · 只读 · 零模型调用`,
  ].join('\n');
}

/** 关着（默认）时用的同步词面检索 —— 与插件里那条路径一字不差。 */
function searchLexical(index, query, limit) {
  return buildIndex ? search(index, query, limit) : [];
}

const HANDLERS = {
  engramory_search: toolSearch,
  engramory_read: (session, args) => readNote(session, args?.file),
  engramory_status: toolStatus,
};

export async function callTool(session, params) {
  const name = String(params?.name ?? '');
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `没有这个工具：${name}。可用：${Object.keys(HANDLERS).join(' / ')}` }], isError: true };
  }
  try {
    // 处理器可以是 async（搜索走语义接缝时就是）：这里必须 await，
    // 否则 String(Promise) 会把结果变成一行 "[object Promise]" —— 0.9.0 开发时真踩过。
    const value = await handler(session, params?.arguments ?? {});
    return { content: [{ type: 'text', text: String(value) }], isError: false };
  } catch (error) {
    const text = error instanceof McpError ? error.message : `工具 ${name} 出错：${error?.message ?? error}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}

export function listResources(session) {
  return {
    resources: notesOf(session).map((note) => ({
      uri: `engramory://note/${note.file}`,
      name: note.file,
      title: note.title,
      description: note.description || undefined,
      mimeType: 'text/markdown',
    })),
  };
}

export function readResource(session, params) {
  const uri = String(params?.uri ?? '');
  const prefix = 'engramory://note/';
  if (!uri.startsWith(prefix)) throw new McpError(`只认得 ${prefix}<文件名> 这种 URI，收到的是：${uri}`);
  const file = decodeURIComponent(uri.slice(prefix.length));
  return { contents: [{ uri, mimeType: 'text/markdown', text: readNote(session, file) }] };
}

function initializeResult(params) {
  const asked = String(params?.protocolVersion ?? '');
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'Engramory 记忆召回（本地 markdown，只读）' },
    instructions:
      '这是本机 markdown 记忆库的只读检索。先用 engramory_search 找相关笔记，再用 engramory_read 打开需要的那些；' +
      '不要假设库里有什么，也不要通过它写任何东西。',
  };
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** 处理一条 JSON-RPC 消息；通知返回 null（协议规定通知不回包）。 */
export async function handleMessage(session, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return fail(null, -32600, 'Invalid Request：只接受单条 JSON-RPC 2.0 对象（不支持批量）。');
  }
  const { id, method } = message;
  const notification = id === undefined || id === null;
  if (typeof method !== 'string') {
    return notification ? null : fail(id, -32600, 'Invalid Request：method 必须是字符串。');
  }
  if (method.startsWith('notifications/')) return null;
  // 协议规定「通知」不回包：已知方法也要按 id 判断一次，否则会写出没有 id 的响应帧。
  const reply = (result) => (notification ? null : ok(id, result));
  try {
    switch (method) {
      case 'initialize':
        return reply(initializeResult(message.params));
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        return reply(await callTool(session, message.params));
      case 'resources/list':
        return reply(listResources(session));
      case 'resources/templates/list':
        return reply({ resourceTemplates: [RESOURCE_TEMPLATE] });
      case 'resources/read':
        return reply(readResource(session, message.params));
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        if (notification) return null;
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const text = error instanceof McpError ? error.message : `内部错误：${error?.message ?? error}`;
    return notification ? null : fail(id, -32603, text);
  }
}

/** stdio 主循环：一行一条消息，stdout 只写协议帧。 */
export async function serveStdio(session, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = [];
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      output.write(`${JSON.stringify(fail(null, -32700, 'Parse error：这一行不是合法 JSON。'))}\n`);
      return;
    }
    // 逐条串行处理：保证响应顺序与请求顺序一致（工具调用本身很快，不值得为并发引入状态问题）。
    const task = (pending.at(-1) ?? Promise.resolve())
      .then(() => handleMessage(session, message))
      .then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        output.write(`${JSON.stringify(fail(message?.id ?? null, -32603, String(error?.message ?? error)))}\n`);
      });
    pending.push(task);
    if (pending.length > 64) pending.shift();
  });
  await new Promise((done) => rl.on('close', done));
  await Promise.all(pending);
}

export const USAGE = `用法：node mcp.js [--store <路径>] [--semantic <本地模块路径>] [--print-config] [--version] [--help]

零依赖、只读的 MCP stdio 服务器：把 Engramory markdown 记忆库暴露成
engramory_search / engramory_read / engramory_status 三个工具。
库路径优先级：--store > 环境变量 ENGRAMORY_STORE > ${DEFAULT_STORE}
语义接缝（可选、默认关闭）：--semantic > 环境变量 ENGRAMORY_SEMANTIC_PROVIDER，
只支持本地模块提供方（host-llm 需要 DSH 宿主运行时，这里会降级为词面）。
日志一律写 stderr；stdout 只有 JSON-RPC 帧。`;

export function parseArgs(argv) {
  const args = { store: '', semantic: '', help: false, version: false, printConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store') args.store = argv[++i] ?? '';
    else if (arg === '--semantic') args.semantic = argv[++i] ?? '';
    else if (arg.startsWith('--semantic=')) args.semantic = arg.slice('--semantic='.length);
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--print-config') args.printConfig = true;
    else if (arg.trim()) args.error = `听不懂的参数：${arg}`;
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  const session = createSession({ store: args.store || undefined, semantic: args.semantic || undefined });
  if (args.printConfig) {
    process.stdout.write(`${JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, store: session.store })}\n`);
    return 0;
  }
  const seam = describeSeam({ provider: session.semantic });
  process.stderr.write(
    `[${SERVER_NAME}] 库：${session.store} · 只读 · 语义接缝：${seam.enabled ? seam.spec : '关闭（默认）'} · 日志只走 stderr\n`,
  );
  await serveStdio(session);
  return 0;
}

/**
 * 「这个文件是被当程序跑的吗」不能只比 URL 字符串：npm 装出来的 bin 是个符号链接
 * （`node_modules/.bin/engramory-recall-mcp`），Node 默认解析真实路径，
 * `import.meta.url` 是真实路径、`process.argv[1]` 是链接路径 —— 一比就 false，
 * 进程会安静地读 stdin 永不回包（0.8.0 就是这么坏的，用户只会看到「服务器没反应」）。
 * 所以两边都取 realpath 再比。
 */
function isEntryPoint(entry) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isEntryPoint(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[${SERVER_NAME}] 退出：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
