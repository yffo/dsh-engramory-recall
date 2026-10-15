/**
 * 池宽天花板尺子：候选池放宽到 N 条时，「完美提供方」最多能拿到几分？
 *
 * 为什么单独一把尺子：接缝（可选语义提供方）只在**候选池**里挑，池子里没有正确笔记时，
 * 再准的重排也只能在错的集合里排序。这把尺子量的是池内召回 —— 它不是我们的成绩，
 * 而是任何提供方（真 embedding 也好、别的排序器也好）在这份卷子上的**上界**。
 *
 *   node bench/pool-ceiling.mjs --data bench/.tmp/longmemeval_s_cleaned.json
 *   node bench/pool-ceiling.mjs --pools 5,20,50,100 --json
 *
 * 顺带量每查询要发给提供方多少东西（条数 / 片段字符数），用来估 embeddings 的代价：
 * 这部分是**离线**算的，不需要任何密钥；真延迟等有端点再量（README 里写明）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, search } from '../bm25.js';
import { sessionToDoc } from './sessions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const dataPath = opt('--data', join(here, '.tmp', 'longmemeval_s_cleaned.json'));
const limit = Number(opt('--limit', '0')) || 0;
const POOLS = (opt('--pools', '5,20,50,100')).split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const wantJson = argv.includes('--json');
const MAX = POOLS[POOLS.length - 1];

const raw = readFileSync(dataPath);
const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
const all = JSON.parse(raw.toString('utf8'));
const questions = limit ? all.slice(0, limit) : all;

const perQuestion = [];
let errors = 0;
const t0 = Date.now();
for (const [i, q] of questions.entries()) {
  const gold = new Set(q.answer_session_ids ?? []);
  if (!gold.size) { errors += 1; continue; }
  const docs = (q.haystack_sessions ?? []).map((turns, j) => sessionToDoc(q.haystack_session_ids[j], turns));
  try {
    const index = buildIndex(docs, {});
    const top = search(index, String(q.question ?? ''), MAX);
    const rank = top.findIndex((hit) => gold.has(hit.id));
    // 交给提供方的就是池子里这些片段（semantic.js 的 rerank 分支用的正是 hit.snippet）
    const sentChars = top.reduce((n, hit) => n + String(hit.snippet ?? '').length, 0);
    perQuestion.push({
      question_id: q.question_id,
      question_type: q.question_type,
      sessions: docs.length,
      goldRank: rank, // -1 = 池子（MAX 宽）里都没有
      firstGoldRank: rank < 0 ? Infinity : rank,
      sent: top.length,
      sentChars,
      ceil: Object.fromEntries(POOLS.map((n) => [n, rank >= 0 && rank < n])),
    });
  } catch (err) {
    errors += 1;
    console.error(`  ! 第 ${i + 1} 题（${q.question_id}）跑挂了：${err?.message ?? err}`);
  }
  if ((i + 1) % 100 === 0) process.stderr.write(`  已跑 ${i + 1}/${questions.length} 题（${((Date.now() - t0) / 1000).toFixed(0)}s）\n`);
}

const pctf = (x) => `${(x * 100).toFixed(1)}%`;
const share = (rows, n) => (rows.length ? rows.filter((r) => r.ceil[n]).length / rows.length : 0);
const quantile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const lines = [];
lines.push(`# 池宽天花板（LongMemEval-S，${perQuestion.length} 题，数据 sha256_12 = ${sha}）\n`);
lines.push(`窗口 top-${MAX}；「池内召回」= 至少一条 gold 落在词面前 N 名里 —— 这是任何提供方的上界。\n`);
lines.push(`| 候选池 | 池内召回（= 提供方的 hit@1 上界） |`);
lines.push(`| --- | --- |`);
for (const n of POOLS) lines.push(`| top-${n} | ${pctf(share(perQuestion, n))} |`);

const types = [...new Set(perQuestion.map((r) => r.question_type))].sort();
lines.push(`\n## 按题型（池 ${MAX}）\n`);
lines.push(`| 题型 | 题数 | ${POOLS.map((n) => `top-${n}`).join(' | ')} |`);
lines.push(`| --- | --- | ${POOLS.map(() => '---').join(' | ')} |`);
for (const type of types) {
  const rows = perQuestion.filter((r) => r.question_type === type);
  lines.push(`| ${type} | ${rows.length} | ${POOLS.map((n) => pctf(share(rows, n))).join(' | ')} |`);
}

const chars = perQuestion.map((r) => r.sentChars);
const sent = perQuestion.map((r) => r.sent);
lines.push(`\n## 每查询要发给提供方多少东西（池 ${MAX}，离线估算）\n`);
lines.push(`| 项 | 中位 | p90 | 最大 |`);
lines.push(`| --- | --- | --- | --- |`);
lines.push(`| 候选条数 | ${quantile(sent, 0.5)} | ${quantile(sent, 0.9)} | ${Math.max(...sent)} |`);
lines.push(`| 片段字符数 | ${quantile(chars, 0.5)} | ${quantile(chars, 0.9)} | ${Math.max(...chars)} |`);
lines.push(`\n按英文 ~4 字符/token 粗估：一条查询 ≈ ${Math.round(quantile(chars, 0.5) / 4)} token（中位）、${Math.round(quantile(chars, 0.9) / 4)} token（p90）；`);
lines.push(`参考文献：` + `zero-hit 的题（池里连一条 gold 都没有）= ${perQuestion.filter((r) => r.goldRank < 0).length} 题。`);

const out = lines.join('\n');
if (process.stdout.isTTY) console.log(out); else console.log(out);
if (errors) console.error(`\n⚠ ${errors} 题因数据缺字段被跳过`);
if (wantJson) {
  const file = join(here, '.pool-ceiling.json');
  writeFileSync(file, `${JSON.stringify({ when: 'bench/pool-ceiling.mjs', sha256_12: sha, questions: perQuestion.length, pools: POOLS, share: Object.fromEntries(POOLS.map((n) => [n, share(perQuestion, n)])), perType: Object.fromEntries(types.map((t) => { const rows = perQuestion.filter((r) => r.question_type === t); return [t, { n: rows.length, ...Object.fromEntries(POOLS.map((n) => [`top${n}`, share(rows, n)])) }]; })), cost: { median: quantile(chars, 0.5), p90: quantile(chars, 0.9), max: Math.max(...chars) }, zeroHit: perQuestion.filter((r) => r.goldRank < 0).length, perQuestion }, null, 2)}\n`);
  console.log(`\n（JSON 写到 bench/.pool-ceiling.json）`);
}
