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
  // 窗口上限（maxPointers）只用来算「窗口用满了几轮」；不知道就不算，别瞎猜。
  const windowLimit = Math.max(0, Number(options.maxPointers) || 0);
  const sorted = [...(lines ?? [])].sort((a, b) => Number(a?.ts ?? 0) - Number(b?.ts ?? 0));

  const stats = {
    injectRounds: 0, pointers: 0, zeroRounds: 0, dedupeRounds: 0, sedimentRounds: 0, denyRounds: 0,
    skipRounds: 0, emptyRounds: 0,
    used: 0, coldOpens: 0, firstAt: 0, lastAt: 0,
    // 预算压力：collapsed = 被缩成裸文件名的那几条，dropped = 因预算整条没列出的条数
    collapsed: 0, collapsedRounds: 0, dropped: 0, droppedRounds: 0, truncatedRounds: 0,
  };
  const injections = [];
  const usedEvents = [];
  const perNote = new Map();
  const roundSizes = [];
  const lags = [];
  // 「为什么没注入」与「注进来的分有多高」——两者都是调参的依据，缺了就只能猜。
  const skipReasons = new Map();
  const emptyReasons = new Map();
  const topScores = [];
  const spreads = [];
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const toCounts = (map) =>
    Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));

  for (const line of sorted) {
    const ts = Number(line?.ts ?? 0);
    const kind = String(line?.kind ?? '');
    if (ts) {
      if (!stats.firstAt) stats.firstAt = ts;
      stats.lastAt = ts;
    }
    if (kind === 'empty') {
      stats.zeroRounds += 1;
      stats.emptyRounds += 1;
      bump(emptyReasons, String(line?.reason ?? 'unspecified'));
    } else if (kind === 'skip') {
      stats.dedupeRounds += 1;
      stats.skipRounds += 1;
      bump(skipReasons, String(line?.reason ?? 'unspecified'));
    }
    else if (kind === 'sediment') stats.sedimentRounds += 1;
    else if (kind === 'deny' || kind === 'deny-error') stats.denyRounds += 1;

    const ids = Array.isArray(line?.ids) ? line.ids.map(String).filter(Boolean) : [];
    if (ids.length) {
      stats.injectRounds += 1;
      stats.pointers += ids.length;
      roundSizes.push(ids.length);
      const scores = Array.isArray(line?.scores) ? line.scores.map(Number).filter(Number.isFinite) : [];
      if (scores.length) {
        topScores.push(scores[0]);
        if (scores.length > 1) spreads.push(scores[0] - scores[scores.length - 1]);
      }
      const collapsed = Math.max(0, Number(line?.collapsed) || 0);
      const dropped = Math.max(0, Number(line?.dropped) || 0);
      if (collapsed > 0) {
        stats.collapsed += collapsed;
        stats.collapsedRounds += 1;
      }
      if (dropped > 0) {
        stats.dropped += dropped;
        stats.droppedRounds += 1;
      }
      if (collapsed > 0 || dropped > 0) stats.truncatedRounds += 1;
      injections.push({ at: ts, ids });
    }
    if (kind === 'used' && line?.id) {
      stats.used += 1;
      const lag = Number(line?.lagMs);
      if (Number.isFinite(lag) && lag >= 0) lags.push(lag);
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
  const sizes = [...roundSizes].sort((a, b) => a - b);
  const lagSorted = [...lags].sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0);
  return {
    ...stats,
    openRate: stats.pointers ? stats.used / stats.pointers : 0,
    positions,
    notes,
    neverOpened: notes.filter((n) => !n.opened).slice(0, neverLimit),
    uniqueNotes: notes.length,
    // 窗口实际用满了吗：perRound 是每轮注入的条数分布，fullRounds 要有 maxPointers 才算
    perRound: {
      min: sizes[0] ?? 0,
      median: q(sizes, 0.5),
      p90: q(sizes, 0.9),
      max: sizes.length ? sizes[sizes.length - 1] : 0,
      windowLimit,
      fullRounds: windowLimit ? roundSizes.filter((n) => n >= windowLimit).length : 0,
    },
    // 打开得多快：lagMs = 注入到被打开之间的毫秒数（中位/p90）
    openLag: { n: lagSorted.length, median: q(lagSorted, 0.5), p90: q(lagSorted, 0.9) },
    // 「为什么没注入」：按原因码计数（chitchat / too-short / duplicate / index-empty /
    // no-hits / below-min-score …）。设计性的跳过与真问题混在一起就看不出异常。
    skipReasons: toCounts(skipReasons),
    emptyReasons: toCounts(emptyReasons),
    // 「把 minScore 抬高会付出什么」——分数光有统计量没用，得能算成代价才可决策
    scoreCurve: minScoreCurve(lines, options),
    // 注进来的分有多高、第 1 条比最后一条高多少 —— 校准 minScore 与窗口宽度的依据
    scoreStats: {
      n: topScores.length,
      median: round3(q([...topScores].sort((a, b) => a - b), 0.5)),
      p10: round3(q([...topScores].sort((a, b) => a - b), 0.1)),
      p90: round3(q([...topScores].sort((a, b) => a - b), 0.9)),
      spreadMedian: round3(q([...spreads].sort((a, b) => a - b), 0.5)),
    },
  };
}

const round3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : 0);

/**
 * 一句判据（尺子与面板共用）：`minScore` 该不该抬、能抬到哪。
 * @param {ReturnType<typeof minScoreCurve>} curve
 */
export function scoreCurveVerdict(curve) {
  if (!curve || !curve.n) {
    return '还没有能校准 minScore 的日志（要 0.13.3 之后的 hit 行：带 scores）';
  }
  if (curve.opened < 5) {
    return `被打开过的指针只有 ${curve.opened} 条 —— 曲线只能看形状，别据此定 minScore`;
  }
  if (curve.freeCap) {
    return `零代价上限：minScore ≥ ${curve.freeCap.minScore} 能砍掉 ${curve.freeCap.cut} 条注入`
      + `（${(curve.freeCap.cutRate * 100).toFixed(1)}%），且没丢过任何被打开过的指针`;
  }
  return '没有「砍掉又不丢」的门槛 —— 被打开过的指针分数并不比没被打开的集中，抬 minScore 只会伤到自己';
}

/**
 * `minScore` 代价曲线：把「把门槛抬高」算成两个数 —— 砍掉几条注入、代价是丢掉几条
 * **真的被打开过**的指针。
 *
 * 光有 `scoreStats`（中位/p10/p90）没法决策：中位 3.2 不代表门槛 3.2 划算 ——
 * 要看被砍掉的那一撮里有没有人真的在用。数据全在召回日志里：`hit` 行的 `ids` 与
 * `scores`（同一顺序、一一对应）、`used` 行的 `id` 与时间；归属规则与位置级打开率
 * 一致（一次 `used` 算在它之前最近一次注入过这条的那一轮上）。
 *
 * 返回：
 * - `points`：候选门槛（取观测到的分位点）各自的 砍掉/留下/丢掉被打开过的
 * - `freeCap`：**零代价上限** —— 能砍掉最多注入、又没丢过任何被打开过的指针的那个门槛
 * - `unaligned` / `legacy`：对不上号的轮数（`scores` 与 `ids` 长度不等、或老日志没有 `scores`），
 *   它们不进曲线但要说出来 —— 静默少算比算错更坏。
 *
 * @param {object[]} lines 日志行（任意顺序）
 * @param {{steps?: number}} [options]
 */
export function minScoreCurve(lines, options = {}) {
  const steps = Math.min(40, Math.max(3, Number(options.steps) || 12));
  const sorted = [...(lines ?? [])].sort((a, b) => Number(a?.ts ?? 0) - Number(b?.ts ?? 0));
  const rounds = [];
  const usedEvents = [];
  let unaligned = 0;
  let legacy = 0;
  for (const line of sorted) {
    const kind = String(line?.kind ?? '');
    if (kind === 'used' && line?.id) {
      usedEvents.push({ at: Number(line?.ts ?? 0), id: String(line.id) });
      continue;
    }
    const ids = Array.isArray(line?.ids) ? line.ids.map(String).filter(Boolean) : [];
    if (!ids.length) continue;
    const scores = Array.isArray(line?.scores) ? line.scores.map(Number) : null;
    if (!scores || !scores.length) {
      // 0.13.3 之前的日志没有 scores 字段：这一轮只能进「无从校准」的计数。
      legacy += 1;
      continue;
    }
    if (scores.length !== ids.length || !scores.every(Number.isFinite)) {
      unaligned += 1;
      continue;
    }
    rounds.push({ at: Number(line?.ts ?? 0), ids, scores, opened: new Set() });
  }

  // 归属：一次 used 算在它之前最近一次注入过这条的那一轮上（与位置级打开率同规则）
  for (const ev of usedEvents) {
    let hit = null;
    for (const round of rounds) {
      if (round.at > ev.at) break;
      if (round.ids.includes(ev.id)) hit = round;
    }
    if (hit) hit.opened.add(ev.id);
  }

  const pairs = [];
  for (const round of rounds) {
    round.ids.forEach((id, i) => pairs.push({ score: round.scores[i], opened: round.opened.has(id) }));
  }
  const injectedTotal = pairs.length;
  const openedTotal = pairs.filter((p) => p.opened).length;
  const observed = [...new Set(pairs.map((p) => p.score))].sort((a, b) => a - b);
  // 候选门槛：从低到高取分位点（含最低分与「比最高分再高一点」= 全砍）
  const candidates = [];
  for (let i = 0; i < steps; i += 1) {
    const idx = Math.floor((i / (steps - 1)) * (observed.length - 1));
    if (observed.length) candidates.push(observed[idx]);
  }
  if (observed.length) candidates.push(Number((observed[observed.length - 1] + 0.001).toFixed(4)));
  const points = [...new Set(candidates)].map((minScore) => {
    const kept = pairs.filter((p) => p.score >= minScore);
    const cut = injectedTotal - kept.length;
    const lost = pairs.filter((p) => p.score < minScore && p.opened).length;
    return {
      minScore: round3(minScore),
      injected: kept.length,
      cut,
      cutRate: injectedTotal ? round3(cut / injectedTotal) : 0,
      lost,
    };
  });
  // 零代价上限：lost === 0 里最大的那个门槛（严格大于最低分，否则「砍 0 条」也算零代价）
  const free = points.filter((p) => p.lost === 0 && p.cut > 0);
  const freeCap = free.length ? free[free.length - 1] : null;
  return {
    n: injectedTotal,
    opened: openedTotal,
    rounds: rounds.length,
    unaligned,
    legacy,
    points,
    freeCap,
    note:
      openedTotal < 5
        ? `被打开过的指针只有 ${openedTotal} 条 —— 曲线现在只能看形状，别据此定 minScore`
        : '',
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

/**
 * 第二句判据：预算（maxChars）够不够用。
 * 注入行里带着 collapsed（被缩成裸文件名）与 dropped（整个没列出）—— 它们才是
 * 「窗口调宽了但字没跟上」的直接证据：指针条数够、内容却被砍掉。
 * @param {ReturnType<typeof summarizeUsage>} summary
 */
export function budgetVerdict(summary) {
  if (!summary || !summary.injectRounds) return '还没有注入行可比';
  const rounds = summary.injectRounds;
  const truncatedShare = summary.truncatedRounds / rounds;
  if (truncatedShare > 0.2) {
    return `预算在砍内容：${(truncatedShare * 100).toFixed(0)}% 的注入轮有指针被截断`
      + `（合计 ${summary.collapsed} 条缩成裸文件名、${summary.dropped} 条整个没列出）—— 先抬 maxChars，再谈放宽窗口`;
  }
  if (summary.perRound.windowLimit && summary.perRound.fullRounds / rounds > 0.5) {
    return `窗口基本用满（${summary.perRound.fullRounds}/${rounds} 轮顶到 ${summary.perRound.windowLimit} 条）`
      + '，且几乎没有被预算砍掉 —— 想再放宽只需动 maxPointers，maxChars 还够';
  }
  return `预算没有明显压力（${summary.truncatedRounds}/${rounds} 轮被截断）——窗口没顶到上限，是命中不够或 minScore 挡住了`;
}

/** 原因码 → 人话。统计里出现没列过的码时原样显示（别把新码藏起来）。 */
const REASON_LABELS = {
  chitchat: '寒暄 / 答话（设计如此）',
  'too-short': '消息太短',
  'empty-message': '空消息',
  duplicate: '与上一轮重复',
  'store-not-configured': '没配库路径',
  'index-empty': '库里没有笔记',
  'no-hits': '一条都不匹配',
  'below-min-score': '被 minScore 拦住',
  unspecified: '没记原因（早期日志）',
};

/**
 * 第三句判据：没注入的那些轮次，原因分布说明了什么。
 * 关键是分清「设计性的安静」与「真出了问题」——寒暄门控占大头是好事，
 * `below-min-score` 或 `no-hits` 占大头才是要动参数的信号。
 * @param {ReturnType<typeof summarizeUsage>} summary
 */
export function reasonVerdict(summary) {
  if (!summary) return '还没有召回判定可看';
  const merged = {};
  for (const [code, n] of Object.entries(summary.skipReasons ?? {})) merged[code] = (merged[code] ?? 0) + n;
  for (const [code, n] of Object.entries(summary.emptyReasons ?? {})) merged[code] = (merged[code] ?? 0) + n;
  const entries = Object.entries(merged).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '还没有「没注入」的轮次可比';
  const [topCode, topCount] = entries[0];
  const topLabel = REASON_LABELS[topCode] ?? topCode;
  // 早期日志没带原因码时别急着下结论：那是缺数据，不是「设计性的安静」。
  if (topCode === 'unspecified') {
    return `没注入的 ${total} 轮里 ${topCount} 轮没有原因码（0.13.3 之前落的盘这样）——`
      + '再聊几轮，新日志会区分寒暄门控 / 太短 / minScore / 库里没有';
  }
  const head = `没注入的 ${total} 轮里，最多的是「${topLabel}」${((topCount / total) * 100).toFixed(0)}%`;
  const blocked = (summary.emptyReasons?.['below-min-score'] ?? 0) + (summary.emptyReasons?.['no-hits'] ?? 0);
  if (blocked / total > 0.3) {
    return `${head}；但 ${blocked} 轮是「有分却不够 / 一条都不匹配」——这两类才是真漏，看 scoreStats 决定 minScore`;
  }
  return `${head}——设计性的安静占大头，参数先别动`;
}
