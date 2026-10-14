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
import { SYNONYMS, buildIndex, search, tokenize as bm25Tokenize } from '../bm25.js';

const args = process.argv.slice(2);
const onlyPairs = args.includes('--pairs');
const saveBaseline = args.includes('--save');
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '.probe-baseline.json');
const storePath = args.find((a) => !a.startsWith('--')) ?? `${process.env.HOME}/memory/engramory`;

/** 口语 query → 期望命中的笔记 id（不含 .md）。加配对时请用真实说法，别写书面语。 */
const PAIRS = [
  ['飞书又连不上了', 'reference-feishu-getaddrinfo-enotfound'],
  ['代码拉下来是空的，装依赖就报错', 'reference-npm-ci-enoent-empty-clone'],
  ['数据库地址写在配置里就报错', 'reference-prisma-7-schema-url'],
  ['图片生成突然用不了了', 'reference-minimaxi-dns-hijack'],
  ['截图说没有权限', 'reference-peekaboo-tcc-permission'],
  ['报表页变成一堆原始数据了', 'reference-zod-validation-report-degradation'],
  ['编辑器一刷新就崩', 'reference-next-blocknote-ssr-and-build-traps'],
  ['浏览器起不来', 'reference-browser-harness-chrome-instance'],
  ['填表单的时候内容重复了两遍', 'reference-browser-harness-fill-input-duplicate'],
  ['浏览器任务报会话冲突', 'reference-browser-use-session-conflict'],
  ['换个库去调模型就失败了', 'reference-chatopenailike-deepseek-incompatible'],
  ['命令行工具报 fetch 没有定义', 'reference-mmx-cli-fetch-undefined'],
  ['ppt 传上去样式全没了', 'reference-html-ppt-inline-assets'],
  ['记忆库怎么体检', 'reference-engramory-doctor'],
  ['原生模块编译不过', 'reference-better-sqlite3-node-version'],
  ['线上服务全挂了，报 502', 'reference-yffto-pm2-502-recovery'],
  ['密钥被我提交到仓库里了', 'reference-secret-hygiene-in-repo'],
  ['登录完又跳回登录页', 'reference-next-prefetch-auth-redirect-cache'],
  ['本地跑得好好的，上线就不行', 'reference-local-and-production-environment'],
  ['视频生成跑不动', 'project-local-comfyui-video'],
  ['选品那个能不能自动做', 'project-1688-sourcing-automation'],
];

/**
 * 桥探针：专压**同义表**的十条 —— 故意用大白话去问那些笔记里全是英文/术语的东西。
 *
 * 为什么单列一组而不混进口径：同义表的手写桥是「中文口语 → 本库实际用词」的映射，
 * 它有没有用，只有用大白话问才看得出来。混进口径会被稀释成一个看不出因果的平均分。
 * 加桥时优先让这一组涨；如果某条桥在这组里没有任何一条 query 用到它，那它就是猜测，
 * 应该删掉 —— 一张没人走的桥不值得维护。
 */
const BRIDGE_PAIRS = [
  ['梯子又抽风了', 'reference-yffto-us-proxy-node'],
  ['那个旧系统怎么删干净', 'reference-openclaw-removal-playbook'],
  ['证书快到期了', 'reference-acme-webroot-behind-1panel-openresty'],
  ['分享图是怎么生成的', 'reference-selfhosted-og-image-satori'],
  ['选品那套怎么做的', 'project-1688-sourcing-automation'],
  ['沙箱里为什么写不了文件', 'reference-dsh-sandbox-memory-write-path'],
  ['工作区怎么交接', 'reference-workspace-and-handoff'],
  ['服务挂了怎么自己起来', 'reference-yffto-pm2-502-recovery'],
  ['旧系统卸载之后还有残留', 'reference-memmy-removal-playbook'],
  ['知识库怎么把质量守住', 'reference-kb-entry-quality-gate'],
];

/**
 * 别名探针：专压**笔记自己声明的 `aliases:`**（frontmatter，计两遍权重）。
 * 这几条 query 里的关键词在全局同义桥里**一个都没有**，所以只有别名能救它们 ——
 * 这样才测得出别名这个机制到底有没有在工作，而不是被别的机制顺手救了。
 *
 * ★ 已知取舍（实测数字，不藏）：`reference-selfhosted-og-image-satori.md` 的别名里有「社交卡片」，
 * 而「卡片」是个通用词 —— 带着它：别名探针 5/5、对照 B 135；删掉它：别名探针 4/5、对照 B 136。
 * **这个换法是有意选的**，不是没发现：前者是人真会那么问的话，后者是把我自己归档时写的长
 * 标题截 30 字当 query，属于合成出来的口味。如果你更看重对照 B，删掉那个别名即可。
 */
const ALIAS_PAIRS = [
  ['社交卡片是怎么生成的', 'reference-selfhosted-og-image-satori'],
  ['老记忆系统怎么迁走的', 'reference-memmy-removal-playbook'],
  ['换会话的时候怎么交接', 'reference-workspace-and-handoff'],
  ['网站打不开是不是进程挂了', 'reference-yffto-pm2-502-recovery'],
  ['旧系统卸载之后还有残留', 'reference-memmy-removal-playbook'],
];

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
  const a = score(byName); const b = score(byTitle);
  console.log(`对照 A（文件名当查询）  top1 ${a.top1}/${a.n} | recall@4 ${a.in4}/${a.n}`);
  console.log(`对照 B（中文标题当查询）top1 ${b.top1}/${b.n} | recall@4 ${b.in4}/${b.n}`);
  console.log('\n对照只是「别掉分」的底线；口径才是要提的那个数。');

  const result = {
    fingerprint: FP,
    notes: NOTE_COUNT,
    chunks: docs.length,
    pairs: `${PAIRS.length - miss}/${PAIRS.length}`,
    bridge: `${BRIDGE_PAIRS.length - bridgeMiss}/${BRIDGE_PAIRS.length}`,
    alias: `${ALIAS_PAIRS.length - aliasMiss}/${ALIAS_PAIRS.length}`,
    controlA: `${a.top1}/${a.n} top1, ${a.in4}/${a.n} recall@4`,
    controlB: `${b.top1}/${b.n} top1, ${b.in4}/${b.n} recall@4`,
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
          && base.controlA === result.controlA && base.controlB === result.controlB;
        console.log(same ? '\n对比基线：指纹相同、三项数字全等 —— 这次改动没有影响召回。'
          : `\n对比基线：指纹相同、数字有变 —— 这才是一次可信的 A/B。\n  口径 ${base.pairs} → ${result.pairs} | 桥探针 ${base.bridge} → ${result.bridge} | 别名 ${base.alias} → ${result.alias} | 对照A ${base.controlA} → ${result.controlA} | 对照B ${base.controlB} → ${result.controlB}`);
      } else {
        // 这条警告是本文件存在的主要理由之一：库变了，分数就没法直接比。
        console.log(`\n⚠️ 语料变了（指纹 ${base.fingerprint} → ${FP}，${base.notes}篇/${base.chunks}chunk → ${NOTE_COUNT}篇/${docs.length}chunk）。`);
        console.log(`  上次：口径 ${base.pairs} | 桥探针 ${base.bridge ?? '—'} | 别名 ${base.alias ?? '—'} | 对照A ${base.controlA} | 对照B ${base.controlB}`);
        console.log('  分数**不可直接比较** —— 掉分可能是库变了，不是代码退步。要对齐请先回溯语料，或 --save 重设基线。');
      }
    }
  }
}
