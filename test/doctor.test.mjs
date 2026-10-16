// doctor.js 的测试：每条检查项各一个正例 + 误报防线各一个反例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { auditStore, normalizePath, parseFrontmatter } from '../doctor.js';
import { DEFAULT_MAX_BYTES } from '../store.js';

const NOW = Date.parse('2026-10-14T00:00:00Z');

function makeStore(notes, index) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-doctor-'));
  for (const [file, text] of Object.entries(notes)) writeFileSync(join(dir, file), text);
  const body = index ?? Object.keys(notes).map((f) => `- [${f}](${f})`).join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body);
  return dir;
}

function note(name, opts = {}) {
  const { description = '一句话说明', type = 'reference', updated = '2026-10-14', extra = '', body = '正文内容' } = opts;
  return `---
name: ${name}
description: ${description}
type: ${type}
created: 2026-01-01
updated: ${updated}
${extra}---

${body}
`;
}

const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);

test('干净的库零发现', (t) => {
  const dir = makeStore({ 'reference-hello-world.md': note('reference-hello-world') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.deepEqual(r.findings, []);
  assert.equal(r.summary.notes, 1);
  assert.equal(r.summary.bySeverity.error, 0);
});

test('索引指向不存在的文件 → error', (t) => {
  const dir = makeStore({ 'reference-hello-world.md': note('reference-hello-world') }, '- [没了](reference-gone.md)\n- [有](reference-hello-world.md)');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.ok(has(r, 'index-missing-file'));
  assert.equal(r.findings.find((f) => f.code === 'index-missing-file').severity, 'error');
});

test('笔记没进索引、也没人链接 → warn（模型读索引时永远发现不了它）', (t) => {
  const dir = makeStore({ 'reference-hello-world.md': note('reference-hello-world') }, '- 空索引\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(has(auditStore(dir, { now: NOW }), 'orphan-note'));
});

test('归档产生的 -history 没进索引、但主笔记链接了它 → 不算孤儿', (t) => {
  // 这是真事：归档按设计不写 MEMORY.md，只在主笔记末尾留一行「## 历史批次」链接。
  // 判据太严时，刚归档完就会冒出 4 条 warn，把一次正常操作报成事故。
  const main = note('project-cicd', {
    type: 'project',
    body: '结论与现状。\n\n## 历史批次\n\n早期日志已归档到 [project-cicd-history.md](project-cicd-history.md)。',
  });
  // 注意：索引必须**只列主笔记** —— makeStore 默认会把所有文件都写进索引，
  // 那样 history 就被索引了，这个用例会为了错误的理由而变绿（吃过一次这个亏）。
  const dir = makeStore(
    { 'project-cicd.md': main, 'project-cicd-history.md': note('project-cicd-history', { type: 'project' }) },
    '- [项目：CI/CD](project-cicd.md)\n',
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.ok(!has(r, 'orphan-note'), `被链接的归档不该报孤儿：${JSON.stringify(r.findings.map((f) => f.message))}`);
});

test('可达性是传递的，且循环链接不会转不出来', (t) => {
  // 索引 → A → B → C，C 也算可达；A 与 B 互相链接构成环，不能把检查卡死。
  const a = note('project-a', { type: 'project', body: '见 [b](project-b.md) 与 [c](project-c.md)。' });
  const b = note('project-b', { type: 'project', body: '回看 [a](project-a.md)，细项在 [c](project-c.md)。' });
  const c = note('project-c', { type: 'project', body: '又见 [a](project-a.md)。' });
  const dir = makeStore(
    { 'project-a.md': a, 'project-b.md': b, 'project-c.md': c },
    '- [a](project-a.md)\n',
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.ok(!has(r, 'orphan-note'), `多跳可达不该报孤儿：${JSON.stringify(r.findings.map((f) => f.message))}`);
});

test('链到不存在的文件不算数，孤儿的判据不能被空链接骗过', (t) => {
  // 笔记里写一行 `[别处](reference-不存在.md)` 就能自证可达？不行 —— 目标必须真实存在。
  const stray = note('reference-stray', { body: '见 [别处](reference-nonexistent.md)。' });
  const dir = makeStore({ 'reference-stray.md': stray }, '- 空索引\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(has(auditStore(dir, { now: NOW }), 'orphan-note'));
});

test('name / type / description / 体积四项自身检查', (t) => {
  const dir = makeStore({
    'reference-name-drift.md': note('reference-other-name'),
    'reference-type-clash.md': note('reference-type-clash', { type: 'project' }),
    'reference-no-desc.md': note('reference-no-desc', { description: '' }),
    'reference-huge.md': note('reference-huge', { body: 'x'.repeat(101 * 1024) }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.ok(has(r, 'name-mismatch'));
  assert.ok(has(r, 'type-mismatch'));
  assert.ok(has(r, 'missing-description'));
  assert.ok(has(r, 'oversize-note'));
});

test('文件名不符合四类事实前缀 → warn', (t) => {
  const dir = makeStore({ 'misc-random.md': note('misc-random') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(has(auditStore(dir, { now: NOW }), 'bad-filename'));
});

test('含待办字样且长期没更新 → info；刚更新过则不报', (t) => {
  const dir = makeStore({
    'project-stale.md': note('project-stale', { type: 'project', updated: '2026-01-01', body: '待办：收尾' }),
    'project-fresh.md': note('project-fresh', { type: 'project', updated: '2026-10-13', body: '待办：收尾' }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  const stale = r.findings.filter((f) => f.code === 'stale-todo');
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0].files, ['project-stale.md']);
});

test('同一 basename 出现在两个真目录 → info', (t) => {
  const dir = makeStore({
    'reference-paths.md': note('reference-paths', {
      body: `旧：${homedir()}/Documents/Acme/my-tool\n新：${homedir()}/proj-x/my-tool`,
    }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  const c = r.findings.find((f) => f.code === 'path-conflict');
  assert.ok(c);
  assert.ok(c.message.includes('my-tool'));
});

test('path-conflict 也认 Linux 的 /home 前缀（曾写死 /Users/ 导致整个检查静默失效）', (t) => {
  // 这个 bug 是在 CI 上暴露的：正则只认 macOS 的 /Users，Linux 跑起来一条 finding 都不出，
  // 不报错也不告警，看起来像"没问题"。修好之后补这条卡住它。
  const dir = makeStore({
    'reference-paths.md': note('reference-paths', {
      body: '旧：/home/runner/Documents/Acme/my-tool\n新：/home/runner/proj-x/my-tool',
    }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = auditStore(dir, { now: NOW }).findings.find((f) => f.code === 'path-conflict');
  assert.ok(c, 'Linux 下的绝对路径必须也能被认出来');
  assert.ok(c.message.includes('my-tool'));
});

test('path-conflict 的三条防误报：~ 归一、省略号、一层隐藏目录', (t) => {
  const dir = makeStore({
    // 同一处的两种写法——必须当成一个位置
    'reference-same.md': note('reference-same', { body: 'A: ~/proj-x/sub\nB: ' + homedir() + '/proj-x/sub' }),
    // 省略号是缩写，不是另一个位置
    'reference-ellipsis.md': note('reference-ellipsis', { body: '~/Library/Caches/ms-playwright/shell-1208/chrome-shell\n~/Library/Caches/ms-playwright/.../chrome-shell' }),
    // 各工具自己的配置位
    'reference-dotfiles.md': note('reference-dotfiles', { body: '~/.codex/AGENTS.md\n~/.dsh/AGENTS.md\n~/.cursor/hooks.json' }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.deepEqual(r.findings.filter((f) => f.code === 'path-conflict'), []);
});

test('description 高度相似 → info（宁可不报也不刷屏）', (t) => {
  const same = '代理节点的部署与回滚流程说明';
  const dir = makeStore({
    'reference-proxy-one.md': note('reference-proxy-one', { description: same }),
    'reference-proxy-two.md': note('reference-proxy-two', { description: same }),
    'reference-unrelated.md': note('reference-unrelated', { description: '完全不同的主题：字体抗锯齿' }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  const dup = r.findings.filter((f) => f.code === 'duplicate-topic');
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].files.sort(), ['reference-proxy-one.md', 'reference-proxy-two.md']);
});

test('两篇都没有 description 的裸 md 不算重复（undefined 字符串化成 token 会算出 1.00）', (t) => {
  const bare = '# 标题\n\n正文内容\n';
  const dir = makeStore({ 'reference-bare-one.md': bare, 'reference-bare-two.md': bare });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = auditStore(dir, { now: NOW });
  assert.deepEqual(r.findings.filter((f) => f.code === 'duplicate-topic'), []);
  assert.equal(r.findings.filter((f) => f.code === 'missing-description').length, 2);
});

test('库读不到时返回 error 而不是崩溃', () => {
  const r = auditStore('/nonexistent/engramory-store-xyz', { now: NOW });
  assert.equal(r.summary.notes, 0);
  assert.equal(r.findings[0].code, 'store-unreadable');
});

test('normalizePath 与 parseFrontmatter 的基本契约', () => {
  assert.equal(normalizePath('~/x/y'), `${homedir()}/x/y`);
  assert.equal(normalizePath('/a//b/'), '/a/b');
  assert.equal(normalizePath('~/x/y,'), `${homedir()}/x/y`);
  const { fields, body } = parseFrontmatter(note('reference-x', { description: 'D' }));
  assert.equal(fields.name, 'reference-x');
  assert.equal(fields.type, 'reference');
  assert.ok(body.includes('正文内容'));
  assert.deepEqual(parseFrontmatter('没有 frontmatter').fields, {});
});

test('archive-suggestion：长文与追加式日志会得到拆分建议，普通笔记不会', () => {
  // 正例一：32 个「第 N 批」式的追加日志（中文数字），体积也大
  const logBody = Array.from(
    { length: 22 },
    (_, i) => `## 第${['一','二','三','四','五','六','七','八','九','十'][i % 10]}批：第 ${i} 次上线（2026-10-0${(i % 9) + 1}）\n\n做了些事情。`,
  ).join('\n\n');
  const giant = note('project-giant-log', { type: 'project', body: logBody });
  const small = note('reference-small-note', { body: '## 只有一个章节\n\n很短。' });
  const dir = makeStore({ 'project-giant-log.md': giant, 'reference-small-note.md': small });

  const { findings } = auditStore(dir, { now: NOW });
  const hits = findings.filter((f) => f.code === 'archive-suggestion');
  assert.equal(hits.length, 1, '只有长文那条该被建议拆分');
  assert.deepEqual(hits[0].files, ['project-giant-log.md']);
  assert.equal(hits[0].severity, 'info');
  assert.ok(hits[0].message.includes('22 个「第 N 批」式追加日志'), `应报出可搬走的批次个数：${hits[0].message}`);
  assert.ok(hits[0].message.includes('搬完正文只剩'), `应说清归档能把它降到多少：${hits[0].message}`);
  // 体检的建议必须和归档器真能做的事一致 —— 否则用户点「执行」才发现搬不动
  assert.ok(hits[0].message.includes('面板「记忆 → 归档」'), `应指路到能一键执行的地方：${hits[0].message}`);
  assert.ok(!findings.some((f) => f.code === 'archive-suggestion' && f.files.includes('reference-small-note.md')));

  rmSync(dir, { recursive: true, force: true });
});

test('archive-suggestion：搬完仍超上限的，要直说「拆不动，得按主题拆」', () => {
  // 正文本身就 120KB、批次只占一点点：归档救不了它，闸门也会正确地拒绝这次写入。
  // 这种时候体检不能给一句「建议归档」就完事 —— 那是在指一条走不通的路。
  const fat = '正文'.repeat(30000); // 每个汉字 3 字节 → 约 180KB
  const body = `${fat}\n\n## 第一批：一点日志\n\n很短。\n\n## 第二批：又一点\n\n也很短。`;
  const giant = note('project-fat-body', { type: 'project', body });
  const dir = makeStore({ 'project-fat-body.md': giant });

  const { findings } = auditStore(dir, { now: NOW });
  const hit = findings.find((f) => f.code === 'archive-suggestion');
  assert.ok(hit, '该给出建议');
  assert.match(hit.message, /得按主题拆成多篇/, `超限时要说清归档解决不了：${hit.message}`);
  assert.doesNotMatch(hit.message, /一键执行/, '搬不动就不能指路去点「执行」');

  rmSync(dir, { recursive: true, force: true });
});

// ── 读侧上限：召回读不到的东西，只有体检看得见 ────────────────────────
// store.js 的 `MAX_NOTES`（2000 篇）与 `MAX_BYTES`（4MB）是召回一次能读的上限，
// 超出的笔记**不会进检索**。这两条以前是静默的（2026-10-17 复查确认全仓没有报告点），
// 所以体检里补了这两条告警 —— 它们是唯一能看见「整库」的地方。

test('读侧上限：库里篇数超过 maxNotes → notes-over-cap，并说得出丢了几篇', (t) => {
  const notes = {};
  for (let i = 0; i < 6; i += 1) notes[`reference-n${i}.md`] = note(`reference-n${i}`);
  const dir = makeStore(notes);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = auditStore(dir, { now: NOW, maxNotes: 3, maxBytes: DEFAULT_MAX_BYTES });
  const cap = r.findings.find((f) => f.code === 'notes-over-cap');
  assert.ok(cap, '必须报出来');
  assert.equal(cap.severity, 'warn');
  assert.match(cap.message, /库里有 6 篇/);
  assert.match(cap.message, /只读前 3 篇/);
  assert.match(cap.message, /另外 3 篇不会被检索到/);
  assert.match(cap.message, /maxNotes/, '要给出可操作的那一行（改哪个配置）');
});

test('读侧上限：总字节超过 maxBytes → store-over-byte-cap', (t) => {
  const dir = makeStore({
    'reference-a.md': note('reference-a', { body: 'x'.repeat(3000) }),
    'reference-b.md': note('reference-b', { body: 'y'.repeat(3000) }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = auditStore(dir, { now: NOW, maxBytes: 4000 });
  const cap = r.findings.find((f) => f.code === 'store-over-byte-cap');
  assert.ok(cap, '必须报出来');
  assert.equal(cap.severity, 'warn');
  assert.match(cap.message, /KB/);
  assert.match(cap.message, /maxBytes/);
});

test('读侧上限：没到顶时两条告警都不出现（默认库不许误报）', (t) => {
  const dir = makeStore({ 'reference-a.md': note('reference-a'), 'reference-b.md': note('reference-b') });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = auditStore(dir, { now: NOW });
  assert.equal(has(r, 'notes-over-cap'), false);
  assert.equal(has(r, 'store-over-byte-cap'), false);
});
