import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_BYTES,
  BACKUP_DIR,
  HISTORY_MAX_BYTES,
  HISTORY_SUFFIX,
  applyArchive,
  applyArchiveAll,
  groupBatches,
  historyFileName,
  parseFrontmatter,
  planArchive,
  splitBatches,
} from '../archive.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function makeStore(files) {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-archive-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}

/**
 * 造一篇带 N 个「第 K 批」章节的大笔记。
 * pad 的单位是**字符**，而汉字是 3 字节 —— pad: 5000 ≈ 15KB/批，
 * 5 批加正文约 90KB：越过 64KB 的归档线，又刚好装得进一份 90KB 的归档文件。
 */
function bigNote({ name = 'project-demo', batches = 5, pad = 5000, type = 'project', withNonBatchTail = false } = {}) {
  const fm = [
    '---',
    `name: ${name}`,
    'description: 演示用的项目笔记',
    `type: ${type}`,
    'scope: global',
    'created: 2026-09-01',
    'updated: 2026-10-01',
    '---',
    '',
    '# 演示项目',
    '',
    '## 结论',
    '',
    '现状：一切正常。'.padEnd(pad, '正'),
    '',
  ].join('\n');
  const body = [];
  for (let i = 0; i < batches; i += 1) {
    body.push(
      `## 第${CN[i] ?? i + 1}批：第 ${i + 1} 次改动（2026-0${(i % 9) + 1}-15，build${1000 + i}）`,
      '',
      `本次改动内容第 ${i + 1} 段。`.padEnd(pad, '改'),
      '',
    );
  }
  if (withNonBatchTail) body.push('## 附录', '', '这段是非批次章节，必须留在主文件里。', '');
  return `${fm}${body.join('\n')}`;
}

/** 把 Note N 批次追加进主文件（模拟又攒了几轮日志） */
function appendBatches(dir, file, nums, pad = 5000) {
  const main = readFileSync(join(dir, file), 'utf8');
  const extra = nums
    .map((n) => `## 第${CN[0]}${n}批：新增 ${n}\n\n${`新批次 ${n} 的内容。`.padEnd(pad, '新')}\n`)
    .join('\n');
  writeFileSync(join(dir, file), `${main}\n${extra}`, 'utf8');
}

test('splitBatches：批次与非批次章节分开，非批次章节留在 head/tail', () => {
  const text = ['## 结论', '留在这里', '## 第一批：改了 A', '搬走 A', '## 第二批：改了 B', '搬走 B', '## 附录', '留在尾部'].join('\n');
  const { head, tail, batches } = splitBatches(text);
  assert.equal(batches.length, 2);
  assert.match(head, /## 结论/);
  assert.match(head, /留在这里/);
  assert.doesNotMatch(head, /搬走 A/);
  assert.match(tail, /## 附录/);
  assert.match(tail, /留在尾部/);
  assert.equal(batches[0].title, '第一批：改了 A');
  assert.match(batches[0].text, /搬走 A/);
});

test('splitBatches：数字两边的空格不影响识别（认不出就等于静默不归档）', () => {
  // 真实库里写的是「## 第二十七批：…」，但「## 第 3 批」同样表意明确。
  // 这里钉死的是「别让书写习惯决定功能是否生效」—— 与 doctor.js 那个
  // 只认 /Users 的前缀正则是同一类毛病：失效时不报错，只是悄悄什么都不做。
  for (const title of ['## 第 3 批：改了 X', '## 第3批：改了 X', '## 第三批：改了 X', '##  第 3 批：改了 X']) {
    const { batches, head } = splitBatches([ '## 结论', '留下', title, '搬走 X' ].join('\n'));
    assert.equal(batches.length, 1, `「${title}」应当被认成批次`);
    assert.equal(batches[0].title.split('：')[0].replace(/\s+/g, ''), title.replace(/^##\s*/, '').split('：')[0].replace(/\s+/g, ''));
    assert.doesNotMatch(head, /搬走 X/, `「${title}」的内容不该留在主文件里`);
  }
  // 但别宽到把普通章节也吃进去
  for (const notBatch of ['## 第三阶段：改了 X', '## 批次记录', '## 第一批次']) {
    const { batches } = splitBatches(['## 结论', '留下', notBatch, '内容'].join('\n'));
    assert.equal(batches.length, 0, `「${notBatch}」不是批次章节，不该被搬走`);
  }
});

test('groupBatches / historyFileName：按体积切组，命名带序号', () => {
  const mk = (n, size) => Array.from({ length: n }, (_, i) => ({ title: `批次 ${i}`, text: 'x'.repeat(size) }));
  assert.equal(groupBatches([], 1000).length, 0);
  assert.equal(groupBatches(mk(3, 100), 1000).length, 1, '装得下就是一组');
  assert.equal(groupBatches(mk(3, 600), 1000).length, 3, '放不下第二个就各自成组');
  assert.equal(historyFileName('project-demo', 0), 'project-demo-history.md');
  assert.equal(historyFileName('project-demo', 2), 'project-demo-history-3.md');
});

test('planArchive：够大且有批次段的出计划，够大但没有批次段的只跳过', () => {
  const many = Array.from({ length: 24 }, (_, i) => `## 章节 ${i + 1}\n\n${'内容'.repeat(2000)}`).join('\n\n');
  const dir = makeStore({
    'MEMORY.md': '# Memory Index\n',
    'project-demo.md': bigNote({ batches: 5 }),
    'reference-nonbatch.md': `---\nname: reference-nonbatch\ndescription: 无批次段的大文件\ntype: reference\nupdated: 2026-10-01\n---\n\n# 大文件\n\n${many}\n`,
    'reference-small.md': '---\nname: reference-small\ndescription: 小文件\ntype: reference\n---\n\n# 小的\n\n## 第一批：也会被无视\n',
  });
  const { plans, skipped } = planArchive(dir);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].file, 'project-demo.md');
  assert.equal(plans[0].batchCount, 5);
  assert.equal(plans[0].historyFiles.length, 1);
  assert.equal(plans[0].historyFiles[0].file, 'project-demo-history.md');
  assert.ok(plans[0].savedBytes > 0, '主文件应当变小');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].file, 'reference-nonbatch.md');
  assert.match(skipped[0].reason, /没有「第 N 批」式追加日志段/);
});

test('applyArchive：搬走批次、主文件留指针，且原文一字不丢', () => {
  const before = bigNote({ batches: 5, withNonBatchTail: true });
  const dir = makeStore({ 'project-demo.md': before });
  const [plan] = planArchive(dir).plans;
  const r = applyArchive(dir, plan, { now: NOW });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.moved, 5);

  const main = readFileSync(join(dir, 'project-demo.md'), 'utf8');
  const history = r.historyFiles.map((h) => readFileSync(join(dir, h), 'utf8')).join('\n');

  // 主文件：变小、留指针、留结论与非批次附录、不留批次正文
  assert.ok(Buffer.byteLength(main) < Buffer.byteLength(before));
  assert.match(main, /## 历史批次/);
  assert.match(main, /project-demo-history\.md/);
  assert.match(main, /现状：一切正常/);
  assert.match(main, /## 附录/);
  assert.doesNotMatch(main, /本次改动内容第 1 段/);
  assert.doesNotMatch(main, /^## 第[一二三四五]批/m);

  // 归档文件：批次原文一条不少，frontmatter 合法（能通过写入闸门）
  assert.match(history, /name: project-demo-history/);
  assert.match(history, /type: project/);
  for (let i = 1; i <= 5; i += 1) assert.match(history, new RegExp(`本次改动内容第 ${i} 段`));
  assert.match(history, /## 第三批：第 3 次改动/);
});

test('applyArchive：动文件之前先备份，原件完整可回滚', () => {
  const before = bigNote({ batches: 4 });
  const dir = makeStore({ 'project-demo.md': before });
  const [plan] = planArchive(dir).plans;
  const r = applyArchive(dir, plan, { now: NOW });
  assert.equal(r.ok, true, r.reason);
  assert.ok(existsSync(r.backupDir), '备份目录应当存在');
  assert.equal(readFileSync(join(r.backupDir, 'project-demo.md'), 'utf8'), before, '备份必须是逐字节原件');
});

test('applyArchive：幂等——同一篇再归档一次会被拒绝，不会重复搬运', () => {
  const dir = makeStore({ 'project-demo.md': bigNote({ batches: 5 }) });
  const [plan] = planArchive(dir).plans;
  assert.equal(applyArchive(dir, plan, { now: NOW }).ok, true);
  assert.deepEqual(planArchive(dir).plans, [], '归档完就不再出计划');
  const second = applyArchive(dir, plan, { now: NOW });
  assert.equal(second.ok, false);
  assert.match(second.reason, /已经没有可搬的批次章节/);
});

test('applyArchive：已有归档文件时写新的一份，旧归档原封不动', () => {
  const dir = makeStore({ 'project-demo.md': bigNote({ batches: 5 }) });
  const [plan] = planArchive(dir).plans;
  assert.equal(applyArchive(dir, plan, { now: NOW }).ok, true);
  const firstHistory = readFileSync(join(dir, 'project-demo-history.md'), 'utf8');

  // 主文件后来又追加了五批（老批次早被搬走），再归档一次
  appendBatches(dir, 'project-demo.md', [11, 12, 13, 14, 15]);
  const [plan2] = planArchive(dir).plans;
  assert.equal(plan2.historyFiles.length, 1);
  assert.equal(plan2.historyFiles[0].file, 'project-demo-history-2.md');
  const r2 = applyArchive(dir, plan2, { now: NOW });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.moved, 5);

  // 旧归档一字未动（既不覆盖也不追加），新批次进第二份
  assert.equal(readFileSync(join(dir, 'project-demo-history.md'), 'utf8'), firstHistory);
  const second = readFileSync(join(dir, 'project-demo-history-2.md'), 'utf8');
  assert.match(second, /新批次 11 的内容/);
  assert.match(second, /新批次 15 的内容/);
  assert.doesNotMatch(second, /本次改动内容第 1 段/, '旧批次不该被重抄一份');
});

test('分组：一份装不下 90KB 时分成多份，每份都过得了闸门的 100KB 上限', () => {
  const dir = makeStore({ 'project-demo.md': bigNote({ batches: 5, pad: 20000 }) });
  const [plan] = planArchive(dir).plans;
  assert.ok(plan.historyFiles.length >= 2, `应当分成多份，实际 ${plan.historyFiles.length}`);
  assert.equal(plan.historyFiles[0].file, 'project-demo-history.md');
  assert.equal(plan.historyFiles[1].file, 'project-demo-history-2.md');

  const r = applyArchive(dir, plan, { now: NOW });
  assert.equal(r.ok, true, r.reason);
  for (const h of r.historyFiles) {
    const size = Buffer.byteLength(readFileSync(join(dir, h), 'utf8'));
    assert.ok(size <= 100 * 1024, `${h} 是 ${size} 字节，超过写入闸门的 100KB 单篇上限`);
  }
  // 五批原文一段不少，且每段恰好出现一次
  const all = r.historyFiles.map((h) => readFileSync(join(dir, h), 'utf8')).join('\n');
  for (let i = 1; i <= 5; i += 1) {
    const hits = all.split(`本次改动内容第 ${i} 段`).length - 1;
    assert.equal(hits, 1, `第 ${i} 段应当恰好出现一次，实际 ${hits} 次`);
  }
});

test('planArchive：库不存在或没有可归档对象时安静返回空计划', () => {
  const empty = planArchive(join(tmpdir(), 'engramory-archive-does-not-exist'));
  assert.deepEqual(empty, { plans: [], skipped: [] });
  const dir = makeStore({ 'reference-tiny.md': '---\nname: reference-tiny\ndescription: 小\ntype: reference\n---\n\n# 小\n' });
  assert.deepEqual(planArchive(dir).plans, []);
});

test('applyArchiveAll：逐篇执行，结果与计划一一对应', () => {
  const dir = makeStore({
    'project-demo.md': bigNote({ name: 'project-demo', batches: 5 }),
    'reference-other.md': bigNote({ name: 'reference-other', batches: 5, type: 'reference' }),
  });
  const { plans } = planArchive(dir);
  assert.equal(plans.length, 2);
  const results = applyArchiveAll(dir, plans, { now: NOW });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok), results.map((r) => r.reason).join(' / '));
  for (const p of plans) for (const h of p.historyFiles) assert.ok(existsSync(join(dir, h.file)));
});

test('parseFrontmatter：能拿到字段，也能拿到正文', () => {
  const { fields, body } = parseFrontmatter('---\nname: x\ntype: reference\n---\n\n# 标题\n');
  assert.equal(fields.name, 'x');
  assert.equal(fields.type, 'reference');
  assert.match(body, /# 标题/);
});

test('归档文件名能通过写入闸门的命名规则（否则归档会被自己的闸门拦下）', () => {
  const dir = makeStore({ 'project-demo.md': bigNote({ batches: 5 }) });
  const [plan] = planArchive(dir).plans;
  assert.equal(plan.historyFiles[0].file, `project-demo${HISTORY_SUFFIX}.md`);
  assert.match(plan.historyFiles[0].file, /^project-[a-z0-9][a-z0-9-]*\.md$/);
  // 分组上限必须留在闸门的单篇上限（100KB）之内，否则归档会被自己的防线拒掉
  assert.ok(HISTORY_MAX_BYTES < 100 * 1024, '分组上限要小于闸门的 100KB');
  assert.ok(ARCHIVE_BYTES > 0 && ARCHIVE_BYTES < HISTORY_MAX_BYTES && BACKUP_DIR.startsWith('.'));
});

test('splitBatches：加粗整行的批次也要认（真实库前 14 批就是这种写法）', () => {
  // 这条测试的来源是一次真实失败：project-by-yffto-cicd.md 里，
  // 早期批次写成 `**2026-10-10 第二批：…**`，后期才改用 `## 。只认 `##` 时，
  // 那 116KB 历史对归档完全隐形 →「搬完批次主文件仍超 100KB」→ 闸门正确拒绝
  // → 归档永远做不成。判据比数据窄，失效时还不报错。
  const text = [
    '# 项目',
    '',
    '**目标**：这说明与现状，要留在主文件。',
    '',
    '**2026-10-10 第二批：SEO 与写作体验（提交 a922d3e）**',
    '',
    '第二批的正文，应该被搬走。',
    '',
    '**2026-10-10 第三批：导航精简**',
    '',
    '第三批的正文。',
    '',
    '## 第二十七批：改用 ## 之后',
    '',
    '第二十七批的正文。',
  ].join('\n');
  const { head, batches } = splitBatches(text);
  assert.equal(batches.length, 3, '两批加粗 + 一批 ## 都要认出来');
  assert.equal(batches[0].title, '2026-10-10 第二批：SEO 与写作体验（提交 a922d3e）');
  assert.equal(batches[1].title, '2026-10-10 第三批：导航精简');
  assert.equal(batches[2].title, '第二十七批：改用 ## 之后');
  assert.match(head, /这说明与现状，要留在主文件/);
  assert.doesNotMatch(head, /第二批的正文/);
  assert.doesNotMatch(head, /第三批的正文/);
  // 「**目标**：…」是个加粗小标题，不是批次，不能把结论也搬走
  assert.match(head, /\*\*目标\*\*/);
});

test('splitBatches：加粗批次认得出，但别把普通加粗小标题当批次', () => {
  for (const notBatch of [
    '**本地验收的可复用姿势（第三批实测）**',
    '**第三阶段：改了 X**',
    '**批次记录**',
  ]) {
    const { batches, head } = splitBatches(['# 项目', '', notBatch, '', '正文'].join('\n'));
    assert.equal(batches.length, 0, `「${notBatch}」不该被当成批次`);
    assert.match(head, /正文/, `「${notBatch}」下面的正文该留在主文件`);
  }
});

test('splitBatches：### 深度的批次同样认（真实库里就有一条）', () => {
  const text = [
    '# 项目',
    '结论留在主文件。',
    '### 第三十八批（2026-10-12）：次级页',
    '这一批的正文，要搬走。',
    '#### 批内的子标题',
    '子标题下还是这一批的内容，不能因为它是标题就被切出去。',
  ].join('\n');
  const { head, batches } = splitBatches(text);
  assert.equal(batches.length, 1, '### 深度的批次也要认');
  assert.equal(batches[0].title, '第三十八批（2026-10-12）：次级页');
  assert.match(batches[0].text, /这一批的正文/);
  assert.match(batches[0].text, /子标题下还是这一批的内容/, '批内子标题不该把它后面的内容切出去');
  assert.match(head, /结论留在主文件/);
  assert.doesNotMatch(head, /这一批的正文/);
});

// ── 第二层：归档产物自己也会长大 ──────────────────────────────────
// 真实事故背景：`project-by-yffto-cicd-history-2.md` 长到 92406 字节，而闸门单篇上限
// 是 100KB。归档产物本来被 planArchive 排除在外（为了躲开「归档器归档自己的归档」），
// 于是它**永远不会被收缩** —— 某天会以「写入被拒、归档失败」的形式炸出来，而不是
// 慢慢变慢。这组用例锁住修复的三件事：够大就拆、不够大别折腾、编号接着排。

test('第二层：归档产物顶到闸门门口时，它自己也会出计划', () => {
  // 3 批 × 20000 字（汉字 3 字节）≈ 180KB，远超 HISTORY_MAX_BYTES(90KB)
  const dir = makeStore({ 'project-demo-history.md': bigNote({ name: 'project-demo-history', batches: 3, pad: 20000 }) });
  try {
    const { plans } = planArchive(dir);
    assert.equal(plans.length, 1, `应该只盯上这一份归档产物，实际: ${plans.map((p) => p.file).join(',')}`);
    assert.equal(plans[0].file, 'project-demo-history.md');
    assert.equal(plans[0].freshCount, 3, '它自己的批次不能被当成「已归档过」而跳过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第二层：编号接着既有序列排，不会出现 -history-history', () => {
  const dir = makeStore({
    'project-demo.md': '# 演示\n\n## 结论\n\n现状正常。\n',
    'project-demo-history.md': bigNote({ name: 'project-demo-history', batches: 3, pad: 20000 }),
  });
  try {
    const { plans } = planArchive(dir);
    const plan = plans.find((p) => p.file === 'project-demo-history.md');
    assert.ok(plan, '归档产物应该出现在计划里');
    for (const h of plan.historyFiles) {
      assert.doesNotMatch(h.file, /-history-history/, `命名不该叠罗汉: ${h.file}`);
      assert.match(h.file, /^project-demo-history-\d+\.md$/, `应该接着编号排: ${h.file}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第二层：没到线的归档产物不动它（不为了拆分而拆分）', () => {
  // 5 批 × 5000 字 ≈ 75KB：超过主文件的 64KB 线，但没到归档产物的 90KB 线
  const dir = makeStore({ 'project-demo-history.md': bigNote({ name: 'project-demo-history', batches: 5, pad: 5000 }) });
  try {
    const { plans } = planArchive(dir);
    assert.equal(plans.length, 0, '归档产物是纯日志，拆它只为留出闸门余量，不该按 64KB 折腾');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第二层：落盘后的归档文件确实不超上限（抬头开销已计入）', () => {
  const dir = makeStore({
    'project-demo.md': '# 演示\n\n## 结论\n\n现状正常。\n',
    'project-demo-history.md': bigNote({ name: 'project-demo-history', batches: 3, pad: 20000 }),
  });
  try {
    // 先把 project-demo-history.md 本身撑到线上，再执行
    const plan = planArchive(dir).plans.find((p) => p.file === 'project-demo-history.md');
    const res = applyArchive(dir, plan, { now: NOW });
    assert.equal(res.ok, true, res.reason);
    for (const h of res.historyFiles) {
      const bytes = Buffer.byteLength(readFileSync(join(dir, h), 'utf8'), 'utf8');
      assert.ok(
        bytes <= HISTORY_MAX_BYTES,
        `${h} 落盘 ${bytes} 字节，超了 HISTORY_MAX_BYTES(${HISTORY_MAX_BYTES}) —— 抬头开销没算进去`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
