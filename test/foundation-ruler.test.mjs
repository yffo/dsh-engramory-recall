/**
 * 地基句尺子（`bench/foundation-corpus.mjs` + `bench/foundation.mjs`）自己的契约。
 *
 * 这把尺子的用途是**证伪我们自己**（「这条线索到底进没进上下文」），
 * 所以它自己必须先在差方法上红 —— 一把永远通过的尺子等于没有尺子。
 * 钉四件事：
 *   1. 题集确定（同种子逐字节一样），且种子真的起作用；
 *   2. 题集是**虚构**的 —— 不许出现真实人名/路径/项目名（要能进仓库、能公开）；
 *   3. 留出集与提问形态**不能共线**。这坑真踩过：第一版用 `i % 8` / `i % 3`
 *      独立取值，结果留出集恰好全是 rare 形态，读出「87.5% vs 10.9%」的假差距；
 *   4. 尺子能分辨好坏：按命中词数挑行的老做法，保地基率必须**显著低于**
 *      IDF 加权挑行 —— 差距 ≥ 20 个百分点。数字随夹具变，这条机制不许失效。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildFoundationSet } from '../bench/foundation-corpus.mjs';
import { buildIndex, search, tokenize } from '../bm25.js';
import { clip } from '../render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTENCE_CAP = 64;

/** 老做法：把候选行按「命中了几个查询词」排队，取命中最多的那一行（这就是 `bestLine` 的口径）。 */
function countPicker(doc, matched) {
  const wanted = new Set(matched);
  const candidates = [
    doc.title,
    doc.description,
    ...String(doc.body ?? '').split('\n'),
  ];
  let best = '';
  let bestScore = 0;
  for (const raw of candidates) {
    const line = String(raw ?? '').trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const terms = new Set(tokenize(line));
    let score = 0;
    for (const term of wanted) if (terms.has(term)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best || doc.title || doc.id;
}

/** 参考做法：同样的候选行，但按 idf 加权，并给「标题/描述」打折（它们只是在复述提问）。 */
function idfPicker(doc, matched, idf, sentences = false) {
  const wanted = new Set(matched);
  const parts = sentences
    ? String(doc.body ?? '').split(/(?<=[。！？!?])|\n/)
    : String(doc.body ?? '').split('\n');
  const candidates = [
    { text: doc.title, kind: 'meta' },
    { text: doc.description, kind: 'meta' },
    ...parts.map((text) => ({ text, kind: 'body' })),
  ];
  let best = '';
  let bestScore = -1;
  for (const candidate of candidates) {
    const line = String(candidate.text ?? '').trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const terms = new Set(tokenize(line));
    let score = 0;
    let hit = 0;
    for (const term of wanted) {
      if (terms.has(term)) {
        score += idf(term);
        hit += 1;
      }
    }
    if (!hit) continue;
    if (candidate.kind === 'meta') score *= 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best || doc.title || doc.id;
}

/** 跑一遍「地基句有没有进上下文」，返回两种挑行口径下的保地基率。 */
function retention() {
  const set = buildFoundationSet();
  const index = buildIndex(set.docs);
  const df = new Map();
  for (const doc of index.docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const total = index.docs.length;
  const idf = (term) => {
    const seen = df.get(term) ?? 0;
    return Math.log(1 + (total - seen + 0.5) / (seen + 0.5));
  };
  const byId = new Map(index.docs.map((doc) => [doc.id, doc]));
  let count = 0;
  let idfHit = 0;
  for (const question of set.questions) {
    const hit = search(index, question.q, 4).find((candidate) => candidate.id === question.gold);
    if (!hit) continue;
    const doc = byId.get(hit.id);
    const oldLine = `- ${hit.id} — ${clip(countPicker(doc, hit.matched ?? []), SENTENCE_CAP)}`;
    if (oldLine.includes(question.foundation)) count += 1;
    const newLine = `- ${hit.id} — ${clip(idfPicker(doc, hit.matched ?? [], idf, true), SENTENCE_CAP)}`;
    if (newLine.includes(question.foundation)) idfHit += 1;
  }
  return { total: set.questions.length, count, idf: idfHit };
}

test('题集是确定的：同种子逐字节一样，换种子真的换题', () => {
  const a = buildFoundationSet();
  const b = buildFoundationSet();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const other = buildFoundationSet({ seed: 20261017 });
  assert.notEqual(JSON.stringify(a.questions), JSON.stringify(other.questions));
});

test('题集是虚构的：不出现真实人名、路径、项目名', () => {
  const source = readFileSync(join(root, 'bench', 'foundation-corpus.mjs'), 'utf8');
  const serialized = JSON.stringify(buildFoundationSet());
  for (const forbidden of ['yangfu', 'yffto', '杨总', 'engramory-recall', 'memory/engramory', '/Users/']) {
    assert.equal(source.includes(forbidden), false, `语料源码里出现了「${forbidden}」`);
    assert.equal(serialized.includes(forbidden), false, `题集里出现了「${forbidden}」`);
  }
});

test('题集结构：一条题一个地基句，地基句带证据且长度落在 24–90 字', () => {
  const set = buildFoundationSet();
  const ids = new Set();
  for (const question of set.questions) {
    assert.equal(ids.has(question.gold), false, `同一篇笔记出了两道题：${question.gold}`);
    ids.add(question.gold);
    assert.ok(question.foundation.length >= 24 && question.foundation.length <= 90, question.foundation);
    assert.ok(question.q.includes(question.evidence[0]), `提问里没带证据词：${question.q}`);
    const doc = set.docs.find((entry) => entry.id === question.gold);
    assert.ok(doc.body.includes(question.foundation), `笔记正文里没有地基句：${question.gold}`);
  }
});

test('留出集与提问形态不许共线（真踩过：留出集恰好全是 rare）', () => {
  const set = buildFoundationSet();
  const heldOut = set.questions.filter((question) => question.heldOut);
  assert.ok(heldOut.length >= 24, `留出集太小：${heldOut.length}`);
  for (const axis of ['shape', 'group']) {
    const keys = new Set(heldOut.map((question) => question[axis]));
    assert.equal(keys.size, new Set(set.questions.map((question) => question[axis])).size);
    for (const key of keys) {
      const share = heldOut.filter((question) => question[axis] === key).length / heldOut.length;
      // 形态轴（rare/mid/verbose）各占三分之一，低于 15% 说明它跟留出集共线了；
      // 分组轴里的 long 天生只占题集的 1/8，门槛按最小的组给。
      const floor = axis === 'shape' ? 0.15 : 0.08;
      assert.ok(share >= floor, `留出集里 ${axis}=${key} 只占 ${(share * 100).toFixed(1)}%，两轴共线了`);
    }
  }
});

test('尺子能分辨好坏：按词数挑行 → IDF 加权挑行，保地基率必须拉开 ≥ 20 个百分点', () => {
  const { total, count, idf } = retention();
  const countRate = count / total;
  const idfRate = idf / total;
  assert.ok(countRate < 0.6, `老做法保地基率 ${(countRate * 100).toFixed(1)}% 太高，夹具已经拦不住它了`);
  assert.ok(
    idfRate - countRate >= 0.2,
    `尺子分辨不出好方法与差方法：${(countRate * 100).toFixed(1)}% → ${(idfRate * 100).toFixed(1)}%`,
  );
});
