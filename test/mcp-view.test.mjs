/**
 * MCP 只读视图的补齐：engramory_list / engramory_usage / engramory://index / prompts。
 *
 * 这里刻意不复述「跑一遍不炸」：每条断言都盯着一个会真的出错的点 ——
 * 类型过滤把没写 type 的笔记算进去、长笔记切桶后列了两遍、账本不存在时印一串 0、
 * 榜单按「注入次数」而不是「打开次数」排、提示词缺参数却照样渲染出空 query。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool, createSession, getPrompt, handleMessage, listResources, readResource, McpError,
  DEFAULT_LIST_LIMIT, DEFAULT_USAGE_TOP, INDEX_RESOURCE, INDEX_URI, MAX_LIST_LIMIT, MAX_OUTPUT_CHARS,
  MAX_USAGE_TOP, PROMPTS,
} from '../mcp.js';

/** 账本文件名：写死在这里，是为了让「没账本 ≠ 0」这条断言不跟着实现一起被改掉。 */
const USAGE_FILE = '.engramory-recall.jsonl';

/** 一个临时记忆库。files 是「相对路径 → 内容」，路径里带 `/` 的用来造子目录。 */
function tempStore(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-view-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const withStore = async (fn, files) => {
  const dir = tempStore(files);
  try {
    return await fn(createSession({ store: dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const textOf = (result) => (result?.content ?? []).map((c) => c.text).join('\n');

const tool = (session, name, args) => callTool(session, { name, arguments: args });

/**
 * 造一篇笔记。description 只认 frontmatter（正文里的「用户是谁：」不算描述 ——
 * store.js 的 splitNote 只 pick frontmatter 的字段），所以这里也必须写在 fm 里。
 */
const note = (body, { type, description } = {}) => {
  const head = [type ? `type: ${type}` : '', description ? `description: ${description}` : ''].filter(Boolean);
  return `${head.length ? `---\n${head.join('\n')}\n---\n\n` : ''}${body}\n`;
};

/** 把某篇笔记的 mtime 按给定秒数设成过去 —— 用来把「按 mtime 新的在前」钉死。 */
const ageFile = (dir, file, secondsAgo) => {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(dir, file), when, when);
};

/** 写一行账本（与 usage.js 的写入形状一致：ts / kind / ids / scope…）。 */
const usageLine = (entry) => `${JSON.stringify(entry)}\n`;
const writeLedger = (dir, entries) => writeFileSync(join(dir, USAGE_FILE), entries.map(usageLine).join(''));

// ── 1. engramory_list ──────────────────────────────────────────────────────

test('engramory_list：一行一篇（文件名 · 类型 · 描述 · 字符数），按 mtime 新的在前', async () => {
  await withStore(async (session, dir) => {
    // 文件名升序是 a < b < c，更新时间反过来 —— 列出来的顺序必须跟 mtime 走，
    // 否则「最近改过的排前面」就是句空话（而且会让刚才在改的那篇掉出第一屏）。
    ageFile(dir, 'a.md', 300);
    ageFile(dir, 'b.md', 200);
    ageFile(dir, 'c.md', 100);
    const listed = await tool(session, 'engramory_list', {});
    assert.equal(listed.isError, false);
    const lines = textOf(listed).split('\n');
    assert.match(lines[0], /^库：.+ · 共 3 篇$/);
    assert.match(lines[1], /^c\.md · — · （没有描述） · \d+ 字符$/, '最新改的在第一行；没写 type/description 也照样列');
    assert.match(lines[2], /^b\.md · project · 项目决策：先落盘再优化 · \d+ 字符$/);
    assert.match(lines[3], /^a\.md · user · 用户是谁 · \d+ 字符$/);
    assert.equal(lines.at(-1), '共 3 篇，这里列了前 3 篇。');
    assert.match(lines[3], /· [1-9]\d* 字符$/, '字符数要从 readDocs 带出来');
  }, {
    'a.md': note('# A\n\n用户是谁：杨总。', { type: 'user', description: '用户是谁' }),
    'b.md': note('# B\n\n先落盘再优化。', { type: 'project', description: '项目决策：先落盘再优化' }),
    'c.md': '没有 frontmatter 的一行正文。\n',
  });
});

test('engramory_list：mtime 相同就按文件名排（顺序必须是确定的）', async () => {
  await withStore(async (session, dir) => {
    const when = new Date(Date.now() - 60_000);
    for (const file of ['b.md', 'a.md', 'c.md']) utimesSync(join(dir, file), when, when);
    const lines = textOf(await tool(session, 'engramory_list', {})).split('\n');
    assert.deepEqual(lines.slice(1, 4).map((line) => line.split(' · ')[0]), ['a.md', 'b.md', 'c.md'], '同一 mtime 时按文件名升序');
  }, { 'a.md': note('# A'), 'b.md': note('# B'), 'c.md': note('# C') });
});

test('engramory_list：kind 过滤按 frontmatter 的 type，非法值给可选清单而不是空清单', async () => {
  await withStore(async (session) => {
    const all = textOf(await tool(session, 'engramory_list', {}));
    assert.match(all, /^库：.+ · 共 3 篇$/m, '全部 = 写了 type 的 2 篇 + 没写 type 的 1 篇');
    const users = textOf(await tool(session, 'engramory_list', { kind: 'user' }));
    assert.match(users, /^库：.+ · 类型：user（全部 3 篇里有 1 篇）$/m, '分母是全部（含没写 type 的），分子是这一类');
    const userFiles = users.split('\n').map((line) => line.split(' · ')[0]);
    assert.equal(userFiles.includes('b.md'), false, 'kind 过滤要真的把别的类型挡在外面');
    assert.equal(userFiles.includes('a.md'), true);
    assert.equal(users.split('\n').at(-1), '共 1 篇（类型 user），这里列了前 1 篇。');
    // 没写 type 的笔记不属于任何 kind —— 按 kind 过滤时它就该消失，而不是被当成「都算」
    const refs = textOf(await tool(session, 'engramory_list', { kind: 'reference' }));
    assert.equal(refs.split('\n').map((line) => line.split(' · ')[0]).includes('plain.md'), false);
    const bad = await tool(session, 'engramory_list', { kind: 'diary' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /kind 只认 user \/ feedback \/ project \/ reference 之一，收到的是：diary/);
  }, {
    'a.md': note('# A', { type: 'user' }),
    'b.md': note('# B', { type: 'project' }),
    'plain.md': '# 没写 type 的笔记\n',
  });
});

test('engramory_list：limit 上限 50、默认 20、下限 1（越界夹紧并说明）', async () => {
  const files = {};
  for (let i = 0; i < 60; i += 1) files[`n${String(i).padStart(2, '0')}.md`] = note(`# ${i}`, { type: 'project' });
  // 文件名升序 ≠ 列出的顺序（按 mtime 排），所以只断言「列了几行」，不断言具体哪几篇
  await withStore(async (session) => {
    const byDefault = textOf(await tool(session, 'engramory_list', {})).split('\n');
    assert.equal(byDefault.length, DEFAULT_LIST_LIMIT + 2, '默认列 20 条 + 头 + 尾');
    assert.match(byDefault.at(-1), /共 60 篇，这里列了前 20 篇。还有 40 篇没列出来（用 limit 调大，上限 50，或按 kind 过滤）。$/);
    const byMax = textOf(await tool(session, 'engramory_list', { limit: 999 })).split('\n');
    assert.equal(byMax.length, MAX_LIST_LIMIT + 2, '999 夹到上限 50');
    assert.match(byMax.at(-1), /前 50 篇。还有 10 篇没列出来/);
    const clamped = textOf(await tool(session, 'engramory_list', { limit: 999 })).split('\n').at(-1);
    assert.match(clamped, /（limit 收到 999，按 50 算）$/, '夹紧不许静默，得说清按什么算的');
    assert.equal(textOf(await tool(session, 'engramory_list', { limit: 0 })).split('\n').length, 3, '0 夹到 1');
    assert.equal(textOf(await tool(session, 'engramory_list', { limit: 'abc' })).split('\n').length, DEFAULT_LIST_LIMIT + 2, '不是数就按默认算');
    assert.equal(textOf(await tool(session, 'engramory_list', { limit: -5 })).split('\n').length, 3, '负数夹到 1');
  }, files);
});

test('engramory_list：长笔记切桶后同 id 只算一条（保留第一条）', async () => {
  await withStore(async (session) => {
    const text = textOf(await tool(session, 'engramory_list', {}));
    const lines = text.split('\n');
    assert.match(lines[1], /^long\.md · reference · 总结一句话 · \d+ 字符$/, '长笔记只出现一次，且拿的是第一条（首桶）的描述与整篇字数');
    assert.equal(lines.filter((line) => line.startsWith('long.md ·')).length, 1, '同一个 id 不许列两遍');
    assert.match(lines.at(-1), /^共 1 篇，这里列了前 1 篇。$/);
  }, {
    // 正文要真的超过 store.js 的 SECTION_BYTES（6KB）才会被切桶，否则测的是「短笔记」这条路
    'long.md': note(`# 长笔记\n\n${'段落内容。'.repeat(1500)}`, { type: 'reference', description: '总结一句话' }),
  });
});

test('engramory_list：描述截到 ~60 字，emoji 也不许被劈成两半', async () => {
  await withStore(async (session) => {
    const line = textOf(await tool(session, 'engramory_list', {})).split('\n')[1];
    const description = line.split(' · ')[2];
    assert.ok([...description].length <= 61, `描述要截到 ~60 字，实际 ${[...description].length}`);
    assert.ok([...description].length >= 55, `截到 60 字就该是 60 字上下，实际 ${[...description].length}`);
    assert.ok(description.endsWith('…'), '截断要留个记号，别假装描述就这么短');
    // 代理对（emoji）按码点截：用 Array.from 数不出半个字符，就不会出现 Unicode 替换符
    assert.equal(description.includes('\uFFFD'), false);
    assert.equal(description.startsWith('😀😀😀'), true, '截断只砍尾巴，不许从头就错位');
  }, {
    // 80 个 😀 = 160 码元 / 80 码点：只有按码点算才会截到 60 字，按码元算切出来多半是半个 emoji
    'a.md': note('# A', { type: 'user', description: '😀'.repeat(80) }),
  });
});

test('engramory_list：库不存在 / 空库都是 isError 文本，并指向 --store', async () => {
  const missing = join(tmpdir(), `mcp-view-missing-${Date.now()}`);
  await withStore(async (session) => {
    const res = await tool(session, 'engramory_list', {});
    assert.equal(res.isError, true);
    assert.equal(textOf(res), `库是空的或不存在：${session.store}。用 --store <路径> 或环境变量 ENGRAMORY_STORE 指定。`);
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, 'text');
  }, {});
  rmSync(missing, { recursive: true, force: true });
});

// ── 2. engramory_usage ────────────────────────────────────────────────────

test('engramory_usage：没有账本时明说「还没有账本」，一个 0 都不印', async () => {
  await withStore(async (session, dir) => {
    const res = await tool(session, 'engramory_usage', {});
    assert.equal(res.isError, false);
    const text = textOf(res);
    assert.match(text, /^还没有账本：.+\.engramory-recall\.jsonl 不存在。/);
    assert.match(text, /这个服务器只读，不会替你创建它/);
    // 临时目录名自带数字，先把它和账本文件名擦掉，再要求正文里一个数字都没有
    assert.equal(/\d/.test(text.split(dir).join('/库').replace(/\.engramory-recall\.jsonl/g, '')), false, '缺数据不许印 0');
  }, { 'a.md': note('# A', { type: 'user' }) });
});

test('engramory_usage：账本存在但是空的，也不许印 0', async () => {
  const dir = tempStore({ 'a.md': note('# A', { type: 'user' }) });
  try {
    writeFileSync(join(dir, USAGE_FILE), '');
    const res = await callTool(createSession({ store: dir }), { name: 'engramory_usage', arguments: {} });
    const text = textOf(res);
    assert.match(text, /^账本还是空的：/);
    assert.equal(/\d/.test(text.split(dir).join('/库').replace(/\.engramory-recall\.jsonl/g, '')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engramory_usage：有数据时报关键数字，并标清 used 与 usedCounted 是两个口径', async () => {
  const dir = tempStore({
    'a.md': note('# A', { type: 'user' }),
    'b.md': note('# B', { type: 'project' }),
    'MEMORY.md': '# 索引\n- 一行指针\n',
  });
  try {
    const t0 = Date.now() - 3600_000;
    writeLedger(dir, [
      { ts: t0, kind: 'hit', ids: ['a.md', 'b.md'], scope: 'main', budget: 1000, spent: 900 },
      { ts: t0 + 1000, kind: 'used', id: 'a.md', via: 'a.md', lagMs: 1000 },
      // 同一轮里把 a.md 读了两次：openRate 的分子只算一次，used 行数照记两条
      { ts: t0 + 2000, kind: 'used', id: 'a.md', via: 'a.md', lagMs: 2000 },
      { ts: t0 + 3000, kind: 'hit', ids: ['b.md'], scope: 'subagent', budget: 1000, spent: 500 },
      { ts: t0 + 4000, kind: 'used', id: 'b.md', via: 'b.md', lagMs: 1000 },
      { ts: t0 + 5000, kind: 'empty', reason: 'no-hits' },
      { ts: t0 + 6000, kind: 'skip', reason: 'chitchat' },
      { ts: t0 + 7000, kind: 'sediment' },
    ]);
    const text = textOf(await callTool(createSession({ store: dir }), { name: 'engramory_usage', arguments: {} }));
    assert.match(text, /^账本：.+（全部：8 行，覆盖 \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}）$/m);
    assert.match(text, /^轮次：2 轮注入了指针，共 3 条$/m);
    // 分子是「去重后的打开条数」= 2（a.md 那一轮读三次只算一次）；原始 used 行数是 3
    assert.match(text, /^被打开：usedCounted（同一轮里读三次只算一次）2 条 \/ 打开率 66\.7% —— 原始 used 行数 3 条/m);
    assert.match(text, /^一个字都没进：1 轮（注入过 0 条）；另有去重跳过 1 轮、沉淀 1 轮$/m);
    assert.match(text, /^按来源：主对话 1 轮 \/ 2 条 \/ 打开 1 条 ｜ 子代理 1 轮 \/ 1 条 \/ 打开 1 条$/m);
    assert.match(text, /^预算（maxChars）：2 轮记了用量，中位用掉 50%、顶格（≥95%）0 轮$/m, '500 与 900 的中位是 700/1000 = 50%');
    assert.match(text, /^被真正打开最多的 5 篇：$/m);
    // 榜单要按「被打开」排，不是按「注入次数」排（summary.notes 默认后者）
    assert.match(text, /^1\. (a|b)\.md —— 被打开过 1 轮 \/ 注入过 \d+ 轮$/m);
    assert.match(text, /这是代理指标：它证明「笔记后来被打开了」，证明不了「被用进了回答」/);
    assert.equal(text.split('\n').at(-1), '这是代理指标：它证明「笔记后来被打开了」，证明不了「被用进了回答」——判断一套召回管不管用，还得看打开率之外的位置曲线与来源拆分。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engramory_usage：top 榜按被打开次数排（不是注入次数）且夹到 [1,20]', async () => {
  const dir = tempStore({ 'a.md': '# A\n', 'b.md': '# B\n' });
  try {
    const t0 = Date.now() - 3600_000;
    const entries = [];
    // a.md：注入得多（每轮都带），只被打开过一次；b.md：只注入一次，却被打开过三轮
    entries.push({ ts: t0, kind: 'hit', ids: ['a.md'], scope: 'main' });
    entries.push({ ts: t0 + 1, kind: 'hit', ids: ['a.md'], scope: 'main' });
    entries.push({ ts: t0 + 2, kind: 'used', id: 'a.md', via: 'a.md' });
    for (const [i, at] of [10, 20, 30].entries()) {
      entries.push({ ts: t0 + 100 + at, kind: 'hit', ids: ['b.md'], scope: 'main' });
      entries.push({ ts: t0 + 100 + at + 1, kind: 'used', id: 'b.md', via: 'b.md' });
      void i;
    }
    writeLedger(dir, entries);
    const session = createSession({ store: dir });
    const text = textOf(await tool(session, 'engramory_usage', { top: 1 }));
    assert.match(text, /^被真正打开最多的 1 篇：$/m, 'top 参数要真的改标题里的数字');
    assert.match(text, /^1\. b\.md —— 被打开过 3 轮 \/ 注入过 3 轮$/m, '按「被打开」排：b.md 注入 1 次但被打开 3 轮，要压过注入 2 轮只被打开 1 轮的 a.md');
    assert.equal(text.includes('\n2. '), false, 'top 1 就只列一篇');
    const many = textOf(await tool(session, 'engramory_usage', { top: 999 }));
    assert.match(many, /^被真正打开最多的 20 篇：$/m, 'top 夹到上限 20');
    const zero = textOf(await tool(session, 'engramory_usage', { top: 0 }));
    assert.match(zero, new RegExp(`^被真正打开最多的 ${1} 篇：$`, 'm'), 'top 0 夹到 1（不能印「前 0 篇」）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engramory_usage：days 过滤走 ts，窗口内空就说窗口空 —— 不说「还没有账本」', async () => {
  const dir = tempStore({ 'a.md': '# A\n' });
  try {
    const old = Date.now() - 40 * 86400000;
    writeLedger(dir, [
      { ts: old, kind: 'hit', ids: ['a.md'], scope: 'main' },
      { ts: old + 1000, kind: 'used', id: 'a.md', via: 'a.md' },
    ]);
    const session = createSession({ store: dir });
    const all = textOf(await tool(session, 'engramory_usage', {}));
    assert.match(all, /^账本：.+（全部：2 行/m);
    assert.match(all, /^轮次：1 轮注入了指针，共 1 条$/m);
    const windowed = textOf(await tool(session, 'engramory_usage', { days: 7 }));
    assert.match(windowed, /^最近 7 天没有账本记录（.+ 共 2 行，最早一行在 \d{4}-\d{2}-\d{2}）。$/);
    assert.equal(windowed.includes('还没有账本'), false, '账本在，只是窗口里没有 —— 别把两种缺数据混成一句');
    const recent = textOf(await tool(session, 'engramory_usage', { days: 3650 }));
    assert.match(recent, /^账本：.+（最近 3650 天窗口：2 行/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. engramory://index ──────────────────────────────────────────────────

test('engramory://index：读 MEMORY.md 原文；缺失时说人话，且不暴露别的路径', async () => {
  await withStore(async (session) => {
    const res = await handleMessage(session, { id: 1, method: 'resources/read', params: { uri: INDEX_URI } });
    assert.equal(res.result.contents.length, 1);
    assert.equal(res.result.contents[0].uri, INDEX_URI, 'URI 原样回显');
    assert.equal(res.result.contents[0].mimeType, 'text/markdown');
    assert.equal(res.result.contents[0].text, '# 索引\n- 一行指针\n', '原文照给，不加头不加尾');
  }, { 'a.md': '# A\n', 'MEMORY.md': '# 索引\n- 一行指针\n' });

  await withStore(async (session) => {
    const frame = await handleMessage(session, { id: 2, method: 'resources/read', params: { uri: INDEX_URI } });
    assert.equal(frame.error.code, -32603, '索引缺失也是内部错误，不是「没这个方法」');
    assert.match(frame.error.message, /读不到索引：.+\/MEMORY\.md。用 engramory_status 确认库的位置/);
    assert.equal(await handleMessage(session, { method: 'resources/read', params: { uri: INDEX_URI } }), null, '通知静默');
  }, { 'a.md': '# A\n' });
});

test('resources/list 里索引排第一，且模板与 templates/list 行为不变', async () => {
  await withStore(async (session) => {
    const list = listResources(session).resources;
    assert.deepEqual(list[0], INDEX_RESOURCE, '索引排在最前（它是「先看这个」）');
    assert.equal(list[0].uri, INDEX_URI);
    assert.equal(list[0].name, '记忆索引');
    assert.equal(list[0].mimeType, 'text/markdown');
    assert.match(list[0].description, /MEMORY\.md 全文/);
    // 帧里不能有 undefined：JSON 化之后键会凭空消失
    const frame = await handleMessage(session, { id: 1, method: 'resources/list' });
    assert.deepEqual(JSON.parse(JSON.stringify(frame)).result.resources[0], INDEX_RESOURCE);
    // note 模板照旧
    const tpl = await handleMessage(session, { id: 2, method: 'resources/templates/list' });
    assert.deepEqual(tpl.result.resourceTemplates.map((t) => t.uriTemplate), ['engramory://note/{file}']);
    // 越界读仍然被挡（新加的 index 分支不许把 safeNotePath 那条路绕松）
    const escaped = await handleMessage(session, { id: 3, method: 'resources/read', params: { uri: 'engramory://note/../MEMORY.md' } });
    assert.equal(escaped.error.code, -32603);
    assert.match(escaped.error.message, /不是库里的笔记文件名/);
  }, { 'a.md': '# A\n', 'MEMORY.md': '# 索引\n' });
});

test('超长资源仍被 MAX_OUTPUT_CHARS 截断（新入口不许把天花板捅漏）', async () => {
  await withStore(async (session) => {
    const res = await handleMessage(session, { id: 1, method: 'resources/read', params: { uri: 'engramory://note/big.md' } });
    const text = res.result.contents[0].text;
    assert.ok(text.length < MAX_OUTPUT_CHARS + 200, `截断后的长度要守住天花板，实际 ${text.length}`);
    assert.match(text, /…（笔记超过 40000 字符，这里截断了；完整原文在 big\.md）/);
    assert.equal(readResource(session, { uri: 'engramory://note/big.md' }).contents[0].text.length, text.length);
  }, { 'big.md': `# 大笔记\n\n${'字'.repeat(MAX_OUTPUT_CHARS + 5000)}\n` });
});

// ── 4. prompts ────────────────────────────────────────────────────────────

test('prompts/list：两个定义的完整形状（name / description / arguments）', async () => {
  await withStore(async (session) => {
    const prompts = (await handleMessage(session, { id: 1, method: 'prompts/list' })).result.prompts;
    assert.deepEqual(prompts.map((p) => p.name), ['recall', 'curate']);
    assert.deepEqual(prompts, PROMPTS, 'list 里给的就是那份定义本身');
    for (const prompt of prompts) {
      assert.deepEqual(Object.keys(prompt), ['name', 'description', 'arguments'], 'MCP 认这三个键，别的别塞');
      assert.ok(prompt.description.length > 20, '描述得让用户在客户端里看懂这是干什么的');
      assert.ok(Array.isArray(prompt.arguments), 'arguments 必须是数组（没有就是空数组，不是 undefined）');
      for (const arg of prompt.arguments) {
        assert.deepEqual(Object.keys(arg), ['name', 'description', 'required']);
        assert.equal(typeof arg.required, 'boolean');
      }
    }
    assert.deepEqual(prompts[0].arguments, [{ name: 'query', description: prompts[0].arguments[0].description, required: true }]);
    assert.deepEqual(prompts[1].arguments, [], 'curate 没有参数');
    // 帧里不能有 undefined
    const frame = await handleMessage(session, { id: 2, method: 'prompts/list' });
    assert.deepEqual(JSON.parse(JSON.stringify(frame)).result.prompts, PROMPTS);
  }, { 'a.md': '# A\n' });
});

test('prompts/get：recall 把 query 渲染进 messages，并写明只读', async () => {
  await withStore(async (session) => {
    const res = await handleMessage(session, { id: 1, method: 'prompts/get', params: { name: 'recall', arguments: { query: '上次那个钻头螺栓是怎么定的' } } });
    const { description, messages } = res.result;
    assert.equal(description, PROMPTS[0].description);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user', 'MCP 的 role 只认 user / assistant（没有 system）');
    assert.equal(messages[0].content.type, 'text');
    const text = messages[0].content.text;
    assert.match(text, /上次那个钻头螺栓是怎么定的/, 'query 必须原样出现在渲染结果里');
    assert.match(text, /engramory_search/);
    assert.match(text, /engramory_read/);
    assert.match(text, /只读/);
    assert.match(text, /不要写文件/);
    // 渲染必须是纯函数：同一个 query 两次得到同一段文本，且不碰库
    assert.equal(getPrompt({ name: 'recall', arguments: { query: 'x' } }).messages[0].content.text, getPrompt({ name: 'recall', arguments: { query: 'x' } }).messages[0].content.text);
  }, { 'a.md': '# A\n' });
});

test('prompts/get：curate 没参数也渲染，且明确「用户确认后自己写文件」', async () => {
  await withStore(async (session) => {
    const res = await handleMessage(session, { id: 1, method: 'prompts/get', params: { name: 'curate' } });
    const text = res.result.messages[0].content.text;
    for (const word of ['type: user|feedback|project|reference', 'name', 'description']) {
      assert.ok(text.includes(word), `Format v1 草稿要提到 ${word}`);
    }
    assert.match(text, /让我确认/);
    assert.match(text, /\*\*你来写文件\*\*/);
    assert.match(text, /只读/);
    // 连 arguments 都不给也算「没参数」，不是错误
    assert.deepEqual(getPrompt({ name: 'curate' }), getPrompt({ name: 'curate', arguments: {} }));
  }, { 'a.md': '# A\n' });
});

test('prompts/get：缺必填参数 / 未知名字都给人话错误，并列出可用名字', async () => {
  await withStore(async (session) => {
    for (const args of [undefined, {}, { query: '' }, { query: '   ' }, { query: 'undefined' }]) {
      const frame = await handleMessage(session, { id: 2, method: 'prompts/get', params: { name: 'recall', arguments: args } });
      assert.equal(frame.error.code, -32603, `${JSON.stringify(args)} 缺 query 应当报错`);
      assert.match(frame.error.message, /^query 不能为空/);
    }
    // 给了但不是字符串：不能 String() 一下就当成查询词用（那会把 [object Object] 塞进提示词）
    const wrongType = await handleMessage(session, { id: 20, method: 'prompts/get', params: { name: 'recall', arguments: { query: 42 } } });
    assert.equal(wrongType.error.code, -32603, '数字要被挡住');
    assert.equal(wrongType.error.message, 'query 必须是字符串：收到的是 number。');
    const unknown = await handleMessage(session, { id: 3, method: 'prompts/get', params: { name: 'recoll' } });
    assert.equal(unknown.error.code, -32603);
    assert.equal(unknown.error.message, '没有这个提示：recoll。可用：recall / curate');
    const empty = await handleMessage(session, { id: 4, method: 'prompts/get', params: {} });
    assert.equal(empty.error.message, '没有这个提示：(空)。可用：recall / curate');
    assert.equal(await handleMessage(session, { method: 'prompts/get', params: { name: 'x' } }), null, '通知静默');
  }, { 'a.md': '# A\n' });
});

test('MCP：没实现的方法仍是 -32601（新增 prompts 不等于接管所有方法）', async () => {
  await withStore(async (session) => {
    for (const method of ['prompts/getX', 'resources/subscribe', 'tools/callOther', 'PROMPTS/GET']) {
      const frame = await handleMessage(session, { id: 5, method });
      assert.equal(frame.error.code, -32601);
      assert.equal(frame.error.message, `Method not found: ${method}`);
    }
    assert.equal((await handleMessage(session, { id: 6, method: 'tools/call', params: { name: 'engramory_list' } })).result.isError, false, '新工具能通过协议调到');
    const unknownTool = await handleMessage(session, { id: 7, method: 'tools/call', params: { name: 'engramory_write' } });
    assert.equal(unknownTool.result.isError, true, '工具错误仍然是 isError 文本，不是 JSON-RPC 错误');
    assert.match(unknownTool.result.content[0].text, /没有这个工具：engramory_write/);
    assert.equal(unknownTool.error, undefined);
  }, { 'a.md': '# A\n' });
});

test('McpError 与缺参渲染共用同一套人话（形状不变，只是多了两个入口）', async () => {
  await withStore(async (session) => {
    assert.throws(() => getPrompt({ name: 'recall' }), McpError);
    assert.throws(() => getPrompt({ name: 'nope' }), (error) => error instanceof McpError && /可用：recall \/ curate/.test(error.message));
    assert.equal(await tool(session, 'engramory_list', { kind: 42 }).then(textOf).then((t) => t.includes('kind 只认')), true, 'kind 不是字符串也按非法值处理');
    assert.equal(DEFAULT_USAGE_TOP, 5);
    assert.equal(DEFAULT_USAGE_TOP <= MAX_USAGE_TOP, true);
  }, { 'a.md': '# A\n' });
});
