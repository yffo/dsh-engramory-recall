#!/usr/bin/env node
/**
 * `bench/recall-eval.mjs` —— 记忆召回评测的判分器与跑分器（第七期 7.1）。
 *
 * 为什么要有它：本仓库此前唯一的质量指标是「打开率 2.4%」（131 轮里 16 条指针后来被打开）。
 * 它证明**指针后来被打开**，证明不了**回答变好了**。没有判分器，7.2~7.4 的改动只能靠感觉，
 * 而感觉不算数据。所以这把尺子量的是最外层的事：**同一个题集**，在
 * 「不注入记忆 / 注入指针（现状）/ 只给一行提示」三档下各答成什么样、各花多少上下文。
 * 题集格式与判分口径按 `plans/engramory-differentiation-plan.md` §11。
 *
 * 判分口径（规则优先，逐条可复算）：
 *   - `expect` 是一个数组，**每一项是一组关键词**，所有项都命中才算「事实齐了」；
 *   - 组内用 `|` 分隔多个写法，**任一命中即算这一项命中**（`"minScore|相关度门槛"`）；
 *   - 匹配是**大小写不敏感的子串包含**，标点与空格按原样比 —— 要容忍写法差异，就多写一个
 *     `|` 分支（例：`"overflow: clip|overflow-clip"`），不要指望判定器去猜；
 *   - `forbid` 命中任意一项 ⇒ 该题**失败**（它装的是旧事实 / 错做法）；
 *   - 空答案（`--answerer none`）在所有项上都落空 ⇒ 这一档就是「地板」。
 *
 * `forbid` 只放**字面量**（路径 / 配置键值 / 命令 / 专名），不放自然语言主张：
 * 中文否定句里包含肯定子串（「不建议开启 X」包含「建议开启 X」），按子串判定必然误伤。
 *
 * 成本口径（写在明面上，别假装它是精确分词）：
 *   - `injectedTokens = Math.ceil(injectedChars / 4)` —— 「4 字符 ≈ 1 token」的粗估。
 *     中文实际约 1 字 ≈ 0.6~1 token，所以这个数对中文偏**乐观**；它的用途是横向比三档，
 *     不是账单（要账单看 `npm run recall:report` 的账本）。
 *   - `elapsedMs` = 该题端到端（召回 + 回答器 + 判分）；`recallMs` 单列召回那一段。
 *   - 建索引只做一次（整库共享），**不进任何一题的 `recallMs`**，单独报在表头 —— 否则
 *     第一题会背上整库的账，三档对照立刻失真。
 *
 * 与插件主流程的关系（push 档凭什么算「现状」）：
 *   `readDocs` → `buildIndex` → `search` → `applyGate` → `renderPointers`，与
 *   `index.js` 自动召回那一段是**同一批函数、同一套默认值**（默认值来自 `index.js` 的
 *   `DEFAULTS`，不在这里另抄一份）。差的三件事都是**会话态**，单轮评测里天然不存在：
 *   ① 跨轮轮换降权（`rotationPenalty`）与注入去重（`dedupeInjection`）需要上一轮的注入记录；
 *   ② 门控的账本证据（`confidence.js` 的 `stats`）来自真实 `.engramory-recall.jsonl`，
 *      评测里喂空账本 = 假造证据；空账本下默认档 `assist` 对每一条都是 `keep`
 *      （`confidence.js:292-345`），所以省略它只少掉 `stale-project` 那一类降权，
 *      门控的**库侧**输入（`docs`，用笔记 mtime 判过期）照常喂进去；
 *   ③ 沉淀提醒 / 「长期记住」提示是会话级触发，与题面无关，不注入。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, search } from '../bm25.js';
import { applyGate } from '../confidence.js';
import { DEFAULTS, pullHintText } from '../index.js';
import { renderPointers } from '../render.js';
import { corpusFingerprint, readDocs } from '../store.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 三个对照臂。`push` = 现状（每轮注入指针），`none` = 不注入任何记忆，`pull` = 只给一行「记忆可用」。 */
export const ARMS = ['none', 'push', 'pull'];
/**
 * 第四个臂（0.22.0 起）：`hybrid` 只推最靠前的 1 条。
 *
 * **为什么不并进 `ARMS`**：`ARMS` 钉住的不只是三个名字，还有它们的顺序与语义 ——
 * 报表里「没跑的档也占一个位置」的占位清单、`arms[].ran:false` 的读法、以及 0.21.0
 * 之前那些结果文件的可比性，全都以「三档」为前提。往 `ARMS` 里塞一项会让老结果读起来变形。
 * 所以 `hybrid` 由 `--mode hybrid` 显式点名，**跑过才在报表里占位**。
 */
export const OPTIONAL_ARMS = ['hybrid'];
/** 四臂的规范顺序（报表并排时的列序）。 */
export const ALL_ARMS = ['none', 'push', 'hybrid', 'pull'];
/** 题集的四类（§11 冻结）。分不开类就没法回答「哪一类记忆最有用」。 */
export const KINDS = ['preference', 'fact-recall', 'correction', 'procedure'];
export const ANSWERERS = ['none', 'cmd', 'file'];
export const DEFAULT_TASKS_DIR = join(root, 'bench', 'eval-tasks');
export const DEFAULT_RESULTS_DIR = join(root, 'bench', 'eval-results');
export const DEFAULT_STORE = process.env.ENGRAMORY_STORE || join(homedir(), 'memory', 'engramory');
/** 成本换算口径（见文件头）。改这个数会让历史结果的 token 列不可比，所以要改就一起改文档。 */
export const TOKENS_PER_CHAR = 4;
/**
 * pull 档注入的那一行**不在这里**：它来自插件本体的 `pullHintText()`（`index.js`）。
 * 0.21.0 收口前的教训：评测器自己写一句提示，量出来的就不是插件的成本 ——
 * 同一份数据会说两个故事，而两边都「没错」。要让别人量，就得让它量真的那一句。
 */

export const estimateTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / TOKENS_PER_CHAR);

// ── 判分：三段小函数，测试可以逐个钉住 ───────────────────────────────────────

/**
 * 判分前统一折叠：NFKC（全角→半角）+ 转小写 + 折叠空白。
 * NFKC 这一层是必须的：中文答案里 `gate： off`（全角冒号）和 `gate: off` 是同一个意思，
 * 而笔记本身就有全角字符（例如 `重复提醒＝噪音` 用了全角等号），不归一化会把同一个短语
 * 判成两条。两边（判据、答案）都过这一层，所以是对称的，不会偏袒某一方。
 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一项关键词拆成候选写法（`|` 分隔，全角 `｜` 同等对待）。
 * 全角那一半是防呆：中文输入法下打出 `｜` 是很自然的事，只认半角会让整组关键词
 * **永远匹配不上**，而且失败得毫无声息（题集看起来完全正常）。
 * 全是分隔符时返回空数组 —— 调用方按「题集坏了」处理。
 */
export function termAlternatives(term) {
  return String(term)
    .split(/[|｜]/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

/** 一项关键词是否命中。`hay` 应已 `normalizeText`（judge 里只归一化一次，别在循环里反复做）。 */
export function matchesTerm(hay, term) {
  return termAlternatives(term).some((alt) => hay.includes(alt));
}

/**
 * 判一题。返回 §11 要的三个字段（多一个 `pass`）。
 * 空答案不是特例：它什么都匹配不上，于是 expect 全落空 —— 「地板」就是这么量出来的。
 */
export function judge(task, answer) {
  const hay = normalizeText(answer);
  const hitExpect = [];
  const missedExpect = [];
  const hitsForbid = [];
  for (const term of task.expect ?? []) (matchesTerm(hay, term) ? hitExpect : missedExpect).push(term);
  for (const term of task.forbid ?? []) if (matchesTerm(hay, term)) hitsForbid.push(term);
  return { pass: missedExpect.length === 0 && hitsForbid.length === 0, hitExpect, missedExpect, hitsForbid };
}

// ── 题集读取与校验：坏数据一律「判不了 + 报告」，绝不抛 ────────────────────────

/** 读一个关键词数组。任何类型不对都返回 `{ error }`：宁可判不了，也不猜作者想说什么。 */
function readTerms(value, field, id) {
  if (value === undefined || value === null) return { list: [] };
  if (!Array.isArray(value)) return { error: `${id} 的 ${field} 不是数组（${typeof value}）` };
  const list = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const shown = item === null ? 'null' : typeof item;
    if (typeof item !== 'string') return { error: `${id} 的 ${field}[${i}] 不是字符串（${shown}）` };
    if (!item.trim()) return { error: `${id} 的 ${field}[${i}] 是空字符串` };
    if (!termAlternatives(item).length) return { error: `${id} 的 ${field}[${i}] 只有分隔符，没有任何关键词` };
    list.push(item.trim());
  }
  return { list };
}

/**
 * 校验一题。返回 `{ task }` 或 `{ reason }` —— 二选一，不会有半个任务。
 * `source` 缺失**不判不了**（它是出处，不影响判分），但要记警告：§11 要求每题都能回答
 * 「这条判据是从哪条真实记忆来的」，警告是给加题的人看的，判分器不替他把这件事做掉。
 */
export function validateTask(raw, position = 0, seen = new Set()) {
  const where = `tasks[${position}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: `${where} 不是一个对象` };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return { reason: `${where} 的 id 缺失或不是非空字符串` };
  if (seen.has(id)) return { reason: `id 重复：${id}` };
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!KINDS.includes(kind)) return { reason: `${id} 的 kind 缺失或不在四类里（${kind || '空'}）` };
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return { reason: `${id} 的 prompt 缺失或不是非空字符串` };
  const expect = readTerms(raw.expect, 'expect', id);
  if (expect.error) return { reason: expect.error };
  const forbid = readTerms(raw.forbid, 'forbid', id);
  if (forbid.error) return { reason: forbid.error };
  if (!expect.list.length && !forbid.list.length) {
    return { reason: `${id} 的 expect 与 forbid 都是空的：没有任何可判的判据` };
  }
  const warnings = [];
  let source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (!source) {
    warnings.push(`${id} 没写 source（判据出处），按空记`);
    source = '';
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  return { task: { id, kind, prompt, expect: expect.list, forbid: forbid.list, source, note }, warnings };
}

/**
 * 读一个目录下所有 `*.tasks.json`。约定：**题集文件必须以 `.tasks.json` 结尾** ——
 * 同一个目录里还放着示例答案集（`restrained-answers.json`），不加后缀区分会把答案当题集读。
 * 目录不在 / 一个文件都解析不出来都不抛，交给调用方按「没题可跑」处理。
 */
export function loadTasks(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.tasks.json')).sort();
  } catch (err) {
    return { tasks: [], invalid: [], warnings: [], files: [], error: `读不了题集目录 ${dir}：${err.code || err.message}` };
  }
  const tasks = [];
  const invalid = [];
  const warnings = [];
  const seen = new Set();
  for (const file of names) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      invalid.push({ id: file, reason: `JSON 解析失败：${err.message}`, file });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tasks)) {
      invalid.push({ id: file, reason: '顶层不是 { version: 1, tasks: [...] }', file });
      continue;
    }
    if (parsed.version !== 1) warnings.push(`${file} 的 version 不是 1（${JSON.stringify(parsed.version)}），按 version 1 读`);
    parsed.tasks.forEach((raw, i) => {
      const verdict = validateTask(raw, i, seen);
      for (const warning of verdict.warnings ?? []) warnings.push(`${file}: ${warning}`);
      if (verdict.task) {
        seen.add(verdict.task.id);
        tasks.push({ ...verdict.task, file });
      } else {
        const fallback = raw && typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${file}#${i}`;
        invalid.push({ id: fallback, reason: verdict.reason, file });
      }
    });
  }
  return { tasks, invalid, warnings, files: names };
}

/** 读答案集：`{ version, answers: { <题 id>: "答案" } }`，也接受裸的 `{ <题 id>: "答案" }`。 */
export function loadAnswers(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { answers: new Map(), error: `读不了答案文件 ${path}：${err.message}` };
  }
  const boxed = parsed && typeof parsed === 'object' && parsed.answers && typeof parsed.answers === 'object';
  const source = boxed ? parsed.answers : parsed;
  const answers = new Map();
  const warnings = [];
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (key === 'version') continue;
      if (typeof value === 'string') answers.set(key, value);
      else warnings.push(`答案 ${key} 不是字符串（${value === null ? 'null' : typeof value}），按没答处理`);
    }
  } else {
    return { answers: new Map(), error: `答案文件 ${path} 的形状不对：要 { answers: { <id>: "..." } }` };
  }
  return { answers, warnings };
}

// ── 三档上下文：注入什么、花多少 ──────────────────────────────────────────────

/** 建一次索引，三个档共用（`push` 才需要它）。返回 `{ docs, files, index, docMap, indexMs, chars }`。 */
export function prepareCorpus(storePath, settings = DEFAULTS) {
  const started = process.hrtime.bigint();
  const docs = readDocs(storePath);
  const index = buildIndex(docs, {
    halfLifeDays: settings.decayHalfLifeDays,
    recencyWeight: settings.recencyWeight,
  });
  // 门控的库侧输入：与 `index.js` 的 `gateContextOf` 同一手法 —— 长笔记切桶后同 id 有多条，
  // 留第一条就够（那里也只留第一条）。
  const docMap = new Map();
  for (const doc of index.docs ?? []) if (doc?.id && !docMap.has(doc.id)) docMap.set(doc.id, doc);
  // 库大小按**文件**去重统计：`readDocs` 会把一篇长笔记切成很多个桶，而每个桶的 `chars`
  // 都是**整篇**的字数（不是桶自己的），照着桶求和会把库吹大十几倍（实测 70 万字被算成 778 万）。
  const byPath = new Set();
  let chars = 0;
  for (const doc of docs) {
    const key = doc.path ?? doc.id;
    if (byPath.has(key)) continue;
    byPath.add(key);
    chars += Number(doc.chars) || 0;
  }
  return { docs, files: byPath.size, index, docMap, indexMs: msSince(started), chars };
}

function msSince(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * 造某一档的注入文本。**这是三档唯一的差别** —— 答案器、判分、记账全都共用，
 * 否则「记忆有没有用」就会跟「换个问法/换个模型」混在一起。
 */
export function buildContext(arm, task, corpus, settings = DEFAULTS, storePath = DEFAULT_STORE) {
  if (arm === 'none') return { text: '', hits: [], wouldInject: 0, recallMs: 0, dropped: 0, collapsed: 0 };
  const started = process.hrtime.bigint();
  // 单轮评测没有「上一轮注入过谁」，所以候选池就是 maxPointers（插件里的 3 倍扩容是给轮换用的）。
  const limit = Math.max(1, Number(settings.maxPointers) || DEFAULTS.maxPointers);
  const found = search(corpus.index, task.prompt, limit);
  const gated = applyGate(found, { docs: corpus.docMap }, {
    mode: settings.gate,
    staleDays: settings.gateStaleDays,
  });
  const hits = gated.hits.slice(0, limit);
  // pull 档（0.21.0 收口）：**文案必须取自插件本体**（`pullHintText`），而且要跟插件一样
  // 「本来没有命中就保持沉默」。以前这里自己写了一句 21 字的提示、也不看向命中数 ——
  // 于是那张三臂对照表量到的 pull 成本不是插件真跑 pull 的成本（两边各说各话）。
  if (arm === 'pull') {
    const text = hits.length ? pullHintText(hits.length, storePath) : '';
    return { text, hits: [], wouldInject: hits.length, recallMs: msSince(started), dropped: 0, collapsed: 0 };
  }
  // `hybrid`：先按 push 的老规矩切出 `maxPointers` 条，再只留最靠前的那一条 ——
  // 与 `index.js` 的 `pushHits.slice(0, 1)` 同一个式子。`wouldInject` 记着「本来有几条」，
  // 否则 hybrid 与 push 的成本差就没法解释成「少推了几条」。
  const injected = arm === 'hybrid' ? hits.slice(0, 1) : hits;
  const rendered = renderPointers(injected, { maxChars: settings.maxChars });
  // 与 `index.js` 的注入分支逐字对齐：一条都没列出来时**连头部都不发**（那里是
  // `const parts = lines.length ? [header, ...lines] : []`）—— 只发一句「有记忆可用」的
  // 空头部，等于每轮白花十几个 token 说废话。
  const text = rendered.lines.length ? [rendered.header, ...rendered.lines].join('\n') : '';
  return {
    text,
    hits: injected.map((hit) => hit.id),
    wouldInject: hits.length,
    recallMs: msSince(started),
    dropped: rendered.dropped,
    collapsed: rendered.collapsed,
  };
}

// ── 回答器：none / file / cmd ────────────────────────────────────────────────

/** `shellQuote` 只用于把题面塞进 `--cmd` 模板：题面里有引号也不能让命令散架。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 跑回答器。返回 `{ text, calls, error }`：**任何失败都退化成空答案**（该题判失败），
 * 因为「回答器挂了」与「答不出来」在这把尺子上都是「没答对」，但 `error` 要留在结果里，
 * 否则会把回答器的故障读成记忆的锅。
 *
 * `cmd` 档约定：模板里的 `{prompt}` / `{context}` 会被替换成 shell 转义后的原文；
 * 同时把「上下文 + 题面」整段喂到 **stdin** —— 这样 `--cmd "claude -p"` 这种从 stdin 读
 * 题面的 CLI 不用改模板就能用，`--cmd "cat"` 还能当「回声回答器」做回归。
 */
export function askAnswerer(armAnswerer, { task, context, answers, cmd, timeoutMs }) {
  if (armAnswerer === 'none') return { text: '', calls: 0, error: '' };
  if (armAnswerer === 'file') {
    if (!answers.has(task.id)) return { text: '', calls: 0, error: `答案集里没有 ${task.id}` };
    return { text: answers.get(task.id), calls: 0, error: '' };
  }
  const full = context ? `${context}\n\n${task.prompt}` : task.prompt;
  const command = String(cmd)
    .replaceAll('{prompt}', shellQuote(task.prompt))
    .replaceAll('{context}', shellQuote(context));
  const res = spawnSync('bash', ['-lc', command], {
    input: full,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) return { text: '', calls: 1, error: `回答器起不来：${res.error.code || res.error.message}` };
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim().slice(0, 160);
    return { text: '', calls: 1, error: `回答器退出码 ${res.status}${stderr ? `：${stderr}` : ''}` };
  }
  return { text: res.stdout ?? '', calls: 1, error: '' };
}

// ── 一档 = 一本题集 × 一个回答器 ─────────────────────────────────────────────

/**
 * 跑一档。`dry` 时不调回答器、不出判分结论（只算注入成本），所以 `pass` 一律 `null`
 * 且 `judged: false` —— **没判过不等于判不过**，两者在报表里必须分得开。
 */
export function runArm(arm, tasks, options = {}) {
  const {
    answerer = 'none',
    answers = new Map(),
    cmd = '',
    timeoutMs = 120000,
    settings = DEFAULTS,
    corpus = null,
    dry = false,
    storePath = DEFAULT_STORE,
  } = options;
  const rows = [];
  for (const task of tasks) {
    const started = process.hrtime.bigint();
    const built = buildContext(arm, task, corpus, settings, storePath);
    const answer = dry
      ? { text: '', calls: 0, error: '' }
      : askAnswerer(answerer, { task, context: built.text, answers, cmd, timeoutMs });
    const verdict = dry ? null : judge(task, answer.text);
    rows.push({
      id: task.id,
      kind: task.kind,
      pass: verdict ? verdict.pass : null,
      judged: Boolean(verdict),
      hitExpect: verdict ? verdict.hitExpect : [],
      missedExpect: verdict ? verdict.missedExpect : [],
      hitsForbid: verdict ? verdict.hitsForbid : [],
      // 「expect 全中、却踩了禁令」是一类特殊失败：答案把该说的都说了，只是**顺带提了旧值**。
      // 规则仍然是失败（§11 冻结的「forbid 命中即失败」），但要单独记一笔 —— 否则
      // 「引旧值解释根因」这种正确答案会被静默算成答错，尺子的误差就看不见了。
      forbidConflict: Boolean(verdict && verdict.hitsForbid.length && verdict.missedExpect.length === 0),
      injectedChars: built.text.length,
      injectedTokens: estimateTokens(built.text.length),
      elapsedMs: Number(msSince(started).toFixed(3)),
      recallMs: Number(built.recallMs.toFixed(3)),
      answererCalls: answer.calls,
      answererError: answer.error,
      hits: built.hits,
      // 「答案那篇笔记被注入了吗」——这是 push / hybrid 唯一能免费量到的因果环节：
      // 题集的 source 就是答案所在的笔记，注入里没有它，模型再强也无从答起。
      // none/pull 档不产生命中，记 null 而不是 false：没跑 ≠ 没命中。
      // hybrid 也算：它只推 1 条，于是这一项顺带成了**它的 top-1 精度**（push 算的是 top-N），
      // 两个数不能并排比大小，只能各自跟自己的通过率比。
      // 两边都要归一化：题集 source 写作 `reference-x.md#小节`，而召回命中的 id 恰好带 `.md`，
      // 只归一化一边会让「明明注入了答案那一篇」也判成没命中。
      hitSource: arm === 'push' || arm === 'hybrid'
        ? built.hits.map(stemOf).includes(stemOf(task.source))
        : null,
      sourceRank: arm === 'push' || arm === 'hybrid'
        ? built.hits.map(stemOf).indexOf(stemOf(task.source)) + 1 || null
        : null,
      dropped: built.dropped,
      collapsed: built.collapsed,
      dry,
      source: task.source,
    });
  }
  const summary = summarize(rows);
  return { arm, ran: true, dry, rows, ...summary };
}

/** 汇总：按类通过率 + 总通过率 + 注入成本。`judged` 是分母 —— 判不了的题不进分母。 */
export function summarize(rows) {
  const byKind = {};
  for (const kind of KINDS) byKind[kind] = { total: 0, judged: 0, passed: 0, invalid: 0, avgInjectedChars: 0, recallHits: 0, recallTotal: 0 };
  const buckets = new Map(KINDS.map((kind) => [kind, byKind[kind]]));
  const charsByKind = new Map();
  let chars = 0;
  let tokens = 0;
  let recallMs = 0;
  let recallRows = 0;
  let answererCalls = 0;
  let judged = 0;
  let passed = 0;
  let invalid = 0;
  let recallHits = 0;
  let recallHitRows = 0;
  let forbidConflicts = 0;
  for (const row of rows) {
    const bucket = buckets.get(row.kind) ?? buckets.get(KINDS[0]);
    bucket.total += 1;
    charsByKind.set(row.kind, (charsByKind.get(row.kind) ?? 0) + row.injectedChars);
    chars += row.injectedChars;
    tokens += row.injectedTokens;
    answererCalls += row.answererCalls;
    if (row.forbidConflict) forbidConflicts += 1;
    if (row.judged) {
      judged += 1;
      if (row.pass) passed += 1;
      bucket.judged += 1;
      if (row.pass) bucket.passed += 1;
    } else if (!row.dry) {
      // dry 模式跑出来的 `judged: false` **不是**「判不了」，别混进 invalid 计数里。
      invalid += 1;
      bucket.invalid += 1;
    }
    if (row.judged || row.dry) {
      recallMs += row.recallMs;
      recallRows += 1;
    }
    if (row.hitSource !== null && row.hitSource !== undefined) {
      recallHitRows += 1;
      if (row.hitSource) recallHits += 1;
      bucket.recallTotal += 1;
      if (row.hitSource) bucket.recallHits += 1;
    }
  }
  for (const kind of KINDS) byKind[kind].avgInjectedChars = byKind[kind].total
    ? Number((charsByKind.get(kind) / byKind[kind].total).toFixed(1))
    : 0;
  const total = rows.length;
  return {
    total,
    judged,
    passed,
    invalid,
    passRate: judged ? passed / judged : null,
    injectedChars: chars,
    injectedTokens: tokens,
    avgInjectedChars: total ? Number((chars / total).toFixed(1)) : 0,
    avgInjectedTokens: total ? Number((tokens / total).toFixed(1)) : 0,
    avgRecallMs: recallRows ? Number((recallMs / recallRows).toFixed(3)) : 0,
    answererCalls,
    // 召回命中率：只在产生过命中的档（push）上有值，别的档是 null = 未测。
    forbidConflicts,
    recallHits,
    recallTotal: recallHitRows,
    recallRate: recallHitRows ? recallHits / recallHitRows : null,
    byKind,
  };
}

// ── 参数、报表、落盘 ────────────────────────────────────────────────────────

export const USAGE = `用法：node bench/recall-eval.mjs [选项]

  --mode <none|push|pull>   对照臂，可给多个（逗号分隔或重复给）。默认 push
  --answerer <none|cmd|file> 回答器。默认 none（不调模型：量地板与注入成本）
  --tasks <目录>            题集目录，读里面所有 *.tasks.json。默认 ${DEFAULT_TASKS_DIR}
  --out <文件>              结果落盘路径。默认 bench/eval-results/<mode>-<answerer>-<时间戳>.json
  --dry                     只算每条注入的字数/token 与召回耗时，不调回答器、不判分
  --json                    只打印 JSON（CI 用）；人话报表一条不印
  --cmd <模板>              --answerer cmd 的命令模板，支持 {prompt} / {context} 占位符
  --answers <文件>          --answerer file 的答案集：{ "answers": { "<题 id>": "..." } }
  --store <目录>            记忆库。默认 ${DEFAULT_STORE}
  --pointers <n>            每题最多注入几条指针（默认取插件的 ${DEFAULTS.maxPointers}）
  --chars <n>               注入预算（默认取插件的 ${DEFAULTS.maxChars}）
  --timeout <毫秒>          cmd 回答器单题超时（默认 120000）
  -h, --help                打印这段`;

/** 参数解析：`--k v` 与 `--k=v` 都认；未知选项在 stderr 点一句、不改输出（尺子的老规矩）。 */
export function parseArgs(argv) {
  const opts = { modes: [], warnings: [] };
  const take = (name, i) => {
    const arg = argv[i];
    if (arg.includes('=')) return { value: arg.slice(arg.indexOf('=') + 1), next: i };
    return { value: argv[i + 1], next: i + 1 };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (key === '--dry') opts.dry = true;
    else if (key === '--json') opts.json = true;
    else if (key === '-h' || key === '--help') opts.help = true;
    else if (key === '--mode') {
      const { value, next } = take(key, i);
      i = next;
      opts.modes.push(...String(value ?? '').split(',').map((m) => m.trim()).filter(Boolean));
    } else if (['--answerer', '--tasks', '--out', '--cmd', '--answers', '--store', '--pointers', '--chars', '--timeout'].includes(key)) {
      const { value, next } = take(key, i);
      i = next;
      opts[key.slice(2)] = value;
    } else opts.warnings.push(`未知选项 ${key}（已忽略）`);
  }
  return opts;
}

const percent = (rate) => (rate === null || rate === undefined ? '未跑' : `${(rate * 100).toFixed(1)}%`);
const ratio = (passed, judged) => (judged ? `${percent(passed / judged)} (${passed}/${judged})` : '未跑');
const stampOf = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/**
 * 人话报表：**一张总表**，横轴是档、纵轴是类。多个档跑在一起时按档并排看才有意义 ——
 * 每档各印一张一模一样的表头，等于让人自己去做减法。
 * 没跑过的档一律印「未跑」，绝不印 0：那两件事含义完全不同。
 */
export function formatReport(bundle) {
  const { tasks, store, settings, answerer, dry, arms, invalid } = { invalid: [], ...bundle };
  const ran = arms.filter((arm) => arm.ran);
  const lines = [];
  lines.push(`召回评测 · 档=${ran.map((arm) => arm.arm).join(',') || '(无)'} · 回答器=${answerer} · ${tasks.count} 题（${tasks.files.length} 个文件）`);
  lines.push(store.read
    ? `库=${store.path} · ${store.files} 篇 / ${store.chunks} 个切片 / ${store.chars} 字 · 指纹 ${store.fingerprint} · 建索引 ${store.indexMs}ms`
    : `库=${store.path}（本档不读库）`);
  lines.push(`口径：注入 token = Math.ceil(字数 / ${TOKENS_PER_CHAR})（粗估，不是分词，见 docs/measuring.md）· elapsedMs=端到端 · recallMs=只算召回`);
  if (dry) lines.push('模式：--dry（只算注入成本，不调回答器、不出判分结论）');
  lines.push('');

  if (dry) {
    // 最后一列「命中出处」是这张表真正的重点：注入了 439 字不等于注入了**答案那一篇**。
    lines.push('| 题 | 类 | none 字 | pull 字 | push 字 | push token | 召回 ms | 命中出处 | 注入了谁 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const row of bundle.dryRows) {
      const chars = (arm) => (row.cost[arm] ? String(row.cost[arm].chars) : '未跑');
      const hits = row.hits && row.hits.length ? row.hits.join(', ') : '—';
      const source = row.hitSource === null || row.hitSource === undefined
        ? '未跑'
        : (row.hitSource ? `✓ 第 ${row.sourceRank} 位` : '✗');
      lines.push(`| ${row.id} | ${row.kind} | ${chars('none')} | ${chars('pull')} | ${chars('push')} | ${row.cost.push ? row.cost.push.tokens : '未跑'} | ${row.cost.push ? row.cost.push.recallMs : '未跑'} | ${source} | ${hits} |`);
    }
  } else {
    // 成本要**按档**列，不能只取「第一个跑了的档」：多档同跑时那一列会静默变成另一档的钱，
    // 而「none 平均注入 0 字」写在 push 那一行旁边正是最容易读错的那种表。
    const costCells = (pick) => ran.map((arm) => (arm.dry ? '（dry）' : pick(arm)));
    lines.push('| 类 | 题数 | ' + ran.map((arm) => arm.arm).join(' | ') + ' | ' + ran.map((arm) => `${arm.arm} 注入字`).join(' | ') + ' |');
    lines.push('|---|' + '---|'.repeat(ran.length * 2 + 1));
    for (const kind of KINDS) {
      const total = checked(tasks.byKind[kind]) ? tasks.byKind[kind] : 0;
      // 这一类一题都没有 ⇒ 印「—」。印「未跑」会被读成「跑过这类、但这一档没跑」，
      // 而那两件事的处理方式完全不同：前者要补题，后者要补跑。
      const cells = total === 0
        ? ran.map(() => '—')
        : ran.map((arm) => (arm.dry ? '（dry）' : ratio(arm.byKind[kind].passed, arm.byKind[kind].judged)));
      const costs = costCells((arm) => arm.byKind[kind].avgInjectedChars);
      lines.push(`| ${kind} | ${total} | ${cells.join(' | ')} | ${costs.join(' | ')} |`);
    }
    const cells = ran.map((arm) => (arm.dry ? '（dry）' : ratio(arm.passed, arm.judged)));
    const costs = costCells((arm) => arm.avgInjectedChars);
    lines.push(`| 合计 | ${tasks.count} | ${cells.join(' | ')} | ${costs.join(' | ')} |`);
  }
  lines.push('');
  lines.push('成本与耗时');
  lines.push('| 档 | 平均注入字 | 平均注入 token | 总注入 token | 平均召回 ms | 回答器调用 |');
  lines.push('|---|---|---|---|---|---|');
  for (const arm of arms) {
    if (!arm.ran) { lines.push(`| ${arm.arm} | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 |`); continue; }
    lines.push(`| ${arm.arm} | ${arm.avgInjectedChars} | ${arm.avgInjectedTokens} | ${arm.injectedTokens} | ${arm.avgRecallMs} | ${arm.answererCalls} |`);
  }
  if (store.read) {
    const perTurn = ran.find((arm) => arm.arm === 'push');
    if (perTurn) {
      const share = store.chars ? ((perTurn.avgInjectedChars * tasks.count) / store.chars) * 100 : 0;
      lines.push(`参考：跑完一整轮题集的注入量 ≈ 库的 ${share.toFixed(1)}%（每轮只碰相关的几篇，不是把库塞进去）`);
    }
  }
  for (const arm of ran) {
    if (!arm.forbidConflicts) continue;
    const ids = arm.rows.filter((row) => row.forbidConflict).map((row) => row.id);
    lines.push(`⚠ ${arm.arm} 档有 ${arm.forbidConflicts} 题「判据全中但踩了禁令」（${ids.slice(0, 8).join('、')}${ids.length > 8 ? ' …' : ''}）：`);
    lines.push('  按 §11 冻结的规则仍算失败，但这多半是「答对了、只是顺带提了旧值」——加题时留意 forbid 是不是定得太宽。');
  }
  const pushArm = arms.find((arm) => arm.ran && arm.arm === 'push');
  if (pushArm) {
    if (pushArm.recallTotal) {
      lines.push(`push 档召回命中：${ratio(pushArm.recallHits, pushArm.recallTotal)} —— 判据是「这道题答案所在的那篇笔记，有没有出现在注入的指针里」`);
      const missed = pushArm.rows.filter((row) => row.hitSource === false);
      if (missed.length) lines.push(`  没命中的 ${missed.length} 题：${missed.slice(0, 12).map((row) => row.id).join('、')}${missed.length > 12 ? ' …' : ''}`);
    } else {
      lines.push('push 档召回命中：未测（只有 --dry 或 push 档才会算这一项）');
    }
  }
  lines.push(`pull 档的固定开销：${settings.pullHintChars} 字（「${settings.pullHint}」）`);
  if (invalid.length) {
    lines.push('');
    lines.push(`判不了 ${invalid.length} 题（题集字段有问题，**不计入通过率**）：`);
    for (const bad of invalid.slice(0, 10)) lines.push(`  - ${bad.id}：${bad.reason}`);
  }
  if (bundle.warnings.length) {
    lines.push('');
    lines.push(`警告 ${bundle.warnings.length} 条：`);
    for (const warning of bundle.warnings.slice(0, 16)) lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}

const checked = (value) => typeof value === 'number' && Number.isFinite(value);

/** 题集 `source`（`reference-x.md#小节`）→ 召回结果里的 doc id（`reference-x`）。 */
function stemOf(source) {
  return String(source ?? '').split('#')[0].trim().replace(/\.md$/i, '');
}

/** 题集按类的题数：报表第一列要回答「这一类我到底造了几题」。 */
function countByKind(tasks) {
  const out = {};
  for (const kind of KINDS) out[kind] = 0;
  for (const task of tasks) out[task.kind] = (out[task.kind] ?? 0) + 1;
  return out;
}

/** 落盘对象：一个文件一档（题面要求 `<mode>-<answerer>-<时间戳>.json`），所以按档生成。 */
function reportOf(bundle, arm) {
  return {
    version: 1,
    tool: 'bench/recall-eval.mjs',
    generatedAt: new Date().toISOString(),
    mode: arm.arm,
    answerer: bundle.answerer,
    dry: bundle.dry,
    tasks: bundle.tasks,
    store: bundle.store,
    settings: bundle.settings,
    total: arm.total,
    judged: arm.judged,
    passed: arm.passed,
    invalid: bundle.tasks.invalid.length,
    passRate: arm.passRate,
    byKind: arm.byKind,
    injectedChars: arm.injectedChars,
    injectedTokens: arm.injectedTokens,
    avgInjectedChars: arm.avgInjectedChars,
    avgInjectedTokens: arm.avgInjectedTokens,
    avgRecallMs: arm.avgRecallMs,
    answererCalls: arm.answererCalls,
    // 召回命中：只在 push 这类真召回过的档上有值，别的档是 null = 未测。
    forbidConflicts: arm.forbidConflicts,
    recallHits: arm.recallHits,
    recallTotal: arm.recallTotal,
    recallRate: arm.recallRate,
    // 「哪几档真跑过」必须随结果一起写下来：只留跑过的档，后来的人会把「没跑」
    // 脑补成「跑了但 0 分」，而这正是这把尺子最该避免的误读。
    arms: bundle.arms.map((entry) => (entry.ran
      ? {
        arm: entry.arm, ran: true, dry: entry.dry, passRate: entry.passRate, judged: entry.judged,
        passed: entry.passed, avgInjectedChars: entry.avgInjectedChars, avgInjectedTokens: entry.avgInjectedTokens,
        injectedTokens: entry.injectedTokens, avgRecallMs: entry.avgRecallMs, answererCalls: entry.answererCalls,
        recallHits: entry.recallHits, recallTotal: entry.recallTotal, recallRate: entry.recallRate,
      }
      : { arm: entry.arm, ran: false })),
    warnings: bundle.warnings,
    rows: arm.rows,
  };
}

/** dry 模式下把各档的成本并到一行一题上：单看一档的注入字数，判断不出它贵不贵。 */
function dryRowsOf(tasks, perArm) {
  return tasks.map((task) => {
    const cost = {};
    let hits = [];
    let hitSource = null;
    let sourceRank = null;
    for (const arm of ALL_ARMS) {
      const row = perArm.get(arm)?.rows.find((entry) => entry.id === task.id);
      if (!row) continue;
      cost[arm] = { chars: row.injectedChars, tokens: row.injectedTokens, recallMs: row.recallMs };
      // 「详细列」（注入了谁+命中出处）以 push 为基准：它是唯一一个把多档并排比的列，
      // 换成 hybrid 会把「按 top-N 注入」这件事从表里抹掉。
      if (arm === 'push') {
        hits = row.hits ?? [];
        hitSource = row.hitSource;
        sourceRank = row.sourceRank;
      }
    }
    return { id: task.id, kind: task.kind, source: task.source, hits, hitSource, sourceRank, cost };
  });
}

// ── main ────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  for (const warning of opts.warnings) console.error(warning);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  // `--dry` 默认把三档都算一遍：这个模式下不调回答器、成本极低，而「三档各花多少」
  // 只有并排看才有意义（单独一档的注入字数是没法判断贵不贵的）。
  const modes = opts.modes.length ? opts.modes : (opts.dry ? ARMS : ['push']);
  // `hybrid` 是显式点名的第四臂（见 `OPTIONAL_ARMS` 的理由）：`--mode hybrid` 走这里，
  // 但默认清单（`--dry` 的三档、单档的 push）**一个字都不动** —— 老结果的列没变。
  const badMode = modes.find((mode) => !ALL_ARMS.includes(mode));
  if (badMode) {
    console.error(`--mode 只认 ${ALL_ARMS.join(' / ')}，收到 ${badMode}`);
    console.error(USAGE);
    return 2;
  }
  const answerer = opts.answerer ?? 'none';
  if (!ANSWERERS.includes(answerer)) {
    console.error(`--answerer 只认 ${ANSWERERS.join(' / ')}，收到 ${answerer}`);
    console.error(USAGE);
    return 2;
  }
  if (answerer === 'cmd' && !opts.cmd) {
    console.error('--answerer cmd 需要 --cmd "<模板>"（模板里可用 {prompt} / {context}，题面同时走 stdin）');
    return 2;
  }
  if (answerer === 'file' && !opts.answers) {
    console.error('--answerer file 需要 --answers <文件>');
    return 2;
  }
  if (opts.dry && answerer !== 'none') console.error('--dry 不调回答器，--answerer 被忽略');

  const tasksDir = resolve(opts.tasks ?? DEFAULT_TASKS_DIR);
  const loaded = loadTasks(tasksDir);
  if (loaded.error) {
    console.error(loaded.error);
    return 2;
  }
  for (const warning of loaded.warnings) console.error(`警告：${warning}`);
  for (const bad of loaded.invalid) console.error(`判不了：${bad.id} —— ${bad.reason}`);
  if (!loaded.tasks.length) {
    console.error(`题集是空的（${tasksDir} 下没有可用的 *.tasks.json）`);
    return 2;
  }
  if (loaded.tasks.length < 30) console.error(`提示：题集只有 ${loaded.tasks.length} 题，§11 要求首批 ≥ 30 题`);

  let answers = new Map();
  if (!opts.dry && answerer === 'file') {
    const read = loadAnswers(resolve(opts.answers));
    if (read.error) {
      console.error(read.error);
      return 2;
    }
    answers = read.answers;
    for (const warning of read.warnings ?? []) console.error(`警告：${warning}`);
  }

  const settings = {
    ...DEFAULTS,
    ...(opts.pointers ? { maxPointers: Number(opts.pointers) } : {}),
    ...(opts.chars ? { maxChars: Number(opts.chars) } : {}),
  };
  const storePath = resolve(String(opts.store ?? DEFAULT_STORE).replace(/^~(?=\/|$)/, homedir()));
  // pull / push / hybrid 都要读库：pull 得先知道「本来会不会有命中」，才知道该不该开口（0.21.0 起
  // 与插件本体同款语义）；hybrid 只推 1 条，但它推的那一条同样来自检索。只有 none 不读 ——
  // 「没碰过记忆库」这句话必须仍然是真话。
  const corpus = modes.some((mode) => mode === 'push' || mode === 'pull' || mode === 'hybrid')
    ? prepareCorpus(storePath, settings)
    : null;
  if (corpus && !corpus.docs.length) console.error(`警告：库 ${storePath} 里一篇笔记都没读到，push 档只能注入 0 条`);

  const tasks = {
    dir: tasksDir,
    files: loaded.files,
    count: loaded.tasks.length,
    byKind: countByKind(loaded.tasks),
    invalid: loaded.invalid.map(({ id, reason, file }) => ({ id, reason, file })),
  };
  const warningLines = [...loaded.warnings.map((w) => `题集：${w}`)];
  const runs = modes.map((mode) => runArm(mode, loaded.tasks, {
    answerer: opts.dry ? 'none' : answerer,
    answers,
    cmd: opts.cmd ?? '',
    timeoutMs: Number(opts.timeout) || 120000,
    settings,
    corpus,
    dry: Boolean(opts.dry),
    // pull 档的提示里带库路径（与插件一致），所以这里必须把真实路径传下去，
    // 否则量到的字数与插件真跑的字数对不上。
    storePath,
  }));
  for (const run of runs) {
    for (const row of run.rows) if (row.answererError) warningLines.push(`${row.id}：${row.answererError}`);
  }
  // 没跑的档也占一个位置（`ran: false`）：报表里必须看得见「这档没跑」，
  // 只印跑过的档会让人把「没跑」脑补成「跑了但 0 分」。
  // 历史三臂永远在列（顺序不变）；`hybrid` 只在真跑过时才插进来 —— 没点名它的那些结果文件
  // 与 0.21.0 之前逐字同形，读起来不会多出一个永远的 `ran: false` 列。
  const ranArms = new Set(runs.map((run) => run.arm));
  const armsAll = ALL_ARMS
    .filter((arm) => ARMS.includes(arm) || ranArms.has(arm))
    .map((arm) => runs.find((run) => run.arm === arm) ?? { arm, ran: false });

  const bundle = {
    answerer,
    dry: Boolean(opts.dry),
    tasks,
    store: {
      path: storePath,
      read: Boolean(corpus),
      files: corpus ? corpus.files : 0,
      chunks: corpus ? corpus.docs.length : 0,
      chars: corpus ? corpus.chars : 0,
      fingerprint: corpus ? corpusFingerprint(corpus.docs) : '',
      indexMs: corpus ? Number(corpus.indexMs.toFixed(3)) : 0,
    },
    settings: {
      maxPointers: settings.maxPointers,
      maxChars: settings.maxChars,
      gate: settings.gate,
      gateStaleDays: settings.gateStaleDays,
      tokensPerChar: TOKENS_PER_CHAR,
      pullHint: pullHintText(1, '<store>'),
      pullHintChars: pullHintText(1, '').length,
    },
    arms: armsAll,
    warnings: warningLines,
    dryRows: opts.dry ? dryRowsOf(loaded.tasks, new Map(runs.map((run) => [run.arm, run]))) : [],
  };
  const reports = runs.map((run) => reportOf(bundle, run));

  if (opts.json) {
    console.log(JSON.stringify({ version: 1, tool: 'bench/recall-eval.mjs', generatedAt: new Date().toISOString(), reports }, null, 2));
  } else {
    console.log(formatReport(bundle));
  }

  // `--dry` 默认不落盘：那是一次「量成本」而不是一次「判定」，混进 eval-results 目录里
  // 会让「这批结果里有几档真跑过」变成要逐个文件打开才知道的事。给了 `--out` 就写。
  if (!opts.dry || opts.out) {
    const dir = opts.out ? dirname(resolve(opts.out)) : DEFAULT_RESULTS_DIR;
    mkdirSync(dir, { recursive: true });
    const stamp = stampOf(new Date());
    // 一个 `--out` 配多个档时不许互相覆盖：多档同跑（三档对照表）是常规用法，
    // 静默只留最后一档 = 你拿着 none 的数当 push 的数读。单档时原样用给的路径。
    const outPathFor = (mode) => {
      if (!opts.out) return join(dir, `${mode}-${answerer}-${stamp}.json`);
      const target = resolve(opts.out);
      if (reports.length === 1) return target;
      const ext = extname(target);
      return `${target.slice(0, target.length - ext.length)}-${mode}${ext}`;
    };
    const written = [];
    for (const report of reports) {
      const path = outPathFor(report.mode);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      written.push(path);
    }
    if (!opts.json) console.log(`\n结果已落盘：${written.map((p) => p.replace(`${root}/`, '')).join('、')}`);
  }
  return 0;
}

// 只有**直接跑这个文件**时才执行 main：测试要 import 里面的判分函数，
// 不能因为 import 就顺手把整库读一遍、把结果写进 bench/eval-results/。
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main();
