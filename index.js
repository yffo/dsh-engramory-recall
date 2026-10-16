/**
 * dsh-engramory-recall —— 给 Engramory 记忆库加一层「本地自动召回」。
 *
 * 它只是把 Memmy/SEP 那类记忆插件的**好处**用 Engramory 的口径重做一遍：
 *
 *   1. 自动召回：在每个用户轮的第一个 step，用 BM25 在记忆库里检索当前这句话，
 *      把**命中的指针**（文件名 + 一行片段）追加到这个 step 的消息批次里。
 *   2. 零常驻成本：没有命中就一个字都不注入；命中也只注入文件名与片段，
 *      正文仍然要模型自己 read —— 保持「索引是钩子、内容在笔记里」的纪律。
 *   3. 只读：本插件从不写记忆库，不联网，不调模型，不下载任何东西。
 *   4. 前缀缓存友好：注入是 append 到批次末尾，且一个用户轮只注入一次。
 *   5. 按需兜底：注册 `engramory_search` 工具，自动召回没命中时模型可以主动搜（同样只读、离线）。
 *
 * 注意：改完本文件必须**重启 App**才生效——宿主进程会缓存已加载的 ESM 模块。
 *
 * 关闭方式：把 profile 的 cordis.patch.yml 里这一行的 `enabled` 改成 false，
 * 或直接 `dsh plugin --profile desktop remove dsh-engramory-recall`。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildIndex, search, clip } from './bm25.js';
import { renderPointers, RECALL_HEADER } from './render.js';
import { checkMemoryWrite } from './guard.js';
import { checkIndexWrite, DEFAULT_MAX_INDEX_BYTES, DEFAULT_MAX_INDEX_LINES } from './index-guard.js';
import { registerSkill, skillStatus } from './skill.js';
import { appendAudit, readAudit, GUARD_EPOCH } from './audit.js';
import {
  appendUsage, readUsage, summarizeUsage, usageVerdict, budgetVerdict, reasonVerdict, scoreCurveVerdict, truncationVerdict,
  noteIdFromPath, pickInjected,
} from './usage.js';
import { readDocs } from './store.js';
import { describeSeam, semanticSearch } from './semantic.js';
import { auditStore } from './doctor.js';
import { planArchive, applyArchive } from './archive.js';

export const name = 'engramory-recall';

/** 注册按需检索工具，所以需要宿主 tools 服务（不用 ctx.tools 之外的任何服务）。 */
export const inject = ['tools'];

/** 会话里的生产者标识用包名，便于在日志/时间线里一眼认出是谁注入的。 */
const PRODUCER = 'dsh-engramory-recall';

const DEFAULTS = {
  enabled: true,
  storePath: '',
  maxPointers: 4,
  maxChars: 480,
  minScore: 0,
  nudge: true,
  /**
   * 召回落盘日志（`.engramory-recall.jsonl`）。开着才有「注入的指针后来被用上了吗」
   * 这个数据——内存里的日志重启即清，跨会话的窗口宽度决策没法靠它。
   * 关掉 = 只留内存日志（旧行为）。账本本身不占上下文，只占磁盘（512KB 封顶）。
   */
  usageLog: true,
  /**
   * freshness 衰减半衰期（天）；0 = 关闭（默认）。
   *
   * 2026-10-14 实测：库内 128 个片段跨 0–31.6 天，扫了 30/60/90/180/365/3650 六档 ——
   * recall 恒为 28/28，top-1 只有 90 天那档 +1（22→23）、对照组反而 −1（26→25），
   * 其余档持平或更差。±1 在 28 条样本上就是噪声，**没有净收益**。
   *
   * 根因：库里唯一那批「老」笔记（31.6 天）恰好是 feedback-collaboration-and-safety-rules、
   * user-profile-and-preferences 这类**基础事实**，本就该被频繁召回，衰减它们纯属误伤。
   * 灵枢能安全用衰减，是因为它的 protected_floor 依赖人工 importance 字段给重要节点设下界
   * （`importance × 乘子 ≥ 0.70`），我们的笔记没有这个字段，硬套半衰期只会误伤。
   *
   * 结论：代码留着（一行配置可开），等库里真出现半年以上的跨度再调成 90 复测。
   */
  decayHalfLifeDays: 0,
  /**
   * 时间**乘性**加权幅度（抄 hindsight `engine/search/reranking.py:35-37` 的 recency ±10%）。
   *
   * 与上面的 decayHalfLifeDays 是两回事：那个是无界指数衰减（半衰期），这个是**有界扰动**
   * —— 库内最新的一篇 ×(1+w)、最旧的 ×(1−w)。
   *
   * 2026-10-14 实测（28 条查询，扫 w = 0 / 0.05 / 0.1 / 0.15 / 0.2）：w=0.05 与关闭完全同分；
   * w≥0.1 起**对照组**（用文件名当查询）从 26/28 掉到 25→24；w=0.2 连 recall 掉到 26/28。
   * 结论：**净收益为零**，默认保持 0（关闭）。原因与 decay 同——库里「旧」的那批恰好是
   * feedback / user-profile 这类基础事实，压它们就是压正确答案。代码留着，跨度上来再复测。
   */
  recencyWeight: 0,
  /**
   * 跨轮轮换去重（抄 mneme `src/inject.js:101` 的 `recentInjectedIds`）：最近注入过的条目
   * 在后续轮次里分数乘这个系数（默认 0.5 = 减半）。降权不是剔除——若它真是唯一命中，
   * 降权后仍在候选池里。设为 1 即关闭降权。
   */
  rotationPenalty: 0.5,
  /** 轮换记忆长度：记住最近多少条注入过的 id（mneme 的 ROTATION_HISTORY_MAX = 32）。 */
  rotationHistory: 32,
  /**
   * 注入去重（抄 mnemon `src/host/lifecycle.ts:339-345`）：渲染出来的指针文本**一字未变**
   * 时不重复注入——上一轮那份还在上下文里，再塞一遍纯属重复计费。默认开。
   */
  dedupeInjection: true,
  /**
   * 写入闸门（fail-closed）：模型用 write/edit 往记忆库里写时，先由本插件静态复核一次，
   * 不合规就拒绝这次调用。它是「编译者不得自证」里的那个编外单元——写的人不校验，
   * 校验的人不写。默认开。
   */
  guardWrites: true,
  /**
   * 检索用的查询字符预算。超长消息**在头尾各取一半**，而不是只取尾部。
   *
   * 原先写死 `slice(-400)`（只留尾部，取「最近说了什么」），但实测踩到灵枢 issue #108
   * 的同类坑：1190 字的消息（开头「飞书那边一直连不上」+ 中间贴 1146 字日志）截断后
   * 开头主题词整个丢失，召回的是一堆无关条目。中间那段通常是粘贴正文，噪音最多，
   * 头（交代意图）尾（最新追问）才是意图所在。
   */
  queryChars: 400,
  /**
   * 沉淀提醒：本会话轮次够多、却一次都没往记忆库写过东西时，注入一次提醒。
   *
   * 补的是**唯一一个不受任何约束限制**的缺口：灵枢的写入闸门、mneme 的 autoDream 保证的
   * 都是「写进来的东西干净」，**没有任何机制保证「该写的被写了」**——现在全靠模型自觉。
   * 短会话（< sedimentMinTurns 轮）和已经在写的会话都不触发，保持「不命中就不消耗上下文」。
   */
  nudgeSediment: true,
  /** 沉淀提醒的轮次门槛（本会话第几个真实用户轮才可能触发）。 */
  sedimentMinTurns: 12,
  /**
   * 自动归档：笔记长过阈值时自动做物理分层，不必每次人工点「执行」。**默认关。**
   *
   * 敢把它做成一个开关，是因为归档已经被验证成**可逆且零信息损失**：不删不截断、原件
   * 整份进 `.archive-backup/<时间戳>/`、拆出去的 history 仍在同一库目录内、仍被索引、
   * 仍能被召回，主笔记末尾还留一行指针指过去（doctor 的孤儿判据已改成可达性，认这行）。
   * 既然最坏情况只是「多出几个文件、随时能读回来」，拦人一道的价值就低于它的摩擦。
   *
   * 触发时机刻意选在**刚写完记忆库之后**：笔记变大只可能来自写入，那一刻检查最自然，
   * 也不必常驻定时器。另加 pre-step 兜底（10 分钟一次），管住「手动用 bash 改大了」
   * 这种绕过闸门的情况。自动执行的每一步都进写入审计，`reason` 里写明触发源。
   */
  autoArchive: false,
  /**
   * 索引上限闸门：`MEMORY.md` 长过这里就拒绝写入（缩小的重写永远放行）。
   *
   * 判定口径（200 行 / 25KB、只拒绝增长）沿用 Engramory 协议（MIT，见 `THIRD-PARTY-NOTICES.md`），
   * 实现是我们自己写的（`index-guard.js`）。自己实现而不是当外部依赖，是因为本插件要做完整的
   * 记忆系统：索引上限是召回正确性的边界，不该落在别人的包里。
   *
   * 路径不必配置：本插件知道库在哪，索引固定是 `<storePath>/MEMORY.md`。
   * 这比让人手钉一个绝对路径更不容易错（原插件正是为此加了 `indexPath` 配置项，
   * 因为它按 basename 匹配会误伤别的项目里同名的 `MEMORY.md`）。
   */
  indexMaxLines: DEFAULT_MAX_INDEX_LINES,
  indexMaxBytes: DEFAULT_MAX_INDEX_BYTES,
  /**
   * 注册 `engramory` 技能（写入纪律的正文）。默认开。
   *
   * 纪律与上游 Engramory 协议一致（MIT，见 `THIRD-PARTY-NOTICES.md`），措辞是本仓库自己的。
   * 与上游插件同时装着时会注册同名技能 —— 两者纪律一致，谁赢都一样；注册处包了 try/catch，
   * 万一注册表对重名是抛错而非覆盖，不会因为一个技能名把宿主拖崩。
   */
  registerSkill: true,
  /**
   * ── 语义增强（唯一的「会发模型请求」开关，默认全关）──────────────────────
   *
   * 招牌是「不装、不配、不显式开启时一个模型请求都不发」。这条承诺靠三层锁着：
   *   1. 两个开关默认 false；
   *   2. 关着时**连工具都不注册**，模型看不到这两个入口；
   *   3. 开着时也只在工具被调用那一刻 `await import('./llm.js')` —— 静态依赖图里没有它，
   *      自动召回、面板、体检、写入闸门全部不在任何情况下发请求。
   *
   * 为什么不做成「面板刷新时顺便查一遍」：面板是轮询的，那样等于按秒烧 token，
   * 而且体检结果会随模型心情变化，不可复现。模型显式调工具才是对的时机。
   */
  semanticConflicts: false,
  semanticSummary: false,
  /** 调用路由：留空则用宿主的 agentDefaultModel；两个都给才生效（半截路由会被忽略）。 */
  llmProvider: '',
  llmModel: '',
  llmReasoningEffort: '',
  /** 单次模型调用的超时预算（毫秒）。 */
  llmTimeoutMs: 30000,
  /**
   * 语义接缝（默认关闭）：留空 = 纯词面，连 import 都不发生。
   *
   * 取值：本地模块路径（导出 `rerank({query, docs, limit, signal})` 或
   * `expand({query, signal})`），或者字面量 `host-llm`（走宿主模型，动态 import llm.js）。
   * 它只影响**按需检索工具**；每轮自动注入那条路径永远是纯词面 ——
   * 自动召回每轮都跑，挂一个需要 300ms 的外部件等于给每个用户轮加税。
   */
  semanticProvider: '',
  /** 接缝的单次超时预算（毫秒）。超时/抛错/返回垃圾一律降级回词面结果。 */
  semanticTimeoutMs: 2000,
  /**
   * `rerank` 提供方看到的候选池宽度（默认 50，上限 200）。
   *
   * 池宽 = 输出窗口时，提供方只能重排词面已经挑中的那几条，天花板被词面钉死；放宽池子
   * 才给语义信号留出「把排名靠后的正确笔记捞上来」的空间。实测（2026-10-15，合成 704 条）：
   * 池内召回 P=5 时 70.3%、P=20 86.6%、P=50 97.3%。代价只是词面多算几条候选 + 提供方多算
   * 几十条（embedding 按篇计费，50 条约几千 token，一次查询级别）。
   */
  semanticPool: 50,
  /**
   * 融合方式：
   * · `rrf`（默认）= 词面与提供方各一票，少赚不赔，什么端点都拖不垮；
   * · `guarded` = 把握度门槛（**量过端点的推荐档**）：只准提供方的头名插到最前，且必须已在输出窗口里
   *   （只换次序、不换人 ⇒ hit@4 与纯词面恒等），分差还要过 `semanticGuard` × 池内分数跨度。
   *   174 条真库卷子实测（池 10 / 窗口 4）：智谱 76.4%、本机 qwen3-embedding:0.6b 75.9%，都高于
   *   rrf（74.7% / 68.4%）；垃圾提供方下它只赔「插错队」那一格（54.6% / 91.4%，rrf 是 34.5%/78.7%）；
   * · `trust` = 提供方的顺序即最终顺序，天花板最高（理想提供方 86.6% vs 词面 50.4%），但提供方
   *   不靠谱时比纯词面更差 —— 实测：坏向量 11.5%、两个真端点 58~60%，都不如 rrf。
   * 结论：没量过端点用 rrf；量过、确认它确实更准，用 guarded。见 semantic.js 文件头与 README。
   */
  semanticFusion: 'rrf',
  /**
   * `guarded` 融合的把握度门槛：提供方的头名要赢词面头名「池内分数跨度的这个比例」才准插队。
   * 实测（2026-10-15，174 条真库卷子、两个真端点）0.4~0.6 是一片平台，默认 0.5 —— 见 README「语义接缝」。
   */
  semanticGuard: 0.5,
  // 只有 `semanticProvider: 'host-embed'` 用得上：指定复用哪条 DSH 路由（留空 = 当前默认模型的路由）。
  semanticHostRoute: '',
};

/** 只在用户句子里出现明确的「长期记住」意图时才追加一行提示（默认开）。 */
const REMEMBER_INTENT =
  /记住|记一下|记下来|记录一下|别忘了|以后都|以后不|别再|不要再|统一用|标准做法|长期偏好|remember this|from now on|don'?t use/i;

/**
 * 寒暄 / 答话 / 纠偏：这些消息不含可检索的意图，检索只会换来噪音。
 * 2026-10-14 实测「继续 / 嗯 / 重试一下」这类消息 10/10 全部注入噪音（平均 297 字符），
 * 过掉之后降到 1/10、平均 39 字符。
 */
const CHITCHAT =
  /^(?:继续|接着(?:来|做|干|写)?|往下|嗯+|哦+|噢+|好(?:的|吧|啊)?|行|可以|收到|明白|了解|谢谢|感谢|辛苦|没事|算了|重试(?:一下)?|再(?:来|试)(?:一次|一遍)?|试一下|不行|不对|错|停|稍等|等(?:等|一下)?|ok(?:ay)?|yes|no|yep|nope|thanks?|thx|continue|go on|retry|again|stop|wait)[。，,.！!？?~～\s]*$/i;

/** 短于这个长度的消息，即使没被寒暄表命中也不值得检索：4 字以下几乎不含可检索信号。 */
const MIN_QUERY_CHARS = 4;

/**
 * 这条真人消息是否值得去记忆库检索。
 * 宁可漏检也不注入噪音——没命中时一个字都不进上下文，正是这套方案的成本优势。
 */
export function isSearchable(text) {
  return searchableReason(text) === '';
}

/**
 * 不值得检索的原因码（可落盘、可统计）。空串 = 值得检索。
 * 为什么要有码：落盘的召回日志里 `skip` 一旦不带原因，「这轮为什么没注入」就答不上来
 * —— 寒暄门控和「太短」是两种完全不同的信号，前者是设计，后者可能说明 queryChars 太小。
 */
export function searchableReason(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'empty-message';
  if (CHITCHAT.test(s)) return 'chitchat';
  if (s.length < MIN_QUERY_CHARS) return 'too-short';
  return '';
}

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');

const isHuman = (message) => message?.role === 'user' && message?.source?.kind === 'user';

/**
 * 把配置里的 `~/xxx` 展开成真实家目录。这步不能省：别人机器上的家目录不是配置里那个字面量，
 * 而 cordis 的 yaml 配置里 `~` 不会被自动展开——不处理的话 `storePath` 会静默无效
 * （readDocs 读不到目录、返回空数组，召回从此一条都不出，且没有任何报错）。
 */
const expandHome = (value) => {
  const p = String(value ?? '').trim();
  if (!p) return '';
  if (p === '~') return homedir();
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
};

/**
 * 归一库路径：**唯一一处**去掉结尾分隔符。所有比较、拼接、落盘都用它的返回值。
 *
 * 为什么必须归一：`noteNoteOpened()` 用「前缀 + 分隔符」判「这次读的是不是库里的笔记」，
 * 而 `storePath` 配成 `…/engramory/` 时前缀就成了 `…/engramory//` —— 永远匹配不上，
 * 于是 `opened` / `used` 一行都不落盘（打开率恒为 0），而且**不报任何错**。
 * `storeSnapshot()` 早就在自己那边写过一次去尾斜杠，两处口径不一致；现在收敛到这一个函数。
 *
 * ⚠️ 两处不能归一坏：整条路径都是分隔符（`/`、`\\`）时去完尾斜杠会变空串，而空串在配置里
 * 代表「没配库」——那会让整个库静默失效，所以根一律留一个分隔符；`C:\` 去掉尾分隔符会变成
 * `C:`（当前盘的工作目录，语义完全不同），也要补回分隔符。没有尾分隔符时原样返回，
 * `~` 展开与相对路径的解析行为都不受影响。
 */
const normalizeStorePath = (value) => {
  // 唯一调用点是 `normalizeStorePath(expandHome(…))`，expandHome 保证给回字符串。
  const p = String(value).trim();
  if (!p) return '';
  if (!/[/\\]$/.test(p)) return p; // 没有尾分隔符：原样（含 `C:` 这类相对写法）
  const stripped = p.replace(/[/\\]+$/, '');
  if (!stripped) return p[0]; // 纯分隔符 = 根，留一个
  return /^[A-Za-z]:$/.test(stripped) ? stripped + path.sep : stripped; // `C:\` → `C:\`，不是 `C:`
};

/**
 * 「库内」判定用的前缀。`storePath` 已经归一（不带尾分隔符），这里只补回**缺失的那一个**：
 * `path.join` 而不是字符串拼接 —— 库就是根（`/`、`C:\`）时 `storePath + path.sep` 会拼成
 * `//`，与尾斜杠那个坑同源（`path.join('/', '/')` 仍是 `/`）。
 */
const storePrefix = (storePath) => path.join(storePath, path.sep);

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };
  settings.storePath = normalizeStorePath(expandHome(settings.storePath));
  if (!settings.enabled) return;

  let indexCache = { docs: null, index: null };
  const seen = new Set();
  const seenOrder = [];

  // 跨轮轮换去重的记忆体（见 DEFAULTS.rotationPenalty / rotationHistory 的注释）。
  // 只记 id、只在内存里，不落盘；进程重启即清空，符合「无常驻状态」的口径。
  const rotationMax = Math.max(0, Number(settings.rotationHistory) || 0);
  const rotationPenalty = Math.min(Math.max(Number(settings.rotationPenalty ?? 0), 0), 1);
  const recentInjected = [];
  const rememberInjected = (ids) => {
    if (!rotationMax || rotationPenalty >= 1) return;
    for (const id of ids) {
      const at = recentInjected.indexOf(id);
      if (at >= 0) recentInjected.splice(at, 1);
      recentInjected.unshift(id);
    }
    if (recentInjected.length > rotationMax) recentInjected.length = rotationMax;
  };

  /** 上一次注入的去重键：`query\0id,id,…`（见 DEFAULTS.dedupeInjection 的注释）。 */
  let lastInjectedKey = '';

  // ── 召回日志的分子：注入过的笔记后来被打开了吗 ────────────────────────
  // 只记 id → 注入时刻，只供记账用（与 rotationHistory 那套轮换去重无关）。
  // 上限 500 条：一场长会话足够，且不会把内存里的表撑大。
  const injectedAt = new Map();
  const INJECTED_MAX = 500;
  const rememberInjectedAt = (ids) => {
    const now = Date.now();
    for (const id of ids) {
      if (injectedAt.has(id)) injectedAt.delete(id); // 重新注入 = 刷新时刻，顺便挪到队尾
      injectedAt.set(id, now);
    }
    while (injectedAt.size > INJECTED_MAX) injectedAt.delete(injectedAt.keys().next().value);
  };

  /**
   * 工具调用里有没有「打开一篇库里的笔记」——有就记一行。**不参与任何裁决**：
   * 库里 .md 的读/写都算用过（read 是最常见的形态，edit/write 是更硬的证据）。
   * 注入过的记 `used`（带 lagMs），没注入过也打开的记 `opened`（对照组）。
   */
  const noteNoteOpened = (exec, toolName) => {
    try {
      const args = exec?.arguments ?? {};
      const raw = args.file_path ?? args.filePath ?? args.path;
      if (typeof raw !== 'string' || !raw) return;
      const resolved = path.resolve(expandHome(raw));
      // 库内的读才记：前缀用归一后的 storePath 算（见 normalizeStorePath / storePrefix）。
      if (!resolved.startsWith(storePrefix(settings.storePath))) return;
      const id = noteIdFromPath(resolved);
      if (!id) return;
      const injected = pickInjected(id, injectedAt);
      appendUsage(settings.storePath, {
        kind: injected ? 'used' : 'opened',
        id,
        via: toolName,
        lagMs: injected ? Date.now() - injected.at : undefined,
      });
    } catch {
      // 记账失败绝不影响工具调用
    }
  };

  // ── 可观测性：每个用户轮的召回判定留痕 ────────────────────────────────
  // 从外面看，「这轮为什么没注入」「注入了什么」以前完全不可见——这是评估里
  // 列的头号短板。这里把判定结果留在内存里（最近 LOG_MAX 条，不落盘），
  // 由下面的 /api/engramory-recall/state 路由喂给「记忆」标签页。
  const LOG_MAX = 80;
  const recallLog = [];
  const record = (entry) => {
    recallLog.unshift({ at: Date.now(), ...entry });
    if (recallLog.length > LOG_MAX) recallLog.length = LOG_MAX;
    // 同时落一份到库里：内存日志重启即清，而「窗口该多宽、注入的指针有没有被用上」
    // 这类问题恰恰要跨会话才问得出来（分子由下面的读取记账负责写）。
    if (settings.usageLog !== false) {
      appendUsage(settings.storePath, {
        kind: entry.kind,
        query: entry.query,
        reason: entry.reason,
        // 提问者身份（main / subagent）：打开率的分母必须能按这个拆开
        ...(entry.scope ? { scope: entry.scope, depth: entry.depth ?? 0 } : {}),
        ids: (entry.hits ?? []).map((hit) => hit.id).filter(Boolean),
        // 分数与门槛一起落盘：否则「minScore 该定多高」永远只能猜。
        // `scores` 与 `ids` 一一对应（同一顺序），第 1 条与最后一条的落差也靠它算。
        scores: (entry.hits ?? []).map((hit) => hit.score).filter((n) => Number.isFinite(n)),
        minScore: entry.minScore,
        topScore: entry.topScore,
        injected: entry.injected,
        collapsed: entry.collapsed,
        dropped: entry.dropped,
        // 「缩的是哪几条」也要落盘：光有塌缩条数答不了「截断有没有代价」——
        // 被缩成裸文件名的那几条后来被打开过吗？空数组也是信息（这轮谁都没被缩）；
        // 老行完全没有这个键 ⇒ 只能算「缩过，但不知道是谁」，不许当成 0。
        ...(Array.isArray(entry.hits) && entry.hits.length
          ? { collapsedIds: entry.hits.filter((hit) => hit.collapsed === true).map((hit) => hit.id).filter(Boolean) }
          : {}),
        // 预算压力：上限与实际用掉的字符数（老行没有这两项，汇总里不计入）
        ...(Number.isFinite(entry.budget) && Number.isFinite(entry.spent)
          ? { budget: entry.budget, spent: entry.spent }
          : {}),
      });
    }
  };
  const brief = (text, n = 160) => clip(String(text ?? ''), n);

  // ── 沉淀提醒的账本 ────────────────────────────────────────────────────
  // 缺口不是「模型不会写记忆」，而是「长任务跑到最后没人提醒该记」。灵枢的 fail-closed
  // 写入闸门、mneme 的 autoDream 保证的都是「写进来的东西是干净的」；**没有任何机制
  // 保证「该写的被写了」**。判据刻意保守：轮次够多 **且** 本会话一次都没写过记忆库，
  // 才提醒一次然后进入冷却。短会话、已经在写的会话——一个字都不注入。
  let turnCount = 0;
  let storeWrites = 0;
  let sedimentNudgedAt = -Infinity;
  const SEDIMENT_MIN_TURNS = Math.max(2, Number(settings.sedimentMinTurns) || 12);
  const SEDIMENT_COOLDOWN = 24;

  const indexOf = (storePath) => {
    const docs = readDocs(storePath);
    if (indexCache.docs === docs && indexCache.index) return indexCache.index;
    const halfLifeDays = Number(settings.decayHalfLifeDays) || 0;
    const recencyWeight = Number(settings.recencyWeight) || 0;
    indexCache = { docs, index: buildIndex(docs, { halfLifeDays, recencyWeight }) };
    return indexCache.index;
  };

  // 按需检索工具：自动召回没命中时，模型仍能在应用内搜记忆库（只读）。
  // 不导入 @deepseek-ai/* 运行时包（profile 插件与宿主共享同一套实例，导入会拿到第二份），
  // 直接按 ctx.tools.register() 的契约给定义：parameters 是 JSON Schema，
  // output 必须带 { schema, render }，render 返回内容块。
  ctx.tools.register({
    name: 'engramory_search',
    description:
      'Search the local Engramory markdown memory store with BM25 (offline, read-only). ' +
      'Use it when the automatic recall did not surface what you need — for example before ' +
      'answering a question about past decisions, pitfalls or user preferences. It returns ' +
      'matching note filenames with a matched snippet and a score; open the ones you need with read. ' +
      // 这条不是文风，是量出来的：模型改写融合净赔，而「换措辞再搜一次」的收益=改写里最好那条
      // （真库探针 80.6% vs 词面 72.2%）。措辞敏感是 BM25 的本性，所以交给调用方换词最划算。
      'It matches wording, not meaning: if it misses, rephrase the query in your own words and ' +
      'search once more (synonyms, the term in English, the wording a note would use) — cheaper and ' +
      'more effective than expecting one phrasing to land.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords in the user language. Chinese is split into single characters plus adjacent bigrams.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum hits to return (default 5, max 20).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          store: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                score: { type: 'number' },
                snippet: { type: 'string' },
              },
              required: ['file', 'score', 'snippet'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
          semantic: {
            type: 'object',
            properties: {
              used: { type: 'boolean' },
              code: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['used', 'code', 'message'],
            additionalProperties: false,
          },
        },
        required: ['store', 'hits', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // 与官方 defineTool 的产出保持一致：execute 必须是 async（宿主可能按 Promise 调用）。
    async execute(args) {
      const storePath = settings.storePath;
      const query = String(args?.query ?? '').trim();
      if (!storePath || !query) {
        return { store: storePath, hits: [], note: '需要 storePath 配置与非空 query' };
      }
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
      // 接缝关着（默认）就走原来那条同步路径：不 await、不 import、零额外开销。
      // 开着时提供方看到的是宽于 limit 的候选池（semanticPool），融合方式见 semanticFusion。
      const seam = describeSeam({ provider: settings.semanticProvider });
      const result = seam.enabled
        ? await semanticSearch({
            index: indexOf(storePath),
            query,
            limit,
            config: {
              provider: settings.semanticProvider,
              timeoutMs: settings.semanticTimeoutMs,
              pool: settings.semanticPool,
              fusion: settings.semanticFusion,
              guard: settings.semanticGuard,
              hostRoute: settings.semanticHostRoute,
            },
            runtime: llmRuntime(),
          })
        : { hits: search(indexOf(storePath), query, limit), used: false, code: 'off', message: '语义接缝未启用（默认）' };
      const hits = result.hits.map((hit) => ({
        file: hit.id,
        score: Number(hit.score.toFixed(3)),
        snippet: clip(hit.snippet, 240), // 显式搜索的返回：给到句子级上限，别把决定性那句裁掉
      }));
      return {
        store: storePath,
        hits,
        note: hits.length
          ? '用 read 打开需要的文件；正文在笔记里，不在这个结果里'
          : '没有命中：换个说法再搜一次（同义词、术语的英文写法、笔记里可能用的那个词）—— 它只认措辞不认意思',
        semantic: { used: result.used, code: result.code, message: result.message },
      };
    },
  });

  // ── 语义增强：可选、显式、按次（默认两个工具都不注册）────────────────────
  // 关着的时候模型连这两个工具名都看不到，也就不存在「误触发一次模型调用」的可能。
  // llm.js 用动态 import：静态依赖图里没有它，自动召回/面板/体检/写入闸门四条路径
  // 在任何情况下都不可能顺带发请求 —— 招牌那句承诺是结构上成立的，不是靠自觉。
  const llmRuntime = () => ({
    ctx,
    config: {
      provider: settings.llmProvider,
      model: settings.llmModel,
      reasoningEffort: settings.llmReasoningEffort,
      timeoutMs: Number(settings.llmTimeoutMs) || 30000,
    },
  });

  if (settings.semanticConflicts === true) {
    ctx.tools.register({
      name: 'engramory_conflicts',
      description:
        'Ask the harness model to check the local Engramory store for notes that contradict each other ' +
        '(semantic conflicts that the static doctor cannot see). Reads at most 80 notes per call and ' +
        'reports only pairs the model names with real filenames. It costs model tokens — call it when ' +
        'the user asks whether the memory store is self-consistent, not on every turn.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Check only the first N notes (default: all, capped at 80).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            store: { type: 'string' },
            notes: { type: 'integer' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  severity: { type: 'string' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  files: { type: 'array', items: { type: 'string' } },
                },
                required: ['severity', 'code', 'message', 'files'],
                additionalProperties: false,
              },
            },
          },
          required: ['store', 'notes', 'findings'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const storePath = settings.storePath;
        if (!storePath) return { store: storePath, notes: 0, findings: [] };
        const docs = readDocs(storePath);
        const limit = Math.max(Number(args?.limit) || docs.length, 1);
        const picked = docs.slice(0, limit);
        const { detectConflicts } = await import('./llm.js');
        const findings = await detectConflicts(llmRuntime(), picked);
        return { store: storePath, notes: picked.length, findings };
      },
    });
  }

  if (settings.semanticSummary === true) {
    ctx.tools.register({
      name: 'engramory_summarize',
      description:
        'Summarize one note of the local Engramory store with the harness model (long notes get compressed, ' +
        'keeping decisions, reasons and concrete details). It costs model tokens and the note body is sent ' +
        'to the model — call it deliberately, never as a background step.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Note filename as returned by engramory_search.' } },
        required: ['file'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            summary: { type: 'string' },
            model: { type: 'string' },
            ms: { type: 'integer' },
            error: { type: 'string' },
          },
          required: ['file', 'summary', 'model', 'ms'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const file = String(args?.file ?? '').trim();
        const storePath = settings.storePath;
        if (!storePath || !file) return { file, summary: '', model: '', ms: 0, error: '需要 storePath 配置与非空 file' };
        const docs = readDocs(storePath);
        const note = docs.find((doc) => doc.id === file || doc.file === file);
        if (!note) return { file, summary: '', model: '', ms: 0, error: `库里没有 ${file}` };
        const { summarizeNote } = await import('./llm.js');
        try {
          const { summary, route, ms } = await summarizeNote(llmRuntime(), note);
          return { file, summary, model: route.model, ms };
        } catch (error) {
          // 失败就把话说明白：这是给人按的入口，返回空摘要等于骗人。
          return { file, summary: '', model: '', ms: 0, error: `${error?.message ?? error}${error?.code ? ` [${error.code}]` : ''}` };
        }
      },
    });
  }

  // ── 写入闸门：fail-closed 的「编外复核」 ────────────────────────────────
  // 宿主流水线：tools/pre-execute（可扩展门禁）→ ctx.tools.guard（单调守卫，本处）
  // → tools/execute → tools/post-execute → tools/result。守卫是同步的，返回字符串即拒绝，
  // 且**后续任何监听器都无法把拒绝翻回允许**——正是 fail-closed 需要的单调性。
  // 只在目标路径落在 storePath 内时介入；库外的写入一律放行（不在管辖范围）。
  // 这个守卫回调是两个用途共用的观测点：写入闸门（会拒绝）+ 召回日志的读取记账（只记）。
  // 闸门关掉时记账仍要在，所以注册条件是两个开关的并集。
  if (settings.guardWrites !== false || settings.usageLog !== false) {
    ctx.tools.guard((exec) => {
      try {
        const toolName = String(exec?.name ?? '');
        if (settings.usageLog !== false) noteNoteOpened(exec, toolName);
        if (settings.guardWrites === false) return undefined;
        if (toolName !== 'write' && toolName !== 'edit') return undefined;
        const args = exec?.arguments ?? {};
        const filePath = args.file_path ?? args.filePath;
        if (!filePath) return undefined;
        const isWrite = toolName === 'write';
        // 笔记文件规则先判；命中索引文件时它返回 skipped:'index'，此时改由索引上限闸门
        // 接管索引上限（逻辑在 index-guard.js，文件头写明了为什么这么设计）。
        let verdict = checkMemoryWrite({
          filePath: String(filePath),
          storePath: settings.storePath,
          content: isWrite ? args.content : undefined,
          fragment: isWrite ? undefined : args.new_string,
        });
        if (verdict.ok && verdict.skipped === 'index') {
          verdict = checkIndexWrite({
            filePath: String(filePath),
            storePath: settings.storePath,
            tool: toolName,
            content: isWrite ? args.content : undefined,
            oldString: isWrite ? undefined : args.old_string,
            newString: isWrite ? undefined : args.new_string,
            maxLines: settings.indexMaxLines,
            maxBytes: settings.indexMaxBytes,
          });
        }
        // 放行与拒绝都落审计（库外的写入上面已经 return，不进审计——那是噪音）。
        // 只记「谁动了库里的哪个文件」，内容一律不记（凭据可能就在里面）。
        const bytes = isWrite
          ? Buffer.byteLength(String(args.content ?? ''), 'utf8')
          : Buffer.byteLength(String(args.new_string ?? ''), 'utf8');
        if (verdict.ok) {
          // 库外 / 未配置（skipped）不记：那不是「对记忆库的写入」，记了是噪音。
          // 索引写入**要**记：它通过索引闸门就是一次真实的库内写入。
          // edit 的片段校验（partial）也要记——它确实动了库里的文件。
          if (!verdict.skipped) {
            storeWrites += 1; // 沉淀提醒的判据之一：本会话真的往库里写过东西
            appendAudit(settings.storePath, {
              tool: toolName,
              file: path.basename(String(filePath)),
              bytes,
              verdict: 'allow',
              partial: verdict.partial === true,
            });
            // 另一个触发源：刚往库里写完 —— 笔记变大只可能来自写入，
            // 所以此刻检查最自然，也不必常驻定时器。开关关着时是空转。
            maybeAutoArchive('write');
          }
          return undefined;
        }
        appendAudit(settings.storePath, {
          tool: toolName,
          file: path.basename(String(filePath)),
          bytes,
          verdict: 'deny',
          reason: verdict.reason,
        });
        record({ kind: 'deny', query: brief(String(filePath)), hits: [], reason: verdict.reason });
        return verdict.reason;
      } catch {
        // 守卫同步抛异常时的行为契约里没写，自己兜住：校验器出问题不阻断正常写入，
        // 但把这次异常留痕——免得闸门悄悄失效却没人知道。
        record({ kind: 'deny-error', query: '', hits: [], reason: 'guard threw' });
        return undefined;
      }
    });
  }

  // ── 注册 engramory 技能（写入纪律的正文）──────────────────────────────
  // 纪律与上游 Engramory 协议一致，措辞为本仓库自己的（见 THIRD-PARTY-NOTICES.md）。
  // 收进来的理由与索引闸门相同 —— 本插件要做完整的记忆系统，纪律这一层不能留在外部。
  registerSkill(ctx, {
    registerSkill: settings.registerSkill !== false,
    storePath: settings.storePath,
    maxLines: settings.indexMaxLines,
    maxBytes: settings.indexMaxBytes,
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    try {
      // 一个用户轮只在第一个 step 有「真人消息」，后续 step 只有工具结果 ——
      // 因此这个过滤天然实现了「每轮一次」，而不是每步一次。
      const human = [...decision.messages].reverse().find(isHuman);
      if (!human) return decision;
      const id = String(human.id ?? '');
      // 「这一轮是谁在问」：委派轮（子代理 / Agent Teams）与主对话轮共用同一个记忆库，
      // 而委派提示词里根本没有「先看记忆库」这回事 —— 它们的指针几乎不可能被打开。
      // 不分开数，打开率会被系统性稀释（实测：23 轮注入里一半是「你是只读侦察员…」）。
      // 判据与 DSH 自己的 delegationDepthOf() 一字不差：session.header.delegationDepth 与
      // agent.options.subagentDepth 取大者；两处都没有（老宿主）就当主对话轮，宁可少分不可误杀。
      const roundAgent = payload?.agent;
      const depth = Math.max(
        Number(roundAgent?.session?.header?.delegationDepth) || 0,
        Number(roundAgent?.options?.subagentDepth) || 0,
      );
      const scope = depth > 0 ? 'subagent' : 'main';
      const recordRound = (entry) => record({ ...entry, scope, depth });
      // 同一个 message id 又被喂进来 = 宿主把同一轮重复交给 pre-step：不重复注入。
      // ⚠️ 但**必须记账**：以前这里直接 `return decision`，这一轮在台账里一行都没有 ——
      // 既不进分母，也统计不到原因码，账本对不上。现在与下面「同一 query 跨轮被去重」
      // 那条路同口径：记一行 skip，原因码用既有的 `duplicate`（usage.js 的 REASON_LABELS 里
      // 现成那个，不新造词）。turnCount 与自动归档都不参与：它不是一个新轮。
      if (id && seen.has(id)) {
        recordRound({ kind: 'skip', query: brief(textOf(human)), hits: [], reason: 'duplicate' });
        return decision;
      }
      // 本会话的第几个真实用户轮（沉淀提醒的判据之一）
      turnCount += 1;
      // 自动归档的两个触发源之一：兜底路径。（另一个在闸门放行写入之后。）
      // 开关关着时这里立刻返回，连文件系统都不碰。
      maybeAutoArchive('pre-step');

      // 超长消息在头尾各取一半：只取尾部会把开头交代的主题词整个丢掉（灵枢 #108 同类坑，
      // 实测见 DEFAULTS.queryChars 的注释）。中间一般是粘贴的正文，噪音最多。
      // 头部再按句子边界收敛一次——头 200 字符里往往也大半是错误堆栈，主题只在前一两句。
      const rawQuery = textOf(human);
      const queryChars = Math.max(80, Number(settings.queryChars) || 400);
      const half = Math.floor(queryChars / 2);
      const headPart = rawQuery.slice(0, half * 2).split(/(?<=[。！？!?\n])/).slice(0, 3).join('').slice(0, half);
      const query = rawQuery.length <= queryChars ? rawQuery : `${headPart}\n${rawQuery.slice(-half)}`;
      // 寒暄 / 答话 / 极短消息直接放行不检索：这类消息里没有可检索的意图，
      // 检索只会把噪音塞进上下文（见 CHITCHAT 上方注释的实测数据）。
      const notSearchable = searchableReason(query);
      if (notSearchable) {
        recordRound({ kind: 'skip', query: brief(query), hits: [], reason: notSearchable });
        return decision;
      }

      const storePath = settings.storePath;
      if (!storePath) {
        recordRound({ kind: 'skip', query: brief(query), hits: [], reason: 'store-not-configured' });
        return decision;
      }

      const maxPointers = Math.max(1, Number(settings.maxPointers) || 4);
      // 跨轮轮换去重：最近注入过的条目降权。候选池必须先放大，否则「降权」只是让召回位
      // 空着，而不是把机会让给别的笔记（mneme 的候选池同样按 maxItems × (N+1) 扩容）。
      const rotating = rotationPenalty < 1 && recentInjected.length > 0;
      const pool = rotating ? Math.max(maxPointers * 3, maxPointers + 4) : maxPointers;
      const minScore = Number(settings.minScore || 0);
      // ⚠️ `indexOf()` 回的是**索引对象**（`{ docs, avgLen }`），不是笔记数组 ——
      // 0.13.3 的原因码一开始写成 `!docs.length`，而对象的 `.length` 恒为 undefined，
      // 于是每一轮「零命中」都被记成 `index-empty`（库里没笔记），
      // 把「一条都不匹配」和「全被 minScore 拦掉」两种真问题全糊掉了。数笔记要 `.docs.length`。
      const index = indexOf(storePath);
      const found = search(index, query, pool);
      const scored = found.filter((hit) => hit.score > minScore);
      // 注入去重的键取「轮换前」的命中集：同查询 + 同候选 = 上一轮那批指针还在上下文里。
      // ⚠️ 不能用降权后的结果算 key——轮换自己就会改掉它，去重等于永不生效
      // （2026-10-14 真实库探针实测到）。candidate 是未排序前的原始 top-N，与轮换无关。
      const dedupeKey = `${query}\u0000${scored.slice(0, maxPointers).map((hit) => hit.id).join(',')}`;
      const hits = scored
        .map((hit) =>
          rotating && recentInjected.includes(hit.id) ? { ...hit, score: hit.score * rotationPenalty, rotated: true } : hit,
        )
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
        .slice(0, maxPointers);
      const wantsRemember = settings.nudge && REMEMBER_INTENT.test(query);
      // 沉淀提醒独立于召回命中：命中为 0 时才更需要它，否则长会话会一路空转到结束。
      const wantsSediment =
        settings.nudgeSediment !== false &&
        turnCount >= SEDIMENT_MIN_TURNS &&
        storeWrites === 0 &&
        turnCount - sedimentNudgedAt >= SEDIMENT_COOLDOWN;
      if (wantsSediment) sedimentNudgedAt = turnCount;
      if (!hits.length && !wantsRemember && !wantsSediment) {
        // 三种「空」要分清：库里没东西、一条都不匹配、全被 minScore 拦掉。
        // `topScore` 是校准 minScore 的唯一依据 —— 只写「空」等于把门槛高低的责任推给猜。
        recordRound({
          kind: 'empty',
          query: brief(query),
          hits: [],
          reason: !index.docs.length ? 'index-empty' : !found.length ? 'no-hits' : 'below-min-score',
          minScore,
          topScore: found[0] ? Number(found[0].score.toFixed(3)) : undefined,
        });
        return decision;
      }

      const header = RECALL_HEADER;
      const { budget, lines, shown, used, collapsed, dropped } = renderPointers(hits, {
        maxChars: settings.maxChars,
      });
      const parts = lines.length ? [header, ...lines] : [];
      if (wantsRemember) {
        const nudge =
          '[提示] 这句话里有「长期记住」的意图。若它是 settled 事实（决策 / 偏好 / 踩坑与解法），按 Engramory 纪律落盘：一条一文件 + 索引加一行；只是当前状态（版本号、进度）就不要记。';
        if (used + nudge.length + 1 <= budget + 120) parts.push(nudge);
      }
      if (wantsSediment) {
        // 只陈述事实 + 给判据，不命令。没东西可记就跳过——提醒本身不该变成噪音。
        parts.push(
          `[engramory 沉淀提醒] 本会话已进行 ${turnCount} 轮，记忆库还没有任何新增或更新。若这期间定下了决策、踩了坑、或摸清了偏好，按 Engramory 纪律落盘（一条一文件 + 索引一行）；只是当前状态（版本号、进度）就别记。没有值得记的就跳过。`,
        );
      }
      if (!parts.length) {
        // 命中了、却一条都没塞进预算（文件名都放不下）：这是一次**真的没注入**，
        // 不能静默返回 —— 静默的话账本里这一轮等于不存在，「为什么这一轮模型没看到记忆」
        // 就永远查不出来（面板、尺子、灰度对比全靠账本这一行）。
        recordRound({
          kind: 'skip',
          query: brief(query),
          hits: [],
          reason: 'budget-too-small',
          budget,
          // `spent: 0` 不是凑数：宿主侧的落盘白名单要求「上限与用掉的量同时在场」才写这两项，
          // 少了它，这一轮在账本里就只剩一个原因码，「到底是预算配小了还是分数不够」看不出来。
          spent: 0,
          topScore: Number((hits[0]?.score ?? 0).toFixed(3)),
        });
        return decision;
      }

      const text = parts.join('\n');
      // 注入去重（mnemon `src/host/lifecycle.ts:339-345`）：上一轮那份指针还在上下文里，别重复塞。
      // 键在检索段算好（`dedupeKey`，取轮换前的命中集），这里只做比较。
      // ⚠️ 沉淀提醒**不参与去重**：它说的是「本会话一直没写过库」，与上一轮注入过什么无关；
      // 被去重吞掉的话，长会话里恰好是「上一轮也没命中」那几次最需要它。
      if (settings.dedupeInjection !== false && dedupeKey === lastInjectedKey && !wantsSediment) {
        if (id) {
          seen.add(id);
          seenOrder.push(id);
          if (seenOrder.length > 500) seen.delete(seenOrder.shift());
        }
        recordRound({ kind: 'skip', query: brief(query), hits: [], reason: 'duplicate' });
        return decision;
      }
      lastInjectedKey = dedupeKey;
      rememberInjected(shown.map((hit) => hit.id));
      rememberInjectedAt(shown.map((hit) => hit.id));

      if (id) {
        seen.add(id);
        seenOrder.push(id);
        if (seenOrder.length > 500) seen.delete(seenOrder.shift());
      }

      recordRound({
        kind: lines.length ? 'hit' : 'sediment',
        query: brief(query),
        hits: shown.map((hit, rank) => ({
          id: hit.id,
          score: Number((hit.score ?? 0).toFixed(3)),
          section: hit.section ?? '',
          bytes: hit.bytes ?? 0,
          collapsed: hit.collapsed === true,
          rotated: hit.rotated === true,
          // 名次落盘：预算现在是**按名次**分的（第一名分到的字数最多），
          // 不记名次的话，「这条为什么只带进来半句」在账本里就无从复算。
          rank,
        })),
        injected: shown.length,
        collapsed,
        dropped,
        // 预算的「上限 / 用掉多少」一起落盘：不然「该不该抬 maxChars」只能靠猜 ——
        // 只有塌缩次数，看不出是「几乎顶满」还是「富余大半」。
        budget,
        spent: used,
        chars: text.length,
        // 本轮最高分：minScore 定得高不高，这是唯一能校准的依据（空轮走的是另一支，
        // 那里早就记了 topScore —— 有命中的轮次同样要记，否则「拦掉了多少好线索」两头都看不见）。
        topScore: Number((hits[0]?.score ?? 0).toFixed(3)),
        nudge: wantsRemember,
        sediment: wantsSediment,
      });

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        // 会话格式 v4 只接受「生产者自有」的 source.kind：裸 'plugin' 已退役，
        // 用它会在会话保存时报 SessionFormatError 并把整轮弄挂（2026-10-08 实测踩到）。
        // form:'notice' 要求带 summary，客户端据此渲染成上下文块，而不是伪造的用户发言。
        source: {
          kind: `plugin:${PRODUCER}`,
          form: 'notice',
          summary: lines.length
            ? `engramory 召回 ${lines.length} 条${wantsRemember ? ' + 记忆提示' : ''}`
            : 'engramory 沉淀提醒',
        },
      };
      return { ...decision, messages: [...decision.messages, message] };
    } catch {
      // 召回失败绝不影响这一轮：原样放行。
      return decision;
    }
  });

  // ── 宿主 HTTP 路由：给「记忆」标签页喂数据 ──────────────────────────────
  // 用 ctx.inject 而不是在导出里硬写 inject: ['webServer']：Electron 载体走 file:// + IPC，
  // 可能压根没有 webServer 服务；那时召回功能必须照常工作，只是没有面板数据可看。
  // 路由是只读的（不写记忆库、不改状态），且 webserver 默认只绑定回环。
  // 体检要把整个库读一遍，而面板每 3 秒轮询一次 —— 按 30 秒 TTL 缓存，别每轮重算。
  const AUDIT_TTL_MS = 30_000;
  let auditCache = { key: '', at: 0, value: null };
  let archiveCache = { key: '', at: 0, value: null };

  /**
   * 归档计划（纯读，不写任何文件）。
   * 面板点「执行」时才真的动库，且每次都要重新出具计划 —— 计划是有时效的：
   * 中间若有人改了文件，旧的计划必须作废（applyArchive 自己还会再核一遍批次标题）。
   */
  const archivePlans = (storePath) => {
    const fresh = archiveCache.key === storePath && Date.now() - archiveCache.at < AUDIT_TTL_MS;
    if (fresh) return archiveCache.value;
    let value;
    try {
      value = planArchive(storePath);
    } catch (err) {
      value = { plans: [], skipped: [], crashed: String(err?.message ?? err) };
    }
    archiveCache = { key: storePath, at: Date.now(), value };
    return value;
  };

  // ── 自动归档（默认关，理由见 DEFAULTS.autoArchive 的注释）────────────────────
  // 两个触发源：'write'（闸门刚放行一次写入）与 'pre-step'（每 10 分钟兜底一次，
  // 管住绕过闸门的手动改文件）。开关关着时这一整段是空转，一次文件系统都不碰。
  const AUTO_ARCHIVE_TTL_MS = 10 * 60 * 1000;
  let autoArchiveCheckedAt = 0;
  /** 本会话内已知搬不动的文件：别每次写入都拿同一堵墙撞一遍（pre-step 时会清空重试）。 */
  const autoArchiveStuck = new Set();

  const maybeAutoArchive = (trigger) => {
    if (settings.autoArchive !== true) return null;
    const storePath = settings.storePath;
    if (!storePath) return null;
    if (trigger === 'pre-step') {
      const now = Date.now();
      if (now - autoArchiveCheckedAt < AUTO_ARCHIVE_TTL_MS) return null;
      autoArchiveCheckedAt = now;
      autoArchiveStuck.clear(); // 兜底路径给失败过的文件一次新机会
    }
    try {
      const { plans } = planArchive(storePath);
      const todo = plans.filter((plan) => !autoArchiveStuck.has(plan.file));
      if (!todo.length) return null;
      const attempted = [];
      for (const plan of todo) {
        const outcome = applyArchive(storePath, plan);
        if (!outcome.ok) {
          // 搬不动多半是「搬完主文件仍超单篇上限」——那是闸门在正确地拒绝，
          // 不是归档坏了。记住它，别在每次写入后重试；把原因留在日志里等人看。
          autoArchiveStuck.add(plan.file);
          attempted.push({ file: plan.file, ok: false, reason: outcome.reason });
          continue;
        }
        appendAudit(storePath, {
          tool: 'archive',
          file: plan.file,
          bytes: outcome.movedBytes,
          verdict: 'allow',
          reason: `自动归档（触发：${trigger}）搬走 ${outcome.moved} 个批次 → ${outcome.historyFiles.join('、')}；备份 ${outcome.backupDir}`,
        });
        attempted.push({ file: plan.file, ok: true, moved: outcome.moved, movedBytes: outcome.movedBytes });
      }
      if (!attempted.length) return null;
      archiveCache = { key: '', at: 0, value: null }; // 计划已作废，下次读状态重新算
      record({
        kind: 'archive-auto',
        query: trigger,
        hits: [],
        injected: attempted.filter((a) => a.ok).length,
        reason: attempted
          .map((a) =>
            a.ok
              ? `${a.file} 搬走 ${a.moved} 个批次 / ${Math.round(a.movedBytes / 1024)}KB`
              : `${a.file} 没搬成：${a.reason}`,
          )
          .join('；'),
      });
      return attempted;
    } catch (err) {
      // 自动归档出任何问题都不能拖垮这一轮：吞掉异常，只在召回日志里留一行。
      record({ kind: 'archive-auto', query: trigger, hits: [], reason: `自动归档异常：${String(err?.message ?? err)}` });
      return null;
    }
  };

  const storeSnapshot = () => {
    const storePath = settings.storePath;
    const docs = storePath ? readDocs(storePath) : [];
    const byId = new Map();
    for (const doc of docs) {
      const prev = byId.get(doc.id);
      if (prev) {
        prev.bytes += Buffer.byteLength(doc.body, 'utf8');
        prev.sections += 1;
        continue;
      }
      byId.set(doc.id, {
        file: doc.id,
        title: doc.title ?? '',
        description: doc.description ?? '',
        bytes: Buffer.byteLength(doc.body, 'utf8'),
        sections: 1,
        aliases: doc.aliases ?? [],
      });
    }
    const notes = [...byId.values()].sort((a, b) => b.bytes - a.bytes);

    // 索引是记忆库的入口，面板要能直接显示它（只读）。
    let index = { path: '', lines: 0, bytes: 0, text: '' };
    if (storePath) {
      // storePath 已在配置归一那一步去过尾分隔符，这里直接拼（不再各自去一遍）。用 path.join
      // 是为了让「库就是根（`/`）」这种配置拼出 `/MEMORY.md` 而不是 `//MEMORY.md`。
      const indexPath = path.join(storePath, 'MEMORY.md');
      try {
        const text = readFileSync(indexPath, 'utf8');
        index = { path: indexPath, lines: text.split('\n').length, bytes: Buffer.byteLength(text, 'utf8'), text };
      } catch {
        index = { path: indexPath, lines: 0, bytes: 0, text: '', missing: true };
      }
    }

    // 体检结果（结构一致性 / 纪律 / 可疑信号）。崩溃了也只是一个 error 条目，绝不拖垮召回。
    let audit = null;
    if (storePath) {
      const fresh = auditCache.key === storePath && Date.now() - auditCache.at < AUDIT_TTL_MS;
      if (fresh) {
        audit = auditCache.value;
      } else {
        try {
          audit = auditStore(storePath);
        } catch (err) {
          audit = {
            findings: [{ severity: 'error', code: 'audit-crashed', message: `体检崩了：${err?.message ?? err}`, files: [] }],
            summary: { notes: 0, indexLines: 0, indexBytes: 0, bySeverity: { error: 1, warn: 0, info: 0 } },
          };
        }
        auditCache = { key: storePath, at: Date.now(), value: audit };
      }
    }

    return {
      store: storePath,
      audit,
      // 写入审计（落盘、可回放）。体检回答「库现在什么样」，审计回答「谁把它改成这样的」。
      writeAudit: storePath ? { epoch: GUARD_EPOCH, entries: readAudit(storePath, 40) } : { epoch: GUARD_EPOCH, entries: [] },
      // 归档计划：只出计划不动手。真正的执行在 POST /api/engramory-recall/archive。
      archive: storePath ? archivePlans(storePath) : { plans: [], skipped: [] },
      // 技能注册的自报状态。这条链失败时**完全静默**（注入表没就绪、或同名技能已被
      // dsh-engramory 注册而注册表选择抛错），不回报就只能在摘掉那个插件之后才发现。
      skill: skillStatus(),
      config: {
        enabled: settings.enabled !== false,
        maxPointers: Number(settings.maxPointers) || 4,
        maxChars: Number(settings.maxChars) || 480,
        minScore: Number(settings.minScore) || 0,
        nudge: settings.nudge !== false,
        guardWrites: settings.guardWrites !== false,
        nudgeSediment: settings.nudgeSediment !== false,
        sedimentMinTurns: SEDIMENT_MIN_TURNS,
        autoArchive: settings.autoArchive === true,
        indexMaxLines: Number(settings.indexMaxLines) || DEFAULT_MAX_INDEX_LINES,
        indexMaxBytes: Number(settings.indexMaxBytes) || DEFAULT_MAX_INDEX_BYTES,
        registerSkill: settings.registerSkill !== false,
        recencyWeight: Number(settings.recencyWeight) || 0,
        rotationPenalty: Number(settings.rotationPenalty ?? 0),
        dedupeInjection: settings.dedupeInjection !== false,
        queryChars: Number(settings.queryChars) || 400,
        // 面板要能一眼看出「这个装法会不会发模型请求」——两个开关都关着就是绝对不发。
        semanticConflicts: settings.semanticConflicts === true,
        semanticSummary: settings.semanticSummary === true,
      },
      totals: {
        notes: notes.length,
        docs: docs.length,
        bytes: notes.reduce((sum, note) => sum + note.bytes, 0),
      },
      index,
      notes,
    };
  };

  // 读 JSON 请求体。限 8KB —— 归档请求就一个文件名，没有理由收大包。
  const readBody = (req, limit = 8 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const sendJson = (res, status, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  };

  ctx.inject(['webServer'], (webCtx) => {
    const disposers = [];

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: '/api/engramory-recall/state',
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          sendJson(res, 200, {
            ...storeSnapshot(),
            log: recallLog,
            // 落盘日志的汇总（打开率/位置级曲线/预算压力/原因分布/注入分/minScore 代价曲线）与四句判据 ——
            // 面板与 `npm run recall:stats` 走同一套算法（usage.js），免得两处口径漂移。
            usage: (() => {
              const summary = summarizeUsage(readUsage(settings.storePath), {
                maxPointers: settings.maxPointers,
              });
              return {
                ...summary,
                verdicts: {
                  open: usageVerdict(summary),
                  budget: budgetVerdict(summary),
                  truncation: truncationVerdict(summary),
                  reason: reasonVerdict(summary),
                  curve: scoreCurveVerdict(summary.scoreCurve),
                },
              };
            })(),
            generatedAt: Date.now(),
          });
        },
      }),
    );

    // 归档执行口。这是本插件唯一会「动记忆库」的 HTTP 接口，所以刻意做得笨：
    // 必须 POST、必须带 confirm:true、文件名必须原样命中当前计划 —— 不做模糊匹配、
    // 不接受「归档所有超标的」。原因：面板给的是「人看一眼再点」的两段式，
    // 接口就不该留一个能批量动手的后门。
    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: '/api/engramory-recall/archive',
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          const storePath = settings.storePath;
          if (!storePath) {
            sendJson(res, 400, { ok: false, reason: 'storePath 没配' });
            return;
          }

          let payload;
          try {
            payload = JSON.parse((await readBody(req)) || '{}');
          } catch (err) {
            sendJson(res, 400, { ok: false, reason: `请求体不是 JSON：${err?.message ?? err}` });
            return;
          }
          if (payload?.confirm !== true) {
            sendJson(res, 400, { ok: false, reason: '缺 confirm:true —— 归档会改真实文件，必须显式确认' });
            return;
          }
          const file = String(payload?.file ?? '').trim();
          if (!file) {
            sendJson(res, 400, { ok: false, reason: '缺 file' });
            return;
          }

          // 计划是 30 秒 TTL 的缓存，但执行前必须现算一遍：中间有人改过文件的话，
          // 旧计划里的字节数与批次个数就已经不是事实了。
          let plan = null;
          let scanned;
          try {
            scanned = planArchive(storePath);
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: `重算计划失败：${err?.message ?? err}` });
            return;
          }
          archiveCache = { key: storePath, at: Date.now(), value: scanned };
          plan = scanned.plans.find((p) => p.file === file) ?? null;
          if (!plan) {
            const why = scanned.skipped.find((s) => s.file === file);
            sendJson(res, 404, {
              ok: false,
              reason: why ? `这篇现在不该归档：${why.reason}` : `没找到可归档计划：${file}`,
            });
            return;
          }

          let result;
          try {
            result = applyArchive(storePath, plan);
          } catch (err) {
            result = { ok: false, reason: `归档抛异常：${err?.message ?? err}` };
          }
          // 不管成没成，刚算的那份计划都不能再当缓存用：成功后它已过期，
          // 失败后重算一次也正好让人看见「为什么还没成」。
          archiveCache = { key: '', at: 0, value: null };

          // 归档也是「落在记忆库里的写」，一样要留痕 —— 审计要回答的是
          // 「谁把它改成这样的」，而拆文件恰恰是最容易让人事后看不懂的一种改法。
          appendAudit(storePath, {
            tool: 'archive',
            file,
            bytes: plan.bytes,
            verdict: result.ok ? 'allow' : 'deny',
            reason: result.ok
              ? `搬走 ${result.moved} 个批次 → ${(result.historyFiles ?? []).join(', ') || '-'}；备份 ${result.backupDir ?? '-'}`
              : String(result.reason ?? '未知原因'),
          });
          record({
            kind: result.ok ? 'archive' : 'deny',
            query: brief(file),
            hits: [],
            reason: result.ok
              ? `${Math.round(plan.bytes / 1024)}KB → ${Math.round((result.keptBytes ?? plan.keptBytes) / 1024)}KB`
              : String(result.reason ?? '归档失败'),
          });

          sendJson(res, result.ok ? 200 : 400, { ...result, file });
        },
      }),
    );

    return () => disposers.forEach((d) => d());
  });
}
