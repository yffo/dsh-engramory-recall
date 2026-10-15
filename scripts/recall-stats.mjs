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
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readUsage, summarizeUsage, usageVerdict, USAGE_FILE } from '../usage.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const HOME = homedir();
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(HOME, p.slice(2)) : p);
const STORE = expandHome(opt('--store', '~/memory/engramory'));
const POSITIONS = Math.max(1, Number(opt('--positions', '5')) || 5);
const LIMIT = Math.max(10, Number(opt('--limit', '2000')) || 2000);
const wantJson = argv.includes('--json');

const lines = readUsage(STORE, LIMIT);
const summary = summarizeUsage(lines, { positions: POSITIONS, neverOpenedLimit: 12 });
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
console.log(`| 注入后被打开 | ${summary.used} |`);
console.log(`| **打开率** | **${pct(summary.used, summary.pointers)}** |`);
console.log(`| 没注入也打开（对照） | ${summary.coldOpens} |`);
console.log(`| 被注入过的不同笔记 | ${summary.uniqueNotes} |`);

console.log('\n## 位置级：窗口该多宽的直接依据');
console.log('| 位置 | 注入次数 | 打开次数 | 打开率 |');
console.log('| --- | --- | --- | --- |');
for (const row of summary.positions) {
  console.log(`| 第 ${row.position} 条 | ${row.injected} | ${row.opened} | ${pct(row.opened, row.injected)} |`);
}

console.log('\n## 判据');
console.log(`- ${usageVerdict(summary)}`);

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
