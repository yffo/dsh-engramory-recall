/**
 * bm25.js 的专属单测。
 *
 * 这个模块此前只有 `test/recall.test.mjs` 顺带覆盖的几条（中文双字、虚词过滤、同义桥形状、
 * decay 开/关的排序效果）。这里补的是它没钉住的部分，分四层：
 *
 *   1. 分词与查询词项：中英混排、汉字单/双字口径、ASCII 与全角标点、代理对、超长串；
 *   2. 同义表本体与扩展：表的形状纪律、字面匹配、跨键去重、以及「桥权」分支的可达性；
 *   3. 打分不变量：确定性、IDF 方向、长度归一的**笔记级**口径、cap 选词、形状与 limit；
 *   4. 两个时间维：decay（指数、可关、有地板）与 boost（有界 ±w），以及片段裁剪。
 *
 * 全部是纯内存语料：不读盘、不写盘、不联网、不碰真实记忆库，整个文件毫秒级。
 * 断言按「实现写实」写 —— 与注释口径不一致的地方（汉字单字、'崩' 这个单字键、全角拉丁）
 * 都在注释里点明了实际行为，并记进了交付报告，而不是按注释臆想一个 API。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNONYMS,
  SUGGESTED_HALF_LIFE_DAYS,
  buildIndex,
  clip,
  expandQuery,
  matchedSynonymKeys,
  queryTerms,
  search,
  tokenize,
} from '../bm25.js';

const DAY = 86400000;
/** 固定时间基准：decay / boost 都要注入 now，否则用例会随真实时钟漂移。 */
const NOW = 1_700_000_000_000;

/** 文档工厂：只有 id + body 的笔记，其余字段留空（字段加权默认只重复 title/description）。 */
const doc = (id, body, extra = {}) => ({ id, title: '', description: '', body, ...extra });

// ── 一、分词 ────────────────────────────────────────────────────────────

test('分词：中英混排先出英文/数字词元，再出汉字的相邻双字', () => {
  // 顺序是分词器的实现顺序（先扫英文词元，再把汉字游程切双字），不是出现顺序 ——
  // 后面 `queryTerms` 的「不做字典序排序」就建立在这一点上。
  assert.deepEqual(tokenize('代理节点 Hy2 端口'), ['hy2', '代理', '理节', '节点', '端口']);
  assert.deepEqual(tokenize('连不上 ENOTFOUND 飞书 feishu'), ['enotfound', 'feishu', '连不', '不上', '飞书']);
});

test('分词：汉字连写只出双字，单字只在独立成段时产出', () => {
  // 模块头注释写的是「单字 + 相邻双字」，实现里单字**只在游程长度为 1** 时产出：
  // 「代理节点」四字连写给的是 3 个双字，没有 代/理/节/点 四个单字。
  // 钉住这条差别，免得后人按注释去假设「单字也在索引里」。
  assert.deepEqual(tokenize('代理节点'), ['代理', '理节', '节点']);
  assert.deepEqual(tokenize('我 的 是'), ['我', '的', '是']);
  assert.deepEqual(tokenize('中，文'), ['中', '文']); // 标点把连写切断 → 两个单字
});

test('分词：大小写归一，整词与连字符/斜杠碎片都进索引', () => {
  // 碎片那一层是实测补上的：`html-ppt` 若只整词入库，查询里写 `ppt` 永远匹配不上。
  assert.deepEqual(tokenize('HTML-PPT'), ['html-ppt', 'html', 'ppt']);
  assert.deepEqual(tokenize('CSS/JS'), ['css/js', 'css', 'js']);
  assert.deepEqual(tokenize('DeepSeek'), ['deepseek']);
});

test('分词：碎片只取长度 ≥2 的，版本号不被炸成单字符噪声', () => {
  assert.deepEqual(tokenize('v0.2.3'), ['v0.2.3', 'v0']); // 不是 v/0/2/3 一堆碎片
  assert.deepEqual(tokenize('a'), []); // 单字符英文/数字不成词项
  assert.deepEqual(tokenize('aa'), ['aa']);
  assert.deepEqual(tokenize('c++'), ['c++']);
  assert.deepEqual(tokenize('c#'), ['c#']);
  assert.deepEqual(tokenize('a_b'), ['a_b']);
});

test('分词：空串/空白/全角标点/emoji 都不出词项，也不抛；非字符串被兜住', () => {
  for (const s of ['', '   ', '\n\t', '！！！？？，。', '🙂🙂👍']) {
    assert.deepEqual(tokenize(s), [], `「${s}」不该产出词项`);
  }
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(42), ['42']); // String() 兜底，调用方传数字也不炸
});

test('分词：ASCII 标点只要长度 ≥2 且全在词元字符集内，也会成一个词项', () => {
  // `---` 是 markdown 分隔线、`...` 是省略号：它们真的占一个词项名额、也真的把 len 撑大
  // （分割线多的笔记会因此略微吃亏）。无害但反直觉，钉住以免将来误判成「空输入」。
  assert.deepEqual(tokenize('---'), ['---']);
  assert.deepEqual(tokenize('...'), ['...']);
  assert.deepEqual(tokenize('//'), ['//']);
  assert.deepEqual(tokenize('+'), []); // 单字符仍不成词元
});

test('分词：全角拉丁字符一个都不进词项（只有半角进）', () => {
  // 这是一条真实的召回盲区：输入法打出的全角 `ｐｐｔ` 会静默地一条都匹配不上。
  assert.deepEqual(tokenize('ＡＢＣ'), []);
  assert.deepEqual(tokenize('ＡＢＣ abc'), ['abc']);
});

test('分词：超长重复串只按滑窗出双字，不产出整体词元，也不退化', () => {
  assert.deepEqual(tokenize('重复'.repeat(3)), ['重复', '复重', '重复', '复重', '重复']);
  assert.equal(queryTerms('重复'.repeat(3)).length, 2); // 去重后只剩两个词项
  const huge = tokenize('填'.repeat(10000));
  assert.equal(huge.length, 9999); // 线性滑窗，不炸栈也不爆内存
  assert.ok(huge.every((t) => t === '填填'));
});

test('分词：多字节/代理对混排不产生半个字符的词项', () => {
  // 半个代理对是「字符串被按字节切过」的典型症状：它会让下游的 JSON / 正则悄悄走样。
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const samples = [
    '👍a',
    '👍👍 量子纠缠',
    '中文🙂English 混排',
    '🏳️‍🌈 代理节点',
    '👨‍👩‍👧‍👦 打包崩了',
  ];
  for (const s of samples) {
    for (const term of tokenize(s)) {
      assert.ok(!lone.test(term), `词项里出现半个代理对: ${JSON.stringify(term)}（来自 ${s}）`);
    }
  }
  assert.deepEqual(tokenize('👍a'), []); // emoji + 单字符 = 没有词项（而不是崩溃）
  assert.deepEqual(tokenize('中文🙂English 混排'), ['english', '中文', '混排']); // emoji 只当分隔符
});

// ── 二、查询词项 ────────────────────────────────────────────────────────

test('查询词项：相对分词只做「去重 + 过滤」，顺序与词项本身都不改写', () => {
  const query = 'beta 中文 beta alpha 的';
  const raw = tokenize(query);
  assert.deepEqual(raw, ['beta', 'beta', 'alpha', '中文', '的']);
  // 不做字典序排序：英文词元在前、汉字双字在后，就是分词器的产出顺序；
  // 也没有任何 stemming/改写 —— 每个词项都原样出现在 tokenize 的结果里。
  assert.deepEqual(queryTerms(query), ['beta', 'alpha', '中文', '的']);
  for (const term of queryTerms(query)) assert.ok(raw.includes(term), `${term} 不是分词器的原样产物`);
});

test('查询词项：去重保留首次出现的位置，绝不产出重复项', () => {
  assert.deepEqual(tokenize('代理 代理'), ['代理', '代理']);
  assert.deepEqual(queryTerms('代理 代理'), ['代理']);
  for (const q of ['alpha alpha 中文 alpha', '量子 量子纠缠 量子', '打包崩了 打包']) {
    const terms = queryTerms(q);
    assert.equal(new Set(terms).size, terms.length, `不该有重复词项: ${terms.join(',')}`);
    assert.ok(terms.every((t) => tokenize(q).includes(t)));
  }
});

test('查询词项：空/空白/纯标点/纯 emoji/纯全角 → 空数组，调用方据此短路', () => {
  for (const q of ['', '   ', '！！！？？', '🙂🙂', 'ＡＢＣ', null, undefined]) {
    assert.deepEqual(queryTerms(q), [], `「${String(q)}」不该产出查询词项`);
  }
});

// ── 三、同义表与查询扩展 ────────────────────────────────────────────────

test('同义表：每个键的值都是数组，且没有自环（自己桥到自己毫无信息量）', () => {
  assert.ok(SYNONYMS.size > 100, `表规模异常缩小: ${SYNONYMS.size}`);
  for (const [key, values] of SYNONYMS) {
    assert.ok(Array.isArray(values), `${key} 的值不是数组: ${typeof values}`);
    for (const value of values) {
      assert.notEqual(
        String(value).toLowerCase(),
        String(key).toLowerCase(),
        `${key} 桥到了自己 —— 权重会平白多算一份`,
      );
    }
  }
});

test('同义表：键全部小写（匹配走小写 includes），单字键只有「崩」这一个例外', () => {
  for (const key of SYNONYMS.keys()) {
    assert.ok(key.length > 0, '空键会匹配到任何查询');
    assert.equal(key, key.toLowerCase(), `键必须小写，否则原文匹配口径和小写化查询对不上: ${key}`);
  }
  const single = [...SYNONYMS.keys()].filter((k) => [...k].length < 2);
  // 表头纪律写的是「键不短于 2 字」（单字太泛会污染一大批无关查询）；'崩' 是唯一进来的单字。
  // 这条断言是「纪律快照」：出现第二个单字键时应当是有意为之，需要单独确认。
  assert.deepEqual(single, ['崩'], `单字键是纪律的例外，出现新的要单独确认: ${single.join(',')}`);
  assert.deepEqual(SYNONYMS.get('崩'), ['crash']);
});

test('同义表：每个值过分词后至少产出一个词项（否则是永远查不到的死词）', () => {
  // 库里的词项形状是「英文整词 + 汉字相邻双字」，一个分词后为空的值 = 一条静默失效的桥。
  for (const [key, values] of SYNONYMS) {
    for (const value of values) {
      assert.ok(tokenize(value).length > 0, `${key} → 「${value}」分词后是空的，等于没写`);
    }
  }
});

test('同义键命中按原文字面，不走分词；返回顺序即表内顺序', () => {
  // 「连不上」会被分词器切成 连不/不上 —— 键能命中恰恰因为它匹配的是**原文 includes**，
  // 这也是三字口语能查到表的原因（见 bm25.js 的收录纪律）。
  assert.deepEqual(tokenize('连不上'), ['连不', '不上']);
  assert.deepEqual([...matchedSynonymKeys('飞书那边一直连不上')].sort(), ['连不上', '飞书']);
  assert.deepEqual(matchedSynonymKeys('量子纠缠火锅'), []);
  assert.deepEqual(matchedSynonymKeys(null), []);
});

test('查询扩展：不重复查询自身的词项，跨键命中要合并去重', () => {
  assert.deepEqual(expandQuery('打包 build'), ['bundle']); // build 已在查询里，不再补一遍
  assert.deepEqual(expandQuery('打包 崩了'), ['crash', 'build', 'bundle']); // 表内顺序
  const merged = expandQuery('样式全没'); // 「样式」与「样式全没」两个键同时命中
  assert.deepEqual(merged, ['css', 'style', 'assets']);
  assert.equal(new Set(merged).size, merged.length);
});

test('查询扩展：无键命中/空输入 → 空数组', () => {
  for (const q of ['量子纠缠火锅', '', '   ', null, undefined]) {
    assert.deepEqual(expandQuery(q), []);
  }
});

test('桥权分支：只要扩展出了桥词，就必定有键命中 —— EXTRA_WEIGHT 那条路不可达', () => {
  // search() 里 `bridgeWeight = bridged.length ? BRIDGE_WEIGHT(1) : EXTRA_WEIGHT(0.5)`。
  // 但 expandQuery 与 matchedSynonymKeys 读的是**同一张表**、都是原文 includes
  // （后者还把两边都小写化，只会更宽），所以 extras 非空 ⇒ bridged 非空。
  // 结论：EXTRA_WEIGHT = 0.5 目前是死代码，模块注释里 0.5 与 0.8 的取舍记录不影响运行结果。
  // 这里把它钉成**不变量**：将来谁把两个匹配口径改成不一致，这条会立刻红。
  for (const key of SYNONYMS.keys()) {
    const expanded = expandQuery(key);
    assert.ok(
      expanded.length === 0 || matchedSynonymKeys(key).length > 0,
      `键「${key}」扩展出了词项却没有被 matchedSynonymKeys 认到 —— 两个匹配口径已经分叉`,
    );
  }
  for (const q of ['量子纠缠火锅', '', '随便一句没有桥的话 xyz']) {
    assert.ok(expandQuery(q).length === 0 || matchedSynonymKeys(q).length > 0);
  }
});

// ── 四、打分不变量 ──────────────────────────────────────────────────────

const CORPUS = [
  doc('reference-cache.md', '缓存穿透的排查方法，以及它和缓存击穿的区别。'),
  doc('reference-proxy.md', '美国自建代理节点架构，Hy2 双端口主力加 Trojan 兜底。'),
  doc('project-cicd.md', 'Jenkins 多段部署命令只有第一条走 SSH。'),
  doc('feedback-style.md', '杨总偏好：结论先行，不要客套话。'),
];

test('打分：同一索引重复调用结果逐字相同（含分数），重建索引也同分', () => {
  const index = buildIndex(CORPUS);
  const first = search(index, '缓存穿透', 5);
  assert.deepEqual(search(index, '缓存穿透', 5), first);
  // 重建一份索引（同一批文档、不注入 now）必须给出同样的分数：打分里没有随机数、
  // 没有 Map 迭代顺序之外的隐藏状态 —— 这是「召回可复现」的地基。
  assert.deepEqual(search(buildIndex(CORPUS), '缓存穿透', 5), first);
});

test('打分：罕见词的 IDF 高于常见词（等长等词频构造，差异只来自 df）', () => {
  // 10 篇文档长度、查询词词频全相同，唯一变量是 df：zebra 只在 1 篇里，common 在 9 篇里。
  const docs = Array.from({ length: 10 }, (_, i) =>
    doc(`d${i}.md`, i === 0 ? 'zebra shared pad pad' : 'common shared pad pad'),
  );
  const index = buildIndex(docs);
  assert.equal(index.docs[0].len, index.docs[1].len); // 长度归一被排除在外
  const rare = search(index, 'zebra', 1)[0];
  const common = search(index, 'common', 1)[0];
  assert.equal(rare.id, 'd0.md');
  assert.ok(rare.score > common.score * 5, `df=1 该远比 df=9 重: ${rare.score} vs ${common.score}`);
});

test('打分：词频相同时文档越长分越低（长度归一的方向）', () => {
  const docs = [0, 1, 3, 8].map((k) => doc(`len${k}.md`, `量子纠缠 ${'填充内容'.repeat(k)}`));
  const hits = search(buildIndex(docs), '量子纠缠', 5);
  assert.deepEqual(hits.map((h) => h.id), ['len0.md', 'len1.md', 'len3.md', 'len8.md']);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score > hits[i].score, '同词频下长度惩罚必须是严格单调的');
  }
});

test('打分：分数始终有限且为正；全库都有的词靠 +1 平滑也不会变负', () => {
  const docs = Array.from({ length: 4 }, (_, i) => doc(`d${i}.md`, '量子纠缠'));
  const hits = search(buildIndex(docs), '量子纠缠', 10);
  assert.equal(hits.length, 4);
  for (const hit of hits) {
    assert.ok(Number.isFinite(hit.score), `分数必须是有限数: ${hit.score}`);
    assert.ok(hit.score > 0, `命中不该带非正分数: ${hit.score}`);
  }
  // df === 文档数时 idf = log(1 + 0.5/1.5) > 0：单篇语料、或者满库都有的词，仍然召回得到。
  assert.equal(search(buildIndex([doc('only.md', '量子纠缠')]), '量子纠缠', 5).length, 1);
});

test('打分：空语料返回空命中且不除零；没有匹配时不返回零分结果', () => {
  const empty = buildIndex([]);
  assert.deepEqual(empty.docs, []);
  assert.equal(empty.avgLen, 1); // 分母兜底成 1，而不是 0 / NaN
  assert.deepEqual(search(empty, '量子纠缠', 5), []);

  const index = buildIndex([doc('a.md', '量子纠缠'), doc('b.md', '缓存穿透')]);
  // 不相关中文 / 未知英文 / 纯 emoji / 纯标点 / 空串 / null 都必须是空数组（而不是零分占位）
  for (const q of ['火锅底料配方', 'zzzqqq', '🙂🙂', '！！！', '', '   ', null, undefined]) {
    assert.deepEqual(search(index, q, 5), [], `「${String(q)}」不该有命中`);
  }
});

test('命中形状：只带 id/section/score/snippet/matched，matched 只列文档真有的词项', () => {
  const index = buildIndex([doc('a.md', '量子纠缠')]);
  const [hit] = search(index, '量子纠缠 火锅', 5);
  assert.deepEqual(Object.keys(hit).sort(), ['id', 'matched', 'score', 'section', 'snippet']);
  assert.deepEqual(hit.matched, ['量子', '子纠', '纠缠']); // 「火锅」不在文档里，不进 matched
  assert.equal(hit.snippet, '量子纠缠');
  assert.equal(hit.section, undefined); // 没切桶的笔记没有 section 字段
});

test('排序与 limit：同分按 id 兜底，limit 截断且默认 5', () => {
  const tie = buildIndex([doc('bbb.md', '量子纠缠'), doc('aaa.md', '量子纠缠')]);
  assert.deepEqual(search(tie, '量子纠缠', 5).map((h) => h.id), ['aaa.md', 'bbb.md']);

  const many = buildIndex(Array.from({ length: 8 }, (_, i) => doc(`d${i}.md`, '量子纠缠')));
  assert.equal(search(many, '量子纠缠').length, 5); // 默认 limit = 5
  assert.equal(search(many, '量子纠缠', 2).length, 2);
  assert.deepEqual(search(many, '量子纠缠', 0), []);
});

test('选词 cap：长查询里最特异的词不会被高频词挤掉', () => {
  // 26 个词项（> QUERY_TERM_CAP）的查询：25 个词满库都有、rare7 只在 d7.md 里。
  // cap 按 df 升序保留最特异的那些，所以 rare7 必须活下来并把 d7 顶到第一。
  const commons = Array.from({ length: 25 }, (_, i) => `w${i}`);
  const docs = Array.from({ length: 30 }, (_, i) => doc(`d${i}.md`, `${commons.join(' ')} rare${i}`));
  const index = buildIndex(docs);
  const query = [...commons, 'rare7'].join(' ');
  assert.equal(queryTerms(query).length, 26);
  const hits = search(index, query, 30);
  assert.equal(hits[0]?.id, 'd7.md');
  assert.equal(hits.length, 30); // 其余 24 个词的分数都还在，说明只是截断了名额而不是清空
});

test('选词 cap：df === 0 的噪声词不占名额，也不把有用的词挤出去', () => {
  // 模块注释里那条 ⚠️ 的直接反面：若让 df===0 的词参与「最特异」排序，日志里的 ghost37
  // 会占满 24 个名额、公共词全被丢，除 d7 外一篇都召不回（注释说实测就是这样）。
  const commons = Array.from({ length: 25 }, (_, i) => `w${i}`);
  const docs = Array.from({ length: 30 }, (_, i) => doc(`d${i}.md`, `${commons.join(' ')} rare${i}`));
  const index = buildIndex(docs);
  const ghosts = Array.from({ length: 30 }, (_, i) => `ghost${i}`);
  const hits = search(index, [...ghosts, ...commons, 'rare7'].join(' '), 30);
  assert.equal(hits[0]?.id, 'd7.md');
  assert.equal(hits.length, 30, 'df===0 的词若占掉 cap，公共词会被丢，除 d7 外一篇都召不回');
});

test('同义桥：查询字面在语料里一次都不出现时，靠桥召回技术写法', () => {
  const index = buildIndex([
    doc('build-crash.md', 'the build failed and the process did crash, exit code 1', { title: 'build pipeline' }),
    doc('unrelated.md', '今天去超市买西红柿和鸡蛋，顺便取快递。'),
  ]);
  const hits = search(index, '打包崩了', 5);
  assert.deepEqual(hits.map((h) => h.id), ['build-crash.md']);
  // 钉住「原词不出现」：查询的全部双字碎片都不在目标笔记里，命中完全来自同义桥 ——
  // 没有桥的话这条查询是字面零重叠，一条都召不回。
  const target = index.docs.find((d) => d.id === 'build-crash.md');
  for (const term of tokenize('打包崩了')) assert.ok(!target.tf.has(term), `「${term}」竟然在语料里`);
  assert.deepEqual([...hits[0].matched].sort(), ['build', 'crash']);
});

// ── 五、字段加权、别名与长度归一的口径 ──────────────────────────────────

test('标题加权：标题命中压过正文命中，哪怕重复标题把这篇的长度撑大', () => {
  const index = buildIndex([
    doc('titled.md', '无关正文', { title: '量子纠缠' }),
    doc('body.md', '量子纠缠'),
  ]);
  assert.deepEqual(search(index, '量子纠缠', 5).map((h) => h.id), ['titled.md', 'body.md']);
  // 机制写实：标题词被计 24 遍 ⇒ 长度从 6 涨到 78（标题命中是「多计几遍」而不是字段分离），
  // 但分数仍然更高 —— 这正是 TITLE_EXTRA 那次调参要的结果。
  assert.equal(index.docs[0].len, 78);
  assert.ok(index.docs[0].len > index.docs[1].len);
});

test('别名：作者点名的 aliases 按两遍计入，正文里没有也能召回', () => {
  const withAlias = buildIndex([{ id: 'a.md', title: '', description: '', body: '正文没有那个词', aliases: ['quantum'] }]);
  const without = buildIndex([{ id: 'a.md', title: '', description: '', body: '正文没有那个词' }]);
  assert.equal(withAlias.docs[0].tf.get('quantum'), 2); // 计两遍
  assert.equal(withAlias.docs[0].len, without.docs[0].len + 2);
  assert.deepEqual(search(withAlias, 'quantum', 5).map((h) => h.id), ['a.md']);
  // 非数组 / 空数组的 aliases 被安静忽略，而不是抛错或当字符串拼进去
  const bad = buildIndex([{ id: 'b.md', title: '', description: '', body: '正文没有那个词', aliases: 'quantum' }]);
  assert.equal(bad.docs[0].tf.has('quantum'), false);
  const emptyAliases = buildIndex([{ id: 'c.md', title: '', description: '', body: 'aa bb', aliases: [] }]);
  assert.equal(emptyAliases.docs[0].len, 2); // 空数组等于没写别名
});

test('长度归一是「笔记级」的：同 id 的桶共享整篇长度，avgLen 按笔记数统计', () => {
  const index = buildIndex([
    { id: 'long.md', section: '第1桶', title: '', description: '', body: '量子纠缠 甲' }, // 自己只有 4 个词项
    { id: 'long.md', section: '第2桶', title: '', description: '', body: '量子纠缠 乙 丙 丁 戊 己' }, // 8 个
    doc('other.md', '量子纠缠'), // 3 个
  ]);
  assert.deepEqual(index.docs.map((d) => d.len), [12, 12, 3]);
  // (12 + 3) / 2 篇笔记 = 7.5。若按**桶**平均会得到 (12+12+3)/3 = 9 —— 那会放松对长文的惩罚，
  // 正是注释里说的「碎桶把基准拉低」。
  assert.equal(index.avgLen, 7.5);
});

test('同 id 的多个桶只返回分最高的那桶；并列时保留先出现的桶', () => {
  const best = buildIndex([
    { id: 'long.md', section: 'A', title: '', description: '', body: '量子纠缠' },
    { id: 'long.md', section: 'B', title: '', description: '', body: '量子纠缠 火锅' },
  ]);
  const hits = search(best, '量子纠缠火锅', 5);
  assert.equal(hits.length, 1); // 一篇笔记只占一个召回位
  assert.equal(hits[0].section, 'B'); // 命中的是那一桶，片段也来自它
  assert.equal(hits[0].snippet, '量子纠缠 火锅');

  const tie = buildIndex([
    { id: 'long.md', section: 'A', title: '', description: '', body: '量子纠缠' },
    { id: 'long.md', section: 'B', title: '', description: '', body: '量子纠缠' },
  ]);
  const tieHits = search(tie, '量子纠缠', 5);
  assert.equal(tieHits.length, 1);
  assert.equal(tieHits[0].section, 'A'); // 严格大于才替换 ⇒ 并列保先（有序、可复现）
});

// ── 六、时间衰减（decay） ───────────────────────────────────────────────

test('衰减：不传 halfLifeDays 时默认关闭（乘子恒为 1，差十年也不计）', () => {
  const index = buildIndex(
    [doc('old.md', '缓存穿透', { mtimeMs: NOW - 3650 * DAY }), doc('new.md', '缓存穿透', { mtimeMs: NOW })],
    { now: NOW },
  );
  assert.deepEqual(index.docs.map((d) => d.decay), [1, 1]);
  const hits = search(index, '缓存穿透', 5);
  assert.equal(hits[0].score, hits[1].score); // 内容相同 ⇒ 同分，只有 id 兜底排序
});

test('衰减：无 mtime / mtime 为 0 / NaN / 未来时间 → 恒为 1，绝不放大', () => {
  const decayOf = (extra) => buildIndex([doc('a.md', '量子纠缠', extra)], { halfLifeDays: 30, now: NOW }).docs[0].decay;
  assert.equal(decayOf({}), 1); // 没有 mtime（比如内存里造的文档）
  assert.equal(decayOf({ mtimeMs: 0 }), 1); // 0 是 falsy：当成「没有时间」
  assert.equal(decayOf({ mtimeMs: NaN }), 1);
  assert.equal(decayOf({ mtimeMs: NOW + 10 * DAY }), 1); // 未来时间不会被算成「更新 ⇒ 加分」
  // 负数半衰期会让指数为正、乘子 >1，clamp 保证它不会变成「越旧分越高」
  const negative = buildIndex([doc('a.md', '量子纠缠', { mtimeMs: NOW - 30 * DAY })], { halfLifeDays: -30, now: NOW });
  assert.equal(negative.docs[0].decay, 1);
});

test('衰减：几何口径 —— 用导出的 SUGGESTED_HALF_LIFE_DAYS 驱动，30 天正好减半', () => {
  const decayAt = (ageDays) =>
    buildIndex([doc('a.md', '量子纠缠', { mtimeMs: NOW - ageDays * DAY })], {
      halfLifeDays: SUGGESTED_HALF_LIFE_DAYS,
      now: NOW,
    }).docs[0].decay;
  // 把导出的常量与行为绑在一起：这个值不是纯文档，它就是默认建议的半衰期。
  assert.equal(SUGGESTED_HALF_LIFE_DAYS, 30);
  assert.equal(decayAt(0), 1);
  assert.ok(Math.abs(decayAt(SUGGESTED_HALF_LIFE_DAYS) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayAt(2 * SUGGESTED_HALF_LIFE_DAYS) - 0.25) < 1e-12);
});

test('衰减：越旧乘子越小且单调不增，撞到地板 0.001 后不再下降', () => {
  const ages = [0, 1, 7, 30, 60, 90, 180, 300, 1000, 100000];
  const values = ages.map(
    (age) =>
      buildIndex([doc('a.md', '量子纠缠', { mtimeMs: NOW - age * DAY })], { halfLifeDays: 30, now: NOW }).docs[0].decay,
  );
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] <= values[i - 1], `${ages[i]} 天的乘子不该比 ${ages[i - 1]} 天大`);
  }
  assert.ok(values[0] > values[1] && values[1] > values[2], '头几天必须是严格下降的');
  assert.equal(values[ages.indexOf(300)], 0.001); // 2^-10 < 0.001 ⇒ 落到 SCORE_FLOOR
  assert.equal(values[values.length - 1], 0.001); // 再老也不会到 0（乘子永远为正）
});

test('衰减：乘性作用在最终分上 —— 同内容两篇的分差正好等于乘子之比', () => {
  const index = buildIndex(
    [doc('new.md', '缓存穿透排查', { mtimeMs: NOW }), doc('old.md', '缓存穿透排查', { mtimeMs: NOW - 30 * DAY })],
    { halfLifeDays: 30, now: NOW },
  );
  const [newer, older] = search(index, '缓存穿透', 5);
  assert.equal(newer.id, 'new.md');
  // 两篇正文/标题完全相同 ⇒ BM25 部分逐位相同，比值只能是 decay 之比 1 : 0.5。
  assert.ok(Math.abs(newer.score / older.score - 2) < 1e-9, `比值 ${newer.score / older.score} 不等于 2`);
});

// ── 七、时间加权（boost）与片段裁剪 ─────────────────────────────────────

test('时间加权：缺省关闭；有库内跨度时按相对新旧线性起伏，且恒被 ±w 夹住', () => {
  const mk = (id, age) => doc(id, `量子纠缠 ${id}`, { mtimeMs: NOW - age * DAY });
  const off = buildIndex([mk('old.md', 10), mk('mid.md', 5), mk('new.md', 0)], { now: NOW });
  assert.deepEqual(off.docs.map((d) => d.boost), [1, 1, 1]); // recencyWeight 缺省 0

  const on = buildIndex([mk('old.md', 10), mk('mid.md', 5), mk('new.md', 0)], { recencyWeight: 0.1, now: NOW });
  assert.deepEqual(on.docs.map((d) => [d.id, d.boost]), [['old.md', 0.9], ['mid.md', 1], ['new.md', 1.1]]);

  // 没有跨度（只有一篇 / mtime 全相同 / 根本没有 mtime）时恒为 1 ——
  // 否则「库里只有一篇」会白拿 +w 的加分。
  assert.equal(buildIndex([mk('only.md', 0)], { recencyWeight: 0.1, now: NOW }).docs[0].boost, 1);
  assert.deepEqual(
    buildIndex([mk('a.md', 1), mk('b.md', 1)], { recencyWeight: 0.1, now: NOW }).docs.map((d) => d.boost),
    [1, 1],
  );
  assert.equal(buildIndex([doc('x.md', '量子纠缠')], { recencyWeight: 0.1, now: NOW }).docs[0].boost, 1);
});

test('片段裁剪：短文本原样、空白折叠、超长按上限截断并留省略号', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('  a   b  ', 10), 'a b'); // 连续空白（含换行）折成一个空格
  assert.equal(clip('a'.repeat(100), 72), `${'a'.repeat(71)}…`);
  assert.equal(clip('a'.repeat(100), 72).length, 72); // 结果长度恰好是上限
  assert.equal(clip('中文'.repeat(50), 72).length, 72);
  assert.equal(clip('abc', 1), '…');
  assert.equal(clip(null, 5), '');
});

// ── clip：按码元截断时不能切出半个代理对 ──────────────────────────────
// 症状：snippet 里第 70 个码元是孤立高代理，面板/JSON/终端会渲染成乱码。

const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

test('clip：短文本原样返回，长文本以省略号收尾且不超长', () => {
  assert.equal(clip('短', 10), '短');
  assert.equal(clip('恰好十个字啊啊啊啊啊', 10).length, 10, '正好等于上限时不动刀');
  const long = clip('字'.repeat(50), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('clip：emoji 在切点上也不会被切成半个（孤立代理对是要修的病）', () => {
  for (const max of [3, 4, 5, 72, 73, 100]) {
    const out = clip('👍'.repeat(100), max);
    assert.ok(out.length <= max, `max=${max} 不能超长`);
    assert.equal(LONE_SURROGATE.test(out), false, `max=${max} 切出了孤立代理对：${JSON.stringify(out.slice(-4))}`);
  }
  // 反向对照：老写法确实会切坏，证明这条断言不是白写的
  const bad = `${'👍'.repeat(50).slice(0, 71)}…`;
  assert.equal(LONE_SURROGATE.test(bad), true, '老写法（直接 slice）会切出孤立高代理');
});

test('clip：内部空白折叠成单空格，首尾不留白', () => {
  assert.equal(clip('  a\n\nb\tc  ', 40), 'a b c');
});
