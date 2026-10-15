/**
 * 单元测试：node --test test/
 *
 * 覆盖三件事：
 *   1. 分词与 BM25 排序在中文上确实能命中（这是 Memmy 当初「中文口语查询零命中」的反面）。
 *   2. 笔记解析（frontmatter / 标题 / 正文）。
 *   3. 插件注入逻辑：命中才注入、没命中不注入、同一轮不重复注入、只注入指针不注入正文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { SYNONYMS, tokenize, queryTerms, buildIndex, search, expandQuery } from '../bm25.js';
import { corpusFingerprint, splitNote, readDocs, chunkBody } from '../store.js';
import { apply, isSearchable, searchableReason } from '../index.js';
import { readAudit, GUARD_EPOCH } from '../audit.js';

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-recall-'));
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory Index\n\n- [代理节点](reference-proxy.md) — Hy2 双端口\n');
  writeFileSync(
    join(dir, 'reference-proxy.md'),
    [
      '---',
      'name: reference-proxy',
      'description: 美国自建代理节点架构：Hy2 双端口主力 + Trojan 兜底',
      'type: reference',
      '---',
      '',
      '# 美国自建代理节点架构',
      '',
      'Hy2 双端口主力 + Trojan 兜底，旧 VMess/VLESS 已退役。',
      '国内 CDN 转发代理不可行。',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'project-cicd.md'),
    ['---', 'name: project-cicd', 'description: Jenkins 流水线与站点部署', '---', '', '# CI/CD', '', 'Jenkins 多段部署命令只有第一条走 SSH。'].join('\n'),
  );
  return dir;
}

test('查询词项：英文虚词在查询侧被丢掉（索引侧不动）', () => {
  assert.deepEqual(queryTerms('What degree did I graduate with?').sort(), ['degree', 'graduate']);
  // 虚词表只收语法词：带语义的词一个不碰
  assert.deepEqual(queryTerms('what time is it'), ['time']); // what/is/it 是虚词，time 不是
  assert.ok(queryTerms('the name of my hamster').includes('name'));
  assert.ok(queryTerms('the name of my hamster').includes('hamster'));
});

test('查询词项：清不空 —— 只剩虚词时退回原样，单关键词也不动', () => {
  const all = queryTerms('what is the');
  assert.ok(all.length >= 1, '过滤后为空等于一条都召不回，必须退回原样');
  assert.ok(all.includes('the') || all.includes('what'));
  assert.deepEqual(queryTerms('the'), ['the']); // 单个词项的查询不筛
});

test('查询词项：求助/建议类框架词在查询侧被丢掉，实词一个不少', () => {
  // 「说出偏好 + 问建议」这类查询里，框架词会把「同一类对话」的干扰项抬上来（见 bm25.js 注释）
  assert.deepEqual(queryTerms('Any tips for a good hotel?').sort(), ['hotel']);
  assert.deepEqual(queryTerms('Can you suggest a hotel for my upcoming trip?').sort(), ['hotel', 'trip']);
  // 只丢框架词：话题词、动词、专有名词都留着
  const coop = queryTerms('what advice do you have about my chicken coop');
  assert.deepEqual(coop.sort(), ['chicken', 'coop']);
  assert.ok(queryTerms('I have been thinking about buying a new road bike').includes('bike'));
});

test('查询词项：全是框架词时退回只过虚词的结果，绝不清空', () => {
  // 「any tips?」这种查询全靠框架词，清空 = 一条都召不回
  assert.deepEqual(queryTerms('any tips'), ['tips']);
  // 整个查询都是框架词时，第三道保险原样退回（宁可留噪声，不可清空）
  assert.deepEqual(queryTerms('good ideas'), ['good', 'ideas']);
  // 单关键词的查询走第一道保险，压根不筛
  assert.deepEqual(queryTerms('tips'), ['tips']);
  assert.deepEqual(queryTerms('advice'), ['advice']);
});

test('BM25：查询侧丢虚词后，英文长问句不再被 how/what 之类带偏', () => {
  const docs = [
    { id: 'a.md', title: '', description: '', body: 'How do I deploy the worker? Set the token in .env.' },
    { id: 'b.md', title: '', description: '', body: 'Q: What degree did you graduate with? A: Master of Science.' },
  ];
  const index = buildIndex(docs);
  const hit = search(index, 'What degree did I graduate with?', 1);
  assert.equal(hit[0]?.id, 'b.md');
});

test('分词：中文出双字，英文出词元', () => {
  const terms = new Set(tokenize('代理节点 Hy2'));
  assert.ok(terms.has('代理'));
  assert.ok(terms.has('理节'));
  assert.ok(terms.has('节点'));
  assert.ok(terms.has('hy2'));
});

test('BM25：中文查询命中正确笔记，且不返回零分结果', () => {
  const docs = [
    { id: 'reference-proxy.md', title: '美国自建代理节点架构', description: 'Hy2 双端口 + Trojan 兜底', body: '国内 CDN 转发代理不可行。' },
    { id: 'project-cicd.md', title: 'CI/CD', description: 'Jenkins 流水线', body: '多段部署命令只有第一条走 SSH。' },
  ];
  const index = buildIndex(docs);

  const proxy = search(index, '代理节点怎么搭的', 3);
  assert.equal(proxy[0].id, 'reference-proxy.md');
  assert.ok(proxy[0].score > 0);
  assert.ok(proxy[0].snippet.length > 0);

  const cicd = search(index, 'Jenkins 部署', 3);
  assert.equal(cicd[0].id, 'project-cicd.md');

  assert.deepEqual(search(index, '量子纠缠火锅', 3), []);
});

test('笔记解析：frontmatter 与一级标题', () => {
  const note = splitNote('---\nname: x\ndescription: 描述行\ntype: reference\n---\n\n# 真标题\n\n正文');
  assert.equal(note.title, '真标题');
  assert.equal(note.description, '描述行');
  assert.equal(note.body, '# 真标题\n\n正文');
});

test('插件：命中才注入，且只注入指针不含正文', async () => {
  const dir = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: dir });
    const decision = {
      kind: 'enter',
      messages: [human('m1', '我们那个代理节点现在是什么架构？')],
    };
    const out = await handler({ agent: {}, signal: undefined }, async () => decision);

    assert.equal(out.messages.length, 2);
    const injected = out.messages[1];
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, 'plugin:dsh-engramory-recall', 'kind 必须是生产者自有形状；裸 plugin 会被 v4 会话格式拒绝');
    assert.equal(injected.source.form, 'notice');
    assert.equal(typeof injected.source.summary, 'string');
    const text = injected.content[0].text;
    assert.match(text, /reference-proxy\.md/);
    assert.equal(text.includes('Hy2 双端口主力 + Trojan 兜底，旧 VMess'), false, '不应注入正文');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件：没命中就不注入；同一轮不重复注入', async () => {
  const dir = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: dir });

    const miss = await handler({}, async () => ({ kind: 'enter', messages: [human('m1', '今天天气不错')] }));
    assert.equal(miss.messages.length, 1, '无命中不应注入任何东西');

    const hit = await handler({}, async () => ({ kind: 'enter', messages: [human('m2', '代理节点')] }));
    assert.equal(hit.messages.length, 2);
    const again = await handler({}, async () => ({ kind: 'enter', messages: [human('m2', '代理节点')] }));
    assert.equal(again.messages.length, 1, '同一个消息 id 不应重复注入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件：非真人消息（工具结果轮）不注入', async () => {
  const dir = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: dir });
    const out = await handler({}, async () => ({
      kind: 'enter',
      messages: [{ id: 't1', role: 'tool', content: [{ type: 'text', text: '代理节点' }], source: { kind: 'tool' } }],
    }));
    assert.equal(out.messages.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实记忆库：一次中文口语查询能命中相关笔记', () => {
  const store = join(process.env.HOME ?? '', 'memory', 'engramory');
  const docs = readDocs(store);
  if (!docs.length) return; // 没有库就跳过（CI 或换机器）
  const index = buildIndex(docs);
  const hits = search(index, '自动召回是怎么做的', 3);
  assert.ok(hits.length > 0, '应当至少命中一条');
  assert.ok(hits.every((hit) => hit.score > 0));
});

test('工具：engramory_search 能按需检索，且形状符合注册契约', async () => {
  const dir = fixtureStore();
  try {
    const { tool } = captureHandler({ storePath: dir });
    assert.ok(tool, 'apply() 应当注册 engramory_search 工具');
    assert.equal(tool.name, 'engramory_search');
    // register() 只校验这两项：output.schema 必须是受支持的 JSON Schema、render 必须是函数
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['query']);
    assert.equal(tool.parameters.additionalProperties, false);

    const hit = await tool.execute({ query: '代理节点' });
    assert.equal(hit.store, dir);
    assert.ok(hit.hits.length > 0);
    assert.equal(hit.hits[0].file, 'reference-proxy.md');
    assert.equal(typeof hit.hits[0].score, 'number');
    assert.ok(hit.hits[0].snippet.length > 0);

    // limit 上限被夹住；空 query 不炸
    const capped = await tool.execute({ query: '部署', limit: 999 });
    assert.ok(capped.hits.length <= 20);
    const empty = await tool.execute({ query: '   ' });
    assert.deepEqual(empty.hits, []);

    // render 返回内容块（宿主据此渲染）
    const blocks = tool.output.render({}, hit);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /reference-proxy\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureHandler(config) {
  let handler;
  let tool;
  const routes = [];
  const guards = [];
  const skills = [];
  const ctx = {
    on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; },
    tools: {
      register: (definition) => { tool = definition; },
      // ctx.tools.guard(fn) 注册单调守卫：返回字符串即拒绝。
      guard: (fn) => { guards.push(fn); return () => {}; },
    },
    // 真实 cordis 的 ctx.inject(deps, cb) 在依赖服务就绪后才跑 cb；这里的假实现
    // **按 deps 分派**（早先不分派、一律塞一份 webServer，于是技能那条链永远拿不到
    // skills 而静默走 catch —— 恰好把要测的东西测没了）。
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
      }
      if (deps.includes('skills')) {
        fn({
          effect: (f) => f(),
          skills: { register: (entry) => { skills.push(entry); return () => {}; } },
        });
      }
    },
  };
  apply(ctx, config);
  assert.ok(handler, 'apply() 应当注册 agent/pre-step 监听');
  return { handler, tool, routes, guards, skills };
}

function captureResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
    end(body) { this.body = body ?? ''; },
  };
}

function human(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

// ── 2026-10-14 三机制改造的回归测试 ─────────────────────────────────

test('寒暄与极短消息不触发检索', () => {
  for (const s of ['继续', '嗯', '重试一下', '好的', '谢谢', 'ok', '可以', '接着做', '再来一次']) {
    assert.equal(isSearchable(s), false, `「${s}」不该去检索`);
  }
  for (const s of ['飞书连不上', 'ppt 样式没了', '主题变量改了颜色没生效']) {
    assert.equal(isSearchable(s), true, `「${s}」应当去检索`);
  }
});

test('超长正文按章节切桶，每桶不超上限', () => {
  const filler = Array.from({ length: 60 }, (_, j) => `第 ${j} 行内容 ${'填'.repeat(20)}`).join('\n');
  const body = Array.from({ length: 6 }, (_, i) => `## 段 ${i}\n\n${filler}`).join('\n');
  const chunks = chunkBody(body, 1024);
  assert.ok(chunks.length > 1, '超长正文应当被切成多桶');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk.body) <= 1024 + 64, `桶超限: ${Buffer.byteLength(chunk.body)}`);
  }
});

test('同一篇笔记切桶后只占一个召回位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-chunk-'));
  try {
    const long = ['---', 'name: long', 'description: 超长日志', '---', '', '# 超长日志', ''];
    for (let i = 0; i < 12; i += 1) {
      long.push(`## 第 ${i} 批`, '', `量子纠缠记录 ${i} ${'填充内容'.repeat(300)}`, '');
    }
    writeFileSync(join(dir, 'long.md'), long.join('\n'));
    writeFileSync(
      join(dir, 'short.md'),
      ['---', 'name: short', 'description: 短笔记', '---', '', '# 短笔记', '', '量子纠缠 也在这篇里。'].join('\n'),
    );
    const docs = readDocs(dir);
    assert.ok(docs.length > 2, '超长笔记应当被切成多桶');
    const ids = search(buildIndex(docs), '量子纠缠', 5).map((hit) => hit.id);
    assert.equal(new Set(ids).size, ids.length, '同一篇笔记不得重复占位');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-10-14 同义桥：一个静默失效的回归 ───────────────────────────
// ⚠️ 下面这条不测权重：EXTRA_WEIGHT 是语料统计量撑起来的经验值，试过 0.5/0.8 都绿
// （真实库里「起不」只出现在 3 个 chunk 而 IDF 高、「浏览器」类词出现在 12+ 个 chunk），
// 在小 fixture 里 df 结构整个反过来，写出来的只会是「怎么改都通过」的假测试 —— 试过，
// 0.5 和 0.8 都绿。证据由 `scripts/recall-probe.mjs` 在真实库上产出，见 bm25.js 的注释。

test('同义扩展的词项必须过分词，否则中文同义词是死词项', () => {
  const terms = expandQuery('浏览器起不来');
  assert.ok(terms.includes('chrome'), `英文桥该原样进来: ${terms.join(',')}`);
  // 中文桥必须被拆成相邻双字 —— 库里的词项就是这个形状。整词原样塞进去，
  // `doc.tf.has('不可用')` 永远为 false，是一条只在中文上静默失效的路。
  assert.ok(terms.includes('不可') || terms.includes('可用'), `中文桥没被分词: ${terms.join(',')}`);
  assert.ok(!terms.includes('不可用'), `不该把整词原样当词项: ${terms.join(',')}`);
});

// ── 2026-10-14 记忆面板（可观测性）的回归测试 ────────────────────────

test('宿主路由：状态接口返回记忆库快照，且每次召回都留痕', async () => {
  const dir = fixtureStore();
  try {
    const { handler, routes } = captureHandler({ storePath: dir });

    assert.equal(routes.length, 2, 'apply() 应当注册两条宿主路由：state 与 archive');
    const route = routes.find((r) => r.path === '/api/engramory-recall/state');
    assert.ok(route, '应当注册状态接口');
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
    assert.ok(routes.some((r) => r.path === '/api/engramory-recall/archive'), '应当注册归档执行接口');

    // 首次取状态：有库快照、暂无召回日志
    const first = captureResponse();
    await route.handler({ method: 'GET' }, first);
    assert.equal(first.status, 200);
    assert.match(first.headers['content-type'], /application\/json/);
    const before = JSON.parse(first.body);
    assert.equal(before.store, dir);
    assert.ok(before.notes.length > 0, '应当列出笔记');
    assert.ok(before.totals.bytes > 0);
    assert.ok(before.notes.every((note) => note.file && typeof note.bytes === 'number'));
    assert.deepEqual(before.log, [], '还没召回时日志应为空');
    assert.equal(before.config.maxPointers, 4);

    // 命中一轮 → 日志要有 hit 与命中明细
    await handler({}, async () => ({ kind: 'enter', messages: [human('m-hit', '代理节点怎么搭的')] }));
    const afterHit = captureResponse();
    await route.handler({ method: 'GET' }, afterHit);
    const hitLog = JSON.parse(afterHit.body).log;
    assert.equal(hitLog.length, 1);
    assert.equal(hitLog[0].kind, 'hit');
    assert.ok(hitLog[0].hits.length > 0, 'hit 应当带命中条目');
    assert.equal(hitLog[0].hits[0].id, 'reference-proxy.md');
    assert.ok(hitLog[0].chars > 0 && hitLog[0].injected > 0);

    // 寒暄轮 → 记成 skip（「为什么没召回」也要看得见）
    await handler({}, async () => ({ kind: 'enter', messages: [human('m-skip', '继续')] }));
    const afterSkip = captureResponse();
    await route.handler({ method: 'GET' }, afterSkip);
    assert.equal(JSON.parse(afterSkip.body).log[0].kind, 'skip');

    // 无命中轮 → 记成 empty
    await handler({}, async () => ({ kind: 'enter', messages: [human('m-empty', '量子纠缠火锅怎么做')] }));
    const afterEmpty = captureResponse();
    await route.handler({ method: 'GET' }, afterEmpty);
    const emptyLog = JSON.parse(afterEmpty.body).log;
    assert.equal(emptyLog[0].kind, 'empty');
    assert.ok(emptyLog.every((entry) => entry.at > 0 && typeof entry.query === 'string'));

    // 使用账（面板「使用账」页签的数据源）：宿主侧汇总 + 四句判据都得在，
    // 否则前端只能显示一个空壳。maxPointers 不传进去，窗口用满了几轮就永远是 0。
    const usageBody = JSON.parse(afterEmpty.body).usage;
    assert.ok(usageBody && typeof usageBody === 'object', 'state 路由应当带 usage 汇总');
    assert.ok(usageBody.pointers > 0, '注入过就应当有指针计数');
    assert.equal(usageBody.perRound.windowLimit, 4, 'usage 汇总要知道窗口上限（maxPointers）');
    assert.equal(usageBody.skipRounds, 1, '寒暄轮应当算作一次跳过');
    assert.ok(usageBody.skipReasons.chitchat >= 1, '跳过原因应当记成 chitchat，而不是光秃秃一个 skip');
    assert.ok(usageBody.emptyReasons['no-hits'] >= 1, '零命中原因应当记成 no-hits');
    assert.ok(Array.isArray(usageBody.positions) && usageBody.positions.length > 0, '应当有位置级曲线');
    assert.ok(usageBody.positions[0].injected > 0, '第 1 条指针至少注入过一次');
    for (const key of ['open', 'budget', 'reason']) {
      assert.equal(typeof usageBody.verdicts[key], 'string', `usage.verdicts.${key} 应当是一句人话`);
      assert.ok(usageBody.verdicts[key].length > 0);
    }

    // 只读：非 GET 一律 405
    const rejected = captureResponse();
    await route.handler({ method: 'POST' }, rejected);
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.allow, 'GET');

    // 体检结果随状态接口一起下发，面板的「体检」tab 靠它
    const auditBody = JSON.parse(afterEmpty.body).audit;
    assert.ok(auditBody, '状态接口应当带上体检结果');
    assert.ok(Array.isArray(auditBody.findings));
    assert.equal(typeof auditBody.summary.bySeverity.error, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freshness 衰减：默认关闭时新旧完全同分，开启后新笔记压过旧笔记', () => {
  const DAY = 86400000;
  const now = 1_700_000_000_000;
  // 两篇正文与标题完全相同，唯一变量是 mtime —— 词项、长度、idf 全同，只有 decay 不同。
  const mk = (id, ageDays) => ({
    id,
    title: '缓存穿透排查',
    description: '',
    body: '缓存穿透的排查方法，以及它和缓存击穿的区别。',
    mtimeMs: now - ageDays * DAY,
  });
  const docs = [mk('old-note.md', 180), mk('new-note.md', 0)];

  // 关闭（默认）：乘子恒为 1，两篇同分，此时谁排前面只看 id 兜底。
  const off = buildIndex(docs, { halfLifeDays: 0, now });
  assert.deepEqual(
    off.docs.map((d) => d.decay),
    [1, 1],
  );
  const offHits = search(off, '缓存穿透', 2);
  assert.equal(offHits.length, 2);
  assert.equal(offHits[0].score, offHits[1].score);

  // 开启：180 天 = 6 个半衰期 ⇒ 旧笔记只剩 0.5^6 ≈ 0.0156 分。
  const on = buildIndex(docs, { halfLifeDays: 30, now });
  const decayOf = new Map(on.docs.map((d) => [d.id, d.decay]));
  assert.equal(decayOf.get('new-note.md'), 1);
  assert.ok(decayOf.get('old-note.md') > 0.01 && decayOf.get('old-note.md') < 0.02);
  const onHits = search(on, '缓存穿透', 2);
  assert.equal(onHits[0].id, 'new-note.md');
  assert.ok(onHits[0].score > onHits[1].score * 10);
});

test('缓存键：只改中间那篇笔记也必须让索引失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-recall-cache-'));
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory Index\n');
    writeFileSync(join(dir, 'aaa-first.md'), '# 甲\n\n内容甲。\n');
    writeFileSync(join(dir, 'mmm-middle.md'), '# 乙\n\n内容乙。\n');
    writeFileSync(join(dir, 'zzz-last.md'), '# 丙\n\n内容丙。\n');

    const before = readDocs(dir);
    assert.equal(before.length, 3);
    assert.ok(before.find((d) => d.id === 'mmm-middle.md').body.includes('内容乙'));

    // 只动中间那篇：首末两篇与 MEMORY.md 都不碰，旧缓存键（只看首末文件名）不会变。
    writeFileSync(join(dir, 'mmm-middle.md'), '# 乙\n\n内容乙改成了量子纠缠。\n');
    // 显式把 mtime 推后：同毫秒内改写会让 mtime 看起来没变，测试会假绿。
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'mmm-middle.md'), future, future);

    const after = readDocs(dir);
    assert.ok(
      after.find((d) => d.id === 'mmm-middle.md').body.includes('量子纠缠'),
      '改了中间那篇之后必须重新读盘，不能命中旧缓存',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 写入闸门（fail-closed）──────────────────────────────────────────

test('写入闸门：库外放行，库里不合规的拒绝', () => {
  const dir = fixtureStore();
  try {
    const { guards } = captureHandler({ storePath: dir });
    assert.equal(guards.length, 1, 'apply() 应当注册恰好一个写入守卫');
    const guard = guards[0];

    // 不是它的管辖范围：库外路径、非 write/edit 工具。
    assert.equal(guard({ name: 'write', arguments: { file_path: '/tmp/other/note.md', content: '# 随便' } }), undefined);
    assert.equal(guard({ name: 'bash', arguments: { command: 'echo hi > note.md' } }), undefined);
    assert.equal(guard({ name: 'write', arguments: {} }), undefined);

    // 库里：文件名不合规 → 返回字符串即拒绝。
    const badName = guard({
      name: 'write',
      arguments: { file_path: join(dir, 'notes.md'), content: '---\nname: x\ndescription: y\n---\n' },
    });
    assert.equal(typeof badName, 'string');
    assert.match(badName, /文件名/);

    // 库里：合法笔记 → 放行。
    assert.equal(
      guard({
        name: 'write',
        arguments: {
          file_path: join(dir, 'reference-ok.md'),
          content: '---\nname: reference-ok\ndescription: 说明\ntype: reference\n---\n\n# 正文\n',
        },
      }),
      undefined,
    );

    // 库里：内容含真凭据 → 拒绝。
    assert.match(
      guard({
        name: 'write',
        arguments: {
          file_path: join(dir, 'reference-ok.md'),
          content: '---\nname: x\ndescription: y\n---\n\nsk-abcdefghijklmnopqrst\n',
        },
      }),
      /凭据/,
    );

    // edit 只给片段，看不到结构，但仍然查凭据。
    assert.match(
      guard({
        name: 'edit',
        arguments: {
          file_path: join(dir, 'reference-ok.md'),
          old_string: 'a',
          new_string: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        },
      }),
      /凭据/,
    );
    assert.equal(
      guard({ name: 'edit', arguments: { file_path: join(dir, 'reference-ok.md'), old_string: 'a', new_string: '普通一行' } }),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入闸门：索引文件改由索引上限闸门接手（融合自 dsh-engramory）', () => {
  const dir = fixtureStore();
  try {
    // 注意：apply() 是 `{ ...DEFAULTS, ...config }` 展开配置的，**没有** settings 这一层
    const { guards } = captureHandler({ storePath: dir, indexMaxLines: 5, indexMaxBytes: 4096 });
    const guard = guards[0];
    const index = join(dir, 'MEMORY.md');

    // 上限内 → 放行（checkMemoryWrite 对索引返回 skipped:'index'，路由给索引闸门后通过）
    assert.equal(
      guard({ name: 'write', arguments: { file_path: index, content: '- a.md\n- b.md' } }),
      undefined,
    );

    // 顶过上限 → 拒绝，且理由必须说清是**索引**、并带上真实行数
    const reason = guard({
      name: 'write',
      arguments: {
        file_path: index,
        content: Array.from({ length: 30 }, (_, i) => `- n${i}.md`).join('\n'),
      },
    });
    assert.match(reason, /索引/);
    assert.match(reason, /30 行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('融合进来的 engramory 技能会真的注册到宿主', () => {
  const dir = fixtureStore();
  try {
    const { skills } = captureHandler({ storePath: dir });
    assert.equal(skills.length, 1, 'apply() 应当注册恰好一个技能');
    assert.equal(skills[0].name, 'engramory');
    assert.match(skills[0].content, /curated file-based memory/);
    assert.match(skills[0].content, /a greeting,\s+an\s+acknowledgement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerSkill:false 时不注册技能（其余照常）', () => {
  const dir = fixtureStore();
  try {
    const { skills, guards } = captureHandler({ storePath: dir, registerSkill: false });
    assert.equal(skills.length, 0);
    assert.equal(guards.length, 1, '闸门不该受技能开关影响');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入闸门：被拒的写入会留在召回日志里（面板看得到）', async () => {
  const dir = fixtureStore();
  try {
    const { guards, routes } = captureHandler({ storePath: dir });
    assert.match(
      guards[0]({ name: 'write', arguments: { file_path: join(dir, 'notes.md'), content: 'x' } }),
      /文件名/,
    );

    const res = captureResponse();
    await routes[0].handler({ method: 'GET' }, res);
    const body = JSON.parse(res.body);
    assert.equal(body.log[0].kind, 'deny');
    assert.match(body.log[0].reason, /文件名/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-10-14 第二波：从四家竞品源码里抄回来的机制 ──────────────────

test('注入去重：渲染文本一字未变时不重复注入', async () => {
  const dir = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: dir });
    const turn = (id, q) => handler({}, async () => ({ kind: 'enter', messages: [human(id, q)] }));

    const first = await turn('m1', '我们那个代理节点现在是什么架构？');
    assert.equal(first.messages.length, 2, '首轮应当注入');

    const second = await turn('m2', '我们那个代理节点现在是什么架构？');
    assert.equal(second.messages.length, 1, '命中与渲染完全相同 → 第二轮不重复注入');

    // 去重比的是整段渲染文本，不是「有没有命中」：片段变了就该照常注入。
    const third = await turn('m3', 'Trojan 兜底还在用吗');
    assert.equal(third.messages.length, 2, '渲染文本变了要照常注入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注入去重：跨轮轮换换了命中集时，同一查询的第二次仍要跳过', async () => {
  // 真实库上探针跑出来的 bug：去重原先比「整段渲染文本」，而机制三（跨轮轮换）
  // 会在第二轮扩容候选池并给上一轮的条目降权 → 命中集/顺序一变渲染文本必变 →
  // 去重永不生效。maxPointers 压到 1 就能在小 fixture 上复现这个置换。
  const dir = fixtureStore();
  try {
    writeFileSync(
      join(dir, 'reference-proxy-alt.md'),
      [
        '---',
        'name: reference-proxy-alt',
        'description: 代理节点备用线路：同城第二跳',
        'type: reference',
        '---',
        '',
        '# 代理节点备用线路',
        '',
        '代理节点备用线路走同城第二跳，主线路挂了再切。',
      ].join('\n'),
    );
    const { handler } = captureHandler({ storePath: dir, maxPointers: 1 });
    const turn = (id, q) => handler({}, async () => ({ kind: 'enter', messages: [human(id, q)] }));

    const first = await turn('m1', '代理节点');
    assert.equal(first.messages.length, 2, '首轮应当注入');

    // 第二轮：rotating 生效（候选池 1 → 5，上一轮那条被降权），命中集被置换。
    const second = await turn('m2', '代理节点');
    assert.equal(second.messages.length, 1, '查询没变、命中集只是被轮换置换 → 不该重复注入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('长消息：开头交代的主题词不会被截断丢掉', async () => {
  // 原实现是 `slice(-400)` 只留尾部（灵枢 issue #108 同类坑）。真实库探针实测：1190 字
  // 的消息开头写「飞书那边一直连不上」、中间贴 1146 字日志，只取尾部时完全召不回飞书笔记。
  // 现在改成头尾各取一半：开头（交代意图）与结尾（最新追问）都保住，中间粘贴正文才是可丢的。
  const dir = fixtureStore();
  try {
    const { handler } = captureHandler({ storePath: dir });
    const 开头 = '代理节点现在是什么架构？';
    const 中间 = Array.from({ length: 60 }, (_, i) => `第 ${i} 行日志：占位文本占位文本占位文本`).join('\n');
    const 结尾 = '大体就是这样了。';
    const long = `${开头}\n${中间}\n${结尾}`;
    assert.ok(long.length > 400, '构造的消息必须超过默认查询预算');

    const r = await handler({}, async () => ({ kind: 'enter', messages: [human('m1', long)] }));
    assert.equal(r.messages.length, 2, '长消息应当注入');
    assert.match(r.messages.at(-1).content[0].text, /reference-proxy\.md/, '开头提到的代理节点笔记必须被召回');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注入预算阶梯：装不下的条目塌缩成只有文件名，而不是整条丢掉', async () => {
  const dir = fixtureStore();
  try {
    writeFileSync(
      join(dir, 'reference-proxy-backup.md'),
      [
        '---',
        'name: reference-proxy-backup',
        'description: 代理节点备用方案',
        'type: reference',
        '---',
        '',
        '# 代理备用',
        '',
        '备用节点走 Trojan。',
      ].join('\n'),
    );

    // 两趟跑。第一趟把预算放开，量出真实条目长度；第二趟把预算**卡在刚好装不下第二条**的位置。
    //
    // 为什么不写死一个数字：条目长度取决于命中片段的截断位置，而片段是排序的产物 ——
    // 同义表一改，片段长度就变。原先写死 `maxChars: 180` 的版本，在一次纯粹的同义表扩容里
    // 变红了，而它本该测试的「预算阶梯」根本没有回归。**一个会被无关改动打红的测试，测的
    // 不是它声称的东西**。所以这里改成自己量：布局怎么变，它都精确落在要测的那一级上。
    const enter = () => ({ kind: 'enter', messages: [human('m1', '代理节点与部署')] });

    const wide = captureHandler({ storePath: dir, maxChars: 100000, maxPointers: 4 });
    const wideOut = await wide.handler({}, async () => enter());
    assert.equal(wideOut.messages.length, 2, '放开预算时应当有命中注入');
    const wideLines = wideOut.messages.at(-1).content[0].text.split('\n');
    assert.ok(wideLines.length >= 4, `放开预算后应列出全部命中，实际只有 ${wideLines.length - 1} 行`);

    const headerLen = wideLines[0].length;
    const [first, second] = wideLines.slice(1, 3);
    const bareSecond = `- ${second.slice(2).split(' — ')[0]}`;
    const afterFirst = headerLen + first.length + 1;
    const budget = afterFirst + bareSecond.length + 1; // 裸名刚好装得下，完整条目刚好装不下
    assert.ok(budget >= 160, 'maxChars 有 160 的下限，太小的预算测不到阶梯');
    assert.ok(afterFirst + second.length + 1 > budget, '第二条必须真的装不下，否则测不到塌缩这一级');

    const { handler } = captureHandler({ storePath: dir, maxChars: budget, maxPointers: 4 });
    const out = await handler({}, async () => enter());
    assert.equal(out.messages.length, 2, '至少要有命中');
    const text = out.messages.at(-1).content[0].text;
    assert.match(text, /^- \S+\.md — /m, '至少要有一条完整条目（文件名 + 片段）');
    assert.ok(text.includes(`\n${bareSecond}\n`) || text.endsWith(`\n${bareSecond}`), `预算不够的条目应当塌缩成只有文件名：\n${text}`);
    // 第三条（裸名都装不下）应当被如实计数，而不是静默消失 —— 这才是「阶梯」的完整契约：
    // 完整条目 → 裸文件名 → 如实报「另有 N 条」。三级的每一级都不能丢信息。
    const leftover = text.match(/（另有 (\d+) 条命中因预算未列出）/);
    assert.ok(!leftover || leftover[1] === '1', `只有第三条该被丢掉，实际：\n${text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨轮轮换：最近注入过的条目在下一轮被降权（记录 rotated）', async () => {
  const dir = fixtureStore();
  try {
    // 关掉注入去重，否则第二轮会被「渲染文本未变」直接拦下，测不到轮换。
    const { handler, routes } = captureHandler({ storePath: dir, dedupeInjection: false, rotationPenalty: 0.5 });
    const q = '代理节点';
    await handler({}, async () => ({ kind: 'enter', messages: [human('m1', q)] }));
    await handler({}, async () => ({ kind: 'enter', messages: [human('m2', q)] }));

    const res = captureResponse();
    await routes[0].handler({ method: 'GET' }, res);
    const body = JSON.parse(res.body);
    const rotated = body.log.some((entry) => entry.kind === 'hit' && (entry.hits ?? []).some((hit) => hit.rotated));
    assert.ok(rotated, '第二轮应当给上一轮注入过的条目打 rotated 标记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入审计：放行与拒绝都落盘，库外写入不记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-audit-'));
  const { guards } = await captureHandler({ storePath: dir });
  const guard = guards[0];

  // 库外：完全不进审计（那是噪音）
  guard({ name: 'write', arguments: { file_path: '/tmp/elsewhere/notes.md', content: 'x' } });
  assert.equal(readAudit(dir).length, 0);

  // 合法笔记：放行 + 记一条 allow
  const okFile = join(dir, 'reference-audit-demo.md');
  const body = [
    '---',
    'name: reference-audit-demo',
    'description: 审计测试用的合法笔记',
    'type: reference',
    'scope: global',
    'created: 2026-10-14',
    'updated: 2026-10-14',
    '---',
    '',
    '# 审计测试',
  ].join('\n');
  assert.equal(guard({ name: 'write', arguments: { file_path: okFile, content: body } }), undefined);
  let entries = readAudit(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict, 'allow');
  assert.equal(entries[0].tool, 'write');
  assert.equal(entries[0].file, 'reference-audit-demo.md');
  assert.equal(entries[0].epoch, GUARD_EPOCH);
  assert.ok(entries[0].bytes > 0);

  // 坏文件名：拒绝 + 记一条 deny（带理由）
  const reason = guard({ name: 'edit', arguments: { file_path: join(dir, 'notes.md'), new_string: 'y' } });
  assert.equal(typeof reason, 'string');
  entries = readAudit(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].verdict, 'deny');
  assert.equal(entries[0].tool, 'edit');
  assert.ok(entries[0].reason.includes('文件名'));

  // 新记录在前（readAudit 反序）
  assert.ok(entries[0].ts >= entries[1].ts);

  rmSync(dir, { recursive: true, force: true });
});

// ── 沉淀提醒：长会话零写入时提醒一次（2026-10-14 加） ──────────────────
/** 跑一轮 pre-step，返回「本轮新注入的消息」数组。 */
async function runTurn(handler, id, text) {
  const decision = { kind: 'enter', messages: [human(id, text)] };
  const out = await handler({}, async () => decision);
  return out.messages.slice(decision.messages.length);
}

const hasSediment = (injected) =>
  injected.some((m) => (m.content ?? []).some((part) => String(part?.text ?? '').includes('沉淀提醒')));

test('沉淀提醒：轮次不够时一个字都不注入，够了且零写入才提醒一次', async () => {
  const dir = fixtureStore();
  // sedimentMinTurns 默认 12；这里用默认值验证门槛本身
  const { handler, routes } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 2 });

  // 前 11 轮：查询各不相同（避开注入去重），且在库里查不到（避开命中干扰）
  for (let i = 0; i < 11; i += 1) {
    const injected = await runTurn(handler, `h${i}`, `库里不存在的提问第${i}号，问的是别的事情`);
    assert.equal(hasSediment(injected), false, `第 ${i + 1} 轮不该有沉淀提醒`);
  }

  // 第 12 轮：越过门槛，且本会话零写入 → 提醒一次
  const twelfth = await runTurn(handler, 'h11', '库里不存在的提问第11号，问的是别的事情');
  assert.equal(hasSediment(twelfth), true, '第 12 轮应当出现沉淀提醒');
  assert.ok(twelfth.length >= 1);

  // 第 13 轮：冷却期内不再提醒
  const thirteenth = await runTurn(handler, 'h12', '库里不存在的提问第12号，问的是别的事情');
  assert.equal(hasSediment(thirteenth), false, '冷却期内不该重复提醒');

  // 面板看得到：日志里留了一条 kind='sediment'
  const res = captureResponse();
  await routes.find((r) => r.path === '/api/engramory-recall/state').handler({ method: 'GET', url: '/api/engramory-recall/state' }, res);
  const body = JSON.parse(res.body);
  assert.ok(body.log.some((entry) => entry.kind === 'sediment' && entry.sediment === true), '日志里应当有 sediment 记录');
  assert.equal(body.config.nudgeSediment, true);
  assert.equal(body.config.sedimentMinTurns, 12);

  rmSync(dir, { recursive: true, force: true });
});

test('沉淀提醒：本会话写过记忆库之后就不再提醒', async () => {
  const dir = fixtureStore();
  const { handler, guards } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 2, sedimentMinTurns: 2 });

  // 一次合法写入 → storeWrites + 1
  const body = ['---', 'name: reference-sediment', 'description: 沉淀提醒测试', 'type: reference', '---', '', '# 测试'].join('\n');
  assert.equal(
    guards[0]({ name: 'write', arguments: { file_path: join(dir, 'reference-sediment.md'), content: body } }),
    undefined,
  );

  // 之后即使轮次远超门槛，也不该再提醒
  for (let i = 0; i < 5; i += 1) {
    const injected = await runTurn(handler, `w${i}`, `写过之后的第${i}号提问，库里同样不存在`);
    assert.equal(hasSediment(injected), false, '写过记忆库之后不该再有沉淀提醒');
  }

  rmSync(dir, { recursive: true, force: true });
});

test('沉淀提醒：nudgeSediment=false 时彻底关闭', async () => {
  const dir = fixtureStore();
  const { handler } = captureHandler({ storePath: dir, minScore: 0, maxPointers: 2, sedimentMinTurns: 1, nudgeSediment: false });
  for (let i = 0; i < 3; i += 1) {
    const injected = await runTurn(handler, `x${i}`, `关闭开关后的第${i}号提问，库里不存在`);
    assert.equal(hasSediment(injected), false);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('配置：storePath 支持 ~ 展开（别人装插件时不会恰好也叫同一个用户名）', async () => {
  const dir = fixtureStore();
  const home = homedir();
  const { routes } = captureHandler({ storePath: '~/memory/engramory', minScore: 0 });
  const res = captureResponse();
  await routes.find((r) => r.path === '/api/engramory-recall/state').handler({ method: 'GET', url: '/api/engramory-recall/state' }, res);
  const body = JSON.parse(res.body);
  // 断言的是「展开成了真实家目录」而不是硬编码用户名
  assert.equal(body.store, join(home, 'memory', 'engramory'));
  assert.ok(!body.store.includes('~'), '不该把 ~ 原样传给 fs');
  rmSync(dir, { recursive: true, force: true });
});

// ── 归档执行接口 ────────────────────────────────────────────────────

/** 造一个够大、够多批次的笔记，专门用来触发归档计划。 */
function archivableStore() {
  const dir = fixtureStore();
  writeFileSync(join(dir, 'MEMORY.md'), [
    '# Memory Index',
    '',
    '- [代理节点](reference-proxy.md) — Hy2 双端口',
    '- [流水线](project-cicd.md) — Jenkins',
    '- [大日志](project-big.md) — 追加式批次',
  ].join('\n'));
  const batches = [];
  for (let n = 1; n <= 5; n += 1) {
    batches.push(`## 第 ${n} 批：第${n}次迭代`, '', `记录${n}：${'填'.repeat(5000)}`);
  }
  writeFileSync(join(dir, 'project-big.md'), [
    '---',
    'name: project-big',
    'description: 追加式批次日志，用来验证物理分层归档',
    'type: project',
    '---',
    '',
    '# 大日志',
    '',
    '这里只放结论与现状。',
    '',
    ...batches,
  ].join('\n\n'));
  return dir;
}

/** 伪造一个可读的 POST 请求体：先注册监听，再在微任务里灌数据。 */
function postReq(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const listeners = {};
  const req = {
    method: 'POST',
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; },
    destroy() {},
  };
  queueMicrotask(() => {
    for (const fn of listeners.data || []) fn(Buffer.from(text, 'utf8'));
    for (const fn of listeners.end || []) fn();
  });
  return req;
}

test('归档接口：非 POST 拒绝，缺 confirm 拒绝，未知文件拒绝', async () => {
  const dir = archivableStore();
  try {
    const { routes } = captureHandler({ storePath: dir });
    const route = routes.find((r) => r.path === '/api/engramory-recall/archive');
    assert.ok(route, '应当注册归档接口');

    const wrongMethod = captureResponse();
    await route.handler({ method: 'GET' }, wrongMethod);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');

    // confirm 不是走过场：归档会改真实文件，没有它一律拒
    const noConfirm = captureResponse();
    await route.handler(postReq({ file: 'project-big.md' }), noConfirm);
    assert.equal(noConfirm.status, 400);
    assert.match(JSON.parse(noConfirm.body).reason, /confirm/);
    assert.ok(existsSync(join(dir, 'project-big.md')), '被拒的请求绝不能动文件');

    const unknown = captureResponse();
    await route.handler(postReq({ file: '不存在的.md', confirm: true }), unknown);
    assert.equal(unknown.status, 404);

    const notYet = captureResponse();
    await route.handler(postReq({ file: 'reference-proxy.md', confirm: true }), notYet);
    assert.equal(notYet.status, 404, '小笔记没到线，不该有可执行计划');

    const badJson = captureResponse();
    await route.handler(postReq('{不是 json'), badJson);
    assert.equal(badJson.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('归档接口：确认后真的分层，且备份、审计、计划刷新都跟上', async () => {
  const dir = archivableStore();
  try {
    const { routes } = captureHandler({ storePath: dir });
    const stateRoute = routes.find((r) => r.path === '/api/engramory-recall/state');
    const archiveRoute = routes.find((r) => r.path === '/api/engramory-recall/archive');

    const before = captureResponse();
    await stateRoute.handler({ method: 'GET' }, before);
    const plans = JSON.parse(before.body).archive.plans;
    assert.equal(plans.length, 1, '应当只有大日志一篇可归档');
    assert.equal(plans[0].file, 'project-big.md');
    assert.ok(plans[0].freshCount >= 3);

    const res = captureResponse();
    await archiveRoute.handler(postReq({ file: 'project-big.md', confirm: true }), res);
    assert.equal(res.status, 200);
    const outcome = JSON.parse(res.body);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.moved, 5);
    assert.ok(outcome.savedBytes > 0, '主文件应当变小');

    // ① 归档文件真的落盘，且批次原文一字不少
    const history = join(dir, outcome.historyFiles[0]);
    assert.ok(existsSync(history), '应当写出归档文件');
    const historyText = readFileSync(history, 'utf8');
    for (let n = 1; n <= 5; n += 1) assert.ok(historyText.includes(`## 第 ${n} 批：第${n}次迭代`));

    // ② 主文件只剩结论 + 指针，批次章节已搬走
    const mainText = readFileSync(join(dir, 'project-big.md'), 'utf8');
    assert.ok(mainText.includes('这里只放结论与现状。'), '结论必须留在主文件');
    assert.ok(!mainText.includes('## 第 5 批'), '批次章节不该还在主文件');
    assert.ok(mainText.includes(outcome.historyFiles[0]), '主文件要留下指向归档的指针');

    // ③ 搬之前备份过原件
    assert.ok(outcome.backupDir && existsSync(outcome.backupDir), '应当有备份目录');
    assert.ok(readFileSync(join(outcome.backupDir, 'project-big.md'), 'utf8').includes('## 第 5 批'),
      '备份里必须是搬走之前的完整原件');

    // ④ 归档是「落在记忆库里的写」，写入审计必须留痕
    const audit = readAudit(dir, 10);
    const entry = audit.find((e) => e.tool === 'archive');
    assert.ok(entry, '归档应当进写入审计');
    assert.equal(entry.verdict, 'allow');
    assert.equal(entry.file, 'project-big.md');
    assert.match(entry.reason, /搬走 5 个批次/);

    // ⑤ 缓存要失效：再取一次状态，计划应当已经没了
    const after = captureResponse();
    await stateRoute.handler({ method: 'GET' }, after);
    assert.equal(JSON.parse(after.body).archive.plans.length, 0, '归档完就不该再出计划');

    // ⑥ 幂等：同一篇再来一次应当被拒，而不是把归档文件再归档一遍
    const again = captureResponse();
    await archiveRoute.handler(postReq({ file: 'project-big.md', confirm: true }), again);
    assert.equal(again.status, 404, '重复归档必须被拒');
    assert.equal(readdirSync(dir).filter((f) => f.includes('-history')).length, outcome.historyFiles.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动归档：默认关着时一次文件系统都不碰', async () => {
  const dir = archivableStore();
  try {
    const { handler } = captureHandler({ storePath: dir });
    await handler({}, async () => ({ kind: 'enter', messages: [human('a1', '代理节点怎么搭的')] }));
    assert.equal(readdirSync(dir).filter((f) => f.includes('-history')).length, 0, '关着还归档了');
    assert.equal(readAudit(dir).filter((e) => e.tool === 'archive').length, 0);
    // 配置回显也要如实说是关的，面板才能提示「每次都要手点」。
    const route = captureHandler({ storePath: dir }).routes.find((r) => r.path === '/api/engramory-recall/state');
    const res = captureResponse();
    await route.handler({ method: 'GET' }, res);
    assert.equal(JSON.parse(res.body).config.autoArchive, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动归档：开着时 pre-step 兜底会真的搬，并留下审计与日志', async () => {
  const dir = archivableStore();
  try {
    const { handler, routes } = captureHandler({ storePath: dir, autoArchive: true });
    const before = readFileSync(join(dir, 'project-big.md'), 'utf8').length;
    await handler({}, async () => ({ kind: 'enter', messages: [human('a2', '代理节点怎么搭的')] }));

    const hist = readdirSync(dir).filter((f) => f.includes('-history'));
    assert.ok(hist.length > 0, '开着却没归档');
    assert.ok(readFileSync(join(dir, 'project-big.md'), 'utf8').length < before, '主文件没变小');
    // 原件必须还在备份里 —— 这是「可逆」的凭据，比任何日志都硬。
    const backupRoot = join(dir, '.archive-backup');
    assert.ok(readdirSync(backupRoot).length === 1, '没留备份');
    const backupDir = join(backupRoot, readdirSync(backupRoot)[0]);
    assert.ok(readFileSync(join(backupDir, 'project-big.md'), 'utf8').length === before, '备份不是搬运前的原件');

    // 审计：放行，且 reason 里写明是自动、触发源是 pre-step
    const arch = readAudit(dir).filter((e) => e.tool === 'archive');
    assert.equal(arch.length, 1);
    assert.equal(arch[0].verdict, 'allow');
    assert.ok(arch[0].reason.includes('自动归档'), arch[0].reason);
    assert.ok(arch[0].reason.includes('pre-step'), arch[0].reason);

    // 日志：kind=archive-auto，面板「记忆」页签能看见
    const stateRoute = routes.find((r) => r.path === '/api/engramory-recall/state');
    const res = captureResponse();
    await stateRoute.handler({ method: 'GET' }, res);
    const snap = JSON.parse(res.body);
    const auto = snap.log.filter((e) => e.kind === 'archive-auto');
    assert.equal(auto.length, 1);
    assert.ok(auto[0].reason.includes('搬走'));

    // 计划已经作废：现场重算应当是空（缓存不该还留着旧计划）
    assert.deepEqual(snap.archive.plans, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动归档：pre-step 有 10 分钟 TTL，不会每轮都扫一遍库', async () => {
  const dir = archivableStore();
  try {
    const { handler } = captureHandler({ storePath: dir, autoArchive: true });
    const turn = (id) => handler({}, async () => ({ kind: 'enter', messages: [human(id, '代理节点怎么搭的')] }));
    await turn('b1');
    const after = readdirSync(dir).filter((f) => f.includes('-history')).length;
    assert.ok(after > 0);
    // 后面几轮不该再多出归档文件（TTL 挡住了重复扫描）；即便漏挡，幂等性也会挡住重复搬运。
    await turn('b2');
    await turn('b3');
    assert.equal(readdirSync(dir).filter((f) => f.includes('-history')).length, after);
    assert.equal(readAudit(dir).filter((e) => e.tool === 'archive').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动归档：写完记忆库那一刻也会触发（触发源记为 write）', async () => {
  const dir = archivableStore();
  try {
    const { guards } = captureHandler({ storePath: dir, autoArchive: true });
    const body = [
      '---',
      'name: reference-touch',
      'description: 自动归档的 write 触发源测试',
      'type: reference',
      'created: 2026-10-14',
      'updated: 2026-10-14',
      '---',
      '',
      '# 随手一写',
    ].join('\n');
    assert.equal(guards[0]({ name: 'write', arguments: { file_path: join(dir, 'reference-touch.md'), content: body } }), undefined);
    const arch = readAudit(dir).filter((e) => e.tool === 'archive');
    assert.equal(arch.length, 1, '写完没有触发自动归档');
    assert.ok(arch[0].reason.includes('write'), arch[0].reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 语料指纹 ──────────────────────────────────────────────────────
// 这组用例守的是一件事：**指纹必须真的跟着内容变**。如果哪天有人图省事改成只哈希 id
// 或只哈希文件名，指纹就会对内容编辑无感 —— 而它存在的唯一理由就是「告诉你卷子换了」。
// 一个对变化无感的指纹，比没有指纹更糟：它会让人以为两次分数可比。

test('语料指纹：顺序无关（同一批 chunk 换个顺序，指纹不变）', () => {
  const docs = [
    { id: 'a.md', body: '甲' },
    { id: 'b.md', body: '乙' },
  ];
  assert.equal(corpusFingerprint(docs), corpusFingerprint([...docs].reverse()));
});

test('语料指纹：内容改一个字就变（否则它无法承担「卷子换了」的告警）', () => {
  const before = [{ id: 'a.md', body: '甲' }, { id: 'b.md', body: '乙' }];
  const after = [{ id: 'a.md', body: '甲' }, { id: 'b.md', body: '乙丙' }];
  assert.notEqual(corpusFingerprint(before), corpusFingerprint(after));
});

test('语料指纹：只是「同样内容的另一个 chunk 集合」也算变（条数变了）', () => {
  const one = [{ id: 'a.md', body: '甲' }];
  const two = [{ id: 'a.md', body: '甲' }, { id: 'a.md', body: '甲' }];
  assert.notEqual(corpusFingerprint(one), corpusFingerprint(two));
});

test('语料指纹：索引用到的每个字段都要算进去（尤其是 aliases）', () => {
  // 这条守的是一个真实踩过的坑：第一版只哈希 id + body，于是「只给笔记加 aliases」
  // 时指纹不变 —— 而 aliases 会被计两遍、实打实改变排序。探针就会报告「语料没变，
  // 这次是可信的代码 A/B」，把一次语料改动伪装成代码改动。
  const base = { id: 'a.md', title: '标题', description: '描述', aliases: '', body: '正文' };
  const fp = (patch) => corpusFingerprint([{ ...base, ...patch }]);
  const ref = fp({});
  assert.notEqual(fp({ aliases: '梯子' }), ref, 'aliases 变了指纹必须变');
  assert.notEqual(fp({ title: '换个标题' }), ref, 'title 变了指纹必须变');
  assert.notEqual(fp({ description: '换个描述' }), ref, 'description 变了指纹必须变');
  assert.notEqual(fp({ body: '换个正文' }), ref, 'body 变了指纹必须变');
  assert.equal(fp({}), ref, '同一个 chunk 重复算应当稳定');
});

test('语料指纹：不泄露正文（长度固定、十六进制，且不等于正文本身）', () => {
  const fp = corpusFingerprint([{ id: 'secret.md', body: '超级机密的正文内容' }]);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.ok(!fp.includes('机密'));
});

// ── 同义表本体 ────────────────────────────────────────────────────
// 这几条查的是**源码文本**而不是运行时行为，理由很具体：JS 对象字面量里重复的键会**静默
// 覆盖前一个**（严格模式也不报错），于是「给同一个键补了两次词」的净效果是第一次白写。
// 运行时看不出任何异常，`SYNONYMS.get()` 也只会给你最后那一份 —— 只有读源码才查得出来。
test('同义表：不能有重复的键（对象字面量重复键会静默覆盖）', () => {
  const src = readFileSync(new URL('../bm25.js', import.meta.url), 'utf8');
  const start = src.indexOf('export const SYNONYMS');
  assert.ok(start > 0, '应当能从源码里定位 SYNONYMS');
  const body = src.slice(start, src.indexOf('\n]);', start));
  const keys = [...body.matchAll(/^ {4}(\S+?):\s*\[/gm)].map((m) => m[1]);
  assert.ok(keys.length > 50, `应当解析出全部键，实际只解析到 ${keys.length} 个`);
  const seen = new Map();
  const dup = [];
  for (const k of keys) {
    if (seen.has(k)) dup.push(k);
    seen.set(k, true);
  }
  assert.deepEqual(dup, [], `这些键写了两遍，前一份被静默覆盖：${dup.join(', ')}`);
});

test('同义表：每个值都不为空、不含空白（值会先过 tokenize，空白会切出碎片）', () => {
  for (const [key, values] of SYNONYMS) {
    for (const v of values) {
      assert.ok(String(v).trim() === String(v) && String(v).length > 0, `${key} 的值 "${v}" 带空白或是空的`);
    }
  }
});

test('同义表：查询扩展出来的词项，必须是分词器认得的形状', () => {
  // 这条守的是那个藏了很久的真 bug：中文同义词原样返回时，它永远匹配不上
  // 「英文整词 + 汉字相邻双字」的词项形状 —— 写了等于没写，且不报错。
  const expanded = expandQuery('浏览器起不来');
  assert.ok(expanded.includes('chrome'), '应当桥到 chrome');
  assert.ok(expanded.some((t) => t.startsWith('不可') || t.startsWith('可用')), '应当桥出汉字双字');
  assert.ok(!expanded.includes('不可用'), '不得把整词「不可用」当词项 —— 它永远查不到');
});

test('不值得检索时给出的原因码（落盘日志靠它回答「这轮为什么没注入」）', () => {
  assert.equal(searchableReason('继续'), 'chitchat');
  assert.equal(searchableReason('好的'), 'chitchat');
  // 寒暄表是整句锚定的：带上正事的「好了，帮我看下部署脚本」不是寒暄
  assert.equal(searchableReason('好了，帮我看下部署脚本'), '');
  assert.equal(searchableReason('ab'), 'too-short');
  assert.equal(searchableReason('   '), 'empty-message');
  assert.equal(searchableReason('帮我看下部署脚本'), '');
  assert.equal(isSearchable('帮我看下部署脚本'), true);
  // 两种「不检索」的码必须能分开：一个是设计（寒暄），一个可能是 queryChars 太小
  assert.notEqual(searchableReason('继续'), searchableReason('ab'));
});
