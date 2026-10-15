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
 *    （也可以写成裸模块名，如 `dsh-engramory-recall/providers/openai-embeddings`——包里自带）
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
 * · `rerank` 声称自己有打分器 ⇒ 它看到的是一个**宽于输出窗口的候选池**（`pool`，默认 50），
 *   融合方式由 `fusion` 决定：`rrf`（默认，词面与提供方各一票，谁也别想翻天）或
 *   `trust`（提供方说了算，词面只负责出候选与补空位）；
 * · `expand` 只是「换个说法再查一遍」⇒ **只补空位，永不改动词面顺序**（它仍然只按 `limit` 检索）。
 *
 * 「池子宽于窗口」这条是 0.12.0 加的，动机：池宽 = 输出窗口时，提供方只能重排词面已经挑中的
 * 那几条，天花板被词面钉死。实测（`bench/.tmp/pool-oracle.mjs`，2026-10-15，合成 704 条 +
 * 真库探针 36 条，`limit=4`，提供方 = 完美排序 / 乱序排序两个极端）：
 * · 池内召回随池宽上升：合成 P=5 495/704 → P=20 610/704 → P=50 685/704 → P=100 689/704；
 *   真库 36 条在 P≥5 就全在池内。池宽就是「完美提供方」的天花板。
 * · `rrf` + 宽池（P≥20）能把完美提供方兑现一半：合成 @1 52.7%（P=5/20 一样，因为 RRF 里
 *   词面第 1 名还压着提供方第 1 名）→ @4 73.6%；真库 @1 72.2% → 80.6%。
 * · `trust` 才拿到全部：合成 @1 86.6%（= 池内召回 610/704）、真库 @1 100%（36/36）。
 * · 代价同样量过：提供方若把顺序**倒过来**，`rrf` 合成 @1 50.4% → 26.0%，`trust` 更惨；
 *   把提供方票数加到 2/3 票能让完美提供方涨到 63.2%/67.5%，但乱序提供方会直接把 @1 打到
 *   1.0%（合成）/ 0.0%（真库）—— 所以**票数永远留 1**，谁想更激进就用 `trust` 明说。
 * 一句话：`rrf` = 少赚不赔，`trust` = 把天花板交给提供方。
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
/** 复用 DSH 设置页里已配好的模型路由（baseURL + 模型 + 密钥），不用再填一遍环境变量。 */
export const HOST_EMBED = 'host-embed';

/**
 * 目录自带路由的地址与 embedding 模型（pi-ai catalog 里，宿主设置读不到，只能在这里兜底）。
 * 只收「确定提供 OpenAI 形状 /embeddings 接口」的几家；其余一律要求用户显式写 baseURL。
 */
const HOST_EMBED_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  zai: 'https://open.bigmodel.cn/api/paas/v4',
};
const HOST_EMBED_MODELS = {
  openai: 'text-embedding-3-small',
  mistral: 'mistral-embed',
  together: 'BAAI/bge-large-en-v1.5',
  zai: 'embedding-3',
};
/** `rerank` 提供方看到的候选池宽度（`pool` 配置，默认 50；上限 200）。 */
export const DEFAULT_POOL = 50;
export const MAX_POOL = 200;
/**
 * 融合模式：
 * · `rrf`（默认）= 词面与提供方各一票（等权），提供方只能往上顶、不能把词面的第 1 名挤掉；
 * · `guarded` = **把握度门槛**：只准提供方把它的头名插到最前，而且（a）那一篇必须**已经在输出窗口里**、
 *   （b）它要明显赢过词面头名（头名分之差 > `semanticGuard` × 池内分数跨度）；其余位置一律保持词面顺序。
 *   因为「不换人」，窗口里的集合与纯词面完全相同 —— hit@4 与词面**恒等**，最多只在窗口内部换次序。
 * · `trust` = 提供方的顺序即最终顺序（词面只用来补满窗口）。
 *
 * **默认选 rrf 是三条实测压出来的**（`npm run bench:seam` 与 `npm run bench:embed` 可复算）：
 * 1. 理想提供方（全量且完美的排名，oracle 实验）确实 trust 更高：合成 86.6%/86.6% vs rrf 52.7%/76.3%；
 * 2. 但**最坏的**提供方（哈希假向量）在 trust 下会砸到底：真库探针 72.2% → 5.6%（rrf 19.4%）；
 * 3. **真模型**（本机 qwen3-embedding:0.6b @ Ollama，2026-10-15 实测）trust 同样亏：
 *    真库探针 hit@1 72.2%（与纯词面持平），而 rrf 是 86.1%（池 10 时 hit@4 100%）。
 * 也就是说 trust 的收益只在「提供方比词面更准」时兑现，而噪音会**全额**转成损失；
 * rrf 的代价是天花板低一点（上面第 1 条），但坏提供方也拖不垮它。
 * 结论：默认 rrf；**量过你的端点、确认它确实更准**，再换 trust（README 有对照表）。
 *
 * 4. 更细的一层是 `guarded`（2026-10-15，174 条真库卷子、两个端点实测，`npm run bench:guard` 可复算）：
 *    把「准不准」从「按谁的顺序」换成「准不准它插队」—— 只动第 1 名，且不许换人。同一张卷子
 *    （池 10 / 窗口 4，保护集 117 条、争夺集 52 条）：
 *    智谱 embedding-3：词面 67.2%/91.4% → rrf 74.7%/93.7% → **guarded 76.4%/91.4%**（保护集丢 2 条）；
 *    本机 qwen3-embedding:0.6b：词面 67.2%/91.4% → rrf 68.4%/94.3% → **guarded 75.9%/91.4%**（丢 1 条）。
 *    最坏情况（分数换成假分数 = 垃圾提供方）：rrf 34.5%/78.7%、trust 10.9%/37.9%，而 `guarded` 是
 *    54.6%/91.4% —— hit@4 一格不掉（它就是词面那一格），掉的只是「插错队」的那 12 个点。
 *    ⇒ `guarded` 是「少赚不赔」最接近字面兑现的一档：赚得比 rrf 多，赔的时候有硬边界。
 *    代价：hit@4 吃不到池子里捞人的红利（允许从池里换人的形状在智谱上是 78.2%/94.3%，但垃圾端点上
 *    hit@1 会塌到 34.5%，尺子里留了这一行做对照）。
 */
export const FUSION_MODES = ['rrf', 'trust', 'guarded'];
export const DEFAULT_FUSION = 'rrf';
/** `guarded` 的把握度门槛：分差要超过「池内提供方分数跨度」的这个比例才准插队（实测 0.4~0.6 是平台）。 */
export const DEFAULT_GUARD = 0.5;

/** 配置里能写的提供方：空 = 关闭；`host-llm` = 走宿主模型（llm.js）；其余当本地模块路径。 */
export function describeSeam(config = {}) {
  const spec = String(config.provider ?? '').trim();
  if (!spec) return { enabled: false, kind: 'off', spec: '', message: '语义接缝未启用（默认）' };
  if (spec === HOST_LLM) {
    return { enabled: true, kind: 'host-llm', spec, message: '语义接缝指向宿主模型（llm.js，动态 import）' };
  }
  if (spec === HOST_EMBED) {
    return { enabled: true, kind: 'host-embed', spec, message: '语义接缝复用 DSH 里已配好的模型路由（设置页的 baseURL + 模型 + 密钥）' };
  }
  return { enabled: true, kind: 'module', spec, message: `语义接缝指向本地模块：${spec}` };
}

/** 候选池宽度：至少等于输出窗口，默认 DEFAULT_POOL，上限 MAX_POOL。 */
export function poolLimit(config = {}, limit = 5) {
  const want = Number(config.pool);
  const pool = Number.isFinite(want) && want > 0 ? want : DEFAULT_POOL;
  return Math.min(MAX_POOL, Math.max(Number(limit) || 1, Math.floor(pool)));
}

/** 融合模式：只认 FUSION_MODES 里的值，其余一律回默认（配置写错不该让检索变怪）。 */
export function fusionMode(config = {}) {
  const want = String(config.fusion ?? '').trim().toLowerCase();
  return FUSION_MODES.includes(want) ? want : DEFAULT_FUSION;
}

/** `guarded` 的门槛比例：0 = 只要高一点点就准插队（发神经）；给了非数或负数回默认。 */
export function guardRatio(config = {}) {
  const want = Number(config.guard);
  return Number.isFinite(want) && want >= 0 ? Math.min(1, want) : DEFAULT_GUARD;
}

/**
 * 把握度门槛（`guarded` 的核心，导出给尺子与测试复用）：
 * 只可能把提供方的**头名**提到最前，而且它必须**已经在输出窗口里** —— 也就是只允许窗口内部重排，
 * 绝不用池子里的生面孔把窗口里的人换掉（换人会让「词面本来答对的题」连人带分一起掉出窗口）。
 * 门槛 = 它的头名分 − 词面头名分 > ratio ×（它给出的分数跨度）。
 * 提供方没给分、分是平的、头名在窗口外、词面头名不在它名单里、分差不够 —— 一律不动（保持词面顺序）。
 */
export function guardedOrder(pool, ranking, ratio = DEFAULT_GUARD, limit = pool.length) {
  const base = pool.map((hit) => hit.id).slice(0, Math.max(1, limit));
  const top = ranking?.ids?.[0];
  if (!top || !base.length || top === base[0]) return { ids: base, promoted: false, reason: 'no-change' };
  if (!base.includes(top)) return { ids: base, promoted: false, reason: 'out-of-window' };
  const ids = ranking.ids;
  const scores = ranking.scores ?? [];
  // 注意 `Number(null)` 是 0：提供方「部分给了分、部分没给」时，null 必须当成**没有分**，
  // 否则会凭空造出一个 0 分的参照物，把分差和跨度都算歪（这正是测试里 no-scores 那格抓出来的）。
  const scoreOf = (id) => {
    const i = ids.indexOf(id);
    return i >= 0 ? asScore(scores[i]) : null;
  };
  const topScore = scoreOf(top);
  const lexScore = scoreOf(base[0]);
  if (topScore === null || lexScore === null) return { ids: base, promoted: false, reason: 'no-scores' };
  const values = ids.map((_, i) => asScore(scores[i])).filter((v) => v !== null);
  const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
  if (!(spread > 0)) return { ids: base, promoted: false, reason: 'flat-scores' };
  if (topScore - lexScore <= ratio * spread) return { ids: base, promoted: false, reason: 'low-margin' };
  return { ids: [top, ...base.filter((id) => id !== top)], promoted: true, reason: 'promoted' };
}

/** 提供方给的分数：非有限值 / 没给（null、undefined）一律当「没有分」。 */
function asScore(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

/**
 * `provider` 可以写成三种形式，这里判断它是不是「裸模块名」（交给 Node 解析）：
 * · `dsh-engramory-recall/providers/openai-embeddings` —— 裸名（包自引用 / 依赖解析）；
 * · `./my-provider.mjs`、`~/x/y.mjs`、`/abs/path.mjs` —— 路径。
 */
export function isBareSpecifier(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return false;
  if (text.startsWith('.') || text.startsWith('/') || text.startsWith('~')) return false;
  return !/^[A-Za-z]:[\\/]/.test(text);
}

export function resolveProviderPath(spec, baseDir = process.cwd()) {
  const text = expandHome(String(spec ?? '').trim());
  if (!text) return '';
  return isAbsolute(text) ? text : resolve(baseDir, text);
}

/**
 * 从宿主设置里读出「用哪条路由做 embedding」：路由 → baseURL → 模型 → 密钥。
 * 每一步都给出**可照做的失败信息**（而不是一句「配置错误」），并且**绝不把密钥写进任何返回值以外的路径**。
 */
async function readHostEmbedProfile(runtime, config = {}) {
  const ctx = runtime?.ctx;
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  if (!settings || typeof settings.describe !== 'function') {
    return { ok: false, code: 'no-host', message: 'host-embed 需要宿主设置服务（ctx.settings）；MCP 等没有宿主的场景请改用本地模块提供方' };
  }
  let route = String(config.hostRoute ?? runtime?.config?.provider ?? '').trim();
  if (!route) {
    try {
      route = String(ctx.get('agentDefaultModel')?.currentSelection?.()?.provider ?? '').trim();
    } catch {
      route = '';
    }
  }
  if (!route) return { ok: false, code: 'no-route', message: '拿不到宿主默认模型的路由：请在插件配置里写 semanticHostRoute' };

  let row;
  try {
    const rows = settings.describe({ redactSecrets: true });
    row = (Array.isArray(rows) ? rows : []).find((item) => item?.ns === 'llm-pi-ai');
  } catch (error) {
    return { ok: false, code: 'load-error', message: `读宿主设置失败：${error?.message ?? error}` };
  }
  const profile = row?.value?.providers?.[route] ?? row?.user?.providers?.[route] ?? {};
  const baseUrl = String(config.hostBaseUrl ?? profile.baseURL ?? HOST_EMBED_BASE_URLS[route] ?? '').trim();
  if (!baseUrl) {
    return {
      ok: false,
      code: 'no-base-url',
      message: `路由 ${route} 没写 baseURL，插件也猜不到它（目录自带路由的地址在 pi-ai catalog 里）。请在 DSH 设置 → 模型 →「自定义模型 API」里加一条 OpenAI 兼容的 embedding 路由，或在本插件配置里写 semanticHostBaseUrl`,
    };
  }
  const declared = Array.isArray(profile.models) ? profile.models : [];
  const model =
    String(config.hostModel ?? '').trim() ||
    String(declared.find((item) => /embed/i.test(String(item?.id ?? '')))?.id ?? '').trim() ||
    (declared.length === 1 ? String(declared[0]?.id ?? '').trim() : '') ||
    HOST_EMBED_MODELS[route] ||
    '';
  if (!model) {
    return { ok: false, code: 'no-model', message: `路由 ${route} 里找不出 embedding 模型：请在插件配置里写 semanticHostModel（例如 text-embedding-3-small）` };
  }
  // 宿主侧凭据的 ref 就是环境变量名本身（custom 路由保存时按 <ROUTE>_API_KEY 派生，catalog 路由由 pi-ai 声明）。
  const keyRef = String(profile.apiKeyEnv ?? '').trim() || `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
  let apiKey = '';
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      // 宿主规范：凭据**每次调用现解析、不许跨操作缓存**（值可能被用户随时改）。
      apiKey = String((await credentials.resolve(keyRef))?.value ?? '');
    } catch {
      apiKey = '';
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      code: 'no-key',
      message: `宿主凭据里没有 ${keyRef}：在 DSH 设置 → 模型 →「${route}」里填 API 密钥（落到 ~/.dsh/.credentials.yaml 的 refs.${keyRef}），或给本插件配 ENGRAMORY_EMBED_API_KEY`,
    };
  }
  return { ok: true, route, baseUrl, model, apiKey, keyRef };
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

    if (seam.kind === 'host-embed') {
      const profile = await readHostEmbedProfile(deps.runtime, config);
      if (!profile.ok) return { ok: false, code: profile.code, message: profile.message, seam };
      const module = await import('./providers/openai-embeddings.mjs');
      const provider = module.createProvider({
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        providerName: `${HOST_EMBED}:${profile.route}/${profile.model}`,
      });
      return { ok: true, provider, kind: 'rerank', code: 'host-embed', message: seam.message, seam, hostRoute: profile.route };
    }

    if (isBareSpecifier(seam.spec)) {
      const module = await import(seam.spec);
      const provider = normalizeModule(module, seam.spec);
      if (!provider) {
        return { ok: false, code: 'unsupported', message: `提供方模块必须导出 rerank 或 expand 函数：${seam.spec}`, seam, path: seam.spec };
      }
      return { ok: true, provider, kind: provider.kind, code: 'module', message: seam.message, seam, path: seam.spec };
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
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      return {
        ok: false,
        code: 'not-found',
        message: `找不到提供方模块：${seam.spec}（裸名要装在同一个 node_modules 里，否则写绝对路径）`,
        seam,
      };
    }
    return { ok: false, code: 'load-error', message: `加载提供方失败：${error?.message ?? error}`, seam };
  }
}

function normalizeModule(module, source) {
  // 两种写法都收：命名导出（`export function rerank`）与默认导出对象（`export default { rerank }`）。
  // 后者是第三方提供方最自然的写法（工厂函数 + 默认导出），不必逼人家改风格。
  const fallback = String(source).split('/').pop();
  for (const target of [module, module?.default]) {
    if (!target || typeof target !== 'object') continue;
    const name = String(target.name ?? module?.name ?? fallback);
    if (typeof target.rerank === 'function') return { name, kind: 'rerank', rerank: target.rerank, source };
    if (typeof target.expand === 'function') return { name, kind: 'expand', expand: target.expand, source };
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
  const scores = [];
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
    // 分数只有 `guarded` 用得上：提供方只给文件名（没有分）时这里就是 null，门槛直接不动。
    const score = typeof row === 'string' ? NaN : Number(row?.score);
    scores.push(Number.isFinite(score) ? score : null);
  }
  return { ids, scores, dropped };
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
      // 提供方看的是宽池：池子 = 输出窗口时它只能重排词面已挑中的那几条（天花板被词面钉死）。
      const poolSize = poolLimit(config, limit);
      const pool = poolSize > limit ? runSearch(options.index, query, poolSize) : lexical;
      const docs = pool.map((hit, index) => ({
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
      const byId = new Map(pool.map((hit) => [hit.id, hit]));
      const fusion = fusionMode(config);
      const guard = guardRatio(config);
      let order;
      let guarded = null;
      if (fusion === 'guarded') {
        // 把握度门槛：只动第 1 名，而且要有把握；没把握就原样交回词面顺序。
        guarded = guardedOrder(pool, ranking, guard, limit);
        order = guarded.ids;
      } else if (fusion === 'trust') {
        // 提供方说了算：它给过分的按它的顺序走，剩下的坑用词面顺序补满。
        order = [...ranking.ids, ...pool.map((hit) => hit.id).filter((id) => !ranking.ids.includes(id))].slice(0, limit);
      } else {
        order = mergeRRF([pool.map((hit) => hit.id), ranking.ids], limit);
      }
      const hits = order.map((id) => byId.get(id)).filter(Boolean);
      // 提供方编造的、池子里没有的文件名 —— 如实报数，别假装融合了。
      const missing = order.filter((id) => !byId.has(id)).length;
      const message = fusion === 'trust'
        ? `已按 ${provider.name} 的顺序取前 ${hits.length} 条（池 ${pool.length}，Trusted 融合）`
        : fusion === 'guarded'
          ? (guarded?.promoted
            ? `已按 ${provider.name} 的把握把它的头名提到最前（池 ${pool.length}，门槛 ${guard}）`
            : `提供方 ${provider.name} 把握不足（池 ${pool.length}，门槛 ${guard}），保持词面顺序`)
          : `已按 ${provider.name} 的顺序融合（RRF，池 ${pool.length}）`;
      return {
        hits,
        used: true,
        code: 'reranked',
        message,
        provider: provider.name,
        fusion,
        pool: pool.length,
        ...(fusion === 'guarded' ? { guard, promoted: Boolean(guarded?.promoted), guardReason: guarded?.reason } : {}),
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
