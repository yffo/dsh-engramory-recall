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

/**
 * 渲染注入文本。
 *
 * @param {Array<{id: string, score?: number, snippet?: string, section?: string, rotated?: boolean}>} hits
 * @param {{maxChars?: number, header?: string, snippetChars?: number, snippetPlan?: number[]}} [options]
 *   `snippetChars` 是每条片段的**统一**上限；`snippetPlan` 是**逐条**上限（按顺序对应 hits，
 *   缺省位置退回 snippetChars）—— 让第一名多分一点、后面少分一点就靠它。
 * @returns {{header: string, budget: number, lines: string[], shown: object[], used: number, collapsed: number, dropped: number}}
 */
export function renderPointers(hits, options = {}) {
  const header = options.header ?? RECALL_HEADER;
  const budget = Math.max(MIN_BUDGET, Number(options.maxChars) || DEFAULT_MAX_CHARS);
  const snippetChars = Math.max(1, Number(options.snippetChars) || DEFAULT_SNIPPET_CHARS);
  const plan = Array.isArray(options.snippetPlan) ? options.snippetPlan : null;
  const lines = [];
  const shown = [];
  let used = header.length;
  let collapsed = 0;
  let dropped = 0;
  const list = Array.isArray(hits) ? hits : [];
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
  if (dropped) {
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
