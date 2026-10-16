/**
 * 「挑哪句话」的契约测试：`search(index, query, limit, {snipget})`。
 *
 * 两条口径必须在场：
 *   - `'count'`（旧）逐字节复现 2026-10-16 之前的行为，是尺子的对照组与线上回退；
 *   - `'idf'`（新默认）IDF 加权 + 句子级 + 邻句扩展。
 *
 * 造语料的原则：每条 filler 用**互不相同**的字符二元组，好让「每次查询都出现」和
 * 「只在某一篇里出现」的 df 拉开 —— 否则 idf 的差异会被满库都有的词淹掉，
 * 测试就变成在测分词而不是在测挑选规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, search } from '../bm25.js';

/** 长到足以独占一个桶的正文：`splitBuckets` 的阈值是字符数，不铺够量就走不到「多桶」那条路。 */
const BODY_MAX = 4000;

/**
 * 多个 filler：每个都用一套只属于它的字符，保证它们的 df 与正文里那个罕见词**可比**。
 * @param {number} n 篇数（语料的 N）
 */
function fillers(n) {
  return Array.from({ length: n }, (_, i) => {
    let uniq = '';
    for (let k = 0; k < 12; k += 1) uniq += 'abcdefghijk'[(i * 7 + k) % 11] + String.fromCharCode(0x4e00 + ((i * 13 + k) % 1200));
    return {
      id: `filler-${i}.md`,
      title: `日常 手记 ${uniq.slice(0, 6)}`,
      description: '随手 记 的 东西',
      body: `今天 记 了 一点 ${uniq.slice(6)}，明天 再 补充。`,
    };
  });
}

/** 一篇「标题在复述提问、正文里才有决定性罕见词」的笔记 —— 病根的缩影。 */
const ECHO_TITLE = '打包 崩了 怎么办';
const ECHO_DESC = '打包 崩了 的 排查 顺序';

/**
 * 「口语词满库都是、罕见词只有一处」的语料 —— 这才是 idf 口径要赢的那个局面。
 *
 * 为什么不能用几篇 filler 凑合：`idf = log(1 + (N-df+0.5)/(df+0.5))` 在 df=1、N=2 时
 * 对**每个**词都给 0.693 —— 分母里的 N-df 把词与词拉平，公式退化成旧口径的「数命中个数」，
 * 测出来的就不是 idf 而是计数。口语词的 df 必须真的接近 N，它才会被压到近乎零。
 */
function spokenCorpus(gold) {
  // 24 篇讲同一件事的旧笔记 + 5 篇旁支：口语词「打包/崩了」的 df 因此接近 N=30。
  const same = Array.from({ length: 24 }, (_, i) => ({
    id: `noise-${i}.md`,
    title: `日志 ${i % 3}`,
    description: '',
    body: '打包 崩了 的 记录：换 了 个 参数。',
  }));
  const aside = ['先 看 日志。', '多半 是 缓存。', '别 慌。', '要 重装。', '先 重启。'].map((tail, i) => ({
    id: `aside-${i}.md`,
    title: `随手 ${i}`,
    description: '',
    body: `打包 崩了 ${tail}`,
  }));
  return [...same, ...aside, gold];
}

/** 取 idf 表里某个词的口径值，避免测试自己重写一遍公式而把错的口径测成对的。 */
function idfOf(index, term) {
  const df = index.docFreq.get(term) ?? 0;
  return Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
}

/** 宽宽松松超过 SNIPPET_MAX（240），用来验证「扩不进去就不扩」。 */
function longLine(term) {
  let tail = '';
  while (tail.length < 260) tail += '补充 说明 很长 ';
  return `${term} 是 长 邻句 的 起点，${tail}`;
}

test("片段口径：'count' 与 2026-10-16 之前的 bestLine 逐字节一致（含预先 clip 到 72）", () => {
  // 正文里那一行命中「打包/崩了/怎么/么办」4 个词项，length 远超 72：旧口径必须挑它，
  // 并且**当场**就截到 72（截断在新口径里归渲染层，这里钉住旧行为不放）。
  const body = [
    '先说 结论。',
    `打包 崩了 怎么办 的 答案：先看 npm run build 的退出码，再翻 node_modules 里缺的 peer。${'补'.repeat(40)}`,
    '最后 一句。',
  ].join('\n');
  const index = buildIndex([
    { id: 'gold.md', title: ECHO_TITLE, description: ECHO_DESC, body },
    ...fillers(20),
  ]);
  const hit = search(index, '打包 崩了 怎么办', 5, { snippet: 'count' })[0];
  assert.equal(hit.id, 'gold.md');
  assert.ok([...hit.snippet].length <= 72, `count 口径的片段必须预先裁剪，实得 ${hit.snippet.length} 字`);
  assert.ok(hit.snippet.endsWith('…') || hit.snippet.length < 72, '被截断时要留省略号');
  assert.ok(hit.snippet.includes('打包 崩了 怎么办'), '裁剪不该把命中的那句话切没了');
  assert.ok(!hit.snippet.includes('最后 一句'), 'count 只挑一行，不许把别的行拼进来');
});

test("片段口径：'count' 只挑一行，且挑的是命中词项最多的那行", () => {
  // 旧规则数「命中几个词」，不看词有多罕见 —— 这正是病根。这里把它的行为钉死，
  // 好让 idf 口径的改进有可比的对照。
  const index = buildIndex([
    {
      id: 'gold.md',
      title: '',
      description: '',
      body: '打包 崩了。\n打包 崩了 怎么办。\n随便 一句。',
    },
    ...fillers(20),
  ]);
  const hit = search(index, '打包 崩了 怎么办', 5, { snippet: 'count' })[0];
  // 整行原样带出（连句号一起）：旧口径挑的是「行」，不是「句」——这正是新口径要改的地方。
  assert.equal(hit.snippet, '打包 崩了 怎么办。');
});

test("片段口径：'idf' 在「标题复述提问 + 正文含罕见词」时选中正文那句", () => {
  const index = buildIndex(spokenCorpus({
    id: 'gold.md',
    title: ECHO_TITLE,
    description: ECHO_DESC,
    body: '现象：换个环境就正常。\n根因是 kwalpha 这个 配置项 写错 了。',
  }));
  // 先证明这个语料配得上「病根」二字：口语词被 df 压到近乎零，罕见词才是重的。
  assert.ok(idfOf(index, '打包') < 0.05, `口语词的 idf 该被压平，实得 ${idfOf(index, '打包')}`);
  assert.ok(idfOf(index, 'kwalpha') > 2, `罕见词的 idf 该很高，实得 ${idfOf(index, 'kwalpha')}`);

  const query = '打包 崩了 kwalpha';
  // 旧口径挑标题：正文里的证据句一个字都没进片段。
  const old = search(index, query, 3, { snippet: 'count' })[0];
  assert.equal(old.snippet, ECHO_TITLE, 'count 口径应当被标题回声带走（对照）');
  assert.ok(!old.snippet.includes('kwalpha'));
  // 新口径：标题命中三个词项也赢不了正文里那一个罕见词。
  const fresh = search(index, query, 3)[0];
  assert.equal(fresh.id, 'gold.md');
  assert.ok(fresh.snippet.includes('kwalpha'), `片段里要有罕见词，实得：${fresh.snippet}`);
  assert.ok(fresh.snippet.includes('根因'), '应当是正文里的证据句，不是标题回声');
});

test("片段口径：'idf' 的赢法随 df 走，不是「正文天然优先」，也不是「标题天然优先」", () => {
  // 想要一个「同查询、标题该赢」的局面，靠「标题多命中一个满库都有的短词」是办不到的：
  // `log(1 + …)` 恒 > 0，正文那句只要命中一个词就有正的权重，而回声被 ×0.6 之后必须
  // 靠**更罕见**的词项才能反超。所以这里用「同一个词项换到谁身上」来测：
  // 它罕见在哪一边，片段就该挑哪一边 —— 换边即换答案，说明打分真的在算 df。
  const both = '缓存 失效 的 组合 情况。';
  const fillers30 = Array.from({ length: 30 }, (_, i) => ({
    id: `f${i}.md`,
    title: `日志 ${i}`,
    description: '',
    body: `随手 记 的 第 ${i} 条，讲 缓存 与 失效 的 区别。`,
  }));
  const rareInBody = buildIndex([
    { id: 'gold.md', title: '缓存 失效', description: '', body: `缓存 失效 与 kwbeta 的 关系。\n${both}` },
    ...fillers30,
  ]);
  const rareInTitle = buildIndex([
    { id: 'gold.md', title: '缓存 失效 kwbeta', description: '', body: `缓存 失效 的 组合 情况。\n${both}` },
    ...fillers30,
  ]);
  assert.ok(idfOf(rareInTitle, 'kwbeta') > idfOf(rareInTitle, '缓存') * 10, '前提：kwbeta 确实罕见得多');

  const body = search(rareInBody, '缓存 失效 kwbeta', 5)[0].snippet;
  const title = search(rareInTitle, '缓存 失效 kwbeta', 5)[0].snippet;
  assert.ok(body.includes('kwbeta'), `罕见词在正文 → 挑正文，实得：${body}`);
  assert.ok(title.includes('kwbeta'), `罕见词在标题 → 挑标题，实得：${title}`);
  assert.notEqual(body, title, '同一个查询、只挪动罕见词的位置，挑中的句子就该跟着变');
});

test('片段口径：标题/描述打 0.6 折 —— 同词项同命中时正文赢，多命中一个才让回声赢', () => {
  // 正文句去掉句号，好让它与标题**逐字相同**：两边命中同一批词项，唯一的差别就是折扣。
  const index = buildIndex([
    { id: 'gold.md', title: '缓存失效', description: '', body: '缓存失效' },
    ...fillers(20),
  ]);
  const hit = search(index, '缓存失效', 5)[0];
  assert.equal(hit.snippet, '缓存失效', '同命中时正文该赢；若这里拿到空片段，说明回退被触发了');

  // 反过来：标题带着**正文里没有的、且数量够多**的词项时它该赢 —— 折扣是「修正优先级」，
  // 不是「禁用回声」。查 `idfOf` 的差额而不是写死数字：这条测的是「多命中能不能扛过折扣」，
  // 不是「折扣恰好等于几」。
  const wider = buildIndex([
    { id: 'gold.md', title: '缓存队列 溢出 抖动', description: '', body: '缓存失效' },
    ...fillers(20),
  ]);
  const query = '缓存失效 缓存队列 溢出 抖动';
  const titleScore = ['缓存', '存队', '队列', '溢出', '抖动'].reduce((n, t) => n + idfOf(wider, t), 0);
  const bodyScore = ['缓存', '存失', '失效'].reduce((n, t) => n + idfOf(wider, t), 0);
  assert.ok(titleScore * 0.6 > bodyScore, '前提：打折后的标题仍严格胜出');
  assert.equal(search(wider, query, 5)[0].snippet, '缓存队列 溢出 抖动');

  // 折扣只作用在标题/描述上：把命中行换到 description，同样打折。
  const viaDesc = buildIndex([
    { id: 'gold.md', title: '', description: '缓存失效', body: '缓存失效' },
    ...fillers(20),
  ]);
  assert.equal(search(viaDesc, '缓存失效', 5)[0].snippet, '缓存失效', '描述与标题同一口径');
});

test('片段口径：0.6 折扣是一行级的乘子，不是逐词打折 —— 正文多命中一个词就能翻盘', () => {
  // 这条钉的是折扣的**已知代价**（报告里要写出来的那一条）：正文句命中 3 个词项、标题只多
  // 命中 1 个词项时，标题会因为整行 ×0.6 而输。也就是说折扣让「回声多命中一个词」不再自动
  // 取胜；这是拿「标题信息量」换「正文证据」的自觉取舍，真丢了什么由地基尺子度量。
  const index = buildIndex([
    { id: 'gold.md', title: '缓存失效 与 队列', description: '', body: '缓存失效' },
    ...fillers(20),
  ]);
  assert.equal(search(index, '缓存失效 与 队列', 5)[0].snippet, '缓存失效');
});

test('片段口径：邻句扩展只扩一句、拼完不超 240；邻句不命中或放不下就不扩', () => {
  // 命中句 < 40 字 → 触发扩展；前一句也命中「缓存」同一个词 → 拼上。
  const joined = buildIndex([
    { id: 'gold.md', title: '', description: '', body: '缓存 的 TTL 是 30 秒。\n缓存 挂 了 就 重启。' },
    ...fillers(20),
  ]);
  // 默认关：2026-10-16 实测邻句扩展不涨指标、只多花预算，所以它不是默认行为。
  const hit = search(joined, '缓存', 5)[0];
  assert.equal(hit.snippet, '缓存 的 TTL 是 30 秒。', '默认不扩邻句');

  // `neighbor:true`：显式开启时才扩，且必须按原文窗口拼，不能凭记忆插空格。
  assert.equal(
    search(joined, '缓存', 5, { neighbor: true })[0].snippet,
    '缓存 的 TTL 是 30 秒。\n缓存 挂 了 就 重启。',
    '邻句要按原文窗口拼，不能凭记忆插空格',
  );

  // 邻句放不下（拼完 > 240）：宁可不拼，也不能突破上限。
  const huge = buildIndex([
    { id: 'gold.md', title: '', description: '', body: `缓存 挂 了。\n${longLine('缓存')}` },
    ...fillers(20),
  ]);
  const capped = search(huge, '缓存', 5)[0].snippet;
  assert.ok([...capped].length <= 240, `片段不得超过 240 字，实得 ${capped.length}`);
  assert.equal(capped, '缓存 挂 了。', '放不下就该退回那一句');

  // 邻句不命中同一个词：不扩（扩了是噪声，还白涨预算）。
  const noise = buildIndex([
    { id: 'gold.md', title: '', description: '', body: '缓存 挂 了。\n完全 不相干 的 一句 话。' },
    ...fillers(20),
  ]);
  assert.equal(search(noise, '缓存', 5)[0].snippet, '缓存 挂 了。');
});

test('片段口径：边界 —— 空 body / 单行 body / 无命中都不崩，且两种口径同形', () => {
  const index = buildIndex([
    { id: 'empty.md', title: '量子纠缠', description: '', body: '' },
    { id: 'one.md', title: '单行', description: '', body: '只有 一行，带 量子纠缠 和 别的 字。' },
    ...fillers(20),
  ]);

  const byEmpty = search(index, '量子纠缠', 5);
  const emptyHit = byEmpty.find((hit) => hit.id === 'empty.md');
  assert.ok(emptyHit, '空 body 的笔记也要能召回');
  assert.equal(emptyHit.snippet, '量子纠缠', '正文空 → 退到标题');

  const byOne = search(index, '量子纠缠', 5).find((hit) => hit.id === 'one.md');
  assert.equal(byOne.snippet, '只有 一行，带 量子纠缠 和 别的 字。');

  // 字段形状不许因为换了口径而变（调用方按这些字段渲染、记账）。
  for (const hit of byEmpty) {
    assert.deepEqual(
      Object.keys(hit).sort(),
      ['chars', 'id', 'matched', 'score', 'section', 'snippet'],
      '命中形状必须与旧口径一致（chars = 整篇字数，不参与打分）',
    );
    assert.ok(Number.isFinite(hit.score) && hit.score > 0);
    assert.ok(typeof hit.snippet === 'string' && hit.snippet.length > 0);
  }
});

test('片段口径：没有一行命中 matched 词时回退到标题，且与 count 口径同一处回退', () => {
  // 构造「整篇能命中分数（同义桥词），但候选行里一个字都不命中 matched」：
  // 正文只有句子本体，title/description 都是空的 —— 谁都没得挑，两边都该落到 id。
  const index = buildIndex([
    { id: 'bare.md', title: '', description: '', body: '飞书 的 机器人 回调 地址。' },
    ...fillers(20),
  ]);
  const query = '连不上';
  const fresh = search(index, query, 5).find((hit) => hit.id === 'bare.md');
  if (fresh) {
    const old = search(index, query, 5, { snippet: 'count' }).find((hit) => hit.id === 'bare.md');
    assert.equal(typeof fresh.snippet, 'string');
    assert.equal(fresh.snippet, old.snippet, '无候选时两条口径的回退目标必须一致');
  }

  // 明确的无候选：matched 只有「火锅」，正文那句只含「量子纠缠」，标题也空 → 回退 id。
  const fallback = buildIndex([
    { id: 'none.md', title: '', description: '', body: '量子 纠缠 的 一句话。' },
    ...fillers(20),
  ]);
  const hit = search(fallback, '火锅', 5)[0];
  if (hit) assert.ok(hit.snippet.length > 0 && !hit.snippet.includes('\n'));
});

test('片段口径：idf 口径下片段不再预先 clip 到 72（截断交给渲染层）', () => {
  // 225 字的一句：既能超过 72（旧口径的预裁线），又不超过 240（新口径的硬上限）。
  const body = `根因是 kwalpha 这个 配置项 写错 了，${'然'.repeat(200)}。`;
  const index = buildIndex(spokenCorpus({ id: 'gold.md', title: ECHO_TITLE, description: ECHO_DESC, body }));
  const hit = search(index, '打包 崩了 kwalpha', 3).find((h) => h.id === 'gold.md');
  assert.ok(hit.snippet.includes('kwalpha'), '前提：应当挑中正文那句');
  assert.ok(hit.snippet.length > 72, `长句应当完整交给渲染层，实得 ${hit.snippet.length} 字`);
  assert.ok([...hit.snippet].length <= 240, '但仍然不得突破 240 的硬上限');
  assert.ok(!hit.snippet.endsWith('…'), 'idf 口径不负责加省略号');
});

test('片段口径：单句本身就超过 240 时也要守住上限（长句不裁 ≠ 无上限）', () => {
  // 300 字一句：不进邻句分支（句子够长），但 240 的硬上限对它同样成立 ——
  // 否则一条指针就能把后面几条的预算吃光。
  const body = `根因是 kwalpha 这个 配置项 写错 了，${'然'.repeat(300)}。`;
  const index = buildIndex(spokenCorpus({ id: 'gold.md', title: ECHO_TITLE, description: ECHO_DESC, body }));
  const hit = search(index, '打包 崩了 kwalpha', 3).find((h) => h.id === 'gold.md');
  assert.ok(hit.snippet.includes('kwalpha'), '前提：应当挑中正文那句');
  assert.ok([...hit.snippet].length <= 240, `单句也必须 ≤240，实得 ${hit.snippet.length}`);
  assert.ok(hit.snippet.endsWith('…'), '被上限切了就该留省略号');

  // 换到消融开关（neighbor:false）也是同一条上限。
  const off = search(index, '打包 崩了 kwalpha', 3, { neighbor: false }).find((h) => h.id === 'gold.md');
  assert.ok([...off.snippet].length <= 240);
});

test('片段口径：未知/缺失的 options 退回新默认，老的三参数调用方行为不变', () => {
  const docs = [
    {
      id: 'gold.md',
      title: ECHO_TITLE,
      description: ECHO_DESC,
      body: '现象：npm run build 报 ELIFECYCLE。\n根因是 kwalpha 这个 配置项 写错 了。',
    },
    ...fillers(20),
  ];
  const index = buildIndex(docs);
  const query = '打包 崩了 kwalpha';
  const legacy = search(index, query, 5); // index.js:818 / index.js:527 / mcp.js:219 都这么调
  const explicit = search(index, query, 5, { snippet: 'idf' });
  assert.deepEqual(legacy.map((hit) => hit.snippet), explicit.map((hit) => hit.snippet));
  const bogus = search(index, query, 5, { snippet: '不存在 的 模式', neighbor: 'no' });
  assert.deepEqual(bogus.map((hit) => hit.snippet), explicit.map((hit) => hit.snippet), '只有 === false 才关邻句');
});

test('索引：docFreq 与 docCount 同口径（df 绝不超过 N，否则 idf 会变负）', () => {
  // 同一篇笔记切出来的多个桶：df 若按桶数、N 按笔记数，罕见词就会拿到负 idf ——
  // 命中越多分越低，片段挑选会反过来躲开证据句（这是实打实撞过的坑）。
  const index = buildIndex([
    { id: 'long.md', section: 'A', title: '', description: '', body: `量子纠缠${'甲'.repeat(BODY_MAX)}` },
    { id: 'long.md', section: 'B', title: '', description: '', body: `量子纠缠 火锅${'乙'.repeat(BODY_MAX)}` },
  ]);
  assert.ok(index.docCount >= 1);
  for (const [term, df] of index.docFreq) {
    assert.ok(df <= index.docCount, `df(${term})=${df} 超过了 N=${index.docCount}，idf 会变负`);
  }
});
