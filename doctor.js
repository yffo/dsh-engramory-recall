// 记忆库体检：结构一致性 + 纪律 + 可疑信号。纯静态、零出网、不改任何文件。
//
// 为什么不是"冲突检测"：实测过 1128 对笔记，正文相似度最高的 12 对全是四个**不同**项目
// （它们像是因为共用 project 模板措辞），description 最高才 0.273。纯词面测的是文体不是主题，
// 声称能自动发现语义矛盾就是骗人。这里只做**能判定**的事，剩下的一律标 info 交给人看。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tokenize } from './bm25.js';
// 「什么叫一批追加日志」只能有一处定义。这里曾经自己抄了一份 `^##\s*第…批`，
// 于是归档器已经认加粗行与 ### 深度了、体检还在报 32 批（真值是 46）——
// 同一个概念两套判据，迟早对不上。
import { splitBatches } from './archive.js';

export const NOTE_KINDS = ['user', 'feedback', 'project', 'reference'];
export const INDEX_FILE = 'MEMORY.md';
export const MAX_NOTE_BYTES = 100 * 1024;
export const STALE_TODO_DAYS = 30;
export const DUPLICATE_TOPIC_THRESHOLD = 0.5;

const NOTE_FILE_RE = new RegExp(`^(${NOTE_KINDS.join('|')})-[a-z0-9][a-z0-9-]*\\.md$`);
const TODO_RE = /待办|未完成|TODO|进行中|未做|待定|未闭环/;
/** 归档建议的两个阈值（超过任一即提示）：体积与「##」章节数。 */
const ARCHIVE_BYTES = 64 * 1024;
const ARCHIVE_SECTIONS = 20;
// 认 `~` 开头的路径，以及常见 home 前缀下的绝对路径。
// 这里曾写死成 `/Users/`（只认 macOS）—— 结果在 Linux 上整个 path-conflict 检查静默失效：
// 一条 finding 都不出，不报错、不告警，看起来像"没发现问题"。CI 上那个测试就是这么挂的。
// 现在把 macOS 的 /Users 与 Linux 的 /home、/root 一起认。
const ABS_PATH_RE = /(?:~|\/(?:Users|home|root)\/[A-Za-z0-9_.-]+)\/[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*/g;

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fields = {};
  if (!m) return { fields, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

/** `~/x` 与 `/Users/me/x` 是同一处，不规范化会报一堆假冲突。 */
export function normalizePath(path, home = homedir()) {
  let p = String(path).replace(/[.,;:)\]}"'`]+$/, '');
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1); // 尾斜杠不代表另一个位置
  return p;
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function auditStore(storePath, options = {}) {
  const now = options.now ?? Date.now();
  const staleDays = options.staleTodoDays ?? STALE_TODO_DAYS;
  const dupThreshold = options.duplicateTopicThreshold ?? DUPLICATE_TOPIC_THRESHOLD;
  const findings = [];
  const add = (severity, code, message, files = []) => findings.push({ severity, code, message, files });

  let entries;
  try {
    entries = readdirSync(storePath);
  } catch (err) {
    return {
      findings: [{ severity: 'error', code: 'store-unreadable', message: `读不到记忆库：${err.message}`, files: [] }],
      summary: { notes: 0, indexLines: 0, indexBytes: 0, bySeverity: { error: 1, warn: 0, info: 0 } },
    };
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  const indexText = mdFiles.includes(INDEX_FILE) ? readFileSync(join(storePath, INDEX_FILE), 'utf8') : '';

  const notes = [];
  for (const file of mdFiles.filter((f) => f !== INDEX_FILE)) {
    let text;
    try {
      if (!statSync(join(storePath, file)).isFile()) continue;
      text = readFileSync(join(storePath, file), 'utf8');
    } catch {
      continue;
    }
    const { fields, body } = parseFrontmatter(text);
    notes.push({ file, text, body, fields, bytes: Buffer.byteLength(text) });
  }

  // ---- 索引 ↔ 文件 ----
  const pointers = [...indexText.matchAll(/\]\(([^)]+?\.md)\)/g)].map((m) => m[1]);
  const uniquePointers = new Set(pointers);
  for (const p of uniquePointers) {
    if (!mdFiles.includes(p)) add('error', 'index-missing-file', `索引指向的笔记不存在：${p}`, [p]);
  }
  const unreferenced = [];
  for (const n of notes) {
    // 「孤儿」原来的判据是「没出现在 MEMORY.md 里」，太严了：归档产生的
    // `xxx-history.md` 按设计**不写进索引**（索引由另一套守卫管，且归档是机械派生），
    // 但主笔记末尾的「## 历史批次」有链接指向它 —— 那就是**可达**的。
    // 判据改成真正的可达性：从索引出发，沿笔记里的 markdown 链接走（可多跳）。
    if (!uniquePointers.has(n.file)) unreferenced.push(n);
  }
  // 可达性闭包：先把索引直接指到的笔记入队，再顺着它们正文里的链接扩散。
  const outLinks = new Map();
  for (const n of notes) {
    outLinks.set(n.file, [...n.text.matchAll(/\]\(([^)]+?\.md)\)/g)].map((m) => m[1]));
  }
  const reachable = new Set();
  const queue = [...uniquePointers].filter((p) => mdFiles.includes(p));
  while (queue.length) {
    const f = queue.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const next of outLinks.get(f) ?? []) if (mdFiles.includes(next)) queue.push(next);
  }
  for (const n of unreferenced) {
    // 只有连链接都走不到，才真是孤儿 —— 这种笔记模型读索引时永远发现不了。
    if (!reachable.has(n.file)) {
      add('warn', 'orphan-note', `笔记既没进索引、也没有任何笔记链接它：${n.file}`, [n.file]);
    }
  }
  const seen = new Set();
  for (const p of pointers) {
    if (seen.has(p)) add('info', 'index-duplicate', `索引里同一篇被引用多次：${p}`, [p]);
    seen.add(p);
  }

  // ---- 单篇自身 ----
  for (const n of notes) {
    const slug = n.file.replace(/\.md$/, '');
    if (!NOTE_FILE_RE.test(n.file)) add('warn', 'bad-filename', `文件名不符合「<四类事实>-<小写slug>.md」：${n.file}`, [n.file]);
    if (n.fields.name && n.fields.name !== slug) add('warn', 'name-mismatch', `frontmatter name 与文件名不一致：${n.fields.name} ≠ ${slug}`, [n.file]);
    const prefix = n.file.split('-')[0];
    if (n.fields.type && NOTE_KINDS.includes(prefix) && n.fields.type !== prefix) {
      add('warn', 'type-mismatch', `type 与前缀不符：type=${n.fields.type} 但文件名是 ${prefix}-`, [n.file]);
    }
    if (!n.fields.description) add('warn', 'missing-description', `缺 description（召回全靠它）：${n.file}`, [n.file]);
    if (n.bytes > MAX_NOTE_BYTES) add('warn', 'oversize-note', `单篇 ${(n.bytes / 1024).toFixed(0)}KB，超过 ${MAX_NOTE_BYTES / 1024}KB：${n.file}`, [n.file]);

    // 归档建议 —— 对标 dsh-mneme 的 `phaseDemotion`（超期归档 / 降级为截断摘要 / 原库存
    // `_full_content`），但在我们这里**只报告、绝不动用户的笔记**：笔记是 Markdown 主存储，
    // 自动改写等于替用户删资料。判据是可核对的：体积，以及「## 第 N 批」这类追加式日志章节数。
    const sections = (n.body.match(/^## /gm) || []).length;
    // 与归档器同一套判据（认中文数字、认加粗整行、认 ### 深度）—— 否则体检说的
    // 「可归档」和归档器真能搬走的不是一回事，用户点「执行」才发现搬不动。
    const { batches: batchList } = splitBatches(n.body);
    const movableBytes = batchList.reduce((sum, b) => sum + Buffer.byteLength(b.text, 'utf8'), 0);
    const keptBytes = n.bytes - movableBytes;
    if (n.bytes > ARCHIVE_BYTES || sections > ARCHIVE_SECTIONS) {
      const kb = (v) => `${(v / 1024).toFixed(0)}KB`;
      add(
        'info',
        'archive-suggestion',
        batchList.length
          ? keptBytes > MAX_NOTE_BYTES
            ? `这篇 ${kb(n.bytes)}：${batchList.length} 个「第 N 批」式追加日志（约 ${kb(movableBytes)}）可搬走，` +
              `但搬完正文仍有 ${kb(keptBytes)}、超过单篇上限 —— 得按主题拆成多篇（一条一主题）`
            : `这篇 ${kb(n.bytes)}：${batchList.length} 个「第 N 批」式追加日志（约 ${kb(movableBytes)}）可以搬走，` +
              `搬完正文只剩 ${kb(keptBytes)}。面板「记忆 → 归档」能一键执行`
          : `这篇 ${kb(n.bytes)} 里没有「第 N 批」式追加日志：拆不动，只能按主题分成多篇`,
        [n.file],
      );
    }

    const updated = Date.parse(n.fields.updated ?? '');
    const ageDays = Number.isFinite(updated) ? (now - updated) / 86400000 : Infinity;
    if (TODO_RE.test(n.body) && ageDays > staleDays) {
      add('info', 'stale-todo', `含待办字样但 ${Math.round(ageDays)} 天没更新（还活着吗）：${n.file}`, [n.file]);
    }
  }

  // ---- 同 basename、不同目录的路径（真踩过的坑：软链指向一个已消失的旧路径） ----
  // 两条防误报规则：① 含 `...` 的是缩写，不是另一个位置；② `~/.codex/AGENTS.md` 与
  // `~/.dsh/AGENTS.md` 是两个工具各自的文件，一律不算冲突——只认相对 home 深度 ≥2 的目录。
  const home = homedir();
  const depthFromHome = (dir) => {
    if (dir === home) return 0;
    if (!dir.startsWith(`${home}/`)) return dir.startsWith('/') ? 99 : 0;
    const parts = dir.slice(home.length + 1).split('/');
    // 一层深的**隐藏**目录（~/.codex、~/.dsh）是各工具自己的配置位，不算"同一个东西的两个位置"；
    // 同样一层深但名字普通（~/yffto）是项目根，必须算进来。
    if (parts.length === 1 && parts[0].startsWith('.')) return 0;
    return parts.length;
  };
  const byBase = new Map();
  for (const n of notes) {
    for (const raw of n.text.match(ABS_PATH_RE) ?? []) {
      if (raw.includes('...')) continue;
      const p = normalizePath(raw);
      const idx = p.lastIndexOf('/');
      if (idx <= 0) continue;
      const base = p.slice(idx + 1);
      const dir = p.slice(0, idx);
      if (depthFromHome(dir) === 0) continue;
      if (!byBase.has(base)) byBase.set(base, new Map());
      const dirs = byBase.get(base);
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir).add(n.file);
    }
  }
  for (const [base, dirs] of byBase) {
    if (dirs.size < 2) continue;
    const files = [...dirs.values()].flatMap((s) => [...s]);
    const shown = [...dirs.keys()].map((d) => {
      const full = d.startsWith(home) ? `~${d.slice(home.length)}` : d;
      let alive = false;
      try {
        statSync(join(d, base)); // 存在即算——软链指向目录时 isFile() 会是 false，别把它当失效
        alive = true;
      } catch {
        alive = false;
      }
      return `${full}${alive ? '' : '（已不存在）'}`;
    });
    add('info', 'path-conflict', `${base} 出现在 ${dirs.size} 个不同目录，确认哪个已失效：${shown.join('  |  ')}`, [...new Set(files)]);
  }

  // ---- 可疑重复（阈值定高：宁可不报，也不刷屏） ----
  // 两条防误报：① 缺 description 的笔记跳过——没有描述就无从比较，硬拼会把 `undefined`
  // 字符串化成 token，两篇裸 md 因此算出过"相似度 1.00"；② 一律回落空串，不再拼 name。
  for (let i = 0; i < notes.length; i++) {
    if (!notes[i].fields.description) continue;
    for (let j = i + 1; j < notes.length; j++) {
      if (!notes[j].fields.description) continue;
      const score = jaccard(
        `${notes[i].fields.description} ${notes[i].file}`,
        `${notes[j].fields.description} ${notes[j].file}`,
      );
      if (score >= dupThreshold) {
        add('info', 'duplicate-topic', `description 相似度 ${score.toFixed(2)}，可能讲的是同一件事：${notes[i].file} × ${notes[j].file}`, [notes[i].file, notes[j].file]);
      }
    }
  }

  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  return {
    findings,
    summary: {
      notes: notes.length,
      indexLines: indexText ? indexText.split('\n').length : 0,
      indexBytes: Buffer.byteLength(indexText),
      bySeverity,
    },
  };
}
