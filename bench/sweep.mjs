/**
 * 参数扫描：把「标题权重」和「同义桥折扣」两个常量在合成语料上扫一遍。
 *
 * 存在的理由：真库探针的对照 C（唯一对标题权重中立的构造）当初选了 TITLE_EXTRA=24，
 * 而合成语料说 0 更好 —— 两个证据冲突时，必须把冲突**定位到机制**，不能取平均。
 * 所以扫描表按「字面重叠」拆开看：靠字面碎片捡到的命中，和真要靠桥的命中，分开数。
 *
 * 用法：node bench/sweep.mjs
 */
import { buildCorpus, literalOverlap } from './corpus.mjs';
import { loadVariant } from './variant.mjs';

const K = 4;
const { docs, queries } = buildCorpus();
const docById = new Map(docs.map((d) => [d.id, d]));

const overlapOf = new Map(queries.map((q) => [q, literalOverlap(q.q, docById.get(q.gold))]));

function measure(bm25) {
  const index = bm25.buildIndex(docs);
  const rows = [];
  for (const query of queries) {
    const hits = bm25.search(index, query.q, K).map((h) => h.id);
    const rank = hits.indexOf(query.gold);
    rows.push({ query, hit1: rank === 0, hitK: rank >= 0, rank });
  }
  const agg = (list) => ({
    n: list.length,
    hit1: list.filter((r) => r.hit1).length / (list.length || 1),
    hitK: list.filter((r) => r.hitK).length / (list.length || 1),
  });
  const colloquial = rows.filter((r) => r.query.style === 'colloquial');
  const bridge = rows.filter((r) => r.query.style === 'bridge');
  return {
    all: agg(rows),
    verbatim: agg(rows.filter((r) => r.query.style === 'verbatim')),
    colloquial: agg(colloquial),
    keyword: agg(rows.filter((r) => r.query.style === 'keyword')),
    bridge: agg(bridge),
    literal: agg(colloquial.filter((r) => overlapOf.get(r.query) > 0)),
  };
}

const titleValues = [0, 2, 3, 8, 16, 24, 48];
const extraValues = [0.5, 1];
const out = [];
for (const title of titleValues) {
  for (const extra of extraValues) {
    const bm25 = await loadVariant(
      { 'const TITLE_EXTRA = 24;': `const TITLE_EXTRA = ${title};`, 'const EXTRA_WEIGHT = 0.5;': `const EXTRA_WEIGHT = ${extra};` },
      `t${title}e${String(extra).replace('.', '')}`,
    );
    out.push({ title, extra, ...measure(bm25) });
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`语料：${docs.length} 篇 / ${queries.length} 条查询。桥组 = 口语查询中字面重叠为 0 的那些。\n`);
console.log('| TITLE_EXTRA | EXTRA_WEIGHT | 总 hit@1 | 总 hit@4 | verbatim | colloquial | keyword | 口语·有字面落点 | 口语·纯桥组 | 桥组 hit@4 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of out) {
  console.log(`| ${row.title} | ${row.extra} | ${pct(row.all.hit1)} | ${pct(row.all.hitK)} | ${pct(row.verbatim.hit1)} | ${pct(row.colloquial.hit1)} | ${pct(row.keyword.hit1)} | ${pct(row.literal.hit1)} (${row.literal.n}) | ${pct(row.bridge.hit1)} (${row.bridge.n}) | ${pct(row.bridge.hitK)} |`);
}

const best = (key) => out.reduce((a, b) => (b[key].hit1 > a[key].hit1 ? b : a));
console.log('\n单看各列的最优取值：');
for (const key of ['all', 'colloquial', 'keyword', 'bridge', 'literal', 'verbatim']) {
  const b = best(key);
  const ties = out.filter((r) => r[key].hit1 === b[key].hit1).map((r) => `${r.title}/${r.extra}`);
  console.log(`- ${key}: ${pct(b[key].hit1)} @ TITLE_EXTRA=${b.title}, EXTRA_WEIGHT=${b.extra}（并列：${ties.join(' ')}）`);
}
