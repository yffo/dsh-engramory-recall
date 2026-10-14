/**
 * 召回基准：跑合成语料，把「本插件 vs 常规写法」和「逐步去掉某一项」都量出来。
 *
 * 用法：
 *   npm run bench              # 打印 markdown 报告
 *   node bench/run.mjs --json  # 额外写 bench/.bench-result.json
 *
 * 退出码：仅当本插件的 hit@1 **低于**最好的基线时才非零 —— 这是防自欺的那一道门，
 * 不做「必须达到某个绝对分数」的卡点（绝对分数会随语料演化，卡死只会逼人改尺子）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBaseline } from './baseline.mjs';
import { buildCorpus, literalOverlap } from './corpus.mjs';
import { loadVariant } from './variant.mjs';
import { SYNONYMS, buildIndex, search } from '../bm25.js';

const here = dirname(fileURLToPath(import.meta.url));
const K = 4;
const wantJson = process.argv.includes('--json');

const { docs, queries, meta } = buildCorpus();

function evaluate(searchFn, index, list) {
  const byStyle = new Map();
  const misses = [];
  const started = process.hrtime.bigint();
  for (const query of list) {
    const hits = searchFn(index, query.q, K).map((h) => h.id);
    const rank = hits.indexOf(query.gold);
    const row = { hit1: rank === 0, hitK: rank >= 0, rr: rank >= 0 ? 1 / (rank + 1) : 0 };
    if (!byStyle.has(query.style)) byStyle.set(query.style, []);
    byStyle.get(query.style).push({ ...row, query });
    if (rank !== 0) {
      const top = hits[0];
      const wrong = top === undefined ? null : docs.find((d) => d.id === top);
      const gold = docs.find((d) => d.id === query.gold);
      misses.push({
        query,
        top,
        // 失败模式归类：同域（事件搞混）/ 同事件（域搞混）/ 完全不沾边。
        kind: wrong === undefined || wrong === null ? 'no-hit'
          : wrong.domain === gold.domain ? 'same-domain'
            : wrong.event === gold.event ? 'same-event' : 'unrelated',
      });
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const agg = (rows) => ({
    n: rows.length,
    hit1: rows.filter((r) => r.hit1).length / (rows.length || 1),
    hitK: rows.filter((r) => r.hitK).length / (rows.length || 1),
    mrr: rows.reduce((s, r) => s + r.rr, 0) / (rows.length || 1),
  });
  const all = [...byStyle.values()].flat();
  return {
    ...agg(all),
    rows: all,
    byStyle: Object.fromEntries([...byStyle].map(([style, rows]) => [style, agg(rows)])),
    misses,
    elapsedMs,
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const signed = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;

const docsNoAlias = docs.map((d) => ({ ...d, aliases: [] }));
const indexFull = buildIndex(docs);
const indexNoAlias = buildIndex(docsNoAlias);

const variantFlatFragments = await loadVariant({ 'const BRIDGED_FRAGMENT_WEIGHT = 0.5;': 'const BRIDGED_FRAGMENT_WEIGHT = 1;' }, 'flat-fragments');
const variantOldBridge = await loadVariant({ 'const BRIDGE_WEIGHT = 1;': 'const BRIDGE_WEIGHT = 0.5;' }, 'old-bridge');
const variantNoTitle = await loadVariant({ 'const TITLE_EXTRA = 24;': 'const TITLE_EXTRA = 0;' }, 'title0');

/** 同义表消融：直接清空模块级 Map，跑完再装回去（索引不受影响，扩展只在查询期发生）。 */
function withoutSynonyms(run) {
  const saved = [...SYNONYMS];
  SYNONYMS.clear();
  try {
    return run();
  } finally {
    SYNONYMS.clear();
    for (const [key, value] of saved) SYNONYMS.set(key, value);
  }
}

const runs = [];
runs.push({ name: '本插件（当前实现）', detail: '字段加权 + 同义扩展 + aliases', result: evaluate((i, q, k) => search(i, q, k), indexFull, queries) });
runs.push({ name: '去掉同义表', detail: '其余不动', result: withoutSynonyms(() => evaluate((i, q, k) => search(i, q, k), indexFull, queries)) });
runs.push({ name: '去掉 aliases', detail: '笔记不再声明别名', result: evaluate((i, q, k) => search(i, q, k), indexNoAlias, queries) });
runs.push({
  name: '去掉字段加权',
  detail: 'TITLE_EXTRA 24 → 0（源码变体）',
  result: evaluate((i, q, k) => variantNoTitle.search(i, q, k), variantNoTitle.buildIndex(docs), queries),
});
// 桥的权重结构（2026-10-15 的新改动）：命中的同义键，其字面碎片降为 0.5，桥到的技术词升为 1.0。
// 两行消融各拆一半，看收益来自「碎片降权」还是「桥升权」。
runs.push({
  name: '同义键碎片不降权（其余同本插件）',
  detail: 'BRIDGED_FRAGMENT_WEIGHT 0.5 → 1',
  result: evaluate((i, q, k) => variantFlatFragments.search(i, q, k), variantFlatFragments.buildIndex(docs), queries),
});
runs.push({
  name: '桥也打回 0.5（本次改动之前的行为）',
  detail: 'BRIDGE_WEIGHT 1 → 0.5',
  result: evaluate((i, q, k) => variantOldBridge.search(i, q, k), variantOldBridge.buildIndex(docs), queries),
});

const baselines = [];
for (const mode of ['bigram', 'unigram']) {
  const engine = createBaseline(mode);
  baselines.push({ name: engine.name, detail: mode === 'bigram' ? '同分词口径、无额外机制' : '中文逐字', result: evaluate((i, q, k) => engine.search(i, q, k), engine.build(docs), queries) });
}
// 地板线：完全瞎猜（按查询串确定性洗牌）。用来把「命中率」读成「比瞎猜好多少」。
const guesser = (i, q, k) => {
  let h = 2166136261;
  for (const ch of q) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  const ids = docs.map((d) => d.id);
  for (let n = ids.length - 1; n > 0; n--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (n + 1);
    [ids[n], ids[j]] = [ids[j], ids[n]];
  }
  return ids.slice(0, k).map((id) => ({ id }));
};
baselines.push({ name: '基线：瞎猜（地板线）', detail: '按查询串确定性洗牌', result: evaluate(guesser, null, queries) });

const ours = runs[0].result;
const bestBaseline = baselines.reduce((a, b) => (b.result.hit1 > a.result.hit1 ? b : a));

const lines = [];
lines.push('# 召回基准（合成语料，可直接复算）');
lines.push('');
lines.push(`语料：${meta.notes} 篇笔记（中文书面 ${meta.zhNotes} / 英文术语 ${meta.englishNotes} / 口语体 ${meta.colloquialNotes}，其中带 aliases ${meta.aliasedNotes} 篇）· 查询 ${meta.queries} 条 · seed \`${meta.seed}\``);
lines.push('');
lines.push(`桥组 ${meta.bridgeQueries} 条（构造校验）· 同义表覆盖：域词 ${meta.domainCovered}/${meta.domainWords}、事件词 ${meta.eventCovered}/${meta.eventWords}`);
lines.push('');
lines.push('三种查询风格：`verbatim` 抄笔记自己的写法（对照组）；`colloquial` 只用口语说法，与正文没有字面重叠（要跨语言/跨说法搭桥）；`keyword` 口语症状 + 域特征词（同域候选很多，必须靠事件词分辨）。');
lines.push('');
lines.push('## 总览');
lines.push('');
lines.push('| 引擎 | 总 hit@1 | 总 hit@4 | verbatim | colloquial | keyword | MRR@4 | 672 条耗时 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const run of [...runs, ...baselines]) {
  const s = run.result.byStyle;
  const cell = (style) => (s[style] ? `${pct(s[style].hit1)} / ${pct(s[style].hitK)}` : '—');
  lines.push(`| ${run.name} | ${pct(run.result.hit1)} | ${pct(run.result.hitK)} | ${cell('verbatim')} | ${cell('colloquial')} | ${cell('keyword')} | ${run.result.mrr.toFixed(3)} | ${run.result.elapsedMs.toFixed(0)}ms |`);
}
lines.push('');
lines.push('（分风格单元格 = hit@1 / hit@4。`keyword` 的同域候选有 14 篇，瞎猜命中率约 7%，地板线一行就是实测值。）');
lines.push('');
lines.push('## 消融（本插件逐步去掉一项，看掉多少）');
lines.push('');
lines.push('| 配置 | hit@1 | 相对本插件 | hit@4 | 说明 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const run of runs) {
  lines.push(`| ${run.name} | ${pct(run.result.hit1)} | ${run === runs[0] ? '—' : signed(run.result.hit1 - ours.hit1)}pt | ${pct(run.result.hitK)} | ${run.detail} |`);
}
lines.push('');
lines.push('## 口语查询到底卡在哪（本插件，只看 colloquial 风格）');
lines.push('');
const docById = new Map(docs.map((d) => [d.id, d]));
const colloquialRows = ours.rows.filter((r) => r.query.style === 'colloquial');
const groupAgg = (rows) => ({
  n: rows.length,
  hit1: rows.filter((r) => r.hit1).length / (rows.length || 1),
  hitK: rows.filter((r) => r.hitK).length / (rows.length || 1),
});
const dialectNote = { colloquial: '正文就是大白话 ⇒ 字面能对上', zh: '正文是书面说法 ⇒ 要跨说法', en: '正文是英文术语 ⇒ 要跨语言' };
lines.push('| 笔记体裁 | 条数 | hit@1 | hit@4 | 说明 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const dialect of ['colloquial', 'zh', 'en']) {
  const rows = colloquialRows.filter((r) => docById.get(r.query.gold)?.dialect === dialect);
  const agg = groupAgg(rows);
  lines.push(`| ${dialect} | ${agg.n} | ${pct(agg.hit1)} | ${pct(agg.hitK)} | ${dialectNote[dialect]} |`);
}
const withAlias = colloquialRows.filter((r) => (docById.get(r.query.gold)?.aliases ?? []).length > 0);
const noAlias = colloquialRows.filter((r) => (docById.get(r.query.gold)?.aliases ?? []).length === 0);
lines.push('');
lines.push('| 笔记是否写了 aliases | 条数 | hit@1 | hit@4 | 说明 |');
lines.push('| --- | --- | --- | --- | --- |');
lines.push(`| 写了 | ${withAlias.length} | ${pct(groupAgg(withAlias).hit1)} | ${pct(groupAgg(withAlias).hitK)} | 作者自己把口语说法钉在笔记上 |`);
lines.push(`| 没写 | ${noAlias.length} | ${pct(groupAgg(noAlias).hit1)} | ${pct(groupAgg(noAlias).hitK)} | 只能靠同义表去猜 |`);
lines.push('');
lines.push('## 同义桥（构造校验：查询词在笔记里一个字都没有）');
lines.push('');
const bridgeRows = ours.rows.filter((r) => r.query.style === 'bridge');
const bridgeSeen = bridgeRows.filter((r) => !r.query.heldOut);
const bridgeHeld = bridgeRows.filter((r) => r.query.heldOut);
lines.push('| 组 | 条数 | hit@1 | hit@4 | 说明 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const [label, rows, note] of [['桥组（全部）', bridgeRows, '命中即表被用上；不命中即桥没接上'], ['其中：公开词族', bridgeSeen, '调表时看得见'], ['其中：留出词族', bridgeHeld, '表里没参与调参的那批，看泛化']]) {
  const agg = groupAgg(rows);
  lines.push(`| ${label} | ${agg.n} | ${pct(agg.hit1)} | ${pct(agg.hitK)} | ${note} |`);
}
lines.push('');
lines.push(`⚠️ 口径边界：这组查询是从引擎自己读的那张表里长出来的，所以它证明的是「扩展管道通不通」，`);
lines.push(`不是「表能不能猜中没见过的说法」。后者只有留出组那 ${bridgeHeld.length} 条能说一点。`);
lines.push('');
lines.push('### 这三种配置下，桥组的差别（同一批 11 条查询）');
lines.push('');
lines.push('| 配置 | 桥组 hit@1 | 总 hit@1 | 怎么读 |');
lines.push('| --- | --- | --- | --- |');
for (const run of [runs[0], runs[4], runs[5]]) {
  const agg = groupAgg(run.result.rows.filter((r) => r.query.style === 'bridge'));
  const total = run.result.hit1;
  lines.push(`| ${run.name} | ${pct(agg.hit1)} | ${pct(total)} | ${run.name === runs[0].name ? '本插件当前实现' : run.detail} |`);
}
lines.push('');
lines.push('⚠️ 这里有一个**明确了取舍**：把桥打回 0.5（改动前的行为）总 hit@1 反而高 1 个点，而桥组掉到 90.9%（在修「碎片压桥」之前实测是 27.3%）。');
lines.push('原因是合成语料里绝大多数查询**本来就有字面落点**，总命中率被它们主导；桥组那 11 条是唯一「字面为零」的场景，');
lines.push('也正是「换一种说法还找得回来吗」的答案所在。所以这里选择牺牲 1 个点的总分，换桥真正接通 —— 而不是让桥静默失效。');
lines.push('');
lines.push('### 桥的供给面（这才是瓶颈）');
lines.push('');
const colloquialOnly = ours.rows.filter((r) => r.query.style === 'colloquial');
const noLiteral = colloquialOnly.filter((r) => literalOverlap(r.query.q, docById.get(r.query.gold)) === 0);
lines.push(`- 同义表覆盖：域词 **${meta.domainCovered}/${meta.domainWords}**、事件词 **${meta.eventCovered}/${meta.eventWords}** —— 表是照着真实库长的，换一套词汇就大面积没有桥。`);
lines.push(`- 构造桥样本时被丢弃 ${meta.bridgeDropped.length} 组：口语键里带的字面碎片在笔记里已经出现，够不上「纯桥」的资格（例如 ${meta.bridgeDropped.slice(0, 2).join('；')}）。`);
lines.push(`- 口语风格的 ${colloquialOnly.length} 条查询里，字面重叠为 0 的只有 **${noLiteral.length}** 条 —— 也就是说这批「口语查询」绝大多数仍能靠字面碎片碰到笔记，真正需要跨说法/跨语言的只有那几条。`);
lines.push('');
lines.push('## 失败模式（本插件 hit@1 未命中的查询里，top-1 错成了什么）');
lines.push('');
const kinds = { 'same-domain': 0, 'same-event': 0, unrelated: 0, 'no-hit': 0 };
for (const m of ours.misses) kinds[m.kind]++;
lines.push(`- 同域、错在事件：${kinds['same-domain']}`);
lines.push(`- 同事件、错在域：${kinds['same-event']}`);
lines.push(`- 完全不沾边：${kinds.unrelated}`);
lines.push(`- 一条都没召回：${kinds['no-hit']}`);

const report = lines.join('\n');
console.log(report);

if (wantJson) {
  writeFileSync(join(here, '.bench-result.json'), `${JSON.stringify({
    meta,
    runs: runs.map((r) => ({ name: r.name, detail: r.detail, hit1: r.result.hit1, hitK: r.result.hitK, mrr: r.result.mrr, byStyle: r.result.byStyle })),
    baselines: baselines.map((r) => ({ name: r.name, detail: r.detail, hit1: r.result.hit1, hitK: r.result.hitK, mrr: r.result.mrr })),
    kinds,
  }, null, 2)}\n`);
}

if (ours.hit1 + 1e-9 < bestBaseline.result.hit1) {
  console.error(`\n✗ 本插件 hit@1 ${pct(ours.hit1)} 低于最好基线「${bestBaseline.name}」${pct(bestBaseline.result.hit1)}`);
  process.exit(1);
}
