// archive.js —— 确定性分层归档（对标 dsh-mneme 的 phaseDemotion，但换了形态）
//
// mneme 敢自动归档，是因为它的 SQLite 才是真相源、markdown 只是可重建的投影；
// 我们 markdown 就是主存储，所以不能截断、不能删、不能改写正文语义。
//
// 这里做的替代方案：**物理分层**。把追加式日志章节（「## 第 N 批：…」）整段搬到一个
// 单独的 <slug>-history.md 里，主文件只留结论与现状 + 一行指针。
//
// 为什么这不损失信息：
//   1. 历史章节原文一字不动，只是换了文件；
//   2. 拆出去的文件仍在同一个库目录、仍会被 readDocs 索引、仍能被召回；
//   3. 拆之前两个文件都备份到 <store>/.archive-backup/<时间戳>/（只读备份，不参与检索）。
//
// 判据全是确定性的、可核对的：体积、章节数、批次章节数。没有任何模型参与。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMemoryWrite } from './guard.js';

export const ARCHIVE_BYTES = 64 * 1024;
export const ARCHIVE_SECTIONS = 20;
export const MIN_BATCHES = 3;
export const BACKUP_DIR = '.archive-backup';
export const HISTORY_SUFFIX = '-history';
export const INDEX_FILE = 'MEMORY.md';
// 归档文件同样要过写入闸门，而闸门的单篇上限是 100KB。留 10KB 余量，
// 超了就分成 <slug>-history-2.md、-history-3.md……（不是放宽闸门）
export const HISTORY_MAX_BYTES = 90 * 1024;

/** 「## 第二十七批：…」这种追加式日志标题（数字位同时认中文与阿拉伯数字） */
// 真实库里的写法是「## 第二十七批：…」（汉字数字、不空格），但书写习惯不该决定
// 归档能不能认出它 —— 认不出就等于静默不归档，跟 doctor.js 那个只认 macOS 路径的
// 正则是一类毛病。所以数字两侧的空格一律容忍。
// 尾部必须落在「：」/空白/行尾/全角括号上：否则「## 第一批次」这种普通章节会被误搬。
// 深度也容忍：#/###/#### 都算 —— 真实库里就有一条「### 第三十八批」，
// 只认 `##` 的话它会连同内容一起被留在主文件里，主文件就永远压不到上限以下。
export const BATCH_RE = /^#{2,6}\s*第\s*[〇零一二三四五六七八九十百两\d]+\s*批(?=\s|[:：]|$|[（(])/;

/**
 * 「**2026-10-10 第二批：SEO/订阅 + 写作体验**」这种**加粗整行**当标题的批次。
 *
 * 真有这种写法：`project-by-yffto-cicd.md` 里前 14 批全是加粗行、后 32 批才是
 * `##`。只认 `##` 的代价是那 14 批（116KB）对归档完全隐形 —— 于是「搬走批次后
 * 主文件仍超 100KB」，闸门正确拒绝，归档永远做不成。这是同一类毛病的第三次：
 * **判据比数据窄，失效时不报错，只是悄悄什么都不做**。
 *
 * 只认「整行以 ** 开头且第一个加粗段里就有『第N批』」，所以
 * 「**本地验收的可复用姿势（第三批实测）**」这类小标题不会被误搬。
 */
export const BOLD_BATCH_RE = /^\*\*[^*]*第\s*[〇零一二三四五六七八九十百两\d]+\s*批(?=\s|[:：]|$|[（(])/;

/**
 * 归档文件自己的名字（<slug>-history.md / <slug>-history-2.md …）。
 * planArchive 必须跳过它们：归档文件同样够大、同样满是批次段，
 * 不排除的话归档器会去归档自己的归档，一轮套一轮。
 */
export const HISTORY_FILE_RE = /-history(?:-\d+)?\.md$/;

const HEADING_RE = /^##\s/;

/** 加粗行当标题时，去掉那一对 `**`（行尾可能还有 `**（commit …）` 之类的尾巴）。 */
const boldTitle = (line) => line.replace(/^\*\*/, '').replace('**', '').trim();

/** 解析 frontmatter，返回 { fields, body }；没有合法头部时 fields 为空对象 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

/**
 * 把正文切成三段：head（第一个批次章节之前）、batches（所有「第 N 批」章节）、
 * tail（最后一个批次章节之后的非批次章节）。
 * 非批次章节一律留在原位（head/tail），只有批次章节会被搬走。
 */
export function splitBatches(body) {
  const lines = String(body ?? '').split('\n');
  const head = [];
  const tail = [];
  const batches = [];
  let cur = null;
  let seenBatch = false;
  for (const line of lines) {
    // 加粗整行的批次先判：它不是 markdown 标题，不参与 head/tail 的章节切分，
    // 但和 `## 第N批` 一样是「该搬走的历史」。
    if (BOLD_BATCH_RE.test(line)) {
      seenBatch = true;
      cur = { title: boldTitle(line), lines: [line] };
      batches.push(cur);
      continue;
    }
    // 批次标题要在普通标题之前判：批次可以是 ### 深度，而普通章节切分只认 `##`，
    // 这样 `### 某个子标题` 会老老实实留在它所属的那一批里。
    if (BATCH_RE.test(line)) {
      seenBatch = true;
      cur = { title: line.replace(/^#+\s*/, '').trim(), lines: [line] };
      batches.push(cur);
      continue;
    }
    if (HEADING_RE.test(line)) {
      cur = null;
    }
    if (cur) cur.lines.push(line);
    else if (seenBatch) tail.push(line);
    else head.push(line);
  }
  return {
    head: head.join('\n').trimEnd(),
    tail: tail.join('\n').trimEnd(),
    batches: batches.map((b) => ({ title: b.title, text: b.lines.join('\n').trimEnd() })),
  };
}

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

/**
 * 把批次按体积分组，每组不超过 limit。分组只影响文件边界，不改动任何一段原文。
 * 之所以要分组：归档文件也要过写入闸门的 100KB 单篇上限。
 */
export function groupBatches(batches, limit = HISTORY_MAX_BYTES) {
  const groups = [];
  let cur = { items: [], bytes: 0 };
  for (const b of batches) {
    const n = bytesOf(b.text) + 2; // +2 是 join('\n\n') 的分隔
    if (cur.items.length && cur.bytes + n > limit) {
      groups.push(cur);
      cur = { items: [], bytes: 0 };
    }
    cur.items.push(b);
    cur.bytes += n;
  }
  if (cur.items.length) groups.push(cur);
  return groups;
}

/** 单组时用 <slug>-history.md，多组时是 -history.md / -history-2.md / … */
export function historyFileName(slug, index) {
  return index === 0 ? `${slug}${HISTORY_SUFFIX}.md` : `${slug}${HISTORY_SUFFIX}-${index + 1}.md`;
}

/**
 * 从任意笔记名取「基础 slug」：`x.md` 与 `x-history-2.md` 都归到 `x`。
 *
 * 为什么需要它：归档产物自己也会长大（真实库里 `-history-2.md` 已经 92KB，紧贴闸门
 * 100KB），所以它必须能被**再归档一次**。但如果直接拿文件名当 slug，产物会叫
 * `x-history-2-history.md` —— 编号既丑陋又会与既有序列脱节。归一化之后，第二层
 * 归档接着同一个编号往下排（`x-history-5.md`），扫库时也还能一眼看出它们是同族。
 */
export function baseSlug(file) {
  return String(file).replace(/\.md$/, '').replace(/-history(?:-\d+)?$/, '');
}

/**
 * 某一篇的归档门槛（字节）。
 *
 * 主文件按 `ARCHIVE_BYTES`（64KB）；归档产物按 `HISTORY_MAX_BYTES`（90KB）—— 理由见
 * `planArchive` 里的注释：它已经是纯日志，拆它只为留出闸门余量。
 *
 * ★ 这是**导出给体检用的**：`doctor.js` 以前自己抄了一份 `ARCHIVE_BYTES`，于是出现
 * 「体检说这篇 89KB 可以搬走、点执行却什么都不发生」—— 判据一分为二，早晚漂移。
 * 一个概念只能有一处定义。
 */
export function archiveBar(file, options = {}) {
  const minBytes = options.minBytes ?? ARCHIVE_BYTES;
  if (!HISTORY_FILE_RE.test(String(file))) return minBytes;
  return Math.max(minBytes, options.historyMinBytes ?? HISTORY_MAX_BYTES);
}

/**
 * 归档文件自己的抬头开销（frontmatter + 标题 + 一行导语）。
 *
 * 为什么必须扣掉：`groupBatches` 只累加**批次正文**，而真正落盘的文件还带着这一段。
 * 这正是真实库里出现 92406 字节（> HISTORY_MAX_BYTES 92160）的原因 —— 判据比事实窄了
 * 一个抬头。凡是「估算写入体积」的地方都得把框架算进去，否则闸门会在最后一刻拒绝。
 */
export function historyOverhead(fields, file, slug) {
  return bytesOf(renderHistory(fields, file, slug, [], '')) + 1;
}

/**
 * 扫描库，产出归档计划（纯读，不写任何文件）。
 * 返回 { plans, skipped }：
 *   plans   —— 够大且有 ≥ MIN_BATCHES 个批次章节的笔记，附拆分后的体积预估
 *   skipped —— 够大但没有可拆批次段的笔记（附原因，面板上要能解释为什么不动它）
 */
export function planArchive(storePath, options = {}) {
  const minBytes = options.minBytes ?? ARCHIVE_BYTES;
  const minSections = options.minSections ?? ARCHIVE_SECTIONS;
  const minBatches = options.minBatches ?? MIN_BATCHES;
  const plans = [];
  const skipped = [];
  if (!storePath || !existsSync(storePath)) return { plans, skipped };

  let files = [];
  try {
    // 归档产物（`-history*.md`）**同样在扫描范围内**：它们也会长大，而它们没有别的地方
    // 可以去。早先为了躲开「归档器归档自己的归档」而把它们排除在外，代价是那一层永远
    // 不会被收缩 —— 闸门会在某天以「写入被拒」的形式把它暴露出来，而不是慢慢变慢。
    files = readdirSync(storePath).filter((f) => f.endsWith('.md') && f !== INDEX_FILE);
  } catch {
    return { plans, skipped };
  }

  for (const file of files.sort()) {
    // ★ 归档产物自己也有门槛，而且更高。
    // 主文件 64KB 就拆，是因为长文会在召回里霸榜（章节切桶 + 长度归一治不完全）；
    // 而 `-history*.md` 是**纯日志**，拆它只有一个目的：别顶到闸门的 100KB 上限。
    // 拿 64KB 去卡它，就会把一份刚生成的归档立刻再劈成两半 —— 文件数变多、召回排序
    // 一点没变好，纯粹是折腾。所以 history 文件的线设在 `HISTORY_MAX_BYTES`。
    const bar = archiveBar(file, options);

    let text = '';
    try {
      text = readFileSync(join(storePath, file), 'utf8');
    } catch {
      continue;
    }
    const bytes = bytesOf(text);
    const sections = (text.match(/^## /gm) || []).length;
    // 两条判据是**或**的关系：足够大，或者章节多到已经不像一篇笔记（追加式日志的形态）。
    // 别把它改成「体积硬门槛」—— 那会让一份 22 个批次、体积却只 1KB 的日志永远不算数，
    // 而它恰恰是最该被拆的那种：正文被日志淹没，召回时又长又散。
    if (bytes <= bar && sections <= minSections) continue;

    const { fields, body } = parseFrontmatter(text);
    const { head, tail, batches } = splitBatches(body);
    if (batches.length < minBatches) {
      skipped.push({
        file,
        bytes,
        sections,
        batches: batches.length,
        reason: bytes > minBytes
          ? `正文 ${Math.round(bytes / 1024)}KB 但没有「第 N 批」式追加日志段（只有 ${batches.length} 个），拆不出可搬的历史块`
          : `「##」章节 ${sections} 个但没有「第 N 批」式追加日志段（只有 ${batches.length} 个）`,
      });
      continue;
    }

    const slug = baseSlug(file);

    // 已经归档过的批次标题（可能已有多份 -history.md / -history-2.md …），用于去重。
    // ★ 但**要跳过自己**：当归档源本身就是一个 `-history-N.md` 时，它里面的标题按定义
    // 就是「已归档」的，若不排除，fresh 会永远是空的 —— 这层文件于是谁都动不了，
    // 静默地卡在闸门门口。
    const existingTitles = new Set();
    let existingCount = 0;
    for (let i = 0; i < 100; i += 1) {
      const hf = historyFileName(slug, i);
      const hp = join(storePath, hf);
      if (!existsSync(hp)) break;
      existingCount += 1;
      if (hf === file) continue;
      for (const line of readFileSync(hp, 'utf8').match(/^## .*/gm) ?? []) {
        existingTitles.add(line.replace(/^##\s*/, '').trim());
      }
    }
    const fresh = batches.filter((b) => !existingTitles.has(b.title));
    if (!fresh.length) continue; // 这一篇的批次都已经归档过了

    // 按体积分组：归档文件同样要过写入闸门的 100KB 单篇上限，超了就写第二份。
    // 上限要先把抬头开销扣掉，否则估算总是偏乐观（真实库里就写出过 92406 字节的文件）。
    const limit = Math.max(1024, (options.historyMaxBytes ?? HISTORY_MAX_BYTES) - historyOverhead(fields, file, slug));
    const groups = groupBatches(fresh, limit);
    const historyFiles = groups.map((g, i) => ({
      file: historyFileName(slug, existingCount + i),
      batchCount: g.items.length,
      bytes: g.bytes,
    }));
    const pointer = historyPointer(historyFiles, batches.length);
    const keptBody = [head, tail, pointer].filter(Boolean).join('\n\n');
    const newMainBytes = bytesOf(renderWithFields(text, fields, keptBody));

    plans.push({
      file,
      bytes,
      sections,
      batchCount: batches.length,
      freshCount: fresh.length,
      historyFiles,
      existingCount,
      movedBytes: groups.reduce((n, g) => n + g.bytes, 0),
      keptBytes: newMainBytes,
      savedBytes: bytes - newMainBytes,
    });
  }
  return { plans, skipped };
}

function historyPointer(historyFiles, count) {
  const today = new Date().toISOString().slice(0, 10);
  const list = historyFiles
    .map((h) => `[\`${h.file}\`](${h.file})${historyFiles.length > 1 ? `（${h.batchCount} 批）` : ''}`)
    .join('、');
  return [
    `## 历史批次`,
    ``,
    `${today} 前的 ${count} 个「第 N 批」追加日志已归档到 ${list}（同一记忆库，照样参与召回）。`,
    `本节只留结论与现状；要查某次改动的时间线，读这些归档。`,
  ].join('\n');
}

/** 用新的 body 重建全文（保留原 frontmatter 字段顺序，updated 换成当天） */
function renderWithFields(originalText, fields, newBody) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(originalText);
  if (!m) return `${newBody}\n`;
  const today = new Date().toISOString().slice(0, 10);
  const lines = m[1].split(/\r?\n/).map((line) => {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (kv && kv[1] === 'updated') return `updated: ${today}`;
    return line;
  });
  return `---\n${lines.join('\n')}\n---\n\n${newBody}\n`;
}

function renderHistory(fields, file, slug, chunks, existingText) {
  const today = new Date().toISOString().slice(0, 10);
  const kind = fields.type ?? file.split('-')[0];
  const header = existingText
    ? existingText.trimEnd()
    : [
        '---',
        `name: ${slug}`,
        `description: ${fields.name ?? file} 的历史批次归档：按时间顺序保留每一次改动的原文；结论与现状见 ${file}`,
        `type: ${kind}`,
        `scope: ${fields.scope ?? 'global'}`,
        `created: ${fields.created ?? today}`,
        `updated: ${today}`,
        '---',
        '',
        `# ${fields.name ?? slug}：历史批次归档`,
        '',
        `正文在 [\`${file}\`](${file})；这里是它的追加式日志原样搬家，一条没删。`,
      ].join('\n');
  return `${header}\n\n${chunks.map((c) => c.text).join('\n\n')}\n`;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * 执行一个归档计划。两段式的第二段（第一段是 planArchive 的只读预览）。
 *
 * 顺序刻意如此：先过写入闸门 → 再备份 → 最后才动文件。任何一步失败都不会留下半成品。
 * 返回 { ok, file, historyFiles, backupDir, moved, keptBytes, movedBytes } 或 { ok:false, reason }。
 */
export function applyArchive(storePath, plan, options = {}) {
  if (!storePath || !plan || !plan.file) return { ok: false, reason: '归档计划不完整' };
  const mainPath = join(storePath, plan.file);
  if (!existsSync(mainPath)) return { ok: false, reason: `找不到 ${plan.file}` };

  const mainText = readFileSync(mainPath, 'utf8');
  const { fields, body } = parseFrontmatter(mainText);
  const { head, tail, batches } = splitBatches(body);
  if (!batches.length) return { ok: false, reason: `${plan.file} 里已经没有可搬的批次章节` };

  // 与 planArchive 用同一套判据：已归档标题去重 + 已存在的归档文件计数
  const slug = baseSlug(plan.file);
  const existingTitles = new Set();
  const existingFiles = [];
  for (let i = 0; i < 100; i += 1) {
    const hf = historyFileName(slug, i);
    const hp = join(storePath, hf);
    if (!existsSync(hp)) break;
    const text = readFileSync(hp, 'utf8');
    existingFiles.push({ file: hf, text });
    // 跳过自己：归档源本身就是 `-history-N.md` 时，它自己的标题正是要搬走的东西
    if (hf === plan.file) continue;
    for (const line of text.match(/^## .*/gm) ?? []) existingTitles.add(line.replace(/^##\s*/, '').trim());
  }
  const fresh = batches.filter((b) => !existingTitles.has(b.title));
  if (!fresh.length) return { ok: false, reason: `${plan.file} 的批次章节都已归档过` };

  const bodyLimit = Math.max(1024, (options.historyMaxBytes ?? HISTORY_MAX_BYTES) - historyOverhead(fields, plan.file, slug));
  const groups = groupBatches(fresh, bodyLimit);
  const writes = groups.map((g, i) => {
    const file = historyFileName(slug, existingFiles.length + i);
    return {
      file,
      path: join(storePath, file),
      batchCount: g.items.length,
      text: renderHistory(fields, plan.file, file.replace(/\.md$/, ''), g.items, ''),
    };
  });
  const pointer = historyPointer(
    writes.map((w) => ({ file: w.file, batchCount: w.batchCount })),
    batches.length,
  );
  const keptBody = [head.trimEnd(), tail.trimEnd(), pointer].filter(Boolean).join('\n\n');
  const mainNewText = renderWithFields(mainText, fields, keptBody);

  // ① 过闸门（编译者不得自证：写入的合法性由 guard 判，不由调用方自称）
  for (const [p, c] of [[mainPath, mainNewText], ...writes.map((w) => [w.path, w.text])]) {
    const verdict = checkMemoryWrite({ filePath: p, storePath, content: c });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, file: plan.file };
  }

  // ② 备份原件（只读快照，不进检索：readDocs 只扫库根目录，不递归）
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const backupDir = join(storePath, BACKUP_DIR, stamp);
  try {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, plan.file), mainText, 'utf8');
    for (const ef of existingFiles) writeFileSync(join(backupDir, ef.file), ef.text, 'utf8');
  } catch (err) {
    return { ok: false, reason: `备份失败，未改动文件：${err.message}`, file: plan.file };
  }

  // ③ 先写归档、后改主文件 —— 万一中断，主文件仍是完整的旧版
  try {
    for (const w of writes) writeAtomic(w.path, w.text);
    writeAtomic(mainPath, mainNewText);
  } catch (err) {
    return { ok: false, reason: `写入失败（原件已备份在 ${backupDir}）：${err.message}`, file: plan.file, backupDir };
  }

  return {
    ok: true,
    file: plan.file,
    historyFiles: writes.map((w) => w.file),
    backupDir,
    moved: fresh.length,
    keptBytes: bytesOf(mainNewText),
    movedBytes: writes.reduce((n, w) => n + bytesOf(w.text), 0),
    savedBytes: bytesOf(mainText) - bytesOf(mainNewText),
  };
}

/** 批量执行：对 planArchive 的结果逐个 apply，任一失败即停（不做部分成功） */
export function applyArchiveAll(storePath, plans, options = {}) {
  const results = [];
  for (const plan of plans) {
    const r = applyArchive(storePath, plan, options);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}
