/**
 * index-guard.js —— `MEMORY.md` 索引上限闸门（默认 200 行 / 25KB）。
 *
 * **融合自 `dsh-engramory` v0.2.5 的 `refuseOversizedIndex`（其 `index.js:128-230`）。**
 * 吸收它的理由：本插件要做**完整的记忆系统**，不该把「索引上限」这一块留在外部依赖里
 * —— 那个插件一共只做两件事（本闸门 + 注册 `engramory` 技能），我们把两件都收进来之后，
 * 它就可以退场了。
 *
 * 原文的核心设计逐条保留（这些是踩过坑才有的，不要想当然地简化）：
 *
 *  1. **只拒绝「确实在长大」的写入**。判据是「某一维**最终超限** 且 **比当前文件大**」，
 *     所以任何**缩小**的重写永远放行 —— 否则索引一旦超限就再也压不回去，变成死锁。
 *     用户看到的是「先压缩」的提示，而压缩这条路必须是通的。
 *  2. **当前文件不存在/读不到 = 空**（0 行 0 字节），所以「第一次写入就超限」照样拒绝。
 *  3. **字节数取原始 buffer**，不先 decode。原文注释记了原因：非 UTF-8 的索引解码后
 *     每个坏字节变成 3 字节的 U+FFFD，会把一次**真增长**算成**缩小**而放行。
 *     行数可以用解码后的文本（换行不会因有损解码而改变）。
 *  4. **片段写入（edit）先做模拟**：能还原出结果就按结果判；还原不出来（参数形状不认），
 *     就只在「当前已经超限」时拒绝盲改 —— 且明确告诉对方出口是整篇重写。
 *  5. **basename 大小写不敏感**：macOS/Windows 上 `memory.md` 就是那个索引。
 *  6. 行数按**末尾换行不敏感**计（`"a\n"` 是 1 行不是 2 行）。
 *
 * 我们**没有**搬过来的部分（诚实写明，别以为它有）：
 *  - `str_replace_editor` 那套工具名与 `old_str`/`new_str` 参数形状 —— 本宿主用的是
 *    `write` / `edit`（`old_string`/`new_string`），搬一套用不上的分支是纯负担。
 *  - `indexName` 配置项：本插件**知道**库在哪，索引路径直接由 `storePath` 推出来
 *    （`<storePath>/MEMORY.md`），比人手钉一个绝对路径更不容易错。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 行数上限。与 `AGENTS.md` 里写的「索引上限 200 行 / 25KB」一致。 */
export const DEFAULT_MAX_INDEX_LINES = 200;
/** 字节上限（25KB = 25600，取十进制，与 dsh-engramory 的默认值一致）。 */
export const DEFAULT_MAX_INDEX_BYTES = 25600;

/** 能整篇替换内容的工具：给了 `content` 就能算出写入后的完整结果。 */
const WHOLE_FILE_TOOLS = new Set(['write']);
/** 只给片段的工具：只能靠模拟还原结果。 */
const PARTIAL_TOOLS = new Set(['edit']);

/**
 * 末尾换行不敏感的行数。`""` → 0，`"a\n"` → 1，`"a\nb"` → 2。
 * （与 dsh-engramory 的 `countLines` 逐字一致 —— 两边算出来的数必须一样，
 * 否则同一个索引在两次检查里会有两个高度。）
 */
export function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** 人类可读的超限描述；没超返回 `null`。 */
export function measureIndex(text, maxLines, maxBytes) {
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const over = [];
  if (lines > maxLines) over.push(`${lines} 行 > ${maxLines}`);
  if (bytes > maxBytes) over.push(`${bytes} 字节 > ${maxBytes}`);
  return over.length ? over.join('，') : null;
}

/** 还原一次 edit 的写入结果；参数形状认不出来时返回 `undefined`。 */
function simulateEdit(current, oldString, newString) {
  if (typeof oldString !== 'string' || oldString === '') return undefined;
  const next = typeof newString === 'string' ? newString : '';
  const first = current.indexOf(oldString);
  // 找不到 old_string：真正的工具会报错、什么也不改 —— 那「当前内容」就是诚实的预测。
  if (first === -1) return current;
  // 出现多次：真正的工具同样会报错，什么都不改。
  if (current.indexOf(oldString, first + oldString.length) !== -1) return current;
  return current.slice(0, first) + next + current.slice(first + oldString.length);
}

/** 读原始 buffer；读不到返回 `undefined`（读不到不算超限，见文件头第 2 条）。 */
function readRaw(filePath) {
  try {
    return readFileSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * 判一次写入是否会把索引顶过上限。
 *
 * @param {object} input
 * @param {string} input.filePath   目标文件（write/edit 的 file_path）
 * @param {string} input.storePath  记忆库根目录；索引固定是它下面的 `MEMORY.md`
 * @param {string} input.tool       `write` 或 `edit`
 * @param {string} [input.content]  全量内容（write）
 * @param {string} [input.oldString] 被替换的片段（edit）
 * @param {string} [input.newString] 替换成的片段（edit）
 * @param {number} [input.maxLines]
 * @param {number} [input.maxBytes]
 * @returns {{ ok: true, skipped?: string } | { ok: false, reason: string }}
 */
export function checkIndexWrite({
  filePath,
  storePath,
  tool,
  content,
  oldString,
  newString,
  maxLines = DEFAULT_MAX_INDEX_LINES,
  maxBytes = DEFAULT_MAX_INDEX_BYTES,
}) {
  const root = String(storePath ?? '').trim();
  if (!root || !filePath) return { ok: true, skipped: 'not-configured' };

  const abs = path.resolve(String(filePath));
  const indexAbs = path.resolve(root, 'MEMORY.md');
  // 只认「就是那个索引文件」：同一个目录、同一个名字（大小写不敏感，见文件头第 5 条）。
  if (path.dirname(abs) !== path.dirname(indexAbs)) return { ok: true, skipped: 'outside-store' };
  if (path.basename(abs).toLowerCase() !== path.basename(indexAbs).toLowerCase()) {
    return { ok: true, skipped: 'not-index' };
  }

  const name = path.basename(abs);
  const reject = (reason) => ({ ok: false, reason });

  if (WHOLE_FILE_TOOLS.has(tool)) {
    if (typeof content !== 'string') return { ok: true, skipped: 'no-content' };
    return verdict(content, readRaw(abs), name, maxLines, maxBytes);
  }

  if (!PARTIAL_TOOLS.has(tool)) return { ok: true, skipped: 'not-a-write' };

  const currentRaw = readRaw(abs);
  if (currentRaw === undefined) return { ok: true, skipped: 'no-current' };
  const current = currentRaw.toString('utf8');
  const simulated = simulateEdit(current, oldString, newString);
  if (simulated !== undefined) return verdict(simulated, currentRaw, name, maxLines, maxBytes);

  // 结果还原不出来。诚实的便宜规则：索引**已经**超限时，不许再盲改它，
  // 并且要指出出口 —— 只说「先压缩」而不说怎么压，等于把路堵死。
  const breach = measureIndex(current, maxLines, maxBytes);
  if (!breach) return { ok: true, skipped: 'unmeasurable' };
  return reject(
    `拒绝盲改索引：${name} 当前已超上限（${breach}），而这次编辑的结果无法从参数还原。` +
      `请改用整篇重写来压缩：**缩小的重写永远放行**（哪怕仍然超限）。` +
      `把过长的行改成「一句钩子 + 链接」、合并重复项、把冷笔记归档 —— ` +
      `索引是目录，超限之后的部分会被静默地不再被召回。`,
  );
}

/**
 * 核心判据：只在「某一维最终超限、且比当前文件大」时拒绝。
 * 照抄 dsh-engramory 的 `verdict`（其 `index.js:204-230`），逐条保留其注释里的坑。
 */
function verdict(text, currentRaw, name, maxLines, maxBytes) {
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  // 当前尺寸取**原始 buffer**：先解码会把非 UTF-8 的坏字节膨胀成 U+FFFD，
  // 让一次真增长看起来像缩小而放行（原文记录的真实缺陷）。
  const curLines = currentRaw === undefined ? 0 : countLines(currentRaw.toString('utf8'));
  const curBytes = currentRaw === undefined ? 0 : currentRaw.length;

  const over = [];
  if (lines > maxLines && lines > curLines) over.push(`${lines} 行 > ${maxLines}`);
  if (bytes > maxBytes && bytes > curBytes) over.push(`${bytes} 字节 > ${maxBytes}`);
  if (!over.length) return { ok: true };

  return {
    ok: false,
    reason:
      `拒绝写入记忆库：这次写入会把索引 ${name} 顶过上限（${over.join('，')}）。` +
      `索引每次会话都要读、而宿主只读前面那么多，超限的部分会被静默地不再被召回。` +
      `请先压缩再写：把细节挪进各自的笔记文件、合并重复、归档冷笔记，` +
      `每行保持「一句短钩子 + 链接」。**缩小的重写永远放行**，可以一步一步压。`,
  };
}
