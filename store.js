/**
 * 读取 Engramory 记忆库（只读）。
 *
 * 契约：本模块**绝不写入**记忆库，只读 MEMORY.md 与同目录的 *.md 笔记。
 * 索引在内存里按「索引文件 mtime + 笔记数量」失效，不产生任何缓存文件。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_NOTES = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 单篇笔记的「桶」上限。超过就按 `##` / `###` / 行边界切桶，每桶独立成一条检索记录。
 *
 * 为什么切桶而不是截断：2026-10-14 实测库内 45 篇 366KB，其中 project-by-yffto-cicd.md
 * 一篇就 267KB（73%），它在 30 条查询里霸榜 17 条。截断前 8KB 能把霸榜压到 2/30，但巨兽
 * 后 259KB 就永远检索不到了；切桶既不丢内容，又只让「真正含查询词的那一节」得分。
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
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) break;
    const { title, description, body, aliases } = splitNote(text);
    const filePath = join(storePath, file);
    if (Buffer.byteLength(body) <= SECTION_BYTES) {
      docs.push({ id: file, title, description, body, aliases, path: filePath, mtimeMs: mtimes.get(file) ?? 0 });
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
      });
    });
  }
  cache = { key, docs };
  return docs;
}

/** 解析 frontmatter 与正文；frontmatter 只取 name/description，不做 YAML 依赖。 */
export function splitNote(text) {
  const raw = String(text ?? '');
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
