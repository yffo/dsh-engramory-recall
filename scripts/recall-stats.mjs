#!/usr/bin/env node
/**
 * 召回打开率尺子（离线，不联网）。
 *
 * 它回答一个此前没人能回答的问题：**每轮注入的那几条指针，后来有几条被真的打开了？**
 *   · 分母 = `.engramory-recall.jsonl` 里的注入行（`ids` 按显示顺序）；
 *   · 分子 = 同一份日志里的 `used` 行（注入过的笔记后来被 read/edit）；
 *   · 对照组 = `opened` 行（没注入过也被主动打开）——说明「有些东西不注入也会看」。
 *
 * 为什么需要它：窗口该 4 条还是 8 条，此前只能按 hit@k 曲线猜；曲线说的是「答对排第几」，
 * 而注入的用途是「给模型一个路标」。打开率低 → 窗口在浪费上下文（该收窄或抬 minScore）；
 * 打开率高 → 窗口偏窄（按曲线放宽）。位置级曲线更进一步：第 4 条如果几乎没人打开，
 * 那放宽窗口就是白加字数。
 *
 * 用法：node scripts/recall-stats.mjs [--store ~/memory/engramory] [--json] [--positions 5] [--limit 2000]
 *   [--max-pointers 5]（给了才算「窗口用满了几轮」）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { budgetVerdict, readUsage, reasonVerdict, scoreCurveVerdict, summarizeUsage, usageVerdict, USAGE_FILE } from '../usage.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const HOME = homedir();
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(HOME, p.slice(2)) : p);
const STORE = expandHome(opt('--store', '~/memory/engramory'));
const POSITIONS = Math.max(1, Math.floor(Number(opt('--positions', '5'))) || 5);
const LIMIT = Math.max(10, Number(opt('--limit', '2000')) || 2000);
const wantJson = argv.includes('--json');
/** 原因码 → 人话（与 usage.js 的 reasonVerdict 用同一套口径）。 */
const REASON_LABELS = {
  chitchat: '寒暄 / 答话',
  'too-short': '消息太短',
  'empty-message': '空消息',
  duplicate: '与上一轮重复',
  'store-not-configured': '没配库路径',
  'index-empty': '库里没有笔记',
  'no-hits': '一条都不匹配',
  'below-min-score': '被 minScore 拦住',
  unspecified: '没记原因（早期日志）',
};
const reasonLabel = (code) => REASON_LABELS[code] ?? code;

// 窗口上限只用于「用满了几轮」这一句；不给就不算（--max-pointers 5）
const MAX_POINTERS = Math.max(0, Number(opt('--max-pointers', '0')) || 0);

const lines = readUsage(STORE, LIMIT);
const summary = summarizeUsage(lines, { positions: POSITIONS, neverOpenedLimit: 12, maxPointers: MAX_POINTERS });
const stamp = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');

if (wantJson) {
  console.log(JSON.stringify({ store: STORE, file: join(STORE, USAGE_FILE), lines: lines.length, summary }, null, 2));
  process.exit(0);
}

console.log(`召回日志：${join(STORE, USAGE_FILE)}`);
if (!existsSync(join(STORE, USAGE_FILE))) {
  console.log('\n还没有这份日志。它是 0.13.1 起才落的盘，而且要有**用户轮**才会写入——');
  console.log('先在 DSH 里聊几句（每轮自动召回都会记一行），再回来跑这把尺子。');
  process.exit(0);
}
console.log(`${lines.length} 行 · ${stamp(summary.firstAt)} → ${stamp(summary.lastAt)}\n`);

console.log('## 分母：注入了多少');
console.log('| 指标 | 值 |');
console.log('| --- | --- |');
console.log(`| 注入轮 | ${summary.injectRounds} |`);
console.log(`| 注入指针 | ${summary.pointers}${summary.injectRounds ? `（平均 ${(summary.pointers / summary.injectRounds).toFixed(1)} 条/轮）` : ''} |`);
console.log(`| 零命中轮 | ${summary.zeroRounds} |`);
console.log(`| 去重挡掉轮 | ${summary.dedupeRounds} |`);
console.log(`| 沉淀提醒轮 | ${summary.sedimentRounds} |`);
console.log(`| 拒写轮 | ${summary.denyRounds} |`);

console.log('\n## 分子：后来被打开了多少');
console.log('| 指标 | 值 |');
console.log('| --- | --- |');
// 分子用**去重后**的条数（同一条指针在同一轮里被反复读只算一次），与判据同一个口径：
// `summary.used` 是原始 used 行数（打开**次数**），拿它当分子会印出两套互相打架的打开率。
console.log(`| 注入后被打开 | ${summary.usedCounted ?? summary.used} |`);
console.log(`| **打开率** | **${pct(summary.usedCounted ?? summary.used, summary.pointers)}** |`);
console.log(`| 打开次数（未去重，同一轮重复读会重复计） | ${summary.used} |`);
console.log(`| 没注入也打开（对照） | ${summary.coldOpens} |`);
console.log(`| 被注入过的不同笔记 | ${summary.uniqueNotes} |`);

// 分母要按「谁在问」拆开：委派轮（子代理 / Agent Teams）的提示词里没有「先看记忆库」
// 这回事，它们的指针几乎注定不会被打开 —— 混在一起会把打开率系统性压低，
// 而打开率正是决定窗口宽窄的那个数（unknown = 升级到 0.13.7 之前写的老行）。
const byScope = summary.scopes ?? {};
if (Object.values(byScope).some((v) => v && v.pointers)) {
  console.log('\n## 按提问者拆开：主对话 vs 委派轮');
  console.log('| 提问者 | 注入轮 | 注入指针 | 打开 | 打开率 |');
  console.log('| --- | --- | --- | --- | --- |');
  const label = { main: '主对话轮', subagent: '子代理轮', unknown: '未标记（0.13.7 前）' };
  for (const key of ['main', 'subagent', 'unknown']) {
    const v = byScope[key];
    if (!v || !v.pointers) continue;
    console.log(`| ${label[key]} | ${v.injectRounds} | ${v.pointers} | ${v.used} | ${pct(v.used, v.pointers)} |`);
  }
}

console.log('\n## 位置级：窗口该多宽的直接依据');
console.log('| 位置 | 注入次数 | 打开次数 | 打开率 |');
console.log('| --- | --- | --- | --- |');
for (const row of summary.positions) {
  console.log(`| 第 ${row.position} 条 | ${row.injected} | ${row.opened} | ${pct(row.opened, row.injected)} |`);
}

console.log('\n## 预算：窗口调宽了，字跟上了吗');
console.log('| 指标 | 值 |');
console.log('| --- | --- |');
console.log(`| 每轮注入条数 | 最少 ${summary.perRound.min} · 中位 ${summary.perRound.median} · p90 ${summary.perRound.p90} · 最多 ${summary.perRound.max}${summary.perRound.windowLimit ? `（上限 ${summary.perRound.windowLimit}）` : ''} |`);
if (summary.perRound.windowLimit) {
  console.log(`| 顶到上限的轮数 | ${summary.perRound.fullRounds}/${summary.injectRounds} |`);
}
console.log(`| 被缩成裸文件名 | ${summary.collapsed} 条（${summary.collapsedRounds} 轮） |`);
console.log(`| 因预算整条没列出 | ${summary.dropped} 条（${summary.droppedRounds} 轮） |`);
console.log(`| 打开得多快（距注入） | 中位 ${summary.openLag.median ? `${(summary.openLag.median / 1000).toFixed(1)} 秒` : '—'} · p90 ${summary.openLag.p90 ? `${(summary.openLag.p90 / 1000).toFixed(1)} 秒` : '—'} |`);

console.log('\n## 为什么会没注入（设计性的安静 vs 真漏）');
console.log('| 原因 | 轮数 | 是哪一类 |');
console.log('| --- | --- | --- |');
const reasonRows = [];
for (const [code, n] of Object.entries(summary.skipReasons ?? {})) reasonRows.push([code, n, '跳过']);
for (const [code, n] of Object.entries(summary.emptyReasons ?? {})) reasonRows.push([code, n, '空手']);
reasonRows.sort((a, b) => b[1] - a[1]);
if (!reasonRows.length) console.log('| （还没有带原因的记录） | 0 | — |');
for (const [code, n, kind] of reasonRows) {
  console.log(`| ${reasonLabel(code)} | ${n} | ${kind} |`);
}
console.log(`\n注入分：中位 ${summary.scoreStats.median} · p10 ${summary.scoreStats.p10} · p90 ${summary.scoreStats.p90}`
  + `（第 1 条与最后一条的落差中位 ${summary.scoreStats.spreadMedian}）—— minScore 就照这排数字定`);

console.log('\n## 把 minScore 抬高会付出什么');
const curve = summary.scoreCurve;
if (!curve.n) {
  console.log(`还没有可用的（分, 是否被打开）配对 —— ${curve.legacy} 轮日志没有 scores 字段（0.13.3 之前的写法），`
    + `${curve.unaligned} 轮分数与文件名对不上号。`);
} else {
  console.log('| 门槛 | 留下注入 | 砍掉 | 砍掉比例 | 其中被打开过的 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const point of curve.points) {
    console.log(`| ≥ ${point.minScore} | ${point.injected} | ${point.cut} | ${(point.cutRate * 100).toFixed(1)}% | ${point.lost} |`);
  }
  console.log(`\n（配对 ${curve.n} 条指针 / ${curve.rounds} 轮；进不了曲线的：${curve.legacy} 轮老日志、${curve.unaligned} 轮对不上号）`);
}
console.log(`- ${scoreCurveVerdict(curve)}`);

console.log('\n## 判据');
console.log(`- ${usageVerdict(summary)}`);
console.log(`- ${budgetVerdict(summary)}`);
console.log(`- ${reasonVerdict(summary)}`);

if (summary.neverOpened.length) {
  console.log('\n## 从没被打开过的注入（按注入次数排）');
  console.log('| 笔记 | 注入 | 最近一次注入 |');
  console.log('| --- | --- | --- |');
  for (const note of summary.neverOpened) {
    console.log(`| ${note.id} | ${note.injected} | ${stamp(note.lastAt)} |`);
  }
  console.log('\n（它们可能是「看一眼文件名就够了」的指针——若长期只有注入、没有打开，');
  console.log('  要么描述的钩子不够吸引人，要么它们本来就是背景信息，不该占窗口。）');
}
