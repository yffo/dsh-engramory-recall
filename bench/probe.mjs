#!/usr/bin/env node
/**
 * 探针卷的**名次分布**尺子（离线，不联网、不需要端点）。
 *
 * 它回答一个问题：每条 query 的正确答案，在纯词面里排第几名？
 *   · 第 1 名   → 「保护集」：重排只能弄坏它，测的是不要退步；
 *   · 第 2~10 名 → 「争夺集」：重排真正能挣分的区间（默认池 10 之内的后半段）；
 *   · 11~50 名  → 「宽池集」：只有把池子放大才够得着；
 *   · 500 名内都找不到 → 「架构外」：池子由词面产生，这类题任何重排都救不了 —— 要改题或改架构。
 *
 * 为什么要有这把尺子：卷子只有 36 条时，1 条 query = 2.8 个点，端点之间的差异全在噪声里。
 * 把噪声压下去的前提是先看清每条题落在哪一档，以及每一档各有多少条。
 *
 * 用法：node bench/probe.mjs [--store ~/memory/engramory] [--json] [--pool 10]
 */
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, search } from '../bm25.js';
import { readDocs } from '../store.js';
import { ALL_PAIRS, ALIAS_PAIRS, BRIDGE_PAIRS, PAIRS, WIDE_PAIRS } from '../scripts/probe-queries.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const STORE = opt('--store', '~/memory/engramory');
const POOL = Math.max(1, Number(opt('--pool', '10')) || 10);
const wantJson = argv.includes('--json');

const storePath = STORE.startsWith('~') ? join(homedir(), STORE.slice(1)) : STORE;
const docs = readDocs(storePath);
if (docs.length === 0) {
  console.error(`✗ ${storePath} 下没读到笔记（空目录？路径写错了？）`);
  process.exit(1);
}
const index = buildIndex(docs);
const noteCount = new Set(docs.map((doc) => doc.id.replace(/\.md$/, ''))).size;

const rankOf = (query, want) => {
  const gold = `${String(want).replace(/\.md$/, '')}.md`;
  const hits = search(index, query, 500);
  const body = hits.findIndex((hit) => hit.id === gold) + 1;   // 1-based
  return { rank: body, gold, near: hits.slice(0, 5).map((h) => h.id.replace(/\.md$/, '')) };
};

const groups = [
  ['原始卷（口语 query）', PAIRS],
  ['桥探针（压同义表）', BRIDGE_PAIRS],
  ['别名探针（压 aliases）', ALIAS_PAIRS],
  ['宽卷（换角度问）', WIDE_PAIRS],
  ['合计', ALL_PAIRS],
];
const bucketOf = (rank) => {
  if (rank === 0) return 'excluded';
  if (rank === 1) return 'protect';
  if (rank <= POOL) return 'contend';
  if (rank <= 50) return 'wide';
  return 'deep';
};
const LABELS = { protect: '第 1 名（保护集）', contend: `第 2~${POOL} 名（争夺集）`, wide: `第 ${POOL + 1}~50 名（宽池集）`, deep: '51~500 名（深池）', excluded: '500 名内找不到（架构外）' };

const rows = [];
console.log(`# 探针名次分布：${storePath} —— ${noteCount} 篇 / ${docs.length} chunk，池宽 ${POOL}\n`);
console.log('| 卷子 | 条数 | ' + ['protect', 'contend', 'wide', 'deep', 'excluded'].map((k) => LABELS[k]).join(' | ') + ' |');
console.log('| --- | --- | ' + Array(5).fill('---').join(' | ') + ' |');
const detail = [];
for (const [label, pairs] of groups) {
  const buckets = { protect: 0, contend: 0, wide: 0, deep: 0, excluded: 0 };
  const seen = new Map();
  for (const [query, want] of pairs) {
    const key = `${query}\u0000${want}`;
    if (seen.has(key)) continue;                 // 同一对在别的卷里出现过：按去重后的条数算
    const { rank, gold, near } = rankOf(query, want);
    seen.set(key, rank);
    buckets[bucketOf(rank)] += 1;
    detail.push({ group: label, query, gold, rank, near });
  }
  const total = seen.size;
  rows.push({ group: label, total, ...buckets });
  console.log(`| ${label} | ${total} | ` + ['protect', 'contend', 'wide', 'deep', 'excluded'].map((k) => `${buckets[k]}（${((buckets[k] / total) * 100).toFixed(0)}%）`).join(' | ') + ' |');
}

const all = rows.at(-1);
// ⚠️ 合计口径必须只取「合计」那一遍的去重结果：各组分开跑时同一对会在两组里各出现一次，
// 拿 detail 直接数会把它们算两遍（第一版就写出过 131% 这种数字）。
const overall = detail.filter((d) => d.group === '合计');
const protect = overall.filter((d) => bucketOf(d.rank) === 'protect');
const contend = overall.filter((d) => bucketOf(d.rank) === 'contend');
console.log(`\n## 这条卷子能测出什么\n`);
console.log(`- 词面 hit@1 的上界 = **${((protect.length / all.total) * 100).toFixed(1)}%**（${protect.length}/${all.total} 已经第 1 名）`);
console.log(`- 头部 4 条里能进 gold 的 = 第 1~4 名合计 = **${(((protect.length + overall.filter((d) => d.rank >= 2 && d.rank <= 4).length) / all.total) * 100).toFixed(1)}%**`);
console.log(`- 重排**能挣分的题** = 争夺集 ${contend.length} 条；放宽池子还能再捞 = 宽池集 ${all.wide} 条；任何重排都救不了 = ${all.excluded} 条`);
console.log(`- 池 ${POOL} 的池内召回上界 = ${(((all.total - all.wide - all.deep - all.excluded) / all.total) * 100).toFixed(1)}%`);
const worst = overall.filter((d) => d.rank === 0 || d.rank > 50).sort((a, b) => b.rank - a.rank || a.rank - b.rank);
if (worst.length) {
  console.log(`\n## 要改的题（第 0 名 = 池子够不着，深池 = 只有大池子能救）\n`);
  console.log('| 名次 | 卷 | query | 期望笔记 | 词面 top-5 实际 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const d of worst.slice(0, 25)) console.log(`| ${d.rank === 0 ? '**0**' : d.rank} | ${d.group.split('（')[0]} | ${d.query} | ${d.gold.replace(/\.md$/, '')} | ${d.near.join(', ') || '—'} |`);
}
const best = overall.filter((d) => d.rank >= 2 && d.rank <= POOL);
if (best.length) {
  console.log(`\n## 争夺集明细（这些题的翻转才说明重排有用）\n`);
  console.log('| 名次 | 卷 | query | 期望笔记 |');
  console.log('| --- | --- | --- | --- |');
  for (const d of best) console.log(`| ${d.rank} | ${d.group.split('（')[0]} | ${d.query} | ${d.gold.replace(/\.md$/, '')} |`);
}

if (wantJson) {
  writeFileSync(new URL('../.probe.json', import.meta.url), `${JSON.stringify({ store: storePath, pool: POOL, notes: noteCount, chunks: docs.length, rows, detail }, null, 2)}\n`);
  console.log(`\n（JSON 写到 bench/.probe.json）`);
}
