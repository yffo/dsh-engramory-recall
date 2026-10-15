/**
 * 接缝的**结构性承诺**要用真语料钉住，而不是只在玩具 fixture 上验一遍：
 * 提供方抛错 / 卡住 / 返回编造的 id 时，返回的命中必须与词面路径**逐字相同**。
 *
 * 这里故意用合成基准语料（`bench/corpus.mjs`，固定种子、离线）而不是 mock：
 * 「降级 = 结果不变 + 如实报码」这句话只有在真实索引与真实查询分布上才算数。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BENCH_NOW, buildCorpus } from '../bench/corpus.mjs';
import { buildIndex } from '../bm25.js';
import { semanticSearch } from '../semantic.js';

const { docs, queries } = buildCorpus();
const index = buildIndex(docs, { now: BENCH_NOW });
// 抽样 120 条查询足够钉住承诺，也让这个用例保持在秒级。
const sample = queries.filter((_, i) => i % 6 === 0);
const LIMIT = 4;

/** 提供方模块写临时目录，真的走 import()（连加载失败的分支都算进去）。 */
function provider(body) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-seam-corpus-'));
  const path = join(dir, 'provider.mjs');
  writeFileSync(path, body);
  return { path, dir };
}

async function idsFor(query, config) {
  const result = await semanticSearch({ index, query, limit: LIMIT, config });
  return { ids: result.hits.map((h) => h.id), ...result };
}

const cases = [
  { label: '抛错', body: `export function rerank() { throw new Error('boom'); }`, code: 'provider-error' },
  { label: '卡住', body: `export function rerank() { return new Promise(() => {}); }`, code: 'timeout' },
  { label: '编造文件名', body: `export function rerank() { return [{ id: '根本没有这篇.md', score: 9 }]; }`, code: 'provider-empty' },
  // 非数组 = 「没给出任何可用排序」：归到 provider-empty（而不是假装成提供方崩了）
  { label: '返回非数组', body: `export function rerank() { return '这就是垃圾'; }`, code: 'provider-empty' },
];

test('接缝降级：坏提供方在真语料上与词面结果逐字相同', async () => {
  const baseline = new Map();
  for (const query of sample) {
    const { ids } = await idsFor(query.q, {});
    baseline.set(query.q, ids);
  }

  for (const scenario of cases) {
    const { path, dir } = provider(scenario.body);
    try {
      let compared = 0;
      for (const query of sample) {
        const { ids, code, used } = await idsFor(query.q, { provider: path, timeoutMs: 30 });
        assert.equal(code, scenario.code, `${scenario.label}：应如实报 ${scenario.code}`);
        assert.equal(used, false, `${scenario.label}：没生效就不能说生效`);
        assert.deepEqual(ids, baseline.get(query.q), `${scenario.label}：「${query.q}」的命中被改动了 —— 降级必须是结果不变`);
        compared++;
      }
      assert.equal(compared, sample.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('接缝正常路径：真打分的提供方只能重排，不能凭空增删', async () => {
  // 用「字符三元组相似度」当离线提供方：确定性、不发请求、不用 gold。
  const { path, dir } = provider(`const grams = (s) => { const t = String(s).toLowerCase().replace(/\\s+/g, ' '); const out = new Set();
     for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
   const jaccard = (a, b) => { let hit = 0; for (const g of a) if (b.has(g)) hit++; return hit / (a.size + b.size - hit); };
   export function rerank({ query, docs }) {
     const qg = grams(query);
     // 必须自己排序：直接按原顺序返回等于没重排（第一版就栽在这儿，reordered === 0）
     return docs.map((d) => ({ id: d.id, score: jaccard(qg, grams(d.snippet ?? '')) }))
       .sort((a, b) => b.score - a.score);
   }`);
  try {
    let reordered = 0;
    for (const query of sample) {
      const base = await idsFor(query.q, {});
      const { ids, code, used } = await idsFor(query.q, { provider: path, timeoutMs: 2000 });
      assert.equal(code, 'reranked');
      assert.equal(used, true);
      assert.deepEqual([...ids].sort(), [...base.ids].sort(), '同一个 limit 下输出就是同一批文档的重排');
      if (ids.join() !== base.ids.join()) reordered++;
    }
    assert.ok(reordered > 0, '真打分的提供方应该至少改掉一部分顺序，否则接缝是装饰');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接缝的 expand 契约：一个「好改写」提供方也只许补空位，永不改动词面顺序', async () => {
  // 用「同一篇笔记的其它问法」当改写 —— 这是**真实的好改写**（模型能给的就是这种），
  // 也是 2026-10-15 实测里把 RRF 融合打出 -7 hit@1 的那类输入。契约：顺序一个字都不许变。
  const others = new Map();
  for (const query of queries) {
    if (!others.has(query.gold)) others.set(query.gold, []);
    const list = others.get(query.gold);
    if (list.length < 3 && query.q !== undefined) list.push(query.q);
  }
  const byQuery = new Map(sample.map((q) => [q.q, (others.get(q.gold) ?? []).filter((t) => t !== q.q).slice(0, 3)]));

  const dir = mkdtempSync(join(tmpdir(), 'engramory-seam-expand-'));
  const path = join(dir, 'provider.mjs');
  writeFileSync(path, `const table = new Map(${JSON.stringify([...byQuery])});\nexport function expand({ query }) { return table.get(query) ?? []; }\n`);
  try {
    let withExpansions = 0;
    for (const query of sample) {
      const base = await idsFor(query.q, {});
      const { ids, code, used, added } = await idsFor(query.q, { provider: path, timeoutMs: 2000 });
      assert.equal(used, true);
      assert.equal(code, 'expanded');
      assert.deepEqual(ids, base.ids, `「${query.q}」的命中顺序被改写了 —— expand 只许补空位`);
      if ((byQuery.get(query.q) ?? []).length) withExpansions += 1;
      assert.equal(added, 0, '词面已占满 limit（4 条），不该有补位空间');
    }
    assert.ok(withExpansions > sample.length * 0.8, '绝大多数查询都该真的拿到了改写（否则这个用例是空跑）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
