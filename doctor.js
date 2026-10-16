// 记忆库体检：结构一致性 + 纪律 + 可疑信号。纯静态、零出网、不改任何文件。
//
// 为什么不是"冲突检测"：实测过 1128 对笔记，正文相似度最高的 12 对全是四个**不同**项目
// （它们像是因为共用 project 模板措辞），description 最高才 0.273。纯词面测的是文体不是主题，
// 声称能自动发现语义矛盾就是骗人。这里只做**能判定**的事，剩下的一律标 info 交给人看。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tokenize } from './bm25.js';
// 两项「记忆卫生」结论要用门控本人的判据与阈值，**不在这里另抄一份**：
// 「这篇到底有没有被用上」只有账本知道，而账本的读法只有 `confidence.js` 一处定义。
// 循环导入是安全的：两边都只在函数体内引用对方的绑定（doctor 的 `NOTE_KINDS` ↔ confidence 的判定函数），
// 模块求值期间谁都不读对方的值。
import { GATE_DEFAULTS, confidenceOf, freshness, markSelfTouches, noteLedgerStats } from './confidence.js';
import { readUsage } from './usage.js';
import { readAudit } from './audit.js';
// ★ 「哪篇该归档」只能有一处定义，而且就是**归档器本人**。
// 这里先后踩过两次同一个坑：① 自己抄了一份 `^##\s*第…批`，于是归档器已经认加粗行与
// ### 深度了、体检还在报 32 批（真值是 46）；② 自己抄了一份 64KB 门槛，于是体检对一份
// 89KB 的归档产物说「可以一键执行」，而归档器根本不会碰它。
// 现在直接问 `planArchive` 要结果：体检说的每一句，都是按钮真做得到的事。
import { HISTORY_FILE_RE, planArchive } from './archive.js';
import { DEFAULT_MAX_NOTES, DEFAULT_MAX_BYTES } from './store.js';

export const NOTE_KINDS = ['user', 'feedback', 'project', 'reference'];
export const INDEX_FILE = 'MEMORY.md';
export const MAX_NOTE_BYTES = 100 * 1024;
export const STALE_TODO_DAYS = 30;
export const DUPLICATE_TOPIC_THRESHOLD = 0.5;

const NOTE_FILE_RE = new RegExp(`^(${NOTE_KINDS.join('|')})-[a-z0-9][a-z0-9-]*\\.md$`);
const TODO_RE = /待办|未完成|TODO|进行中|未做|待定|未闭环/;
/** 归档建议的两个阈值（超过任一即提示）：体积与「##」章节数。 */
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
  // 与上面的 `staleDays` **不是一回事**，所以另起一个名字：`staleTodoDays`（默认 30 天）量的是
  // 「frontmatter.updated 里写着待办却没人动」，门控的 `staleDays`（默认 180 天）量的是
  // 「project 笔记的文件多久没被写过」。两个判据、两个量级，共用一个数就会同时错两头。
  const gateStaleDays = options.staleDays ?? GATE_DEFAULTS.staleDays;
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
    let mtimeMs = 0;
    try {
      // mtime 顺手从这次 `statSync` 里取走（下面判 `isFile()` 本来就要调它）——
      // 「project 笔记多久没更新」要的就是这个数，不能再为它多跑一次 IO。
      const st = statSync(join(storePath, file));
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
      text = readFileSync(join(storePath, file), 'utf8');
    } catch {
      continue;
    }
    const { fields, body } = parseFrontmatter(text);
    notes.push({ file, text, body, fields, bytes: Buffer.byteLength(text), mtimeMs });
  }

  // ---- 读侧上限（召回读不到的东西，只有体检看得见）----
  // 召回一次只读前 `maxNotes` 篇 / 前 `maxBytes` 字节（`readDocsReport`），超出的笔记
  // **在检索里根本不存在**。体检是唯一能看到「整库」的地方，所以这里必须报 ——
  // 否则现象只是「召回变差」，原因（有 N 篇从没进过检索）没有任何界面会说出来。
  const capNotes = Number(options.maxNotes) > 0 ? Math.floor(Number(options.maxNotes)) : DEFAULT_MAX_NOTES;
  const capBytes = Number(options.maxBytes) > 0 ? Math.floor(Number(options.maxBytes)) : DEFAULT_MAX_BYTES;
  const totalBytes = notes.reduce((sum, note) => sum + note.bytes, 0);
  if (notes.length > capNotes) {
    add(
      'warn',
      'notes-over-cap',
      `库里有 ${notes.length} 篇，召回只读前 ${capNotes} 篇（按文件名排序），另外 ${notes.length - capNotes} 篇不会被检索到 —— 调大 maxNotes，或归档/合并掉不再用的笔记`,
      [INDEX_FILE],
    );
  }
  if (totalBytes > capBytes) {
    add(
      'warn',
      'store-over-byte-cap',
      `库共 ${Math.round(totalBytes / 1024)} KB，召回一次只读前 ${Math.round(capBytes / 1024)} KB（按文件名顺序），排在后面的笔记不会被检索到 —— 调大 maxBytes，或归档掉大文件`,
      [INDEX_FILE],
    );
  }

  // ---- 索引 ↔ 文件 ----
  const pointers = [...indexText.matchAll(/\]\(([^)]+?\.md)\)/g)].map((m) => m[1]);
  const uniquePointers = new Set(pointers);
  for (const p of uniquePointers) {
    if (!mdFiles.includes(p)) add('error', 'index-missing-file', `索引指向的笔记不存在：${p}`, [p]);
  }
  const unreferenced = [];
  // 归档器亲自出的计划：体检不再自己判定「哪篇该归档」
  const { plans: archivePlans, skipped: archiveSkipped } = planArchive(storePath, options.archive);
  const archivePlanByFile = new Map(archivePlans.map((p) => [p.file, p]));
  const archiveSkipByFile = new Map(archiveSkipped.map((s) => [s.file, s]));

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

  // ---- 账本：两项「记忆卫生」结论的输入 ----
  // 账本从哪来：注入给了就用注入的（测试要能造出任意履历），否则自己读库目录里的两份账本。
  // 读取上限与 `index.js#gateContextOf` **逐字一致**（usage 2000 行 / audit 500 行）：
  // 体检说的必须与门控真做的同一口径，否则同一篇笔记会出现「体检说它从没被用上、门控却在放行」。
  //
  // 为什么账本不存在（或为空）时**一项新结论都不出**：没有账本只说明这个库没在记账
  // （老库、`usageLog` 关着、或刚建好），并不说明「库里没有问题」。此时报「这篇从没被用上」
  // 是纯粹的瞎猜，而体检最不能做的事就是把「不知道」写成一条结论 —— 用户会当成「已检查过」。
  // 所以两条结论统一挂在「有账本」这个前提上：没账本的库，体检输出与从前逐字相同。
  const usageLines = Array.isArray(options.usageLines) ? options.usageLines : readUsage(storePath, 2000);
  const auditLines = Array.isArray(options.auditLines) ? options.auditLines : readAudit(storePath, 500);
  const hasLedger = usageLines.length > 0;
  const ledgerStats = hasLedger ? noteLedgerStats(usageLines) : new Map();
  // 自我触碰必须先扣掉：模型刚落盘一篇笔记、紧接着又读回来（同一个话题里很常见），
  // 账本上照样是一次 `used`。把它算成「被用上」，等于让模型自己写的结论回头证明自己有用
  // ——越写越像真的。扣掉之后仍然是 0 次，才敢说这篇「从没被用上」。
  if (hasLedger) markSelfTouches(ledgerStats, auditLines, { selfTouchMs: options.selfTouchMs ?? GATE_DEFAULTS.selfTouchMs });

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

    // 归档建议 —— 对标 dsh-mneme 的 `phaseDemotion`（超期归档 / 降级为截断摘要），
    // 但在我们这里**只报告、绝不动用户的笔记**：笔记是 Markdown 主存储，自动改写等于
    // 替用户删资料。判据不在这里判 —— 直接查归档器刚出的计划，见文件头的说明。
    const ap = archivePlanByFile.get(n.file);
    const as = archiveSkipByFile.get(n.file);
    if (ap) {
      const kb = (v) => `${(v / 1024).toFixed(0)}KB`;
      add(
        'info',
        'archive-suggestion',
        ap.keptBytes > MAX_NOTE_BYTES
          ? `这篇 ${kb(ap.bytes)}：${ap.freshCount} 个「第 N 批」式追加日志可搬走，` +
            `但搬完正文仍有 ${kb(ap.keptBytes)}、超过单篇上限 —— 得按主题拆成多篇（一条一主题）`
          : `这篇 ${kb(ap.bytes)}：${ap.freshCount} 个「第 N 批」式追加日志（约 ${kb(ap.movedBytes)}）可以搬走，` +
            `搬完正文只剩 ${kb(ap.keptBytes)}。面板「记忆 → 归档」能一键执行`,
        [n.file],
      );
    } else if (as) {
      // 归档器算了但搬不动（没有「第 N 批」式日志段）。这种时候不能只说「建议归档」——
      // 那是在指一条走不通的路，用户点开面板会发现根本没有可执行的计划。
      add('info', 'archive-suggestion', `${as.reason} —— 得按主题拆成多篇（一条一主题）`, [n.file]);
    }

    const updated = Date.parse(n.fields.updated ?? '');
    const ageDays = Number.isFinite(updated) ? (now - updated) / 86400000 : Infinity;
    if (TODO_RE.test(n.body) && ageDays > staleDays) {
      add('info', 'stale-todo', `含待办字样但 ${Math.round(ageDays)} 天没更新（还活着吗）：${n.file}`, [n.file]);
    }

    // ---- 记忆卫生（账本类）----
    // 只判有账本的库（理由见上面读账本处）。判据一律问 `confidence.js` 要 ——
    // 体检不许自己修一套阈值，否则改阈值时「面板降权了谁」与「体检报了谁」迟早分叉。
    if (hasLedger) {
      // ① 「每轮都在占预算、却从没人用过」。判据是门控的 `tier === 'ignored'`：
      //    携带次数够多（≥ minEvidence，样本不够时它返回 `unknown`，体检也就不说话）+ 一次没用上。
      const stat = ledgerStats.get(n.file);
      if (confidenceOf(stat ?? { carried: 0, used: 0 }).tier === 'ignored') {
        const selfTouch = stat?.selfTouch ?? 0;
        add(
          'warn',
          'never-used',
          `被带进上下文 ${stat.carried} 次、一次都没被用上` +
            // 「另有」而不是「其中」：`selfTouch` 数是**被扣掉的读事件**，包含注入后被读回
            // 与模型自己搜出来打开这两条路，真实账本里出现过「携带 11 次、自我触碰 39 次」。
            // 写成「其中 39 次」会造出一句自相矛盾的话，体检的可信度就是这么磨掉的。
            (selfTouch > 0 ? `（另有 ${selfTouch} 次是写完自己马上读回，不算用上）` : '') +
            '—— 它每轮都在占预算：改写 description 让它更容易被认出来，或合并进相关笔记',
          [n.file],
        );
      }
      // ② 「正在做的事」半年没动过。**只给 info，不给 warn**：一篇 project 笔记长期不更新，
      //    可能恰恰是那件「还没做完、所以没人动」的事——它是待确认的提醒，不是过错。
      //    warn 会让用户以为库坏了，而这条本身给不出「该删」的结论（过期只降权，见 confidence.js）。
      const fresh = freshness({ id: n.file, mtimeMs: n.mtimeMs }, { now, staleDays: gateStaleDays });
      // mtime 拿不到时 `freshness` 返回 stale=false —— 宁可漏报，也不拿「不知道」当「很旧」。
      // 归档产物（`project-*-history.md`）要排除：它是冻结的派生文件，mtime 只会越来越旧，
      // 但它既不是「正在做的事」、也没法「更新或归档」（归档器按设计不会再动它）。
      // 不排除的话，半年之后每一份归档都会冒出一句「还活着吗」—— 正是 duplicate-topic
      // 当年被归档产物刷屏（N 份归档报出 N²/2 条）的翻版，同一类机械噪声。
      if (fresh.stale && !HISTORY_FILE_RE.test(n.file)) {
        add('info', 'stale-project', `这份「正在做的事」已经 ${Math.round(fresh.ageDays)} 天没更新（还活着吗）：要么更新、要么归档`, [n.file]);
      }
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
  // 三条防误报：① 缺 description 的笔记跳过——没有描述就无从比较，硬拼会把 `undefined`
  // 字符串化成 token，两篇裸 md 因此算出过"相似度 1.00"；② 一律回落空串，不再拼 name；
  // ③ **归档产物跳过**——它们的 description 是归档器按同一模板生成的（"X 的历史批次
  // 归档：…"），彼此天然 0.94 相似，于是 N 份归档会报出 N²/2 条「可能讲的是同一件事」。
  // 那是机械派生的噪声，不是人写重了；体检的可信度就是被这种条目磨掉的。
  const dupCandidates = notes.filter((n) => !HISTORY_FILE_RE.test(n.file));
  for (let i = 0; i < dupCandidates.length; i++) {
    if (!dupCandidates[i].fields.description) continue;
    for (let j = i + 1; j < dupCandidates.length; j++) {
      if (!dupCandidates[j].fields.description) continue;
      const score = jaccard(
        `${dupCandidates[i].fields.description} ${dupCandidates[i].file}`,
        `${dupCandidates[j].fields.description} ${dupCandidates[j].file}`,
      );
      if (score >= dupThreshold) {
        add('info', 'duplicate-topic', `description 相似度 ${score.toFixed(2)}，可能讲的是同一件事：${dupCandidates[i].file} × ${dupCandidates[j].file}`, [dupCandidates[i].file, dupCandidates[j].file]);
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
