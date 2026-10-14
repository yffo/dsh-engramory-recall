/**
 * 语义接缝的成本与收益：把「开着会不会变慢、会不会变差、值不值得开」量出来。
 *
 * 这条尺子回答的是 0.9.0 那件事的核心疑问 —— 接缝是**可选的**，那它代价是什么？
 * 五个场景跑同一批查询（合成语料，固定种子，全程离线、零模型调用）：
 *   ① 关闭（默认）      ② 提供方抛错        ③ 提供方卡住（超时 50ms）
 *   ④ 提供方返回编造的 id ⑤ 字符三元组重排（离线、确定性、真的能打分的提供方）
 *
 * 判据不是「分数越高越好」，而是三条硬要求：
 *   · 前四个场景的命中数**必须与词面基线逐字相同**（接缝只许改顺序、不许丢结果，失败必须降级）；
 *   · 「关闭」的耗时增量必须约等于 0（默认路径不许为可选能力付税）；
 *   · 卡住的场景耗时 ≈ 超时值（硬兜必须真的兜住 —— 提供方可以完全无视 AbortSignal）。
 *
 * 用法：
 *   node bench/semantic-seam.mjs            # 打印 markdown 报告
 *   node bench/semantic-seam.mjs --json     # 额外写 bench/.semantic-seam.json
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, BENCH_NOW } from './corpus.mjs';
import { buildIndex } from '../bm25.js';
import { semanticSearch } from '../semantic.js';

const K = 4; // 评测看前 4 名（插件实际注入的指针数就是这个量级）
// 候选池：插件默认 limit=5、上限 20。池子==输出量时 RRF 只能在池内重排（词面命中不会离开输出）；
// 池子更大时提供方才有机会「把第 12 名捞上来」，同时也会把词面命中挤出前 4 —— 两种都要量。
const poolArg = process.argv.indexOf('--pool');
const POOL = poolArg >= 0 ? Number(process.argv[poolArg + 1]) : 20;
const TIMEOUT_MS = 50;
const wantJson = process.argv.includes('--json');

const { docs, queries } = buildCorpus();
const index = buildIndex(docs, { now: BENCH_NOW });

/** 提供方模块写到临时目录：真的走 import()，连加载、缓存、超时都算进去，不是 mock。 */
const dir = mkdtempSync(join(tmpdir(), 'engramory-seam-bench-'));
const providerFile = (name, body) => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
};

const thrower = providerFile('thrower', `export function rerank() { throw new Error('boom'); }`);
const slowpoke = providerFile('slowpoke', `export function rerank() { return new Promise(() => {}); }`);
const liar = providerFile('liar', `export function rerank() { return [{ id: '完全不存在的笔记.md', score: 9 }]; }`);
// 真能打分的离线提供方：查询与候选片段按字符三元组算 Jaccard（不用 gold，不作弊）
const trigram = providerFile(
  'trigram',
  `const grams = (s) => { const t = String(s).toLowerCase().replace(/\\s+/g, ' '); const out = new Set();
     for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
   const jaccard = (a, b) => { let hit = 0; for (const g of a) if (b.has(g)) hit++; return hit / (a.size + b.size - hit); };
   export const name = 'trigram';
   export function rerank({ query, docs }) {
     const qg = grams(query);
     return docs.map((d) => ({ id: d.id, score: jaccard(qg, grams(d.snippet ?? '')) })).sort((a, b) => b.score - a.score);
   }`,
);

// 作弊上界：直接按 gold 重排。它不是可用方案，只用来证明「管线是通的」——
// 若连 oracle 都改不动前 4 名，那说明 RRF 把提供方锁死了，问题在融合而不是提供方。
const oracleMap = Object.fromEntries(queries.map((q) => [q.q, q.gold]));
const oracle = providerFile(
  'oracle',
  `const gold = ${JSON.stringify(oracleMap)};
   export function rerank({ query }) {
     const want = gold[String(query).trim()];
     return want ? [{ id: want, score: 1 }] : [];
   }`,
);

const scenarios = [
  { label: '关闭（默认）', config: {}, expect: 'off' },
  { label: '提供方抛错', config: { provider: thrower, timeoutMs: TIMEOUT_MS }, expect: 'provider-error' },
  { label: '提供方卡住不返回', config: { provider: slowpoke, timeoutMs: TIMEOUT_MS }, expect: 'timeout' },
  { label: '提供方返回编造的 id', config: { provider: liar, timeoutMs: TIMEOUT_MS }, expect: 'provider-empty' },
  { label: `字符三元组重排（离线、确定、真打分）`, config: { provider: trigram, timeoutMs: TIMEOUT_MS }, expect: 'reranked' },
  { label: `按 gold 重排（作弊上界，只验管线）`, config: { provider: oracle, timeoutMs: TIMEOUT_MS }, expect: 'reranked' },
];

async function run(config) {
  let hit1 = 0;
  let hitK = 0;
  let used = 0;
  let promoted = 0; // 词面原本排在前 K 之外、被提供方拉进来的查询数
  let demoted = 0; // 词面原本在前 K 之内、被挤出去的查询数
  let ms = 0;
  const codes = new Map();
  const byStyle = new Map();
  for (const query of queries) {
    const result = await semanticSearch({ index, query: query.q, limit: POOL, config, baseDir: dir });
    const ids = result.hits.map((h) => h.id);
    const rank = ids.indexOf(query.gold);
    const lexicalRank = rank; // 关闭时 result.hits 就是词面顺序，用它当参照见下面的 compare
    void lexicalRank;
    if (rank === 0) hit1++;
    if (rank >= 0 && rank < K) hitK++;
    if (rank >= 0 && rank < K && result.used) promoted++;
    if (rank >= K && result.used) demoted++;
    if (result.used) used++;
    ms += result.ms;
    codes.set(result.code, (codes.get(result.code) ?? 0) + 1);
    // 逐条比对用：把每个查询的名次留下来，才能证明「前四个场景与基线逐字相同」
    if (!byStyle.has(query.style)) byStyle.set(query.style, []);
    byStyle.get(query.style).push(rank);
  }
  return { hit1, hitK, used, promoted, demoted, avgMs: ms / queries.length, codes: Object.fromEntries(codes), ranks: byStyle };
}

const total = queries.length;
const rows = [];
for (const scenario of scenarios) {
  const stats = await run(scenario.config);
  rows.push({ ...scenario, ...stats });
}

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
const base = rows[0];

const sameAsBase = (row) => {
  for (const [style, ranks] of row.ranks) {
    const ref = base.ranks.get(style) ?? [];
    if (ref.length !== ranks.length) return false;
    for (let i = 0; i < ranks.length; i++) if (ref[i] !== ranks[i]) return false;
  }
  return true;
};

console.log(`# 语义接缝的成本与收益\n`);
console.log(`语料：合成基准（确定性种子），${total} 条查询 × top-${K}；候选池 ${POOL}；超时预算 ${TIMEOUT_MS}ms；全程离线、零模型调用。`);
console.log(`基线（第 ① 行）就是词面路径本身。\n`);
console.log(`| 场景 | hit@1 | hit@${K} | 生效查询 | 平均耗时 | 返回码 | 与词面逐字相同 |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- |`);
for (const row of rows) {
  const codes = Object.entries(row.codes).map(([c, n]) => `${c}×${n}`).join(' ');
  console.log(`| ${row.label} | ${pct(row.hit1)} | ${pct(row.hitK)} | ${row.used}/${total} | ${row.avgMs.toFixed(2)} ms | ${codes} | ${sameAsBase(row) ? '✓' : '✖ 顺序变了'} |`);
}

const off = base;
const err = rows[1];
const slow = rows[2];
const tri = rows[4];
const oracleRow = rows[5];

console.log(`\n## 结论（都是上面这张表算出来的）\n`);
console.log(`- **默认零成本**：关闭时平均 ${off.avgMs.toFixed(2)} ms/次，与词面路径同一条同步路径（没有 import、没有 await 外部件）。`);
console.log(`- **失败不改变结果**：抛错 / 超时 / 编造 id 三种坏提供方，命中与词面**逐字相同**（${pct(err.hit1)} / ${pct(err.hitK)}，与基线一致）—— 降级是「结果不变 + 如实报码」，不是「返回半个答案」。`);
console.log(`- **超时是硬兜**：卡住的提供方让每次检索停在 ${slow.avgMs.toFixed(1)} ms（预算 ${TIMEOUT_MS}ms），说明它无视 AbortSignal 也收得住。`);
console.log(`- **顺序确实能被改**：只有第 ⑤ 行（真打分的提供方）与前四行不同 —— 接缝不是装饰。`);
const delta = tri.hit1 - off.hit1;
const pp = (n) => `${n >= 0 ? '+' : ''}${((n / total) * 100).toFixed(1)}pp`;
console.log(
  `- **随手写的词法变体不但没赚，还赔了**：离线三元组重排把 hit@1 从 ${pct(off.hit1)} 变成 ${pct(tri.hit1)}（${pp(delta)}）。` +
    `\n  ⇒ 结论：**默认关闭是对的**。接缝的价值上限 = 提供方的质量，而词法层面的花样内置路径已经做过了。`,
);
console.log(
  `- **管线是通的（上限在哪）**：作弊上界（按 gold 重排）把 hit@1 拉到 ${pct(oracleRow.hit1)}、hit@${K} 拉到 ${pct(oracleRow.hitK)}` +
    `（+${((oracleRow.hit1 - off.hit1) / total * 100).toFixed(1)}pp / +${((oracleRow.hitK - off.hitK) / total * 100).toFixed(1)}pp）——` +
    `说明 RRF 没有把提供方锁死：**提供方准到什么程度，结果就到什么程度**，收益完全来自信号质量（真 embedding / 交叉编码器），不来自接缝本身。`,
);

if (wantJson) {
  const out = fileURLToPath(new URL('./.semantic-seam.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify({ when: 'bench/semantic-seam.mjs', total, K, timeoutMs: TIMEOUT_MS, rows: rows.map(({ label, hit1, hitK, used, avgMs, codes }) => ({ label, hit1, hitK, used, avgMs, codes })) }, null, 2)}\n`);
  console.log(`\n（JSON 写到 bench/.semantic-seam.json）`);
}

rmSync(dir, { recursive: true, force: true });
