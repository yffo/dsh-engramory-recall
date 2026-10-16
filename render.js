/**
 * 召回指针的**渲染与预算分配**：把命中列表切成「注入文本 + 记账明细」。
 *
 * 为什么单独一个模块：预算怎么花是这一期的核心变量（每条给多少字、装不下时怎么降级），
 * 而它原来长在 pre-step 钩子中间 —— 钩子里的代码没法单独量，`bench:foundation` 只能
 * 重新实现一遍渲染，那样尺子量的就不是真跑的那条路。抽出来之后，插件与基准跑的是
 * 同一个函数（`bench/foundation.mjs` 直接 import 这里）。
 *
 * 三条既有约束（别在优化里弄丢）：
 *   1. **零常驻成本**：一条都装不下时返回空 `lines`，调用方据此不注入（`parts.length` 为 0）。
 *   2. **降级不静默**：整条装不下 → 塌缩成只有文件名（模型至少知道有这么一篇）；
 *      连文件名都装不下 → 计入 `dropped`，并补一句「另有 N 条命中因预算未列出」。
 *   3. **记账口径**：`used` 从 `header.length` 起算，`bytes` 记的是该行**实际写进上下文**的
 *      字符数 —— 台账与面板的「花掉多少预算」全靠它，改渲染就不能改这个口径。
 */

/** 注入头（模型看到这段就知道后面是记忆库指针，不是用户发言）。 */
export const RECALL_HEADER =
  '[engramory 自动召回] 以下是记忆库里可能相关的既有条目（只是指针；需要细节时用 read 打开 ~/memory/engramory/<文件名>）：';

/** 预算下限：`maxChars` 配得太小时至少留这么多，否则连一条文件名都放不下。 */
export const MIN_BUDGET = 160;
/** `maxChars` 缺省值（与 index.js 的 DEFAULTS 保持一致）。 */
export const DEFAULT_MAX_CHARS = 480;
/** 单条片段的默认上限（`maxChars` 之外的二级上限，防止第一条把预算吃光）。 */
export const DEFAULT_SNIPPET_CHARS = 64;
/** 名次加权方案里，第一名最多能拿到多少字（句子级片段比 64 字更可能装下整句话）。 */
export const MAX_SNIPPET_CHARS = 200;
/** 名次加权方案里，任何一条只要还给片段，就至少给这么多字（再少就不如只给文件名）。 */
export const MIN_SNIPPET_CHARS = 24;
/**
 * 名次衰减：第 i 名的权重是 `1 / (1 + decay * i)`。
 *
 * 为什么按名次给而不是人人均分：注入行是给模型**判断要不要去 read** 用的，
 * 而「第一名」几乎就是这一轮唯一会被打开的那条（真实账本里打开率 4–5%）。
 * 均分的结果是每条都只够半句话 —— 48% 的题里连决定性那个词都进不去。
 * 但衰减也不能太狠：第 2–4 名拿到的片段太短，模型就没了「这篇可能相关」的判断依据，
 * 所以按下限 24 字托底，多出来的额度再给第一名。这个 0.5 是拿 tune 那半调出来的。
 */
export const RANK_DECAY = 0.5;

/**
 * 按名次算每条指针能分到多少字。
 *
 * 预算是硬约束，所以这里先把「固定开销」扣掉：每条指针至少要有 `- ` + 文件名 + ` — ` + 换行，
 * 剩下的才是能分给片段的额度。装不下时**先减少片段条数**（尾部几条塌缩成只有文件名），
 * 而不是把每条都切成四五个字 —— 后者让每个片段都失去判断价值。
 *
 * @param {Array<{id?: string}>} hits
 * @param {{maxChars?: number, header?: string, maxSnippetChars?: number, decay?: number}} [options]
 * @returns {number[]} 与 hits 等长的逐条上限（尾部让位的几条给下限值，装不下时由阶梯降级接管）
 */
export function planSnippets(hits, options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const headerLen = String(options.header ?? RECALL_HEADER).length;
  const budget = Math.max(MIN_BUDGET, Number(options.maxChars) || DEFAULT_MAX_CHARS);
  const maxSnippet = Math.max(MIN_SNIPPET_CHARS, Number(options.maxSnippetChars) || MAX_SNIPPET_CHARS);
  const decay = Number.isFinite(Number(options.decay)) ? Math.max(0, Number(options.decay)) : RANK_DECAY;
  // 固定开销 = "- " + 文件名 + " — " + 换行
  const overhead = list.map((hit) => 4 + String(hit?.id ?? '').length + 1);
  const roomFor = (count) => budget - headerLen - overhead.slice(0, count).reduce((sum, n) => sum + n, 0);
  let count = list.length;
  while (count > 1 && roomFor(count) / count < MIN_SNIPPET_CHARS) count -= 1;
  const room = Math.max(0, roomFor(Math.max(1, count)));
  const weights = [];
  for (let i = 0; i < count; i += 1) weights.push(1 / (1 + decay * i));
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const plan = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i >= count) {
      plan.push(MIN_SNIPPET_CHARS);
      continue;
    }
    const share = (room * weights[i]) / total;
    plan.push(Math.max(MIN_SNIPPET_CHARS, Math.min(maxSnippet, Math.floor(share))));
  }
  return plan;
}

/**
 * 渲染注入文本。
 *
 * @param {Array<{id: string, score?: number, snippet?: string, section?: string, rotated?: boolean}>} hits
 * @param {{maxChars?: number, header?: string, snippetChars?: number, snippetPlan?: number[], maxSnippetChars?: number, decay?: number}} [options]
 *   三条路，按优先级：
 *   1. `snippetPlan` —— 逐条上限，调用方说了算（基准的 `--no-plan` 走这条，用来复现旧行为）；
 *   2. `snippetChars` —— 每条**统一**上限（消融/对照用，也是老口径）；
 *   3. 都不给 —— `planSnippets()` 按名次分配（新默认）。
 * @returns {{header: string, budget: number, lines: string[], shown: object[], used: number, collapsed: number, dropped: number}}
 */
export function renderPointers(hits, options = {}) {
  const header = options.header ?? RECALL_HEADER;
  const budget = Math.max(MIN_BUDGET, Number(options.maxChars) || DEFAULT_MAX_CHARS);
  const snippetChars = Math.max(1, Number(options.snippetChars) || DEFAULT_SNIPPET_CHARS);
  const list = Array.isArray(hits) ? hits : [];
  const plan = Array.isArray(options.snippetPlan)
    ? options.snippetPlan
    : Number(options.snippetChars)
      ? null
      : planSnippets(list, { ...options, header, budget });
  const lines = [];
  const shown = [];
  let used = header.length;
  let collapsed = 0;
  let dropped = 0;
  for (let i = 0; i < list.length; i += 1) {
    const hit = list[i];
    const cap = Math.max(1, Number(plan?.[i]) || snippetChars);
    const full = `- ${hit.id} — ${clip(hit.snippet, cap)}`;
    if (used + full.length + 1 <= budget) {
      used += full.length + 1;
      lines.push(full);
      // `line` 是该条**真正写进上下文**的那行文本（`shown` 里跟着它，方便尺子/测试逐字对；
      // 记账只挑 id/score/bytes/collapsed 这几个字段，多带一个字段不改变台账口径）。
      shown.push({ ...hit, bytes: full.length, line: full });
      continue;
    }
    // 预算装不下完整条目时先塌缩成「只有文件名」（mneme `src/inject.js:232` 的 render
    // 就是这么降级的）：模型至少知道有这么一篇，比整条静默丢掉有用。
    const bare = `- ${hit.id}`;
    if (used + bare.length + 1 <= budget) {
      used += bare.length + 1;
      lines.push(bare);
      shown.push({ ...hit, collapsed: true, bytes: bare.length, line: bare });
      collapsed += 1;
      continue;
    }
    dropped += 1;
  }
  // 一条都没列出来时**不补**说明句：那行只说「有几条没列出来」，却一条名字都不给，
  // 模型拿着它无从下手 —— 整轮注入就只剩「头部 + 另有 N 条」，纯噪音。
  // 宁可这一轮空着，让调用方按「预算太小」记账（`budget-too-small`），
  // 这样账本上看得出来是预算配小了、还是压根没命中。
  if (dropped && lines.length) {
    // 连文件名都装不下：补一句说明，别让「有命中却没显示」变成静默丢失。
    const note = `（另有 ${dropped} 条命中因预算未列出）`;
    if (used + note.length + 1 <= budget + 80) {
      used += note.length + 1;
      lines.push(note);
    }
  }
  return { header, budget, lines, shown, used, collapsed, dropped };
}

/** 折叠空白并截断到 `max` 字符；超长时留一个省略号，且不把代理对切成半个。 */
export function clip(text, max) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  const before = s.charCodeAt(cut - 1);
  if (cut > 0 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}
