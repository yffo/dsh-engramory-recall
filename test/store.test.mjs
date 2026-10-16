/**
 * store.js —— 记忆库「读取 + 切片」层的专属测试。
 *
 * 为什么值得单测这一层：它是整条召回链路的入口，而且是个**静默**层 —— 读漏一篇、frontmatter
 * 解析错位、长笔记少切一桶，都不会抛错、不会有日志，只会让召回命中率悄悄变差。所以下面除了
 * 常规行为，还专门钉了一批「反直觉但当前确实是这么跑」的用例，它们是**现状记录**（疑似 bug，
 * 已写进注释）：如果哪天有人修了源码，这几条断言会红 —— 那不是回归，是提醒你连断言一起改。
 *
 * 所有临时文件都在 mkdtempSync 出来的目录里，测试结束就地删除；**不读也不写真实记忆库**。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkBody, corpusFingerprint, readDocs, splitNote } from '../store.js';

// store.js 里这两个常量没有导出（SECTION_BYTES / MAX_BYTES），只能在测试里抄一份。
// 它们一旦被改动，下面的边界断言会失败 —— 这正是我们想要的提醒。
const SECTION_BYTES = 6 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;

/** 本文件建出来的临时库目录，跑完统一删。 */
const tempDirs = [];

/** 建一个临时记忆库目录，files 是 { 文件名: 内容 }。 */
function mkStore(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-store-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 造一篇正文超长的笔记：sections 个 `## 段 i`，每段约 620 字节。 */
function longNote(sections = 12, heading = true, padding = 300) {
  const lines = [];
  if (heading) lines.push('# 长笔记', '');
  for (let i = 0; i < sections; i += 1) lines.push(`## 段 ${i}`, '', `第 ${i} 段内容 ${'x'.repeat(padding)}`, '');
  return lines.join('\n');
}

// ── splitNote：frontmatter 解析 ───────────────────────────────────────

test('splitNote：无 frontmatter 的笔记，正文原样保留、标题取一级标题', () => {
  // 这条守的是「最朴素的笔记也不能被解析器吃掉」：没有 --- 时整篇都是正文。
  const note = splitNote('# 我的笔记\n\n正文第一行\n\n---\n\n分隔线之后');
  assert.equal(note.title, '我的笔记');
  assert.equal(note.description, '');
  assert.deepEqual(note.aliases, []);
  assert.equal(note.body, '# 我的笔记\n\n正文第一行\n\n---\n\n分隔线之后');
});

test('splitNote：标题回退顺序是 h1 → name → description', () => {
  // h1 优先那条已由 recall.test.mjs 覆盖，这里补的是后两级回退：没有 h1 时用 name，
  // 连 name 都没有时用 description 兜底 —— 否则一篇没写 h1 的笔记在召回里就是「无名氏」。
  const withName = splitNote('---\nname: 名字标题\ndescription: 描述\n---\n\n正文');
  assert.equal(withName.title, '名字标题');

  const onlyDesc = splitNote('---\ndescription: 只有描述\n---\n\n正文');
  assert.equal(onlyDesc.title, '只有描述');
  assert.equal(onlyDesc.description, '只有描述');
});

test('splitNote：缺 name / 缺 description 是空串，不是 undefined', () => {
  // 调用方（bm25/index.js）会直接把这些字段喂进索引，undefined 会让 String() 落成 "undefined"。
  const note = splitNote('---\nname: 只有名字\n---\n\n正文');
  assert.equal(note.description, '');
  assert.deepEqual(note.aliases, []);

  const bare = splitNote('---\ntype: reference\n---\n\n正文');
  assert.equal(bare.title, '');
  assert.equal(bare.description, '');
  assert.equal(bare.body, '正文');
});

test('splitNote：frontmatter 的值会剥掉一层引号，值里的冒号不受影响', () => {
  const note = splitNote('---\nname: "飞书: 桥接"\ndescription: \'单引描述\'\n---\n\n正文');
  assert.equal(note.title, '飞书: 桥接', '引号要剥掉，但值内的冒号是内容的一部分');
  assert.equal(note.description, '单引描述');
});

test('splitNote：不以前缀开头时，正文里的 --- 分隔线不是 frontmatter', () => {
  // 关键前提：只有当文件**第一行**就是 --- 时才会进入 frontmatter 分支。
  const note = splitNote('# T\n\n甲\n\n---\n\n乙');
  assert.equal(note.title, 'T');
  assert.ok(note.body.includes('乙'), '分隔线之后的正文必须留在 body 里');
});

test('splitNote：文件以 --- 分隔线开头时会被误判成 frontmatter（现状钉住 / 疑似 bug）', () => {
  // ⚠️ 现状记录：`raw.startsWith('---')` 只看前三字符，分不清 frontmatter 与一条水平分隔线。
  // 一篇以 `---` 开头的普通笔记，会被当成 frontmatter，标题丢光、前面的正文被吃掉，
  // 只剩最后一段正文。这属于解析歧义（真实库里以 --- 开头的笔记确实存在）。
  const note = splitNote('---\n\n# T\n\n正文\n\n---\n\n更多');
  assert.equal(note.title, '', '现状：h1 被当成 frontmatter 吃掉');
  assert.equal(note.body, '更多', '现状：只剩最后一段');
});

test('splitNote：CRLF / 孤立 CR 都在解析入口归一（字段与正文都不带 \r）', () => {
  // Windows / 手工编辑器写出来的 .md 到处都是 CRLF（老 Mac 还可能留下孤立 CR）。
  // 曾经的坑：\r 会跟着标题、词项与 snippet 一路进索引；现在解析入口统一
  // replace(/\r\n?/g, '\n')，所以 frontmatter 字段与正文都只见 LF —— 这条钉住这个归一化。
  const note = splitNote('---\r\nname: 名字\r\ndescription: 描述\r\n---\r\n\r\n# T\r\n\r\n正文');
  assert.equal(note.title, 'T');
  assert.equal(note.description, '描述');
  assert.equal(note.description.includes('\r'), false, '字段值经过 trim，不该带 \r');
  assert.equal(note.body, '# T\n\n正文', '正文也归一成 LF');
  assert.equal(splitNote('老式\r回车').body, '老式\n回车', '孤立 CR 同样认');
});

test('splitNote：BOM 开头的笔记照样解析 frontmatter（记事本另存为 UTF-8 会带 BOM）', () => {
  // 曾经的坑：\uFEFF 让 startsWith('---') 为假 → frontmatter 被当成正文喂进索引，
  // description/aliases 全丢。现在在解析入口就把 BOM 抹掉。
  const note = splitNote('\uFEFF---\nname: 名字\ndescription: 描述\n---\n\n# 标题\n\n正文');
  assert.equal(note.description, '描述');
  assert.equal(note.title, '标题');
  assert.equal(note.body.startsWith('---'), false, 'frontmatter 不该留在 body 里');
  assert.match(note.body, /正文/);
});

test('splitNote：空文件 / null / 非字符串都不抛，字段全为空', () => {
  // readDocs 会对库里的空 .md 直接调用它，这里不能抛。
  for (const input of ['', '   \n\n  ', null, undefined]) {
    const note = splitNote(input);
    assert.deepEqual(note, { title: '', description: '', body: '', aliases: [] }, `输入 ${JSON.stringify(input)}`);
  }
  assert.equal(splitNote(12345).body, '12345', '非字符串按 String() 处理');
});

test('splitNote：只有 frontmatter 没有正文 → body 为空', () => {
  const note = splitNote('---\nname: 只有骨头\n---\n');
  assert.equal(note.title, '只有骨头');
  assert.equal(note.body, '');
});

test('splitNote：只有 frontmatter 且末尾没有换行 → body 泄漏成整篇原文（现状钉住 / 疑似 bug）', () => {
  // ⚠️ 现状记录：`raw.indexOf('\n', end + 1)` 找不到换行时返回 -1，slice(0) 于是把整篇
  // （含 frontmatter）当成正文。同一个文件只差一个结尾换行，body 却有天壤之别。
  const note = splitNote('---\nname: x\n---');
  assert.equal(note.title, 'x');
  assert.equal(note.body, '---\nname: x\n---', '现状：frontmatter 自己变成了正文');
});

test('splitNote：aliases 支持中英文逗号、顿号、空白分隔；不写就是空数组', () => {
  // aliases 会被 bm25 计两遍，是实打实影响排序的字段，分隔符认不全就会变成一堆死词项。
  const note = splitNote('---\nname: x\naliases: 飞书, lark，钉钉、slack 微信\n---\n\n正文');
  assert.deepEqual(note.aliases, ['飞书', 'lark', '钉钉', 'slack', '微信']);

  const quoted = splitNote('---\nname: x\naliases: "飞书, lark"\n---\n\n正文');
  assert.deepEqual(quoted.aliases, ['飞书', 'lark'], '整体加引号也要能剥');

  assert.deepEqual(splitNote('---\nname: x\n---\n\n正文').aliases, [], '不写就是空数组，不是 [""]');
});

test('splitNote：字段值为空时会吃掉下一行（现状钉住 / 疑似 bug）', () => {
  // ⚠️ 现状记录：pick() 的正则是 `^field:\s*(.+)$`，`\s*` 会跨过换行，于是空值字段把
  // **下一行整行**当成自己的值。后果分两种：标题莫名其妙变成 "description: 描述"，
  // 或者 aliases 里混进 "name:" 这种假词项（直接进索引、影响打分）。
  const bleedTitle = splitNote('---\nname:\ndescription: 描述\n---\n\n正文');
  assert.equal(bleedTitle.title, 'description: 描述', '现状：name 空值吃掉了下一行');
  assert.equal(bleedTitle.description, '描述');

  const bleedAlias = splitNote('---\naliases:\nname: x\n---\n\n正文');
  assert.deepEqual(bleedAlias.aliases, ['name:', 'x'], '现状：空的 aliases 把下一行当成了同义词');

  // 正常情况（同一行写值）不受影响，别把 bug 当成普遍行为。
  assert.equal(splitNote('---\nname: x\ndescription:\n---\n\n正文').description, '');
});

test('splitNote：全角冒号不认（现状钉住）', () => {
  // 现状记录：正则只认 ASCII `:`，中文输入法下写成 `name：` 的字段会被整个忽略。
  const note = splitNote('---\nname： 中文冒号\n---\n\n正文');
  assert.equal(note.title, '', '现状：全角冒号字段不生效（会退化成空标题）');
  assert.equal(note.body, '正文');
});

test('splitNote：正文首尾空白被 trim 掉', () => {
  const note = splitNote('---\nname: x\n---\n\n\n\n正文\n\n\n');
  assert.equal(note.body, '正文');
});

// ── chunkBody：长正文切片 ────────────────────────────────────────────

test('chunkBody：空正文与纯空白都返回空数组', () => {
  // readDocs 会对每篇判断是否切桶；返回 [""] 这种空桶会往索引里塞空文档。
  assert.deepEqual(chunkBody(''), []);
  assert.deepEqual(chunkBody('   \n\n  '), []);
  assert.deepEqual(chunkBody(null), []);
});

test('chunkBody：按 ## 分节，标题行归它后面那一块', () => {
  // 「标题归后面那块」是刻意的：检索命中的是标题 + 它管辖的正文，标题不该跑到上一节去。
  const chunks = chunkBody('## A\n\n内容A\n\n## B\n\n内容B', 200);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].title, 'A');
  assert.ok(chunks[0].body.startsWith('## A'), '标题行必须在这一块的开头');
  assert.equal(chunks[1].title, 'B');
  assert.equal(chunks[1].body, '## B\n\n内容B');
});

test('chunkBody：一节超过上限时再按 ### 降级切', () => {
  const chunks = chunkBody('## A\n\n内容\n\n### A1\n\n内容1', 200);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].title, 'A');
  assert.equal(chunks[0].body, '## A\n\n内容');
  assert.equal(chunks[1].title, 'A1');
  assert.ok(chunks[1].body.startsWith('### A1'));
});

test('chunkBody：第一个 ## 之前的前言自成一桶，桶标题为空', () => {
  // 前言（含 h1）不属于任何 ## 节；它的标题只能是空 —— 别把整篇的 h1 当成桶标题。
  const chunks = chunkBody('前言\n\n## A\n\n内容', 200);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { title: '', body: '前言' });
  assert.equal(chunks[1].title, 'A');
});

test('chunkBody：正文正好等于上限时不切碎', () => {
  // 边界必须精确到字节：`<=` 与 `<` 差一个字节，就会让所有刚好 6KB 的笔记被切出一个空标题桶。
  const chunks = chunkBody('a'.repeat(10), 10);
  assert.equal(chunks.length, 1);
  assert.equal(Buffer.byteLength(chunks[0].body), 10);
});

test('chunkBody：单行本身超过上限时自成一桶（不会在字符中间切开）', () => {
  // 一行超限是无解的（不能把一行劈两半喂给同一个桶），只能让它自成一块 —— 但不能死循环或丢内容。
  const line = 'x'.repeat(7000);
  const chunks = chunkBody(line, 100);
  assert.equal(chunks.length, 1, '超长单行必须原样保留，不能被吞掉');
  assert.equal(chunks[0].body, line);
});

test('chunkBody：一节超过上限时，标题行会先自成一个空壳桶（现状钉住）', () => {
  // 硬切是逐行的：标题行 + 紧跟的空行先凑满一次 flush，超长正文行再自成一块。
  // 于是**每一个大于 6KB 的 ## 节都会多出一条 body 只有标题、正文一字不带的桶**。
  // 影响：桶数近乎翻倍（大日志尤其明显），标题词被多计一次 df；命中空壳桶时片段里没有内容。
  const chunks = chunkBody(`## 大节\n\n${'填'.repeat(3000)}`, SECTION_BYTES);

  assert.deepEqual(chunks.map((c) => c.title), ['大节', '']);
  assert.equal(chunks[0].body, '## 大节', '现状：空壳桶只装着标题行');
  assert.equal(Buffer.byteLength(chunks[1].body), 9000, '超长正文行自成一桶');
});

test('chunkBody：按行边界硬切，且每行多算 1 字节换行（4 字节行 + 上限 10 → 每桶两行）', () => {
  // 这条钉的是硬切算法本体：size = 行长 + 1（换行符）。算错会让每桶实际字节数超过上限，
  // 而 readDocs 是把 limit 当硬上限用的。
  const chunks = chunkBody(['abcd', 'abcd', 'abcd', 'abcd'].join('\n'), 10);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.body), ['abcd\nabcd', 'abcd\nabcd']);
});

test('chunkBody：多字节字符不被切坏，拼回来与原文一字不差', () => {
  // 中文/emoji/ZWJ 序列一旦被按字节劈开，就会变成 U+FFFD 墓碑字符：既污染索引词项，
  // 又让片段在面板里显示成乱码。这里要求「桶接起来 == 原文」且没有半个字符。
  const body = Array.from({ length: 8 }, (_, i) => `第${i}行 🎈👨‍👩‍👧🇨🇳 中文内容`).join('\n');
  const chunks = chunkBody(body, 100);

  assert.ok(chunks.length > 1, '这份正文应当被切成多桶');
  assert.equal(chunks.map((c) => c.body).join('\n'), body, '拼回来必须与原文等价');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk.body) <= 100, `桶超限: ${Buffer.byteLength(chunk.body)}`);
    assert.equal(chunk.body.includes('\uFFFD'), false, '不能出现替换字符（说明切在了字符中间）');
    assert.equal(Buffer.from(chunk.body, 'utf8').toString('utf8'), chunk.body, '每桶都必须是合法 UTF-8');
  }
  assert.ok(chunks.some((c) => c.body.includes('👨‍👩‍👧')), 'ZWJ 家庭 emoji 必须完整存活');
});

test('chunkBody：上限按字节算，不是按字符算', () => {
  // 中文一个字 3 字节。按字符算会在真实库里把 6KB 的桶撑成 18KB。
  const line = '中文'.repeat(5); // 10 字符 / 30 字节
  const chunks = chunkBody([line, line, line, line].join('\n'), 65);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.equal(chunk.body.split('\n').length, 2, '每桶两行');
    assert.equal(Buffer.byteLength(chunk.body), 61, '两行 30+30 字节 + 1 个换行');
  }
});

test('chunkBody：不传上限时用默认的 6KB（SECTION_BYTES）', () => {
  // 默认值写死在 store.js 里；这里用「60 行 × 100 字节 + 每行 1 字节换行 = 6059」反推它。
  const chunks = chunkBody(Array.from({ length: 62 }, () => 'a'.repeat(100)).join('\n'));
  assert.equal(chunks.length, 2, '62 行装不进一个 6KB 桶');
  assert.equal(Buffer.byteLength(chunks[0].body), 6059, '60 行（60×100 + 59 个换行）');
  assert.ok(chunks.every((c) => Buffer.byteLength(c.body) <= SECTION_BYTES));
});

test('chunkBody：一级标题不参与桶标题', () => {
  // h1 是整篇的标题（readDocs 已经把它算进 title 了），再当桶标题会让同一个标题被计两次。
  const chunks = chunkBody('# T\n\n正文', 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].title, '');
});

// ── readDocs：目录遍历与文档形状 ─────────────────────────────────────

test('readDocs：目录不存在 / 路径是文件 → 空数组而不是抛错', () => {
  // 这是插件最容易踩的配置错（storePath 写错/库被删）。契约是静默返回空，
  // 但**不能抛** —— 抛了会把宿主的整个回合带崩。
  const dir = mkStore({ 'a.md': '# 甲\n\n正文\n' });
  assert.deepEqual(readDocs(join(dir, '不存在的子目录')), []);
  assert.deepEqual(readDocs(join(dir, 'a.md')), [], '传进来一个文件路径应当被 ENOTDIR 兜住');
});

test('readDocs：空目录与只有索引的目录 → 空数组', () => {
  assert.deepEqual(readDocs(mkStore()), []);
  assert.deepEqual(readDocs(mkStore({ 'MEMORY.md': '# 索引\n\n- [甲](a.md)\n' })), []);
});

test('readDocs：只收 .md，排除 MEMORY.md 与非 markdown，且不递归子目录', () => {
  const dir = mkStore({
    'MEMORY.md': '# 索引\n\n不该被当成笔记\n',
    '.engramory-recall.jsonl': '{"不该被读":true}\n',
    'notes.txt': '不是 markdown\n',
    'a-note.md': '# 甲\n\n甲正文\n',
    'b-note.md': '# 乙\n\n乙正文\n',
  });
  mkdirSync(join(dir, 'subdir'));
  writeFileSync(join(dir, 'subdir', 'deep.md'), '# 深层\n\n不该被读到\n');
  mkdirSync(join(dir, 'trap.md')); // 目录名刚好以 .md 结尾：读它会 EISDIR

  const docs = readDocs(dir);
  assert.deepEqual(docs.map((d) => d.id), ['a-note.md', 'b-note.md'], '目录名像 .md 的那条要被静默跳过，不能抛');
  assert.equal(docs.some((d) => d.body.includes('不该被')), false);
});

test('readDocs：隐藏的 .md 会被读进来（现状钉住）', () => {
  // 现状记录：过滤条件只有 `endsWith('.md') && !== 'MEMORY.md'`，没有排除点开头的文件。
  // 非 .md 的隐藏文件（如 .engramory-recall.jsonl）靠扩展名天然挡住了，但 .hidden.md 会进索引。
  const dir = mkStore({
    '.hidden.md': '# 隐藏\n\n隐藏正文\n',
    'normal.md': '# 普通\n\n普通正文\n',
  });
  assert.deepEqual(readDocs(dir).map((d) => d.id), ['.hidden.md', 'normal.md']);
});

test('readDocs：返回顺序按文件名排序，稳定可复现', () => {
  // 顺序不稳 → 词项 df 一样但文档编号漂移 → 分数看起来随机。默认 sort() 是字典序。
  const dir = mkStore({
    'zz.md': '# Z\n\nz\n',
    'MM.md': '# M\n\nm\n',
    'aa.md': '# A\n\na\n',
  });
  const first = readDocs(dir).map((d) => d.id);
  assert.deepEqual(first, ['MM.md', 'aa.md', 'zz.md'], '大写字母排在小写之前（UTF-16 码点序）');
  assert.deepEqual(readDocs(dir).map((d) => d.id), first, '重复读必须同序');
});

test('readDocs：短笔记的字段形状（八个字段，没有 section/seq）', () => {
  // 形状是下游契约：bm25 用 id/body，注入用 title/description，衰减用 mtimeMs，
  // 账本用 chars（整篇字数，算「省下多少上下文」）。
  // 注意没有 `bytes` 字段 —— 字节数由 body 现算（Buffer.byteLength）。
  const dir = mkStore({ 'a.md': '---\nname: 甲\ndescription: 描述\n---\n\n# 甲\n\n正文\n' });
  const [doc] = readDocs(dir);

  assert.deepEqual(Object.keys(doc), ['id', 'title', 'description', 'body', 'aliases', 'path', 'mtimeMs', 'chars']);
  assert.equal(doc.chars, '---\nname: 甲\ndescription: 描述\n---\n\n# 甲\n\n正文\n'.length, 'chars = 整个文件的字符数');
  assert.equal(doc.id, 'a.md', 'id 就是文件名，召回注入靠它定位');
  assert.equal(doc.title, '甲');
  assert.equal(doc.description, '描述');
  assert.equal(doc.body, '# 甲\n\n正文');
  assert.equal(doc.path, join(dir, 'a.md'));
  assert.equal('section' in doc, false, '短笔记不进切片路径');
  assert.equal('bytes' in doc, false, '没有 bytes 字段，字节数由 body 现算');
});

test('readDocs：正文正好 6KB 不切桶，多 1 字节才切', () => {
  // 这条钉的是 readDocs 里的 `Buffer.byteLength(body) <= SECTION_BYTES` 分支边界：
  // 差一个字节就会多出一批只有首桶的「切片」，而首桶还要被拼上 `标题 § 节标题`。
  const dir = mkStore({
    'exact.md': `---\nname: 边界\n---\n\n${'a'.repeat(SECTION_BYTES)}\n`,
    'over.md': `---\nname: 超一字节\n---\n\n${'a'.repeat(SECTION_BYTES + 1)}\n`,
  });
  const docs = readDocs(dir);

  const exact = docs.find((d) => d.id === 'exact.md');
  assert.equal('seq' in exact, false, '正好等于上限 → 走短笔记路径');
  assert.equal(Buffer.byteLength(exact.body), SECTION_BYTES);

  const over = docs.find((d) => d.id === 'over.md');
  assert.equal(over.seq, 0, '超一个字节 → 走切片路径');
  assert.equal(over.section, '', '单行超限时没有 ## 标题可用');
  assert.equal(over.title, '超一字节', '首桶且无节标题 → 保留整篇标题，不拼 §');
  assert.equal(Buffer.byteLength(over.body), SECTION_BYTES + 1);
});

test('readDocs：长笔记按 ## 切桶，seq 连续、只有首桶带描述', () => {
  // 「一篇笔记 = 多个 chunk」是长笔记霸榜的解法（见 store.js 顶部注释），
  // 但描述只在首桶带，否则同一段描述会被计入十几次。
  // fixture 必须同时满足两个条件：整篇 > SECTION_BYTES（才会走切桶），
  // 且**每一节 < SECTION_BYTES**（否则一节自己就被行硬切，标题行会另立一个空壳桶，
  // 桶数就不再是「1 + 节数」）。padding=800 → 整篇约 9.9KB，每节约 0.8KB。
  const dir = mkStore({
    'long.md': `---\nname: 长笔记\ndescription: 描述\n---\n\n${longNote(12, true, 800)}\n`,
  });
  const docs = readDocs(dir);
  const mine = docs.filter((d) => d.id === 'long.md');

  assert.equal(mine.length, 13, '前言 1 桶 + 12 个 ## 节');
  assert.deepEqual(mine.map((d) => d.seq), Array.from({ length: 13 }, (_, i) => i), 'seq 必须连续');
  assert.deepEqual(Object.keys(mine[0]), ['id', 'section', 'seq', 'title', 'description', 'body', 'aliases', 'path', 'mtimeMs', 'chars']);
  assert.equal(new Set(mine.map((d) => d.chars)).size, 1, '同一篇的所有桶共享整篇字数');
  assert.equal(mine[0].section, '', '首桶装的是 h1 前言，没有 ## 标题');
  assert.equal(mine[0].description, '描述', '首桶带描述');
  assert.equal(mine.slice(1).every((d) => d.description === ''), true, '非首桶不带描述');
  assert.deepEqual(mine.slice(1).map((d) => d.section), Array.from({ length: 12 }, (_, i) => `段 ${i}`));
  assert.deepEqual(mine.slice(1).map((d) => d.title), Array.from({ length: 12 }, (_, i) => `段 ${i}`));
  assert.ok(mine.every((d) => Buffer.byteLength(d.body) <= SECTION_BYTES));
});

test('readDocs：没有标题的长笔记，首桶标题会多出一个孤立的 §（现状钉住 / 疑似 bug）', () => {
  // ⚠️ 现状记录：首桶标题是 `${title} § ${chunk.title}`，title 为空时不做判断，
  // 于是得到 " § 段 0"。这种笔记在注入的指针里会显示成「§ 段 0」，看着莫名其妙。
  // 每节 7KB：既超过 6KB 桶上限（保证会被切成多桶），又让整篇走长笔记路径。
  const dir = mkStore({ 'anon.md': longNote(3, false, 7000) });
  const docs = readDocs(dir).filter((d) => d.id === 'anon.md');

  assert.ok(docs.length > 1, '三节 21KB 的正文必须被切开');
  assert.equal(docs[0].title, ' § 段 0', '现状：空标题也照样拼分隔符');
  assert.equal(docs[0].section, '段 0');
  assert.equal(docs[1].section, '', '一节被硬切成两桶时，第二桶没有标题可用');
  assert.equal(docs[1].title, '');
});

test('readDocs：空 .md 文件也会产出一条空文档', () => {
  // 现状：没有「正文为空就跳过」的判断。空文档会白占一个索引位并参与 df 统计。
  const dir = mkStore({ 'empty.md': '', 'blank.md': '   \n\n', 'real.md': '# 真\n\n正文\n' });
  const docs = readDocs(dir);
  assert.deepEqual(docs.map((d) => d.id), ['blank.md', 'empty.md', 'real.md']);
  assert.equal(docs.find((d) => d.id === 'empty.md').body, '');
  assert.equal(docs.find((d) => d.id === 'empty.md').title, '');
});

test('readDocs：path 与 mtimeMs 来自真实文件', () => {
  // mtimeMs 一路喂到 bm25 的 freshness 衰减，取错值会让新笔记不占优、旧笔记不衰减。
  const dir = mkStore({ 'a.md': '# 甲\n\n正文\n' });
  const [doc] = readDocs(dir);
  assert.equal(doc.path, join(dir, 'a.md'));
  assert.equal(doc.mtimeMs, statSync(join(dir, 'a.md')).mtimeMs);
  assert.ok(doc.mtimeMs > 0);
});

test('readDocs：同一目录两次读命中缓存并返回同一个数组（index.js 依赖这个引用相等）', () => {
  // index.js 的 indexOf() 就是靠 `indexCache.docs === docs` 判断要不要重建索引的，
  // 所以「同一份内容返回同一个数组引用」不是巧合，是契约。
  const dir = mkStore({ 'a.md': '# 甲\n\n正文\n' });
  const first = readDocs(dir);
  const again = readDocs(dir);
  assert.equal(again, first, '没改动时必须复用缓存（引用相等）');
  assert.deepEqual(again, first);
});

test('readDocs：笔记被改动之后缓存失效', () => {
  // 反向契约：改了库必须重读。mtime 要显式推后 —— 同一毫秒内改写会让缓存键看起来没变，
  // 测试会假绿（recall.test.mjs 里踩过同一个坑）。
  const dir = mkStore({ 'a.md': '# 甲\n\n旧正文\n' });
  const before = readDocs(dir);
  assert.ok(before[0].body.includes('旧正文'));

  writeFileSync(join(dir, 'a.md'), '# 甲\n\n新正文\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(join(dir, 'a.md'), future, future);

  const after = readDocs(dir);
  assert.notEqual(after, before, '内容变了就不能再返回同一个数组');
  assert.ok(after[0].body.includes('新正文'), '必须读到新正文');
});

test('readDocs：单篇超过 4MB 会被跳过，同一目录里排在它后面的正常笔记照常读出', () => {
  // 字节预算的语义是「单篇超限 → 跳过这一篇；累计超限 → 才停」：超限的那篇不再让整库归零。
  // 真实风险（曾经踩到）：一篇几 MB 的追加式日志排在最前，它后面所有笔记从召回里静默消失。
  const dir = mkStore({ 'aaa-huge.md': 'a'.repeat(MAX_BYTES + 10), 'zzz-normal.md': '# 正常\n\n正文\n' });
  assert.deepEqual(readDocs(dir).map((d) => d.id), ['zzz-normal.md'], '超大那篇被跳过，它后面的正常笔记必须照读');
});

test('readDocs：超过 4MB 的那篇被丢掉，排在它前面的笔记仍然保留', () => {
  // 与上一条配对：预算语义是「装不下就停，已装的留着」，不是「整库作废」。
  const dir = mkStore({ 'aaa-normal.md': '# 正常\n\n正文\n', 'zzz-huge.md': 'a'.repeat(MAX_BYTES + 10) });
  assert.deepEqual(readDocs(dir).map((d) => d.id), ['aaa-normal.md']);
});

test('readDocs：超过 2000 篇时只取排序靠前的 2000 篇', () => {
  // MAX_NOTES 是防病态目录把索引撑爆的上限。注意是**静默截断**（排序靠后的笔记消失），
  // 所以这条钉的是「截断方向」：保留前 2000，丢弃排最后的那些。
  const dir = mkStore();
  for (let i = 0; i < 2001; i += 1) writeFileSync(join(dir, `n${String(i).padStart(4, '0')}.md`), `# n${i}\n\n正文\n`);

  const docs = readDocs(dir);
  assert.equal(docs.length, 2000);
  assert.equal(docs[0].id, 'n0000.md');
  assert.equal(docs[docs.length - 1].id, 'n1999.md');
  assert.equal(docs.some((d) => d.id === 'n2000.md'), false, '排序最后的那篇被丢掉');
});

// ── corpusFingerprint：语料指纹 ──────────────────────────────────────

test('corpusFingerprint：同一语料指纹相同，且是 12 位十六进制', () => {
  // 指纹是「分数可不可比」的唯一凭据：同一份语料必须永远给同一个值，且不泄露正文。
  const docs = [
    { id: 'a.md', title: '甲', description: '', aliases: '', body: '甲的正文' },
    { id: 'b.md', title: '乙', description: '', aliases: '', body: '乙的正文' },
  ];
  const fp = corpusFingerprint(docs);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(corpusFingerprint(docs), fp);
  assert.equal(corpusFingerprint(docs.map((d) => ({ ...d }))), fp, '同内容的另一个对象必须同指纹');
  assert.equal(fp.includes('正文'), false, '指纹里不能出现正文');
});

test('corpusFingerprint：空语料也给得出指纹（不抛）', () => {
  // 空库要走同一条代码路径（面板/探针都会调它），不能因为没文档就抛。
  assert.match(corpusFingerprint([]), /^[0-9a-f]{12}$/);
  assert.equal(corpusFingerprint([]), corpusFingerprint([]));
});

test('corpusFingerprint：id 不同时与顺序无关', () => {
  // 探针会比较两次运行的指纹；语料顺序变了（例如重新读盘）不该被误报成「卷子换了」。
  const docs = [{ id: 'a.md', body: '甲' }, { id: 'b.md', body: '乙' }, { id: 'c.md', body: '丙' }];
  const fp = corpusFingerprint(docs);
  assert.equal(corpusFingerprint([...docs].reverse()), fp);
  assert.equal(corpusFingerprint([docs[1], docs[2], docs[0]]), fp);
});

test('corpusFingerprint：path / mtimeMs 这类没喂进索引的字段不进指纹', () => {
  // 指纹描述的是「语料内容」，不是「文件放在哪、什么时候改的」。
  // 反过来也说明：同内容换个目录，指纹不变是**设计如此**。
  const base = { id: 'a.md', title: '甲', description: '', aliases: '', body: '正文' };
  const fp = corpusFingerprint([base]);
  assert.equal(corpusFingerprint([{ ...base, path: '/tmp/别处/a.md' }]), fp);
  assert.equal(corpusFingerprint([{ ...base, mtimeMs: 1234567890 }]), fp);
});

test('corpusFingerprint：字段之间有分隔符，id 与 body 拼接不产生歧义', () => {
  // 如果只是把字段直接 update 进去，{id:'ab', body:'c'} 与 {id:'a', body:'bc'} 会撞成同一个
  // 指纹 —— 两份不同语料报「没变」，比没有指纹更坏。
  assert.notEqual(corpusFingerprint([{ id: 'ab', body: 'c' }]), corpusFingerprint([{ id: 'a', body: 'bc' }]));
});

test('corpusFingerprint：缺字段按空串算，不抛', () => {
  // 真实调用方会传 readDocs() 的产物（字段齐全），也会传手工造的探针语料（字段残缺）。
  const full = { id: 'a.md', title: '', description: '', aliases: '', body: '' };
  assert.equal(corpusFingerprint([{ id: 'a.md' }]), corpusFingerprint([full]));
  assert.equal(corpusFingerprint([{ id: 'a.md', body: null }]), corpusFingerprint([{ id: 'a.md' }]));
  assert.equal(corpusFingerprint([{ id: 'a.md', aliases: ['飞书', 'lark'] }]), corpusFingerprint([{ id: 'a.md', aliases: '飞书,lark' }]));
});

test('corpusFingerprint：大语料下是确定值（同样输入永远同样指纹）', () => {
  // 不与具体哈希字面量绑定：只钉「确定性」和「对内容敏感」。
  const docs = Array.from({ length: 500 }, (_, i) => ({
    id: `note-${i}.md`,
    title: `标题 ${i}`,
    description: '',
    aliases: '',
    body: `正文 ${i} `.repeat(20),
  }));
  const fp = corpusFingerprint(docs);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(corpusFingerprint(docs), fp, '同输入必须同指纹');
  assert.equal(corpusFingerprint([...docs].reverse()), fp, 'id 不同 → 顺序无关');

  const edited = docs.map((d, i) => (i === 250 ? { ...d, body: `${d.body}改了一个字` } : d));
  assert.notEqual(corpusFingerprint(edited), fp, '中间改一个字也要变');
});

test('corpusFingerprint：id 重复且**没有 seq** 的退化语料无法区分桶，顺序仍影响指纹', (t) => {
  // 排序比较函数已是全序（id 相等再比 seq），所以顺序无关性要用**带 seq** 的语料来钉（见下一条）。
  // 这里故意不写 seq：同 id 的桶排序键完全相等 → Array#sort 保持稳定 → 输入的先后被原样保留。
  // 真实语料不落进这个退化形态：readDocs() 给长笔记的每个桶都写了 seq。
  // 只钉「同一顺序下确定」，顺序敏感性发诊断而不断言 —— 免得两种实现互踩。
  const docs = [
    { id: 'long.md', body: '第一桶' },
    { id: 'long.md', body: '第二桶' },
    { id: 'long.md', body: '第三桶' },
  ];
  assert.equal(corpusFingerprint(docs), corpusFingerprint(docs.map((d) => ({ ...d }))), '同顺序必须同指纹');

  const reversed = [...docs].reverse();
  if (corpusFingerprint(reversed) !== corpusFingerprint(docs)) {
    t.diagnostic('退化语料：同 id 且无 seq，桶彼此等价、排序保持输入顺序，故指纹随顺序变；真实语料请带 seq。');
  }
});

test('corpusFingerprint：同 id 多桶（长笔记切桶的真实形态）时指纹与输入顺序无关', () => {
  // 修复点：比较器此前对相等 id 恒返回 1（不是全序），同 id 多桶的相对次序由输入数组决定 ——
  // 于是「同一份语料、换个顺序」得到不同指纹，探针会把一次顺序抖动误报成「卷子换了」。
  // 现在第二键是 seq ⇒ 全序 ⇒ 指纹只由语料内容决定。readDocs() 产出的桶天生带 seq。
  const docs = [
    { id: 'a', seq: 0, title: '甲 § 一', description: '', aliases: '', body: '第一桶' },
    { id: 'a', seq: 1, title: '一', description: '', aliases: '', body: '第二桶' },
    { id: 'a', seq: 2, title: '二', description: '', aliases: '', body: '第三桶' },
  ];
  const fp = corpusFingerprint(docs);
  assert.equal(corpusFingerprint([...docs].reverse()), fp, '反序必须同指纹');
  assert.equal(corpusFingerprint([docs[1], docs[2], docs[0]]), fp, '轮换顺序必须同指纹');
  assert.equal(corpusFingerprint(docs.map((d) => ({ ...d }))), fp, '同内容的另一批对象必须同指纹');
  // 反面：顺序无关不等于「桶之间随便调换内容也无关」—— 换掉桶的正文指纹必须变。
  assert.notEqual(
    corpusFingerprint([{ ...docs[0], body: '第二桶' }, { ...docs[1], body: '第一桶' }, docs[2]]),
    fp,
    '把 seq 0 与 seq 1 的正文对调 ⇒ 指纹必须变',
  );
});
