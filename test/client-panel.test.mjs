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

/** 极小的 React 桩：够 client.js 用（9 个 useState、1 个 useRef、1 个 useEffect）。 */
function stubReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      // 按调用序发预设值；用完了就回落到初始值（未列到的状态保持原样）。
      const next = pending.length ? pending.shift() : initial;
      return [next === undefined ? initial : next, () => {}];
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
async function renderWith(values) {
  // 桩与组件只建一次（bundle 只能 import 一次），每次渲染只换「预设值队列」：
  // 这样多次渲染复用同一个 factory 闭包，useState 仍然能拿到本轮想要的宿主 state。
  pending.length = 0;
  pending.push(...values);
  componentRef = await loadPanel();
  const tree = componentRef();
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
