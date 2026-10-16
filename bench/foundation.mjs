/**
 * 召回基准（地基句口径）：量「模型到底看没看见那句话」。
 *
 * 用法：
 *   npm run bench:foundation              # 打印 markdown 报告
 *   node bench/foundation.mjs --check     # 额外比对 bench/foundation-expectations.json（CI 用）
 *   node bench/foundation.mjs --json      # 额外写 bench/.foundation-result.json
 *   node bench/foundation.mjs --mode=count --snippet-chars=64   # 复现旧行为（对照用）
 *   node bench/foundation.mjs --store ~/memory/engramory        # 真实记忆库上出题（数据本机）
 *   node bench/foundation.mjs --replay --store ~/memory/engramory  # 重放真实账本（数据本机）
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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, search, tokenize } from '../bm25.js';
import { USAGE_FILE } from '../usage.js';
import { clip, renderPointers } from '../render.js';
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
const NEIGHBOR = has('neighbor');
const PLAN = has('no-plan') ? false : undefined;
const STORE = flag('store', '');
// 账本重放：拿真实历史轮次问「今天我们这条还答不答得出来」。账本默认在库里。
const REPLAY = has('replay');
const LEDGER = flag('ledger', '');

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
  options.neighbor = NEIGHBOR && !NO_NEIGHBOR;
  return options;
}

function renderOptions(settings) {
  const options = { maxChars: settings.maxChars };
  // `--snippet-chars=N` 就是「平均额度 N 字」：给出等额计划，别让它被名次加权计划盖掉。
  if (SNIPPET_CHARS) options.snippetPlan = new Array(settings.maxPointers).fill(SNIPPET_CHARS);
  else if (PLAN === false) options.snippetPlan = new Array(settings.maxPointers).fill(64);
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


/** 词的文档频率：df 越小越罕见（重放里用来挑「决定性的一句」）。 */
function documentFrequency(index) {
  const df = new Map();
  for (const doc of index.docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  return df;
}

/**
 * 账本重放：真实历史里「被真正打开过」的那些笔记，用今天的管线还答不答得出来。
 *
 * 为什么要它：合成题集是我们自己出的题，真实库题集是「拿笔记里的句子反推一个问题」——
 * 两者都答不了「当时真发生过的那一轮，今天会怎样」。账本里有真实的问题、真实的命中、
 * 以及**后来真的被 read 打开过的那一条**：这是唯一一条不靠我们出题的证据链。
 * 归因口径跟 usage.js 的 `pickInjected()` 一致：一次打开算在它之前最近一次注入了它的那轮头上。
 */
async function runReplay(storePath, ledgerPath, settings) {
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
  const df = documentFrequency(index);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const rows = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  const injections = rows.filter((row) => row.kind === 'hit' && row.query && Array.isArray(row.ids));
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind !== 'opened' && row.kind !== 'used') continue;
    if (!row.id || row.id === 'MEMORY.md') continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const round = rows[j];
      if (round.kind !== 'hit' || !round.query || !Array.isArray(round.ids)) continue;
      if (!round.ids.includes(row.id)) continue;
      pairs.push({
        at: row.ts,
        via: row.via ?? 'read',
        query: round.query,
        openedId: row.id,
        rankThen: round.ids.indexOf(row.id),
        lagMs: Number.isFinite(row.lagMs) ? row.lagMs : row.ts - round.ts,
      });
      break;
    }
  }

  const results = [];
  for (const pair of pairs) {
    const doc = byId.get(pair.openedId);
    if (!doc) continue;
    const hits = search(index, pair.query, settings.maxPointers, searchOptions());
    const rendered = renderPointers(hits, renderOptions(settings));
    const entry = rendered.shown.find((hit) => hit.id === pair.openedId);
    results.push({
      ...pair,
      rankNow: hits.findIndex((hit) => hit.id === pair.openedId),
      shown: Boolean(entry) && entry.collapsed !== true,
      collapsed: entry?.collapsed === true,
      line: entry?.line ?? '',
    });
  }
  const spanHours = rows.length ? (rows[rows.length - 1].ts - rows[0].ts) / 3.6e6 : 0;
  const rate = (key) => (results.length ? results.filter((row) => row[key]).length / results.length : 0);
  const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
  const summary = {
    rows: rows.length,
    injections: injections.length,
    opened: rows.filter((row) => row.kind === 'opened' || row.kind === 'used').length,
    pairs: results.length,
    spanHours,
    stillShown: rate('shown'),
    collapsed: rate('collapsed'),
    coverage: median(results.map((row) => row.coverage)),
    lost: results.length ? results.filter((row) => !row.shown && !row.collapsed).length / results.length : 0,
    medianLagHours: median(results.map((row) => row.lagMs)) / 3.6e6,
  };
  console.log(`\n## 账本重放（真实历史） · ${settings.label}`);
  console.log(`账本：${ledgerPath}`);
  console.log(`共 ${summary.rows} 行（${summary.injections} 轮真注入 / ${summary.opened} 次打开事件）· 跨度 ${spanHours.toFixed(1)} 小时`);
  // 两个必须一起读的前提：① 账本里存的是**截断到 160 字**的 query，当时那一轮用的是完整消息
  // → 这一档是下界；② 期间记忆库本身也在长（新笔记会把旧名次挤下去）→ 生存性不等于引擎好坏。
  console.log('前提：账本只存了截断到 160 字的 query（原轮用完整消息）→ 生存性是下界；期间库里也添了新笔记。');
  console.log(`可判定的「被打开过」条目：${summary.pairs} 条（打开距注入中位 ${summary.medianLagHours.toFixed(1)} 小时）`);
  console.log('');
  console.log('| 被真正打开过的那条… | 值 |');
  console.log('| --- | --- |');
  console.log(`| 今天还会被注入 | ${pct(summary.stillShown)} |`);
  console.log(`| 今天只给了文件名（被缩掉） | ${pct(summary.collapsed)} |`);
  console.log(`| 今天连名字都没给（被预算挡掉） | ${pct(summary.lost)} |`);
  // 抽三条注入行原文出来给人看：数字能骗人，原文不能。
  // （真实中文笔记里「线索进没进去」没法用字面重合算 —— 查询与正文常常不同词，
  //   量出来大半是 0，那是尺子的毛病；这一项交给合成题集与真实库题集去量。）
  const samples = results.filter((row) => row.shown).slice(0, 3);
  if (samples.length) {
    console.log('');
    console.log('抽样（今天真会注入的原文，自己看像不像话）：');
    for (const row of samples) {
      console.log(`- 那轮问的是「${String(row.query).slice(0, 40)}」→ 今天给的是：${row.line.slice(0, 150)}`);
    }
  }
  return summary;
}

async function main() {
  const wantJson = has('json');
  const wantCheck = has('check');
  if (REPLAY) {
    const store = STORE || join(homedir(), 'memory', 'engramory');
    const ledger = LEDGER || join(store, USAGE_FILE);
    for (const settings of SETTINGS) await runReplay(store, ledger, settings);
    return;
  }
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
    NO_NEIGHBOR || !NEIGHBOR ? 'neighbor=off' : 'neighbor=on',
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
