/**
 * 把握度门槛（`semanticFusion: 'guarded'`）的尺子：它到底比 rrf / trust 好在哪、在垃圾提供方上会不会崩。
 *
 *   node bench/guard-sweep.mjs --collect                 # 打真端点，采 174 条 query 的池内原始分
 *   node bench/guard-sweep.mjs                           # 只用已落盘的数据扫规则（离线、零调用）
 *   node bench/guard-sweep.mjs --fake-cos                # 把余弦换成哈希假分数 = 垃圾提供方的最坏情况
 *   ENGRAMORY_EMBED_CONFIG=~/.config/engramory/embed.json.ollama node bench/guard-sweep.mjs --collect --data bench/.tmp/guard-data-ollama.json
 *
 * 采集只做一次（结果落 `bench/.tmp/guard-data*.json`）：规则本身用产品里的 `guardedOrder()` 现算，
 * 所以尺子量的就是产品会做的事，而不是另写一份仿制品。
 *
 * 为什么要拆成「保护集 / 争夺集」：总分是两个方向相抵后的净值 —— 一个升一个降时总分可能不动，
 * 但机制完全不同（`trust` 就是翻盘率最高、同时把已对的题毁掉一半）。
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { buildIndex, search } from '../bm25.js';
import { readDocs } from '../store.js';
import { ALL_PAIRS } from '../scripts/probe-queries.mjs';
import { guardedOrder, mergeRRF, DEFAULT_GUARD } from '../semantic.js';
import { rerank, readConfig } from '../providers/openai-embeddings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const POOL = Number(opt('--pool', '10'));
const LIMIT = Number(opt('--limit', '4'));
const STORE = opt('--store', '~/memory/engramory').replace(/^~/, homedir());
const DATA = opt('--data', join(here, '.tmp', 'guard-data.json'));

if (argv.includes('--collect')) {
  const cfg = readConfig();
  console.log(`端点：${cfg.model} @ ${cfg.baseUrl}${cfg.local ? '（本机，不需要密钥）' : ''}`);
  const docs = readDocs(STORE);
  const index = buildIndex(docs);
  const seen = new Set();
  const rows = [];
  let n = 0;
  for (const [query, want] of ALL_PAIRS) {
    const gold = `${String(want).replace(/\.md$/, '')}.md`;
    if (seen.has(`${query}\u0000${gold}`)) continue;
    seen.add(`${query}\u0000${gold}`);
    const pool = search(index, query, POOL);
    if (!pool.length) continue;
    const lexRank = search(index, query, 500).findIndex((hit) => hit.id === gold) + 1;
    // 直接问提供方要「带分的排序」——走接缝的话分会被融合逻辑吃掉，尺子需要原始分
    const ranked = await rerank({
      query,
      docs: pool.map((hit, i) => ({ id: hit.id, snippet: hit.snippet, matched: hit.matched, lexicalRank: i + 1, lexicalScore: hit.score })),
      limit: LIMIT,
    });
    rows.push({
      q: query,
      gold,
      lexRank,
      pool: pool.map((hit, i) => ({ id: hit.id, lexRank: i + 1, lexScore: hit.score })),
      cos: Object.fromEntries(ranked.map((r) => [r.id, r.score])),
    });
    n += 1;
    if (n % 25 === 0) console.log(`  ${n}/${ALL_PAIRS.length} …`);
  }
  writeFileSync(DATA, JSON.stringify({ pool: POOL, limit: LIMIT, model: cfg.model, rows }, null, 1));
  console.log(`采完 ${rows.length} 条 → ${DATA}`);
}

if (!existsSync(DATA)) {
  console.error(`没有数据：先跑 node bench/guard-sweep.mjs --collect`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const rows = data.rows;

// 垃圾提供方：把分数换成「与相关性无关的确定性哈希分」——`guarded` 在这种端点必须退回词面，不能崩。
if (argv.includes('--fake-cos')) {
  for (const row of rows) {
    const next = {};
    for (const id of Object.keys(row.cos)) {
      const hex = createHash('sha1').update(`${row.q}\u0000${id}`).digest('hex').slice(0, 8);
      // 整数除法，别写 `Number('0.' + hex)`：十六进制里出现 `1e5` 会被当科学计数法 → NaN，整轮假分数全废。
      next[id] = Number.parseInt(hex, 16) / 0x1_0000_0000;
    }
    row.cos = next;
  }
}

const cosOf = (row, id) => row.cos[id] ?? -Infinity;
const byCos = (row) => [...row.pool].map((d) => d.id).sort((a, b) => cosOf(row, b) - cosOf(row, a) || a.localeCompare(b));
const lexOrder = (row) => row.pool.map((d) => d.id);
const rank1 = (row) => row.pool[0]?.id;
const ranking = (row) => ({ ids: byCos(row), scores: byCos(row).map((id) => cosOf(row, id)) });

/** 对照规则（产品里没有的写法，只用来量「换成别的融合会怎样」）。 */
const rules = {
  lexical: (row) => lexOrder(row).slice(0, LIMIT),
  rrf: (row) => mergeRRF([lexOrder(row), byCos(row)], LIMIT),
  trust: (row) => [...byCos(row), ...lexOrder(row).filter((id) => !byCos(row).includes(id))].slice(0, LIMIT),
  weighted: (row, w = 0.5) => {
    const lex = row.pool.map((d) => d.lexScore);
    const cos = row.pool.map((d) => cosOf(row, d.id));
    const flat = (arr) => !(Math.max(...arr) - Math.min(...arr) > 1e-12);
    // 两边任意一边打平（提供方没给分 / 词面自己全同分）就退回词面：
    // 否则归一化会把平的那一边的分差放大成 0~1 的假差异，等于让另一边独裁。
    if (flat(lex) || flat(cos)) return lexOrder(row).slice(0, LIMIT);
    const norm = (arr) => {
      const lo = Math.min(...arr); const hi = Math.max(...arr);
      return arr.map((v) => (v - lo) / (hi - lo));
    };
    const nl = norm(lex);
    const nc = norm(cos);
    return row.pool
      .map((d, i) => ({ id: d.id, s: w * nl[i] + (1 - w) * nc[i], r: d.lexRank }))
      .sort((a, b) => b.s - a.s || a.r - b.r || a.id.localeCompare(b.id))
      .slice(0, LIMIT)
      .map((x) => x.id);
  },
  /** 产品里的那一个：`guardedOrder()` 现算（单一真源，尺子不另写一份）。 */
  guarded: (row, t = DEFAULT_GUARD) => guardedOrder(row.pool, ranking(row), t, LIMIT).ids,
  /** 它到底插没插队 —— 光看顺序看不出来（插的正好是第 1 名时顺序不变）。 */
  'guarded+': (row, t = DEFAULT_GUARD) => guardedOrder(row.pool, ranking(row), t, LIMIT).promoted,
  /**
   * 进取档（**没进产品**，留在这里当对照）：同样的把握度门槛，但允许从池子里换人 ——
   * 智谱上能多赚 1.8 个 hit@1 / 2.9 个 hit@4（因为能把词面第 5~10 名的 gold 捞进窗口），
   * 代价是假分数（垃圾提供方）下 hit@1 从 54.6% 塌到 34.5%，而 `guarded` 的 hit@4 一格不掉。
   */
  'guarded-pool': (row, t = DEFAULT_GUARD) => {
    const base = lexOrder(row).slice(0, LIMIT);
    const ids = byCos(row);
    const top = ids[0];
    if (!top || top === base[0]) return base;
    const score = (id) => cosOf(row, id);
    const values = ids.map(score).filter(Number.isFinite);
    const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
    if (!(spread > 0)) return base;
    if (score(top) - score(base[0]) <= t * spread) return base;
    return [top, ...base.filter((id) => id !== top)];
  },
};

function score(name, fn) {
  let hit1 = 0; let hit4 = 0; let cWin = 0; let cTot = 0; let pKeep = 0; let pLost = 0;
  for (const row of rows) {
    const out = fn(row);
    const at = out.indexOf(row.gold);
    if (at === 0) hit1 += 1;
    if (at >= 0 && at < 4) hit4 += 1;
    if (row.lexRank >= 2 && row.lexRank <= POOL) { cTot += 1; if (at === 0) cWin += 1; }
    if (row.lexRank === 1) { (at === 0 ? (pKeep += 1) : (pLost += 1)); }
  }
  const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
  return {
    name,
    hit1: pct(hit1, rows.length),
    hit4: pct(hit4, rows.length),
    cWin: `${pct(cWin, cTot)}（${cWin}/${cTot}）`,
    pKeep: `${pct(pKeep, pKeep + pLost)}（${pKeep}/${pKeep + pLost}）`,
    pLost,
  };
}

const protectTot = rows.filter((r) => r.lexRank === 1).length;
const contendTot = rows.filter((r) => r.lexRank >= 2 && r.lexRank <= POOL).length;
console.log(`\n卷子：${rows.length} 条 · 模型 ${data.model ?? '—'}${argv.includes('--fake-cos') ? '（**分数已被换成假分数**）' : ''}`
  + ` · 池 ${data.pool} · 窗口 ${data.limit} · 保护集 ${protectTot} / 争夺集 ${contendTot}\n`);

const results = [];
for (const name of ['lexical', 'rrf', 'trust']) results.push(score(name, (r) => rules[name](r)));
for (const w of [0.5, 0.4]) results.push(score(`weighted w=${w}`, (r) => rules.weighted(r, w)));
for (const t of [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  results.push(score(`guarded τ=${t}${t === DEFAULT_GUARD ? '（默认）' : ''}`, (r) => rules.guarded(r, t)));
}
results.push(score(`guarded-pool τ=${DEFAULT_GUARD}（进取档，对照）`, (r) => rules['guarded-pool'](r, DEFAULT_GUARD)));
console.log('| 规则 | hit@1 | hit@4 | 争夺集翻盘 | 保护集守住 | 保护集被挤掉 |');
console.log('|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | **${r.hit1}** | ${r.hit4} | ${r.cWin} | ${r.pKeep} | ${r.pLost} |`);

const promoted = rows.filter((r) => rules['guarded+'](r, DEFAULT_GUARD)).length;
console.log(`\n默认门槛下 guarded 真的插队了 ${promoted}/${rows.length} 条（其余原样回词面顺序）。`);

const margins = { win: [], lost: [], keep: [] };
for (const row of rows) {
  const d = cosOf(row, byCos(row)[0]) - cosOf(row, rank1(row));
  // 注意口径：`guardedOrder` 只会把「提供方头名」插到第 1 位，所以 gold 是否还在第 1 位
  // 就等价于「这次插队有没有踩到它」——保护集里 gold 在第 1 = 守住（不是被弄坏）。
  const goldStillFirst = rules.guarded(row, DEFAULT_GUARD).indexOf(row.gold) === 0;
  if (row.lexRank >= 2 && row.lexRank <= POOL) {
    if (goldStillFirst) margins.win.push(d); // 争夺集：gold 被顶上来 = 收益来源
  } else if (row.lexRank === 1) {
    (goldStillFirst ? margins.keep : margins.lost).push(d);
  }
}
const stat = (arr) => {
  const clean = arr.filter(Number.isFinite); // 分数缺失的（提供方没排到那一篇）不算进分布
  if (!clean.length) return 'n=0';
  const s = [...clean].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4);
  return `n=${clean.length} 最小 ${s[0].toFixed(4)} p25 ${q(0.25)} 中位 ${q(0.5)} p75 ${q(0.75)} 最大 ${s[s.length - 1].toFixed(4)}`;
};
console.log('\n分差（提供方头名分 − 词面头名分）：');
console.log(`  争夺集里被插队顶上去的：${stat(margins.win)}`);
console.log(`  保护集里守住没动的：  ${stat(margins.keep)}`);
console.log(`  保护集里被弄坏的：    ${stat(margins.lost)}  ← 这个必须是 0，或接近 0`);
