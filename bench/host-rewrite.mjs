/**
 * 宿主模型改写尺子：**harness 自己**当语义提供方，到底值不值？
 *
 * 起因（2026-10-15）：杨总问「harness 在跑插件的时候本身就能做这件事吧，本机模型服务不现实」。
 * 对 —— `semantic.js` 的 `provider: 'host-llm'` 就是这个口子。但「能做」不等于「有用」，
 * 所以这把尺子用**真宿主模型**去量，而不是用离线假提供方估：
 *
 *   · 改写由 `dsh --profile headless -` 逐条产生（本机的 harness，用它自己的模型与路由）；
 *   · 提示词与解析直接 import 产品代码（`hostLlmPrompt` / `normalizeExpansions`），
 *     保证尺子问的就是产品要问的那句话 —— 否则量出来的是别的东西；
 *   · 检索效果把改写离线重放给真接缝（`semanticSearch`），两张卷子：
 *     合成基准子集（colloquial 20 / bridge 32 / verbatim 20）与真库探针 36 条真实口语 query。
 *
 * 这条尺子量三件事：
 *   ① 代价：逐条延迟分布、有多少条超过插件默认 `semanticTimeoutMs: 2000`；
 *   ② 收益：词面基线 vs 接缝（当前实现）的 hit@1 / hit@4；
 *   ③ 上界：模型给的几条改写里**任意一条单独检索**能不能命中 gold
 *      （这一项是「信号在不在」的证明 —— 它比基线高，但要用它得有个打分器，
 *       没有打分器就只能当上界看，别当收益）。
 *
 * 用法：
 *   node bench/host-rewrite.mjs                # 采集 + 出报告（markdown）
 *   node bench/host-rewrite.mjs --limit 6      # 冒烟：每类只跑 6 条
 *   node bench/host-rewrite.mjs --offline      # 只用已采到的改写，不再调模型
 *   node bench/host-rewrite.mjs --json         # 额外写 bench/.host-rewrite.json
 *   node bench/host-rewrite.mjs --store <库>   # 换真库（默认 ~/memory/engramory）
 *
 * 依赖：本机有 `dsh` CLI（要真模型调用，所以不进 CI）；采集结果缓存在 bench/.tmp/，
 * 可断点续跑，重跑不重复烧钱。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BENCH_NOW, buildCorpus } from './corpus.mjs';
import { buildIndex, search } from '../bm25.js';
import { readDocs, corpusFingerprint } from '../store.js';
import { hostLlmPrompt, normalizeExpansions, semanticSearch } from '../semantic.js';
import { ALIAS_PAIRS, BRIDGE_PAIRS, PAIRS } from '../scripts/probe-queries.mjs';

const K = 4; // 看前 4 名（插件实际注入的指针数就是这个量级）
const POOL = 20; // 候选池：插件上限 20
const CALL_TIMEOUT_MS = 60000;
const TMP = path.join(import.meta.dirname, '.tmp');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const LIMIT = Number(flag('limit', 0)) || 0;
const OFFLINE = has('offline');
const wantJson = has('json');
const STORE = flag('store', `${process.env.HOME}/memory/engramory`);

mkdirSync(TMP, { recursive: true });

/** 每张卷子一份缓存文件；断点续跑按查询原文去重。 */
function cache(file) {
  const full = path.join(TMP, file);
  const rows = new Map();
  if (existsSync(full)) {
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        rows.set(row.q, row);
      } catch {}
    }
  } else {
    writeFileSync(full, '');
  }
  return {
    full,
    rows,
    add(row) {
      rows.set(row.q, row);
      appendFileSync(full, `${JSON.stringify(row)}\n`);
    },
  };
}

/** 用本机 harness 拿一次改写（真模型；提示词来自产品代码）。 */
function askHarness(query) {
  const started = Date.now();
  const run = spawnSync('dsh', ['--profile', 'headless', '-'], {
    input: hostLlmPrompt(query),
    encoding: 'utf8',
    timeout: CALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const text = run.status === 0 ? String(run.stdout ?? '').trim() : '';
  const expansions = normalizeExpansions(safeJson(text), query);
  return { ms, status: run.status, ok: expansions.length > 0, expansions, raw: text.slice(0, 400) };
}

/** 模型可能把 JSON 包在解释里；产品代码也这么取（`[` 到 `]`）。 */
function safeJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
}

// ---------- 两张卷子 ----------
const { docs, queries } = buildCorpus();
const every = (style, n) => {
  const list = queries.filter((q) => q.style === style);
  const step = Math.max(1, Math.ceil(list.length / n));
  return list.filter((_, i) => i % step === 0).slice(0, n);
};
const bridgeAll = queries.filter((q) => q.style === 'bridge');
const synthSheet = [...every('colloquial', 20), ...bridgeAll, ...every('verbatim', 20)].slice(0, LIMIT || undefined);
console.log(
  `合成子集：colloquial ${synthSheet.filter((q) => q.style === 'colloquial').length} · bridge ${synthSheet.filter((q) => q.style === 'bridge').length} · verbatim ${synthSheet.filter((q) => q.style === 'verbatim').length}（语料里 bridge 共 ${bridgeAll.length}）`,
);

const storeDocs = readDocs(STORE);
if (!storeDocs.length) {
  console.error(`读不到笔记：${STORE}（--store 可以换库）`);
  process.exit(1);
}
const realSheet = [
  ...PAIRS.map(([q, gold]) => ({ q, gold, group: '口径' })),
  ...BRIDGE_PAIRS.map(([q, gold]) => ({ q, gold, group: '桥' })),
  ...ALIAS_PAIRS.map(([q, gold]) => ({ q, gold, group: '别名' })),
].slice(0, LIMIT || undefined);

const sheets = [
  {
    name: '合成基准子集',
    kind: 'synthetic',
    index: buildIndex(docs, { now: BENCH_NOW }),
    sheet: synthSheet,
    // 分组直接用行自带的 style：早先按 q 文本回查会串组（不同风格的查询可能撞同一句）
    group: (row) => row.style ?? '?',
    cache: cache('host-rewrites.jsonl'),
  },
  {
    name: `真库探针（${new Set(storeDocs.map((d) => d.id)).size} 篇 / ${corpusFingerprint(storeDocs)}）`,
    kind: 'store',
    index: buildIndex(storeDocs),
    sheet: realSheet,
    group: (row) => row.group,
    cache: cache('host-rewrites-pairs.jsonl'),
  },
];

if (!OFFLINE) {
  const cli = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (cli.error || cli.status !== 0) {
    console.error('找不到可用的 `dsh` CLI —— 这把尺子要真宿主模型，所以只能在装了 harness 的机器上跑。');
    console.error('（只做检索效果复算、不调模型：node bench/host-rewrite.mjs --offline，前提是 bench/.tmp 里已有采集结果）');
    process.exit(1);
  }
}

// ---------- ① 采集 ----------
for (const s of sheets) {
  if (OFFLINE) continue;
  for (const row of s.sheet) {
    if (s.cache.rows.has(row.q)) continue;
    const got = askHarness(row.q);
    s.cache.add({ q: row.q, ...got });
    console.log(`[采集 ${s.name}] ${String(got.ms).padStart(6)}ms ${got.expansions.length} 条 · ${row.q}`);
  }
}

for (const s of sheets) {
  for (const row of s.sheet) {
    if (!s.cache.rows.has(row.q)) {
      console.error(`缺改写：${row.q} —— 去掉 --offline 先采一遍（或删掉 bench/.tmp 里对应缓存重采）`);
      process.exit(1);
    }
  }
}

/**
 * 融合策略变体：把「为什么生产必须是 append」这件事做成可复算的表。
 * 每种变体都只碰**排序**，不碰检索本身；`append` 就是当前产品实现（只补空位）。
 * 打分口径与 `semantic.js` 一致（RRF 是 1/(K + 名次)，名次从 1 起）。
 */
const VARIANTS = ['rrf-1', 'rrf-3', 'rrf-5', 'rrf-60', 'max-norm', 'sum-norm', 'append', 'gate'];

function rrf(lists, k, limit) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([id]) => id);
}

function scoredVariant(lists, limit, combine) {
  const scores = new Map();
  for (const list of lists) {
    const top = list[0]?.score ?? 1;
    for (const hit of list) {
      const value = top > 0 ? hit.score / top : 0;
      scores.set(hit.id, combine(scores.get(hit.id) ?? 0, value));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([id]) => id);
}

function appendOnly(lexicalIds, extraLists, limit) {
  const out = lexicalIds.slice(0, limit);
  const seen = new Set(out);
  for (const list of extraLists) {
    for (const id of list) {
      if (out.length >= limit) return out;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function fusionVariants(lexicalHits, expansionHits, limit) {
  const lexicalIds = lexicalHits.map((h) => h.id);
  const extraIds = expansionHits.map((list) => list.map((h) => h.id));
  const all = [lexicalIds, ...extraIds];
  const out = {};
  for (const name of VARIANTS) {
    if (name.startsWith('rrf-')) out[name] = rrf(all, Number(name.slice(4)), limit);
    else if (name === 'max-norm') out[name] = scoredVariant([lexicalHits, ...expansionHits], limit, (a, b) => Math.max(a, b));
    else if (name === 'sum-norm') out[name] = scoredVariant([lexicalHits, ...expansionHits], limit, (a, b) => a + b);
    else if (name === 'append') out[name] = appendOnly(lexicalIds, extraIds, limit);
    // gate：只有词面什么都没查到时才动用改写（保守到近乎不生效）
    else if (name === 'gate') out[name] = lexicalIds.length ? lexicalIds.slice(0, limit) : appendOnly([], extraIds, limit);
  }
  return out;
}

// ---------- 重放提供方（走真接缝） ----------
const replay = (s) => {
  const file = path.join(TMP, `replay-${s.kind}.mjs`);
  const table = JSON.stringify([...s.sheet.map((row) => [row.q, s.cache.rows.get(row.q).expansions ?? []])]);
  writeFileSync(
    file,
    `const table = new Map(${table});\nexport const name = 'host-rewrite-replay';\nexport async function expand({ query }) { return table.get(query) ?? []; }\n`,
  );
  return file;
};

// ---------- ② 量 ----------
const norm = (id) => String(id).replace(/\.md$/, '');
const report = [];
const json = { K, POOL, sheets: {} };

for (const s of sheets) {
  const provider = replay(s);
  const rows = [];
  for (const row of s.sheet) {
    const got = s.cache.rows.get(row.q);
    const want = norm(row.gold ?? '');
    const lexicalHits = search(s.index, row.q, POOL).map((h) => ({ ...h, id: norm(h.id) }));
    const base = lexicalHits.slice(0, K).map((h) => h.id);
    const pool = lexicalHits.map((h) => h.id);
    const expansionHits = got.expansions.map((text) => search(s.index, text, POOL).map((h) => ({ ...h, id: norm(h.id) })));
    const variants = fusionVariants(lexicalHits, expansionHits, K);
    const seam = await semanticSearch({ index: s.index, query: row.q, limit: POOL, config: { provider, timeoutMs: 5000 }, baseDir: TMP });
    const seamTop = seam.hits.slice(0, K).map((h) => norm(h.id));
    // 上界：任意一条改写单独检索（不改写不融合，所以没有投票污染）
    const alone = got.expansions.map((text) => search(s.index, text, K).map((h) => norm(h.id)));
    rows.push({
      q: row.q,
      group: s.group(row),
      gold: want,
      ms: got.ms,
      count: got.expansions.length,
      ok: got.ok,
      base1: base[0] === want,
      baseK: base.includes(want),
      seam1: seamTop[0] === want,
      seamK: seamTop.includes(want),
      poolK: pool.includes(want),
      alone1: alone.some((l) => l[0] === want),
      aloneK: alone.some((l) => l.includes(want)),
      code: seam.code,
      added: seam.added ?? 0,
      variantHit1: Object.fromEntries(Object.entries(variants).map(([name, ids]) => [name, ids[0] === want])),
      variantHitK: Object.fromEntries(Object.entries(variants).map(([name, ids]) => [name, ids.includes(want)])),
    });
  }
  report.push({ sheet: s, rows });
  json.sheets[s.kind] = { name: s.name, rows };
}

// ---------- ③ 出报告 ----------
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
const count = (list, key) => list.filter((r) => r[key]).length;

console.log('\n## 代价（逐条真调用）\n');
for (const { sheet: s, rows } of report) {
  const mss = rows.map((r) => r.ms).sort((a, b) => a - b);
  const median = mss[Math.floor(mss.length / 2)];
  const p90 = mss[Math.floor(mss.length * 0.9)] ?? mss[mss.length - 1];
  const over = rows.filter((r) => r.ms > 2000).length;
  const empty = rows.filter((r) => !r.ok).length;
  console.log(
    `- ${s.name}：${rows.length} 条 · 中位 **${median}ms** · p90 ${p90}ms · 最小 ${mss[0]}ms · 最大 ${mss[mss.length - 1]}ms` +
      ` · 超过插件默认 2000ms 预算 **${over}/${rows.length}** · 没拿到改写 ${empty}/${rows.length}`,
  );
  json.sheets[s.kind].latency = { median, p90, min: mss[0], max: mss[mss.length - 1], over2000: over, empty };
}

console.log('\n## 收益（词面 vs 接缝 vs 上界）\n');
console.log('| 卷子 | 组 | 条数 | 词面 hit@1 / hit@4 | 接缝 hit@1 / hit@4 | 任意一条改写单独检索 hit@1 / hit@4 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const { sheet: s, rows } of report) {
  for (const g of [...new Set(rows.map((r) => r.group)), '全部']) {
    const list = g === '全部' ? rows : rows.filter((r) => r.group === g);
    console.log(
      `| ${s.name} | ${g} | ${list.length} | ${count(list, 'base1')}/${count(list, 'baseK')} | ${count(list, 'seam1')}/${count(list, 'seamK')} | ${count(list, 'alone1')}/${count(list, 'aloneK')} |`,
    );
  }
}

console.log('\n## 融合策略对照（生产 = append；其余是「换成别的融合会怎样」）\n');
console.log(`| 变体 | ${report.map(({ sheet }) => sheet.name).join(' | ')} |`);
console.log(`| --- | ${report.map(() => '---').join(' | ')} |`);
for (const name of VARIANTS) {
  const cells = report.map(({ rows }) => {
    const one = rows.filter((r) => r.variantHit1[name]).length;
    const kk = rows.filter((r) => r.variantHitK[name]).length;
    return `${one}/${kk}（${pct(one, rows.length)} / ${pct(kk, rows.length)}）`;
  });
  console.log(`| ${name}${name === 'append' ? ' ← 生产' : ''} | ${cells.join(' | ')} |`);
}
for (const { sheet, rows } of report) {
  json.sheets[sheet.kind].variants = Object.fromEntries(
    VARIANTS.map((name) => [
      name,
      { hit1: rows.filter((r) => r.variantHit1[name]).length, hitK: rows.filter((r) => r.variantHitK[name]).length },
    ]),
  );
}

console.log('\n## 结论行（自动生成，别手抄）\n');
for (const { sheet: s, rows } of report) {
  const same = rows.filter((r) => r.seam1 === r.base1 && r.seamK === r.baseK).length;
  console.log(
    `- ${s.name}：接缝与词面**逐条相同**的 ${same}/${rows.length}（` +
      `hit@1 ${count(rows, 'base1')} → ${count(rows, 'seam1')}，hit@${K} ${count(rows, 'baseK')} → ${count(rows, 'seamK')}）；` +
      `池内召回 ${count(rows, 'poolK')}/${rows.length}；上界（任意一条改写命中 gold@1）${count(rows, 'alone1')}/${rows.length}`,
  );
  json.sheets[s.kind].summary = {
    rows: rows.length,
    base1: count(rows, 'base1'),
    baseK: count(rows, 'baseK'),
    seam1: count(rows, 'seam1'),
    seamK: count(rows, 'seamK'),
    alone1: count(rows, 'alone1'),
    aloneK: count(rows, 'aloneK'),
    poolK: count(rows, 'poolK'),
    identical: same,
  };
}
console.log('\n- 读法：接缝必须与词面**逐条相同**（`expand` 只补空位）；`上界` 是「信号在不在」，不是收益 ——');
console.log('  要用上它得有一个能判断「哪条改写更好」的打分器（embedding），宿主只有对话接口。');

if (wantJson) {
  const out = path.join(import.meta.dirname, '.host-rewrite.json');
  writeFileSync(out, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`\n→ ${out}`);
}
