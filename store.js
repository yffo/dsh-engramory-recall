/**
 * 读取 Engramory 记忆库（只读）。
 *
 * 契约：本模块**绝不写入**记忆库，只读 MEMORY.md 与同目录的 *.md 笔记。
 * 索引在内存里按「索引文件 mtime + 笔记数量」失效，不产生任何缓存文件。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_NOTES = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 单篇笔记的「桶」上限。超过就按 `##` / `###` / 行边界切桶，每桶独立成一条检索记录。
 *
 * 为什么切桶而不是截断：在一份实测过的库里，有一篇追加式日志长到 267KB、占全库七成体积，
 * 它在 30 条查询里霸榜 17 条。截断成前 8KB 能把霸榜压到 2/30，但后面那 259KB 就永远
 * 检索不到了；切桶既不丢内容，又只让「真正含查询词的那一节」得分。
 */
const SECTION_BYTES = 6 * 1024;

/** 单篇最多切多少桶：防病态文件把索引撑爆。 */
const MAX_SECTIONS = 400;

let cache = { key: '', docs: [] };

/** 读出笔记集合；storePath 不存在或为空时返回空数组。 */
export function readDocs(storePath) {
  let files;
  try {
    files = readdirSync(storePath).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  } catch {
    return [];
  }
  if (files.length > MAX_NOTES) files = files.slice(0, MAX_NOTES);

  let indexMtime = 0;
  try {
    indexMtime = statSync(join(storePath, 'MEMORY.md')).mtimeMs;
  } catch {
    /* 索引缺失不是错误：仍然可以按笔记正文召回 */
  }
  // 每篇的 mtime 一次取齐：既用于缓存键，也用于 freshness 衰减（见 bm25.js 的 decay）。
  const mtimes = new Map();
  for (const file of files) {
    try {
      mtimes.set(file, statSync(join(storePath, file)).mtimeMs);
    } catch {
      mtimes.set(file, 0);
    }
  }
  // 缓存键必须覆盖「任意一篇被改动」：此前只盯首末两篇，改中间那篇不会失效
  // （2026-10-14 发现），会一直读到旧正文。用全部 mtime 之和换正确性，量级可忽略。
  const stamp = [...mtimes.values()].reduce((a, b) => a + b, 0);
  const key = `${storePath}|${indexMtime}|${files.length}|${stamp}`;
  if (cache.key === key) return cache.docs;

  const docs = [];
  let bytes = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(storePath, file), 'utf8');
    } catch {
      continue;
    }
    const fileBytes = Buffer.byteLength(text);
    // 单篇就超过总上限：跳过它，而不是 break —— break 会让它后面（以及它自己）的所有笔记
    // 一篇都读不到，症状是「库里 69 篇笔记，索引却是空的」，而原因只是有一篇大文件排在最前。
    if (fileBytes > MAX_BYTES) continue;
    // 总量到顶：排序在后面的干脆不读了（这才是 break 的本来意图）。
    if (bytes + fileBytes > MAX_BYTES) break;
    bytes += fileBytes;
    const { title, description, body, aliases } = splitNote(text);
    const filePath = join(storePath, file);
    // 整篇字数（含 frontmatter，用字符数而不是字节数：预算 `maxChars` 也是字符口径）。
    // 账本要靠它算「这篇笔记整篇多少字、我们只送出去了多少字」—— 顺手记，不额外做 IO。
    const chars = text.length;
    if (Buffer.byteLength(body) <= SECTION_BYTES) {
      docs.push({ id: file, title, description, body, aliases, path: filePath, mtimeMs: mtimes.get(file) ?? 0, chars });
      continue;
    }
    // 长笔记切桶：同一 id 出现多次，检索侧按 id 聚合只留分最高的那一桶，
    // 所以对调用方而言「一篇笔记仍然只是一条命中」。
    const chunks = chunkBody(body, SECTION_BYTES).slice(0, MAX_SECTIONS);
    chunks.forEach((chunk, i) => {
      docs.push({
        id: file,
        section: chunk.title,
        seq: i,
        // 文档标题只喂给首桶：否则同一个标题会被计入几十次，把长笔记的分数抬虚。
        title: i === 0 ? (chunk.title ? `${title} § ${chunk.title}` : title) : chunk.title || '',
        description: i === 0 ? description : '',
        body: chunk.body,
        aliases,
        path: filePath,
        // 同一篇的所有桶共享同一 mtime，衰减倍率因此一致（不会靠碎桶各自「变新」）。
        mtimeMs: mtimes.get(file) ?? 0,
        // 同一篇的所有桶共享「整篇字数」：一篇长笔记只送出一小段时，省下的量要按整篇算。
        chars,
      });
    });
  }
  cache = { key, docs };
  return docs;
}

/** 解析 frontmatter 与正文；frontmatter 只取 name/description，不做 YAML 依赖。 */
export function splitNote(text) {
  // 入口统一：去 BOM（记事本另存为 UTF-8 会带）、CRLF/CR 归一成 LF。
  // 不归一的话 \r 会混进标题与词项、BOM 会让 frontmatter 整段被当成正文喂进索引。
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let front = '';
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      front = raw.slice(3, end);
      body = raw.slice(raw.indexOf('\n', end + 1) + 1);
    }
  }
  const pick = (field) => {
    const m = front.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const heading = body.match(/^#\s+(.+)$/m);
  const description = pick('description');
  // 作者点名的同义钩子：`aliases: 飞书, lark` —— 让中文口语能命中英文正文。
  // 可选字段，不写就为空数组，检索侧按普通词项处理。
  const aliases = pick('aliases')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    title: (heading ? heading[1].trim() : '') || pick('name') || description,
    description,
    body: body.trim(),
    aliases,
  };
}

/** 按标题行把行数组切成若干块（标题行归属它后面那块）。 */
function splitByHeading(lines, re) {
  const out = [];
  let current = [];
  for (const line of lines) {
    if (re.test(line) && current.length) {
      out.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) out.push(current);
  return out;
}

/** 按行边界硬切成 ≤limit 字节的块（单行本身超限时它自成一桶）。 */
function hardSplit(lines, limit) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (current.length && bytes + size > limit) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out.map((chunk) => ({
    title: (chunk.find((line) => /^#{2,3}\s/.test(line)) ?? '').replace(/^#{2,3}\s*/, '').trim(),
    body: chunk.join('\n').trim(),
  }));
}

/**
 * 把长正文切成 ≤limit 的桶，返回 [{ title, body }]。
 * 三级降级：先按 `##` 分节 → 仍超限再按 `###` 分 → 还超限按行硬切。
 */
export function chunkBody(body, limit = SECTION_BYTES) {
  const out = [];
  for (const section of splitByHeading(String(body ?? '').split('\n'), /^##\s/)) {
    for (const part of splitByHeading(section, /^###\s/)) {
      for (const chunk of hardSplit(part, limit)) {
        if (chunk.body) out.push(chunk);
      }
    }
  }
  return out;
}

/**
 * 语料指纹：把每个 chunk 的 id 与正文喂进 sha256，取前 12 位。
 *
 * 为什么需要它：召回质量只能拿**真实库**当卷子（小 fixture 的 df 结构是反的，测不出东西），
 * 而真实库天天在变。于是「今天 20/21、昨天 21/21」这种比较根本不成立 —— 分掉了不是代码
 * 退步，是卷子换了。这个坑真实踩过两次（自己写的笔记变成召回第一名；同义表没补全时量了
 * 个权重差，把功劳记错了对象）。
 *
 * 是单向哈希，不泄露内容；库动一个字它就变。分数必须和指纹一起读。
 */
export function corpusFingerprint(docs) {
  const h = createHash('sha256');
  // 长笔记会切成多桶（同一 id 多个文档），所以比较器必须是**全序**：只比 id 是不够的 ——
  // 相等时返回常量 1 会让排序结果依赖输入顺序，于是「同一份语料换个顺序」得到不同指纹，
  // A/B 对比就会把一次顺序抖动误判成「语料变了」。第二键用 seq。
  for (const d of [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : (a.seq ?? 0) - (b.seq ?? 0)))) {
    // ⚠️ 这里必须覆盖**所有喂进索引的字段**，而不只是正文。
    // 第一版只哈希了 id + body，于是「只改 aliases」时指纹纹丝不动 —— 而 aliases 是会
    // 被 `bm25.js` 计两遍、实打实影响排序的。结果就是探针一边说「语料没变、这次是可信
    // A/B」，一边把一次语料改动伪装成一次代码改动。**一个漏字段的指纹比没有指纹更坏。**
    for (const field of [d.id, d.title, d.description, d.aliases, d.body]) {
      h.update(String(field ?? '')); h.update('\0');
    }
  }
  return h.digest('hex').slice(0, 12);
}
