/**
 * index-guard.js —— 记忆库索引（`MEMORY.md`）的体积闸门：默认 200 行 / 25KB。
 *
 * 闸门的职责只有一句话：**别让索引涨过上限**。索引是每次会话都要整篇读进上下文的东西，
 * 一旦它无限长大，读它的成本就吃掉了记忆本身的价值。所以这里不做什么智能化，只做
 * 一件很笨但很难出错的事：在写入落盘**之前**算一遍结果，超了就拦。
 *
 * 上限约定（200 行 / 25KB、只拒增长）来自 Engramory 协议
 * （MIT，见 `THIRD-PARTY-NOTICES.md`）。本文件是按该约定写的独立实现，
 * 公开接口（两个常量 + `countLines` / `measureIndex` / `checkIndexWrite`）与判定口径
 * 由 `test/index-guard-equivalence.test.mjs` 用一组固定矩阵钉死。
 *
 * 每个反直觉的分支都在下面就地写了「为什么」，它们都是踩过坑才定下来的口径，
 * 看着啰嗦也别顺手简化：
 *
 *  1. **只拦「确实在长大」的写入**：某一维**超限** 且 **比当前文件更大**，两条同时成立才拒。
 *     于是任何**缩小**的重写永远放行 —— 这不是后门，是唯一的出路：索引一旦超限，如果
 *     连「压小一点」都拒，就再没有任何一次写入能让它降下来，闸门把自己锁死。
 *  2. **当前文件不存在 / 读不到 = 0 行 0 字节**，所以「第一次写就超限」照样被拒。
 *  3. **字节判据用原始 buffer，不先 decode**：非 UTF-8 的坏字节解码后每个会变成 3 字节的
 *     U+FFFD，能把一次**真增长**算成**缩小**而放行。行数用解码后的文本就够了 ——
 *     换行符不会因为有损解码而改变。
 *  4. **片段写入（edit）先模拟出结果再判**：能还原就按结果判；还原不出来（参数形状不认），
 *     只在「索引**已经**超限」时拒绝盲改 —— 并且必须告诉对方出口在哪（整篇重写），
 *     只说「先压缩」而不说怎么压，等于把路堵死。
 *  5. **basename 大小写不敏感**：macOS / Windows 上 `memory.md` 就是那一份索引。
 *  6. **行数对末尾换行不敏感**（`"a\n"` 是 1 行，不是 2 行）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 行数上限；与 `AGENTS.md` 里写给用户看的「索引上限 200 行 / 25KB」是同一个数。 */
export const DEFAULT_MAX_INDEX_LINES = 200;
/** 字节上限：25KB 取十进制 25600，与 Engramory 的默认口径一致。 */
export const DEFAULT_MAX_INDEX_BYTES = 25600;

/** 整篇替换型工具：给了 `content` 就等于给了写入后的完整结果。 */
const FULL_REWRITE_TOOLS = new Set(['write']);
/** 片段替换型工具：只能靠模拟 `oldString → newString` 还原结果。 */
const SNIPPET_EDIT_TOOLS = new Set(['edit']);

/**
 * 上限参数没传时回落到默认值。
 * 只认「传了数字」这一种情况：`undefined`（没配）走默认；
 * 0 或负数确实会被当成上限用 —— 那也是调用方明确表达的意思，不该悄悄改成默认。
 */
function cap(value, fallback) {
  return typeof value === 'number' ? value : fallback;
}

/**
 * 末尾换行不敏感的行数：`""` → 0、`"a\n"` → 1、`"a\nb"` → 2。
 *
 * 「末尾换行不算新开一行」是有意为之：编辑器里在最后一行按回车、保存，文件不该
 * 因为一个光标动作就顶掉一行配额。反过来 `"\n\n\n"` 算 3 行 —— 空行也是行，
 * 它们照样占索引的版面。
 *
 * 注意这个口径必须与 `mcp.js` 报给用户的数字、`scripts/check-recall-wiring.mjs`
 * 的自检口径保持一致，否则同一份索引会在两处显示成两个高度。
 */
export function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * 量一次文本，回答「它超上限了吗」：超了返回一句人话（哪一维、多少、上限多少），
 * 没超返回 `null`。两维都超时会一起写进去，方便用户一次看清要砍多少。
 */
export function measureIndex(text, maxLines, maxBytes) {
  const lineCount = countLines(text);
  const byteCount = Buffer.byteLength(text, 'utf8');
  const over = [];
  if (lineCount > maxLines) over.push(`${lineCount} 行 > ${maxLines}`);
  if (byteCount > maxBytes) over.push(`${byteCount} 字节 > ${maxBytes}`);
  return over.length ? over.join('，') : null;
}

/**
 * 把一次 edit 应用到当前正文上，算出「写完之后长什么样」。
 *
 * 三种还原不出来的情况直接返回 `undefined`，交给调用方走「量不出来」的分支：
 *  - `oldString` 不是字符串、或是空串：真实的 edit 工具要求非空，形状不认就不猜；
 *  - `oldString` 在当前正文里**找不到**：工具会报错、一个字都不改，所以「当前内容」
 *    就是最诚实的预测 —— 这种情况是可以判的，返回 `current`；
 *  - `oldString` 出现**不止一次**：工具同样报错、什么都不改，返回 `current`。
 *
 * `newString` 缺失时按空串算（等价于「删掉这一段」），这与工具自身对可选参数的
 * 处理一致，也避免了把 `undefined` 拼进字符串里变成 "undefined" 这种荒唐结果。
 */
function resolveEdit(current, oldString, newString) {
  if (typeof oldString !== 'string' || oldString === '') return undefined;
  const replacement = typeof newString === 'string' ? newString : '';
  const at = current.indexOf(oldString);
  if (at === -1) return current;
  if (current.indexOf(oldString, at + oldString.length) !== -1) return current;
  return current.slice(0, at) + replacement + current.slice(at + oldString.length);
}

/**
 * 读原始字节；读不到（不存在、没权限、是目录……）返回 `undefined`。
 * 「读不到」在判定里等于空文件，不抛给调用方 —— 守卫不该因为一个读失败就炸掉整个写入链路。
 */
function readBytes(filePath) {
  try {
    return readFileSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * 这次写入落在哪：库外、库里但不是索引、还是就是那份索引。
 * 索引路径由库根目录推出来（`<storeRoot>/MEMORY.md`），调用方不需要告诉我们；
 * 名字比较用 `toLowerCase()` 而不是 `localeCompare` —— 要的是「同一份文件」的
 * 平台无关判断，不涉及任何语言排序规则。
 */
function locate(filePath, storeRoot) {
  const targetAbs = path.resolve(String(filePath));
  const indexAbs = path.resolve(storeRoot, 'MEMORY.md');
  if (path.dirname(targetAbs) !== path.dirname(indexAbs)) return { where: 'outside' };
  if (path.basename(targetAbs).toLowerCase() !== path.basename(indexAbs).toLowerCase()) {
    return { where: 'other' };
  }
  return { where: 'index', abs: targetAbs, name: path.basename(targetAbs) };
}

/**
 * 核心判据：只在「最终超限」**且**「比当前文件更大」时拒绝，两维各判各的。
 *
 * 为什么要把「更大」也写进条件：只判超限的话，超限文件唯一的自救方式（写一份更小的
 * 重写）也会被拒，索引就再也回不到上限以内 —— 见文件头第 1 条。
 *
 * @param {string} proposed 这次写入之后的完整正文
 * @param {Buffer|undefined} currentRaw 当前文件的原始字节（读不到 = `undefined` = 空）
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function judgeAgainstCaps(proposed, currentRaw, name, maxLines, maxBytes) {
  const nextLines = countLines(proposed);
  const nextBytes = Buffer.byteLength(proposed, 'utf8');
  // 当前尺寸取原始 buffer：先用 utf8 解码再量长度，会把坏字节膨胀成 U+FFFD（见文件头第 3 条）。
  const curLines = currentRaw === undefined ? 0 : countLines(currentRaw.toString('utf8'));
  const curBytes = currentRaw === undefined ? 0 : currentRaw.length;

  const over = [];
  if (nextLines > maxLines && nextLines > curLines) over.push(`${nextLines} 行 > ${maxLines}`);
  if (nextBytes > maxBytes && nextBytes > curBytes) over.push(`${nextBytes} 字节 > ${maxBytes}`);
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

/**
 * 判一次写入会不会把索引顶过上限。放行时 `{ ok: true }`（可能带 `skipped` 说明为什么
 * 这次没量），拒绝时 `{ ok: false, reason }` 带一句给人和模型看的话。
 *
 * `skipped` 的取值都表示「这次写入不在闸门管辖范围内」，不是一个错误：
 *  - `not-configured`：没配记忆库，索引在哪都不知道；
 *  - `outside-store`：路径不在库根目录下（库外同名文件不属于本插件）；
 *  - `not-index`：不是那一份 `MEMORY.md`（别的笔记文件由内容守卫管，不归这条上限管）；
 *  - `no-content`：write 没给内容，没什么可判的；
 *  - `not-a-write`：既不是 write 也不是 edit 的工具调用；
 *  - `no-current`：edit 但当前读不到文件（工具自己会报错，这里不预判）；
 *  - `unmeasurable`：edit 的参数形状还原不出结果，而当前索引也没超限。
 *
 * @param {object} input
 * @param {string} input.filePath    目标文件（write/edit 的 file_path）
 * @param {string} input.storePath   记忆库根目录；索引固定是它下面的 `MEMORY.md`
 * @param {string} input.tool        `write` 或 `edit`
 * @param {string} [input.content]   全量内容（write）
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
  maxLines,
  maxBytes,
}) {
  // 库根目录允许两端带空白（配置里从 yaml/环境变量来，容易带），去掉再判；
  // 去掉之后为空就等于「没配库」，闸门没有任何依据，直接放行。
  const storeRoot = String(storePath ?? '').trim();
  if (!storeRoot || !filePath) return { ok: true, skipped: 'not-configured' };
  const target = locate(filePath, storeRoot);
  // 库外的同名文件不归它管；库内的其他文件（笔记）也不归它管 —— 一条上限只管一份文件。
  if (target.where === 'outside') return { ok: true, skipped: 'outside-store' };
  if (target.where === 'other') return { ok: true, skipped: 'not-index' };

  const lineCap = cap(maxLines, DEFAULT_MAX_INDEX_LINES);
  const byteCap = cap(maxBytes, DEFAULT_MAX_INDEX_BYTES);
  const { abs, name } = target;

  if (FULL_REWRITE_TOOLS.has(tool)) {
    // 没有 content 的重写调用（工具自己会报参数错误）：不猜，放行。
    if (typeof content !== 'string') return { ok: true, skipped: 'no-content' };
    return judgeAgainstCaps(content, readBytes(abs), name, lineCap, byteCap);
  }

  if (!SNIPPET_EDIT_TOOLS.has(tool)) return { ok: true, skipped: 'not-a-write' };

  const currentRaw = readBytes(abs);
  // 文件还不存在 / 读不到：真实工具会自己报错，这里不替它预判，也别拿「空文件」去
  // 编一个 edit 结果 —— 那种预测没有意义。
  if (currentRaw === undefined) return { ok: true, skipped: 'no-current' };

  const currentText = currentRaw.toString('utf8');
  const proposed = resolveEdit(currentText, oldString, newString);
  if (proposed !== undefined) return judgeAgainstCaps(proposed, currentRaw, name, lineCap, byteCap);

  // 结果还原不出来时的诚实打折：索引**已经**超限就不许再盲改（这次编辑到底会让它变大
  // 还是变小无从得知，赌它不会更大是不负责任的）；没超限就放行，别为了理论上的风险
  // 去拦正常编辑。拒绝时一定捎上出口。
  const breach = measureIndex(currentText, lineCap, byteCap);
  if (!breach) return { ok: true, skipped: 'unmeasurable' };
  return {
    ok: false,
    reason:
      `拒绝盲改索引：${name} 当前已超上限（${breach}），而这次编辑的结果无法从参数还原。` +
      `请改用整篇重写来压缩：**缩小的重写永远放行**（哪怕仍然超限）。` +
      `把过长的行改成「一句钩子 + 链接」、合并重复项、把冷笔记归档 —— ` +
      `索引是目录，超限之后的部分会被静默地不再被召回。`,
  };
}
