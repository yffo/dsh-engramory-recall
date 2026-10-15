/**
 * 召回日志（落盘版）：每轮注入了什么、注入过的东西**后来有没有被打开**，各记一行 JSONL。
 *
 * 为什么要有它：写入审计回答「谁动了记忆库」，内存里的 recallLog 回答「这轮为什么注入 /
 * 为什么没注入」，但没有任何地方回答「注入的指针后来被用上了吗」——于是「窗口该多宽、
 * 门槛该多高」这类问题只能靠离线卷子猜，猜完还不知道对不对。这里把分母与分子都补上：
 *
 *   inject 行（kind = hit / sediment，`ids` 按**显示顺序**）—— 本轮注入了哪几条；
 *   used   行 —— 注入过的那条后来被 read/edit 打开（`lagMs` = 距注入多久）；
 *   opened 行 —— 没被注入过、也被主动打开的笔记（对照组：不注入也会看的有多少）。
 *
 * 位置级打开率（第 1 条 vs 第 4 条）靠 `ids` 的顺序算，所以顺序必须原样落盘。
 * 纪律与写入审计一致：体积上限、超了半量截断、**永不抛异常**——记账失败绝不能影响工具调用。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const USAGE_FILE = '.engramory-recall.jsonl';

/** 日志体积上限；超了只留后半（与 audit.js 同一套做法，召回日志不该无限增长）。 */
export const MAX_USAGE_BYTES = 512 * 1024;

/**
 * 追加一条召回日志。**永不抛异常**。
 * @param {string} storePath 记忆库目录
 * @param {object} entry `{ kind, query?, reason?, ids?, injected?, collapsed?, dropped?, id?, via?, lagMs? }`
 */
export function appendUsage(storePath, entry) {
  if (!storePath) return;
  try {
    mkdirSync(storePath, { recursive: true });
    const file = path.join(storePath, USAGE_FILE);
    try {
      if (statSync(file).size > MAX_USAGE_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch {
      // 文件还不存在：正常路径
    }
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    // 只读挂载、磁盘满、权限问题——都不该让一次工具调用失败
  }
}

/**
 * 读召回日志（新的在前）。文件不存在或损坏时返回空数组。
 * @param {string} storePath 记忆库目录
 * @param {number} limit 最多读多少行
 */
export function readUsage(storePath, limit = 2000) {
  try {
    const text = readFileSync(path.join(storePath, USAGE_FILE), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // 半截行（写到一半被杀）跳过
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 从工具参数的路径里认出笔记 id。只认 `.md`——别的文件不是笔记。
 * @param {string} filePath
 * @returns {string} 文件名，或空串
 */
export function noteIdFromPath(filePath) {
  const base = path.basename(String(filePath ?? ''));
  return base.endsWith('.md') ? base : '';
}

/**
 * 这条笔记是不是**注入过**？注入记录表由调用方维护（id → 时间戳），这里只做纯查询。
 * @param {string} id 笔记文件名
 * @param {Map<string, number>} injectedAt
 * @returns {{id: string, at: number}|null}
 */
export function pickInjected(id, injectedAt) {
  if (!id || !(injectedAt instanceof Map)) return null;
  const at = injectedAt.get(id);
  return Number.isFinite(at) ? { id, at } : null;
}

/**
 * 汇总召回日志（纯函数，便于单测与离线回放）。
 *
 * 位置级打开率的归属规则：一次 `used` 归到**它之前最近一次注入过这条**的那一轮——
 * 第 1 轮注入、第 3 轮才打开，算第 1 轮第 N 个位置的账。
 *
 * @param {object[]} lines 日志行（任意顺序）
 * @param {{positions?: number, neverOpenedLimit?: number}} [options]
 */
export function summarizeUsage(lines, options = {}) {
  const maxPositions = Math.max(1, Number(options.positions) || 8);
  const neverLimit = Math.max(1, Number(options.neverOpenedLimit) || 12);
  const sorted = [...(lines ?? [])].sort((a, b) => Number(a?.ts ?? 0) - Number(b?.ts ?? 0));

  const stats = {
    injectRounds: 0, pointers: 0, zeroRounds: 0, dedupeRounds: 0, sedimentRounds: 0, denyRounds: 0,
    used: 0, coldOpens: 0, firstAt: 0, lastAt: 0,
  };
  const injections = [];
  const usedEvents = [];
  const perNote = new Map();

  for (const line of sorted) {
    const ts = Number(line?.ts ?? 0);
    const kind = String(line?.kind ?? '');
    if (ts) {
      if (!stats.firstAt) stats.firstAt = ts;
      stats.lastAt = ts;
    }
    if (kind === 'empty') stats.zeroRounds += 1;
    else if (kind === 'skip') stats.dedupeRounds += 1;
    else if (kind === 'sediment') stats.sedimentRounds += 1;
    else if (kind === 'deny' || kind === 'deny-error') stats.denyRounds += 1;

    const ids = Array.isArray(line?.ids) ? line.ids.map(String).filter(Boolean) : [];
    if (ids.length) {
      stats.injectRounds += 1;
      stats.pointers += ids.length;
      injections.push({ at: ts, ids });
    }
    if (kind === 'used' && line?.id) {
      stats.used += 1;
      usedEvents.push({ at: ts, id: String(line.id), via: String(line.via ?? '') });
    }
    else if (kind === 'opened' && line?.id) stats.coldOpens += 1;
  }

  const positions = Array.from({ length: maxPositions }, (_, i) => ({ position: i + 1, injected: 0, opened: 0 }));
  for (const inj of injections) {
    inj.ids.forEach((id, i) => {
      if (i < maxPositions) positions[i].injected += 1;
      const rec = perNote.get(id) ?? { id, injected: 0, opened: 0, lastAt: 0 };
      rec.injected += 1;
      rec.lastAt = Math.max(rec.lastAt, inj.at);
      perNote.set(id, rec);
    });
  }
  for (const ev of usedEvents) {
    let position = -1;
    for (const inj of injections) {
      if (inj.at > ev.at) break;
      const at = inj.ids.indexOf(ev.id);
      if (at >= 0) position = at;
    }
    if (position >= 0 && position < maxPositions) positions[position].opened += 1;
    const rec = perNote.get(ev.id);
    if (rec) rec.opened += 1;
  }

  const notes = [...perNote.values()].sort((a, b) => b.injected - a.injected || b.lastAt - a.lastAt);
  return {
    ...stats,
    openRate: stats.pointers ? stats.used / stats.pointers : 0,
    positions,
    notes,
    neverOpened: notes.filter((n) => !n.opened).slice(0, neverLimit),
    uniqueNotes: notes.length,
  };
}

/**
 * 一句判据（尺子与面板共用）：打开率该往哪边走。
 * 样本太小就明说别据此决策——12 条指针的 50% 与 4 条是指针的 50% 不是一回事。
 * @param {ReturnType<typeof summarizeUsage>} summary
 */
export function usageVerdict(summary) {
  if (!summary || summary.pointers < 20) {
    return `样本太小（注入 ${summary?.pointers ?? 0} 条）——先攒到 20 条以上再据此决策`;
  }
  if (summary.openRate < 0.3) {
    return `打开率 ${(summary.openRate * 100).toFixed(1)}% 偏低：窗口该收窄，或把 minScore 抬高一点`;
  }
  if (summary.openRate > 0.6) {
    return `打开率 ${(summary.openRate * 100).toFixed(1)}% 偏高：窗口可以按 hit@k 曲线放宽到 5~8 条`;
  }
  return `打开率 ${(summary.openRate * 100).toFixed(1)}% 在中间档：窗口保持现状，先看位置级曲线`;
}
