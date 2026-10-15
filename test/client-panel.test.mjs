/**
 * 面板客户端 bundle 的渲染回归。
 *
 * 为什么要测：`client/client.js` 是手写的渲染代码（500+ 行，页面刷新才生效、没有构建链），
 * 此前**一个测试都没有** —— 里面抛出任何异常都只会表现为「记忆页签一片空白」，
 * 而且只有人肉打开面板才看得见。这个文件用一个极小的 React 桩把那层壳撑起来：
 * `createElement` 只记树，hooks 按调用序返回预设值，effect 不执行（不联网），
 * 于是可以对着真实代码断言「给定宿主 state，这一页渲染出什么、会不会抛」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 每次渲染前填好的预设值（按 useState 调用序发；用完了回落到初始值）。 */
const pending = [];

/**
 * 点按钮时 setState 收到的更新（桩没有调度器，不重渲染，但把更新记下来）。
 * 这样「点了归档之后面板会显示什么」也能断言 —— 见文件末尾的归档用例。
 */
const recorded = [];

/** 极小的 React 桩：够 client.js 用（9 个 useState、1 个 useRef、1 个 useEffect）。 */
function stubReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      // 按调用序发预设值；用完了就回落到初始值（未列到的状态保持原样）。
      const next = pending.length ? pending.shift() : initial;
      // setter 只记录、不重渲染（桩里没有调度器），既有用例的语义不变。
      return [next === undefined ? initial : next, (update) => { recorded.push(update); }];
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect() {},
  };
}

/** 把渲染树里的所有字符串抠出来（含 props 里的 label/value/hint），便于断言文案。 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
      else if (key === 'label' || key === 'value' || key === 'hint') textsOf(value, out);
    }
    textsOf(node.children, out);
  }
  return out;
}

/** 载入 bundle，取出 MemoryView（apply() 时注册给 conversation.view 的那个组件）。 */
let viewing = null;
async function loadPanel() {
  if (viewing) return viewing;
  let mod = null;
  globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  await import('../client/client.js?panel-render-test');
  assert.ok(mod && typeof mod.factory === 'function', 'bundle 应当把自己的 factory 交给模块加载器');
  const plugin = mod.factory((name) => {
    if (name === 'react') return stubReact();
    throw new Error(`面板不该 require 平台基座之外的东西：${name}`);
  });
  assert.equal(plugin.name, 'engramory-recall-client');
  assert.deepEqual(plugin.inject, ['slots']);
  let component = null;
  plugin.apply({
    slots: {
      inject: (_slot, fn) => fn(),
      register: (meta, comp) => {
        assert.equal(meta.id, 'memory');
        assert.equal(meta.order, 20);
        assert.equal(meta.label(), '记忆');
        component = comp;
      },
    },
  });
  assert.ok(component, 'apply() 应当把记忆视图注册到 conversation.view');
  viewing = component;
  return component;
}

/** 宿主 state 的最小形状（真实字段取自 index.js 的 storeSnapshot + log + usage）。 */
function fakeState(usage) {
  return {
    store: '/tmp/store',
    notes: [{ file: 'a.md', title: 'A', description: 'd', bytes: 10, id: 'a' }],
    totals: { notes: 1, docs: 1, bytes: 10 },
    index: { lines: 2, bytes: 20, text: 'x' },
    audit: { summary: { bySeverity: {} }, findings: [] },
    writeAudit: { epoch: 'guard-v1', entries: [] },
    archive: { plans: [], skipped: [] },
    skill: null,
    log: [],
    config: { maxPointers: 5, maxChars: 600, minScore: 0, nudge: true, guardWrites: true, autoArchive: false, enabled: true },
    usage,
    generatedAt: Date.now(),
  };
}

const richUsage = () => ({
  injectRounds: 6,
  pointers: 24,
  zeroRounds: 1,
  dedupeRounds: 0,
  sedimentRounds: 0,
  denyRounds: 0,
  used: 9,
  coldOpens: 2,
  firstAt: Date.now() - 60000,
  lastAt: Date.now(),
  collapsed: 3,
  collapsedRounds: 2,
  dropped: 1,
  droppedRounds: 1,
  truncatedRounds: 2,
  openRate: 9 / 24,
  positions: [
    { injected: 6, opened: 5 },
    { injected: 6, opened: 2 },
    { injected: 6, opened: 1 },
    { injected: 4, opened: 1 },
    { injected: 2, opened: 0 },
  ],
  notes: [{ id: 'a.md', injected: 6, opened: 5, lastAt: Date.now() }],
  neverOpened: [{ id: 'b.md', injected: 3, lastAt: Date.now() }],
  uniqueNotes: 2,
  perRound: { min: 2, median: 5, p90: 5, max: 5, windowLimit: 5, fullRounds: 4 },
  openLag: { n: 9, median: 12345, p90: 60000 },
  skipReasons: { chitchat: 5, duplicate: 2 },
  emptyReasons: { 'no-hits': 3, 'below-min-score': 1, 'made-up-code': 1 },
  scoreStats: { n: 6, median: 12.345, p10: 4.1, p90: 30.2, spreadMedian: 8.888 },
  scopes: {
    main: { injectRounds: 4, pointers: 18, used: 8, openRate: 8 / 18 },
    subagent: { injectRounds: 2, pointers: 6, used: 1, openRate: 1 / 6 },
    unknown: { injectRounds: 0, pointers: 0, used: 0, openRate: 0 },
  },
  scoreCurve: {
    n: 20, rounds: 4, legacy: 19, unaligned: 0, opened: 0,
    points: [
      { minScore: 3.051, injected: 20, cut: 0, cutRate: 0, lost: 0 },
      { minScore: 3.152, injected: 19, cut: 1, cutRate: 0.05, lost: 0 },
      { minScore: 3.745, injected: 17, cut: 3, cutRate: 0.15, lost: 0 },
      { minScore: 5.441, injected: 15, cut: 5, cutRate: 0.25, lost: 1 },
      { minScore: 7.52, injected: 10, cut: 10, cutRate: 0.5, lost: 2 },
      { minScore: 9.372, injected: 5, cut: 15, cutRate: 0.75, lost: 3 },
      { minScore: 12.493, injected: 3, cut: 17, cutRate: 0.85, lost: 3 },
      { minScore: 14.754, injected: 0, cut: 20, cutRate: 1, lost: 4 },
    ],
  },
  verdicts: {
    open: '打开率 37.5% 在中间档',
    budget: '窗口基本用满',
    reason: '跳过以寒暄为主',
    curve: '被打开过的指针只有 0 条 —— 曲线只能看形状',
  },
});

test('面板：minScore 代价曲线最多显示 6 行，首尾必留', async () => {
  const long = {
    n: 40, rounds: 9, legacy: 0, unaligned: 0, opened: 3,
    points: Array.from({ length: 12 }, (_, i) => ({
      minScore: i + 1, injected: 12 - i, cut: i, cutRate: i / 12, lost: 0,
    })),
  };
  const text = await render(fakeState({ ...richUsage(), scoreCurve: long }));
  const rows = text.match(/≥ \d+/g) || [];
  assert.equal(rows.length, 6, `12 个门槛只该抽 6 行，实际 ${rows.length} 行`);
  assert.match(text, /≥ 1(?![0-9])/, '首行必留');
  assert.match(text, /≥ 12(?![0-9])/, '尾行必留');
  assert.match(text, /配对 40 条指针 \/ 9 轮/);
});

/** 渲染一次：返回抠出来的文本（渲染抛异常时测试自然失败）。 */
async function render(state) {
  const values = [state, null, Date.now(), 'usage', -1, '', '', {}, null];
  return renderWith(values);
}

let componentRef = null;
/** 最近一次渲染的树：桩不会递归渲染函数组件，需要断言子组件 props 时用它。 */
let lastTree = null;

/** 从渲染树里挑出某个函数组件的节点（按组件名匹配）。 */
function nodesOfType(node, name, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesOfType(child, name, out);
    return out;
  }
  if (typeof node.type === 'function' && node.type.name === name) out.push(node);
  nodesOfType(node.children, name, out);
  return out;
}
async function renderWith(values) {
  // 桩与组件只建一次（bundle 只能 import 一次），每次渲染只换「预设值队列」：
  // 这样多次渲染复用同一个 factory 闭包，useState 仍然能拿到本轮想要的宿主 state。
  pending.length = 0;
  pending.push(...values);
  recorded.length = 0;
  componentRef = await loadPanel();
  const tree = componentRef();
  lastTree = tree;
  return textsOf(tree).join(' | ');
}

test('面板：使用账页签把打开率、位置级曲线、预算、原因分布、minScore 代价曲线、四句判据都渲染出来', async () => {
  const text = await render(fakeState(richUsage()));
  assert.match(text, /注入指针/, '应当有四张卡片的第一张');
  assert.match(text, /打开率/);
  assert.match(text, /37\.5%/, '打开率应当按百分比渲染');
  assert.match(text, /位置级曲线/);
  assert.match(text, /6\/5|5\/6/, '位置级曲线应当有「打开/注入」的分数');
  assert.match(text, /预算与分数/);
  assert.match(text, /顶满窗口 4\/6 轮/, '窗口用满的轮数来自 perRound + maxPointers');
  assert.match(text, /缩成裸文件名 3 条/, '预算压力要写清楚');
  assert.match(text, /注入分：中位 12\.345/, '注入分要按落盘的 scores 渲染');
  assert.match(text, /为什么没注入/);
  assert.match(text, /寒暄 \/ 答话（设计如此）/, '原因码要翻成人话');
  assert.match(text, /与上一轮重复/);
  assert.match(text, /一条都不匹配/);
  assert.match(text, /被 minScore 拦住/);
  assert.match(text, /made-up-code/, '没列过的原因码要原样显示，不能藏起来');
  assert.match(text, /注入过、但从没被打开/);
  assert.match(text, /b\.md/);
  assert.match(text, /打开率 37\.5% 在中间档/, '四句判据要照搬宿主的原话');
  assert.match(text, /窗口基本用满/);
  assert.match(text, /跳过以寒暄为主/);
  assert.match(text, /曲线只能看形状/, '第四句判据（minScore 曲线）要照搬宿主的原话');
  // textsOf 用 ' | ' 拼文本，所以断言只取连续的那一段
  assert.match(text, /按提问者：/);
  assert.match(text, /主对话轮 4 轮 \/ 18 条 \/ 打开 8（44\.4%）/, '分母要按谁在问拆开');
  assert.match(text, /子代理轮 2 轮 \/ 6 条 \/ 打开 1（16\.7%）/);
  assert.doesNotMatch(text, /未标记（0\.13\.7 前）/, '空桶不显示，免得面板上全是 0');
  assert.match(text, /把 minScore 抬高会付出什么/);
  assert.match(text, /配对 20 条指针 \/ 4 轮/);
  assert.match(text, /≥ 3\.152/);
  assert.match(text, /砍 5%/);
  assert.match(text, /丢过 1/);
  assert.doesNotMatch(text, /≥ 3\.745/, '8 个门槛抽 6 行，第 3 行应当被抽样跳过');
});

test('面板：老宿主没有 usage 字段时给一句「重启后就有」，而不是白屏或崩', async () => {
  const text = await render(fakeState(null));
  assert.match(text, /宿主这一侧还没提供使用账/);
  assert.match(text, /重启一次 App/);
  assert.doesNotMatch(text, /打开率/, '没有 usage 时不该渲染出半张卡片');
});

test('面板：还没有注入记录时说清楚账本落在哪，不显示 0% 的假指标', async () => {
  const text = await render(fakeState({ ...richUsage(), pointers: 0, positions: [], neverOpened: [], scoreStats: { n: 0 } }));
  assert.match(text, /还没有注入记录/);
  assert.match(text, /\.engramory-recall\.jsonl/);
  assert.doesNotMatch(text, /0\.0%/, '没有指针时不该显示打开率');
});

test('面板：usage 缺字段（半截数据）也不抛异常', async () => {
  const text = await render(fakeState({ pointers: 3, openRate: 0 }));
  assert.match(text, /注入指针/);
  assert.doesNotMatch(text, /NaN|undefined/, '半截数据不该渲染出 NaN/undefined');
});

/** 渲染指定页签：`useState` 的预设值按钩子序摆（第 4 个是 tab、第 5 是展开项、第 6 是过滤器）。 */
async function renderTab(tab, state, extra = {}) {
  return renderWith([state, null, Date.now(), tab, extra.expanded ?? -1, extra.filter ?? '', extra.busy ?? '', extra.results ?? {}, extra.bulk ?? null]);
}

const richLogEntry = () => ({
  at: Date.now(),
  kind: 'hit',
  query: '代理节点怎么配',
  reason: '命中 2 篇',
  injected: 2,
  hits: [{ id: 'a.md', score: 12.5, bytes: 800, section: '代理' }],
});

const richState = () => {
  const state = fakeState(richUsage());
  state.log = [richLogEntry()];
  state.audit = {
    summary: { notes: 3, bySeverity: { error: 1, warn: 2, info: 3 } },
    findings: [
      { severity: 'info', code: 'note-short', message: '这条是提示', files: ['c.md'] },
      { severity: 'error', code: 'index-too-long', message: '索引超过 200 行', files: ['MEMORY.md'] },
    ],
  };
  state.writeAudit = {
    epoch: 'guard-v1',
    entries: [
      { ts: Date.now(), tool: 'write', file: 'MEMORY.md', verdict: 'deny', reason: '索引 201 行', bytes: 10 },
      { ts: Date.now(), tool: 'edit', file: 'reference-x.md', verdict: 'allow', reason: '库内正常写入', bytes: 5 },
    ],
  };
  state.archive = {
    plans: [{ file: 'MEMORY.md', bytes: 30000, batchCount: 3, freshCount: 2, existingCount: 1, historyFiles: ['MEMORY-history.md'], keptBytes: 8000, savedBytes: 22000 }],
    skipped: [{ file: 'y.md', reason: '还不到门槛' }],
    crashed: null,
  };
  state.index = { lines: 201, bytes: 26000, text: '# Memory Index\n- [A](a.md)' };
  return state;
};

test('面板：七个页签每一个都渲染得出内容（渲染期抛异常＝整页空白，只有人肉看得见）', async () => {
  const state = richState();
  const seen = {};
  for (const tab of ['log', 'usage', 'notes', 'audit', 'writes', 'index', 'archive']) {
    seen[tab] = await renderTab(tab, state);
    assert.ok(seen[tab].length > 20, `${tab} 页签不该是空的`);
  }
  assert.match(seen.log, /召回日志/, '日志页签的标签要在');
  assert.match(seen.usage, /注入指针/);
  assert.match(seen.notes, /a\.md/);
  // 体检：严重性排序后结论在前，findings 的 code / message / files 都要给出来
  assert.match(seen.audit, /索引超过 200 行/);
  assert.match(seen.audit, /index-too-long/);
  assert.match(seen.audit, /MEMORY\.md/);
  // 写入审计：一行摘要 + 逐条工具/结果
  assert.match(seen.writes, /规则版本 guard-v1 · 共 2 条 · 拦截 1 条/);
  assert.match(seen.writes, /reference-x\.md/);
  // 索引原文：内容照抄，不做净化（面板是只读窗口）
  assert.match(seen.index, /Memory Index/);
  // 归档：说清「不删内容」的机制 + 跳过项的原因
  assert.match(seen.archive, /归档不删内容/);
  assert.match(seen.archive, /还不到门槛/);
});

test('面板：体检页签把 error 排在 info 前面，findings 为空时不留空白', async () => {
  const state = richState();
  const text = await renderTab('audit', state);
  assert.ok(text.indexOf('索引超过 200 行') < text.indexOf('这条是提示'), 'error 要在 info 前面');

  state.audit = { summary: { notes: 1, bySeverity: {} }, findings: [] };
  const empty = await renderTab('audit', state);
  assert.ok(empty.length > 10, '没有 findings 也要有结论行，不能是一片空白');
});

test('面板：笔记页签的过滤器真的在过滤（输入什么就只看得到什么）', async () => {
  const state = richState();
  const hit = await renderTab('notes', state, { filter: 'a' });
  assert.match(hit, /a\.md/);
  const miss = await renderTab('notes', state, { filter: 'zzz-查不到' });
  assert.doesNotMatch(miss, /a\.md/);
});

test('面板：日志条目拿得到「展开/收起」与整条数据（函数组件由桩按 props 断言）', async () => {
  const state = richState();
  await renderTab('log', state, { expanded: -1 });
  const collapsed = nodesOfType(lastTree, 'LogEntry');
  assert.equal(collapsed.length, 1, '一条日志应当渲染一个 LogEntry');
  assert.equal(collapsed[0].props.expanded, false);
  assert.equal(collapsed[0].props.entry.query, '代理节点怎么配');
  assert.equal(collapsed[0].props.entry.hits.length, 1, 'hits 要原样传下去，展开时靠它列出明细');

  await renderTab('log', state, { expanded: 0 });
  const [opened] = nodesOfType(lastTree, 'LogEntry');
  assert.equal(opened.props.expanded, true, '展开态要传成 true（否则按钮永远只显示「展开」）');
});

test('面板：宿主路由不可用时给人话，而不是白屏', async () => {
  const text = await renderWith([null, 'ECONNREFUSED', Date.now(), 'log', -1, '', '', {}, null]);
  assert.match(text, /正在读取记忆库状态…/);
  assert.match(text, /宿主路由不可用：ECONNREFUSED/);
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 补厚：宿主「给得少 / 给得脏」时面板的每一条渲染分支。
 * 规矩：分支要么显示人话、要么整块不渲染，绝不能抛 —— 渲染期抛异常 = 记忆页签白屏，
 * 只有人肉打开面板才看得见。
 * 0.13.9 起：原先标「现状钉住」的 6 条在册缺陷已经修完（位置级曲线取错下标、三处漏数组
 * 兜底、hits 只兜数组不兜元素、半截字段印 undefined、配置缺失把「不知道」写成 off、
 * 脏数字不净化），那批用例改成断言**修好后的行为**，注释里写了各自的新规矩。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 按宿主元素名（'button' / 'tr' / 'div'…）收节点；nodesOfType 只认函数组件。 */
function elementsOfType(node, type, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOfType(child, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  elementsOfType(node.children, type, out);
  return out;
}

/** 页签那一排按钮的文案（按渲染顺序）。textsOf 会把 key 也抠出来，所以先摘掉 id 前缀。 */
function tabLabels() {
  return elementsOfType(lastTree, 'button')
    .map((b) => textsOf(b).join('').replace(/^(log|usage|notes|audit|index|archive|writes)/, ''))
    .filter((t) => /^(召回日志|使用账|笔记|体检|索引原文|归档|写入审计)/.test(t));
}

/** 归档页签上的按钮（文案 + disabled），用来钉住 busy 三态。 */
function archiveButtons() {
  return elementsOfType(lastTree, 'button')
    .filter((b) => /执行归档|排队中|搬运中|正在依次搬运|全部执行/.test(textsOf(b).join('')))
    .map((b) => ({ text: textsOf(b).join(''), disabled: b.props.disabled }));
}

/** 直接渲染一条日志：桩不递归渲染函数组件，所以手动调一次 LogEntry 的函数体。 */
async function renderLogEntry(entry, expanded = false) {
  const state = fakeState(null);
  state.log = [entry];
  await renderTab('log', state, { expanded: expanded ? 0 : -1 });
  const [node] = nodesOfType(lastTree, 'LogEntry');
  assert.ok(node, '日志页签应当渲染出一个 LogEntry');
  return { node, text: textsOf(node.type(node.props)).join(' | ') };
}

test('面板：usage 是空对象时只说「还没有注入记录」，不摊开 0% 的假指标', async () => {
  const text = await renderTab('usage', fakeState({}));
  assert.match(text, /还没有注入记录。账本落在记忆库的/);
  assert.match(text, /\.engramory-recall\.jsonl/);
  assert.match(text, /攒够 20 条指针再回来看判据/);
  assert.deepEqual(tabLabels(), ['召回日志（0）', '使用账', '笔记（1）', '体检', '索引原文', '归档', '写入审计（0）']);
  assert.doesNotMatch(text, /注入指针|打开率|位置级曲线|预算与分数|为什么没注入/, '没有指针时不该留下半张卡片');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：usage 只有 pointers 时四张卡片都在，缺的字段各给人话', async () => {
  const text = await renderTab('usage', fakeState({ pointers: 5 }));
  assert.deepEqual(tabLabels().slice(1, 2), ['使用账（0%）'], '页签上的百分比按 openRate 取整');
  assert.match(text, /注入指针/);
  assert.match(text, /5 条/);
  assert.match(text, /0 轮/, 'injectRounds 缺省按 0');
  assert.match(text, /打开率/);
  assert.match(text, /0\.0%/);
  assert.match(text, /0 条被 read\/edit/);
  assert.match(text, /注入过的笔记/);
  assert.match(text, /0 篇/);
  assert.match(text, /都至少打开过一次/);
  assert.match(text, /打开延迟/);
  assert.match(text, /还没被打开过/);
  assert.match(text, /还没有逐轮记录（这一节要重启一次 App 让新宿主开始写）。/);
  assert.match(text, /还没有带分数的注入记录（早期日志没有 scores 字段）。/);
  assert.match(text, /位置级曲线/, '位置级曲线那一节是说明书，没有数据也在');
  assert.doesNotMatch(text, /第 1 条/, 'positions 缺失时不该凭空造位置行');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：perRound 只有 median 时，缺的「最少 / p90 / 最多」印「—」而不是 undefined', async () => {
  // 0.13.9 起：守卫仍然是 `rounds.median === undefined`（缺整块还是那句「还没有逐轮记录」），
  // 但真拿到 median 之后，min / p90 / max 各自过 fmtNum —— 缺的印「—」。
  // 最小复现：usage = { pointers: 5, perRound: { median: 3 } }
  const text = await renderTab('usage', fakeState({ pointers: 5, perRound: { median: 3 } }));
  assert.match(text, /每轮注入 3 条（最少 — \/ p90 — \/ 最多 —）/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：scoreCurve 缺 rounds 时印「—」，points 半截也不会漏 undefined / NaN%', async () => {
  // 0.13.9 起：配对那句话的两头、以及 points 的每一列都过 fmtNum / fmtPct ——
  // 半截数据只留下「—」，不会插出 undefined，也不会算出 NaN%。
  // 最小复现：usage = { pointers: 5, scoreCurve: { n: 7 } }
  const text = await renderTab('usage', fakeState({ pointers: 5, scoreCurve: { n: 7 } }));
  assert.match(text, /把 minScore 抬高会付出什么/);
  assert.match(text, /配对 7 条指针 \/ — 轮/);
  assert.doesNotMatch(text, /≥ /, 'points 缺失时表格一行都不出');

  const half = await renderTab('usage', fakeState({ pointers: 5, scoreCurve: { n: 2, rounds: 1, points: [{}] } }));
  assert.match(half, /≥ —/);
  assert.match(half, /留下 —/);
  assert.match(half, /砍 —/);
  assert.match(half, /丢过 —/);
  assert.doesNotMatch(half, /undefined|NaN/);
});

test('面板：scoreCurve.n 为 0、points 为空或整块缺失时，「抬高 minScore」那一节整块不渲染', async () => {
  const zero = await renderTab('usage', fakeState({ pointers: 5, scoreCurve: { n: 0, rounds: 0, points: [{ minScore: 1, injected: 1, cut: 0, cutRate: 0, lost: 0 }] } }));
  assert.doesNotMatch(zero, /把 minScore 抬高会付出什么/);
  assert.doesNotMatch(zero, /配对/);
  const missing = await renderTab('usage', fakeState({ pointers: 5 }));
  assert.doesNotMatch(missing, /把 minScore 抬高会付出什么/);
});

test('面板：positions 全是 0 注入的桶不渲染行，但说明书留着', async () => {
  const text = await renderTab('usage', fakeState({
    pointers: 5,
    positions: [{ position: 1, injected: 0, opened: 0 }, { position: 2, injected: 0, opened: 0 }],
  }));
  assert.match(text, /位置级曲线/);
  assert.match(text, /第 N 条指针被打开的比例/);
  assert.doesNotMatch(text, /第 1 条/, 'injected 为 0 的行没有「打开比例」可言');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：位置级曲线的行标签用桶自己的 position，不是过滤后的下标', async () => {
  // 0.13.9 起：标签取元素自己的 p.position —— 先 filter 掉 injected === 0 的桶、
  // 再用 map 的下标写「第 i+1 条」，会把 position 2 的数据挂到「第 1 条」上。
  // 最小复现：positions = [{ position: 1, injected: 0, opened: 0 }, { position: 2, injected: 4, opened: 1 }]
  const text = await renderTab('usage', fakeState({
    pointers: 5,
    positions: [{ position: 1, injected: 0, opened: 0 }, { position: 2, injected: 4, opened: 1 }],
  }));
  assert.match(text, /第 2 条/, '这一行的数据来自 position 2');
  assert.match(text, /1\/4/);
  assert.match(text, /25%/);
  assert.doesNotMatch(text, /第 1 条/, 'position 1 那个桶 injected 为 0，不该出现');

  // 密集分桶（真实宿主的常态）不受影响：两条都在，只是标签来源换了。
  const dense = await renderTab('usage', fakeState({
    pointers: 5,
    positions: [{ position: 1, injected: 2, opened: 1 }, { position: 2, injected: 4, opened: 1 }],
  }));
  assert.match(dense, /第 1 条/);
  assert.match(dense, /第 2 条/);
});

test('面板：scopes 只有未标记桶时照样按提问者拆开；pointers 为 0 的桶一行都不出', async () => {
  const text = await renderTab('usage', fakeState({
    pointers: 5,
    scopes: {
      main: { injectRounds: 0, pointers: 0, used: 0, openRate: 0 },
      subagent: { injectRounds: 2, pointers: 6, used: 1, openRate: 1 / 6 },
      unknown: { injectRounds: 1, pointers: 5, used: 2, openRate: 0.4 },
    },
  }));
  assert.match(text, /按提问者：/);
  assert.match(text, /子代理轮 2 轮 \/ 6 条 \/ 打开 1（16\.7%）/);
  assert.match(text, /未标记（0\.13\.7 前） 1 轮 \/ 5 条 \/ 打开 2（40\.0%）/);
  assert.doesNotMatch(text, /主对话轮/, 'pointers 为 0 的桶不算「有提问者」');
});

test('面板：scopes 一个指针都没有时，「按提问者」整块不渲染', async () => {
  const zero = await renderTab('usage', fakeState({ pointers: 5, scopes: { main: { injectRounds: 3, pointers: 0, used: 0, openRate: 0 } } }));
  assert.doesNotMatch(zero, /按提问者/);
  const missing = await renderTab('usage', fakeState({ pointers: 5 }));
  assert.doesNotMatch(missing, /按提问者/);
});

test('面板：skipReasons / emptyReasons 都空时「为什么没注入」不渲染；只有一边时另一边按 0 行补齐', async () => {
  const bothEmpty = await renderTab('usage', fakeState({ pointers: 5, skipReasons: {}, emptyReasons: {} }));
  assert.doesNotMatch(bothEmpty, /为什么没注入/);

  await renderTab('usage', fakeState({ pointers: 5, skipRounds: 3, skipReasons: { chitchat: 2, 'too-short': 1 } }));
  const text = textsOf(lastTree).join(' | ');
  assert.match(text, /为什么没注入/);
  assert.match(text, /跳过（3 轮）/);
  assert.match(text, /零命中（0 轮）/, 'emptyRounds 缺省按 0');
  assert.match(text, /寒暄 \/ 答话（设计如此）/);
  assert.match(text, /消息太短/);
  assert.equal(elementsOfType(lastTree, 'tr').length, 3, '1 行表头 + 2 行原因');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：scoreStats 缺失或 n === 0 时说「还没有带分数的注入记录」', async () => {
  for (const usage of [{ pointers: 5, scoreStats: { n: 0, median: 1 } }, { pointers: 5 }]) {
    const text = await renderTab('usage', fakeState(usage));
    assert.match(text, /还没有带分数的注入记录（早期日志没有 scores 字段）。/);
    assert.doesNotMatch(text, /注入分：中位/);
  }
});

test('面板：verdicts 缺某一句时只渲染有的那句，不留空行', async () => {
  const one = await renderTab('usage', fakeState({ pointers: 5, verdicts: { open: '只有这一句' } }));
  assert.match(one, /· 只有这一句/);
  assert.equal((one.match(/· /g) || []).length, 1, '缺的三句不该变成三行空行');
  const none = await renderTab('usage', fakeState({ pointers: 5, verdicts: {} }));
  assert.equal((none.match(/· /g) || []).length, 0);
  const nulled = await renderTab('usage', fakeState({ pointers: 5, verdicts: null }));
  assert.equal((nulled.match(/· /g) || []).length, 0);
});

test('面板：脏数字在显示层被净化成「—」（NaN / Infinity / 1e+21），有限数照抄', async () => {
  // 0.13.9 起：进面板的数字统一过 fmtNum / fmtPct / fmtSecs（只改显示、不动数据）——
  // 非有限数、或超出安全整数范围的数一律印「—」；缺字段该按 0 走的（老宿主）仍旧按 0。
  // 最小复现：openRate: NaN、openLag.median: NaN、scoreStats.p90: Infinity、spreadMedian: 1e21
  const text = await renderTab('usage', fakeState({
    pointers: 5,
    openRate: NaN,
    injectRounds: -3,
    uniqueNotes: -1,
    openLag: { n: -1, median: NaN, p90: NaN },
    scoreStats: { n: 2, median: NaN, p10: -5, p90: Infinity, spreadMedian: 1e21 },
    positions: [{ position: 1, injected: 3, opened: 2 }],
  }));
  assert.match(text, /打开率/);
  assert.doesNotMatch(text, /NaN|Infinity|1e\+21|undefined/, '脏数字一个都不许原样进面板');
  assert.match(text, /-3 轮/, '有限的负数照抄，不洗成 0');
  assert.match(text, /-1 篇/);
  assert.match(text, /p90 — · n=-1/, 'openLag 的坏中位数印「—」，n 仍是有限数');
  assert.match(text, /注入分：中位 — · p10 -5 · p90 — · 首尾落差中位 —（共 2 轮）/);
  assert.match(text, /2\/3/);
  assert.match(text, /67%/);

  // 有限数照抄：面积不变，只是坏值不再透出。
  const clean = await renderTab('usage', fakeState({ pointers: 5, openRate: 0.5, injectRounds: 4, uniqueNotes: 2 }));
  assert.match(clean, /50\.0%/);
  assert.match(clean, /4 轮/);
  assert.match(clean, /2 篇/);
});

test('面板：一条召回记录都没有时给一句人话，不是空卡片', async () => {
  const text = await renderTab('log', fakeState(null));
  assert.match(text, /这个会话还没有召回记录。发一句真实的提问就会出现在这里。/);
  assert.match(text, /召回日志（0）/);
  assert.equal(nodesOfType(lastTree, 'LogEntry').length, 0);
});

test('面板：日志条目按 kind 翻成人话，命中带字符数、nudge 与 reason 都照出来', async () => {
  // 注意：LogEntry 的 reason 是**原样照抄**（宿主往日志里写的就是人话，比如「命中 2 篇」），
  // REASON_LABELS 的翻译只发生在「使用账」的原因表里 —— 别把两处混起来断言。
  const cases = [
    [{ kind: 'hit', injected: 3, chars: 120, query: 'q' }, /注入 3 条/, /120 字符/],
    [{ kind: 'skip', query: 'q', reason: '命令式提问，不需要回忆' }, /跳过/, /命令式提问，不需要回忆/],
    [{ kind: 'deny', query: 'q' }, /拦截写入/, null],
    [{ kind: 'deny-error', query: '' }, /闸门异常/, /（空）/],
    [{ kind: 'sediment', query: 'q' }, /沉淀提醒/, null],
    [{ kind: 'archive-auto', query: 'q' }, /自动归档/, null],
    [{ kind: 'empty', query: 'q' }, /无命中/, null],
    [{ kind: 'brand-new-kind', query: 'q' }, /无命中/, null],
  ];
  for (const [entry, label, extra] of cases) {
    const { text } = await renderLogEntry({ at: Date.now(), hits: [], ...entry });
    assert.match(text, label, `${entry.kind} 的标签`);
    if (extra) assert.match(text, extra);
  }
  const nudge = await renderLogEntry({ at: Date.now(), kind: 'skip', query: 'q', nudge: true, reason: 'unspecified' });
  assert.match(nudge.text, /含记忆提示/);
  assert.match(nudge.text, /unspecified/, 'reason 原样照出，面板不替宿主翻译');
});

test('面板：日志折叠只摘要前 4 条，展开列全部 6 条（含 § 分节与 score/bytes），按钮文案跟着翻', async () => {
  const hits = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}.md`, score: i, bytes: 10 * i, section: i === 5 ? '尾节' : '' }));
  const entry = { at: Date.now(), kind: 'hit', query: '六个指针', injected: 6, chars: 100, hits };

  const folded = await renderLogEntry(entry, false);
  assert.match(folded.text, /展开/);
  assert.doesNotMatch(folded.text, /收起/);
  assert.match(folded.text, /n3\.md · 3/, '摘要按「id · score」写');
  assert.doesNotMatch(folded.text, /n4\.md|n5\.md/, '折叠时只给前 4 条');
  const buttons = elementsOfType(folded.node.type(folded.node.props), 'button');
  assert.equal(buttons.length, 1);
  assert.equal(textsOf(buttons[0]).join(''), '展开');
  assert.equal(buttons[0].props.onClick, folded.node.props.onToggle, '折叠按钮要接上 MemoryView 给的 onToggle');

  const opened = await renderLogEntry(entry, true);
  assert.match(opened.text, /收起/);
  assert.match(opened.text, /6\. n5\.md § 尾节  score=5  50B/, '展开的明细行格式');
  assert.equal((opened.text.match(/score=/g) || []).length, 6, '展开要列全 6 条，不是前 4 条');
});

test('面板：hit 条目缺 chars 时那一列印「—」；hits 不是数组就当没有明细', async () => {
  // 0.13.9 起：chars 过 fmtNum —— 缺字段印「—」，不再是「undefined 字符」。
  // 真实宿主的命中行一定带 chars（index.js 记日志时写 chars: text.length），
  // 所以只有「老宿主 / 手改过的日志」才走得到这条。
  // 最小复现：state.log = [{ at: 1, kind: 'hit', query: 'q', injected: 2, hits: [] }]
  const noChars = await renderLogEntry({ at: Date.now(), kind: 'hit', query: 'q', injected: 2, hits: [] });
  assert.match(noChars.text, /\| q \| —$/, 'chars 缺了就在那一列印 —');
  assert.doesNotMatch(noChars.text, /undefined|NaN/);
  assert.doesNotMatch(noChars.text, /展开/, '没有 hits 时不给展开按钮');

  const badHits = await renderLogEntry({ at: Date.now(), kind: 'hit', query: 'q', injected: 2, chars: 9, hits: 'oops' });
  assert.match(badHits.text, /9 字符/);
  assert.doesNotMatch(badHits.text, /展开|收起/, 'objsOnly 兜住了「不是数组」，当没有明细处理');
});

test('面板：hits 里混进 null 时被滤掉，不退化成白屏', async () => {
  // 0.13.9 起 hits 过 objsOnly（先兜数组、再滤掉非对象元素）—— 以前只兜了数组，
  // 元素是 null 时 LogEntry 读 hit.id 直接抛，渲染期抛异常 = 记忆页签整片白屏。
  // 最小复现：state.log = [{ at: 1, kind: 'hit', query: 'q', injected: 1, chars: 9, hits: [null] }]
  const onlyNull = await renderLogEntry({ at: Date.now(), kind: 'hit', query: 'q', injected: 1, chars: 9, hits: [null] });
  assert.match(onlyNull.text, /9 字符/);
  assert.doesNotMatch(onlyNull.text, /展开|收起/, 'null 被滤掉后等于没有明细，不给展开按钮');

  const entry = {
    at: Date.now(), kind: 'hit', query: 'q', injected: 2, chars: 9,
    hits: [null, { id: 'n1.md', score: 2, bytes: 3 }, 'oops'],
  };
  const mixed = await renderLogEntry(entry);
  assert.match(mixed.text, /n1\.md · 2/, '活下来的元素照常渲染');
  assert.match(mixed.text, /展开/, '还有一条真明细就给展开按钮');

  const opened = await renderLogEntry(entry, true);
  assert.equal((opened.text.match(/score=/g) || []).length, 1, '展开只列过滤后的那一条');
  assert.match(opened.text, /1\. n1\.md  score=2  3B/);
});

test('面板：多条日志时展开态只落在 expanded === 下标 的那一条上', async () => {
  const state = fakeState(null);
  state.log = [1, 2, 3].map((n) => ({ at: n, kind: 'empty', query: `q${n}`, hits: [] }));
  await renderTab('log', state, { expanded: 1 });
  const entries = nodesOfType(lastTree, 'LogEntry');
  assert.deepEqual(entries.map((n) => n.props.entry.query), ['q1', 'q2', 'q3']);
  assert.deepEqual(entries.map((n) => n.props.expanded), [false, true, false]);
});

test('面板：统计卡把命中次数与字符数累计出来，没有命中时显示「—」而不是 0', async () => {
  const state = fakeState(null);
  state.log = [
    { at: 1, kind: 'hit', query: 'a', chars: 100, hits: [] },
    { at: 2, kind: 'hit', query: 'b', chars: '50', hits: [] },
    { at: 3, kind: 'deny', query: 'c', hits: [] },
  ];
  const text = await renderTab('log', state);
  assert.match(text, /本轮注入/);
  assert.match(text, /2 次/);
  assert.match(text, /共 150 字符/, 'chars 是字符串也要按数字累加');
  assert.match(text, /闸门拦截/);
  assert.match(text, /1 次/);
  assert.match(text, /写记忆库被拒/);

  const none = await renderTab('log', fakeState(null));
  assert.match(none, /尚无命中/);
  assert.match(none, /尚无拦截/);
  assert.doesNotMatch(none, /0 次/);
  assert.match(none, /—/);
});

test('面板：笔记列表为空时表头仍在，一行数据都不渲染', async () => {
  const state = fakeState(null);
  state.notes = [];
  const text = await renderTab('notes', state);
  assert.match(text, /笔记（0）/);
  assert.match(text, /按文件名 \/ 标题 \/ 描述过滤/);
  const rows = elementsOfType(lastTree, 'tr');
  assert.equal(rows.length, 1, '只有表头那一行');
  assert.equal(textsOf(rows[0]).join(''), '文件标题大小片段');
  assert.doesNotMatch(text, /undefined/);
});

test('面板：笔记过滤器按 文件名/标题/描述 匹配且不分大小写，不命中就一行都不出', async () => {
  const state = fakeState(null);
  state.notes = [
    { file: 'Alpha.md', title: '标题一', description: '讲代理节点', bytes: 2048, sections: 3 },
    { file: 'beta.md', title: '标题二', description: '无关', bytes: 100, sections: 1 },
  ];
  const byFile = await renderTab('notes', state, { filter: 'ALPHA' });
  assert.match(byFile, /Alpha\.md/);
  assert.doesNotMatch(byFile, /beta\.md/);
  assert.match(byFile, /2\.0 KB/);
  assert.match(byFile, /3/, 'sections 大于 1 时按真实数显示');

  const byDesc = await renderTab('notes', state, { filter: '代理' });
  assert.match(byDesc, /Alpha\.md/);
  assert.doesNotMatch(byDesc, /beta\.md/);

  const byTitle = await renderTab('notes', state, { filter: '标题二' });
  assert.match(byTitle, /beta\.md/);
  assert.doesNotMatch(byTitle, /Alpha\.md/);

  await renderTab('notes', state, { filter: 'zzz-查不到' });
  assert.equal(elementsOfType(lastTree, 'tr').length, 1, '过滤不中时不留空行');
});

test('面板：笔记缺 title/description 时用占位符，不显示 undefined', async () => {
  const state = fakeState(null);
  state.notes = [{ file: 'z.md', bytes: 2048, sections: 0 }];
  const text = await renderTab('notes', state);
  assert.match(text, /z\.md/);
  assert.match(text, /—/);
  assert.match(text, /2\.0 KB/);
  assert.match(text, /1/, 'sections 不是 > 1 就按 1 显示');
  assert.doesNotMatch(text, /undefined/);
});

test('面板：体检页签认得没见过的 severity（图标回落「•」、排最后），没 summary 就不写摘要行', async () => {
  const state = fakeState(null);
  state.audit = {
    findings: [
      { severity: 'fatal', code: 'brand-new', message: '没见过的严重度' },
      { severity: 'warn', code: 'w1', message: '告警一句', files: [] },
    ],
  };
  const text = await renderTab('audit', state);
  assert.match(text, /•/, '没见过的 severity 用回落图标');
  assert.match(text, /brand-new/);
  assert.match(text, /没见过的严重度/);
  assert.match(text, /w1/);
  assert.match(text, /告警一句/);
  assert.ok(text.indexOf('告警一句') < text.indexOf('没见过的严重度'), '未知 severity 排在已知之后');
  assert.doesNotMatch(text, /篇笔记 · 结构错/, '没有 summary 时不写摘要行');
  assert.doesNotMatch(text, /undefined/);
});

test('面板：体检「没发现问题」与「还没拿到结果」是两句不同的人话', async () => {
  const ok = await renderTab('audit', fakeState(null));
  assert.match(ok, /✅ 没发现结构问题、失联路径或可疑重复。/);
  const missing = fakeState(null);
  missing.audit = null;
  const pending = await renderTab('audit', missing);
  assert.match(pending, /还没拿到体检结果（宿主侧未就绪）。/);
  assert.doesNotMatch(ok, /还没拿到体检结果/);
});

test('面板：写入审计缺字段时用「?」「—」「0 B」占位，非 deny 一律显示「放行」', async () => {
  const state = fakeState(null);
  state.writeAudit = {
    entries: [
      { ts: 0, verdict: 'deny', tool: 'write', file: 'MEMORY.md', bytes: 1024, reason: '索引超行' },
      { ts: 0, verdict: 'weird', bytes: NaN },
    ],
  };
  const text = await renderTab('writes', state);
  assert.match(text, /规则版本 — · 共 2 条 · 拦截 1 条/, 'epoch 缺失用「—」，拦截只数 deny');
  assert.match(text, /拦截/);
  assert.match(text, /放行/, '不是 deny 的一律算放行');
  assert.match(text, /MEMORY\.md/);
  assert.match(text, /索引超行/);
  assert.match(text, /\?/, 'tool 缺失用「?」');
  assert.match(text, /1\.0 KB/);
  assert.match(text, /0 B/, 'bytes 是 NaN 时按 0 显示');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：写入审计没有记录时给一句机制说明，不是空表', async () => {
  const text = await renderTab('writes', fakeState(null));
  assert.match(text, /还没有落在记忆库里的写入记录。/);
  assert.match(text, /\.engramory-audit\.jsonl/);
  assert.match(text, /写入审计（0）/);
});

test('面板：索引页签区分「没找到文件」「文件是空的」「有内容」三种', async () => {
  const missing = fakeState(null);
  missing.index = { missing: true, path: '/store/MEMORY.md', lines: 0, bytes: 0 };
  assert.match(await renderTab('index', missing), /没找到索引文件：\/store\/MEMORY\.md/);

  const empty = fakeState(null);
  empty.index = { lines: 0, bytes: 0, text: '' };
  assert.match(await renderTab('index', empty), /（空）/);

  const filled = fakeState(null);
  filled.index = { lines: 2, bytes: 20, text: '# Memory Index\n- [A](a.md)' };
  const text = await renderTab('index', filled);
  assert.match(text, /Memory Index/);
  assert.match(text, /\[A\]\(a\.md\)/, '索引原文照抄，不做净化');
});

test('面板：归档的单篇/全部按钮随 busy 换文案并禁用；只有一篇时不给「全部执行」', async () => {
  const plan = (file) => ({
    file, bytes: 30000, keptBytes: 8000, savedBytes: 22000, batchCount: 3, freshCount: 2,
    existingCount: 0, historyFiles: [{ file: `${file}-history.md`, batchCount: 3, bytes: 20000 }],
  });
  const state = fakeState(null);

  state.archive = { plans: [plan('M.md')], skipped: [] };
  await renderTab('archive', state);
  assert.deepEqual(archiveButtons(), [{ text: '执行归档', disabled: false }], '只有一篇就没有「全部执行」');

  state.archive = { plans: [plan('M.md'), plan('N.md')], skipped: [] };
  await renderTab('archive', state);
  assert.deepEqual(archiveButtons().map((b) => b.text), ['全部执行（2 篇）', '执行归档', '执行归档']);
  assert.ok(archiveButtons().every((b) => !b.disabled));

  await renderTab('archive', state, { busy: '@all' });
  const allBusy = archiveButtons();
  assert.deepEqual(allBusy.map((b) => b.text), ['正在依次搬运 2 篇…', '排队中', '排队中']);
  assert.deepEqual(allBusy.map((b) => b.disabled), [true, true, true], '跑批量时单篇按钮全禁用');

  await renderTab('archive', state, { busy: 'N.md' });
  const oneBusy = archiveButtons();
  assert.deepEqual(oneBusy.map((b) => b.text), ['全部执行（2 篇）', '执行归档', '搬运中…']);
  assert.deepEqual(oneBusy.map((b) => b.disabled), [true, false, true], '只有正在搬的那篇禁用');

  const text = textsOf(lastTree).join(' | ');
  assert.match(text, /29\.3 KB → 7\.8 KB/);
  assert.match(text, /省 21\.5 KB/);
  // 「→」后面是另一个文本节点，跨节点的整句会被 ' | ' 隔开，所以分成两段断言。
  assert.match(text, /3 个批次章节，搬走 2 个 →/);
  assert.match(text, /M\.md-history\.md（3 批 \/ 19\.5 KB）/);
});

test('面板：归档页签把「规划崩了」「扫过但没到线」「自动归档开关」都写清楚', async () => {
  const state = fakeState(null);
  state.archive = {
    plans: [],
    skipped: [{ file: 'y.md', reason: '还不到门槛' }, { file: 'z.md', reason: '只有 1 个批次章节' }],
    crashed: 'boom',
  };
  const off = await renderTab('archive', state);
  assert.match(off, /归档规划崩了：boom/);
  assert.match(off, /2 篇扫过但没到线：/);
  assert.match(off, /y\.md（还不到门槛）；z\.md（只有 1 个批次章节）/);
  assert.match(off, /没有超标的笔记。触发线：单篇 >64KB 或 >20 个章节，且至少 3 个可搬的批次章节。/);
  assert.match(off, /自动归档当前关闭/);

  state.config.autoArchive = true;
  assert.match(await renderTab('archive', state), /自动归档已开启/);
});

test('面板：归档结果与批量汇总按成功/失败上色，文案原样显示', async () => {
  const state = fakeState(null);
  state.archive = {
    plans: [{
      file: 'M.md', bytes: 30000, keptBytes: 8000, savedBytes: 22000, batchCount: 3,
      freshCount: 2, existingCount: 1, historyFiles: [],
    }],
    skipped: [],
  };
  const text = await renderTab('archive', state, {
    results: { 'M.md': { ok: true, text: '已归档 → M-history.md' } },
    bulk: { ok: false, text: '成功 0 篇，失败 1 篇：M.md' },
  });
  assert.match(text, /已归档 → M-history\.md/);
  assert.match(text, /成功 0 篇，失败 1 篇：M\.md/);
  assert.match(text, /（已有 1 份归档文件，续写）/);
  const colorOf = (want) => {
    const node = elementsOfType(lastTree, 'div').find((n) => textsOf(n).join('') === want);
    assert.ok(node, `应当找得到文案为「${want}」的结果行`);
    return node.props.style.color;
  };
  assert.equal(colorOf('已归档 → M-history.md'), '#2e9e63');
  assert.equal(colorOf('成功 0 篇，失败 1 篇：M.md'), '#c2803a');
});

test('面板：positions / neverOpened / plan.historyFiles 不是数组时当空列表处理，不抛', async () => {
  // 0.13.9 起：这三处也过 objsOnly（跟 log / notes / findings / writeAudit.entries /
  // scoreCurve.points / entry.hits 一个写法）—— 非数组当空列表、数组里的非对象元素滤掉；
  // 以前直接 .filter / .map，宿主换了形状就是渲染期抛异常 = 记忆页签整片白屏。
  // 最小复现：
  //   usage = { pointers: 5, positions: 'x' }                 → 曾经 TypeError
  //   usage = { pointers: 5, neverOpened: 'xxx' }             → 曾经 TypeError
  //   archive.plans[0].historyFiles = 'oops'                  → 曾经 TypeError
  const positions = await renderTab('usage', fakeState({ pointers: 5, positions: 'x' }));
  assert.match(positions, /位置级曲线/, '说明书留着');
  assert.doesNotMatch(positions, /第 1 条/, '不是数组就没有位置行');
  assert.doesNotMatch(positions, /undefined|NaN/);

  const neverOpened = await renderTab('usage', fakeState({ pointers: 5, neverOpened: 'xxx' }));
  assert.match(neverOpened, /注入过的笔记/);
  assert.match(neverOpened, /都至少打开过一次/, '空清单按「都打开过」那句话回落');
  assert.doesNotMatch(neverOpened, /注入过、但从没被打开/, '不是数组就不渲染清单');
  assert.doesNotMatch(neverOpened, /undefined|NaN/);

  const state = fakeState(null);
  state.archive = {
    plans: [{ file: 'M.md', bytes: 1, keptBytes: 1, savedBytes: 0, batchCount: 1, freshCount: 1, historyFiles: 'oops' }],
    skipped: [],
  };
  const archive = await renderTab('archive', state);
  assert.match(archive, /1 个批次章节，搬走 1 个 →/);
  assert.doesNotMatch(archive, /undefined|NaN/, '不是数组就当没有历史文件');
});

test('面板：positions / neverOpened / historyFiles 数组里混了 null / 字符串时被滤掉', async () => {
  // 0.13.9 起这三处跟 hits / points 一样走 objsOnly —— 非对象元素直接滤掉：
  // 光兜「不是数组」不够，元素是 null 时读 p.position / hf.file 照样抛。
  const usage = await renderTab('usage', fakeState({
    pointers: 5,
    positions: [null, 'oops', { position: 2, injected: 4, opened: 1 }],
    neverOpened: [null, 'oops', { id: 'b.md', injected: 3, lastAt: Date.now() }],
  }));
  assert.match(usage, /第 2 条/);
  assert.match(usage, /1\/4/);
  assert.doesNotMatch(usage, /第 1 条/, 'null / 字符串不占行号');
  assert.match(usage, /注入过、但从没被打开/);
  assert.match(usage, /b\.md/);
  assert.match(usage, /1 篇从未被打开/);
  assert.doesNotMatch(usage, /undefined|NaN/);

  const state = fakeState(null);
  state.archive = {
    plans: [{
      file: 'M.md', bytes: 1, keptBytes: 1, savedBytes: 0, batchCount: 1, freshCount: 1,
      historyFiles: [null, 'oops', { file: 'H.md', batchCount: 2, bytes: 3 }],
    }],
    skipped: [],
  };
  const archive = await renderTab('archive', state);
  assert.match(archive, /H\.md（2 批 \/ 3 B）/);
  assert.doesNotMatch(archive, /undefined|NaN/);
});

test('面板：host state 缺 config 时页脚写「配置未回显」，不把「不知道」写成关', async () => {
  // 0.13.9 起：页脚的「配置」行先看 state.config 在不在 ——
  //   整块缺失 → 「配置未回显」，布尔开关一个都不写；
  //   字段缺了 → 该字段印「—」，而不是 undefined / off。
  // 「不知道」和「关」是两回事：写 off 会让人以为真关掉了。
  // 最小复现：delete state.config（真实宿主总带 config，这是老宿主 / 半截快照的分支）
  const state = fakeState(null);
  delete state.config;
  const text = await renderTab('log', state);
  assert.match(text, /配置未回显/);
  assert.doesNotMatch(text, /undefined|NaN|=off/);
  assert.doesNotMatch(text, /maxPointers|nudge=/, '整块缺失就连字段名都不列');

  // 半截配置：只有一个字段时其余印「—」，off 只留给真正的 false。
  const half = fakeState(null);
  half.config = { enabled: true };
  const halfText = await renderTab('log', half);
  assert.doesNotMatch(halfText, /配置未回显/);
  assert.match(halfText, /maxPointers=— maxChars=— minScore=— nudge=— guardWrites=— autoArchive=— enabled=/);
  assert.doesNotMatch(halfText, /undefined|NaN/);
});

test('面板：totals/index 半截时统计卡印「—」，整块缺失仍回落成 0', async () => {
  // 0.13.9 起：统计卡过 fmtNum —— 半截数据（有 totals 没 docs、有 index 没 lines）
  // 印「—」，不再是 undefined；整块缺失照旧回落成 0（老宿主分支）。
  // 最小复现：state.totals = { notes: 2 }、state.index = { bytes: 20 }
  const half = fakeState(null);
  half.totals = { notes: 2 };
  half.index = { bytes: 20 };
  const text = await renderTab('log', half);
  assert.match(text, /笔记 \| 2 \| —/, 'docs 缺了，hint 印 —');
  assert.match(text, /索引 \| — \| 20 B/, 'lines 缺了，value 印 —');
  assert.doesNotMatch(text, /undefined|NaN/);

  const bare = fakeState(null);
  for (const key of ['totals', 'index', 'writeAudit', 'archive', 'audit', 'notes', 'log']) delete bare[key];
  const fallback = await renderTab('log', bare);
  assert.match(fallback, /0 个检索片段/);
  assert.match(fallback, /0 行/);
  assert.match(fallback, /笔记（0）/);
  assert.match(fallback, /归档/);
  assert.doesNotMatch(fallback, /undefined|NaN/);
});

test('面板：统计卡里的脏数字也净化成「—」（NaN / Infinity / 1e+21 一个都不进面板）', async () => {
  // 0.13.9 起：统计卡跟使用账页签走同一条显示层净化 —— 非有限数（或超出安全整数范围）
  // 印「—」，只改显示、不动数据；「整块缺失回落 0」只留给真的没这个字段（老宿主）。
  // 最小复现：totals = { notes: NaN, docs: Infinity, bytes: NaN }、index = { lines: 1e21, bytes: NaN }
  const state = fakeState(null);
  state.totals = { notes: NaN, docs: Infinity, bytes: NaN };
  state.index = { lines: 1e21, bytes: NaN };
  const text = await renderTab('log', state);
  assert.match(text, /笔记 \| — \| — \| 库大小 \| — \| 索引 \| — \| —/);
  assert.doesNotMatch(text, /NaN|Infinity|1e\+21|undefined/);

  // 有限的负数不是脏数字：照抄，不洗成 0 也不吞掉。
  const neg = fakeState(null);
  neg.totals = { notes: -2, docs: -1, bytes: -1 };
  neg.index = { lines: -3, bytes: -1 };
  const negText = await renderTab('log', neg);
  assert.match(negText, /笔记 \| -2 \| -1 个检索片段/);
  assert.doesNotMatch(negText, /NaN|undefined/);

  // 「本轮注入」那张卡的字符数是拿日志累加出来的，脏的 chars 一样过净化。
  const logged = fakeState(null);
  logged.log = [{ at: Date.now(), kind: 'hit', query: 'q', injected: 1, chars: Infinity }];
  const loggedText = await renderTab('log', logged);
  assert.match(loggedText, /本轮注入 \| 1 次 \| 共 — 字符/);
  assert.doesNotMatch(loggedText, /NaN|Infinity|undefined/);
});

test('面板：库大小到 MB 档也要有单位（大库不能显示成 3400.0 KB）', async () => {
  const state = fakeState(null);
  state.totals = { notes: 3, docs: 9, bytes: 3500000 };
  const text = await renderTab('log', state);
  assert.match(text, /3\.34 MB/);
});

test('面板：Stat 组件体自己把 label / value / hint 摆出来，hint 是假值就不留空节点', async () => {
  await renderTab('log', fakeState(null));
  const [stat] = nodesOfType(lastTree, 'Stat');
  assert.ok(stat, '统计卡应当是 Stat 组件');
  assert.equal(textsOf(stat.type(stat.props)).join(' | '), '笔记 | 1 | 1 个检索片段');
  assert.equal(textsOf(stat.type({ label: '本轮注入', value: '—' })).join(' | '), '本轮注入 | —');
});

test('面板：点「执行归档」按契约打 POST（confirm:true），「全部执行」是一篇一篇串行', async () => {
  // index.js 的 /archive 路由要求 body 里 confirm === true（防误触），这里钉住面板发出的请求；
  // 「全部执行」的循环是 await 串行的（源码注释：并发会让后一篇基于作废的计划动库），
  // 用一个记录并发数的 fetch 桩证明同一时刻只有一个在飞。
  const plan = (file) => ({
    file, bytes: 30000, keptBytes: 8000, savedBytes: 22000, batchCount: 3, freshCount: 2,
    existingCount: 0, historyFiles: [{ file: `${file}-history.md`, batchCount: 3, bytes: 20000 }],
  });
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, historyFiles: [`${JSON.parse(init.body).file}-history.md`], backupDir: '/tmp/store/.archive-backup/1' }) };
  };
  try {
    const state = fakeState(null);
    state.archive = { plans: [plan('M.md'), plan('N.md')], skipped: [] };
    const buttonWith = (re) => elementsOfType(lastTree, 'button').find((b) => re.test(textsOf(b).join('')));

    await renderTab('archive', state);
    buttonWith(/执行归档/).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, [{ url: '/api/engramory-recall/archive', method: 'POST', body: { file: 'M.md', confirm: true } }]);
    assert.deepEqual(
      recorded.filter((u) => typeof u === 'function').pop()({}),
      { 'M.md': { ok: true, text: '已归档 → M.md-history.md；原件备份在 /tmp/store/.archive-backup/1' } },
      '归档成功后要给「搬到哪、备份在哪」的人话',
    );

    calls.length = 0;
    recorded.length = 0;
    await renderTab('archive', state);
    buttonWith(/全部执行/).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(calls.map((c) => c.body.file), ['M.md', 'N.md'], '按界面顺序一篇一篇来');
    assert.ok(calls.every((c) => c.body.confirm === true));
    assert.equal(maxInFlight, 1, '同一时刻只该有一个归档请求在飞');
    assert.deepEqual(
      recorded.find((u) => u && typeof u === 'object' && 'text' in u),
      { ok: true, text: '全部 2 篇都归档完了。' },
      '批量汇总只在全部成功时报喜',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('面板：「全部执行」遇到网络错、宿主拒绝、响应不是 JSON 三种失败都继续往下，不中断', async () => {
  // 源码注释承诺「失败不中断，剩下的照做，最后统一报数」——用三种失败形态一起证明：
  // M.md 网络层直接抛、N.md 宿主 500 说不干、Q.md 回了非 JSON、P.md 正常；
  // 四篇都要被打到，且按顺序。
  const plan = (file) => ({
    file, bytes: 30000, keptBytes: 8000, savedBytes: 22000, batchCount: 3, freshCount: 2,
    existingCount: 0, historyFiles: [],
  });
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { file } = JSON.parse(init.body);
    seen.push(file);
    if (file === 'M.md') throw new Error('ECONNRESET');
    if (file === 'N.md') return { ok: false, status: 500, json: async () => ({ ok: false, reason: '备份目录写不进去' }) };
    if (file === 'Q.md') return { ok: false, status: 502, json: async () => { throw new Error('not json'); } };
    return { ok: true, status: 200, json: async () => ({ ok: true, historyFiles: ['P-history.md'], backupDir: '/tmp/store/.archive-backup/1' }) };
  };
  try {
    const state = fakeState(null);
    state.archive = { plans: [plan('M.md'), plan('N.md'), plan('P.md'), plan('Q.md')], skipped: [] };
    await renderTab('archive', state);
    elementsOfType(lastTree, 'button').find((b) => /全部执行/.test(textsOf(b).join(''))).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(seen, ['M.md', 'N.md', 'P.md', 'Q.md'], '前面失败也要继续搬后面几篇');
    const merged = {};
    for (const update of recorded) if (typeof update === 'function') Object.assign(merged, update({}));
    assert.deepEqual(merged, {
      'M.md': { ok: false, text: 'ECONNRESET' },
      'N.md': { ok: false, text: '备份目录写不进去' },
      'P.md': { ok: true, text: '已归档 → P-history.md；原件备份在 /tmp/store/.archive-backup/1' },
      'Q.md': { ok: false, text: 'HTTP 502（响应不是 JSON）' },
    }, '每一篇的结果行都要说清成功还是失败、为什么');
    assert.deepEqual(
      recorded.find((u) => u && typeof u === 'object' && 'text' in u),
      { ok: false, text: '成功 1 篇，失败 3 篇：M.md、N.md、Q.md' },
      '有失败时汇总要报数并点名',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 收尾（0.13.9）：**元素级**脏数据。
 * 上一批用例把「不是数组」兜干净了，但 objsOnly 只到数组这一层，数组里混进 null /
 * 字符串这一层还留着残余。最狠的是跑在**页签分发之前**的那四处 —— log 的统计累计、
 * notes 的过滤器、findings 的严重性排序、writeAudit 的拦截计数：它们在 MemoryView 的
 * return 之前就抛，七个页签连渲染的机会都没有（整片白屏，只有人肉打开面板才看得见）。
 * 规矩同前：脏元素当没发生（滤掉），活下来的照常渲染成人话，一个字都不许漏 undefined。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 七个页签逐个渲染一遍（任一页签抛异常，用例就炸在这里），返回 { 页签: 文本 }。 */
async function renderAllTabs(state) {
  const out = {};
  for (const tab of ['log', 'usage', 'notes', 'audit', 'writes', 'index', 'archive']) out[tab] = await renderTab(tab, state);
  return out;
}

/** 「不抛」只是底线：白屏同样是坏结果，每个页签都得有实打实的内容。 */
function assertNoBlankTab(tabs) {
  for (const [tab, text] of Object.entries(tabs)) assert.ok(text.length > 20, `${tab} 页签不该是空的`);
}

test('面板：state.log 混进 null / 字符串时，跑在分发之前的统计与计数都不抛', async () => {
  // 最小复现：state.log = [null, 'oops', { at: 1, kind: 'hit', query: 'q', injected: 2, hits: [] }]
  // log.reduce 读 item.kind —— 元素是 null 时直接抛，而这一句在 return 之前，
  // 所以白的是七个页签，不只是日志页签。
  const state = fakeState(null);
  state.log = [null, 'oops', richLogEntry()];
  const text = await renderTab('log', state);
  // 桩不递归渲染函数组件，LogEntry 里的「注入 2 条」抠不出来 —— 断言结构：
  // 活下来的那条原样交给 LogEntry，脏元素一个都不占位。
  const [kept] = nodesOfType(lastTree, 'LogEntry');
  assert.equal(kept.props.entry, state.log[2], '活下来的那条日志照常渲染（原对象交给 LogEntry）');
  assert.match(text, /本轮注入 \| 1 次/, '脏元素不参与累计');
  assert.match(text, /召回日志（1）/, '页签计数只数得清的条目');
  assert.equal(nodesOfType(lastTree, 'LogEntry').length, 1, '脏元素不占一条日志');
  assert.doesNotMatch(text, /undefined|NaN/);
  assertNoBlankTab(await renderAllTabs(state));
});

test('面板：state.notes 混进 null / 字符串时，跑在分发之前的过滤器不抛', async () => {
  // 最小复现：state.notes = [null, 'oops', { file: 'keep.md', ... }]
  // shown 也是在 return 之前算的（notes.filter 里摸 note.file），一抛七个页签一起白。
  const state = fakeState(null);
  state.notes = [null, 'oops', { file: 'keep.md', title: '标题', description: '描述', bytes: 10, sections: 2 }];
  const text = await renderTab('notes', state);
  assert.match(text, /keep\.md/);
  assert.match(text, /笔记（1）/);
  assert.equal(elementsOfType(lastTree, 'tr').length, 2, '表头 + 一条真笔记');
  assert.doesNotMatch(text, /undefined|NaN/);

  await renderTab('notes', state, { filter: 'undefined' });
  assert.equal(elementsOfType(lastTree, 'tr').length, 1, '脏元素不该凭「字段缺失」匹配上 undefined');
  assertNoBlankTab(await renderAllTabs(state));
});

test('面板：audit.findings 混进 null / 字符串时，跑在分发之前的严重性排序不抛', async () => {
  // 最小复现：state.audit = { findings: [null, 'oops', { severity: 'error', code: 'boom', ... }] }
  // sortedFindings 在 return 之前对每个元素取 a.severity —— 元素是 null 时七个页签一起白。
  const state = fakeState(null);
  state.audit = {
    summary: { notes: 1, bySeverity: { error: 1, warn: 0, info: 0 } },
    findings: [null, 'oops', { severity: 'error', code: 'boom', message: '真问题', files: ['MEMORY.md'] }],
  };
  const text = await renderTab('audit', state);
  assert.match(text, /boom/);
  assert.match(text, /真问题/);
  assert.match(text, /MEMORY\.md/);
  assert.match(text, /1 篇笔记 · 结构错 1 · 告警 0 · 提示 0/);
  assert.match(text, /体检（1）/, '严重性计数只数得清的 finding');
  assert.equal(
    elementsOfType(lastTree, 'div').filter((n) => n.props.key === 'boom-0').length, 1,
    '活下来的 finding 排第 0 位（脏元素不占位）',
  );
  assert.doesNotMatch(text, /undefined|NaN/);
  assertNoBlankTab(await renderAllTabs(state));
});

test('面板：writeAudit.entries 混进 null / 字符串时，跑在分发之前的拦截计数不抛', async () => {
  // 最小复现：state.writeAudit = { epoch: 'guard-v1', entries: [null, 'oops', { verdict: 'deny', ... }] }
  // denied = auditEntries.filter(...) 同样在 return 之前，一抛七个页签一起白。
  const state = fakeState(null);
  state.writeAudit = {
    epoch: 'guard-v1',
    entries: [null, 'oops', { ts: 1, tool: 'write', file: 'MEMORY.md', verdict: 'deny', reason: '索引 201 行', bytes: 10 }],
  };
  const text = await renderTab('writes', state);
  assert.match(text, /规则版本 guard-v1 · 共 1 条 · 拦截 1 条/);
  assert.match(text, /MEMORY\.md/);
  assert.match(text, /索引 201 行/);
  assert.match(text, /写入审计（1）/);
  assert.doesNotMatch(text, /undefined|NaN/);
  assertNoBlankTab(await renderAllTabs(state));
});

test('面板：finding.files 不是数组或混进 null 时，整条 finding 照渲染、文件清单该省就省', async () => {
  // 最小复现：files: 'MEMORY.md' —— 曾经 f.files.join is not a function，体检页签整片白屏。
  // files 在契约里是**路径字符串数组**，所以这里不能过 objsOnly（那个按「必须是对象」过滤，
  // 会把字符串整条扔光，好数据也没了）—— 用同一族的字符串版：不是数组当空清单，
  // 元素只留字符串。跟 hits 一个规矩：非数组 = 没有清单。
  const state = fakeState(null);
  state.audit = {
    summary: { notes: 3, bySeverity: { error: 1, warn: 1, info: 1 } },
    findings: [
      { severity: 'info', code: 'files-not-array', message: 'files 是字符串', files: 'a-string.md' },
      { severity: 'warn', code: 'files-mixed', message: 'files 混了 null', files: [null, 'kept.md', 42] },
      { severity: 'error', code: 'files-empty', message: 'files 是空数组', files: [] },
    ],
  };
  const text = await renderTab('audit', state);
  for (const code of ['files-not-array', 'files-mixed', 'files-empty']) assert.match(text, new RegExp(code), `${code} 这条结论要照常给出`);
  assert.match(text, /kept\.md/, '数组里的真路径原样印出（契约里的字符串标签不动）');
  assert.doesNotMatch(text, /a-string\.md/, '不是数组就当没有文件清单');
  assert.doesNotMatch(text, /undefined|NaN/);
  const filesLines = elementsOfType(lastTree, 'div').filter((n) => n.props.style && n.props.style.paddingLeft === '20px');
  assert.equal(filesLines.length, 1, '三条 finding 里只有一条有文件清单');
  assert.equal(textsOf(filesLines[0]).join(''), 'kept.md');
});

test('面板：archive.plans / skipped 混进 null / 字符串时，归档页签不白屏、脏元素不占一篇', async () => {
  // 最小复现：archive.plans = [null, {...}]、archive.skipped = [null, {...}]
  // plans.map 读 plan.file、skipped.map 读 s.file —— 都在归档卡片里，抛了就是这一页白屏。
  const state = fakeState(null);
  state.archive = {
    plans: [null, 'oops', {
      file: 'M.md', bytes: 30000, keptBytes: 8000, savedBytes: 22000, batchCount: 3,
      freshCount: 2, existingCount: 0, historyFiles: [{ file: 'M-history.md', batchCount: 3, bytes: 20000 }],
    }],
    skipped: [null, { file: 'y.md', reason: '还不到门槛' }],
  };
  const text = await renderTab('archive', state);
  assert.match(text, /M-history\.md（3 批 \/ 19\.5 KB）/, 'historyFiles 里剩的真条目照常印出');
  // 「：」后面是另一个文本节点，跨节点的整句会被 ' | ' 隔开，分两段断言。
  assert.match(text, /1 篇扫过但没到线：/);
  assert.match(text, /y\.md（还不到门槛）/, '脏元素不占一篇，真跳过项照常印出');
  assert.match(text, /归档（1）/, '页签计数只数得清的笔记');
  assert.deepEqual(archiveButtons(), [{ text: '执行归档', disabled: false }], '只剩一篇就不给「全部执行」');
  assert.doesNotMatch(text, /undefined|NaN/);
  assertNoBlankTab(await renderAllTabs(state));
});

test('面板：scoreCurve.points 混进 null / 字符串时，「抬高 minScore」那张表只列真行', async () => {
  // 最小复现：usage.scoreCurve.points = [null, { minScore: 3, ... }]
  // sampleCurve 以前只兜了「不是数组」，元素是 null 时读 p.minScore 抛 → 使用账页签白屏。
  const text = await renderTab('usage', fakeState({
    pointers: 5,
    scoreCurve: {
      n: 7, rounds: 2, legacy: 0, unaligned: 0, opened: 0,
      points: [null, 'oops', { minScore: 3, injected: 20, cut: 0, cutRate: 0, lost: 0 }],
    },
  }));
  assert.match(text, /配对 7 条指针 \/ 2 轮/);
  assert.match(text, /≥ 3(?![0-9])/);
  assert.match(text, /留下 20/);
  assert.match(text, /砍 0%/);
  assert.match(text, /丢过 0/);
  assert.equal((text.match(/≥ /g) || []).length, 1, '脏元素不占表格行');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：audit.summary 半截（没有 bySeverity）时摘要行印 0，体检页签不抛', async () => {
  // 最小复现：state.audit = { summary: { notes: 3 }, findings: [] }
  // 摘要行直接读 audit.summary.bySeverity.error —— 半截 summary 抛 TypeError，体检页签整片白屏。
  const state = fakeState(null);
  state.audit = { summary: { notes: 3 }, findings: [] };
  const text = await renderTab('audit', state);
  assert.match(text, /3 篇笔记 · 结构错 0 · 告警 0 · 提示 0/, '缺的按计数规矩印 0，不是 undefined');
  assert.match(text, /✅ 没发现结构问题、失联路径或可疑重复。/);
  assert.equal(tabLabels()[3], '体检', '一个已知严重性都没有就不写「体检（0）」');
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('面板：一份浑身上下都是脏元素的 state 下，七个页签全都有内容（不白屏）', async () => {
  const state = richState();
  const usage = richUsage();
  state.log = [null, richLogEntry()];
  state.notes = [null, ...state.notes];
  state.audit.findings = [null, { severity: 'warn', code: 'dirty', message: '半截 finding', files: 'oops' }];
  state.writeAudit.entries = [null, state.writeAudit.entries[0]];
  state.archive = { plans: [null, state.archive.plans[0]], skipped: [null, ...state.archive.skipped], crashed: null };
  state.usage = {
    ...usage,
    positions: [null, ...usage.positions],
    neverOpened: [null, ...usage.neverOpened],
    scoreCurve: { ...usage.scoreCurve, points: [null, ...usage.scoreCurve.points] },
  };

  const tabs = await renderAllTabs(state);
  assertNoBlankTab(tabs);
  assert.match(tabs.log, /召回日志（1）/, '页签计数只数得清的条目（也证明分发之前的 reduce 没抛）');
  assert.match(tabs.usage, /位置级曲线/);
  assert.match(tabs.usage, /第 1 条/, '位置桶里的真元素照常占行');
  assert.match(tabs.notes, /a\.md/);
  assert.match(tabs.audit, /半截 finding/);
  assert.match(tabs.writes, /MEMORY\.md/);
  assert.match(tabs.index, /Memory Index/);
  assert.match(tabs.archive, /还不到门槛/);
});
