// doctor.js 的测试：每条检查项各一个正例 + 误报防线各一个反例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { auditStore, normalizePath, parseFrontmatter } from '../doctor.js';

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

test('笔记没进索引 → warn（召回时看不见它）', (t) => {
  const dir = makeStore({ 'reference-hello-world.md': note('reference-hello-world') }, '- 空索引\n');
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
      body: `旧：${homedir()}/Documents/Meitu/my-tool\n新：${homedir()}/yffto/my-tool`,
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
      body: '旧：/home/runner/Documents/Meitu/my-tool\n新：/home/runner/yffto/my-tool',
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
    'reference-same.md': note('reference-same', { body: 'A: ~/yffto/proj-x\nB: ' + homedir() + '/yffto/proj-x' }),
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
  assert.ok(hits[0].message.includes('22 个'), `应报出章节数：${hits[0].message}`);
  assert.ok(hits[0].message.includes('22 个是「第 N 批」'), `应识别中文数字批次：${hits[0].message}`);
  assert.ok(!findings.some((f) => f.code === 'archive-suggestion' && f.files.includes('reference-small-note.md')));

  rmSync(dir, { recursive: true, force: true });
});
