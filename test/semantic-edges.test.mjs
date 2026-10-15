/**
 * 语义接缝（semantic.js）的**边角与错误路径**：加载失败怎么分类、`kind` 怎么判、
 * 宿主模型那条路现在到底通不通。
 *
 * 与 `test/semantic.test.mjs` 的分工：那边钉的是「接缝的产品承诺」（默认关闭、融合不丢条、
 * 超时收得住）；这边钉的是**被承诺掩盖的那些分支** —— 它们平时只会以一行 `code` 的形式出现在
 * 检索结果里，一旦分类错了，用户拿到的是一句没法照做的提示。
 *
 * 三条纪律（与仓库既有测试一致）：
 *   1. 完全离线：一个网络请求、一次真模型调用都不发，宿主一律用假对象；
 *   2. 每个用例自建临时目录，`finally` 里**同步**清理（绝不能跨 await —— 清理没跑完就进下一个
 *      用例，下半场会看到空库）；
 *   3. 只断言**真实行为**：发现源码有问题也不改源码，就地钉住现状并写清为什么（见文件末两条）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildIndex } from '../bm25.js';
import { hostLlmPrompt, isBareSpecifier, loadProvider, resolveProviderPath, semanticSearch } from '../semantic.js';

const SHARED = '本地记忆库的检索只在这台机器上跑';

const DOCS = [
  {
    id: 'reference-npm-publish.md',
    title: '把插件发到 npm',
    description: '发版三步与 token 的坑',
    body: `${SHARED}。npm publish 之前先 npm test。granular token 不带 bypass 2FA 时只能读不能发。`,
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'project-pipeline.md',
    title: '构建流水线',
    description: 'CI 上跑什么',
    body: `${SHARED}。推 tag 之后 CI 跑测试与基准自检，两个 Node 版本。`,
    aliases: [],
    mtimeMs: 0,
  },
  {
    id: 'user-preferences.md',
    title: '表达偏好',
    description: '说话方式',
    body: `${SHARED}。偏好中文短句，能用表格就用表格。`,
    aliases: [],
    mtimeMs: 0,
  },
];

const index = buildIndex(DOCS);
const QUERY = '本地记忆库';
const ids = (result) => result.hits.map((hit) => hit.id);

/** 一次性的临时目录：写假提供方模块，跑完就删。 */
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `semantic-edges-${label}-`));
  return {
    dir,
    write: (name, body) => {
      const file = join(dir, name);
      writeFileSync(file, body);
      return file;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 假宿主 LLM：按脚本吐一段文本，再补一个正常终止 chunk（`collectText` 只认这两种 chunk）。 */
function fakeRouteLlm(text) {
  return {
    calls: [],
    async *stream(options) {
      this.calls.push(options);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/**
 * 给 host-llm 那条路递一个假宿主模型。
 *
 * 递法就是**真宿主的样子**：`ctx.get('llm')` 回那个带 `stream()` 的服务（`resolveRoute` 只回
 * provider/model 名字，两样东西是分开取的）。2026-10-16 之前 semantic.js 写的是 `route.llm.stream`，
 * 于是真宿主里这条路恒 TypeError —— 子代理测试发现后已修，这里改成按修好的形状注入。
 */
async function withRouteLlm(llm, run) {
  const runtime = {
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    config: { provider: 'fake-route', model: 'fake-model' },
  };
  const loaded = await loadProvider({ provider: 'host-llm' }, { runtime });
  assert.equal(loaded.ok, true, '配置合法、路由与 llm 服务都拿得到，就不该在加载阶段被拦');
  return run(loaded.provider, runtime);
}

/** 降级路径的统一断言：词面结果必须一条不少地原样返回（接缝坏掉不许影响检索）。 */
async function expectFallback(config, deps = {}) {
  const lexical = await semanticSearch({ index, query: QUERY, limit: 3, config: {} });
  const result = await semanticSearch({ index, query: QUERY, limit: 3, config, ...deps });
  assert.equal(result.used, false, '降级时 used 必须是 false');
  assert.deepEqual(ids(result), ids(lexical), '降级后必须逐字返回词面结果');
  return result;
}

test('语义边角：裸包名不存在 → not-found，并教用户「裸名要装在同一个 node_modules 里」', async () => {
  // 裸名走 Node 的解析（从 semantic.js 自己的位置往上找 node_modules），找不到时抛
  // ERR_MODULE_NOT_FOUND —— 这条与「路径写错」是两种不同的病，提示也必须不同：
  // 路径写错要去改路径，裸名写错要去装包。
  const loaded = await loadProvider({ provider: 'dsh-engramory-nonexistent-probe-pkg' });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'not-found');
  assert.match(loaded.message, /dsh-engramory-nonexistent-probe-pkg/, '消息里要有用户写的那个名字');
  assert.match(loaded.message, /裸名要装在同一个 node_modules 里/, '要给出可照做的下一步，而不是一句「找不到」');
  assert.equal(loaded.path, undefined, '裸名没有「解析后的路径」可报 —— 别编一个出来');

  const result = await expectFallback({ provider: 'dsh-engramory-nonexistent-probe-pkg' });
  assert.equal(result.code, 'not-found');
});

test('语义边角：裸名能加载、但不导出 rerank/expand → unsupported', async () => {
  // 「装好了」与「合规」是两回事：模块能 import 进来、但接口不对，仍然要单独报一类。
  // 这里用 `node:fs` 当那个「装好了的裸名」：它必然存在（内置），也确实两个函数都没有；
  // 不往本仓库的 node_modules 里造包 —— 本插件零依赖，且同目录有别的 agent 在并行跑测试，
  // 往插件目录里塞 node_modules 会污染别人的运行。
  const loaded = await loadProvider({ provider: 'node:fs' });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'unsupported');
  assert.match(loaded.message, /必须导出 rerank 或 expand 函数/);
  assert.match(loaded.message, /node:fs/, '消息要指出是哪个模块');
  assert.equal(loaded.path, 'node:fs');

  const result = await expectFallback({ provider: 'node:fs' });
  assert.equal(result.code, 'unsupported');
});

test('语义边角：裸名真的解析成功时 → ok，path 是配置里那一串原文', async () => {
  // 与上一条配对：失败的两条路（not-found / unsupported）之外，还得钉住裸名成功那条路
  //（semantic.js:320）的返回形状。仓库零依赖、磁盘上没有 node_modules，装不了假包；
  // data: URL 在 isBareSpecifier 眼里就是裸名（不以 . / ~ / 盘符开头），Node 也真的能 import，
  // 所以它能走完 import(seam.spec) → normalizeModule → ok 这条真实分支。
  const spec = 'data:text/javascript,export function expand() { return ["英文对照"]; }';
  assert.equal(isBareSpecifier(spec), true, '前提：它被判成裸名，才会走 import(spec) 那条分支');

  const loaded = await loadProvider({ provider: spec });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.code, 'module');
  assert.equal(loaded.kind, 'expand');
  assert.equal(loaded.path, spec, '裸名没有磁盘路径，path 原样回配置值');
  assert.deepEqual(await loaded.provider.expand({ query: QUERY }), ['英文对照'], '拿到的提供方立刻可用');
});

test('语义边角：路径写错 → 先探 readFileSync，not-found 且消息带上 error.code', async () => {
  const c = tempDir('path');
  try {
    // 相对路径：相对的是 provide 方的 baseDir（插件里就是库目录那一侧），不是 cwd。
    const relative = await loadProvider({ provider: './nope-relative.mjs' }, { baseDir: c.dir });
    assert.equal(relative.code, 'not-found');
    assert.equal(relative.path, join(c.dir, 'nope-relative.mjs'), '要报「解析后的绝对路径」，用户才知道它找的是哪儿');
    assert.match(relative.message, /ENOENT/, '带上 error.code：ENOENT 与 EISDIR/EACCES 的处置完全不同');
    assert.match(relative.message, /nope-relative\.mjs/);

    const absolute = await loadProvider({ provider: join(c.dir, 'nope-absolute.mjs') });
    assert.equal(absolute.code, 'not-found');
    assert.match(absolute.message, /ENOENT/);
    assert.equal(absolute.path, join(c.dir, 'nope-absolute.mjs'));

    // `~` 展开成一个**存在的目录**：readFileSync 探测会在 import 之前先把它拦下来（EISDIR）。
    // 只断言 code 与「不抛」——具体 errno 随平台而变，钉死反而是给未来的 CI 埋雷。
    const asDir = await loadProvider({ provider: '~' });
    assert.equal(asDir.code, 'not-found', '把目录当模块读也要归到 not-found，而不是抛出去');

    const result = await expectFallback({ provider: './nope-relative.mjs' }, { baseDir: c.dir });
    assert.equal(result.code, 'not-found');
    assert.match(result.message, /读不到提供方模块/);
  } finally {
    c.cleanup();
  }
});

test('语义边角：provider 写成空白 → 在更早一关就被判「未启用」；empty-path 那条分支够不着', async () => {
  // 现状钉住（不是期望，是事实）：describeSeam 先 trim，空串/纯空白一律返回 off，
  // 于是 loadProvider 走不到第 324 行的 `empty-path`；resolveProviderPath('') 确实返回 ''，
  // 但那个入参永远递不进来（describeSeam 与 resolveProviderPath 用的是同一个 trim 口径）。
  // 要让它可达得改源码，本轮不改 —— 谁将来动了 describeSeam，这条用例会红，
  // 正好提醒他重新决定「空白算关闭、还是算配置错误」。
  assert.equal(resolveProviderPath(''), '', 'helper 自己的契约：空进空出');
  assert.equal(resolveProviderPath('   '), '', '空白也一样');
  for (const provider of ['', '   ', '\t\n']) {
    const loaded = await loadProvider({ provider });
    assert.equal(loaded.code, 'off', `${JSON.stringify(provider)} 应当是「未启用」而不是「路径是空的」`);
    assert.equal(loaded.seam.kind, 'off');
  }
  const result = await expectFallback({ provider: '   ' });
  assert.equal(result.code, 'off');
});

test('语义边角：模块在加载时抛异常 → load-error，消息带原始文本（不吞错）', async () => {
  const c = tempDir('load');
  try {
    // 顶层 throw：文件读得到（readFileSync 那一关过得去），import() 时才炸 —— 这是
    // 「路径对、模块坏」的第三类病，绝不能和 not-found 混成一句「加载失败」。
    const boom = c.write('boom.mjs', "export function rerank() { return []; }\nthrow new Error('boom');\n");
    const loaded = await loadProvider({ provider: boom });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'load-error');
    assert.match(loaded.message, /boom/, '要把模块自己的错因带出来，否则用户只能猜');
    assert.match(loaded.message, /加载提供方失败/);
    assert.equal(loaded.path, undefined, '这一条来自 catch 兜底，没有 path 字段 —— 别指望它');

    const result = await expectFallback({ provider: boom });
    assert.equal(result.code, 'load-error');

    // 语法错与运行期抛错归同一类（都是「模块坏了」），不为此再分一个 code。
    const broken = c.write('broken.mjs', 'export function rerank( { return []; }\n');
    const syntax = await loadProvider({ provider: broken });
    assert.equal(syntax.code, 'load-error');
  } finally {
    c.cleanup();
  }
});

test('语义边角：kind 按导出形态判（两个都导出优先 rerank，默认导出也收）', async () => {
  const c = tempDir('kind');
  try {
    // 命名导出 rerank：name 取模块自己声明的那个。
    const named = c.write('named.mjs', "export const name = 'named-reranker';\nexport function rerank() { return []; }\n");
    const a = await loadProvider({ provider: named });
    assert.equal(a.ok, true);
    assert.equal(a.code, 'module');
    assert.equal(a.kind, 'rerank');
    assert.equal(a.provider.name, 'named-reranker');

    // 两个都导出：rerank 优先（文件头写明的那条纪律），name 没声明就退回文件名。
    const both = c.write('both.mjs', "export function expand() { return ['x']; }\nexport function rerank() { return []; }\n");
    const b = await loadProvider({ provider: both });
    assert.equal(b.kind, 'rerank', '两种接口都给了就用 rerank');
    assert.equal(b.provider.name, 'both.mjs', '没有 name 就用文件名兜底（便于在结果里认领是谁）');

    // 默认导出对象（第三方最自然的写法）：也收，且用它自己的 name。
    const defaultExport = c.write(
      'default.mjs',
      "export default { name: '默认导出的改写器', expand() { return ['表达偏好 中文短句']; } };\n",
    );
    const d = await loadProvider({ provider: defaultExport });
    assert.equal(d.ok, true);
    assert.equal(d.kind, 'expand', '只有 expand 的提供方 kind 就是 expand（走「只补空位」那条路）');
    assert.equal(d.provider.name, '默认导出的改写器');

    // 匿名默认导出：name 兜底成文件名，不许出现 undefined。
    const anon = c.write('anon.mjs', "export default { expand() { return ['表达偏好 中文短句']; } };\n");
    const e = await loadProvider({ provider: anon });
    assert.equal(e.kind, 'expand');
    assert.equal(e.provider.name, 'anon.mjs');

    // 端到端：默认导出形态真的能跑（补位那条路），不是只有 loadProvider 认得。
    const filled = await semanticSearch({ index, query: 'npm publish', limit: 3, config: { provider: defaultExport } });
    assert.equal(filled.used, true);
    assert.equal(filled.code, 'expanded');
    assert.equal(filled.provider, '默认导出的改写器');
  } finally {
    c.cleanup();
  }
});

test('语义边角：host-llm 真能拿到 ctx.get("llm") 并打一次模型（这条曾经是红的）', async () => {
  // 历史：loadProvider 拿到的 route 来自 llm.js 的 resolveRoute()，那个函数只回
  // { provider, model, reasoningEffort? }（llm.js:97-118）—— 没有 `llm`；而 semantic.js 曾写
  // `route.llm.stream` ⇒ 真宿主里 host-llm 的 expand 恒定 TypeError（归一成 llm-error → 降级），
  // 395-403 的 JSON 抽取永远到不了。修法：`module.getLlm(runtime.ctx)`（llm.js:80）拿真服务。
  // 这条用例现在钉的是修复后的形状：ctx 里的 llm 服务必须被真的用上。
  const fakeLlm = fakeRouteLlm('["本地记忆库 检索", "本地记忆库 召回"]');
  const runtime = {
    ctx: { get: (name) => (name === 'llm' ? fakeLlm : undefined) },
    config: { provider: 'fake-route', model: 'fake-model' },
  };

  const loaded = await loadProvider({ provider: 'host-llm' }, { runtime });
  assert.equal(loaded.ok, true, '配置本身是合法的：路由与 llm 服务都在，就该算 enabled');
  assert.equal(loaded.kind, 'expand');
  assert.equal(loaded.code, 'host-llm');

  assert.deepEqual(await loaded.provider.expand({ query: QUERY, signal: undefined }), ['本地记忆库 检索', '本地记忆库 召回']);
  assert.equal(fakeLlm.calls.length, 1, 'ctx 里那个 llm 服务必须被真的调用一次');
  assert.equal(fakeLlm.calls[0].provider, 'fake-route', 'route 的 provider/model 原样透传给宿主');
  assert.equal(fakeLlm.calls[0].model, 'fake-model');
  assert.ok(fakeLlm.calls[0].signal instanceof AbortSignal, 'collectText 会补一个超时 deadline');

  const result = await semanticSearch({ index, query: QUERY, limit: 3, config: { provider: 'host-llm' }, runtime });
  assert.equal(result.used, true, 'llm 服务在，改写就该真生效');
  assert.equal(result.code, 'expanded');
});

test('语义边角：宿主没有 llm 服务（ctx.get("llm") 回 undefined）→ 明确报 no-llm 并降级', async () => {
  // 与 no-host / no-route 并列的第三种「宿在这条路走不通」：运行时在、默认模型也在，
  // 但 llm 服务拿不到（例如宿主换了一版、服务名变了）。必须当场说清是哪一步缺，
  // 而不是等 expand 时抛一个 TypeError 再被归一成 llm-error —— 那样消息离真因很远。
  const runtime = { ctx: { get: () => undefined }, config: { provider: 'fake-route', model: 'fake-model' } };
  const loaded = await loadProvider({ provider: 'host-llm' }, { runtime });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'no-llm');
  assert.match(loaded.message, /ctx\.get\("llm"\)/, '消息要指到具体那一步');

  const result = await expectFallback({ provider: 'host-llm' }, { runtime });
  assert.equal(result.code, 'no-llm', '接缝层面：降级回词面并把 no-llm 如实透出');
  assert.match(result.message, /语义接缝降级/, '给用户的消息要说明白是接缝降级，不是「检索坏了」');
});

test('语义边角：宿主改写一旦真拿到 llm，JSON 抽取的每种形态都被钉住', async () => {
  // 上一条钉的是「拿不到 llm 服务时必须当场报 no-llm」。这一条补上 llm 真在时的解析逻辑
  // （semantic.js 的 hostLlmExpand）：模型输出怎么被切、被解析、被兜底，全部钉死。
  const cases = [
    {
      label: '散文包裹的 JSON 数组：只取第一个 [ 到最后一个 ] 之间的内容',
      text: '好的，给你三条：\n["代理节点 部署", "Hy2 双端口"]\n希望有用。',
      want: ['代理节点 部署', 'Hy2 双端口'],
    },
    { label: '一个方括号都没有 → 空改写', text: '抱歉，我直接说吧：代理节点用 Hy2 部署就行。', want: [] },
    { label: '只有左括号（end <= start）→ 空改写', text: '大概是 [ 这种写法', want: [] },
    { label: '方括号都在、但 JSON 语法坏（走 catch）→ 空改写', text: '结果是：[真的假的] 大概吧', want: [] },
    // Array.isArray 的 else 分支结构上不可达：切片必然以 [ 开头、] 结尾，合法 JSON 那就一定是数组。
    // 这里钉的是「切片恰好落在内层数组字面量上」这个事实（对象外壳被 indexOf/lastIndexOf 吃掉）。
    { label: '外层是对象、内层是数组 → 取到内层数组', text: '{"改写": ["甲", "乙"]}', want: ['甲', '乙'] },
  ];

  for (const item of cases) {
    const llm = fakeRouteLlm(item.text);
    await withRouteLlm(llm, async (provider, runtime) => {
      assert.deepEqual(await provider.expand({ query: QUERY }), item.want, item.label);

      // 顺手钉住参数是怎么进宿主的：route 的 provider/model 原样透传，提示词用同一份 hostLlmPrompt。
      assert.equal(llm.calls.length, 1, `${item.label}：一次 expand 只打一次模型`);
      assert.equal(llm.calls[0].provider, 'fake-route');
      assert.equal(llm.calls[0].model, 'fake-model');
      assert.equal(llm.calls[0].maxTokens, 200);
      assert.deepEqual(llm.calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: hostLlmPrompt(QUERY) }] }]);
      assert.ok(llm.calls[0].signal instanceof AbortSignal, '超时兜底由 collectText 补一个 deadline');

      if (item.want.length > 0) {
        // 端到端反证：llm 一旦真能拿到，host-llm 整条链路（改写进来、词面兜底）就是通的。
        const result = await semanticSearch({ index, query: QUERY, limit: 3, config: { provider: 'host-llm' }, runtime });
        assert.equal(result.code, 'expanded');
        assert.equal(result.provider, 'host-llm');
      }
    });
  }

});

test('语义边角：hostLlmPrompt 是提示词本身（导出给尺子复用，口径必须同一份）', () => {
  const prompt = hostLlmPrompt('代理节点怎么部署');
  const lines = prompt.split('\n');
  assert.equal(lines.length, 3, '提示词就三行：要求、格式、问题');
  assert.match(lines[0], /改写成 3 条/);
  assert.match(lines[1], /只输出 JSON 数组/, '格式要求必须写死，否则解析口径会飘');
  assert.equal(lines[2], '问题：代理节点怎么部署', '问题原样拼在最后一行（不转义、不裁剪）');
});

test('语义边角：expand 返回空数组（或全是不合法改写）→ provider-empty 且退回词面', async () => {
  const c = tempDir('empty');
  try {
    for (const [label, body] of [
      ['空数组', 'export function expand() { return []; }'],
      ['非数组垃圾', 'export function expand() { return 42; }'],
      ['全是空串与重复原查询', `export function expand({ query }) { return ['   ', query, null]; }`],
    ]) {
      const file = c.write(`e-${label}.mjs`, `${body}\n`);
      const result = await expectFallback({ provider: file });
      assert.equal(result.code, 'provider-empty', `${label}：没有可用改写就是 provider-empty`);
      assert.match(result.message, /没给出任何可用的改写/);
      assert.match(result.message, /已降级/);
      assert.equal(result.expansions, undefined, '降级路径不返回 expansions 字段');
    }
  } finally {
    c.cleanup();
  }
});
