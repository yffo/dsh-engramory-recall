/**
 * 召回基准（地基句口径）：量「模型到底看没看见那句话」。
 *
 * 用法：
 *   npm run bench:foundation              # 打印 markdown 报告
 *   node bench/foundation.mjs --check     # 额外比对 bench/foundation-expectations.json（CI 用）
 *   node bench/foundation.mjs --json      # 额外写 bench/.foundation-result.json
 *   node bench/foundation.mjs --mode=count --snippet-chars=64   # 复现旧行为（对照用）
 *   node bench/foundation.mjs --store ~/memory/engramory        # 真实记忆库上出题（数据本机）
 *
 * 三条口径（别在优化里弄丢）：
 *   1. **跑真实代码路径**：召回走 `bm25.js` 的 `search()`，注入文本走 `render.js` 的
 *      `renderPointers()` —— 与插件 pre-step 钩子用的是同一个函数，本文件不重写渲染。
 *   2. **保地基 = 逐字保住**：注入行里必须**逐字包含**那句话（空白归一后比较）。
 *      宽松口径（罕见词还在）只当诊断，不当结论 —— 灵枢的公开数字也是逐字口径。
 *   3. **调参与汇报分开**：`heldOut` 那半只用来汇报，调参只看 `tune` 那半。
 *
 * 退出码：`--check` 时任何一项偏离 expectations.json 超过容差即 1（防的是悄悄漂走）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, search, tokenize } from '../bm25.js';
import { renderPointers } from '../render.js';
import { buildFoundationSet } from './foundation-corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const MODE = flag('mode', null); // null = 引擎默认（改进后的做法）
const SNIPPET_CHARS = Number(flag('snippet-chars', 0)) || 0;
const NO_NEIGHBOR = has('no-neighbor');
const PLAN = has('no-plan') ? false : undefined;
const STORE = flag('store', '');

/** 两套真实配置：插件默认档，以及杨总 profile 里那一档（预算更宽）。 */
const SETTINGS = [
  { label: '默认 480 字 / 4 条', maxChars: 480, maxPointers: 4 },
  { label: 'profile 600 字 / 5 条', maxChars: 600, maxPointers: 5 },
];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 逐字判定：注入行里有没有那句话。 */
const keepsSentence = (line, sentence) => {
  if (!line) return false;
  const hay = norm(line);
  const needle = norm(sentence);
  return needle.length > 0 && hay.includes(needle);
};

/** 宽松判定：罕见词还在（句子被截断时用它判断「至少没丢关键线索」）。 */
const keepsEvidence = (line, evidence) => {
  if (!line) return false;
  const hay = norm(line);
  return evidence.every((term) => hay.includes(term));
};

function searchOptions() {
  const options = {};
  if (MODE) options.snippet = MODE;
  if (NO_NEIGHBOR) options.neighbor = false;
  return options;
}

function renderOptions(settings) {
  const options = { maxChars: settings.maxChars };
  if (SNIPPET_CHARS) options.snippetChars = SNIPPET_CHARS;
  if (PLAN === false) options.snippetPlan = new Array(settings.maxPointers).fill(SNIPPET_CHARS || 64);
  return options;
}

/**
 * 跑一个配置：返回总体 + 分组指标。
 * @param {{docs: object[], questions: object[]}} set
 */
function evaluate(set, settings) {
  const index = buildIndex(set.docs);
  const rows = [];
  const started = process.hrtime.bigint();
  for (const question of set.questions) {
    const hits = search(index, question.q, settings.maxPointers, searchOptions());
    const rendered = renderPointers(hits, renderOptions(settings));
    const rank = hits.findIndex((h) => h.id === question.gold);
    const entry = rendered.shown.find((h) => h.id === question.gold);
    const line = entry?.line ?? null;
    rows.push({
      question,
      rank,
      hit1: rank === 0,
      hitK: rank >= 0,
      injected: Boolean(entry) && entry.collapsed !== true,
      collapsed: entry?.collapsed === true,
      strict: keepsSentence(line, question.foundation),
      lenient: keepsEvidence(line, question.evidence),
      lineChars: line ? line.length : 0,
      used: rendered.used,
      budget: rendered.budget,
      // 「找对了但没让它看见」——这一格的差值就是本期要收掉的差距。
      foundButLost: rank >= 0 && !keepsSentence(line, question.foundation),
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const rate = (rows, key) => (rows.length ? rows.filter((r) => r[key]).length / rows.length : 0);
  const agg = (list) => ({
    n: list.length,
    hit1: rate(list, 'hit1'),
    hitK: rate(list, 'hitK'),
    strict: rate(list, 'strict'),
    lenient: rate(list, 'lenient'),
    foundButLost: rate(list, 'foundButLost'),
    avgLineChars: list.length ? list.reduce((s, r) => s + r.lineChars, 0) / list.length : 0,
    avgUsed: list.length ? list.reduce((s, r) => s + r.used, 0) / list.length : 0,
  });
  const by = (key) => {
    const groups = new Map();
    for (const row of rows) {
      const value = row.question[key];
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(row);
    }
    return [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([value, list]) => [value, agg(list)]);
  };
  return {
    settings,
    elapsedMs,
    overall: agg(rows),
    tune: agg(rows.filter((r) => !r.question.heldOut)),
    heldOut: agg(rows.filter((r) => r.question.heldOut)),
    byGroup: by('group'),
    byShape: by('shape'),
  };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function printReport(label, result, meta) {
  const o = result.overall;
  console.log(`\n## ${label}`);
  console.log(`题集：${meta.notes} 篇笔记 / ${meta.questions} 题（tune ${meta.tune}，heldOut ${meta.heldOut}）· 耗时 ${result.elapsedMs.toFixed(0)}ms`);
  console.log('');
  console.log('| 指标 | 全部 | tune | heldOut |');
  console.log('| --- | --- | --- | --- |');
  console.log(`| 找对笔记 hit@1 | ${pct(o.hit1)} | ${pct(result.tune.hit1)} | ${pct(result.heldOut.hit1)} |`);
  console.log(`| 找对笔记 hit@K | ${pct(o.hitK)} | ${pct(result.tune.hitK)} | ${pct(result.heldOut.hitK)} |`);
  console.log(`| **保地基（逐字）** | **${pct(o.strict)}** | **${pct(result.tune.strict)}** | **${pct(result.heldOut.strict)}** |`);
  console.log(`| 罕见词还在（宽松） | ${pct(o.lenient)} | ${pct(result.tune.lenient)} | ${pct(result.heldOut.lenient)} |`);
  console.log(`| 找对了却丢掉地基句 | ${pct(o.foundButLost)} | ${pct(result.tune.foundButLost)} | ${pct(result.heldOut.foundButLost)} |`);
  console.log(`| 平均注入行字符 | ${o.avgLineChars.toFixed(1)} | — | — |`);
  console.log(`| 平均用掉预算 | ${o.avgUsed.toFixed(0)} 字 | — | — |`);
  console.log('');
  console.log('| 分组 | n | hit@1 | 保地基 | 宽松 | 找对却丢 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const [group, a] of result.byGroup) {
    console.log(`| ${group} | ${a.n} | ${pct(a.hit1)} | ${pct(a.strict)} | ${pct(a.lenient)} | ${pct(a.foundButLost)} |`);
  }
  console.log('');
  console.log('| 查询形态 | n | hit@1 | 保地基 | 宽松 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [shape, a] of result.byShape) {
    console.log(`| ${shape} | ${a.n} | ${pct(a.hit1)} | ${pct(a.strict)} | ${pct(a.lenient)} |`);
  }
}

/** 真实库模式：拿真笔记里的真句子出题（数据不出本机，数字只当本地对照）。 */
async function buildStoreSet(storePath) {
  const { readDocs } = await import('../store.js');
  const docs = readDocs(storePath).map((doc) => ({
    id: doc.id ?? doc.file,
    title: doc.title ?? '',
    description: doc.description ?? '',
    body: doc.body ?? '',
    aliases: doc.aliases ?? [],
    mtimeMs: doc.mtimeMs ?? 0,
  }));
  const index = buildIndex(docs);
  // 词项在库里的文档频率：df 越小越罕见。
  const df = new Map();
  for (const doc of index.docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const questions = [];
  for (const doc of docs) {
    const sentences = String(doc.body ?? doc.description ?? '')
      .split(/(?<=[。！？!?\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 24 && s.length <= 90);
    for (const sentence of sentences) {
      // 罕见词要按**引擎自己的切词口径**找（中文是相邻双字、英文整词），否则「整句当一个词」
      // 这种伪罕见词拼出来的查询根本匹配不上任何东西，量出来的是尺子自己的毛病。
      const rare = [...new Set(tokenize(sentence))]
        .filter((term) => (df.get(term) ?? 0) === 1 && term.length >= 2)
        .sort((a, b) => b.length - a.length)[0];
      if (!rare) continue;
      questions.push({
        id: `sq-${questions.length}`,
        q: `${doc.title || doc.id} ${rare}`,
        gold: doc.id,
        foundation: sentence,
        evidence: [rare],
        shape: 'store',
        group: 'store',
        heldOut: questions.length % 3 === 0,
      });
      break; // 一篇笔记一题，避免同一篇刷分
    }
  }
  return { docs, questions, meta: { seed: 0, notes: docs.length, questions: questions.length, tune: 0, heldOut: 0 } };
}

async function main() {
  const wantJson = has('json');
  const wantCheck = has('check');
  let set;
  let label = '合成题集（地基句口径）';
  if (STORE) {
    set = await buildStoreSet(STORE);
    label = `真实库题集：${STORE}（${set.meta.notes} 篇 / ${set.meta.questions} 题，数据不出本机）`;
  } else {
    set = buildFoundationSet();
  }
  const results = [];
  for (const settings of SETTINGS) {
    const result = evaluate(set, settings);
    results.push(result);
    printReport(`${label} · ${settings.label}`, result, set.meta);
  }
  const modeLine = [
    `mode=${MODE ?? 'default'}`,
    SNIPPET_CHARS ? `snippet-chars=${SNIPPET_CHARS}` : 'snippet-chars=plan',
    NO_NEIGHBOR ? 'neighbor=off' : 'neighbor=on',
  ].join(' · ');
  console.log(`\n口径：${modeLine}${STORE ? ' · store' : ''}`);

  if (wantJson) {
    mkdirSync(here, { recursive: true });
    const out = { mode: modeLine, meta: set.meta, results };
    writeFileSync(join(here, '.foundation-result.json'), `${JSON.stringify(out, null, 2)}\n`);
  }
  if (wantCheck) {
    const expectPath = join(here, 'foundation-expectations.json');
    const expectations = JSON.parse(readFileSync(expectPath, 'utf8'));
    const tolerance = expectations.tolerance ?? 0.02;
    const problems = [];
    for (let i = 0; i < expectations.settings.length; i += 1) {
      const want = expectations.settings[i];
      const got = results[i];
      if (!got) {
        problems.push(`缺少配置 ${want.label} 的结果`);
        continue;
      }
      for (const metric of Object.keys(want.metrics)) {
        const floor = want.metrics[metric];
        const value = got.overall[metric];
        if (value + tolerance < floor) problems.push(`${want.label} · ${metric}: ${value.toFixed(4)} < 期望 ${floor}（容差 ${tolerance}）`);
      }
    }
    // 同样的地板也要压住「留出组」——防的是拿 tune 组把数字调到刚好过线。
    for (let i = 0; i < expectations.settings.length; i += 1) {
      const want = expectations.settings[i];
      const got = results[i];
      if (!got || !want.heldOut) continue;
      for (const metric of Object.keys(want.heldOut)) {
        const value = got.heldOut[metric];
        const floor = want.heldOut[metric];
        if (value + tolerance < floor) problems.push(`${want.label} · heldOut.${metric}: ${value.toFixed(4)} < 期望 ${floor}`);
      }
    }
    if (problems.length) {
      console.error(`\n对账失败（${problems.length} 项）：`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log('\n对账通过：所有指标都在期望地板之上。');
  }
}

await main();
