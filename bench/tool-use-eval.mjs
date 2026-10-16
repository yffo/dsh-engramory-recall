#!/usr/bin/env node
/**
 * 工具调用实验（回答「pull 的收益到底成不成立」）。
 *
 * 为什么需要它：`bench/recall-eval.mjs` 的三臂对照只量到「注入了多少字」和
 * 「模型拿着注入的字答对没有」。但 pull 档**一条指针都不推**，它把全部赌注押在
 * 「模型看见那一行提示后会自己去查」上 —— 这个前提在离线判分器里根本量不到：
 * 那里没有工具、没有第二轮、模型收到什么就只能用那点东西答。
 *
 * 所以本文件补的正是那一环：**模型真的调用检索的比例**。
 *
 * 保真度声明（决定了结论能推到哪一步）：
 *   1. 三个臂都给同一个工具、同一份工具说明 —— 真实宿主里 `engramory_search` 一直注册着，
 *      `recallMode` 只改「这一轮往上下文里塞什么」，不改模型看得见哪些工具。
 *      于是 `none` 臂就是**对照组**：没有那行提示时模型的自然调用率。
 *   2. 臂间唯一变量仍然是 `buildContext()`（直接复用判分器的函数），
 *      与三臂对照表量的是同一个东西。
 *   3. 工具实现照抄 `index.js` 的 execute：`search()` → `{file, score, snippet≤240}`，
 *      note 文案一致；`limit` 默认 5、夹在 1..20。
 *   4. 工具调用走**文本 JSON 协议**（不是各家模型的 function-calling 模板）：
 *      模板格式因模型而异，会把这个实验变成「谁的原生 tool 模板更顺」的比赛，
 *      而这里要量的是「模型想不想查」。协议在系统提示里写死，三臂逐字相同。
 *
 * 用法：
 *   node bench/tool-use-eval.mjs --mode none,push,pull --out bench/eval-results/tool-use.json
 *   可选 --limit N（先跑前 N 题）/ --max-calls 3 / --base-url / --model
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clip, search } from '../bm25.js';
import { DEFAULTS } from '../index.js';
import {
  DEFAULT_RESULTS_DIR,
  DEFAULT_STORE,
  DEFAULT_TASKS_DIR,
  buildContext,
  estimateTokens,
  judge,
  loadTasks,
  prepareCorpus,
} from './recall-eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const ARMS = ['none', 'push', 'pull'];

/** 工具条数上限：给小模型一个硬闸，免得它在「再查一次」里转圈。 */
const DEFAULT_MAX_CALLS = 3;

/**
 * 三臂逐字相同的系统提示。
 *
 * 「线索里没有就说明缺什么、不要编」这一句是**故意的**：不写它，模型会用通用工程常识
 * 把分数蒙上去，臂间差值就不可信了（`none` 臂尤其容易被蒙高）。
 *
 * 工具协议用一行 JSON，而不是原生 function-calling：见文件头「保真度声明」第 4 条。
 */
const systemPrompt = (storePath) => [
  '你在回答用户关于他这台机器上过往决策与踩坑的问题。',
  '',
  '你可以调用两个只读工具查本地 Engramory markdown 记忆库：',
  `  库路径：${storePath}`,
  '  1) engramory_search —— BM25 检索，返回命中的笔记文件名、命中片段、分数（正文不在里面）',
  '     参数：{"query": "<关键词>", "limit": <1-20，默认 5>}',
  '  2) engramory_read —— 打开一篇笔记拿正文',
  '     参数：{"file": "<engramory_search 返回的文件名>"}',
  '',
  '需要查库时，**只输出一行 JSON**，不要输出任何别的东西，例如：',
  '{"tool":"engramory_search","query":"next 代理 鉴权 路径"}',
  '{"tool":"engramory_read","file":"reference-next-proxy-authed-path-404.md"}',
  '',
  '不需要查库时，直接回答问题本身。',
  '回答只依据查到的内容：查不到就说明「记忆库里没有」，不要用通用常识编一个像样的答案。',
  '回答控制在 120 字以内。',
].join('\n');

// ── 工具实现（照抄 index.js 的 execute 契约）────────────────────────────────

export const makeTools = (corpus, storePath) => {
  const searchTool = (args) => {
    const query = String(args?.query ?? '').trim();
    if (!query) return { store: storePath, hits: [], note: '需要 storePath 配置与非空 query' };
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
    const hits = search(corpus.index, query, limit).map((hit) => ({
      file: hit.id,
      score: Number(hit.score.toFixed(3)),
      snippet: clip(hit.snippet, 240),
    }));
    return {
      store: storePath,
      hits,
      note: hits.length
        ? '用 read 打开需要的文件；正文在笔记里，不在这个结果里'
        : '没有命中：换个说法再搜一次（同义词、术语的英文写法、笔记里可能用的那个词）—— 它只认措辞不认意思',
      semantic: { used: false, code: 'off', message: '语义接缝未启用（默认）' },
    };
  };
  const readTool = (args) => {
    const name = String(args?.file ?? '').trim();
    // 只允许库内文件名：`..` 与绝对路径都挡掉（实验装置也该按真实工具的边界来）。
    if (!name || name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      return { file: name, error: '文件名不合法' };
    }
    const full = resolve(storePath, name);
    if (!full.startsWith(resolve(storePath) + sep) && full !== resolve(storePath)) {
      return { file: name, error: '文件不在库内' };
    }
    try {
      return { file: name, text: clip(readFileSync(full, 'utf8'), 4000) };
    } catch {
      return { file: name, error: '读不到这篇笔记' };
    }
  };
  return { engramory_search: searchTool, engramory_read: readTool };
};

// ── 解析模型输出里的一行工具调用 ─────────────────────────────────────────────

/**
 * 从模型输出里抠出工具调用。散文里混一行 JSON 也要认（小模型经常先写一句「我来查一下」）。
 * 返回 `{tool, args}` 或 null。**只认白名单里的工具名** —— 否则模型编一个
 * `{"tool":"rm"}` 也会被当成调用，调用率就虚高了。
 */
export function parseToolCall(text, allowed = ['engramory_search', 'engramory_read']) {
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(s.slice(i, j + 1));
            const tool = obj?.tool ?? obj?.name ?? obj?.tool_name;
            if (typeof tool === 'string' && allowed.includes(tool)) {
              return { tool, args: obj.arguments && typeof obj.arguments === 'object' ? obj.arguments : obj };
            }
          } catch { /* 不是 JSON 就继续往后扫 */ }
          break;
        }
      }
    }
  }
  return null;
}

// ── 一次对话 ────────────────────────────────────────────────────────────────

/**
 * 密钥：**只为能跑远程回答器**（`--base-url https://api.deepseek.com`）。
 * 本地 llama-server 不需要，所以取不到就空着、继续跑。
 *
 * 为什么不复用 `bench/eval-answerer-deepseek.mjs` 的解析：那是脚本的顶层副作用，
 * import 它会直接 `process.exit`。这里抄的是同一套规则（`refs.<NAME>`、不打印、不回显），
 * 不抄它的控制流。**密钥绝不进日志、绝不进 JSON、绝不进文档**。
 */
function evalApiKey(ref = 'DEEPSEEK_API_KEY') {
  const fromEnv = (process.env.DSH_EVAL_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  let src = '';
  try {
    src = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  } catch {
    return '';
  }
  // 只扫 refs 段之后的行，避免误抓 payload 里别的字段。
  const at = src.indexOf('\nrefs:');
  const tail = at === -1 ? src : src.slice(at);
  for (const line of tail.split('\n')) {
    const m = line.match(/^\s+([A-Z0-9_]+)\s*:\s*(\S+)\s*$/);
    if (m && m[1] === ref) return m[2].replace(/^["']|["']$/g, '');
  }
  return '';
}

const API_KEY = evalApiKey();
const isLocalhost = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

const chat = async ({ baseUrl, model, messages, maxTokens, timeoutMs }) => {
  const headers = { 'Content-Type': 'application/json' };
  // 只有非本机端点才带凭据：本地 llama-server 收到 Authorization 会当噪声。
  if (API_KEY && !isLocalhost(baseUrl)) headers.Authorization = `Bearer ${API_KEY}`;
  // `seed` 是本机 llama.cpp 的确定性旋钮；官方 API 不认这个参数，带上可能直接 400。
  const body = { model, messages, temperature: 0, max_tokens: maxTokens, stream: false };
  if (isLocalhost(baseUrl)) body.seed = 0;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
  const payload = await res.json();
  return {
    text: payload?.choices?.[0]?.message?.content ?? '',
    usage: payload?.usage ?? {},
  };
};

const resolveModel = async (baseUrl, explicit) => {
  if (explicit) return explicit;
  const headers = {};
  if (API_KEY && !isLocalhost(baseUrl)) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  const id = body?.data?.[0]?.id || body?.models?.[0]?.name;
  if (!id) throw new Error('本地服务没有可用模型');
  return id;
};

/**
 * 跑一题：`turns` 上限由 `maxCalls` 决定 —— 每调一次工具算一轮，
 * 用完之后追加一句「别再调用」逼出最终答案，避免无限转圈。
 */
export async function runTask({ arm, task, corpus, tools, storePath, cfg }) {
  const started = Date.now();
  const built = buildContext(arm, task, corpus, cfg.settings, storePath);
  const messages = [
    { role: 'system', content: systemPrompt(storePath) },
    { role: 'user', content: built.text ? `${built.text}\n\n${task.prompt}` : task.prompt },
  ];
  const calls = [];
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let error = '';

  for (let turn = 0; turn <= cfg.maxCalls; turn += 1) {
    const forced = turn === cfg.maxCalls;
    if (forced) {
      messages.push({ role: 'user', content: '现在直接给出最终答案，不要再调用工具。' });
    }
    let res;
    try {
      res = await chat({ ...cfg, messages, maxTokens: cfg.maxTokens });
    } catch (err) {
      error = String(err?.message || err).slice(0, 160);
      break;
    }
    promptTokens += Number(res.usage?.prompt_tokens) || 0;
    completionTokens += Number(res.usage?.completion_tokens) || 0;
    text = res.text;
    const call = forced ? null : parseToolCall(res.text);
    if (!call) break;
    const impl = tools[call.tool];
    let value;
    try {
      value = impl(call.args);
    } catch (err) {
      value = { error: String(err?.message || err).slice(0, 120) };
    }
    calls.push({ tool: call.tool, args: call.args, bytes: JSON.stringify(value).length });
    if (call.tool === 'engramory_search') {
      const files = (value.hits ?? []).map((h) => h.file);
      calls[calls.length - 1].hitFiles = files;
      calls[calls.length - 1].hitSource = files.includes(task.source) || files.includes(`${task.source}.md`);
    }
    messages.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'user', content: `工具 ${call.tool} 返回：\n${JSON.stringify(value)}` });
  }

  const verdict = error ? null : judge(task, text);
  return {
    arm,
    id: task.id,
    kind: task.kind,
    source: task.source,
    pass: verdict ? verdict.pass : null,
    judged: Boolean(verdict),
    missedExpect: verdict ? verdict.missedExpect : [],
    hitsForbid: verdict ? verdict.hitsForbid : [],
    injectedChars: built.text.length,
    injectedTokens: estimateTokens(built.text.length),
    toolCalls: calls.length,
    searched: calls.some((c) => c.tool === 'engramory_search'),
    readCount: calls.filter((c) => c.tool === 'engramory_read').length,
    searchQueries: calls.filter((c) => c.tool === 'engramory_search').map((c) => String(c.args?.query ?? '')),
    searchHitSource: calls.filter((c) => c.tool === 'engramory_search').map((c) => Boolean(c.hitSource)),
    // 工具返回的字数：这是 pull 档真正的**上下文成本**（三臂对照表量不到它，
    // 因为那张表里没有工具）。要跟 push 的注入比，就必须把这一项算进来。
    toolResultChars: calls.reduce((s, c) => s + c.bytes, 0),
    toolResultTokens: estimateTokens(calls.reduce((s, c) => s + c.bytes, 0)),
    turns: calls.length + 1,
    answerChars: text.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    elapsedMs: Date.now() - started,
    answer: text.slice(0, 300),
    error,
  };
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

export function summarizeArm(rows) {
  const n = rows.length;
  const judged = rows.filter((r) => r.judged);
  const rate = (k) => (n ? rows.filter(k).length / n : 0);
  const passOf = (subset) => (subset.length ? subset.filter((r) => r.pass).length / subset.length : null);
  const searched = rows.filter((r) => r.searched);
  const notSearched = rows.filter((r) => !r.searched);
  return {
    arm: rows[0]?.arm ?? '',
    total: n,
    judged: judged.length,
    passed: rows.filter((r) => r.pass).length,
    passRate: passOf(rows),
    toolCallRate: rate((r) => r.searched),
    readRate: rate((r) => r.readCount > 0),
    avgToolCalls: n ? rows.reduce((s, r) => s + r.toolCalls, 0) / n : 0,
    searchedCount: searched.length,
    passRateSearched: passOf(searched),
    passRateNotSearched: passOf(notSearched),
    // 查了、而且第一枪就查到答案那篇笔记的比例 —— 把「模型不肯查」与「查了也没查到」分开。
    searchHitSourceRate: searched.length
      ? searched.filter((r) => r.searchHitSource.some(Boolean)).length / searched.length
      : null,
    avgInjectedChars: n ? rows.reduce((s, r) => s + r.injectedChars, 0) / n : 0,
    avgInjectedTokens: n ? rows.reduce((s, r) => s + r.injectedTokens, 0) / n : 0,
    avgToolResultChars: n ? rows.reduce((s, r) => s + r.toolResultChars, 0) / n : 0,
    avgToolResultTokens: n ? rows.reduce((s, r) => s + r.toolResultTokens, 0) / n : 0,
    avgTotalTokens: n ? rows.reduce((s, r) => s + r.totalTokens, 0) / n : 0,
    avgElapsedMs: n ? rows.reduce((s, r) => s + r.elapsedMs, 0) / n : 0,
    errors: rows.filter((r) => r.error).length,
  };
}

export function parseArgs(argv) {
  const opts = {
    modes: [],
    tasksDir: DEFAULT_TASKS_DIR,
    store: process.env.ENGRAMORY_STORE || DEFAULT_STORE,
    out: '',
    limit: 0,
    maxCalls: DEFAULT_MAX_CALLS,
    baseUrl: (process.env.LOCAL_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
    model: process.env.LOCAL_MODEL || '',
    maxTokens: Number(process.env.LOCAL_MAX_TOKENS) || 400,
    timeoutMs: Number(process.env.LOCAL_TIMEOUT_MS) || 120000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const next = inline ?? argv[i + 1];
    const take = () => { if (inline === undefined) i += 1; return next; };
    if (key === '--mode') opts.modes.push(...String(take()).split(','));
    else if (key === '--tasks') opts.tasksDir = String(take());
    else if (key === '--store') opts.store = String(take());
    else if (key === '--out') opts.out = String(take());
    else if (key === '--limit') opts.limit = Number(take());
    else if (key === '--max-calls') opts.maxCalls = Number(take());
    else if (key === '--base-url') opts.baseUrl = String(take()).replace(/\/$/, '');
    else if (key === '--model') opts.model = String(take());
    else if (key === '--max-tokens') opts.maxTokens = Number(take());
  }
  if (!opts.modes.length) opts.modes = ARMS.slice();
  const bad = opts.modes.find((m) => !ARMS.includes(m));
  if (bad) throw new Error(`--mode 只认 ${ARMS.join(' / ')}，收到 ${bad}`);
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const loaded = loadTasks(opts.tasksDir);
  const tasks = opts.limit > 0 ? loaded.tasks.slice(0, opts.limit) : loaded.tasks;
  if (!tasks.length) throw new Error(`题集是空的：${opts.tasksDir}（题集不入库，缺它就没人可问）`);
  const corpus = prepareCorpus(opts.store, DEFAULTS);
  const tools = makeTools(corpus, opts.store);
  const model = await resolveModel(opts.baseUrl, opts.model);
  const cfg = {
    baseUrl: opts.baseUrl, model, maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs, maxCalls: opts.maxCalls, settings: DEFAULTS,
  };
  console.log(`本地模型 ${model} @ ${opts.baseUrl}`);
  console.log(`题集 ${tasks.length} 题 × ${opts.modes.length} 臂，工具调用上限 ${opts.maxCalls} 次\n`);

  const arms = [];
  for (const arm of opts.modes) {
    const rows = [];
    for (const task of tasks) {
      const row = await runTask({ arm, task, corpus, tools, storePath: opts.store, cfg });
      rows.push(row);
      const mark = row.pass ? '✓' : row.judged ? '✗' : '!';
      console.log(`${arm.padEnd(5)} ${mark} ${task.id.padEnd(38)} 调用${row.toolCalls} ${row.turns}轮 ${(row.elapsedMs / 1000).toFixed(1)}s`);
    }
    const summary = summarizeArm(rows);
    arms.push({ ...summary, rows });
    console.log(`\n── ${arm} ── 调用率 ${(summary.toolCallRate * 100).toFixed(1)}% | 通过率 ${(summary.passRate * 100).toFixed(1)}% | 均注入 ${summary.avgInjectedTokens.toFixed(1)} tok | 均工具返回 ${summary.avgToolResultTokens.toFixed(1)} tok\n`);
  }

  const outPath = opts.out || join(DEFAULT_RESULTS_DIR, `tool-use-${Date.now()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({
    tool: 'bench/tool-use-eval.mjs',
    generatedAt: new Date().toISOString(),
    model,
    baseUrl: opts.baseUrl,
    store: opts.store,
    tasks: tasks.length,
    maxCalls: opts.maxCalls,
    arms: arms.map(({ rows, ...rest }) => rest),
    rows: arms.flatMap((a) => a.rows),
  }, null, 2)}\n`);
  console.log(`落盘：${outPath}`);
  return { arms, outPath };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });
}
