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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex, search } from './bm25.js';
import { countLines, DEFAULT_MAX_INDEX_BYTES, DEFAULT_MAX_INDEX_LINES, measureIndex } from './index-guard.js';
import { describeSeam, semanticSearch } from './semantic.js';
import { corpusFingerprint, readDocs, readDocsReport, DEFAULT_MAX_NOTES, DEFAULT_MAX_BYTES } from './store.js';
import { readUsage, summarizeUsage, USAGE_FILE } from './usage.js';

export const SERVER_NAME = 'dsh-engramory-recall';
/** 声明支持的 MCP 协议版本。客户端报的版本在名单里就照它回，否则回我们最新的。 */
export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
export const DEFAULT_STORE = '~/memory/engramory';
/** 单个工具结果的字符上限：MCP 客户端会把结果塞进上下文，给个天花板。 */
export const MAX_OUTPUT_CHARS = 40000;
export const MAX_LIMIT = 20;
export const DEFAULT_LIMIT = 5;
/**
 * `engramory_list` 有自己的一对上下限：它是「先看一眼库里有什么」的入口，
 * 一次多看几条很正常（让陌生宿主先建立地图），跟搜索的 MAX_LIMIT 是两回事 ——
 * 改 MAX_LIMIT 不该顺手改掉搜索的语义，所以单开一对常量。
 */
export const MAX_LIST_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 20;
/** 每行只给 ~60 字描述：清单是目录不是正文，一行一条才扫得动。 */
export const LIST_DESCRIPTION_CHARS = 60;
/** `engramory_usage` 的 top 榜上限：榜单是佐证，不是报表。 */
export const MAX_USAGE_TOP = 20;
export const DEFAULT_USAGE_TOP = 5;

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
  {
    name: 'engramory_list',
    description:
      '列出记忆库里的笔记清单（文件名 · 类型 · 描述 · 字符数，按修改时间新的在前）。库是陌生的时先看这里，'
      + '再决定搜什么词、读哪几篇。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: '只看某一类：user（用户是谁）/ feedback（交互偏好）/ project（项目决策与踩坑）/ reference（外部资料指路）。不给就是全部。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `最多列几条，默认 ${DEFAULT_LIST_LIMIT}。`,
        },
      },
    },
  },
  {
    name: 'engramory_usage',
    description:
      '汇报记忆召回账本（只读）：注入过多少条指针、后来被打开过多少条（打开率）、一个字都没进的轮次、'
      + '按提问来源拆分、预算用量与顶格轮次数、被打开最多的几篇。'
      + '注意这是代理指标 —— 它证明「笔记后来被打开了」，证明不了「被用进了回答」。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 0, description: '只看最近几天（0 = 账本里的全部，默认 0）。' },
        top: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_USAGE_TOP,
          description: `列出被真正打开过最多的几篇笔记，默认 ${DEFAULT_USAGE_TOP}。`,
        },
      },
    },
  },
];

export const RESOURCE_TEMPLATE = {
  uriTemplate: 'engramory://note/{file}',
  name: '一篇笔记',
  description: '把 {file} 换成 <store> 下的文件名。',
  mimeType: 'text/markdown',
};

/**
 * 库的入口地图：索引（MEMORY.md）本身是一等资源。它是宿主「先看一眼有没有相关的」
 * 的那张地图，跟「库里某一篇笔记」不是一回事 —— 所以给它一个固定的、可枚举的 URI，
 * 而不是藏在 note 模板里让调用方去猜文件名。
 */
export const INDEX_URI = 'engramory://index';
export const INDEX_RESOURCE = {
  uri: INDEX_URI,
  name: '记忆索引',
  title: '记忆索引（MEMORY.md）',
  mimeType: 'text/markdown',
  description: 'MEMORY.md 全文：库的入口地图，一行一条指针，先读它再决定打开哪几篇笔记。',
};

export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '~') return homedir();
  return text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
}

/** 读侧上限也可以走环境变量：写错（0/NaN/负数）时退回默认 —— 配置错误不该把库读空。 */
function capFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** 把 session 上的两条上限整理成 store.js 认的形状。 */
function capsOf(session) {
  return { maxNotes: session.maxNotes, maxBytes: session.maxBytes };
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
    // 读侧上限：召回一次最多读多少篇 / 多少字节。默认与 DSH 插件一致（2000 篇 / 4MB），
    // 可用 ENGRAMORY_MAX_NOTES / ENGRAMORY_MAX_BYTES 调 —— MCP 侧读不到 DSH 的配置，
    // 所以「两处上限不一致」只能靠这两条环境变量对齐；status 会把实际值印出来。
    maxNotes: Number(options.maxNotes) > 0 ? Math.floor(Number(options.maxNotes)) : capFromEnv('ENGRAMORY_MAX_NOTES', DEFAULT_MAX_NOTES),
    maxBytes: Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : capFromEnv('ENGRAMORY_MAX_BYTES', DEFAULT_MAX_BYTES),
    semanticTimeoutMs: Number(options.semanticTimeoutMs) || 2000,
    index: null,
    fingerprint: '',
  };
}

/** 索引按语料指纹缓存：库被改过就重建，没改过就复用（readDocs 自己也有 mtime 缓存）。 */
function indexFor(session) {
  const docs = readDocs(session.store, capsOf(session));
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
  for (const doc of readDocs(session.store, capsOf(session))) {
    const existing = notes.get(doc.id);
    if (!existing) notes.set(doc.id, { file: doc.id, title: doc.title || doc.id, description: doc.description || '' });
    else if (!existing.description && doc.description) existing.description = doc.description;
  }
  return [...notes.values()];
}

/**
 * `type:` 只活在笔记的 frontmatter 里，而 `store.js` 的 readDocs() 已经把 frontmatter
 * 摘掉了（它只挑 name/description/aliases 三个字段），所以「这篇是 user 还是 project」
 * 只能从原文的头部认。**不碰 store.js**，所以这里自己截一段头部来读。
 * 缓存按 mtimeMs 失效：只留最近一次的那个库（一次 stdio 会话只读一个库）。
 */
let listMetaCache = { store: '', docs: new Map() };

function noteTypeOf(session, doc) {
  if (listMetaCache.store !== session.store) listMetaCache = { store: session.store, docs: new Map() };
  const cached = listMetaCache.docs.get(doc.id);
  if (cached && cached.mtimeMs === doc.mtimeMs) return cached.type;
  let text = '';
  try {
    text = readFileSync(join(session.store, doc.id), 'utf8');
  } catch {
    /* 读不到的按「没写 type」算：清单里照样列出来，只是类型显示「—」。 */
  }
  const head = text.replace(/^\uFEFF/, '');
  const end = head.indexOf('\n---', 3);
  const frontmatter = head.startsWith('---') && end > 0 ? head.slice(0, end) : '';
  const match = frontmatter.match(/^type[ \t]*:[ \t]*(.+)$/m);
  const type = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  listMetaCache.docs.set(doc.id, { mtimeMs: doc.mtimeMs, type });
  return type;
}

/**
 * 清单的去重口径：长笔记在索引里会被切成多个桶（同一个 id 重复出现），
 * 而清单是给「库里有什么」看的 —— 一篇就是一条，保留第一条。
 */
function listNotes(session) {
  const notes = new Map();
  for (const doc of readDocs(session.store, capsOf(session))) {
    if (notes.has(doc.id)) continue;
    notes.set(doc.id, {
      file: doc.id,
      description: String(doc.description ?? '').replace(/\s+/g, ' ').trim(),
      chars: Number(doc.chars) || 0,
      mtimeMs: Number(doc.mtimeMs) || 0,
      type: noteTypeOf(session, doc),
    });
  }
  return [...notes.values()];
}

/** 描述截到 ~60 字（按码点切，别把 emoji 劈成两半）。 */
function truncate(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 可选的整数参数：没给 / 给了但不是数 → 用默认值；给了数就夹到 [min, max]。 */
function optionalInt(value, { fallback, min, max }) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
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
  const docs = readDocs(session.store, capsOf(session));
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
  // 读侧上限账：超出了就必须说出来 —— 以前这两条上限是静默的，用户只看到「召回变差」，
  // 看不到「有 N 篇根本没进检索」。这也是 MCP 侧唯一能报的地方。
  const report = readDocsReport(session.store, capsOf(session));
  const dropped = report.stats.droppedByCount + report.stats.droppedByBytes + report.stats.droppedBySize;
  const capLine = dropped > 0
    ? `读侧上限：一次召回只读前 ${session.maxNotes} 篇 / ${Math.round(session.maxBytes / 1024)} KB —— 这个库超出了，`
      + `${dropped} 篇不会被检索到（按条数丢 ${report.stats.droppedByCount} · 按字节丢 ${report.stats.droppedByBytes} · 单篇过大丢 ${report.stats.droppedBySize}）`
    : `读侧上限：一次召回最多 ${session.maxNotes} 篇 / ${Math.round(session.maxBytes / 1024)} KB（当前读到 ${report.stats.read} 篇，没到顶）`;
  return [
    `库：${session.store}`,
    // 库里有多少篇 ≠ 这次读到多少篇（读侧上限可能把后面截掉）：两个数都印，别让人把「读到」当「库里有」。
    `笔记：库里 ${report.stats.found} 篇${report.stats.read < report.stats.found ? ` · 这次读到 ${report.stats.read} 篇` : ''}`,
    capLine,
    indexLine,
    `指纹：${corpusFingerprint(readDocs(session.store, capsOf(session))).slice(0, 12) || '（空库）'}`,
    `服务器：${SERVER_NAME} ${SERVER_VERSION} · 只读 · 零模型调用`,
  ].join('\n');
}

const LIST_KINDS = ['user', 'feedback', 'project', 'reference'];

/**
 * 「库里有什么」——给陌生宿主的入口地图。刻意不做检索：检索的前提是知道该搜什么词，
 * 而这一步的用处正是让模型先知道库里有什么，再决定搜索词。
 */
function toolList(session, args) {
  const rawKind = args?.kind;
  const kind = rawKind === undefined || rawKind === null || rawKind === '' ? '' : String(rawKind).trim();
  if (kind && !LIST_KINDS.includes(kind)) {
    throw new McpError(`kind 只认 ${LIST_KINDS.join(' / ')} 之一，收到的是：${kind}。不给就是全部。`);
  }
  const limit = optionalInt(args?.limit, { fallback: DEFAULT_LIST_LIMIT, min: 1, max: MAX_LIST_LIMIT });
  const all = listNotes(session);
  if (!all.length) {
    throw new McpError(`库是空的或不存在：${session.store}。用 --store <路径> 或环境变量 ENGRAMORY_STORE 指定。`);
  }
  const typed = kind ? all.filter((note) => note.type === kind) : all;
  // 按「改得最新」排，mtime 相同再按文件名 —— 排序必须确定，否则同一份库两次列出顺序不同。
  const sorted = [...typed].sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.file.localeCompare(b.file));
  const shown = sorted.slice(0, limit);
  const header = kind
    ? `库：${session.store} · 类型：${kind}（全部 ${all.length} 篇里有 ${typed.length} 篇）`
    : `库：${session.store} · 共 ${all.length} 篇`;
  const lines = shown.map((note) => {
    const description = note.description ? truncate(note.description, LIST_DESCRIPTION_CHARS) : '（没有描述）';
    return `${note.file} · ${note.type || '—'} · ${description} · ${note.chars} 字符`;
  });
  const tail = `共 ${typed.length} 篇${kind ? `（类型 ${kind}）` : ''}，这里列了前 ${shown.length} 篇。`;
  const footer = kind || shown.length === typed.length
    ? tail
    : `${tail}还有 ${typed.length - shown.length} 篇没列出来（用 limit 调大，上限 ${MAX_LIST_LIMIT}，或按 kind 过滤）。`;
  // 说明行本身也是内容：limit 是调用方自己给的，被夹过就得说清楚按什么算的。
  const asked = Number(args?.limit);
  const clampNote = Number.isFinite(asked) && asked !== shown.length && (asked > MAX_LIST_LIMIT || asked < 1)
    ? `（limit 收到 ${Math.trunc(asked)}，按 ${limit} 算）`
    : '';
  const body = [header, ...lines, footer + clampNote].join('\n');
  if (body.length > MAX_OUTPUT_CHARS) {
    return `${body.slice(0, MAX_OUTPUT_CHARS)}\n\n…（清单超过 ${MAX_OUTPUT_CHARS} 字符，这里截断了；把它调小或加 kind 过滤）`;
  }
  return body;
}

const usageDate = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * 只读地念一遍召回账本。**不重新实现任何统计口径**：读盘用 usage.js 的 readUsage()，
 * 统计用它的 summarizeUsage() —— 面板、尺子、这里必须是同一套数字，否则两边对不上时
 * 没人知道该信哪个。这个函数只做两件事：按时间窗筛行、把已有字段组织成人话。
 */
function toolUsage(session, args) {
  const days = optionalInt(args?.days, { fallback: 0, min: 0, max: 3650 });
  const top = optionalInt(args?.top, { fallback: DEFAULT_USAGE_TOP, min: 1, max: MAX_USAGE_TOP });
  const ledger = join(session.store, USAGE_FILE);
  if (!existsSync(ledger)) {
    // 缺数据 ≠ 0：印一堆 0 会让人以为「跑过但没打开任何笔记」，而事实是还没开始记。
    return `还没有账本：${ledger} 不存在。\n`
      + '账本由 DSH 那侧的插件在注入记忆时写（一行一条 JSONL）；这个服务器只读，不会替你创建它。';
  }
  const lines = readUsage(session.store, 2000);
  if (!lines.length) return `账本还是空的：${ledger} 存在，但没有一行记录。`;
  // 窗口口径就地做（usage.js 没有现成的 days 过滤）：先按 ts 筛，再喂给 summarizeUsage，
  // 免得统计里混进窗口外的行。
  const now = Date.now();
  const cutoff = days > 0 ? now - days * 86400000 : 0;
  const windowed = cutoff ? lines.filter((line) => Number(line?.ts ?? 0) >= cutoff) : lines;
  if (cutoff && !windowed.length) {
    return `最近 ${days} 天没有账本记录（${ledger} 共 ${lines.length} 行，最早一行在 ${usageDate(Number(lines.at(-1)?.ts) || now)}）。`;
  }
  const summary = summarizeUsage(windowed, { positions: 5, neverOpenedLimit: 5 });
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const scope = (key) => summary.scopes?.[key] ?? { injectRounds: 0, pointers: 0, used: 0 };
  const scopeLine = [['main', '主对话'], ['subagent', '子代理'], ['unknown', '未知']]
    .map(([key, label]) => [label, scope(key)])
    .filter(([, s]) => s.pointers > 0)
    .map(([label, s]) => `${label} ${s.injectRounds} 轮 / ${s.pointers} 条 / 打开 ${s.used} 条`);
  const budget = summary.budgetUse ?? { n: 0, median: 0, full: 0 };
  const budgetText = budget.n
    ? `预算（maxChars）：${summary.budgetRounds} 轮记了用量，中位用掉 ${Math.round(budget.median * 100)}%、顶格（≥95%）${budget.full} 轮`
    : `预算（maxChars）：${summary.budgetRounds} 轮都没有用量字段（0.13.13 之前的行）—— 缺数据，不是用掉 0`;
  // summarizeUsage 的 notes 是按「注入次数」排的，而这里要的是「被打开最多的几篇」——
  // 自己再排一次（排完仍要标清 opened 是«被打开过的轮数»：同一轮里读三次只算一次）。
  const ranked = summary.notes
    .filter((note) => note.opened > 0)
    .sort((a, b) => (b.opened - a.opened) || (b.injected - a.injected) || (b.lastAt - a.lastAt))
    .slice(0, top);
  const topText = ranked.length
    ? ranked.map((note, i) => `${i + 1}. ${note.id} —— 被打开过 ${note.opened} 轮 / 注入过 ${note.injected} 轮`).join('\n')
    : '（还没有任何一篇被打开过）';
  const windowText = days > 0 ? `最近 ${days} 天窗口` : '全部';
  const clampNote = days > 3650 ? `（days 收到 ${Math.trunc(Number(args.days))}，按 3650 天算）` : '';
  return [
    `账本：${ledger}（${windowText}${clampNote}：${windowed.length} 行，覆盖 ${usageDate(summary.firstAt || now)} → ${usageDate(summary.lastAt || now)}）`,
    `轮次：${summary.injectRounds} 轮注入了指针，共 ${summary.pointers} 条`,
    `被打开：usedCounted（同一轮里读三次只算一次）${summary.usedCounted} 条 / 打开率 ${pct(summary.openRate)}`
      + ` —— 原始 used 行数 ${summary.used} 条，两者口径不同`,
    `一个字都没进：${summary.zeroRounds} 轮（注入过 0 条）；另有去重跳过 ${summary.skipRounds} 轮、沉淀 ${summary.sedimentRounds} 轮`,
    `按来源：${scopeLine.length ? scopeLine.join(' ｜ ') : '账本里没有带来源的行'}`,
    budgetText,
    `被真正打开最多的 ${top} 篇：`,
    topText,
    '这是代理指标：它证明「笔记后来被打开了」，证明不了「被用进了回答」——判断一套召回管不管用，还得看打开率之外的位置曲线与来源拆分。',
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
  engramory_list: toolList,
  engramory_usage: toolUsage,
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
    resources: [
      // 索引排在最前：它是「先看这个」的那一个。注意 notesOf() 从来不含 MEMORY.md
      // （store.js 只把非索引的 .md 当笔记），所以这里不会出现两条索引。
      INDEX_RESOURCE,
      ...notesOf(session).map((note) => ({
        uri: `engramory://note/${note.file}`,
        name: note.file,
        title: note.title,
        description: note.description || undefined,
        mimeType: 'text/markdown',
      })),
    ],
  };
}

export function readResource(session, params) {
  const uri = String(params?.uri ?? '');
  if (uri === INDEX_URI) {
    // 固定文件名 + 固定库路径：这里没有调用方给的路径成分，拼接是安全的。
    const full = join(session.store, 'MEMORY.md');
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      throw new McpError(`读不到索引：${full}。用 engramory_status 确认库的位置，或先用 engramory_list 看库里有什么。`);
    }
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  const prefix = 'engramory://note/';
  if (!uri.startsWith(prefix)) throw new McpError(`只认得 ${prefix}<文件名> 与 ${INDEX_URI} 这两种 URI，收到的是：${uri}`);
  const file = decodeURIComponent(uri.slice(prefix.length));
  return { contents: [{ uri, mimeType: 'text/markdown', text: readNote(session, file) }] };
}

/**
 * 提示（prompts）是 MCP 的第三个「面」：工具是「模型能做什么」，资源是「宿主能读什么」，
 * 提示是**用户在客户端里点一下就能把一段工作流交给模型**。这两个都是只读工作流 ——
 * 它们只组织「先搜、再读、最后回答」或「整理成草稿」，写文件那一步永远留给用户。
 */
export const PROMPTS = [
  {
    name: 'recall',
    description: '先搜记忆库、再打开最相关的一篇，带着它回答当前问题（只读，不写任何文件）。',
    arguments: [
      { name: 'query', description: '要回答的问题或要查的事，用你自己的话写就行。', required: true },
    ],
  },
  {
    name: 'curate',
    description: '把本次会话里值得长期记住的 settled 事实整理成一篇 Format v1 草稿，交给你确认后自己写文件（服务器不写）。',
    arguments: [],
  },
];

const NONE_READONLY =
  '这一次是**只读**的：不要写文件、不要创建库或索引、不要改账本。'
  + '你只能读 —— 任何落盘的动作都由人在确认之后自己做。';

function recallText(query) {
  return [
    `请先查我的记忆库，再回答这个问题：${query}`,
    '',
    '1. 调 engramory_search（query 就用上面这句，可以拆成更准的几个词试第二次）；',
    '2. 从返回的文件名里挑最相关的一篇，用 engramory_read 打开它（别只信片段）；',
    '3. 如果那一篇只是提到了线索，可以再沿它指的名字多读一篇；最多读三篇就停；',
    '4. 最后回答我：答案 + 你用的是哪一篇笔记（写文件名）。',
    '',
    '如果搜不到相关笔记，直接说「库里没有相关的」，不要编造库里的内容。',
    NONE_READONLY,
  ].join('\n');
}

function curateText() {
  return [
    '请把本次会话里值得长期记住的 settled 事实整理成待确认的笔记草稿。',
    '',
    '只记已经定下来的：决策与这么定的理由、踩过的坑与解法、我的偏好与纠正、外部资料的指路。'
    + '别记当前状态（版本号、tip commit、测试通过数这类会腐烂的东西 —— 要记就记「去哪里读」），'
    + '也别记临时结论。没有值得记的就直说没有，不要硬凑。',
    '',
    '每一条按 Format v1 写成草稿给我看：',
    '- frontmatter: `type: user|feedback|project|reference`、`name`（也就是文件名，小写连字符）、`description`（一行、≤60 字）；',
    '- 正文：一个主题一篇，写清楚「是什么 / 为什么」。',
    '',
    '写进库之前必须让我确认：**你来写文件** —— '
    + '这个 MCP 服务器是只读的，不会替你创建或修改任何文件，也不会改库里的索引。',
  ].join('\n');
}

/** prompts/get 的参数只需要「有没有值」：缺了 give 的名字就直接说清楚缺什么。 */
function requireArg(args, name) {
  const raw = args?.[name];
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new McpError(`${name} 必须是字符串：收到的是 ${typeof raw}。`);
  }
  const value = String(raw ?? '').trim();
  // 'undefined' / 'null' 是客户端把参数序列化成字符串后最常见的坑，按「没给」算。
  const usable = value && value !== 'undefined' && value !== 'null' ? value : '';
  if (!usable) throw new McpError(`${name} 不能为空：这个提示词必须先知道你要查什么。`);
  return usable;
}

export function getPrompt(params) {
  const name = String(params?.name ?? '');
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (name === 'recall') {
    const query = requireArg(args, 'query');
    return {
      description: PROMPTS[0].description,
      messages: [{ role: 'user', content: { type: 'text', text: recallText(query) } }],
    };
  }
  if (name === 'curate') {
    return {
      description: PROMPTS[1].description,
      messages: [{ role: 'user', content: { type: 'text', text: curateText() } }],
    };
  }
  throw new McpError(`没有这个提示：${name || '(空)'}。可用：${PROMPTS.map((p) => p.name).join(' / ')}`);
}

function initializeResult(params) {
  const asked = String(params?.protocolVersion ?? '');
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'Engramory 记忆召回（本地 markdown，只读）' },
    instructions:
      '这是本机 markdown 记忆库的只读检索。先用 engramory_search 找相关笔记，再用 engramory_read 打开需要的那些；' +
      '不知道库里有什么时先看 engramory_list，想确认客户端读的是哪个库就调 engramory_status。' +
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
        return reply({ prompts: PROMPTS });
      case 'prompts/get':
        // 未知名字 / 缺必填参数都会抛 McpError，走下面的 -32603（与工具错误同一套人话文本）。
        return reply(getPrompt(message.params));
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
  · 工具：engramory_search / engramory_read / engramory_status / engramory_list / engramory_usage
  · 资源：engramory://index（MEMORY.md 全文）与 engramory://note/{file}
  · 提示：recall（先搜再读后回答）/ curate（整理成 Format v1 草稿，交用户确认）
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
