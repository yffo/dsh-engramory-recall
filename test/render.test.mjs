/**
 * `render.js` —— 注入文本的渲染与**预算分配**。
 *
 * 这一期改的就是「预算怎么花」：从「每条一律 64 字」改成「按名次分配」。
 * 要钉的契约：
 *   1. 预算永远是硬约束：`used ≤ budget`（「另有 N 条未列出」那句的 80 字余量是
 *      唯一例外，且它只在真有命中被丢掉时才出现）；
 *   2. 老口径必须还能复现：给 `snippetChars` 或 `snippetPlan` 时行为与改造前逐字节一致
 *      （基准的 `--no-plan --snippet-chars=64` 靠这条对齐基线）；
 *   3. 名次分配不能把尾巴饿死：任何还带片段的条目至少 `MIN_SNIPPET_CHARS` 字，
 *      实在分不过来就**减少片段条数**（尾部塌缩成文件名），而不是人人切碎；
 *   4. 降级阶梯不许退化：整条装不下 → 只有文件名；连文件名都装不下 → 记账 `dropped` + 补一句说明。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_SNIPPET_CHARS,
  MAX_SNIPPET_CHARS,
  MIN_BUDGET,
  MIN_SNIPPET_CHARS,
  RECALL_HEADER,
  clip,
  planSnippets,
  renderPointers,
} from '../render.js';

/** 造几条假命中；id 长度贴近真实（`reference-xxx-yyy.md` 这种）。 */
function hits(
  count,
  snippet = '根因是 采样率 没有跟着一起更新 —— 每次跑了两次都会退回旧值，日志里只能看到一半；'
    + '修的时候把 采样率 跟 回滚点 一起写进同一张表，再让 打包 那步读表，才不会再退回旧值。',
) {
  return Array.from({ length: count }, (_, i) => ({
    id: `reference-sample-topic-${i}.md`,
    score: 10 - i,
    snippet,
  }));
}

test('按名次分配：第一名明显多于后面，全部不低于下限，且不超上限', () => {
  const plan = planSnippets(hits(4), { maxChars: DEFAULT_MAX_CHARS });
  assert.equal(plan.length, 4);
  assert.ok(plan[0] > DEFAULT_SNIPPET_CHARS, `第一名只拿到 ${plan[0]} 字，跟老口径没区别`);
  assert.ok(plan[0] >= plan[1] && plan[1] >= plan[2] && plan[2] >= plan[3], `名次不是递减的：${plan}`);
  assert.ok(plan[3] >= MIN_SNIPPET_CHARS, `尾巴被饿死：${plan}`);
  assert.ok(plan[0] <= MAX_SNIPPET_CHARS, `第一名超过了单条上限：${plan[0]}`);
});

test('按名次分配：预算不够时先减少片段条数，而不是把每条都切碎', () => {
  const plan = planSnippets(hits(6), { maxChars: MIN_BUDGET });
  assert.equal(plan.length, 6);
  const withSnippet = plan.filter((n) => n > MIN_SNIPPET_CHARS).length;
  assert.ok(withSnippet >= 1, `一条都分不到片段：${plan}`);
  assert.ok(withSnippet < 6, `预算都到下限了还人人有份：${plan}`);
  assert.ok(plan.slice(withSnippet).every((n) => n === MIN_SNIPPET_CHARS));
});

test('按名次分配：没有命中时不炸，也不产生负数', () => {
  assert.deepEqual(planSnippets([], { maxChars: 480 }), []);
  const plan = planSnippets(hits(3), { maxChars: 1 });
  assert.equal(plan.length, 3);
  assert.ok(plan.every((n) => n >= MIN_SNIPPET_CHARS));
});

test('渲染：默认走名次分配，第一名带整句话，尾巴让位，注入行不超预算', () => {
  const list = hits(4);
  const fresh = renderPointers(list, { maxChars: DEFAULT_MAX_CHARS });
  const old = renderPointers(list, { maxChars: DEFAULT_MAX_CHARS, snippetChars: DEFAULT_SNIPPET_CHARS });
  assert.equal(fresh.lines.length, 4);
  assert.ok(fresh.used <= fresh.budget, `超预算：${fresh.used} > ${fresh.budget}`);
  // 名次分配真正的收益：**第一名带的是整句话**（老口径 64 字必然把它截断）。
  assert.equal(fresh.lines[0], `- ${list[0].id} — ${list[0].snippet}`);
  assert.ok(old.lines[0].endsWith('…'), '老口径应该把第一句截断');
  assert.ok(fresh.lines[3].length < old.lines[3].length, '尾巴让位没生效');
  assert.equal(fresh.header, RECALL_HEADER);
});

test('渲染：给 snippetChars 或 snippetPlan 时，与改造前的老口径逐字节一致', () => {
  const list = hits(3);
  const flat = renderPointers(list, { maxChars: DEFAULT_MAX_CHARS, snippetChars: DEFAULT_SNIPPET_CHARS });
  const planned = renderPointers(list, {
    maxChars: DEFAULT_MAX_CHARS,
    snippetPlan: [DEFAULT_SNIPPET_CHARS, DEFAULT_SNIPPET_CHARS, DEFAULT_SNIPPET_CHARS],
  });
  assert.deepEqual(planned.lines, flat.lines);
  // 老口径的样子：`- 文件名 — 前 63 字…`
  assert.equal(flat.lines[0], `- ${list[0].id} — ${clip(list[0].snippet, DEFAULT_SNIPPET_CHARS)}`);
  assert.ok(flat.lines[0].endsWith('…'));
});

test('渲染：装不下时塌缩成只有文件名，连文件名都装不下则记账并补一句说明', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({
    id: `reference-${'long-topic-name-'.repeat(2)}${i}.md`,
    snippet: 'x'.repeat(400),
  }));
  const out = renderPointers(list, { maxChars: 480 });
  assert.equal(out.collapsed, out.shown.filter((h) => h.collapsed).length);
  assert.ok(out.collapsed > 0, '这么长的 id 应该出现塌缩');
  assert.ok(out.used <= out.budget + 80);
  assert.ok(out.shown.length + out.dropped === list.length);
  const tiny = renderPointers(list, { maxChars: DEFAULT_MAX_CHARS, header: 'x'.repeat(430) });
  assert.ok(tiny.dropped > 0, '连文件名都装不下时应记账');
  if (tiny.dropped) assert.match(tiny.lines.at(-1), /另有 \d+ 条命中因预算未列出/);
});

test('记账口径没变：used 从头长度起算，bytes 是该行真正写进上下文的字符数', () => {
  const list = hits(2);
  const out = renderPointers(list, { maxChars: DEFAULT_MAX_CHARS });
  assert.equal(out.used, out.header.length + out.lines.reduce((sum, line) => sum + line.length + 1, 0));
  for (const entry of out.shown) {
    assert.equal(entry.bytes, entry.line.length);
    assert.ok(out.lines.includes(entry.line));
  }
});

test('clip：折空白、超长留省略号、不切半个代理对', () => {
  assert.equal(clip('  a\n b  ', 10), 'a b');
  assert.equal(clip('abcdef', 3), 'ab…');
  assert.equal(clip('😀😀😀', 3), '😀…');
});

test('一条都列不出来时：不补说明句，lines 交白卷（让宿主按「预算太小」记账）', () => {
  // 预算 160、注入头 80、文件名 116 字符 → 连裸文件名都放不下。
  // 老行为会补一句「（另有 1 条命中因预算未列出）」：整轮注入 = 头部 + 这句话，
  // 一个名字都没有，模型无从下手。现在交给宿主记 `budget-too-small`。
  const long = [{ id: `${'r'.repeat(116)}.md`, score: 9, snippet: '代理节点双端口配置。' }];
  const out = renderPointers(long, { maxChars: 160 });
  assert.equal(out.shown.length, 0);
  assert.deepEqual(out.lines, [], '一条都没列出来就不该有正文');
  assert.equal(out.dropped, 1, '但账要记：确实有 1 条被预算挡在外面');
  assert.equal(out.used, out.header.length, 'used 等于头部长度（什么都没多花）');
  // 只要有一条列出来了，说明句仍然要在（预算不够时的那句提醒不能丢）。
  // 预算 260：第一条列得出来，长的那个连裸名字都放不下 → 有正文，才该补说明句。
  const mixed = renderPointers([...hits(1), ...long], { maxChars: 260 });
  assert.ok(mixed.shown.length >= 1);
  assert.match(mixed.lines.at(-1), /另有 \d+ 条命中因预算未列出/);
});
