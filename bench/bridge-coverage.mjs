#!/usr/bin/env node
/**
 * 同义表 / aliases 的**覆盖率尺子**。
 *
 * 为什么需要它：`SYNONYMS` 有 177 个键、500 多个值，全是手写的「中文口语 → 本库实际用词」。
 * 这张表最安静的失效方式不是报错，而是**写了等于没写** —— 值里的词项在语料里根本不存在时，
 * 它一分都不加、也不降级、也不报警。探针里那句「死桥自检」只能数出这个总数，回答不了：
 *
 *   1. 死的是哪些、为什么死（拼错？改名？还是根本没写进库）？
 *   2. 库里还有多少「有辨识度的锚点词」根本没有桥接着（口语问它时没有路）？
 *   3. 这张表在卷子上被走过几步？哪些键从来没人走（= 猜测）？
 *   4. 每个键单独值多少分（拔掉它，只有用到它的查询会掉多少）？
 *
 * 三张卷子一起用，各量各的：
 *   · **真库**（`~/memory/engramory`）：死值、覆盖、孤儿笔记 —— 这张表就是为它写的；
 *   · **探针的 32 条真实口语 query**（口径 22 + 桥 10 + 别名 5，`scripts/probe-queries.mjs`）：
 *     「这个键在真人怎么问的时候真的被走到过吗」；
 *   · **合成语料 704 条**：逐键消融的样本量来源（真库的 32 条太粗，只够当交叉验证）。
 *
 * 用法：
 *   node bench/bridge-coverage.mjs                 # 真库 + 合成语料的覆盖/使用面
 *   node bench/bridge-coverage.mjs --store <path>
 *   node bench/bridge-coverage.mjs --ablate        # 逐键消融（慢一点，但这是「值多少分」那半）
 *   node bench/bridge-coverage.mjs --json          # 另存 bench/.bridge-coverage.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNONYMS, buildIndex, matchedSynonymKeys, search, tokenize } from '../bm25.js';
import { corpusFingerprint, readDocs } from '../store.js';
import { ALIAS_PAIRS, BRIDGE_PAIRS, PAIRS } from '../scripts/probe-queries.mjs';
import { buildCorpus } from './corpus.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const storePath = opt('--store', `${process.env.HOME}/memory/engramory`);
const wantJson = args.includes('--json');
const wantAblate = args.includes('--ablate');
const SHOW = Number(opt('--show', 12));
const HERE = dirname(fileURLToPath(import.meta.url));

/** 词项是否「像个词」：纯 16 进制色号、纯数字、单字母都不算。 */
const wordLike = (t) => /^[a-z][a-z0-9_-]{2,}$/i.test(t) && !/^[0-9a-f]{6}$/i.test(t) && /[a-z]{3,}/i.test(t);

// ── 真库：规模、死值、覆盖 ────────────────────────────────────────────
const docs = readDocs(storePath);
const index = buildIndex(docs);
const fingerprint = corpusFingerprint(docs);
const df = new Map();
for (const d of index.docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

const rows = [];
for (const [key, values] of SYNONYMS) {
  for (const value of values) {
    const terms = tokenize(value);
    const alive = terms.filter((t) => df.has(t));
    rows.push({ key, value, terms, alive, deadTerms: terms.length - alive.length });
  }
}
const deadAll = rows.filter((r) => r.alive.length === 0);
const partial = rows.filter((r) => r.alive.length > 0 && r.deadTerms > 0);
const full = rows.filter((r) => r.deadTerms === 0);

const byKey = new Map();
for (const r of rows) {
  const s = byKey.get(r.key) ?? { values: 0, deadAll: 0, partial: 0 };
  s.values += 1;
  if (r.alive.length === 0) s.deadAll += 1;
  else if (r.deadTerms > 0) s.partial += 1;
  byKey.set(r.key, s);
}
const keysAllDead = [...byKey.entries()].filter(([, s]) => s.deadAll === s.values).map(([k]) => k);
const keysPartial = [...byKey.entries()].filter(([, s]) => s.deadAll > 0 && s.deadAll < s.values).map(([k]) => k);

// 近似候选：死词项在库里有没有「长得像」的活词项（很可能是单复数/改名，不是没写）
const editDistance = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};
const buckets = new Map();
for (const t of df.keys()) {
  if (!wordLike(t)) continue;
  const k = t.slice(0, 3);
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(t);
}
const nearMiss = [];
const seenDead = new Set();
for (const r of deadAll) {
  for (const term of r.terms) {
    if (seenDead.has(term) || !wordLike(term) || term.length < 3) continue;
    const cands = (buckets.get(term.slice(0, 3)) ?? []).filter((t) => {
      const d = editDistance(term, t);
      return d <= 2 && d / Math.max(term.length, t.length) <= 0.34;
    });
    if (cands.length) { nearMiss.push({ 键: r.key, 值: r.value, 死词项: term, 库里近似: cands.slice(0, 3) }); seenDead.add(term); }
  }
}

// 覆盖方向：低 df 锚点词（有辨识度）被桥值接住了多少
const anchors = [...df.entries()]
  .filter(([t, n]) => n <= 5 && t.length >= 4 && wordLike(t))
  .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
const bridgeTerms = new Set(rows.flatMap((r) => r.terms));
const coveredAnchors = anchors.filter(([t]) => bridgeTerms.has(t));
const uncoveredAnchors = anchors.filter(([t]) => !bridgeTerms.has(t));
const coveredSet = new Set(coveredAnchors.map(([t]) => t));
const orphanNotes = index.docs.filter((d) => ![...d.tf.keys()].some((t) => coveredSet.has(t)));

// ── 三张卷子：谁被走到过 ──────────────────────────────────────────────
const corpus = buildCorpus();
const indexSynthetic = buildIndex(corpus.docs);
const dfSynthetic = new Map();
for (const d of indexSynthetic.docs) for (const t of d.tf.keys()) dfSynthetic.set(t, (dfSynthetic.get(t) ?? 0) + 1);

/**
 * 死值分四类 —— 关键在于**两张卷子对一遍**：
 *   两边都活   · 真库活/合成死（这就是这张表的本来用途：为真库写的）
 *   真库死/合成活（**只对基准有用**，要么是巧合，要么是照着基准补的 —— 要看清）
 *   两边都死（**双向白写**：删掉它，两张卷子的分数都应该一个点都不动）
 */
for (const r of rows) {
  r.aliveS = r.terms.filter((t) => dfSynthetic.has(t));
  r.真库 = r.alive.length > 0;
  r.合成 = r.aliveS.length > 0;
}
const bothDead = rows.filter((r) => !r.真库 && !r.合成);
const benchOnly = rows.filter((r) => !r.真库 && r.合成);
const storeOnly = rows.filter((r) => r.真库 && !r.合成);
const bothAlive = rows.filter((r) => r.真库 && r.合成);

const probe = [
  { group: '口径', queries: PAIRS.map(([q, gold]) => ({ q, gold: `${gold}.md`, style: '口径' })) },
  { group: '桥', queries: BRIDGE_PAIRS.map(([q, gold]) => ({ q, gold: `${gold}.md`, style: '桥' })) },
  { group: '别名', queries: ALIAS_PAIRS.map(([q, gold]) => ({ q, gold: `${gold}.md`, style: '别名' })) },
];
const probeQueries = probe.flatMap((g) => g.queries);

const usage = new Map();      // key → { 合成, 探针, 查询 }
const bump = (key, field) => {
  const u = usage.get(key) ?? { 合成: 0, 探针: 0 };
  u[field] += 1;
  usage.set(key, u);
};
for (const q of corpus.queries) for (const key of matchedSynonymKeys(q.q)) bump(key, '合成');
for (const q of probeQueries) for (const key of matchedSynonymKeys(q.q)) bump(key, '探针');
const usedKeys = [...usage.keys()];
const unusedKeys = [...SYNONYMS.keys()].filter((k) => !usage.has(k));

const scoreWith = (index, queries, limit) => {
  let hit1 = 0; let hitK = 0;
  for (const q of queries) {
    const hits = search(index, q.q, limit).map((h) => h.id);
    const rank = hits.indexOf(q.gold);
    if (rank === 0) hit1 += 1;
    if (rank >= 0) hitK += 1;
  }
  return { n: queries.length, hit1, hitK };
};

let ablation = null;
let wholeTable = null;
if (wantAblate) {
  const baseSyn = scoreWith(indexSynthetic, corpus.queries, 4);
  const baseProbe = scoreWith(index, probeQueries, 4);
  const saved = new Map(SYNONYMS);
  SYNONYMS.clear();
  wholeTable = {
    合成: { on: baseSyn, off: scoreWith(indexSynthetic, corpus.queries, 4) },
    探针: { on: baseProbe, off: scoreWith(index, probeQueries, 4) },
  };
  for (const [k, v] of saved) SYNONYMS.set(k, v);

  ablation = [];
  for (const key of usedKeys) {
    const firingSyn = corpus.queries.filter((q) => matchedSynonymKeys(q.q).includes(key));
    const firingProbe = probeQueries.filter((q) => matchedSynonymKeys(q.q).includes(key));
    const beforeSyn = scoreWith(indexSynthetic, firingSyn, 4);
    const beforeProbe = firingProbe.length ? scoreWith(index, firingProbe, 4) : null;
    const values = SYNONYMS.get(key);
    SYNONYMS.delete(key);
    const afterSyn = scoreWith(indexSynthetic, firingSyn, 4);
    const afterProbe = firingProbe.length ? scoreWith(index, firingProbe, 4) : null;
    SYNONYMS.set(key, values);
    ablation.push({
      key,
      合成条数: firingSyn.length, 探针条数: firingProbe.length,
      合成Δ1: beforeSyn.hit1 - afterSyn.hit1, 合成Δ4: beforeSyn.hitK - afterSyn.hitK,
      探针Δ1: beforeProbe ? beforeProbe.hit1 - afterProbe.hit1 : null,
      探针Δ4: beforeProbe ? beforeProbe.hitK - afterProbe.hitK : null,
    });
  }
  ablation.sort((a, b) => (b.合成Δ1 + b.合成Δ4 / 10) - (a.合成Δ1 + a.合成Δ4 / 10));
}

// ── 报告 ──────────────────────────────────────────────────────────────
const pct = (x, n) => `${((x / (n || 1)) * 100).toFixed(1)}%`;
console.log(`同义表覆盖率尺子 · 库：${storePath}（${docs.length} 篇 / ${index.docs.length} 个 chunk · 指纹 ${fingerprint}）`);
const emptyKeys = [...SYNONYMS].filter(([, v]) => !v.length).map(([k]) => k);
console.log(`\n## 1. 表规模\n${SYNONYMS.size} 个键 / ${rows.length} 个值 · 平均每键 ${(rows.length / SYNONYMS.size).toFixed(2)} 个值 · 空值键 ${emptyKeys.length}${emptyKeys.length ? `（${emptyKeys.join('、')}）` : ''}`);
console.log(`  全活 ${full.length} · 半死（部分词项不存在）${partial.length} · 全死 ${deadAll.length}（${pct(deadAll.length, rows.length)}）`);
console.log(`  整键全死 ${keysAllDead.length} 个键 · 半死 ${keysPartial.length} 个键`);
console.log(`\n## 2. 死值解剖`);
console.log(`  近似候选（库里存在只差一点、≥66% 相似）：${nearMiss.length} 个`);
for (const m of nearMiss.slice(0, SHOW)) console.log(`    · ${m.键} → ${m.值}（死：${m.死词项}；库里近似：${m.库里近似.join(', ')}）`);
console.log(`  整键全死（写了等于没写）：${keysAllDead.length ? keysAllDead.join('、') : '无'}`);
console.log(`\n## 2b. 两张卷子对一遍（真库 vs 合成语料）`);
console.log(`  两边都活 ${bothAlive.length} · 只对真库有用 ${storeOnly.length} · **只对基准有用 ${benchOnly.length}** · 两边都死 ${bothDead.length}`);
console.log(`  只对基准有用的值（真库里没有落点，合成语料里才有）：${benchOnly.length ? benchOnly.slice(0, SHOW).map((r) => `${r.key}→${r.value}`).join('、') : '无'}`);
console.log(`  两边都死（双向白写，删除候选）：${bothDead.length} 个值 / ${new Set(bothDead.map((r) => r.key)).size} 个键`);
console.log(`    ${[...new Set(bothDead.map((r) => r.key))].slice(0, 20).join('、')}${new Set(bothDead.map((r) => r.key)).size > 20 ? ' …' : ''}`);
console.log(`\n## 3. 覆盖方向`);
console.log(`  低 df 锚点词 ${anchors.length} 个，被桥值接住的 ${coveredAnchors.length}（${pct(coveredAnchors.length, anchors.length)}）`);
console.log(`  一个桥都没接住的 chunk：${orphanNotes.length} / ${index.docs.length}（${pct(orphanNotes.length, index.docs.length)}）`);
console.log(`  没被任何桥指过的锚点（口语问它时没有路），前 ${SHOW} 个：`);
for (const [t, n] of uncoveredAnchors.slice(0, SHOW)) console.log(`    · ${t}（df ${n}）`);
console.log(`\n## 4. 使用面`);
console.log(`  合成语料 ${corpus.queries.length} 条 → 走到 ${[...usage.values()].filter((u) => u.合成).length} 个键`);
console.log(`  探针 ${probeQueries.length} 条 → 走到 ${[...usage.values()].filter((u) => u.探针).length} 个键`);
console.log(`  两张卷子都没走到的键 ${unusedKeys.length}（= 猜测；列前 ${SHOW}）：${unusedKeys.slice(0, SHOW).join('、')}${unusedKeys.length > SHOW ? ' …' : ''}`);
for (const g of probe) {
  const walked = new Set();
  for (const q of g.queries) for (const k of matchedSynonymKeys(q.q)) walked.add(k);
  console.log(`    探针·${g.group} 用到 ${walked.size} 个键`);
}
if (ablation) {
  console.log(`\n## 5. 逐键消融（拔掉单个键，只看用到它的查询）`);
  console.log(`  整表拔掉 · 合成：hit@1 ${wholeTable.合成.on.hit1} → ${wholeTable.合成.off.hit1} · hit@4 ${wholeTable.合成.on.hitK} → ${wholeTable.合成.off.hitK}`);
  console.log(`  整表拔掉 · 探针：hit@1 ${wholeTable.探针.on.hit1} → ${wholeTable.探针.off.hit1} · hit@4 ${wholeTable.探针.on.hitK} → ${wholeTable.探针.off.hitK}`);
  const zero = ablation.filter((a) => a.合成Δ1 === 0 && a.合成Δ4 === 0 && (a.探针Δ1 ?? 0) === 0 && (a.探针Δ4 ?? 0) === 0);
  console.log(`  有贡献的键 ${usedKeys.length - zero.length} · 零贡献的键 ${zero.length}（拔掉不影响任何名次）`);
  console.log(`  键名        合成条数  合成Δ1  合成Δ4   探针条数  探针Δ1  探针Δ4`);
  for (const a of ablation.slice(0, SHOW)) {
    console.log(`  ${a.key.padEnd(12)}${String(a.合成条数).padStart(6)}${String(a.合成Δ1).padStart(8)}${String(a.合成Δ4).padStart(8)}${String(a.探针条数).padStart(10)}${String(a.探针Δ1 ?? '-').padStart(8)}${String(a.探针Δ4 ?? '-').padStart(8)}`);
  }
  console.log(`  零贡献（候选删除，前 20）：${zero.map((a) => a.key).slice(0, 20).join('、')}${zero.length > 20 ? ' …' : ''}`);
}
console.log(`\n（口径：死值/覆盖看真库；使用面看探针 32 条真实 query + 合成 704 条；消融看两者。）`);

if (wantJson) {
  const out = {
    生成命令: 'node bench/bridge-coverage.mjs --ablate --json',
    库: storePath, 指纹: fingerprint, 篇数: docs.length, chunk数: index.docs.length,
    表: { 键数: SYNONYMS.size, 空值键: emptyKeys, 值数: rows.length, 全活: full.length, 半死: partial.length, 全死: deadAll.length },
    整键全死: keysAllDead, 近似候选: nearMiss,
    两卷对照: { 两边都活: bothAlive.length, 只对真库有用: storeOnly.length, 只对基准有用: benchOnly.length, 两边都死: bothDead.length,
      只对基准有用的值: benchOnly.map((r) => `${r.key}→${r.value}`), 两边都死的值: bothDead.map((r) => `${r.key}→${r.value}`) },
    覆盖: { 锚点数: anchors.length, 被接住: coveredAnchors.length, 孤儿chunk: orphanNotes.length,
      未被接住的锚点: uncoveredAnchors.slice(0, 200) },
    使用面: { 合成走到: [...usage.values()].filter((u) => u.合成).length, 探针走到: [...usage.values()].filter((u) => u.探针).length, 都没走到: unusedKeys },
    消融: ablation ? { 整表: wholeTable, 逐键: ablation } : null,
  };
  const file = join(HERE, '.bridge-coverage.json');
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`JSON 已写 ${file}`);
}
