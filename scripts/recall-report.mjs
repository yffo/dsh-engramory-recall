#!/usr/bin/env node
/**
 * 记忆周报 —— 把账本翻成一段人话：这段时间记忆有没有在干活、花了多少上下文、
 * 哪些笔记真被用上、为什么有些轮次一个字都没进。
 *
 * 用法：node scripts/recall-report.mjs [--days 7] [--store <目录>] [--ledger <文件>]
 *   [--config <cordis.patch.yml>] [--top 5] [--json] [--help]
 *
 * 三条纪律（都不是装饰）：
 * 1. 只报账本里真有的东西。缺字段的轮次**单列**计数，不拿 0 冒充（与面板同一条纪律）。
 * 2. 参数、判据一律取自活代码：引擎参数来自 `bm25.js#scoringProfile()`，宿主设置来自
 *    你 profile 的 `cordis.patch.yml`（路径原样印出来），插件默认来自 `index.js#DEFAULTS`。
 *    报告里没有第二个数字来源 —— 抄一份常量过来，改了代码而报告不变，那份报告就是谎话。
 * 3. stdout 是报告本身（`--json` 时是能被 JSON.parse 的纯数据），提示一律走 stderr。
 *
 * 导入本文件不会跑报告（只在直接执行时跑）：`main` 有入口守卫。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoringProfile } from '../bm25.js';
import { DEFAULTS } from '../index.js';
import {
  budgetVerdict,
  plainTerms,
  readUsage,
  reasonLabel,
  reasonVerdict,
  scoreCurveVerdict,
  summarizeUsage,
  truncationVerdict,
  usageVerdict,
  USAGE_FILE,
} from '../usage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const USAGE = `用法：node scripts/recall-report.mjs [选项]

  --days <N>        只看最近 N 天（正整数，默认 7；给 0 = 全部）
  --store <目录>    记忆库目录（默认 ~/memory/engramory）
  --ledger <文件>   账本文件（默认 <库>/${USAGE_FILE}）
  --config <文件>   宿主配置文件（默认自动找 ~/.dsh/profiles/*/cordis.patch.yml）
  --top <N>         各榜单列几条（正整数，默认 5）
  --json            输出 JSON（stdout 只有 JSON，提示走 stderr）
  --help            看这份用法
`;

/**
 * 提示一律走 `io.stderr`（给得出就给它，给不出才直接写进程）——
 * `main()` 的 io 注入就是为这件事存在的：没走 io 的提示在测试里会**凭空消失**，
 * 于是「不认识的参数要提示」这条约定谁也没钉住。
 */
const note = (msg, io) => (io?.stderr ?? ((s) => process.stderr.write(s)))(`[recall-report] ${msg}\n`);

// ── 参数 ──────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set(['--days', '--store', '--ledger', '--config', '--top', '--json', '--help', '-h']);

/** `--name value` 取值（吃下一个参数）；`--name=value` 也认。 */
function makeOpt(argv) {
  return (name) => {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = String(argv[i]);
      if (arg === name) return { given: true, value: argv[i + 1] === undefined ? '' : String(argv[i + 1]) };
      if (arg.startsWith(`${name}=`)) return { given: true, value: arg.slice(name.length + 1) };
    }
    return { given: false, value: undefined };
  };
}

function makeNumOpt(argv, opt) {
  return (name, fallback, { min = 0 } = {}) => {
    const { given, value } = opt(name);
    if (!given) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) {
      note(`${name} 需要一个 ≥${min} 的数（收到 ${JSON.stringify(value)}）—— 已用默认值 ${fallback}`);
      return fallback;
    }
    return Math.floor(n);
  };
}

// ── 宿主设置：从 profile 的 cordis.patch.yml 里读，不猜 ─────────────────────
/**
 * 从一份 cordis patch 里抠出 `- id: engramory-recall` 那一段的 config 键值。
 *
 * 只做**够用**的解析：patch 是「整段替换 config」的 YAML 数组，我们要的就是那个 id 下面
 * 的键值对。不引 YAML 依赖（本插件零依赖），所以不做嵌套结构 —— 这些键本来就都是标量。
 * 解析不出东西就返回空对象，报告照实说「这份文件里没找到这一段」。
 *
 * @param {string} text
 * @returns {{values: Record<string, string|number|boolean>, found: boolean}}
 */
export function parsePatchSettings(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => /^-\s+id:\s*engramory-recall\s*$/.test(line.trimEnd()));
  if (start === -1) return { values: {}, found: false };
  const SKIP = new Set(['id', 'name', 'config']);
  const values = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // 下一个数组项 = 这段结束
    if (/^-\s/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (SKIP.has(key)) continue;
    // 去掉行尾注释（只在「空白 + #」时才当注释，免得把 `#fff` 这类值切掉）
    let value = m[2].replace(/\s+#\s.*$/, '').trim();
    if (value === '') continue; // 嵌套块（我们不解析）—— 如实跳过
    value = value.replace(/^["']|["']$/g, '');
    if (value === 'true' || value === 'false') values[key] = value === 'true';
    else if (/^-?\d+$/.test(value)) values[key] = Number(value);
    else if (/^-?\d*\.\d+$/.test(value)) values[key] = Number(value);
    else values[key] = value;
  }
  return { values, found: true };
}

/** 找默认位置上的 profile patch（`~/.dsh/profiles/<名字>/cordis.patch.yml`）。 */
export function findProfilePatches(home = homedir()) {
  const root = join(home, '.dsh', 'profiles');
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, 'cordis.patch.yml');
    if (existsSync(candidate)) out.push(candidate);
  }
  return out.sort();
}

/**
 * 决定报告里「宿主设置」那一节用哪份文件、值是什么。
 * 优先 `--config`；否则扫 profile，挑**真含这段配置**的那份。找不到就如实返回空。
 */
export function resolveSettings({ config, home = homedir(), io } = {}) {
  const candidates = config ? [config] : findProfilePatches(home);
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      note(`读不了配置文件 ${file}：${err?.message ?? err}`, io);
      continue;
    }
    const { values, found } = parsePatchSettings(text);
    if (found) return { source: file, values, searched: candidates };
  }
  return { source: null, values: {}, searched: candidates };
}

// ── 报告 ──────────────────────────────────────────────────────────────────
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const pct = (x) => `${(Number(x ?? 0) * 100).toFixed(1)}%`;
const when = (ms) => {
  if (!Number.isFinite(ms) || !ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 组装报告（纯函数：给行数据与选项，返回可打印的文本 + 同一份数据的 JSON）。
 *
 * @param {Array<object>} lines 账本行（`readUsage` 的产物，已带 ts）
 * @param {{days?: number, top?: number, now?: number, store?: string, ledger?: string,
 *          settings?: {source: string|null, values: Record<string, unknown>}, profile?: object,
 *          defaults?: object, version?: string}} options
 */
export function buildReport(lines, options = {}) {
  const days = Number.isFinite(options.days) ? Number(options.days) : 7;
  const top = Math.max(1, Math.floor(Number(options.top) || 5));
  const now = Number(options.now) || Date.now();
  const all = Array.isArray(lines) ? lines : [];
  const since = days > 0 ? now - days * 86400000 : 0;
  const windowLines = since ? all.filter((line) => Number(line?.ts ?? 0) >= since) : all;

  const settings = options.settings ?? { source: null, values: {} };
  const values = settings.values ?? {};
  const summary = summarizeUsage(windowLines, {
    maxPointers: Number(values.maxPointers) || 0,
    positions: 5,
  });
  const profile = options.profile ?? scoringProfile();
  const defaults = options.defaults ?? DEFAULTS;
  const version = options.version ?? PKG.version;
  const store = options.store ?? '(未指定)';
  const ledger = options.ledger ?? '(未指定)';

  const out = [];
  const push = (s = '') => out.push(s);

  // ── 头 ─────────────────────────────────────────────────────────────────
  push(`# 记忆周报 · ${days > 0 ? `最近 ${days} 天` : '全部账本'}`);
  push('');
  push(`- 窗口：${when(summary.firstAt)} → ${when(summary.lastAt)}（账本共 ${fmt(all.length)} 行，落在窗口里 ${fmt(windowLines.length)} 行）`);
  push(`- 记忆库：${store}`);
  push(`- 账本：${ledger}`);
  push(`- 版本：dsh-engramory-recall@${version}`);
  push('');

  // ── 一、有没有在干活 ────────────────────────────────────────────────────
  const coverage = summary.coverage ?? { rounds: 0, injected: 0, zeroInjected: 0, injectedShare: 0, byKind: {} };
  push('## 一、这段时间记忆有没有在干活');
  push('');
  push(`宿主问了 ${fmt(coverage.rounds)} 轮：**${fmt(coverage.injected)} 轮真的带了记忆进上下文（${pct(coverage.injectedShare)}）**，`
    + `另外 ${fmt(coverage.zeroInjected)} 轮一个字都没进（这同样是结论，不是空白）。`);
  const skips = Object.entries({ ...(summary.skipReasons ?? {}), ...(summary.emptyReasons ?? {}) })
    .map(([code, n]) => [reasonLabel(code), n])
    .sort((a, b) => b[1] - a[1]);
  if (skips.length) {
    push('');
    push('没进的都因为什么：');
    for (const [label, n] of skips.slice(0, 8)) push(`  - ${label}：${fmt(n)} 轮`);
  }
  push('');
  push(`带进去的 ${fmt(summary.pointers)} 条指针里，${fmt(summary.usedCounted ?? 0)} 条后来被打开过（**${pct(summary.openRate)}**）`
    + `—— 同一条在同一轮里读三次只算一次。`);
  push('');
  push(`- ${plainTerms(usageVerdict(summary))}`);
  push(`- ${plainTerms(reasonVerdict(summary))}`);
  push('');

  // ── 二、花了多少上下文 / 省下多少 ────────────────────────────────────────
  const cost = summary.cost ?? { rounds: 0, legacyRounds: 0, pointerChars: 0, noteChars: 0, savedChars: 0, savedRate: 0 };
  push('## 二、这块记忆花了多少上下文');
  push('');
  if (cost.rounds > 0) {
    push(`- 注入进上下文的字：**${fmt(cost.pointerChars)} 字**（含每轮的表头；共 ${fmt(cost.rounds)} 轮记着这笔账）`);
    push(`- 这些笔记整篇加起来：${fmt(cost.noteChars)} 字 —— 也就是说 **${pct(cost.savedRate)} 的字留在了磁盘上**，`
      + `没进上下文的有 ${fmt(cost.savedChars)} 字`);
    if (cost.legacyRounds > 0) {
      push(`- ⚠️ 另有 ${fmt(cost.legacyRounds)} 轮账本没有「整篇字数」这一项（0.15.0 起才落盘），上面的比例只覆盖有数据的那些轮`);
    }
    const use = summary.budgetUse ?? { n: 0, median: 0, p90: 0, full: 0 };
    if (use.n) {
      push(`- 预算：上限 ${fmt(values.maxChars ?? defaults.maxChars)} 字，中位用掉 ${pct(use.median)}、p90 ${pct(use.p90)}；`
        + `顶到天花板（≥95%）的有 ${fmt(use.full)} 轮`);
    }
  } else {
    push(`还没有一轮账本记着「整篇字数」（0.15.0 起才落盘）—— 现在只能看到注入了 ${fmt(summary.pointers)} 条指针，`
      + '算不出省下了多少上下文。');
  }
  push('');
  push(`- ${plainTerms(budgetVerdict(summary))}`);
  push(`- ${plainTerms(truncationVerdict(summary))}`);
  // ⚠️ 这三个判据收的是**各自那一段**（curve / truncation / summary），不是整个 summary：
  // 混着传的典型症状是「明明有 445 条带分的日志，报告却说还没有能校准门槛的日志」。
  push(`- ${plainTerms(scoreCurveVerdict(summary.scoreCurve))}`);
  push('');

  // ── 三、哪些笔记真在干活 ────────────────────────────────────────────────
  const notes = Array.isArray(summary.notes) ? summary.notes : [];
  const working = notes.filter((n) => n.opened > 0).sort((a, b) => b.opened - a.opened || b.injected - a.injected).slice(0, top);
  const idle = notes.filter((n) => !n.opened && n.injected >= 2).sort((a, b) => b.injected - a.injected).slice(0, top);
  push('## 三、哪些笔记真在干活');
  push('');
  if (working.length) {
    push('真被打开过（打开 / 被带入）：');
    for (const n of working) push(`  - ${n.id} — ${fmt(n.opened)} / ${fmt(n.injected)}`);
  } else {
    push('这窗口里还没有一条笔记被打开过（被带入过的有 ' + fmt(notes.length) + ' 条）。');
  }
  if (idle.length) {
    push('');
    push('总被带入、一次没打开：');
    for (const n of idle) push(`  - ${n.id} — 带入 ${fmt(n.injected)} 次`);
    push('');
    push('（多数是「看一眼文件名就够了」的指针；长期如此，要么描述不够勾人，要么它们本就不该占窗口。）');
  }
  push('');

  // ── 四、这套尺子现在怎么算 ──────────────────────────────────────────────
  push('## 四、这套尺子现在怎么算（都是活值，不是抄来的文档）');
  push('');
  push(`引擎（bm25.js）：k1=${profile.bm25.k1} · b=${profile.bm25.b} · 标题多计 ${profile.bm25.titleExtra} 次 · `
    + `单次查询最多 ${profile.bm25.queryTermCap} 个词 · 同义键 ${fmt(profile.bridge.synonymKeys)} 条 · `
    + `桥到的词权重 ${profile.bridge.bridgeWeight}（被桥的碎片 ${profile.bridge.bridgedFragmentWeight}）`);
  push(`片段：${profile.snippet.picker === 'idf' ? '按 IDF 加权挑句子' : '按命中词数挑行'} · `
    + `标题/描述打 ${profile.snippet.titleDiscount} 折 · 单条上限 ${profile.snippet.maxChars} 字 · `
    + `邻句扩展${profile.snippet.neighbor ? '开' : '关'}`);
  push(`已证伪、故意留着的机制：整句子串奖励 = ${profile.phraseBonus}（奖励「抄了提问的笔记」会把该命中的挤下去）`);
  const where = settings.source ? `来源：${settings.source}` : '没找到宿主的 profile 配置（没给 --config，也没在默认位置找到）';
  push(`宿主设置（${where}）：`);
  const shown = [
    ['enabled', '总开关'],
    ['maxPointers', `每次最多提醒几条（插件默认 ${defaults.maxPointers}）`],
    ['maxChars', `一轮提醒的字数上限（插件默认 ${defaults.maxChars}）`],
    ['minScore', `相关度门槛（插件默认 ${defaults.minScore}）`],
    ['nudge', '做完事顺带问一句要不要记一笔'],
    ['usageLog', '记不记账本'],
    ['semanticFusion', '语义接缝的融合口径'],
  ];
  let printed = 0;
  for (const [key, label] of shown) {
    if (!(key in values)) continue;
    push(`  - ${label}：${typeof values[key] === 'boolean' ? (values[key] ? '开' : '关') : values[key]}（${key}）`);
    printed += 1;
  }
  for (const [key, value] of Object.entries(values)) {
    if (shown.some(([k]) => k === key)) continue;
    push(`  - ${key}：${typeof value === 'boolean' ? (value ? '开' : '关') : value}`);
    printed += 1;
  }
  if (!printed) push('  - （这份配置里没读到 engramory-recall 那一段：报告里就不编数字）');
  push('');

  // ── 五、怎么读 ──────────────────────────────────────────────────────────
  push('## 五、怎么读这份报告（边界写在这儿，免得数字被读大）');
  push('');
  push('- 「被打开」的归属：某条笔记在**注入它的那一轮之后**被读过才算（只认最近一次注入它的轮）；更早的读不算数。');
  push('- 账本只存提问的前 160 字，所以「为什么这条没命中」这类问题得回会话里看原文。');
  push(`- 老账本缺字段的地方一律标注（比如上面「省下多少」只覆盖 ${fmt(cost.rounds)} 轮），不拿 0 补。`);
  push('- 判据是提示不是命令：样本少于 20 条时它自己会说「先攒样本」。');
  push('');

  return {
    text: out.join('\n'),
    json: {
      version,
      days,
      store,
      ledger,
      window: { from: summary.firstAt, to: summary.lastAt, rows: windowLines.length, totalRows: all.length },
      coverage,
      cost,
      summary,
      settings: { source: settings.source, values },
      profile,
      defaults: { maxPointers: defaults.maxPointers, maxChars: defaults.maxChars, minScore: defaults.minScore },
    },
  };
}

// ── 入口 ──────────────────────────────────────────────────────────────────
/**
 * @param {string[]} argv
 * @param {{stdout: (s: string) => void, stderr: (s: string) => void}} io
 */
export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(USAGE);
    return 0;
  }
  for (const arg of argv) {
    if (arg.startsWith('-') && !KNOWN_FLAGS.has(arg)) note(`不认识的参数：${arg}（--help 看用法）——已忽略`, io);
  }
  const opt = makeOpt(argv);
  const numOpt = makeNumOpt(argv, opt);
  const HOME = homedir();
  const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

  const storeOpt = opt('--store');
  const STORE = expandHome(storeOpt.given ? storeOpt.value : '~/memory/engramory');
  const ledgerOpt = opt('--ledger');
  const LEDGER = expandHome(ledgerOpt.given ? ledgerOpt.value : join(STORE, USAGE_FILE));
  const configOpt = opt('--config');
  const DAYS = numOpt('--days', 7);
  const TOP = numOpt('--top', 5, { min: 1 });
  const wantJson = argv.includes('--json');

  if (!existsSync(LEDGER)) {
    io.stdout(`还没有账本：${LEDGER}\n（账本在插件第一次注入记忆时才会创建；先正常聊几轮，或者用 --ledger 指到别的文件。）\n`);
    return 0;
  }
  const settings = STORE
    ? resolveSettings({ config: configOpt.given ? expandHome(configOpt.value) : undefined, home: HOME, io })
    : { source: null, values: {} };
  const lines = readUsage(STORE, 5000);
  const report = buildReport(lines, {
    days: DAYS,
    top: TOP,
    store: STORE,
    ledger: LEDGER,
    settings,
  });
  if (wantJson) io.stdout(`${JSON.stringify(report.json, null, 2)}\n`);
  else io.stdout(`${report.text}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
