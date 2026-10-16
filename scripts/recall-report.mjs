#!/usr/bin/env node
/**
 * 记忆周报 —— 把账本翻成一段人话：这段时间记忆有没有在干活、花了多少上下文、
 * 哪些笔记真被用上、为什么有些轮次一个字都没进、消费侧门控会拦谁。
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
import { readAudit } from '../audit.js';
import { readDocs } from '../store.js';
import {
  GATE_DEFAULTS,
  gateReport,
  markSelfTouches,
  normalizeGate,
  noteLedgerStats,
  suppressReady,
} from '../confidence.js';
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
                    前五节与第六节的回放按这个窗口算；第六节的门槛与两份名单
                    看的是**整本账本**（和实时门控同一个口径，不然同一条笔记
                    在报告里和在运行时会被判成两样）
  --store <目录>    记忆库目录（默认 ~/memory/engramory）
  --ledger <文件>   账本文件（默认 <库>/${USAGE_FILE}）
  --config <文件>   宿主配置文件（默认自动找 ~/.dsh/profiles/*/cordis.patch.yml）
                    「消费侧门控」的档位（gate）也从这个文件里读
  --top <N>         各榜单列几条（正整数，默认 5；门控的两份名单同样受它限制）
  --json            输出 JSON（stdout 只有 JSON，提示走 stderr）
  --help            看这份用法

报告的第六节是「消费侧门控」：现在这两份名单是谁，以及**账本回放**——
把历史指针按「当时要是开了 enforce，这条够不够抑制线」重算一遍，
再看其中多少条后来真被读过（假杀）。
  够不够线一律问 confidence.js 的 suppressReady()：门槛是**按本库基础打开率**
  算出来的（不是固定 12 次），所以这个库里到底几条算够，看第六节那行「本库门槛」。
  账本太短（跨度不到观察天数）或一条指针都没有时，这一节只写「数据还不够」，
  不把 0 印成结论。
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
 *
 * 返回值多一个 `gate`：消费侧门控的档位。`mode` 是**实际生效**的档（缺省或写了不认识的值
 * 时回落 `assist`），`raw` 是配置里原样写了什么（没写就是 null）。两个都留着，是为了
 * 报告能说清「这个档是你设的、还是插件的默认」—— 只印一个数，读的人分不出是自己配错了
 * 还是插件就该这样，而这两种情况该做的事完全不同。
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
    if (found) {
      const raw = 'gate' in values ? values.gate : null;
      const mode = normalizeGate(raw, GATE_DEFAULTS.mode);
      // 归一之后把 `values.gate` 也换成生效值：第四节会把没列出的键原样打印，
      // 留着原始值就会出现「档位写 off、生效值却印 off」之外的第三种说法。
      values.gate = mode;
      return { source: file, values, searched: candidates, gate: { mode, raw, default: GATE_DEFAULTS.mode } };
    }
  }
  return {
    source: null,
    values: {},
    searched: candidates,
    gate: { mode: GATE_DEFAULTS.mode, raw: null, default: GATE_DEFAULTS.mode },
  };
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
 * 负反馈回放：把账本正着走一遍，回答「要是我当时开了 `enforce`，会拦掉谁、拦对了吗」。
 *
 * 为什么必须**增量**维护 as-of 统计：抑制判据里有「观察够久」这一条，它比的是
 * 「这条笔记第一次被携带」到「这一轮」的距离。今天回看过去某一轮时，用**今天**的统计
 * 去判它，等于拿一年后的证据否定当时的一次决定 —— 那既不是当时会发生的，也不是判据的本意。
 * 所以每一行只看得见它之前（含它自己）的账。
 *
 * 三个口径，都是刻意的：
 * 1. **走的是判据，不是当时的档位。** 老账本里没有 `demoted` / `suppressed`（0.15.1 起才落盘），
 *    而且历史账本里 `gate` 多数根本没开。这里一律调 `confidence.js#suppressReady()` ——
 *    抑制线只有那一份，回放自己抄一套阈值，两份就会在改阈值时分叉。
 * 2. **只报「够到抑制线」的指针条数。** 一条笔记被携带 30 次、第 12 次就够线了，那后面每一轮
 *    的注入都是「本来会被拦掉」的一次 —— 假杀就是按这些指针条数算的，不是按笔记篇数。
 * 3. **自我触碰的读不算「被用上」。** 与实时门控同一套判据（审计里有写入，且读与写在
 *    `selfTouchMs` 内）：刚写完就翻回来看，不能算这篇笔记后来被需要了。
 *
 * @param {object[]} lines 账本行（任意顺序；`ts` 缺失的行不参与回放，另计）
 * @param {{since?: number, selfTouchMs?: number, auditLines?: object[], examples?: number}} [options]
 * @returns {object} 见下面 `stats` 的拼装
 */
export function replayGate(lines, options = {}) {
  const rows = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && typeof line === 'object')
    // 时间戳缺失就没法谈「之前 / 之后」：如实单列，不塞进 0 了事。稳定排序保证同刻的行保持账本顺序。
    .map((line, i) => ({ line, i }))
    .sort((a, b) => Number(a.line.ts ?? 0) - Number(b.line.ts ?? 0) || a.i - b.i)
    .map(({ line }) => line);
  const since = Number.isFinite(Number(options.since)) ? Number(options.since) : 0;
  const selfTouchMs = Number(options.selfTouchMs ?? GATE_DEFAULTS.selfTouchMs);
  const maxExamples = Math.max(0, Math.floor(Number(options.examples) || 3));
  const inWindow = (ts) => !since || (Number.isFinite(ts) && ts >= since);

  // 审计里「库内写入」的时刻 —— 自我触碰的判据与 `markSelfTouches` 逐字一致
  // （`verdict === 'allow'` + 写入时刻在读取前后 `selfTouchMs` 之内）。
  const writes = new Map();
  for (const row of Array.isArray(options.auditLines) ? options.auditLines : []) {
    if (!row || row.verdict !== 'allow' || typeof row.file !== 'string' || !row.file) continue;
    if (!writes.has(row.file)) writes.set(row.file, []);
    const ts = Number(row.ts);
    if (Number.isFinite(ts)) writes.get(row.file).push(ts);
  }
  const isSelfTouch = (id, at) => {
    const list = writes.get(id);
    return Array.isArray(list) && list.some((w) => Math.abs(w - at) <= selfTouchMs);
  };

  const stats = {
    /** 回放看到的行数（含非 hit 行），以及因缺 `ts` 被排除的行数。 */
    rows: rows.length,
    missingTs: (Array.isArray(lines) ? lines : []).length - rows.length,
    firstTs: rows.length ? Number(rows[0].ts ?? 0) || 0 : 0,
    lastTs: rows.length ? Number(rows[rows.length - 1].ts ?? 0) || 0 : 0,
    spanDays: 0,
    /** 观察窗口下限（`suppressReady` 的 observeDays）：回放判不出一条时，得说清是「没到线」还是「还没到能判的时候」。 */
    observeDays: Number(GATE_DEFAULTS.observeDays),
    /** 指针：`kind:'hit'` 行里被带进上下文的那几条。窗口内 / 外分开数，因为报告只讲窗口内的。 */
    pointers: { count: 0, outsideWindow: 0, rounds: 0, outsideWindowRounds: 0 },
    hitLine: { count: 0, outsideWindow: 0 },
    falseKills: { count: 0, outsideWindow: 0 },
    selfTouchSkips: 0,
    examples: [],
  };
  stats.spanDays = stats.firstTs && stats.lastTs ? (stats.lastTs - stats.firstTs) / 86400000 : 0;

  const stat = new Map(); // id → 截至该行的 as-of 统计（suppressReady 只读 carried / used / firstCarriedAt）
  const of = (id) => {
    if (!stat.has(id)) stat.set(id, { carried: 0, used: 0, firstCarriedAt: 0 });
    return stat.get(id);
  };
  const pending = new Map(); // id → 已经够到抑制线、还在等「后来有没有被读」的那条指针
  /**
   * 记一次「假杀」：`p` 是够线的那一次携带，`readTs` 是**后来那次读**的时间戳。
   *
   * 两个时间戳缺一不可：窗口判定要用**读**的时间（它落在窗口外就不算这条结论），
   * 而 `gapDays`（拦下之后多久才被读）要用两个时间戳相减 —— 曾经把读的时间戳丢了，
   * 于是例子里的 `gapDays` 恒为 null，报告少了一列还看不出来。
   */
  const kill = (p, readTs, genuine) => {
    if (!p) return;
    pending.delete(p.id);
    stats.falseKills[genuine && inWindow(readTs) ? 'count' : 'outsideWindow'] += 1;
    if (stats.examples.length >= maxExamples) return;
    stats.examples.push({
      id: p.id,
      carried: p.carried,
      observedDays: p.observedDays,
      confidence: p.confidence,
      hitAt: p.ts,
      usedAt: readTs,
      gapDays: readTs - p.ts >= 0 ? (readTs - p.ts) / 86400000 : null,
    });
  };

  for (const line of rows) {
    const ts = Number(line.ts);
    const kind = String(line.kind ?? '');
    const win = inWindow(ts);
    if (kind === 'hit' && Array.isArray(line.ids)) {
      if (win) stats.pointers.rounds += 1;
      else stats.pointers.outsideWindowRounds += 1;
      for (const id of line.ids) {
        if (typeof id !== 'string' || !id) continue;
        if (win) stats.pointers.count += 1;
        else stats.pointers.outsideWindow += 1;
        const s = of(id);
        s.carried += 1;
        if (!s.firstCarriedAt) s.firstCarriedAt = ts;
        // 抑制判据只调这一个函数：回放与实时门控共用同一条线，改阈值不会两边分叉。
        if (suppressReady(s, { now: ts })) {
          if (win) stats.hitLine.count += 1;
          else stats.hitLine.outsideWindow += 1;
          pending.set(id, {
            ts,
            id,
            carried: s.carried,
            observedDays: (ts - s.firstCarriedAt) / 86400000,
            confidence: (s.used + GATE_DEFAULTS.prior.alpha)
              / (s.carried + GATE_DEFAULTS.prior.alpha + GATE_DEFAULTS.prior.beta),
          });
        }
      }
      continue;
    }
    if ((kind === 'used' || kind === 'opened') && typeof line.id === 'string' && line.id) {
      // 自我触碰的读先剔掉：与 `markSelfTouches` 同一判据（刚写完又读回来，不算这条笔记被需要）。
      if (isSelfTouch(line.id, ts)) {
        stats.selfTouchSkips += 1;
        continue;
      }
      const s = of(line.id);
      s.used += 1;
      if (pending.has(line.id)) kill(pending.get(line.id), ts, true);
    }
  }
  return stats;
}

/**
 * 组装报告（纯函数：给行数据与选项，返回可打印的文本 + 同一份数据的 JSON）。
 *
 * @param {Array<object>} lines 账本行（`readUsage` 的产物，已带 ts）
 * @param {{days?: number, top?: number, now?: number, store?: string, ledger?: string,
 *          settings?: {source: string|null, values: Record<string, unknown>, gate?: object},
 *          profile?: object, defaults?: object, version?: string,
 *          docs?: Map<string, object>|object[], auditLines?: object[]}} options
 *   `docs` / `auditLines` 是消费侧门控的另外两样输入（笔记元数据、写入审计）：
 *   传进来才谈得上「哪些过期」与「哪些读是自我触碰」。给不出就按空算，并在报告里说清。
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

  // ── 消费侧门控的三样输入 ────────────────────────────────────────────────
  // 档位：缺省 `assist`，经 `normalizeGate` 归一（配置里写了不认识的值时回落默认档，
  // 但 `raw` 留着 —— 报告要说清「这个档是你设的、还是插件的默认」）。
  const gateSetting = settings.gate ?? {};
  // 这里不能用 `??`：`raw: null` 是「patch 里根本没写 gate」这个**结论**，用 `??` 会一路
  // 落到 `values.gate`（resolveSettings 把它归一成了生效值），于是第④节会把默认档印成
  // 「你设的 gate: assist」—— 正是这一节最不该犯的错（读不到就说读不到）。
  const hasGateSetting = gateSetting.raw !== undefined && gateSetting.raw !== null;
  const gateMode = normalizeGate(gateSetting.mode ?? values.gate, GATE_DEFAULTS.mode);
  const gateRaw = hasGateSetting ? gateSetting.raw : (gateSetting.mode ? null : (values.gate ?? null));
  // 门控的统计（携带/被读/自我触碰）与实时门控同一套：`noteLedgerStats` + `markSelfTouches`，
  // 扣掉自我触碰之后再判「总也用不上」—— 否则模型自己写完马上读回来，就能把一篇死笔记喂成活的。
  const gateStats = noteLedgerStats(all);
  const auditLines = Array.isArray(options.auditLines) ? options.auditLines : [];
  const selfTouched = markSelfTouches(gateStats, auditLines, { selfTouchMs: GATE_DEFAULTS.selfTouchMs });
  // `readDocs` 返回的是数组（长笔记切桶 ⇒ 同一 id 多份），门控只要元数据，留第一条。
  const docs = options.docs instanceof Map ? options.docs : new Map();
  if (Array.isArray(options.docs)) {
    for (const doc of options.docs) if (doc?.id && !docs.has(doc.id)) docs.set(doc.id, doc);
  }
  const gate = gateReport(gateStats, docs, {
    mode: gateMode,
    now,
    staleDays: Number(values.gateStaleDays) || GATE_DEFAULTS.staleDays,
    selfTouched,
  });
  const replay = replayGate(all, { since, auditLines, selfTouchMs: GATE_DEFAULTS.selfTouchMs });

  const out = [];
  const push = (s = '') => out.push(s);

  // ── 头 ─────────────────────────────────────────────────────────────────
  push(`# 记忆周报 · ${days > 0 ? `最近 ${days} 天` : '全部账本'}`);
  push('');
  push(`- 窗口：${when(summary.firstAt)} → ${when(summary.lastAt)}（账本共 ${fmt(all.length)} 行，落在窗口里 ${fmt(windowLines.length)} 行）`);
  push(`- 记忆库：${store}`);
  push(`- 账本：${ledger}`);
  push(`- 版本：dsh-engramory-recall@${version}`);
  push(`- 消费侧门控：${gateMode}（第六节）`);
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
    ['gate', `消费侧门控档位（off 不干预 / shadow 只记账 / assist 降权 / enforce 移出注入；插件默认 ${GATE_DEFAULTS.mode}）`],
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
  push('- 第⑥节回放走的是**判据**、不是当时的档位：抑制线是 `confidence.js#suppressReady()`（只有这一份），'
    + '所以它答的是「按今天的线，当时会拦谁」，不等于当时真拦了谁。');
  push('- 老账本里没有 `demoted` / `suppressed` 这两个字段（0.15.1 起才落盘），回放因此只能重算，不能翻旧账。');
  push('- 回放里的「被用上」已经剔除自我触碰（判定同 `usage.js` / `audit.js` 的口径），所以「假杀」是**保守估计**：'
    + '被剔掉的那些读里，本来可能也有一部分是真需要。');
  push('');

  // ── 六、消费侧门控 ──────────────────────────────────────────────────────
  // 这一节回答的是「这条笔记值不值得占上下文」：检索只回答「像不像」，值不值得只有账本知道。
  push('## 六、消费侧门控：值不值得占上下文');
  push('');
  {
    // 档位来源：读到了就说读到哪份文件的哪个值；读不到（或写了不认识的值）就明说是哪一步的默认 ——
    // 沿用第④节的纪律，不许悄悄回落冒充用户设置。
    const gateWhere = settings.source
      ? (gateRaw === null
        ? `${settings.source} 里没写 gate ⇒ 用默认档 ${GATE_DEFAULTS.mode}`
        : (normalizeGate(gateRaw, '') === gateMode
          ? `${settings.source} 里写的是 gate: ${gateRaw}`
          : `${settings.source} 里写的是 ${JSON.stringify(gateRaw)}（不认识）⇒ 回落默认档 ${GATE_DEFAULTS.mode}`))
      : `没读到宿主配置 ⇒ 用默认档 ${GATE_DEFAULTS.mode}`;
    push(`- 档位：**${gateMode}**（${gateWhere}）`);
    // 两条线都是**本库算出来的**（基础打开率 → 门槛），不是固定数字：里子写死一个 12，
    // 改了 baseRate 或先验之后报告就会骗人，所以这里一律印 gate.policy 的活值。
    const sampleNote = gate.policy.baseSource === 'prior'
      ? `本库共携带 ${fmt(gate.policy.carriedSamples)} 次，样本不够，改按先验算 —— 比按本库账本算更保守`
      : `按本库账本算，共 ${fmt(gate.policy.carriedSamples)} 次携带`;
    push(`- 本库门槛（${sampleNote}）：基础打开率 ${pct(gate.policy.baseRate)} ⇒ 携带 ≥${fmt(gate.policy.demoteAt)} 次开始降权 · `
      + `≥${fmt(gate.policy.suppressAt)} 次才算「够到抑制线」（enforce 档会把它移出注入）· `
      + `两条线都还要观察 ≥${fmt(gate.policy.observeDays)} 天`);
    push(`- 另外几条活值：最少携带 ${fmt(gate.policy.minEvidence)} 次才谈得上「用不上」· `
      + `assist 降权系数 ${gate.policy.demote} · project 类 ${fmt(gate.policy.staleDays)} 天没动算过期 · `
      + `刚写完 ${Math.round(gate.policy.selfTouchMs / 60000)} 分钟内读回来的不算「被用上」`);
    if (!settings.source) push('  （档位这一行是按插件的默认档说的，不是你配的 —— 没读到配置就不编来源。）');
    push('');

    // ── 两份名单 ────────────────────────────────────────────────────────
    push(`### 6.1 总也用不上（携带 ≥${fmt(gate.policy.minEvidence)} 次、一次没被用上）`);
    push('');
    const ignoredShown = gate.ignored.slice(0, top);
    // 自我触碰（刚写完又读回来）不算「被用上」：这一条要是闷着不说，名单容易被读成
    // 「这些笔记作者自己都不看」，而那部分读其实已经剔掉了。
    const ignoredSelfTouch = gate.ignored.reduce((n, it) => n + (it.selfTouch || 0), 0);
    if (ignoredShown.length) {
      for (const it of ignoredShown) {
        push(`  - ${it.id} — 携带 ${fmt(it.carried)} 次 · 被读过 ${fmt(it.used)} 次 · 自我触碰 ${fmt(it.selfTouch)} 次 · 置信度 ${it.confidence.toFixed(3)}`);
      }
      if (gate.ignored.length > ignoredShown.length) push(`  （共 ${fmt(gate.ignored.length)} 条，这里按携带次数列前 ${fmt(ignoredShown.length)} 条，--top 可调）`);
      if (ignoredSelfTouch > 0) push(`  （这些笔记身上共有 ${fmt(ignoredSelfTouch)} 次读是「刚写完又读回来」，已经不算「被用上」。）`);
    } else {
      push('目前没有需要留意的笔记：还没有一条笔记同时满足「携带够多」与「一次没被用上」。');
    }
    push('');

    push(`### 6.2 过期（project- 类、超过 ${fmt(gate.policy.staleDays)} 天没更新）`);
    push('');
    const staleShown = gate.stale.slice(0, top);
    if (staleShown.length) {
      for (const it of staleShown) push(`  - ${it.id} — ${fmt(Math.round(it.ageDays))} 天没更新`);
      if (gate.stale.length > staleShown.length) push(`  （共 ${fmt(gate.stale.length)} 条，--top 可调）`);
    } else if (docs.size) {
      push('目前没有需要留意的笔记：没有哪篇 project- 类笔记久到该更新。');
    } else {
      push('目前没有需要留意的笔记：这次没读到库里的笔记元数据（读不到 mtime 就不判过期，宁可漏报）。');
    }
    push('');

    // ── 6.3 回放：要是当时开了 enforce ────────────────────────────────────
    const hitThreshold = gate.policy.suppressAt; // 线是这条，别在文案里再抄一个数
    push('### 6.3 负反馈回放：要是当时开了 enforce，会拦掉谁、拦对了吗');
    push('');
    const suffix = replay.missingTs > 0 ? `；另有 ${fmt(replay.missingTs)} 行没有时间戳、不参与回放` : '';
    // 数据不足的三种形状要分开说：账本空 / 账本太短 / 压根没有指针。
    // 「没判出一条」与「判了，结果没事」是两句话，混在一起就是 0 当结论。
    const tooShort = replay.spanDays < replay.observeDays;
    if (!replay.pointers.count) {
      push('数据还不够：这个窗口里没有一条记录着「带进去了哪几条」的指针，回放没有样本。');
    } else if (tooShort) {
      // 先说不够，再摆扫出来的数 —— 顺序反了「0 条」就会被当成结论。
      push(`数据还不够：账本只有 ${replay.spanDays.toFixed(1)} 天，而「一次没被用上」要观察满足 ${fmt(replay.observeDays)} 天才算数`
        + `（本机账本上限 512KB、读回最近 5000 行，更早的行已经不在文件里，所以老账本本来就只有这么长）—— 现在判不出一条，不是判过了没事。`);
      push(`  扫过的底子（这些是分母，不是结论）：${fmt(replay.pointers.rounds)} 轮注入·${fmt(replay.pointers.count)} 条指针`
        + `，够不够抑制线无从谈起${replay.selfTouchSkips > 0 ? `；另外自我触碰的读已剔除 ${fmt(replay.selfTouchSkips)} 次` : ''}。`);
    } else if (!replay.hitLine.count) {
      // 时间够长还是一条都不够线：缺的是「携带次数」这条件。**这条线上不摆「扫了 N 轮」**——
      // 一个够线都没有的时候，那行数字读起来就是成绩单，而它其实只是分母（真实库正是这一支）。
      push(`数据还不够：扫了 ${fmt(replay.pointers.count)} 条指针，没有一条在当时就够到抑制线 —— `
        + `这个库的线是携带 ≥${fmt(hitThreshold)} 次且观察 ≥${fmt(replay.observeDays)} 天，账本里的指针还差得远，`
        + `所以「开 enforce 会拦掉谁」现在还是未知数，不是判过了没事${suffix}。`);
    } else {
      push(`正着扫了 ${fmt(replay.pointers.rounds)} 轮注入：**${fmt(replay.pointers.count)} 条指针**，`
        + `其中 **${fmt(replay.hitLine.count)} 条**在当时就够到了抑制线（${pct(replay.hitLine.count / replay.pointers.count)}），`
        + `这些里面 **${fmt(replay.falseKills.count)} 条**后来真被读过（假杀率 ${pct(replay.falseKills.count / replay.hitLine.count)})${suffix}。`);
      if (!replay.falseKills.count) {
        push('够到抑制线的这些指针，后来一次都没被真读过 —— 这一轮要是开 enforce，拦掉的都是没人要的。');
      } else {
        push('上面这些例子说明：够到抑制线的指针里，有一部分后来真被读了 —— 那几轮要是开了 enforce，线索就断在这儿。');
        if (replay.examples.length) {
          push('');
          push('够到抑制线、后来又被读了的例子（最多 3 条）：');
          for (const ex of replay.examples) {
            push(`  - ${ex.id} — 够线时已携带 ${fmt(ex.carried)} 次、观察 ${ex.observedDays.toFixed(1)} 天：`
              + `拦下 ${when(ex.hitAt)}，随后 ${when(ex.usedAt)} 真被读了（相隔 ${fmt(Math.max(0, Math.round(ex.gapDays)))} 天）`);
          }
          if (replay.examples.length < replay.falseKills.count) {
            push(`  （还有 ${fmt(replay.falseKills.count - replay.examples.length)} 条假杀没列出来：例子只列 3 条，数字是全部的。）`);
          }
        }
      }
      if (replay.selfTouchSkips > 0) {
        push('');
        push(`（自我触碰的读已剔除：刚写完 ${Math.round(GATE_DEFAULTS.selfTouchMs / 60000)} 分钟内读回来的 ${fmt(replay.selfTouchSkips)} 次不算「被用上」，所以假杀只会少算、不会多算。）`);
      }
    }
    push('');
  }

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
      // 消费侧门控：档位（+ 它从哪儿来）、当前两份名单、以及账本回放。
      // `gate` 与 `gateReport()` 的形状一致，少一个来源字段都不行 —— 不然读 JSON 的人也分不清
      // 「档位是设的」还是「默认的」。
      gate: { ...gate, source: settings.source ?? null, raw: gateRaw, default: GATE_DEFAULTS.mode },
      replay,
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
    : { source: null, values: {}, gate: { mode: GATE_DEFAULTS.mode, raw: null, default: GATE_DEFAULTS.mode } };
  const lines = readUsage(STORE, 5000);
  // 门控的另外两样输入：笔记元数据（只用来判过期，读不到就一律不判）与写入审计（剔自我触碰）。
  const docs = readDocs(STORE);
  const auditLines = readAudit(STORE, 500);
  const report = buildReport(lines, {
    days: DAYS,
    top: TOP,
    store: STORE,
    ledger: LEDGER,
    settings,
    docs,
    auditLines,
  });
  if (wantJson) io.stdout(`${JSON.stringify(report.json, null, 2)}\n`);
  else io.stdout(`${report.text}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
