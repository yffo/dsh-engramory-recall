/**
 * 可选的「语义检索」接缝（seam）。
 *
 * 立场先说清楚：本插件的默认路径是纯词面检索，**一个模型调用都不发**。
 * 这个文件不改变那条基线，它只是给「用户自己愿意挂一个语义/重排提供方」留一个口子，
 * 三条纪律把口子的边界钉死：
 *
 * 1. **默认关闭**：`provider` 为空时，这里连 `import()` 都不会执行；
 * 2. **不 import 任何宿主包**：提供方只能是「本地模块路径」（用户在配置里写），
 *    或者内置的 `host-llm` —— 后者也走 `llm.js` 的动态 import，静态依赖图里没有它；
 * 3. **挂掉的提供方不许影响检索**：超时、抛错、返回垃圾形状、编造不存在的文件名，
 *    一律降级回词面结果，并把原因如实放进返回值（`code` / `message`）。
 *
 * 提供方模块的两种接口（导出哪个就用哪个，两个都导出优先用 `rerank`）：
 *
 * ```js
 * // 1) 重排：给我候选，还我一个顺序
 * export async function rerank({ query, docs, limit, signal }) {
 *   return [{ id: 'some-note.md', score: 0.9 }, ...];
 * }
 *
 * // 2) 扩展：把问题改写成几句别的说法，由我分别检索（**只用于补空位**）
 * export async function expand({ query, signal }) {
 *   return ['另一种说法', '关键词组合'];
 * }
 * ```
 *
 * 两种接口的边界**不一样**，这是量出来的、不是拍出来的：
 * · `rerank` 声称自己有打分器 ⇒ 结果与词面走 RRF 融合，**允许改顺序**（同 limit 下不增不减）；
 * · `expand` 只是「换个说法再查一遍」⇒ **只补空位，永不改动词面顺序**。
 *   实测（2026-10-15，真库探针 36 条 + 合成 70 条，改写由宿主模型逐条产生）：
 *   RRF 融合让 3 条改写以 1:1 的票数盖过原查询的 1 票，真库 hit@1 26/36 → 19/36、
 *   hit@4 36/36 → 30/36；把原查询加权到 3 票 / 5 票、或改成归一化打分，全都仍不如基线；
 *   只有「只补空位」「池子合并（原查询打分优先）」「命中不足才用」三种保守规则能逐字打平基线。
 *   结论：改写能扩候选，改不了排序，那就别让它碰排序。详见 README「宿主模型改写实测」。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { search as lexicalSearch } from './bm25.js';

/** RRF 的平滑常数：教科书取值 60，小语料上够用。 */
export const RRF_K = 60;
export const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_EXPANSIONS = 8;
export const MAX_EXPANSION_CHARS = 120;
export const HOST_LLM = 'host-llm';

/** 配置里能写的提供方：空 = 关闭；`host-llm` = 走宿主模型（llm.js）；其余当本地模块路径。 */
export function describeSeam(config = {}) {
  const spec = String(config.provider ?? '').trim();
  if (!spec) return { enabled: false, kind: 'off', spec: '', message: '语义接缝未启用（默认）' };
  if (spec === HOST_LLM) {
    return { enabled: true, kind: 'host-llm', spec, message: '语义接缝指向宿主模型（llm.js，动态 import）' };
  }
  return { enabled: true, kind: 'module', spec, message: `语义接缝指向本地模块：${spec}` };
}

function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

export function resolveProviderPath(spec, baseDir = process.cwd()) {
  const text = expandHome(String(spec ?? '').trim());
  if (!text) return '';
  return isAbsolute(text) ? text : resolve(baseDir, text);
}

/** 加载提供方。任何失败都返回 `{ ok: false }` —— 调用方负责降级，这里绝不抛。 */
export async function loadProvider(config = {}, deps = {}) {
  const seam = describeSeam(config);
  if (!seam.enabled) return { ok: false, code: 'off', message: seam.message, seam };
  try {
    if (seam.kind === 'host-llm') {
      const runtime = deps.runtime;
      if (!runtime) return { ok: false, code: 'no-host', message: 'host-llm 提供方需要宿主运行时（runtime）', seam };
      const module = await import('./llm.js');
      const route = module.resolveRoute(runtime.ctx, runtime.config);
      if (!route) return { ok: false, code: 'no-route', message: '宿主没有可用的默认模型，语义接缝降级', seam };
      const provider = {
        name: HOST_LLM,
        kind: 'expand',
        expand: ({ query, signal }) => hostLlmExpand(module, route, query, config, signal),
      };
      return { ok: true, provider, kind: 'expand', code: 'host-llm', message: seam.message, seam };
    }

    const full = resolveProviderPath(seam.spec, deps.baseDir);
    if (!full) return { ok: false, code: 'empty-path', message: '提供方路径是空的', seam };
    try {
      readFileSync(full);
    } catch (error) {
      return { ok: false, code: 'not-found', message: `读不到提供方模块：${full}（${error?.code ?? error?.message}）`, seam, path: full };
    }
    const module = await import(pathToFileURL(full).href);
    const provider = normalizeModule(module, full);
    if (!provider) {
      return {
        ok: false,
        code: 'unsupported',
        message: `提供方模块必须导出 rerank 或 expand 函数：${full}`,
        seam,
        path: full,
      };
    }
    return { ok: true, provider, kind: provider.kind, code: 'module', message: seam.message, seam, path: full };
  } catch (error) {
    return { ok: false, code: 'load-error', message: `加载提供方失败：${error?.message ?? error}`, seam };
  }
}

function normalizeModule(module, source) {
  const rerank = module?.rerank;
  const expand = module?.expand;
  if (typeof rerank === 'function') {
    return { name: String(module.name ?? source.split('/').pop()), kind: 'rerank', rerank, source };
  }
  if (typeof expand === 'function') {
    return { name: String(module.name ?? source.split('/').pop()), kind: 'expand', expand, source };
  }
  return null;
}

/**
 * 宿主模型改写的提示词。**导出**是给 `bench/host-rewrite.mjs` 用的：
 * 那把尺子得用同一句话去问真宿主模型，否则量出来的不是产品行为。
 */
export function hostLlmPrompt(query) {
  return [
    '把用户的问题改写成 3 条更可能命中本地记忆库的检索短句（同义词、术语、英文对照都可以）。',
    '只输出 JSON 数组，元素是字符串，不要解释、不要编号。',
    `问题：${query}`,
  ].join('\n');
}

/** 宿主模型的「扩展」实现：问模型要几句别的说法，别的什么都不做。 */
async function hostLlmExpand(module, route, query, config, signal) {
  const prompt = hostLlmPrompt(query);
  const result = await module.collectText(
    { stream: (options) => route.llm.stream(options) },
    {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 200,
      signal,
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const text = String(result?.text ?? '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 带超时的执行：超时既用 AbortController 通知提供方，也 `Promise.race` 硬兜一层 ——
 * 提供方完全可以忽略 signal（第三方代码什么都干得出来），只靠 abort 会让检索永远等下去。
 */
export async function withTimeout(run, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ms = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('语义接缝超时'));
      const error = new Error(`提供方超过 ${ms}ms 没回`);
      error.name = 'AbortError';
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** 倒数排名融合：列表里名次越靠前分越高；不同列表的分数不可比，所以按名次来。 */
export function mergeRRF(lists, limit) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, index) => {
      if (!id) return;
      const gain = 1 / (RRF_K + index + 1);
      scores.set(id, (scores.get(id) ?? 0) + gain);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, Math.max(1, limit))
    .map(([id]) => id);
}

function normalizeRanking(raw, docs) {
  const known = new Set(docs.map((doc) => doc.id));
  const seen = new Set();
  const ids = [];
  let dropped = 0;
  const rows = Array.isArray(raw) ? raw : [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : String(row?.id ?? '');
    if (!id) continue;
    if (!known.has(id)) {
      dropped += 1; // 模型/提供方编出来的文件名一律丢弃：宁可少一条，也不许凭空造文档
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, dropped };
}

/** 改写结果的宽松解析（同样导出给尺子复用：解析口径不一致，数字就不可比）。 */
export function normalizeExpansions(raw, query) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set([String(query).trim().toLowerCase()]);
  for (const row of rows) {
    const text = String(typeof row === 'string' ? row : row?.query ?? '').trim().slice(0, MAX_EXPANSION_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_EXPANSIONS) break;
  }
  return out;
}

const fail = (hits, started, code, message, extra = {}) => ({
  hits,
  used: false,
  code,
  message,
  ms: Date.now() - started,
  ...extra,
});

/**
 * 词面检索 + 可选语义接缝。
 *
 * 返回值里 `used` 说明接缝这次到底有没有真的用上（false 时 `code`/`message` 给出原因），
 * `ms` 是整段耗时 —— 这样调用方与测试都能看见「开着但没用上」和「关着」的区别。
 */
export async function semanticSearch(options = {}) {
  const started = Date.now();
  const runSearch = options.searchFn ?? lexicalSearch;
  const limit = Math.max(1, Number(options.limit) || 5);
  const query = String(options.query ?? '').trim();
  const config = options.config ?? {};
  const lexical = runSearch(options.index, query, limit);
  if (!query) return fail([], started, 'empty-query', '查询为空');

  const seam = describeSeam(config);
  if (!seam.enabled) return fail(lexical, started, 'off', seam.message);

  const loaded = await loadProvider(config, { runtime: options.runtime, baseDir: options.baseDir });
  if (!loaded.ok) return fail(lexical, started, loaded.code, loaded.message);

  const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const provider = loaded.provider;

  try {
    if (provider.kind === 'rerank') {
      const docs = lexical.map((hit, index) => ({
        id: hit.id,
        snippet: hit.snippet,
        matched: hit.matched,
        lexicalRank: index + 1,
        lexicalScore: hit.score,
      }));
      const raw = await withTimeout((signal) => provider.rerank({ query, docs, limit, signal }), timeoutMs);
      const ranking = normalizeRanking(raw, docs);
      if (!ranking.ids.length) {
        return fail(lexical, started, 'provider-empty', `提供方 ${provider.name} 没给出任何可用排序，已降级`, { provider: provider.name });
      }
      const order = mergeRRF([lexical.map((hit) => hit.id), ranking.ids], limit);
      const byId = new Map(lexical.map((hit) => [hit.id, hit]));
      const hits = order.map((id) => byId.get(id)).filter(Boolean);
      // 词面没排进前 limit、却被提供方拉进来的文档不在池子里 —— 如实报数，别假装融合了。
      const missing = order.filter((id) => !byId.has(id)).length;
      return {
        hits,
        used: true,
        code: 'reranked',
        message: `已按 ${provider.name} 的顺序融合（RRF）`,
        provider: provider.name,
        dropped: ranking.dropped,
        missing,
        ms: Date.now() - started,
      };
    }

    const raw = await withTimeout((signal) => provider.expand({ query, signal }), timeoutMs);
    const expansions = normalizeExpansions(raw, query);
    if (!expansions.length) {
      return fail(lexical, started, 'provider-empty', `提供方 ${provider.name} 没给出任何可用的改写，已降级`, { provider: provider.name });
    }
    // 词面顺序原样保留：改写只按自己的名次往后补，绝不插队。理由见文件头（实测：融合会以多欺少）。
    const order = lexical.map((hit) => hit.id);
    const seen = new Set(order);
    const byId = new Map(lexical.map((hit) => [hit.id, hit]));
    const extra = [];
    for (const text of expansions) {
      for (const hit of runSearch(options.index, text, limit)) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (!byId.has(hit.id)) byId.set(hit.id, hit);
        extra.push(hit.id);
      }
    }
    const room = Math.max(0, limit - order.length);
    const filled = extra.slice(0, room);
    const hits = [...order, ...filled].map((id) => byId.get(id)).filter(Boolean);
    return {
      hits,
      used: true,
      code: 'expanded',
      message: filled.length
        ? `已用 ${expansions.length} 条改写补位（新增 ${filled.length} 条，词面顺序未动）`
        : `已用 ${expansions.length} 条改写，但没有可补的空位（词面结果已占满 ${limit} 条，顺序未动）`,
      provider: provider.name,
      expansions,
      added: filled.length,
      ms: Date.now() - started,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /超时/.test(String(error?.message ?? ''));
    const code = aborted ? 'timeout' : 'provider-error';
    const message = aborted
      ? `提供方 ${provider.name} 超过 ${timeoutMs}ms 没回，已降级为词面结果`
      : `提供方 ${provider.name} 出错（${error?.message ?? error}），已降级为词面结果`;
    return fail(lexical, started, code, message, { provider: provider.name });
  }
}
