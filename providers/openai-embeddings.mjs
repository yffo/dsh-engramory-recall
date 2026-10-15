/**
 * 参考提供方：OpenAI 兼容的 embeddings 接口（零依赖、可选、密钥只从环境变量进）。
 *
 * 它存在的意义是把「语义接缝」从「你自己写一个」变成「填三个环境变量就能试」：
 *
 * ```jsonc
 * // DSH 插件配置
 * {
 *   "semanticProvider": "dsh-engramory-recall/providers/openai-embeddings",
 *   "semanticTimeoutMs": 15000,
 *   "semanticPool": 50,
 *   "semanticFusion": "rrf"
 * }
 * ```
 *
 * 配置来源（优先级：环境变量 > 配置文件 > 内置默认），密钥**不进仓库、不进日志**：
 * · `~/.config/engramory/embed.json`（可用 `ENGRAMORY_EMBED_CONFIG` 换路径）：
 *   `{"apiKey": "…", "baseUrl": "…", "model": "…"}` —— 推荐这条：macOS 上 GUI 启动的应用
 *   读不到 `~/.zshrc` 里的环境变量，一个 0600 的小文件最省事：
 *   `mkdir -p ~/.config/engramory && printf '{"apiKey":"sk-…"}' > ~/.config/engramory/embed.json && chmod 600 ~/.config/engramory/embed.json`
 * · `ENGRAMORY_EMBED_API_KEY`        或 `ENGRAMORY_EMBED_API_KEY_FILE` 指一个只放密钥的文件
 * · `ENGRAMORY_EMBED_BASE_URL`       默认 `https://api.openai.com/v1`（base 里带 `/v1`）
 * · `ENGRAMORY_EMBED_MODEL`          默认 `text-embedding-3-small`
 * · `ENGRAMORY_EMBED_BATCH`          默认 32（一次请求塞多少条）
 * · `ENGRAMORY_EMBED_MAX_CHARS`      每篇笔记送多少字，默认 1200
 * · `ENGRAMORY_EMBED_QUERY_PREFIX` / `ENGRAMORY_EMBED_DOC_PREFIX`
 *                                    有些模型要指令前缀（如 `query: ` / `passage: `），默认空
 *
 * 换一家提供商就是换 `BASE_URL` + `MODEL`（阿里百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1`
 * + `text-embedding-v4`、智谱 `https://open.bigmodel.cn/api/paas/v4` + `embedding-3`、硅基流动
 * `https://api.siliconflow.cn/v1` + `BAAI/bge-m3` 等）。注意：**embeddings 只有 OpenAI 这一种
 * 接口形状**，Anthropic 没有 embedding 接口，所谓「Claude 协议」在这里用不上。
 *
 * 自检（不打印密钥）：
 * ```bash
 * node providers/openai-embeddings.mjs --check          # 探一次接口，报维度与耗时
 * node providers/openai-embeddings.mjs --check --json
 * ```
 *
 * 纪律：接口失败一律 **throw**（接缝会降级回词面结果并如实报 `provider-error`），
 * 绝不返回一个「凑合」的顺序；错误信息里绝不含密钥。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'openai-embeddings';

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
  batch: 32,
  maxChars: 1200,
  queryPrefix: '',
  docPrefix: '',
};

/** 默认配置文件位置（可用 ENGRAMORY_EMBED_CONFIG 换）。 */
export const DEFAULT_CONFIG_PATH = '~/.config/engramory/embed.json';

/** 可重试的状态码：限流与网关/服务端临时故障。真端点第一次限流就失败的话，接缝等于不能用。 */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRY_LIMIT = 2; // 首次 + 2 次重试
const RETRY_BASE_MS = 250;

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~') return homedir();
  return text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
}

/** 读小配置文件；不存在就当空（这是正常状态，不是错误）；坏 JSON 要说清楚。 */
export function readConfigFile(env = process.env) {
  const full = expandHome(env.ENGRAMORY_EMBED_CONFIG || DEFAULT_CONFIG_PATH);
  if (!full) return { path: '', data: {} };
  try {
    const text = readFileSync(full, 'utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('顶层必须是一个对象');
    return { path: full, data };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: full, data: {} };
    throw new Error(`配置文件 ${full} 读不了：${error?.message ?? error}`);
  }
}

/** 进程内缓存：同一篇笔记在不同查询里不必重复付费（键含模型与前缀，换模型自动失效）。 */
const CACHE_LIMIT = 5000;
const cache = new Map();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从环境变量读配置（导出是为了自检与测试能显式传 env，不读进程全局）。 */
export function readConfig(env = process.env) {
  const { path: configPath, data } = readConfigFile(env);
  // trim=false 是给指令前缀用的：`query: ` 末尾那个空格是模型约定的一部分，不能被吃掉
  const pick = (envName, fileKey, fallback, { trim = true } = {}) => {
    const clean = (value) => (trim ? String(value).trim() : String(value));
    const fromEnv = String(env[envName] ?? '');
    if (fromEnv.trim()) return clean(fromEnv);
    const fromFile = data[fileKey] ?? data[envName];
    if (fromFile !== undefined && fromFile !== null && String(fromFile).trim()) return clean(fromFile);
    return fallback;
  };
  const base = String(pick('ENGRAMORY_EMBED_BASE_URL', 'baseUrl', DEFAULTS.baseUrl)).replace(/\/+$/, '');
  return {
    configPath,
    baseUrl: base || DEFAULTS.baseUrl,
    model: pick('ENGRAMORY_EMBED_MODEL', 'model', DEFAULTS.model) || DEFAULTS.model,
    batch: Math.min(128, Math.max(1, num(pick('ENGRAMORY_EMBED_BATCH', 'batch', DEFAULTS.batch), DEFAULTS.batch))),
    maxChars: Math.max(64, num(pick('ENGRAMORY_EMBED_MAX_CHARS', 'maxChars', DEFAULTS.maxChars), DEFAULTS.maxChars)),
    queryPrefix: pick('ENGRAMORY_EMBED_QUERY_PREFIX', 'queryPrefix', DEFAULTS.queryPrefix, { trim: false }),
    docPrefix: pick('ENGRAMORY_EMBED_DOC_PREFIX', 'docPrefix', DEFAULTS.docPrefix, { trim: false }),
    apiKey: readKey(env, data),
    keySource: keySource(env, data),
  };
}

function keySource(env, data) {
  if (String(env.ENGRAMORY_EMBED_API_KEY ?? '').trim()) return 'ENGRAMORY_EMBED_API_KEY';
  if (String(env.ENGRAMORY_EMBED_API_KEY_FILE ?? '').trim()) return 'ENGRAMORY_EMBED_API_KEY_FILE';
  if (String(data?.apiKey ?? '').trim()) return `配置文件 ${expandHome(env.ENGRAMORY_EMBED_CONFIG || DEFAULT_CONFIG_PATH)}`;
  return '';
}

function readKey(env, data = {}) {
  const inline = String(env.ENGRAMORY_EMBED_API_KEY ?? '').trim();
  if (inline) return inline;
  const file = String(env.ENGRAMORY_EMBED_API_KEY_FILE ?? '').trim();
  if (file) {
    try {
      return readFileSync(expandHome(file), 'utf8').trim();
    } catch (error) {
      throw new Error(`读不到密钥文件 ${file}（${error?.code ?? error?.message}）`);
    }
  }
  return String(data?.apiKey ?? '').trim();
}

function endpoint(baseUrl) {
  return /\/embeddings$/.test(baseUrl) ? baseUrl : `${baseUrl}/embeddings`;
}

function textOf(doc, cfg) {
  const raw = [doc?.snippet, doc?.title].filter(Boolean).join('\n') || String(doc?.id ?? '');
  return (cfg.docPrefix + raw.replace(/\s+/g, ' ').trim()).slice(0, cfg.maxChars);
}

async function embedBatch(cfg, texts, signal) {
  let response;
  let body = '';
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    body = await response.text();
    if (response.ok || !RETRY_STATUS.has(response.status) || attempt >= RETRY_LIMIT) break;
    await sleep(retryDelayMs(response, attempt), signal);
  }
  if (!response.ok) {
    // 状态码 + 服务端原话（截断）：密钥绝不进消息。重试过的话说明这是重试后的终态。
    const tried = RETRY_STATUS.has(response.status) ? `（已重试 ${RETRY_LIMIT} 次）` : '';
    throw new Error(`embeddings HTTP ${response.status}${tried}：${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`embeddings 返回的不是 JSON：${body.slice(0, 120)}`);
  }
  const rows = parsed?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error(`embeddings 返回的数据条数不对：想 ${texts.length} 条，拿到 ${Array.isArray(rows) ? rows.length : '非数组'}`);
  }
  return rows
    .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((row) => {
      const vector = row?.embedding;
      if (!Array.isArray(vector) || !vector.length) throw new Error('embeddings 返回了空向量');
      return vector;
    });
}

/** 批量取向量，带进程内缓存。文本相同（含前缀与模型）就不重复请求。 */
export async function embedTexts(cfg, texts, signal) {
  const out = new Array(texts.length);
  const todo = [];
  texts.forEach((text, index) => {
    const key = `${cfg.model}\u0000${text}`;
    if (cache.has(key)) out[index] = cache.get(key);
    else todo.push({ index, text, key });
  });
  for (let start = 0; start < todo.length; start += cfg.batch) {
    const slice = todo.slice(start, start + cfg.batch);
    const vectors = await embedBatch(cfg, slice.map((item) => item.text), signal);
    slice.forEach((item, offset) => {
      const vector = vectors[offset];
      out[item.index] = vector;
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(item.key, vector);
    });
  }
  return out;
}

/** 等服务端让等的时间：优先 `Retry-After`（秒数或 HTTP 日期），否则指数退避。上限 5 秒。 */
function retryDelayMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.min(5000, Math.max(0, when - Date.now()));
  }
  return Math.min(5000, RETRY_BASE_MS * 2 ** attempt);
}

/** 可被 AbortSignal 打断的等待：接缝有超时预算，重试不许把预算吃光。 */
function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 接缝的 `rerank` 接口：给候选池，按余弦相似度排序。
 * 返回**全部**候选（不是只给 limit 条）—— 融合方式（rrf / trust）由接缝决定，不由提供方越权决定。
 */
/** 用一份**显式配置**跑重排（密钥来自调用方，而不是环境变量）—— `host-embed` 复用宿主凭据时走这条路。 */
export async function rerankWith(cfg, { query, docs, signal } = {}) {
  if (!cfg?.apiKey) {
    throw new Error('没配密钥：设置 ENGRAMORY_EMBED_API_KEY（或 ENGRAMORY_EMBED_API_KEY_FILE）后重试');
  }
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return [];
  const vectors = await embedTexts(cfg, [cfg.queryPrefix + String(query ?? ''), ...list.map((doc) => textOf(doc, cfg))], signal);
  const queryVector = vectors[0];
  return list
    .map((doc, index) => ({ id: doc.id, score: cosine(queryVector, vectors[index + 1]) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/** 默认配置（env + 配置文件）下的提供方，供 `provider: '<包名>/providers/openai-embeddings'` 直接使用。 */
export async function rerank(args) {
  return rerankWith(readConfig(), args);
}

/**
 * 用显式配置造一个提供方对象（`host-embed` 与 `--check` 之外的集成都用它）。
 * overrides 里常见：`baseUrl` / `model` / `apiKey` / `batch` / `maxChars` / `queryPrefix` / `docPrefix`。
 */
export function createProvider(overrides = {}) {
  const cfg = { ...readConfig(), ...overrides };
  return {
    name: overrides.providerName ?? `${name}(${cfg.model})`,
    kind: 'rerank',
    config: cfg,
    rerank: (args) => rerankWith(cfg, args),
  };
}

/** 自检：探一次接口，报配置（不含密钥）、维度与耗时。 */
export async function check(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.apiKey) {
    throw new Error(`没配密钥：设置 ENGRAMORY_EMBED_API_KEY，或写一份 ${cfg.configPath}（{"apiKey":"…"}，chmod 600）`);
  }
  const started = Date.now();
  const vectors = await embedTexts(cfg, ['engramory 自检：这一段会被送进 embeddings 接口。'], undefined);
  return {
    ok: true,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keySource: cfg.keySource,
    configPath: cfg.configPath,
    dimensions: vectors[0].length,
    ms: Date.now() - started,
  };
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain || process.argv.includes('--check')) {
  if (!process.argv.includes('--check')) {
    console.log('用法：node providers/openai-embeddings.mjs --check [--json]');
  } else {
    try {
      const result = await check();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`✓ embeddings 可用：${result.model} @ ${result.baseUrl}`);
        console.log(`  密钥来源：${result.keySource} · 维度：${result.dimensions} · 耗时：${result.ms}ms`);
      }
    } catch (error) {
      console.error(`✗ ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}
