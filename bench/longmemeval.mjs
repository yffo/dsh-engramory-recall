#!/usr/bin/env node
/**
 * LongMemEval-S 上的召回测速 —— 只测「检索」这一段，不测问答（问答要模型，本项目零模型调用）。
 *
 * 数据集：https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned （MIT，265MB）
 *   · 官方原版 xiaowu0162/longmemeval 已被作者标注 deprecated，cleaned 版删掉了一批
 *     「会干扰答案正确性」的噪声 session。用哪一份必须写在结果旁边，否则数字没法比。
 *   · 国内直连 huggingface.co 不通时可用镜像 hf-mirror.com（同一路径）。
 *
 * 用法：
 *   node bench/longmemeval.mjs --data /path/longmemeval_s_cleaned.json [--limit 50] [--k 5] [--json]
 *   加 --engine unigram|bigram 可换成教科书 BM25 基线（同一套数据、同一套判据）
 *
 * 口径（为了跟别人可比，必须写死，不许随手改）：
 *   · 一篇「笔记」= 一个 session（该 session 的全部轮次按顺序拼成一条正文，标题与描述留空）
 *   · 查询 = 问题原文（不含 question_date；本引擎默认不读日期，这一项如实写在结论里）
 *   · 命中判据 = gold session 出现在 top-k
 *   · RecallAny@k：top-k 里有没有**任何**一个 gold session（多 gold 题只要中一个就算）
 *   · Recall@k：gold session 被 top-k 覆盖的比例
 *   · 只用仓库里的真实引擎（import ../bm25.js），不改任何参数、不做任何针对性调参
 *   · 数据集里的 `has_answer` 字段是「哪几轮带答案」的标注，**本脚本一眼都不看** —— 看了就是作弊
 *
 * 输出：一张总表 + 按题型拆的表 + 可选 --json（含逐题结果，便于别人复核我们没挑题）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, search } from '../bm25.js';
import { createBaseline } from './baseline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const dataPath = opt('--data', join(here, '.tmp', 'longmemeval_s_cleaned.json'));
const limit = Number(opt('--limit', '0')) || 0;
const K = Number(opt('--k', '5'));
const wantJson = argv.includes('--json');
const engineArg = opt('--engine', 'ours');
const baseline = engineArg === 'ours' ? null : createBaseline(engineArg);
const engineName = baseline ? baseline.name : '本插件（dsh-engramory-recall）';

if (!existsSync(dataPath)) {
  console.error(`找不到数据集：${dataPath}`);
  console.error('下载（约 265MB）：');
  console.error('  mkdir -p bench/.tmp && curl -L -o bench/.tmp/longmemeval_s_cleaned.json \\');
  console.error('    https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json');
  process.exit(2);
}

const raw = readFileSync(dataPath);
const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
const all = JSON.parse(raw.toString('utf8'));
const questions = limit ? all.slice(0, limit) : all;

/** 一个 session → 一篇「笔记」。轮次按顺序拼，role 前缀保留（user/assistant 的用词分布不同）。 */
function sessionToDoc(sessionId, turns) {
  const lines = [];
  for (const turn of turns) {
    const role = turn?.role === 'assistant' ? 'Assistant' : 'User';
    const text = String(turn?.content ?? '').trim();
    if (text) lines.push(`${role}: ${text}`);
  }
  return { id: sessionId, title: '', description: '', body: lines.join('\n'), aliases: [], lines: [], mtimeMs: 0 };
}

const perQuestion = [];
let errors = 0;
const t0 = Date.now();

for (const [i, q] of questions.entries()) {
  const gold = new Set(q.answer_session_ids ?? []);
  if (!gold.size) { errors += 1; continue; }
  const docs = (q.haystack_sessions ?? []).map((turns, j) => sessionToDoc(q.haystack_session_ids[j], turns));
  let top = [];
  try {
    const index = baseline ? baseline.build(docs) : buildIndex(docs, {});
    top = (baseline ? baseline.search(index, String(q.question ?? ''), Math.max(K, 10)) : search(index, String(q.question ?? ''), Math.max(K, 10)));
  } catch (err) {
    errors += 1;
    console.error(`  ! 第 ${i + 1} 题（${q.question_id}）跑挂了：${err?.message ?? err}`);
    continue;
  }
  const ids = top.map((r) => r.id);
  const hitAt = (k) => ids.slice(0, k).some((id) => gold.has(id));
  const recallAtK = ids.slice(0, K).filter((id) => gold.has(id)).length / gold.size;
  const firstRank = ids.findIndex((id) => gold.has(id));
  perQuestion.push({
    question_id: q.question_id,
    question_type: q.question_type,
    sessions: docs.length,
    gold: gold.size,
    hit1: hitAt(1),
    hitK: hitAt(K),
    hit10: hitAt(10),
    recallK: recallAtK,
    rr: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
  });
  if ((i + 1) % 50 === 0) process.stderr.write(`  已跑 ${i + 1}/${questions.length} 题（${((Date.now() - t0) / 1000).toFixed(0)}s）\n`);
}

const elapsed = (Date.now() - t0) / 1000;
const pctf = (x) => `${(x * 100).toFixed(1)}%`;
const mean = (rows, key) => (rows.length ? rows.reduce((n, r) => n + r[key], 0) / rows.length : 0);

function block(rows) {
  return {
    n: rows.length,
    recallAny1: mean(rows, 'hit1'),
    recallAnyK: mean(rows, 'hitK'),
    recallAny10: mean(rows, 'hit10'),
    recallK: mean(rows, 'recallK'),
    mrr: mean(rows, 'rr'),
  };
}
const overall = block(perQuestion);

const isTty = process.stdout.isTTY;
const lines = [];
lines.push(`# LongMemEval-S 检索测速（${engineName}，k=${K}）`);
lines.push('');
lines.push(`数据集 ${dataPath.split('/').pop()} · sha256 前 12 位 \`${sha}\``);
lines.push(`题数 ${perQuestion.length}${limit ? `（--limit ${limit} 截断）` : ''} · 每题平均 ${(perQuestion.reduce((n, r) => n + r.sessions, 0) / (perQuestion.length || 1)).toFixed(1)} 个 session · 耗时 ${elapsed.toFixed(0)}s · 出错 ${errors} 题`);
lines.push('');
lines.push(`| 指标 | 全部 ${overall.n} 题 |`);
lines.push('| --- | --- |');
lines.push(`| RecallAny@1 | ${pctf(overall.recallAny1)} |`);
lines.push(`| RecallAny@${K} | ${pctf(overall.recallAnyK)} |`);
lines.push(`| Recall@${K}（gold 覆盖率） | ${pctf(overall.recallK)} |`);
lines.push(`| MRR@${K} | ${overall.mrr.toFixed(4)} |`);
lines.push(`| RecallAny@10 | ${pctf(overall.recallAny10)} |`);
lines.push('');
lines.push('| 题型 | 题数 | RecallAny@1 | RecallAny@' + K + ' | Recall@' + K + ' | MRR@' + K + ' |');
lines.push('| --- | --- | --- | --- | --- | --- |');
const types = [...new Set(perQuestion.map((r) => r.question_type))].sort();
for (const t of types) {
  const b = block(perQuestion.filter((r) => r.question_type === t));
  lines.push(`| ${t} | ${b.n} | ${pctf(b.recallAny1)} | ${pctf(b.recallAnyK)} | ${pctf(b.recallK)} | ${b.mrr.toFixed(3)} |`);
}
lines.push('');
lines.push('口径见文件头：一篇「笔记」= 一个 session，查询 = 问题原文（不读 question_date），命中 = gold session 进 top-k。');
lines.push(`本引擎默认不读日期，所以 \`temporal-reasoning\` 这一类只靠词面匹配 —— 它的分数不代表「时间推理」被解决了。`);
lines.push('');
const out = lines.join('\n');
if (isTty) console.log(out);
else process.stdout.write(`${out}\n`);

if (wantJson) {
  mkdirSync(join(here, '.tmp'), { recursive: true });
  const file = join(here, '.tmp', 'longmemeval-result.json');
  writeFileSync(file, `${JSON.stringify({
    数据集: { file: dataPath.split('/').pop(), sha256_12: sha, limit: limit || null, k: K },
    总表: overall,
    分题型: Object.fromEntries(types.map((t) => [t, block(perQuestion.filter((r) => r.question_type === t))])),
    逐题: perQuestion,
  }, null, 2)}\n`);
  console.error(`逐题结果写到 ${file}`);
}

if (errors > perQuestion.length * 0.1) process.exit(1);
