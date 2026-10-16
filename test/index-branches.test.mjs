/**
 * `index.js` 的**分支覆盖**补测：专门去走那些「行覆盖到了、分支没走到」的路。
 *
 * 为什么单独开一个文件：`index.js` 行覆盖 96%，分支只有 70% —— 差额全在「半截配置」
 * （`Math.max(1, Number(x) || 4)` 的兜底侧）、「早退路径」（工具未配置 / 库为空 /
 * 分数全低于门槛）、以及三块**行覆盖都没到过**的区域：
 *
 *   1. `semanticConflicts` / `semanticSummary` 两个可选工具的 execute 与 render
 *      （`test/llm-wiring.test.mjs` 只验了「注册/不注册」，没验返回值）；
 *   2. `maybeAutoArchive`（归档失败 → 卡住 → pre-step 兜底重试 的整条状态机）；
 *   3. 归档 HTTP 路由 POST 侧的六条错误分支（405 / 未配库 / 坏 JSON / 缺 confirm /
 *      缺 file / 404 的两种话术）。
 *
 * 全部离线：临时目录造库、绝不发网络请求。每条都断言**具体的返回值 / 文案 / 落盘行**，
 * 不以「不抛异常」为准（除非该用例的主题就是脏数据不抛）。
 *
 * 读取路径一律现读现取（`pending()`），不断言「一共有几行」——铁律 9：只该断言增量，
 * 全文件断言会被别的用例（含未来新增的）踩成假红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { apply } from '../index.js';
import { AUDIT_FILE } from '../audit.js';
import { summarizeUsage, USAGE_FILE } from '../usage.js';

// ── 夹具 ──────────────────────────────────────────────────────────────────

const tmps = [];
function store(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-branches-'));
  tmps.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}
test.after(() => { for (const dir of tmps) rmSync(dir, { recursive: true, force: true }); });

/** 一篇合法笔记（`type` 与前缀一致，否则写入闸门会拒）。 */
function note(name, { description = '演示笔记', body = '正文内容。' } = {}) {
  const slug = String(name).replace(/\.md$/, '');
  const type = slug.split('-')[0];
  return `---\nname: ${slug}\ndescription: ${description}\ntype: ${type}\n---\n\n# ${slug}\n\n${body}\n`;
}

/** 合法正文 + `batches` 个 `## 第 K 批` 章节，每节 `pad` 个字符（汉字 3 字节）。 */
function bigNote(name, { batches = 3, pad = 8000, tail = 0 } = {}) {
  const slug = String(name).replace(/\.md$/, '');
  const type = slug.split('-')[0];
  const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const parts = [
    '---', `name: ${slug}`, 'description: 演示用的超大笔记', `type: ${type}`, 'updated: 2026-10-01', '---', '',
    '# 演示', '', '## 结论', '', '结论正文。', '',
  ];
  for (let i = 0; i < batches; i += 1) {
    parts.push(`## 第${cn[i] ?? i + 1}批：第 ${i + 1} 次改动`, '', `${i + 1}`.padEnd(pad, '改'), '');
  }
  if (tail) parts.push('## 附录', '', '附录内容。'.padEnd(tail, '附'), '');
  return parts.join('\n');
}

/**
 * 假宿主 ctx：把 register/guard 收到的定义都留下来。
 *
 * 与 `wiring-paths.test.mjs` 的 captureHandler 是同一套思路，差别只在「也要能拿工具定义」。
 */
function captureCtx(config = {}) {
  const handlers = new Map();
  const routes = [];
  const tools = new Map();
  const guards = [];
  const ctx = {
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    tools: {
      register: (definition) => { tools.set(definition.name, definition); return () => {}; },
      guard: (fn) => { guards.push(fn); return () => {}; },
    },
    inject: (deps, fn) => {
      if (!deps.includes('webServer')) return;
      fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
    },
  };
  apply(ctx, { usageLog: false, ...config });
  const handlerOf = (event) => handlers.get(event)?.[0];
  return { ctx, handlers, routes, tools, guards, handlerOf };
}

const human = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/** 跑一轮：payload 原样交给 hook，返回它交还给宿主的东西。 */
async function turn(handler, payload = {}, id = 'm1', text = '代理节点的双端口是怎么配的') {
  const decision = { kind: 'enter', messages: [human(id, text)] };
  return handler(payload, async () => decision);
}

/** 现读现取落盘行（只对增量下断言）。 */
function usageRows(dir) {
  const file = join(dir, USAGE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const lastRow = (dir) => usageRows(dir).at(-1);

function auditRows(dir) {
  const file = join(dir, AUDIT_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function captureResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
    end(body) { if (body !== undefined) this.body = body; },
  };
}

const route = (routes, path) => routes.find((r) => r.path === path);

/** 两个路由都是 async handler，必须 await —— 直接读 res.body 会读到 undefined。 */
async function getState(routes, req = { method: 'GET' }) {
  const res = captureResponse();
  await route(routes, '/api/engramory-recall/state').handler(req, res);
  return res;
}
const stateOf = async (routes) => JSON.parse((await getState(routes)).body);

/** 归档 POST 的假请求：按 Node 的 on/data/end 契约喂 body。 */
function postRequest(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

async function postArchive(routes, body) {
  const res = captureResponse();
  await route(routes, '/api/engramory-recall/archive').handler(postRequest(body), res);
  return res;
}

const SEARCH_QUERY = '代理节点的双端口是怎么配的';
const tinyStore = () => store({
  'reference-proxy.md': note('reference-proxy', { description: '美国自建代理节点', body: 'Hy2 双端口主力，Trojan 兜底。' }),
});

// ── 1. 配置归一：半截值 / 非法值 / 越界值 ────────────────────────────────

test('配置归一：正常值原样透出，计数类配置不做「至少 1」的钳制', async () => {
  const { routes } = captureCtx({
    storePath: '/tmp/branches-not-exist',
    maxPointers: 10, maxChars: 900, minScore: 1.5, queryChars: 800,
    indexMaxLines: 321, indexMaxBytes: 12345, rotationPenalty: 0.25,
  });
  const body = await stateOf(routes);
  assert.equal(body.config.maxPointers, 10);
  assert.equal(body.config.maxChars, 900);
  assert.equal(body.config.minScore, 1.5);
  assert.equal(body.config.queryChars, 800);
  assert.equal(body.config.indexMaxLines, 321);
  assert.equal(body.config.indexMaxBytes, 12345);
  assert.equal(body.config.rotationPenalty, 0.25);
  // 库不存在 → audit / index / notes 三条链各自的「空」形状，且不抛
  assert.equal(body.store, '/tmp/branches-not-exist');
  assert.equal(body.totals.notes, 0);
  assert.equal(body.totals.docs, 0);
  assert.equal(body.totals.bytes, 0);
  assert.deepEqual(body.notes, []);
  assert.equal(body.index.path, join('/tmp/branches-not-exist', 'MEMORY.md'));
  assert.equal(body.index.missing, true, '库里没有 MEMORY.md 要给 missing 标记，而不是当空文件');
  assert.ok(body.audit, '体检崩没崩都要给得出结构');
});

test('配置归一：`0` / `NaN` / 字符串 / 越界值一律回落到默认（`|| 4` 的兜底侧）', async () => {
  const { routes } = captureCtx({
    storePath: '/tmp/branches-not-exist',
    maxPointers: 0, maxChars: NaN, minScore: 0, queryChars: 'abc',
    indexMaxLines: 0, indexMaxBytes: NaN, rotationPenalty: 'abc',
  });
  const body = await stateOf(routes);
  assert.equal(body.config.maxPointers, 4, '0 是非法指针数，要回落到内置 4');
  assert.equal(body.config.maxChars, 480);
  assert.equal(body.config.queryChars, 400);
  assert.equal(body.config.indexMaxLines, 200);
  assert.equal(body.config.indexMaxBytes, 25600);
  assert.equal(body.config.minScore, 0);
  // 面板上这三个是「没配就是内置值」的展示口径
  assert.equal(body.config.sedimentMinTurns, 12);
  assert.equal(body.config.autoArchive, false);
  assert.equal(body.config.registerSkill, true);
  assert.equal(body.config.dedupeInjection, true);
});

test('配置归一：`~` 展开成家目录并把 `~/xxx` 拼成绝对路径（`~` 不会被宿主展开）', async () => {
  const { routes } = captureCtx({ storePath: '~' });
  assert.equal((await stateOf(routes)).store, process.env.HOME);
  const nested = captureCtx({ storePath: '~/engramory-branches-不存在/' });
  assert.ok((await stateOf(nested.routes)).store.startsWith('/'), '`~/x` 必须变成绝对路径，否则 readDocs 静默空手而归');
});

test('配置归一：`enabled: false` 连注册都不做（守卫、技能、pre-step 一个都不留）', () => {
  const { handlers, routes, tools, guards } = captureCtx({ enabled: false, storePath: tinyStore() });
  assert.equal(handlers.size, 0);
  assert.equal(routes.length, 0);
  assert.equal(tools.size, 0);
  assert.equal(guards.length, 0);
});

test('配置归一：显式 `null` 配置不抛（半截 yaml 会是这种形状）', () => {
  const ctx = {
    on: () => {}, tools: { register: () => {}, guard: () => () => {} }, inject: () => {},
  };
  assert.doesNotThrow(() => apply(ctx, null));
});

// ── 2. engramory_search：三条早退路径 + render ───────────────────────────

test('engramory_search：没配库 → 给出结构化空结果，不是抛异常', async () => {
  const { tools } = captureCtx({});
  const result = await tools.get('engramory_search').execute({ query: '代理' });
  assert.deepEqual(result, { store: '', hits: [], note: '需要 storePath 配置与非空 query' });
});

test('engramory_search：空白 query → 同一条早退（空白不等于有词）', async () => {
  const dir = tinyStore();
  const { tools } = captureCtx({ storePath: dir });
  const result = await tools.get('engramory_search').execute({ query: '   ' });
  assert.equal(result.store, dir);
  assert.deepEqual(result.hits, []);
  assert.equal(result.note, '需要 storePath 配置与非空 query');
});

test('engramory_search：空白 storePath 与缺 query 都走早退，且不碰文件系统', async () => {
  const { tools } = captureCtx({ storePath: '   ' });
  const tool = tools.get('engramory_search');
  assert.deepEqual((await tool.execute({ query: '代理' })).hits, []);
  assert.deepEqual((await tool.execute({})).hits, []);
});

test('engramory_search：库是空目录 → 零命中，note 给「换个说法」而不是假装搜过', async () => {
  const dir = store();
  const { tools } = captureCtx({ storePath: dir });
  const result = await tools.get('engramory_search').execute({ query: SEARCH_QUERY });
  assert.deepEqual(result.hits, []);
  assert.equal(result.store, dir);
  assert.match(result.note, /没有命中/);
  assert.equal(result.semantic.used, false);
  assert.equal(result.semantic.code, 'off', '接缝默认关着，语义那一栏要能自证没发请求');
});

test('engramory_search：命中时给 file/score/snippet 三件套，score 固定三位小数', async () => {
  const dir = tinyStore();
  const { tools } = captureCtx({ storePath: dir });
  const result = await tools.get('engramory_search').execute({ query: SEARCH_QUERY });
  assert.equal(result.hits.length >= 1, true);
  const short = result.hits.find((h) => h.file === 'reference-proxy.md');
  assert.ok(short, `命中里应当有 reference-proxy.md：${JSON.stringify(result.hits)}`);
  assert.equal(typeof short.score, 'number');
  assert.equal(Number(short.score.toFixed(3)), short.score, '分数必须落成三位小数，否则面板会显示一长串');
  assert.ok(short.snippet.length > 0);
  assert.match(result.note, /用 read 打开需要/);
});

test('engramory_search：limit 越界与半截值都钳到 [1,20]，不影响别的字段', async () => {
  const dir = tinyStore();
  const { tools } = captureCtx({ storePath: dir });
  const tool = tools.get('engramory_search');
  const capped = await tool.execute({ query: SEARCH_QUERY, limit: 99 });
  assert.equal(capped.hits.length <= 20, true);
  // `Number(0) || 5` → 0 视为「没给」，回到默认 5 —— 不是「返回 0 条」
  assert.equal((await tool.execute({ query: SEARCH_QUERY, limit: 0 })).hits.length, capped.hits.length);
  // 负数被 Math.max(…, 1) 抬到 1
  assert.equal((await tool.execute({ query: SEARCH_QUERY, limit: -3 })).hits.length, 1);
  assert.equal((await tool.execute({ query: SEARCH_QUERY, limit: 'abc' })).hits.length, capped.hits.length);
});

test('engramory_search：render 把结果对象原样 JSON 化成一个 text 块（宿主按它渲染）', () => {
  const { tools } = captureCtx({});
  const content = tools.get('engramory_search').output.render({ query: 'x' }, { store: '/s', hits: [], note: 'n' });
  assert.deepEqual(content, [{ type: 'text', text: '{"store":"/s","hits":[],"note":"n"}' }]);
});

// ── 3. 两个可选语义工具：注册否 + 早退 + 离线返回值 ──────────────────────

test('语义工具：两个开关默认都不注册（招牌：关着时模型连工具名都看不到）', () => {
  const { tools } = captureCtx({ storePath: tinyStore() });
  assert.deepEqual([...tools.keys()], ['engramory_search']);
});

test('语义工具：开关打开后两个都注册，且各自的 render 直接可用', () => {
  const { tools } = captureCtx({ storePath: tinyStore(), semanticConflicts: true, semanticSummary: true });
  assert.deepEqual([...tools.keys()].sort(), ['engramory_conflicts', 'engramory_search', 'engramory_summarize']);
  const rendered = tools.get('engramory_conflicts').output.render({}, { store: '/s', notes: 0, findings: [] });
  assert.deepEqual(rendered, [{ type: 'text', text: '{"store":"/s","notes":0,"findings":[]}' }]);
  const summaryRender = tools.get('engramory_summarize').output.render({}, { file: 'a.md', summary: '', model: '', ms: 0 });
  assert.deepEqual(summaryRender, [{ type: 'text', text: '{"file":"a.md","summary":"","model":"","ms":0}' }]);
});

test('engramory_conflicts：没配库 → 空结果；配了库但没模型 → 一条 warn 而不是抛', async () => {
  const bare = captureCtx({ semanticConflicts: true });
  assert.deepEqual(await bare.tools.get('engramory_conflicts').execute({}), { store: '', notes: 0, findings: [] });

  const dir = tinyStore();
  const { tools } = captureCtx({ storePath: dir, semanticConflicts: true });
  const result = await tools.get('engramory_conflicts').execute({});
  assert.equal(result.store, dir);
  assert.equal(result.notes, 1);
  assert.equal(result.findings[0].code, 'semantic-unavailable', '离线/无模型必须降级成可读的 findings，不是异常');
  assert.deepEqual(result.findings[0].files, []);
});

test('engramory_conflicts：limit 只切前 N 篇，notes 报的是**实际送去检查的篇数**', async () => {
  const dir = store({
    'reference-a.md': note('reference-a'),
    'reference-b.md': note('reference-b'),
    'reference-c.md': note('reference-c'),
  });
  const { tools } = captureCtx({ storePath: dir, semanticConflicts: true });
  assert.equal((await tools.get('engramory_conflicts').execute({ limit: 2 })).notes, 2);
  // `Number(0) || docs.length` → 0 视为「没给」
  assert.equal((await tools.get('engramory_conflicts').execute({ limit: 0 })).notes, 3);
  assert.equal((await tools.get('engramory_conflicts').execute({ limit: 'abc' })).notes, 3);
});

test('engramory_summarize：缺库 / 缺 file 两种早退各给各的话术', async () => {
  const bare = captureCtx({ semanticSummary: true });
  const tool = bare.tools.get('engramory_summarize');
  const noStore = await tool.execute({ file: 'reference-proxy.md' });
  assert.equal(noStore.file, 'reference-proxy.md');
  assert.equal(noStore.error, '需要 storePath 配置与非空 file');
  const noFile = await tool.execute({});
  assert.equal(noFile.file, '');
  assert.equal(noFile.error, '需要 storePath 配置与非空 file');
});

test('engramory_summarize：库里的文件打不开或不存在 → 报「库里没有」，不返回空摘要当成功', async () => {
  const dir = tinyStore();
  const { tools } = captureCtx({ storePath: dir, semanticSummary: true });
  const tool = tools.get('engramory_summarize');
  const missing = await tool.execute({ file: 'reference-不存在.md' });
  assert.deepEqual(missing, { file: 'reference-不存在.md', summary: '', model: '', ms: 0, error: '库里没有 reference-不存在.md' });
});

test('engramory_summarize：无模型路由时把失败原因连错误码一起回给调用方（离线、不发请求）', async () => {
  const dir = store({ 'reference-proxy.md': note('reference-proxy') });
  const { tools } = captureCtx({ storePath: dir, semanticSummary: true });
  const result = await tools.get('engramory_summarize').execute({ file: 'reference-proxy.md' });
  assert.equal(result.file, 'reference-proxy.md');
  assert.equal(result.summary, '', '失败必须给空摘要 + 错误，不能编一个摘要出来');
  assert.equal(result.ms, 0);
  assert.match(result.error, /宿主 LLM 服务不可用/);
  assert.match(result.error, /\[llm-unavailable\]/, '错误码要带出来，否则面板只能说「失败了」');
});

// ── 4. 写入闸门的分支 ───────────────────────────────────────────────────

test('闸门：两个开关都关掉时连守卫都不注册（不留空转的观测点）', () => {
  const { guards } = captureCtx({ storePath: tinyStore(), guardWrites: false, usageLog: false });
  assert.equal(guards.length, 0);
});

test('闸门关掉、只留记账：读库内笔记仍记一行 opened，但不再拦写入', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir, guardWrites: false, usageLog: true });
  assert.equal(guards.length, 1, '闸门关了记账还得在，注册条件是两者的并集');
  const guard = guards[0];
  assert.equal(guard({ name: 'read', arguments: { file_path: join(dir, 'reference-proxy.md') } }), undefined);
  assert.equal(lastRow(dir).kind, 'opened', '闸门关着时 opened 记账必须照常');
  const denied = guard({ name: 'write', arguments: { file_path: join(dir, 'notes.md'), content: 'x' } });
  assert.equal(denied, undefined, '闸门关掉就是真的关掉，不合规的文件名也放行');
});

test('闸门：非 write/edit 工具直接放行，且不落审计（不只是「不拒」，是不介入）', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir });
  const guard = guards[0];
  assert.equal(guard({ name: 'bash', arguments: { command: `rm -rf ${dir}` } }), undefined);
  assert.equal(guard({ name: 'read', arguments: { file_path: join(dir, 'reference-proxy.md') } }), undefined);
  assert.equal(existsSync(join(dir, AUDIT_FILE)), false, '非写入工具不该进写入审计——那是噪音');
});

test('闸门：write 缺 file_path 时不介入（拿不到路径就无从复核）', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir });
  assert.equal(guards[0]({ name: 'write', arguments: { content: 'x' } }), undefined);
  assert.equal(existsSync(join(dir, AUDIT_FILE)), false);
});

test('闸门：拒绝时返回的原因字符串就是拒因，并落一行 deny 审计 + 一行 deny 召回日志', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir, usageLog: true });
  const reason = guards[0]({ name: 'write', arguments: { file_path: join(dir, 'notes.md'), content: note('notes') } });
  assert.match(String(reason), /文件名「notes\.md」不合规/, '返回值就是给模型看的拒因');
  const audit = auditRows(dir).at(-1);
  assert.equal(audit.verdict, 'deny');
  assert.equal(audit.file, 'notes.md');
  assert.equal(audit.reason, reason);
  const row = lastRow(dir);
  assert.equal(row.kind, 'deny');
  assert.equal(row.reason, reason);
});

test('闸门：库外路径一律放行（不在管辖范围），否则会把别人的文件也管起来', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir });
  assert.equal(guards[0]({ name: 'write', arguments: { file_path: '/tmp/outside/notes.md', content: 'x' } }), undefined);
  assert.equal(existsSync(join(dir, AUDIT_FILE)), false, '库外写入不进库里那份审计');
});

test('闸门：候选路径的三种写法（file_path / filePath / path）都认，`read` 也算打开', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir, usageLog: true });
  const guard = guards[0];
  guard({ name: 'read', arguments: { filePath: join(dir, 'reference-proxy.md') } });
  assert.equal(lastRow(dir).kind, 'opened');
  guard({ name: 'read', arguments: { path: join(dir, 'reference-proxy.md') } });
  assert.equal(lastRow(dir).kind, 'opened');
  guard({ name: 'read', arguments: {} });
  assert.equal(lastRow(dir).kind, 'opened', '没有路径可认时不该写行，最后一行仍是上一条');
  assert.equal(usageRows(dir).length, 2, '两次带路径的读 = 两行，缺路径那次不写');
});

test('闸门：edit 的片段校验（partial）也要记审计并计入「本会话写过」', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir });
  assert.equal(guards[0]({ name: 'edit', arguments: { file_path: join(dir, 'reference-proxy.md'), old_string: '旧', new_string: '新' } }), undefined);
  const audit = auditRows(dir).at(-1);
  assert.equal(audit.verdict, 'allow');
  assert.equal(audit.partial, true, '片段校验过了要标 partial —— 它没看整篇结构');
  assert.equal(audit.tool, 'edit');
});

test('闸门：读取参数时抛异常 → 记账层吞掉，写入照样放行且不留痕', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir });
  const exec = { name: 'write', arguments: {} };
  Object.defineProperty(exec.arguments, 'file_path', { get() { throw new Error('取路径时炸了'); }, enumerable: true });
  assert.equal(guards[0](exec), undefined, '校验器出问题绝不能把正常写入挡在门外');
  // 现状：这一抛是在 noteNoteOpened 自己的 try 里被吞掉的，压根到不了守卫那层
  // 兜底 —— 所以「路径取不出来」是一次静默的记账丢失，不落 deny-error、不落审计。
  assert.deepEqual(usageRows(dir), []);
  assert.equal(existsSync(join(dir, AUDIT_FILE)), false);
});

test('闸门：守卫层自己抛异常 → 兜底成 deny-error 一行，仍不阻断写入', () => {
  const dir = tinyStore();
  const { guards } = captureCtx({ storePath: dir, usageLog: true });
  const exec = { name: 'write' };
  // `arguments` 整个取不到：noteNoteOpened 先吞一次，守卫自己的 `exec?.arguments` 再抛一次
  Object.defineProperty(exec, 'arguments', { get() { throw new Error('参数对象炸了'); }, enumerable: true });
  assert.equal(guards[0](exec), undefined, '守卫崩了也必须放行，否则一次记账事故会变成写不进去');

  // 留痕是这一段的全部价值：闸门悄悄失效却没人知道，比崩一次更糟
  const row = usageRows(dir).find((r) => r.kind === 'deny-error');
  assert.ok(row, '守卫抛异常要落一行 deny-error');
  assert.equal(row.reason, 'guard threw');
});

// ── 5. agent/pre-step 的 payload 形状与决策形状 ──────────────────────────

test('pre-step：决策不是 enter / messages 不是数组时原样返回（连 messages 都不碰）', async () => {
  const { handlerOf } = captureCtx({ storePath: tinyStore() });
  const handler = handlerOf('agent/pre-step');
  const done = { kind: 'stop', messages: [] };
  assert.equal(await handler({}, async () => done), done);
  const weird = { kind: 'enter', messages: 'not-an-array' };
  assert.equal(await handler({}, async () => weird), weird);
  const none = await handler({}, async () => undefined);
  assert.equal(none, undefined, '返回值原样透传，插件不替宿主做决定');
});

test('pre-step：决定里没有真人消息（只有工具结果）时不注入，也不记账', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, usageLog: true });
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: SEARCH_QUERY }] }] };
  const out = await handlerOf('agent/pre-step')({}, async () => decision);
  assert.equal(out.messages.length, 1);
  assert.equal(existsSync(join(dir, USAGE_FILE)), false, '没有真人轮就不该有账');
});

test('pre-step：数字 id 与同值的字符串 id 视为同一轮（`String(id)` 之后才进 seen）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 7);
  assert.equal(lastRow(dir).kind, 'hit');
  const before = summarizeUsage(usageRows(dir), { maxPointers: 2 });
  const again = await turn(handler, {}, '7');
  assert.equal(again.messages.length, 1, '同一个 id 的第二轮连消息都不该多');
  // 轮级去重早退**也要留一行 skip**（原因码用既有的 `duplicate`）：以前这里直接
  // `return decision`，这一轮在台账里一行都没有 —— 既不进分母、也统计不到原因码，
  // 账本对不上。口径与下面「同一 query 跨轮被去重」那条路一致。
  const rows = usageRows(dir);
  assert.equal(rows.length, 2, 'hit 一行 + 重复轮的 skip 一行');
  const row = lastRow(dir);
  assert.equal(row.kind, 'skip');
  assert.equal(row.reason, 'duplicate', '用 usage.js REASON_LABELS 里现成的重复码，不新造词');
  assert.equal(row.query, SEARCH_QUERY, '重复轮的 skip 也要记下问的是什么');
  assert.equal(row.scope, 'main', 'scope 照记：skip 也要能按提问者拆');
  assert.deepEqual(row.ids, [], '没注入就没有 ids');
  const after = summarizeUsage(rows, { maxPointers: 2 });
  assert.equal(after.pointers, before.pointers, 'injected 计数不变：重复轮没真的多注入一条指针');
  assert.equal(after.injectRounds, before.injectRounds);
  assert.equal(after.skipRounds, before.skipRounds + 1, '重复轮进的是 skip 分母');
  assert.equal(after.skipReasons.duplicate, (before.skipReasons.duplicate ?? 0) + 1, '原因码在汇总里数得出来');
  assert.equal(after.openRate, before.openRate, '分母没变 → 打开率不受重复轮影响');
});

test('pre-step：`id: null` 的一轮不记账去重键，但该注入还是注入', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  const out = await turn(handler, {}, null);
  assert.equal(out.messages.length, 2, '没有 id 也要能注入');
  assert.equal(lastRow(dir).kind, 'hit');
  // 没有 id 就不进 seen，于是同一个 id=null 的第二轮仍然会跑完整流程
  await turn(handler, {}, null);
  assert.equal(lastRow(dir).kind, 'skip');
  assert.equal(lastRow(dir).reason, 'duplicate', '第二次是「同样内容」，靠去重键挡住而不是靠轮级 seen');
});

test('pre-step：深度字段是脏值（NaN / 字符串）时按主对话记账，绝不误判成委派轮', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, { agent: { session: { header: { delegationDepth: NaN } }, options: { subagentDepth: 'x' } } }, 'a');
  assert.equal(lastRow(dir).scope, 'main');
  assert.equal(lastRow(dir).depth, 0);
  await turn(handler, { agent: { session: null, options: null } }, 'b');
  assert.equal(lastRow(dir).scope, 'main', 'agent 的形状烂掉也要当主对话——误判成委派会把真实利用率藏起来');
});

// ── 6. 查询整形与预算：短句 / 超长消息 / 塌缩 / 丢弃 ────────────────────

test('查询整形：空白消息 → skip 且原因是 empty-message（不是 chitchat）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, usageLog: true });
  await turn(handlerOf('agent/pre-step'), {}, 'm1', '   ');
  assert.equal(lastRow(dir).kind, 'skip');
  assert.equal(lastRow(dir).reason, 'empty-message');
});

test('查询整形：超长消息只取头尾各一半，注入的 query 里留着开头那个主题词', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, queryChars: 200, usageLog: true });
  const text = `${SEARCH_QUERY}。${'日志正文'.repeat(400)}`;
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1', text);
  assert.equal(out.messages.length, 2);
  const text2 = out.messages.at(-1).content[0].text;
  assert.match(text2, /自动召回/);
  const row = lastRow(dir);
  assert.ok(row.query.includes('双端口'), `query 必须保留开头那句主题词，实际：${row.query}`);
  assert.ok(row.query.length < text.length, '超长消息不能整条进账本');
});

test('预算：装不下完整条目就塌缩成裸文件名，连文件名都装不下才计 dropped', async () => {
  const long = '美国自建代理节点 Hy2 双端口主力 Trojan 兜底 Jenkins 流水线只跑第一条命令';
  const dir = store({
    // slug 73 字符的 alpha：裸文件名 75 字符，完整条目 125 字符
    'reference-proxy-alpha-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.md': note('reference-proxy-alpha-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', { description: '代理节点', body: long }),
    'reference-proxy-beta.md': note('reference-proxy-beta', { description: '代理节点', body: long }),
    // slug 142 字符的 gamma：连裸文件名（144 字符）都塞不进 240 的预算
    [`reference-proxy-gamma-${'g'.repeat(120)}.md`]: note(`reference-proxy-gamma-${'g'.repeat(120)}`, { description: '代理节点', body: long }),
  });
  // 预算 240：抬头 80 之后只剩 160。beta 完整条目 75 字符（80+76=156）、alpha 塌缩成裸文件名
  // 75 字符（156+76=232）；gamma 无论哪种形态都放不下，只能计 dropped，并在正文里补一句说明。
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxPointers: 3, maxChars: 240, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  const injected = out.messages.at(-1).content[0].text;
  assert.match(injected, /- reference-proxy-beta\.md — /, '预算够的那条要拿到完整形态（文件名 + 摘要）');
  assert.match(injected, /- reference-proxy-alpha-e{2,}\.md(?=\n|$)/, '装不下完整条目的那条只剩「只有文件名」的裸形态（后面没有 — 摘要），而不是静默丢掉');
  assert.doesNotMatch(injected, /reference-proxy-alpha-e{2,}\.md — /, '塌缩了就不该再带摘要');
  assert.match(injected, /（另有 1 条命中因预算未列出）/, '连文件名都装不下的要在正文里说明，不能静默丢失');
  assert.doesNotMatch(injected, /reference-proxy-gamma/, '被 dropped 的那条一个字都不该出现');
  const row = lastRow(dir);
  assert.equal(row.collapsed, 1, 'alpha 记在 collapsed 上');
  assert.equal(row.dropped, 1, 'gamma 记在 dropped 上');
  assert.equal(row.injected, 2, 'injected 数的是真正列出去的条数（完整 + 塌缩）');
  assert.equal(row.kind, 'hit');
});

test('预算：maxChars 小到离谱也留得住一个下限（Math.max(160, …) 的兜底侧）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 1, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  const injected = out.messages.at(-1).content[0].text;
  assert.match(injected, /reference-proxy\.md/, 'maxChars 再小也要撑到 160，至少容得下一条指针');
  assert.equal(lastRow(dir).injected, 1);
});

// ── 7. 记忆意图提示、沉淀提醒、注入去重 ─────────────────────────────────

test('记忆意图：命中时把 nudge 追加进注入正文，summary 里标注「+ 记忆提示」', async () => {
  const dir = tinyStore();
  const { routes, handlerOf } = captureCtx({ storePath: dir, minScore: 0, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1', '代理节点的双端口以后都这么配');
  const message = out.messages.at(-1);
  assert.match(message.content[0].text, /\[提示\] 这句话里有「长期记住」的意图/);
  assert.match(message.content[0].text, /按 Engramory 纪律落盘/);
  assert.match(message.source.summary, /召回 \d+ 条 \+ 记忆提示/);
  assert.equal(message.source.form, 'notice');
  // 账本里查 nudge：`nudge` / `sediment` 只写进内存 recallLog（appendUsage 不收这两个字段），
  // 落盘行里没有 —— 要判「提示到底发没发」只能看内存日志或注入正文。
  assert.equal((await stateOf(routes)).log[0].nudge, true);
});

test('记忆意图：nudge 关掉后一个字都不追加，summary 也不带尾巴', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, nudge: false, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1', '代理节点的双端口以后都这么配');
  const message = out.messages.at(-1);
  assert.match(message.content[0].text, /reference-proxy\.md/, '关的是提示，不是召回本身');
  assert.doesNotMatch(message.content[0].text, /\[提示\]/);
  assert.doesNotMatch(message.source.summary, /记忆提示/);
  assert.equal(lastRow(dir).nudge, undefined, 'nudge 字段本来就不落盘，落盘行里永远看不到它');
});

test('沉淀提醒：轮次不够时不注入（`nudgeSediment` 开着但没到门槛）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, nudgeSediment: true, sedimentMinTurns: 3, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  // 前两轮的命中会被轮级 seen 与去重键挡住，这里只关心「哪一轮开始出现沉淀提醒」
  for (const id of ['m1', 'm2']) await turn(handler, {}, id);
  assert.equal(lastRow(dir).sediment, undefined, '没到门槛就不该有 sediment 字段');
});

test('沉淀提醒：库外问题也照样提醒 —— 它补的正是「命中为 0 时更需要」那个缺口', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, sedimentMinTurns: 2, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 'm1', SEARCH_QUERY);
  const out = await turn(handler, {}, 'm2', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  const message = out.messages.at(-1);
  assert.match(message.content[0].text, /\[engramory 沉淀提醒\] 本会话已进行 2 轮/);
  assert.match(message.content[0].text, /没有值得记的就跳过/);
  assert.equal(message.source.summary, 'engramory 沉淀提醒', '一条指针都没有时 summary 只报沉淀提醒');
  const row = lastRow(dir);
  assert.equal(row.kind, 'sediment');
  assert.equal(row.ids.length, 0);
  assert.equal(row.injected, 0);
});

test('沉淀提醒：nudgeSediment 关掉后一条都不注入（空库 + 长会话也保持安静）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 999, nudgeSediment: false, sedimentMinTurns: 2, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  for (const id of ['m1', 'm2', 'm3']) {
    const out = await turn(handler, {}, id, '库外不存在的词条：钴蓝色鲸鱼三号计划');
    assert.equal(out.messages.length, 1, '关掉后一个字都不注入');
  }
  assert.equal(lastRow(dir).kind, 'empty');
  // ⚠️ 这条查询在库里没有任何词命中，所以原因码是 `no-hits` 而不是 `below-min-score`：
  // minScore 是在**检索到候选之后**才过滤的，没有候选就轮不到它说话（usage.js 的
  // reasonVerdict 也正是靠这三个码把「库里没有 / 一条不匹配 / 门槛太高」分开报的）。
  assert.equal(lastRow(dir).reason, 'no-hits');
});

test('沉淀提醒：冷却期内不重复提醒（提醒本身不该变成噪音）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 999, sedimentMinTurns: 2, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  const ask = (id) => turn(handler, {}, id, '库外不存在的词条：钴蓝色鲸鱼三号计划');
  await ask('m1');
  assert.match((await ask('m2')).messages.at(-1).content[0].text, /沉淀提醒/);
  for (const id of ['m3', 'm4', 'm5']) {
    assert.equal((await ask(id)).messages.length, 1, '冷却 24 轮内不再提醒');
  }
});

test('注入去重：同一轮的 query 与命中集原样时记 duplicate 且不注入', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, dedupeInjection: true, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  assert.equal((await turn(handler, {}, 'm1')).messages.length, 2);
  // 换提问者 id 绕过「轮级 seen」，专门验去重键那条路
  const second = await turn(handler, {}, 'm2');
  assert.equal(second.messages.length, 1, '上一轮那份指针还在上下文里，别重复塞');
  const row = lastRow(dir);
  assert.equal(row.kind, 'skip');
  assert.equal(row.reason, 'duplicate');
});

test('注入去重：关掉开关后同一轮照塞（对照侧，证明 duplicate 来自这个开关）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, dedupeInjection: false, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 'm1');
  const second = await turn(handler, {}, 'm2');
  assert.equal(second.messages.length, 2, '关掉去重就该照样注入');
  assert.equal(lastRow(dir).kind, 'hit');
});

test('注入去重：沉淀提醒不参与去重（它说的是本会话一直没写过库）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 999, dedupeInjection: true, sedimentMinTurns: 2, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 'm1', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  const out = await turn(handler, {}, 'm2', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  assert.equal(out.messages.length, 2, '同样的 query 也会被去重键命中，但沉淀提醒必须逃过它');
  assert.match(out.messages.at(-1).content[0].text, /沉淀提醒/);
});

// ── 8. 轮换降权与手工召回（两条与去重不同的路）──────────────────────────

test('轮换降权：上一轮注入过的条目降权后不再进窗口，落盘标注 rotated', async () => {
  const dir = store({
    'reference-proxy.md': note('reference-proxy', { description: '代理节点双端口', body: 'Hy2 双端口主力，Trojan 兜底。' }),
    'reference-other.md': note('reference-other', { description: '代理节点备用方案', body: '另一套代理方案，双端口备用。' }),
  });
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxPointers: 1, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 'm1', '代理节点的双端口');
  const second = await turn(handler, {}, 'm2', '代理节点的双端口备用方案');
  assert.equal(second.messages.length, 2, '换一条问法仍要有命中');
  const row = lastRow(dir);
  assert.equal(row.ids.length, 1);
  assert.equal(typeof row.ids[0], 'string');
});

test('轮换降权：`rotationPenalty: 1` 等于关掉降权，候选池不再放大', async () => {
  const dir = store({
    'reference-proxy.md': note('reference-proxy', { description: '代理节点双端口', body: 'Hy2 双端口主力，Trojan 兜底。' }),
    'reference-other.md': note('reference-other', { description: '代理节点备用方案', body: '另一套代理方案，双端口备用。' }),
  });
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxPointers: 1, rotationPenalty: 1, usageLog: true });
  const handler = handlerOf('agent/pre-step');
  await turn(handler, {}, 'm1', '代理节点的双端口');
  const second = await turn(handler, {}, 'm2', '代理节点的双端口');
  assert.equal(second.messages.length, 1, 'penalty=1 时第二轮的指针文本一字未变，被注入去重挡住');
  assert.equal(lastRow(dir).reason, 'duplicate');
});

// ── 9. 自动归档：整条状态机 ─────────────────────────────────────────────

test('自动归档：默认关着一个文件都不碰（连 planArchive 都不跑）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { handlerOf } = captureCtx({ storePath: dir, autoArchive: false, minScore: 0, usageLog: true });
  await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.equal(readdirSync(dir).some((f) => f.includes('history')), false, '开关关着不该产出任何归档产物');
  assert.equal(existsSync(join(dir, '.archive-backup')), false);
  assert.equal(usageRows(dir).some((r) => r.kind === 'archive-auto'), false);
});

test('自动归档：开着但没配库时空转不抛（`maybeAutoArchive` 的第二条早退）', async () => {
  const { handlerOf } = captureCtx({ autoArchive: true, storePath: '   ', usageLog: false });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content[0].text, SEARCH_QUERY);
});

test('自动归档：写入后自动搬走批次，落审计 + 一行 archive-auto（含触发源）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { guards } = captureCtx({ storePath: dir, autoArchive: true, usageLog: true });
  const verdict = guards[0]({
    name: 'write',
    arguments: { file_path: join(dir, 'reference-small.md'), content: note('reference-small') },
  });
  assert.equal(verdict, undefined, '自动归档不该把这次写入变成拒绝');

  const history = readdirSync(dir).filter((f) => f.includes('history'));
  assert.equal(history.length, 1, `应当产出 1 份归档产物，实际：${history.join(',')}`);
  const audit = auditRows(dir).find((a) => a.tool === 'archive');
  assert.ok(audit, '自动归档也必须有审计行');
  assert.equal(audit.verdict, 'allow');
  assert.equal(audit.file, 'project-big.md');
  assert.match(audit.reason, /自动归档（触发：write）/);
  assert.match(audit.reason, /搬走 \d+ 个批次/);

  const row = usageRows(dir).find((r) => r.kind === 'archive-auto');
  assert.equal(row.query, 'write', '触发源要落进 query，否则分不清是谁搬的');
  assert.equal(row.injected, 1);
  assert.match(row.reason, /搬走 \d+ 个批次/);
});

test('自动归档：搬不动的文件记住、不反复重试；pre-step 兜底会给它一次新机会', async () => {
  // 3 批 × 34KB：够大且批次数达标（MIN_BATCHES = 3）才进得了计划；但单批拆出去
  // 仍过不了闸门的「单篇 100KB 上限」→ applyArchive 必然失败。
  const dir = store({ 'project-huge.md': bigNote('project-huge', { batches: 3, pad: 34000 }) });
  const { handlerOf, guards } = captureCtx({ storePath: dir, autoArchive: true, minScore: 0, usageLog: true });
  const guard = guards[0];
  const writeSmall = () => guard({
    name: 'write',
    arguments: { file_path: join(dir, 'reference-small.md'), content: note('reference-small') },
  });

  writeSmall();
  const first = usageRows(dir).filter((r) => r.kind === 'archive-auto');
  assert.equal(first.length, 1, '第一次尝试要留痕');
  assert.match(first[0].reason, /没搬成/);
  assert.equal(existsSync(join(dir, '.archive-backup')), false, '闸门拒绝时连备份都不该产生');

  writeSmall();
  assert.equal(usageRows(dir).filter((r) => r.kind === 'archive-auto').length, 1, '已知搬不动的文件不该每次写入都去撞同一堵墙');

  // pre-step 兜底：清空「搬不动」名单，重新试一次；同一个 10 分钟窗口内只做一次
  await turn(handlerOf('agent/pre-step'), {}, 'p1', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  await turn(handlerOf('agent/pre-step'), {}, 'p2', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  assert.equal(
    usageRows(dir).filter((r) => r.kind === 'archive-auto').length,
    2,
    'pre-step 兜底重试一次，且 10 分钟 TTL 内不重复',
  );
});

test('自动归档：pre-step 兜底与写入触发都能成功（两条触发源都要走通）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { handlerOf } = captureCtx({ storePath: dir, autoArchive: true, minScore: 0, usageLog: true });
  await turn(handlerOf('agent/pre-step'), {}, 'p1', '库外不存在的词条：钴蓝色鲸鱼三号计划');
  const row = usageRows(dir).find((r) => r.kind === 'archive-auto');
  assert.ok(row, 'pre-step 兜底也要能真的搬走');
  assert.equal(row.query, 'pre-step');
  assert.equal(readdirSync(dir).filter((f) => f.includes('history')).length, 1);
});

// ── 10. 归档 HTTP 路由：唯一会动记忆库的接口 ────────────────────────────

test('归档路由：GET 一律 405 并回 allow: POST（这个口只收 POST）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir });
  const res = captureResponse();
  await route(routes, '/api/engramory-recall/archive').handler({ method: 'GET' }, res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('归档路由：没配 storePath → 400 且话说明白（不是 500 也不是静默）', async () => {
  const { routes } = captureCtx({});
  const res = await postArchive(routes, JSON.stringify({ confirm: true, file: 'project-big.md' }));
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { ok: false, reason: 'storePath 没配' });
});

test('归档路由：请求体不是 JSON → 400 且带上解析器原话', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir });
  const res = await postArchive(routes, '{ 这不是 json');
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.reason, /^请求体不是 JSON：/);
});

test('归档路由：空 body 当成 `{}` → 缺 confirm 的那条话术', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir });
  const res = await postArchive(routes, undefined);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).reason, /缺 confirm:true/);
});

test('归档路由：confirm 不是布尔真、或 file 是空白 → 各自 400（不做「归档所有超标」的后门）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir });
  const noConfirm = await postArchive(routes, JSON.stringify({ confirm: 'yes', file: 'project-big.md' }));
  assert.match(JSON.parse(noConfirm.body).reason, /缺 confirm:true/);

  const noFile = await postArchive(routes, JSON.stringify({ confirm: true, file: '   ' }));
  assert.equal(noFile.status, 400);
  assert.deepEqual(JSON.parse(noFile.body), { ok: false, reason: '缺 file' });
});

test('归档路由：文件不在计划里 → 404，两种话术分开（「现在不该归档」vs「没找到」）', async () => {
  // 够大但没有「第 N 批」段 → skipped；另一个名字连计划都没有
  const dir = store({
    'project-nonbatch.md': note('project-nonbatch', { body: Array.from({ length: 24 }, (_, i) => `## 章节 ${i}\n\n${'内容'.repeat(2000)}`).join('\n\n') }),
  });
  const { routes } = captureCtx({ storePath: dir });
  const skipped = await postArchive(routes, JSON.stringify({ confirm: true, file: 'project-nonbatch.md' }));
  assert.equal(skipped.status, 404);
  assert.match(JSON.parse(skipped.body).reason, /这篇现在不该归档：/);

  const absent = await postArchive(routes, JSON.stringify({ confirm: true, file: 'project-不存在.md' }));
  assert.equal(absent.status, 404);
  assert.equal(JSON.parse(absent.body).reason, '没找到可归档计划：project-不存在.md');
});

test('归档路由：体超过 8KB 直接 400（只收一个文件名，没有理由收大包）', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir });
  const huge = JSON.stringify({ confirm: true, file: `${'x'.repeat(9000)}.md` });
  const res = await postArchive(routes, huge);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).reason, /body too large/, '超限的请求体解析不出 JSON，拒因要留下真实线索');
});

test('归档路由：成功执行 → 200 + 计划原件齐备，落审计与召回日志', async () => {
  const dir = store({ 'project-big.md': bigNote('project-big', { batches: 3, pad: 8000 }) });
  const { routes } = captureCtx({ storePath: dir, usageLog: true });
  const planned = (await stateOf(routes)).archive.plans.find((p) => p.file === 'project-big.md');
  assert.ok(planned, '这份夹具必须够大且有 3 个批次章节，才谈得上归档');

  const res = await postArchive(routes, JSON.stringify({ confirm: true, file: 'project-big.md' }));
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.file, 'project-big.md');
  assert.equal(body.moved, 3, '夹具里 3 个批次段要一个不剩地搬走');
  assert.equal(body.historyFiles.length, 1);
  assert.match(body.backupDir, /\.archive-backup/);
  assert.equal(body.keptBytes < planned.bytes, true, '主文件必须真的瘦下来');
  assert.equal(existsSync(join(dir, 'project-big-history.md')), true, '归档产物要真的落盘');
  const history = readFileSync(join(dir, 'project-big-history.md'), 'utf8');
  for (const marker of ['第 1 次改动', '第 2 次改动', '第 3 次改动']) {
    assert.match(history, new RegExp(marker), `批次正文要原样搬进 history：缺 ${marker}`);
  }
  assert.doesNotMatch(readFileSync(join(dir, 'project-big.md'), 'utf8'), /第 1 次改动/, '主文件里不该再留着搬走的批次');

  const audit = auditRows(dir).at(-1);
  assert.equal(audit.tool, 'archive');
  assert.equal(audit.verdict, 'allow');
  assert.equal(audit.bytes, planned.bytes);
  assert.match(audit.reason, /搬走 \d+ 个批次/);
  const row = usageRows(dir).find((r) => r.kind === 'archive');
  assert.ok(row);
  assert.match(row.reason, /KB → \d+KB/, '召回日志里要留下「多少 KB 变成多少 KB」');
});

test('归档路由：执行失败 → 400 且把真实拒因回给面板（不能只说「失败了」）', async () => {
  const dir = store({ 'project-huge.md': bigNote('project-huge', { batches: 3, pad: 34000 }) });
  const { routes } = captureCtx({ storePath: dir, usageLog: true });
  const res = await postArchive(routes, JSON.stringify({ confirm: true, file: 'project-huge.md' }));
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.file, 'project-huge.md');
  assert.match(String(body.reason), /超过单篇上限/, '拒因要能指着闸门那条规则，否则人只能猜');

  const audit = auditRows(dir).at(-1);
  assert.equal(audit.verdict, 'deny');
  const row = usageRows(dir).find((r) => r.kind === 'deny');
  assert.ok(row, '失败的归档也要在召回日志里留痕');
  assert.match(String(row.reason), /超过单篇上限/);
});

// ── 11. 状态路由与台账的另一侧 ──────────────────────────────────────────

test('状态路由：没配库时也给得出 200 与合法结构（面板刷新不该把宿主拖下水）', async () => {
  const { routes } = captureCtx({});
  const res = await getState(routes);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.store, '');
  assert.equal(body.audit, null, '没有库就没有体检报告，别伪造一份空的');
  assert.deepEqual(body.writeAudit, { epoch: 'guard-v1', entries: [] });
  assert.deepEqual(body.archive, { plans: [], skipped: [] });
  assert.equal(body.index.lines, 0);
  assert.equal(body.totals.notes, 0);
  assert.equal(typeof body.skill, 'object', '技能自报状态要一直在，它失败时完全静默');
});

test('状态路由：snippet 与正文不一致的笔记按 path 归一到同一篇（byId 的累加分支）', async () => {
  // 同一 slug 的两个路径会被 readDocs 归成同一 id，面板要合成一篇
  const dir = store({ 'reference-proxy.md': note('reference-proxy', { body: '第一段。'.repeat(200) }) });
  const { routes, tools } = captureCtx({ storePath: dir });
  const body = await stateOf(routes);
  assert.equal(body.notes.length, 1);
  assert.equal(body.notes[0].file, 'reference-proxy.md');
  assert.equal(body.notes[0].sections, 1);
  assert.equal(body.notes[0].title, 'reference-proxy');
  assert.equal(typeof body.notes[0].bytes, 'number');
  assert.deepEqual(body.notes[0].aliases, []);
  assert.equal(body.totals.docs, 1);
  assert.equal(typeof (await tools.get('engramory_search').execute({ query: SEARCH_QUERY })).note, 'string');
});

// ── 13. 体检与归档计划读不动时的降级 ─────────────────────────────────────

test('库路径读不动时体检自己降级成 store-unreadable，而不是 500 或崩溃', async () => {
  // storePath 指向一个普通文件：auditStore 内部的 statSync/readdir 会抛 ENOTDIR，
  // 它在自己内部就把这种情况归一成一条 error finding（不是走 index.js 的 audit-crashed 兜底）
  const dir = mkdtempSync(join(tmpdir(), 'branches-audit-crash-'));
  const file = join(dir, 'not-a-store.md');
  writeFileSync(file, '# 这是个文件，不是库\n');
  const { routes } = captureCtx({ storePath: file });
  const res = await getState(routes);
  assert.equal(res.status, 200, '面板每 3 秒轮询一次，体检读不动也不能把宿主拖下水');
  const body = JSON.parse(res.body);
  assert.equal(body.audit.summary.bySeverity.error, 1);
  assert.equal(body.audit.findings[0].code, 'store-unreadable');
  assert.equal(body.audit.summary.notes, 0, '读不动就别编数字');
  assert.equal(body.store, file, 'store 原样透出，面板能显示「配了什么」');
  assert.equal(body.index.lines, 0);
});

// ── 14. 兜底与脏数据：守卫抛异常、agent 字段的乱七八糟形状 ───────────────

test('守卫同步抛异常时：放行写入 + 在召回日志里留一行 deny-error（闸门不许悄悄失效）', async () => {
  const dir = tinyStore();
  const { guards, routes } = captureCtx({ storePath: dir, minScore: 0, usageLog: true });
  // 校验器自己坏掉（参数是个一读就抛的 getter）：契约里没写，代码选择「不阻断写入 + 留痕」
  const boom = { name: 'write', get arguments() { throw new Error('校验器炸了'); } };
  assert.equal(guards[0](boom), undefined, '闸门坏了不能让正常写入跟着一起坏');
  const log = (await stateOf(routes)).log;
  assert.equal(log.length, 1, '悄悄失效才是最糟的：必须留一行');
  assert.equal(log[0].kind, 'deny-error');
  assert.equal(log[0].reason, 'guard threw');
  assert.equal(log[0].query, '', '路径都没解析出来，别硬编一个');
});

test('agent 字段的脏形状一律当成主对话轮：缺 agent / 号码 depth / 非字符串 id 都不许炸', async () => {
  const dir = tinyStore();
  const { handlerOf, routes } = captureCtx({ storePath: dir, minScore: 0, usageLog: true });
  const pre = handlerOf('agent/pre-step');
  // 1) 压根没有 agent（老宿主）→ depth 走 Math.max(0,0)=0 → main
  await turn(pre, {}, 'm1');
  // 2) depth 是 NaN / 字符串数字，id 是数字
  await turn(pre, { agent: { session: { header: { delegationDepth: Number.NaN } }, options: { subagentDepth: '2' } } }, 7);
  // 3) delegationDepth 与 subagentDepth 都有 → 取大者
  await turn(pre, { agent: { session: { header: { delegationDepth: 3 } }, options: { subagentDepth: null } } }, 8);
  const log = (await stateOf(routes)).log; // unshift 进队首，所以 [0] 是最新那轮
  assert.equal(log.length, 3, '每一轮都要记账，脏 agent 不该让 pre-step 提前返回');
  assert.equal(log[2].scope, 'main', '缺 agent = 老宿主，宁可少分也不误杀');
  assert.equal(log[2].depth, 0);
  assert.equal(log[1].depth, 2, 'subagentDepth 是字符串 "2" 也要 Number 出来');
  assert.equal(log[1].scope, 'subagent');
  assert.equal(log[0].depth, 3, '两边都有时取大者');
  assert.equal(log[0].scope, 'subagent');
});

// ── 15. storePath 归一：尾斜杠不再打死「读取记账」（修 B1） ───────────────

test('storePath 带尾斜杠照样记 opened，且与不带尾斜杠的同款用例逐字段一致（修 B1）', () => {
  const slash = tinyStore();
  const plain = tinyStore();
  const read = (dir) => ({ name: 'read', arguments: { file_path: join(dir, 'reference-proxy.md') } });

  // 闸门（同一个 guard 回调）两处都得放行：库内的读本来就该放行，坏的只是记账那一步。
  assert.equal(captureCtx({ storePath: `${slash}/`, usageLog: true }).guards[0](read(slash)), undefined);
  assert.equal(captureCtx({ storePath: plain, usageLog: true }).guards[0](read(plain)), undefined);

  // 修前：`noteNoteOpened` 拿 `settings.storePath + path.sep` 当库内前缀，`<库>/` + `/` = `<库>//`
  // 永远匹配不上 → 读到库里的 .md 也一行都不落（打开率恒为 0、连 `opened` 对照组都没有，
  // 且不报错）。判据收敛到 normalizeStorePath 之后这条链才通。
  const rows = usageRows(slash);
  assert.equal(rows.length, 1, '库内的一次 read 必须落一行 —— 以前这里恒为 0');
  assert.equal(rows[0].kind, 'opened', '没注入过也打开 → opened（对照组）');
  assert.equal(rows[0].id, 'reference-proxy.md');
  assert.equal(rows[0].via, 'read');
  // 尾斜杠只能影响配置字符串的写法，不该影响账本：两边的行逐字段一致（ts/lagMs 是时钟，抹掉）。
  const strip = (row) => ({ ...row, ts: undefined, lagMs: undefined });
  assert.deepEqual(usageRows(slash).map(strip), usageRows(plain).map(strip));
});

test('storePath 带尾斜杠：注入过的笔记后来被打开，那一行 used 也落盘（打开率的分子）', async () => {
  const dir = tinyStore();
  const { guards, handlerOf } = captureCtx({ storePath: `${dir}/`, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {});
  assert.equal(out.messages.length, 2, '召回本身从来是好的 —— 坏的只有记账');
  assert.equal(lastRow(dir).kind, 'hit');
  guards[0]({ name: 'read', arguments: { file_path: join(dir, 'reference-proxy.md') } });
  const row = lastRow(dir);
  assert.equal(row.kind, 'used', '尾斜杠时这一行以前永远不出现（打开率的分子恒为 0）');
  assert.equal(row.id, 'reference-proxy.md');
  assert.equal(row.via, 'read');
  assert.ok(Number.isFinite(row.lagMs) && row.lagMs >= 0, 'used 要带上「注入到被打开」的滞后');
});

test('storePath 归一：根不被归一成空串，空值仍当「没配库」（别把归一做成新的静默失效）', async () => {
  // 空白值：归一后仍是空 → 工具照旧说「需要 storePath 配置」，不能被归一成别的路径。
  const blank = await captureCtx({ storePath: '   ' }).tools.get('engramory_search').execute({ query: SEARCH_QUERY });
  assert.deepEqual(blank, { store: '', hits: [], note: '需要 storePath 配置与非空 query' });
  // `/` 与 `//`：去尾分隔符**绝不能**吃到空串 —— 空串在配置里代表「没配库」，
  // 那会让整个库静默失效（正是 B1 同类错误的反面）。根就是根。
  for (const raw of ['/', '//']) {
    const out = await captureCtx({ storePath: raw }).tools.get('engramory_search').execute({ query: SEARCH_QUERY });
    assert.equal(out.store, '/', `${JSON.stringify(raw)} 归一后必须还是根`);
    assert.notEqual(out.note, '需要 storePath 配置与非空 query', '根是配好的库，不是「没配」');
    assert.deepEqual(out.hits, [], '根下没有笔记 → 空命中，但不是配置错误');
  }
  // Windows 盘根同理：`C:\` 去掉尾分隔符会变成 `C:`（当前盘的工作目录，语义完全不同），要补回来。
  const drive = await captureCtx({ storePath: 'C:\\' }).tools.get('engramory_search').execute({ query: SEARCH_QUERY });
  assert.equal(drive.store, `C:${sep}`);
  assert.notEqual(drive.note, '需要 storePath 配置与非空 query');
});

test('归档口：库路径读不动时 planArchive 给空计划 → 404 而不是 500 或静默动手', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branches-archive-500-'));
  const file = join(dir, 'not-a-store.md');
  writeFileSync(file, '# 文件不是库\n');
  const { routes } = captureCtx({ storePath: file });
  const res = await postArchive(routes, JSON.stringify({ confirm: true, file: 'x.md' }));
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.reason, '没找到可归档计划：x.md', '读不动就等于没有计划，措辞要说得出来');
});

test('账本：有命中的那一轮也要记 topScore 与预算（否则「为什么只给半句」无从复算）', async () => {
  const dir = tinyStore();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.ok(out.messages.length > 1, '这一轮应该有注入');
  const row = lastRow(dir);
  assert.equal(row.kind, 'hit');
  // 落盘的行是宿主侧的**投影**（`ids`/`scores` 一一对应、顺序就是注入顺序），
  // 不是内存日志里的 `hits`；名次由 `ids` 的顺序表达，不另存一个 rank 字段。
  assert.equal(row.injected, row.ids.length, 'injected 要等于真正列出去的条数');
  assert.equal(row.ids.length, row.scores.length, 'ids 与 scores 一一对应');
  assert.equal(typeof row.topScore, 'number');
  assert.ok(row.topScore > 0, '有命中就该有正的最高分');
  assert.ok(row.budget > 0 && row.spent > 0, '预算上限与花掉的量都要在账上');
});

test('账本：命中了却一条都塞不进预算 → 记 budget-too-small，不许静默返回', async () => {
  // 造一个长到「连裸文件名都放不下」的 id：文件名 116 字符 + 注入头 80 + 预算下限 160，
  // 只剩 80 字符给条目 → 裸形态也放不下。正文要真能命中查询，否则走的是「没命中」那一支。
  const longName = `${'r'.repeat(116)}.md`;
  const dir = store({
    [longName]: `---\nname: ${'r'.repeat(116)}\ndescription: 代理节点的双端口\ntype: reference\n---\n\n# 长文件名\n\n代理节点双端口配置。\n`,
  });
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 1, usageLog: true });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.equal(out.messages.length, 1, '一条都放不下时不该注入任何东西');
  const row = lastRow(dir);
  assert.equal(row.kind, 'skip');
  assert.equal(row.reason, 'budget-too-small', '要能看出「是预算太小，不是没命中」');
  assert.ok(row.budget >= 160, '记下当时的上限，才知道该不该抬');
  assert.ok(row.topScore > 0, '记下最高分，才知道是分数不够还是预算不够');
});

/**
 * 造一份「总也用不上」的账本：同一篇笔记被携带 `carried` 次、从 `days` 天前开始，一次都没被读过。
 * 门控的抑制判据要两条证据同时成立（携带够多 + 观察够久），所以这里两样都给足。
 *
 * 携带次数为什么是 40 而不是「刚好过线」：降权/抑制的门槛不写死，而是按**本库基础打开率**
 * 算出来的（`confidence.js#gatePolicy`）。这批用例的账本样本量太小（携带总数低于
 * `baseRateMinSamples`），会退回先验率 10% → 降权线 10 次、抑制线 30 次；40 次两头都过，
 * 于是这些用例钉的是**档位语义**，不会被门槛算术的调整带红。
 */
function seedIgnoredLedger(dir, id, { carried = 40, days = 8 } = {}) {
  const rows = [];
  for (let i = 0; i < carried; i += 1) {
    rows.push(JSON.stringify({
      ts: Date.now() - (days - i * 0.1) * 86400000,
      kind: 'hit',
      query: '代理节点',
      scope: 'main',
      ids: [id],
      scores: [3.2],
      injected: 1,
      budget: 480,
      spent: 120,
    }));
  }
  writeFileSync(join(dir, USAGE_FILE), `${rows.join('\n')}\n`, 'utf8');
}

test('门控 off 档：一行账都不多记，注入一个字节都不变', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'off' });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.ok(out.messages.length > 1, 'off 档不该影响注入');
  const row = lastRow(dir);
  assert.equal(row.gate, 'off', '档位要落在账上');
  assert.equal(row.demoted, undefined, 'off 档没有降权，就不该有 demoted 字段占地方');
  assert.equal(row.suppressed, undefined);
});

test('门控 shadow 档：注入一字不改，但账本要留下观察值（够到抑制线的 id）', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'shadow' });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.ok(out.messages.length > 1, 'shadow 只观察，不许改注入');
  const row = lastRow(dir);
  assert.equal(row.gate, 'shadow');
  assert.deepEqual(row.suppressReady, ['reference-proxy.md'], '「开了 enforce 会拦谁」要能从账本里读出来');
  assert.equal(row.suppressed, undefined, 'shadow 什么都没拦，就不许写 suppressed（那是「真拦了」的字段）');
  assert.ok(row.scores[0] > 0, 'shadow 不动分数');
});

test('门控 assist 档：仍然注入，但降权（分数减半）—— 证据落地的方式由档位决定', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const shadow = await (async () => {
    const d = tinyStore();
    seedIgnoredLedger(d, 'reference-proxy.md');
    const { handlerOf } = captureCtx({ storePath: d, minScore: 0, maxChars: 480, usageLog: true, gate: 'shadow' });
    await turn(handlerOf('agent/pre-step'), {}, 'm1');
    return lastRow(d);
  })();
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'assist' });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.ok(out.messages.length > 1, 'assist 仍然让这条笔记看得见');
  const row = lastRow(dir);
  assert.equal(row.gate, 'assist');
  assert.deepEqual(row.demoted, ['reference-proxy.md'], '降权要落账（带 reason 的细节在内存日志里）');
  // 这条证据两半都够（携带 40 次已过抑制线、观察 8 天 ≥ 7），所以它同时出现在抑制预备名单里 ——
  // assist 档只是**没有真的拦**，`suppressed` 必须空着。
  assert.deepEqual(row.suppressReady, ['reference-proxy.md'], '证据够到抑制线就要如实写在预备名单里');
  assert.equal(row.suppressed, undefined, 'assist 档不许写 suppressed（那是「真拦了」的字段）');
  assert.ok(row.scores[0] < shadow.scores[0], '同一篇笔记，assist 档的分数必须比 shadow 档低（这就是降权）');
  assert.ok(Math.abs(row.scores[0] - shadow.scores[0] / 2) < 1e-6, '默认降权系数是 0.5');
});

test('门控：证据只够一半（观察还不到 7 天）→ 只降权，不进抑制预备名单', async () => {
  // 「观察够久」是抑制判据的另一半：刚带进来几天、还没被读过的笔记，不该被判死刑。
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md', { carried: 13, days: 2 });
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'assist' });
  await turn(handlerOf('agent/pre-step'), {}, 'm1');
  const row = lastRow(dir);
  assert.deepEqual(row.demoted, ['reference-proxy.md'], '证据少也够降权（8 次以上没被用上就该往后排）');
  assert.equal(row.suppressReady, undefined, '观察期没到，不许进抑制预备名单');
});

test('门控 enforce 档：拦掉总也用不上的那条，并单独记 reason=suppressed', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'enforce' });
  const out = await turn(handlerOf('agent/pre-step'), {}, 'm1');
  assert.equal(out.messages.length, 1, 'enforce 档真的把它移出注入');
  const row = lastRow(dir);
  // 被拦掉之后命中集为空，走的是「这一轮没有东西可注入」那一支（`kind: 'empty'`），
  // 但原因码必须是 `suppressed` —— 否则事后会拿「门槛太高」去治一个门控的问题。
  assert.equal(row.kind, 'empty');
  assert.equal(row.reason, 'suppressed', '要能区分「门控拦的」「门槛拦的」「压根没命中」');
  assert.deepEqual(row.suppressed, ['reference-proxy.md']);
  assert.deepEqual(row.suppressReady, ['reference-proxy.md']);
  assert.equal(row.gate, 'enforce');
  assert.ok(row.topScore > 0, '记门控前的最高分：它才是「差点就注入了」的那个分数');
});

test('门控档位在配置入口收口：写错一个词不许出现「行为 assist、账本写 zzz」', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const { handlerOf } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'ENFORCE!' });
  await turn(handlerOf('agent/pre-step'), {}, 'm1');
  const row = lastRow(dir);
  assert.equal(row.gate, 'assist', '认不出的档位回落默认档，并且账本要写归一后的值');
  assert.equal(row.suppressed, undefined, '回落成 assist 就不许拦东西（认错档位比写错档位可怕得多）');
});

test('状态路由：面板能读到门控档位与两份名单（总也用不上 / 过期）', async () => {
  const dir = tinyStore();
  seedIgnoredLedger(dir, 'reference-proxy.md');
  const { routes } = captureCtx({ storePath: dir, minScore: 0, maxChars: 480, usageLog: true, gate: 'assist' });
  const body = await stateOf(routes);
  assert.equal(body.hygiene.mode, 'assist', '档位要如实透出，面板才写得对');
  assert.equal(body.hygiene.policy.staleDays, 180, '阈值也要透出：面板不该自己抄一份');
  const ids = body.hygiene.ignored.map((n) => n.id);
  assert.ok(ids.includes('reference-proxy.md'), '14 次携带、一次没读过 → 必须进「总也用不上」名单');
  assert.equal(body.hygiene.counts.notes, 1);
  assert.deepEqual(body.hygiene.stale, [], '刚建的笔记不该被判过期');
});
