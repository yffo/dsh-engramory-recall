#!/usr/bin/env node
/**
 * 召回质量探针 —— 在**真实记忆库**上量三件事：
 *
 *   口径：22 条中文口语 query → 应该命中的那篇。这是「人怎么问」的正脸。
 *   对照 A：把笔记文件名当查询。英文词项为主，是分词器的压力测试。
 *   对照 B：把笔记中文标题当查询。这是「几乎必然 top-1」的底线。
 *
 * 为什么要有这个文件：`bm25.js` 里的 EXTRA_WEIGHT（同义桥权重）和 SYNONYMS（同义表）
 * 都是**语料统计量撑起来的经验值**，在小 fixture 里测不出来 —— 试过写单测，0.5 和 0.8
 * 都绿，是个假测试。所以证据留在这里：改这两个东西之前先跑它，掉分就回退。
 *
 * ★ 为什么每行输出都带一个「语料指纹」：
 * 探针跑的是**真实记忆库**，而记忆库每天都在变（写一篇笔记、归档一次、改一行措辞）。
 * 这就意味着「今天 20/21、昨天 21/21」这种比较**根本无效** —— 分掉了，不是因为代码退步，
 * 而是因为卷子换了。这个坑真实踩过两次：一次是把自己写的调优笔记（里面逐字抄了探针的
 * query）变成第一名，把真目标挤下去；一次是在同义表还没补全时量了个权重差，于是改错了
 * 参数，等补完再量才发现两个权重一模一样。
 *
 * 所以分数必须**和指纹一起读**：指纹相同 → 分数可比；指纹不同 → 只能看个大概，
 * 要对齐就得先把库回溯到同一状态。`--save` 存基线，之后每次跑都会自动比对。
 *
 * 用法：
 *   node scripts/recall-probe.mjs                       # 默认读 ~/memory/engramory
 *   node scripts/recall-probe.mjs /path/to/store        # 指定库
 *   node scripts/recall-probe.mjs --pairs               # 只跑口径，不出对照（看细节用）
 *   node scripts/recall-probe.mjs --save                # 把这次结果存成基线
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusFingerprint, readDocs } from '../store.js';
import { ALIAS_PAIRS, BRIDGE_PAIRS, PAIRS } from './probe-queries.mjs';
import { SYNONYMS, buildIndex, search, tokenize as bm25Tokenize } from '../bm25.js';

const args = process.argv.slice(2);
const onlyPairs = args.includes('--pairs');
const saveBaseline = args.includes('--save');
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '.probe-baseline.json');
const storePath = args.find((a) => !a.startsWith('--')) ?? `${process.env.HOME}/memory/engramory`;

const docs = readDocs(storePath);
if (!docs.length) {
  console.error(`读不到笔记：${storePath}`);
  process.exit(1);
}
const idx = buildIndex(docs);
const rank = (q, want) => search(idx, q, 4).map((h) => h.id.replace(/\.md$/, '')).indexOf(want);

const FP = corpusFingerprint(docs);
const NOTE_COUNT = new Set(docs.map((d) => d.id)).size;
console.log(`库：${storePath}`);
console.log(`语料：${NOTE_COUNT} 篇 / ${docs.length} 个 chunk | 指纹 ${FP}\n`);

let miss = 0;
for (const [q, want] of PAIRS) {
  const r = rank(q, want);
  if (r < 0) miss += 1;
  const mark = r < 0 ? '❌' : r === 0 ? '✅' : `⚠️${r + 1}`;
  const tail = r < 0 ? `  | 实际: ${search(idx, q, 3).map((h) => h.id.replace(/\.md$/, '')).join(', ')}` : '';
  console.log(`${mark} ${q.padEnd(20)} → ${want.replace(/^(reference|project|feedback)-/, '')}${tail}`);
}
console.log(`\n口径 recall@4：${PAIRS.length - miss}/${PAIRS.length}`);

let bridgeMiss = 0;
for (const [q, want] of BRIDGE_PAIRS) {
  const r = rank(q, want);
  if (r < 0) bridgeMiss += 1;
  const mark = r < 0 ? '❌' : r === 0 ? '✅' : `⚠️${r + 1}`;
  const tail = r < 0 ? `  | 实际: ${search(idx, q, 3).map((h) => h.id.replace(/\.md$/, '')).join(', ')}` : '';
  console.log(`${mark} ${q.padEnd(20)} → ${want.replace(/^(reference|project|feedback)-/, '')}${tail}`);
}
console.log(`\n桥探针 recall@4：${BRIDGE_PAIRS.length - bridgeMiss}/${BRIDGE_PAIRS.length}`);

let aliasMiss = 0;
for (const [q, want] of ALIAS_PAIRS) {
  const r = rank(q, want);
  if (r < 0) aliasMiss += 1;
  const mark = r < 0 ? '❌' : r === 0 ? '✅' : `⚠️${r + 1}`;
  const tail = r < 0 ? `  | 实际: ${search(idx, q, 3).map((h) => h.id.replace(/\.md$/, '')).join(', ')}` : '';
  console.log(`${mark} ${q.padEnd(20)} → ${want.replace(/^(reference|project|feedback)-/, '')}${tail}`);
}
console.log(`\n别名探针 recall@4：${ALIAS_PAIRS.length - aliasMiss}/${ALIAS_PAIRS.length}`);

// ── 死桥自检 ──────────────────────────────────────────────────────
// 同义桥的每一项都要**在语料里真的存在**才有分。指向一个库里根本没有的词，效果是
// 「写了等于没写」—— 而且不报错、不降级，最安静的那种失效。所以每次跑探针都数一遍。
{
  const df = new Map();
  for (const d of idx.docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const dead = [];
  let total = 0;
  for (const [key, values] of SYNONYMS) {
    for (const v of values) {
      total += 1;
      // 同义值会先过 tokenize 再用，所以判断的粒度是词项而不是原始字符串。
      for (const term of bm25Tokenize(v)) if (!df.has(term)) dead.push(`${key} → ${v}`);
    }
  }
  const uniq = [...new Set(dead)];
  console.log(`\n死桥自检：${total} 个同义值，指向库里不存在的 ${uniq.length} 个（不影响正确性，只是白写）`);
  for (const d of uniq.slice(0, 12)) console.log(`  · ${d}`);
  if (uniq.length > 12) console.log(`  …另有 ${uniq.length - 12} 个`);
}

if (!onlyPairs) {
  const score = (queries) => {
    let top1 = 0; let in4 = 0;
    for (const [q, want] of queries) {
      const r = rank(q, want);
      if (r === 0) top1 += 1;
      if (r >= 0) in4 += 1;
    }
    return { top1, in4, n: queries.length };
  };
  const byName = docs.map((d) => [d.id.replace(/\.md$/, ''), d.id.replace(/\.md$/, '')]);
  const byTitle = docs
    .filter((d) => /[\u4e00-\u9fff]/.test(String(d.title)))
    .map((d) => [String(d.title).replace(/^[#\s]+/, '').slice(0, 30), d.id.replace(/\.md$/, '')]);
  /**
   * 对照 C：把「正文里最有辨识度的词」当查询。
   *
   * 为什么非要有这一组：对照 A 与对照 B **都拿标题当查询**，所以它们对 `TITLE_EXTRA`
   * （标题里的词多计几遍）是**结构性偏袒**的 —— 抬高标题权重几乎必然让这两组变好，
   * 那不是证据，是同义反复。能中立评价标题权重的，只有「查询词出自正文」这种情形：
   * 此时抬高标题权重只会让标题里恰好有这个词的**别的**笔记平白加分、把正确答案挤下去。
   *
   * 取法：每篇正文词表里挑 df 最低、且**不在任何标题/描述里**的词（df ≤ 3）。
   * 中文双字碎片不收（它们在中文里天然泛滥，拿来做 query 只会测出分词器的噪声）。
   */
  const byBody = (() => {
    const df = new Map();
    for (const d of idx.docs) for (const t of new Set(d.tf.keys())) df.set(t, (df.get(t) ?? 0) + 1);
    // 全库标题词：query 词必须**任何**标题里都没有，才算真正「只靠正文才认得出来」
    const allHeadTerms = new Set(
      bm25Tokenize(idx.docs.map((d) => [d.title, d.description].filter(Boolean).join('\n')).join('\n')),
    );
    const seen = new Set();
    const out = [];
    for (const d of idx.docs) {
      let best = null;
      for (const t of d.tf.keys()) {
        if (allHeadTerms.has(t)) continue;
        if (t.length < 4) continue;
        if (!/[a-z]/i.test(t)) continue;
        const n = df.get(t) ?? 99;
        if (n > 3) continue;
        if (!best || n < best.n || (n === best.n && t.length > best.t.length)) best = { t, n };
      }
      if (!best) continue;
      const key = `${best.t}\u0000${d.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([best.t, d.id.replace(/\.md$/, '')]);
    }
    return out;
  })();

  const a = score(byName); const b = score(byTitle); const c = score(byBody);
  console.log(`对照 A（文件名当查询）  top1 ${a.top1}/${a.n} | recall@4 ${a.in4}/${a.n}`);
  console.log(`对照 B（中文标题当查询）top1 ${b.top1}/${b.n} | recall@4 ${b.in4}/${b.n}`);
  console.log(`对照 C（正文独有词当查询）top1 ${c.top1}/${c.n} | recall@4 ${c.in4}/${c.n}`);
  console.log('\n对照只是「别掉分」的底线；口径才是要提的那个数。');
  console.log('对照 A/B 都拿标题当查询，对标题权重是**结构性偏袒**的 —— 它们既不能当目标，');
  console.log('也不能当「抬高标题权重是安全的」这个结论的证据（它们测不出这件事）。');
  console.log('评价 TITLE_EXTRA 只看对照 C（正文独有词当查询）。');

  const result = {
    fingerprint: FP,
    notes: NOTE_COUNT,
    chunks: docs.length,
    pairs: `${PAIRS.length - miss}/${PAIRS.length}`,
    bridge: `${BRIDGE_PAIRS.length - bridgeMiss}/${BRIDGE_PAIRS.length}`,
    alias: `${ALIAS_PAIRS.length - aliasMiss}/${ALIAS_PAIRS.length}`,
    controlA: `${a.top1}/${a.n} top1, ${a.in4}/${a.n} recall@4`,
    controlB: `${b.top1}/${b.n} top1, ${b.in4}/${b.n} recall@4`,
    controlC: `${c.top1}/${c.n} top1, ${c.in4}/${c.n} recall@4`,
    at: new Date().toISOString(),
  };

  if (saveBaseline) {
    writeFileSync(BASELINE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`\n已存基线 → ${BASELINE}`);
  } else if (existsSync(BASELINE)) {
    let base = null;
    try { base = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { /* 基线坏了就当没有 */ }
    if (base) {
      if (base.fingerprint === FP) {
        const same = base.pairs === result.pairs && base.bridge === result.bridge && base.alias === result.alias
          && base.controlA === result.controlA && base.controlB === result.controlB
          && (base.controlC ?? result.controlC) === result.controlC;
        console.log(same ? '\n对比基线：指纹相同、三项数字全等 —— 这次改动没有影响召回。'
          : `\n对比基线：指纹相同、数字有变 —— 这才是一次可信的 A/B。\n  口径 ${base.pairs} → ${result.pairs} | 桥探针 ${base.bridge} → ${result.bridge} | 别名 ${base.alias} → ${result.alias} | 对照A ${base.controlA} → ${result.controlA} | 对照B ${base.controlB} → ${result.controlB} | 对照C ${base.controlC ?? '—'} → ${result.controlC}`);
      } else {
        // 这条警告是本文件存在的主要理由之一：库变了，分数就没法直接比。
        console.log(`\n⚠️ 语料变了（指纹 ${base.fingerprint} → ${FP}，${base.notes}篇/${base.chunks}chunk → ${NOTE_COUNT}篇/${docs.length}chunk）。`);
        console.log(`  上次：口径 ${base.pairs} | 桥探针 ${base.bridge ?? '—'} | 别名 ${base.alias ?? '—'} | 对照A ${base.controlA} | 对照B ${base.controlB} | 对照C ${base.controlC ?? '—'}`);
        console.log('  分数**不可直接比较** —— 掉分可能是库变了，不是代码退步。要对齐请先回溯语料，或 --save 重设基线。');
      }
    }
  }
}
