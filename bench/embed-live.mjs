/**
 * 真端点的 embeddings 对照尺子：同一条命令，有 key 就量真收益，没 key 就对着本地假服务量管线。
 *
 *   node bench/embed-live.mjs --fake        # 起一个本地假 /embeddings（默认，不需要任何密钥）
 *   node bench/embed-live.mjs --real        # 用 providers/openai-embeddings.mjs 的配置读法找真端点
 *   node bench/embed-live.mjs --real --store ~/memory/engramory --limit 100 --json
 *
 * 假向量模式下**只读管线与代价**（调用次数 / 文本条数 / 字符数 / 缓存命中 / 每次检索耗时），
 * 因为假向量不含语义，质量数字没有意义 —— 脚本会明确打上标记。
 *
 * 真端点模式会把这些文本发给该端点：合成语料是造的假笔记；`--store` 加进来的真库探针
 * 会把**你的笔记片段**发出去，所以它默认不开（要显式给 `--store`）。
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildIndex, search } from '../bm25.js';
import { homedir } from 'node:os';
import { buildCorpus, BENCH_NOW } from './corpus.mjs';
import { readDocs } from '../store.js';
import { PAIRS, BRIDGE_PAIRS, ALIAS_PAIRS } from '../scripts/probe-queries.mjs';
import { semanticSearch } from '../semantic.js';
import { readConfig, DEFAULT_CONFIG_PATH } from '../providers/openai-embeddings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const wantJson = argv.includes('--json');
const STORE = opt('--store', '');
const LIMIT = Number(opt('--limit', '0')) || 0;
const POOL = Number(opt('--pool', '50'));
const FUSION = opt('--fusion', 'trust');
const fake = !argv.includes('--real');
const DIM = 16;

/** 假 embeddings 服务：确定性的哈希向量（同文本同向量），只验证管线与代价。 */
function startFakeServer() {
  const stats = { calls: 0, texts: 0, chars: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
      stats.calls += 1;
      stats.texts += input.length;
      stats.chars += input.reduce((n, t) => n + String(t).length, 0);
      const data = input.map((text, index) => {
        const digest = createHash('sha256').update(String(text)).digest();
        const vector = Array.from({ length: DIM }, (_, i) => (digest[i % digest.length] / 255) * 2 - 1);
        return { object: 'embedding', index, embedding: vector };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data, model: parsed.model ?? 'fake', usage: { prompt_tokens: 0, total_tokens: 0 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, stats, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

const corpus = buildCorpus();
const index = buildIndex(corpus.docs, { now: BENCH_NOW });
const queries = LIMIT ? corpus.queries.slice(0, LIMIT) : corpus.queries;
const sheet = [{ label: '合成基准', queries: queries.map((q) => ({ q: q.q, gold: q.gold })) }];

// 真库探针卷子：显式 `--store` 才加进来（--real 模式下它会把你的笔记片段发给那个端点）
let storeIndex = null;
if (STORE) {
  const storePath = STORE.startsWith('~') ? join(homedir(), STORE.slice(1)) : STORE;
  const docs = readDocs(storePath);
  storeIndex = buildIndex(docs);
  // 配对表是 [query, 期望命中的笔记 id（不含 .md）] 的数组（见 scripts/probe-queries.mjs）
  const pairs = [...PAIRS, ...BRIDGE_PAIRS, ...ALIAS_PAIRS];
  const noteCount = new Set(docs.map((doc) => doc.id.replace(/\.md$/, ''))).size;
  sheet.push({
    label: `真库探针（${noteCount} 篇 / ${docs.length} chunk）`,
    queries: pairs.map(([query, want]) => ({ q: query, gold: `${String(want).replace(/\.md$/, '')}.md` })),
  });
  console.log(`真库卷子：${storePath} —— ${fake ? '片段只发给本机假服务' : '**片段会发给你配的那个端点**'}\n`);
}

let fakeHandle = null;
let providerPath = '';
let cleanup = async () => {};
if (fake) {
  fakeHandle = await startFakeServer();
  providerPath = join(here, '.tmp', 'fake-embed-provider.mjs');
  writeFileSync(
    providerPath,
    `import { createProvider } from ${JSON.stringify(new URL('../providers/openai-embeddings.mjs', import.meta.url).href)};
     const provider = createProvider({ baseUrl: ${JSON.stringify(fakeHandle.baseUrl)}, model: 'fake-16d', apiKey: 'not-a-secret' });
     export const rerank = provider.rerank;\n`,
  );
  cleanup = async () => { await new Promise((r) => fakeHandle.server.close(r)); };
} else {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.error(`✗ 没找到密钥：设置 ENGRAMORY_EMBED_API_KEY，或写 ${DEFAULT_CONFIG_PATH}；想先验证管线就跑 --fake`);
    process.exit(1);
  }
  console.log(`真端点：${cfg.baseUrl} · 模型 ${cfg.model}（密钥来自配置，脚本不打印它）\n`);
  providerPath = join(here, '.tmp', 'real-embed-provider.mjs');
  writeFileSync(
    providerPath,
    `import provider from ${JSON.stringify(new URL('../providers/openai-embeddings.mjs', import.meta.url).href)};
     export const rerank = provider.rerank;\n`,
  );
}

const pct = (n, total) => `${((n / total) * 100).toFixed(1)}%`;
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
};

console.log(`# embeddings 接缝：${fake ? '本地假服务（管线与代价）' : '真端点'} \n`);
console.log(`窗口 top-4、池 ${POOL}、融合 ${FUSION}；${fake ? '**假向量不含语义，下面的质量列不可当结论**' : '质量列就是这条端点的真实表现'}。\n`);
console.log(`| 卷子 | 条数 | 词面 hit@1 | 词面 hit@4 | 接缝 hit@1 | 接缝 hit@4 | 每次检索 p50 | p90 | 超时/失败 |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);

const json = { when: 'bench/embed-live.mjs', fake, pool: POOL, fusion: FUSION, dim: DIM, sheets: [] };
for (const s of sheet) {
  let base1 = 0;
  let base4 = 0;
  let seam1 = 0;
  let seam4 = 0;
  let failed = 0;
  const codes = new Map();
  const times = [];
  const pools = [];
  const queryIndex = s.label.startsWith('真库') ? storeIndex : index;
  for (const item of s.queries) {
    const lexical = search(queryIndex, item.q, 4);
    const baseRank = lexical.findIndex((hit) => hit.id === item.gold);
    if (baseRank === 0) base1 += 1;
    if (baseRank >= 0) base4 += 1;
    const result = await semanticSearch({
      index: queryIndex,
      query: item.q,
      limit: 4,
      config: { provider: providerPath, pool: POOL, fusion: FUSION, timeoutMs: 20000 },
      baseDir: here,
    });
    const rank = result.hits.findIndex((hit) => hit.id === item.gold);
    if (rank === 0) seam1 += 1;
    if (rank >= 0) seam4 += 1;
    if (!result.used) failed += 1;
    codes.set(result.code, (codes.get(result.code) ?? 0) + 1);
    if (typeof result.pool === 'number') pools.push(result.pool);
    if (!result.used && failed <= 2) console.error(`  ! 没用上（${result.code}）：${result.message}`);
    times.push(result.ms);
  }
  const total = s.queries.length;
  const row = {
    sheet: s.label,
    total,
    base1,
    base4,
    seam1,
    seam4,
    p50: quantile(times, 0.5),
    p90: quantile(times, 0.9),
    pool50: quantile(pools, 0.5),
    pool90: quantile(pools, 0.9),
    candidates: pools.reduce((n, size) => n + size, 0),
    failed,
    codes: Object.fromEntries(codes),
  };
  json.sheets.push(row);
  const codeText = [...codes].map(([code, n]) => `${code}×${n}`).join(' ');
  console.log(`| ${s.label} | ${total} | ${pct(base1, total)} | ${pct(base4, total)} | ${pct(seam1, total)} | ${pct(seam4, total)} | ${row.p50.toFixed(0)} ms | ${row.p90.toFixed(0)} ms | ${failed}（${codeText}） |`);
}

console.log(`\n## 池子实际有多大（决定要发多少东西）\n`);
console.log(`| 卷子 | 池中位 | 池 p90 |`);
console.log(`| --- | --- | --- |`);
for (const row of json.sheets) console.log(`| ${row.sheet} | ${row.pool50} | ${row.pool90} |`);
console.log(`\n词面只回有分的文档，所以「池 50」是上限不是常态；库越小、查询越刁，实际发的越少。`);

if (fake) {
  console.log(`\n## 代价（假服务自己数的，与提供方无关的那部分）\n`);
  console.log(`| 项 | 值 |`);
  console.log(`| --- | --- |`);
  console.log(`| HTTP 调用次数 | ${fakeHandle.stats.calls} |`);
  console.log(`| 发出的文本条数 | ${fakeHandle.stats.texts} |`);
  console.log(`| 发出字符数 | ${fakeHandle.stats.chars} |`);
  console.log(`| 平均每次调用文本条数 | ${(fakeHandle.stats.texts / Math.max(1, fakeHandle.stats.calls)).toFixed(1)} |`);
  const candidates = json.sheets.reduce((n, row) => n + (row.candidates ?? 0), 0);
if (candidates) {
  const saved = 1 - fakeHandle.stats.texts / candidates;
  console.log(`\n提供方缓存：候选总量 ${candidates} 条，实际只发了 ${fakeHandle.stats.texts} 条（省下 ${(saved * 100).toFixed(1)}%）——`);
  console.log(`同一篇笔记在不同查询里反复出现，按文本缓存后只付一次钱。`);
}
  console.log(`真实 cost（token/价格）与真延迟请跑 --real；本模式只证明**管线通、池宽真的发出去了、超时预算够**。`);
  json.cost = fakeHandle.stats;
}

await cleanup();
if (wantJson) {
  writeFileSync(join(here, '.embed-live.json'), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`\n（JSON 写到 bench/.embed-live.json）`);
}
