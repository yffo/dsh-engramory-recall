/**
 * guard.js —— 记忆库写入闸门（fail-closed）。
 *
 * 借的是灵枢（FuRongJun-1999/dsh-memory）的写入纪律：
 *   - **fail-closed**：不能证明合法就不落盘（它只看 `committed` 字段，`ok:true` 不算数）；
 *   - **编译者不得自证**：LLM 写的候选必须由「编外单元」复核后才算数。
 *
 * 我们用宿主原生的工具守卫做那个「编外单元」：模型要写记忆库时，由本插件（一个不参与
 * 写作的组件）按静态规则复核，复核不过就拒绝这次调用。
 *
 * 能力边界（诚实写明，别把它当安全边界）：
 *   1. 只能做**静态**校验（文件名 / 结构 / 凭据 / 体积），做不了语义复核——那需要模型，
 *      而本插件零出网、零模型调用。
 *   2. 拦不住绕过：`bash` 里的重定向（`echo … > note.md`）、`node -e "fs.writeFileSync…"`
 *      都不经过 write/edit 工具，闸门看不见。它是**正路守卫**，不是沙箱。
 *   3. `edit` 只给片段（old_string/new_string），看不到整篇，所以只校验文件名与凭据，
 *      结构校验只在 `write`（全量内容）上做。
 */
import path from 'node:path';

/** 四类事实（AGENTS.md 的 Engramory 纪律）。 */
export const MEMORY_KINDS = ['user', 'feedback', 'project', 'reference'];

/** 笔记文件名：<kind>-<slug>.md；slug 只允许小写字母/数字/连字符。 */
export const NOTE_FILE_RE = /^(user|feedback|project|reference)-[a-z0-9][a-z0-9-]*\.md$/;

/** 索引文件名：内容是指针列表，不受笔记规则约束（另有 dsh-engramory 的行数/字节守卫）。 */
export const INDEX_FILE = 'MEMORY.md';

/**
 * 单篇笔记上限。库里那种 267KB 的追加式日志是历史包袱——一条一主题才是纪律，
 * 超过这个体积基本可以断定是在往一篇里堆时间线。
 */
export const MAX_NOTE_BYTES = 100 * 1024;

const SECRET_RULES = [
  { label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'OpenAI 风格密钥', re: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

/** 「键: 值」形式的凭据；值要够长、够像钥匙才判。 */
const KV_SECRET_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|passwd|password|passphrase)\b\s*[:=]\s*["'`]?([A-Za-z0-9_\-/+]{16,})/gi;

/**
 * 占位豁免：记忆库**应该**记「密钥在哪里」，所以 `process.env.X`、`<token>`、`YOUR_KEY`
 * 这类指路写法必须放行。`.` 不在值的字符集里，`process.env.OPENAI_API_KEY` 天然不会被
 * KV 规则整体匹配——这里再兜一层显式占位。
 */
const PLACEHOLDER_RE =
  /^(?:<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|YOUR[_-]?[A-Za-z0-9_-]*|XXX+|xxx+|\*{3,}|\.{3,}|REDACTED|CHANGEME|PLACEHOLDER|EXAMPLE|N\/?A|TODO)$/i;

/** 扫出疑似真实凭据，返回描述；没有则返回 undefined。 */
export function scanSecrets(text) {
  const s = String(text ?? '');
  for (const rule of SECRET_RULES) {
    if (rule.re.test(s)) return rule.label;
  }
  KV_SECRET_RE.lastIndex = 0;
  let match;
  while ((match = KV_SECRET_RE.exec(s)) !== null) {
    if (PLACEHOLDER_RE.test(match[1])) continue;
    return `${match[0].split(/[:=]/)[0].trim()} 的值`;
  }
  return undefined;
}

/** 解析开头的 frontmatter 块；没有则返回 undefined。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ''));
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  return { raw: match[1], fields };
}

const isInside = (abs, root) => abs === root || abs.startsWith(root + path.sep);

/**
 * 复核一次写入。
 *
 * @param {object} input
 * @param {string} input.filePath   目标文件（write/edit 的 file_path）
 * @param {string} input.storePath  记忆库根目录
 * @param {string} [input.content]  全量内容（write）——给了才做结构/体积校验
 * @param {string} [input.fragment] 片段（edit 的 new_string）
 * @returns {{ ok: true, skipped?: string } | { ok: false, reason: string }}
 */
export function checkMemoryWrite({ filePath, storePath, content, fragment }) {
  const root = String(storePath ?? '').trim();
  if (!root || !filePath) return { ok: true, skipped: 'not-configured' };

  const abs = path.resolve(String(filePath));
  if (!isInside(abs, path.resolve(root))) return { ok: true, skipped: 'outside-store' };

  const file = path.basename(abs);
  if (file === INDEX_FILE) return { ok: true, skipped: 'index' };

  const reject = (reason) => ({ ok: false, reason });

  if (!NOTE_FILE_RE.test(file)) {
    return reject(
      `拒绝写入记忆库：文件名「${file}」不合规。必须是 <user|feedback|project|reference>-<小写slug>.md；` +
        `索引固定为 ${INDEX_FILE}。`,
    );
  }

  const prefix = file.split('-')[0];

  const payload = content ?? fragment;
  if (payload !== undefined && payload !== null) {
    const secret = scanSecrets(payload);
    if (secret) {
      return reject(
        `拒绝写入记忆库：${file} 里疑似含真实凭据（${secret}）。` +
          `记忆库要能安全进 git——只记「密钥在哪里」，不要记密钥本身。`,
      );
    }
  }

  // 片段（edit）看不到整篇，结构校验到此为止。
  if (content === undefined || content === null) {
    return { ok: true, partial: true };
  }

  const text = String(content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_NOTE_BYTES) {
    return reject(
      `拒绝写入记忆库：${file} 有 ${(bytes / 1024).toFixed(0)}KB，超过单篇上限 ` +
        `${MAX_NOTE_BYTES / 1024}KB。一条一主题——请拆成多篇，索引里各加一行指针。`,
    );
  }

  const fm = parseFrontmatter(text);
  if (!fm) {
    return reject(`拒绝写入记忆库：${file} 缺少 frontmatter（文件开头由 --- 包裹的头部）。`);
  }
  if (!fm.fields.name) return reject(`拒绝写入记忆库：${file} 的 frontmatter 缺 name 字段。`);
  if (!fm.fields.description) {
    return reject(`拒绝写入记忆库：${file} 的 frontmatter 缺 description 字段。`);
  }
  if (fm.fields.type && fm.fields.type !== prefix) {
    return reject(
      `拒绝写入记忆库：${file} 的 frontmatter 写的是 type: ${fm.fields.type}，` +
        `与文件名前缀「${prefix}」不一致。`,
    );
  }

  return { ok: true };
}
