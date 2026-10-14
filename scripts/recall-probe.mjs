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
 * 用法：
 *   node scripts/recall-probe.mjs                       # 默认读 ~/memory/engramory
 *   node scripts/recall-probe.mjs /path/to/store        # 指定库
 *   node scripts/recall-probe.mjs --pairs               # 只跑口径，不出对照（看细节用）
 */
import { readDocs } from '../store.js';
import { buildIndex, search } from '../bm25.js';

const args = process.argv.slice(2);
const onlyPairs = args.includes('--pairs');
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

const docs = readDocs(storePath);
if (!docs.length) {
  console.error(`读不到笔记：${storePath}`);
  process.exit(1);
}
const idx = buildIndex(docs);
const rank = (q, want) => search(idx, q, 4).map((h) => h.id.replace(/\.md$/, '')).indexOf(want);

console.log(`库：${storePath}（${docs.length} 个 chunk）\n`);

let miss = 0;
for (const [q, want] of PAIRS) {
  const r = rank(q, want);
  if (r < 0) miss += 1;
  const mark = r < 0 ? '❌' : r === 0 ? '✅' : `⚠️${r + 1}`;
  const tail = r < 0 ? `  | 实际: ${search(idx, q, 3).map((h) => h.id.replace(/\.md$/, '')).join(', ')}` : '';
  console.log(`${mark} ${q.padEnd(20)} → ${want.replace(/^(reference|project|feedback)-/, '')}${tail}`);
}
console.log(`\n口径 recall@4：${PAIRS.length - miss}/${PAIRS.length}`);

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
}
