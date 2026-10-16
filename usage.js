/**
 * 召回日志（落盘版）：每轮注入了什么、注入过的东西**后来有没有被打开**，各记一行 JSONL。
 *
 * 为什么要有它：写入审计回答「谁动了记忆库」，内存里的 recallLog 回答「这轮为什么注入 /
 * 为什么没注入」，但没有任何地方回答「注入的指针后来被用上了吗」——于是「窗口该多宽、
 * 门槛该多高」这类问题只能靠离线卷子猜，猜完还不知道对不对。这里把分母与分子都补上：
 *
 *   inject 行（kind = hit / sediment，`ids` 按**显示顺序**）—— 本轮注入了哪几条；
 *   hint   行（kind = hint，0.21.0 起）—— pull 档只推了一句提示、**没有**注入指针
 *          （`ids` 为空、`wouldInject` = 本来会注入几条）；它不是 inject 行，`hintRounds` 单记；
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
  // 必须取整：小数（如 --positions 2.5）会让 Array.from({length: 2.5}) 只建 2 格，
  // 后面的 i < maxPositions 却能走到 2 —— 越界写入直接 TypeError。
  const maxPositions = Math.max(1, Math.floor(Number(options.positions)) || 8);
  const neverLimit = Math.max(1, Number(options.neverOpenedLimit) || 12);
  // 窗口上限（maxPointers）只用来算「窗口用满了几轮」；不知道就不算，别瞎猜。
  const windowLimit = Math.max(0, Number(options.maxPointers) || 0);
  const sorted = [...(lines ?? [])].sort((a, b) => Number(a?.ts ?? 0) - Number(b?.ts ?? 0));

  const stats = {
    injectRounds: 0, pointers: 0, zeroRounds: 0, dedupeRounds: 0, sedimentRounds: 0, denyRounds: 0,
    skipRounds: 0, emptyRounds: 0,
    // pull 档「只推了一句提示」的轮次（0.21.0）：**不进 `injectRounds` / `pointers`** ——
    // 那两个数代表「注入了指针」，是打开率的分母。提示一句话没有被翻开的东西，
    // 混进分母只会让打开率凭空变好看。
    hintRounds: 0,
    used: 0, coldOpens: 0, firstAt: 0, lastAt: 0,
    // 预算压力：collapsed = 被缩成裸文件名的那几条，dropped = 因预算整条没列出的条数
    collapsed: 0, collapsedRounds: 0, dropped: 0, droppedRounds: 0, truncatedRounds: 0,
    // 预算用量：budget = 那一轮的上限（maxChars），spent = 实际用掉的字符数。
    // 只看「塌缩了几条」分不出「几乎顶满」还是「富余大半」—— 抬不抬 maxChars 全靠这两个数。
    budgetRounds: 0,
  };
  // 预算用量的原始比例（spent / budget），逐轮收集、最后算中位/p90
  const budgetRatios = [];
  // 上下文代价与「留在磁盘上的量」：0.15.0 起的 hit 行才有 `noteChars`（这一轮带到的笔记整篇
  // 加起来多少字），老行只能算「注入了多少」。缺数据的轮**单列**计数，不拿 0 冒充
  // —— 与 budget 同一纪律：宁可说「不知道」，也不能让「没这一项」看起来像「省了 0 字」。
  const cost = { rounds: 0, legacyRounds: 0, pointerChars: 0, noteChars: 0, savedChars: 0 };
  const savedPerRound = [];
  // 「这一轮到底带没带记忆」的完整分母：宿主问过的每一轮都算进来。
  // 「本轮没注入任何记忆」本身就是结论（设计性的安静 vs 真出问题），必须看得见。
  // `hint`（0.21.0）是 pull 档的安静轮：它**不是** `hit`（没注入指针），也算「问过一轮」，
  // 单开一格 —— 既有键一个都没改名。
  const coverageRounds = { hit: 0, skip: 0, empty: 0, sediment: 0, hint: 0 };
  // 「缩成裸文件名的是哪几条」（0.13.15 起落盘）：截断的代价只能靠它算 ——
  // 只记「缩了几条」的话，没法知道被缩的那几条后来有没有被打开。
  const truncatedRounds = [];
  let truncationLegacy = 0;
  const injections = [];
  const usedEvents = [];
  const perNote = new Map();
  const roundSizes = [];
  const lags = [];
  // 「为什么没注入」与「注进来的分有多高」——两者都是调参的依据，缺了就只能猜。
  const skipReasons = new Map();
  const emptyReasons = new Map();
  // 消费侧门控的账（0.16.0 起落盘）：档位分布 + 每轮被降权/被拦的指针数。
  // 只记「真的发生了什么」：`shadow` 档一分未改，它的数字是**观察值**（用来估算开 enforce 的后果）。
  const gateModes = new Map();
  const gate = { rounds: 0, demotedRounds: 0, demotedPointers: 0, readyRounds: 0, readyPointers: 0, suppressedRounds: 0, suppressedPointers: 0 };
  const topScores = [];
  const spreads = [];
  // 「这一轮是谁在问」：main（主对话）/ subagent（委派轮）/ unknown（0.13.7 之前的老行）。
  // 委派轮按设计几乎不会打开笔记，混进分母会让打开率系统性偏低 —— 必须能拆开看。
  const scopes = { main: { injectRounds: 0, pointers: 0, used: 0 }, subagent: { injectRounds: 0, pointers: 0, used: 0 }, unknown: { injectRounds: 0, pointers: 0, used: 0 } };
  const scopeOf = (line) => (line?.scope === 'main' || line?.scope === 'subagent' ? line.scope : 'unknown');
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
    // 门控账：`gate` 字段每一轮都写（0.16.0 起），所以这里按「有没有这个字段」计，
    // 不必区分 kind（拦掉一轮的 kind 是 empty，降权一轮是 hit）。
    if (line?.gate) {
      gate.rounds += 1;
      bump(gateModes, String(line.gate));
      const demoted = Array.isArray(line.demoted) ? line.demoted.length : 0;
      const ready = Array.isArray(line.suppressReady) ? line.suppressReady.length : 0;
      const dropped = Array.isArray(line.suppressed) ? line.suppressed.length : 0;
      if (demoted) {
        gate.demotedRounds += 1;
        gate.demotedPointers += demoted;
      }
      if (ready) {
        gate.readyRounds += 1;
        gate.readyPointers += ready;
      }
      if (dropped) {
        gate.suppressedRounds += 1;
        gate.suppressedPointers += dropped;
      }
    }
    if (kind === 'empty') {
      stats.zeroRounds += 1;
      stats.emptyRounds += 1;
      coverageRounds.empty += 1;
      bump(emptyReasons, String(line?.reason ?? 'unspecified'));
    } else if (kind === 'skip') {
      stats.dedupeRounds += 1;
      stats.skipRounds += 1;
      coverageRounds.skip += 1;
      bump(skipReasons, String(line?.reason ?? 'unspecified'));
    }
    else if (kind === 'sediment') {
      stats.sedimentRounds += 1;
      coverageRounds.sediment += 1;
    }
    // pull 档的提示（0.21.0）：只记「有过这么一轮 + 本来会有几条」，**不碰**下面的
    // `ids.length` 分支 —— hint 行的 ids 是空数组，天然进不了 injectRounds / pointers，
    // 这也是这一档不改打开率分母的结构性保证（不是靠人记着别写）。
    else if (kind === 'hint') {
      stats.hintRounds += 1;
      coverageRounds.hint += 1;
    }
    else if (kind === 'deny' || kind === 'deny-error') stats.denyRounds += 1;

    const ids = Array.isArray(line?.ids) ? line.ids.map(String).filter(Boolean) : [];
    if (ids.length) {
      stats.injectRounds += 1;
      coverageRounds.hit += 1;
      stats.pointers += ids.length;
      roundSizes.push(ids.length);
      const bucket = scopes[scopeOf(line)];
      bucket.injectRounds += 1;
      bucket.pointers += ids.length;
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
      // 缩掉的是哪几条：有这个键的轮才能算「截断的代价」；老行（缩过但没记名单）只计数。
      const collapsedIds = Array.isArray(line?.collapsedIds) ? line.collapsedIds.map(String).filter(Boolean) : null;
      if (collapsedIds) truncatedRounds.push({ at: ts, ids, collapsedIds });
      else if (collapsed > 0) truncationLegacy += 1;
      // 预算用量（0.13.13 起落盘）：老行没有这两项 ⇒ 只统计有数据的轮，不拿 0 冒充
      const budget = Number(line?.budget);
      const spent = Number(line?.spent);
      if (Number.isFinite(budget) && budget > 0 && Number.isFinite(spent) && spent >= 0) {
        stats.budgetRounds += 1;
        budgetRatios.push(Math.min(1, spent / budget));
      }
      // 省下的上下文（0.15.0 起落盘）：整篇字数 − 真正送出去的字符数。
      // 这是「记忆到底占了多少上下文」的可复算答案，不是形容词；老行没有这一项，
      // 就单列 legacyRounds，让报告能说清「这个数只覆盖了哪几轮」。
      const noteChars = Number(line?.noteChars);
      if (Number.isFinite(noteChars) && noteChars > 0) {
        cost.rounds += 1;
        cost.noteChars += noteChars;
        // spent 与 noteChars 同源（同一轮、同一支记的）；真缺了就按 0 记 —— 那一轮确实一个字都没送。
        const pointerChars = Number.isFinite(spent) && spent >= 0 ? spent : 0;
        cost.pointerChars += pointerChars;
        const saved = Math.max(0, noteChars - pointerChars);
        cost.savedChars += saved;
        savedPerRound.push(saved);
      } else {
        cost.legacyRounds += 1;
      }
      injections.push({ at: ts, ids, scope: scopeOf(line) });
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
  // 去重：同一轮注入里，同一条指针被读三次只算「打开过一个指针」。`used` 行记的是打开**次数**，
  // 而分母 pointers 是注入**条数**，量纲不同 —— 不去重的话 20 条指针被读 30 次会算出打开率
  // 150%，判据还会反过来说「打开率偏高：窗口可以放宽」，正好把结论说反。
  const countedUsed = new Set();
  // 「哪一轮注入的哪一条被打开过」——位置级、分账、截断代价都用这一份归属。
  const openedPairs = new Set();
  let usedCounted = 0;
  for (const ev of usedEvents) {
    let position = -1;
    let owner = null;
    for (const inj of injections) {
      if (inj.at > ev.at) break;
      const at = inj.ids.indexOf(ev.id);
      if (at >= 0) {
        position = at;
        owner = inj;
      }
    }
    const key = owner ? `${owner.at}\u0000${ev.id}` : null;
    if (key) {
      openedPairs.add(key);
      if (countedUsed.has(key)) continue;
      countedUsed.add(key);
      scopes[owner.scope].used += 1;
      usedCounted += 1;
    }
    if (position >= 0 && position < maxPositions) positions[position].opened += 1;
    const rec = perNote.get(ev.id);
    if (rec) rec.opened += 1;   // 没找到注入过它的那一轮 = 冷启动打开，照旧记账
  }

  const notes = [...perNote.values()].sort((a, b) => b.injected - a.injected || b.lastAt - a.lastAt);
  // 截断的代价：被缩成裸文件名的那几条，后来被打开过吗？——「缩了多少条」答不了这个，
  // 所以 0.13.15 起把「缩掉的是谁」也落盘，这里按名单把两撮分开各算打开率。
  const truncation = {
    rounds: truncatedRounds.length,
    legacy: truncationLegacy,
    collapsed: { pointers: 0, opened: 0, openRate: 0 },
    full: { pointers: 0, opened: 0, openRate: 0 },
  };
  for (const round of truncatedRounds) {
    const names = new Set(round.collapsedIds);
    for (const id of round.ids) {
      const side = names.has(id) ? truncation.collapsed : truncation.full;
      side.pointers += 1;
      if (openedPairs.has(`${round.at}\u0000${id}`)) side.opened += 1;
    }
  }
  for (const side of [truncation.collapsed, truncation.full]) {
    side.openRate = side.pointers ? side.opened / side.pointers : 0;
  }
  const sizes = [...roundSizes].sort((a, b) => a - b);
  const lagSorted = [...lags].sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0);
  // hint 轮也是「宿主问过的一轮」：不进分母的话，pull 档跑得越多 injectedShare 越虚高
  // （分母只数了 push 那几轮）。它只影响「问了多少轮」，不影响打开率的分母。
  const coverageTotal =
    coverageRounds.hit + coverageRounds.skip + coverageRounds.empty + coverageRounds.sediment + coverageRounds.hint;
  return {
    ...stats,
    // 上下文代价：注入了多少字 / 这些笔记整篇多少字 / 差就是没进上下文的量。
    // savedRate 只对**有 noteChars 的轮**成立 —— 老行算不进来，报告里必须写明覆盖了几轮。
    cost: {
      ...cost,
      savedRate: cost.noteChars ? cost.savedChars / cost.noteChars : 0,
      medianSaved: q([...savedPerRound].sort((a, b) => a - b), 0.5),
    },
    // 宿主一共问了多少轮、其中多少轮真的带了记忆、多少轮一个字都没进 ——
    // 「本轮没注入任何记忆」是结论不是空白，所以它得有个明确的位置。
    coverage: {
      rounds: coverageTotal,
      injected: coverageRounds.hit,
      zeroInjected: coverageTotal - coverageRounds.hit,
      injectedShare: coverageTotal ? coverageRounds.hit / coverageTotal : 0,
      byKind: { ...coverageRounds },
    },
    // 分子是**去重后**的打开条数（openRate ≤ 1 恒成立）；stats.used 仍是原始 used 行数。
    openRate: stats.pointers ? usedCounted / stats.pointers : 0,
    usedCounted,
    // 按提问者拆开的同一笔账：主对话轮才是「这套召回到底有没有用」的判据，
    // 委派轮的指针几乎注定不会被打开（unknown = 升级前写的老行）。
    scopes: Object.fromEntries(
      Object.entries(scopes).map(([key, v]) => [key, { ...v, openRate: v.pointers ? v.used / v.pointers : 0 }]),
    ),
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
    // 预算用掉了多少（0.13.13 起 hit 行才带 budget/spent）：mid 高 = 指针被压得难看，
    // 该抬 maxChars；mid 低 = 抬了也白抬。full = 用掉 ≥95% 的轮数。
    budgetUse: budgetRatios.length
      ? {
        n: budgetRatios.length,
        median: q([...budgetRatios].sort((a, b) => a - b), 0.5),
        p90: q([...budgetRatios].sort((a, b) => a - b), 0.9),
        full: budgetRatios.filter((r) => r >= 0.95).length,
      }
      : { n: 0, median: 0, p90: 0, full: 0 },
    // 「为什么没注入」：按原因码计数（chitchat / too-short / duplicate / index-empty /
    // no-hits / below-min-score …）。设计性的跳过与真问题混在一起就看不出异常。
    skipReasons: toCounts(skipReasons),
    emptyReasons: toCounts(emptyReasons),
    // 门控的现实：降权了多少轮/多少条、有多少条够到抑制线、enforce 档真拦了多少条。
    // 老账本（0.15.x）没有 `gate` 字段 → `rounds: 0`，读的一侧必须能分清「没开」与「没数据」。
    gate: { ...gate, modes: toCounts(gateModes) },
    // 「把 minScore 抬高会付出什么」——分数光有统计量没用，得能算成代价才可决策
    scoreCurve: minScoreCurve(lines, options),
    // 截断的代价：被缩成裸文件名的那些后来有没有被打开（0.13.15 起落盘 collapsedIds）
    truncation,
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
  // 有足够多的委派轮时改用「只看主对话」的口径：委派提示词里没有「先看记忆库」这回事，
  // 把它们算进分母等于拿一群不会打开笔记的轮次来评判窗口宽度（实测稀释掉一半以上）。
  const byScope = summary.scopes ?? {};
  const main = byScope.main ?? { pointers: 0, used: 0, openRate: 0 };
  const sub = byScope.subagent ?? { pointers: 0, used: 0 };
  const diluted = sub.pointers >= 10 && sub.pointers >= 0.2 * summary.pointers && main.pointers >= 20;
  const rate = diluted ? main.openRate : summary.openRate;
  const head = diluted
    ? `打开率 ${(rate * 100).toFixed(1)}%（只看主对话轮的 ${main.pointers} 条指针；另有 ${sub.pointers} 条来自子代理轮，它们几乎不会打开笔记）`
    : `打开率 ${(summary.openRate * 100).toFixed(1)}%`;
  if (rate < 0.3) {
    return `${head} 偏低：窗口该收窄，或把 minScore 抬高一点`;
  }
  if (rate > 0.6) {
    return `${head} 偏高：窗口可以按 hit@k 曲线放宽到 5~8 条`;
  }
  return `${head} 在中间档：窗口保持现状，先看位置级曲线`;
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
    const use = summary.budgetUse ?? { n: 0 };
    const detail = use.n
      ? `；预算中位用掉 ${(use.median * 100).toFixed(0)}%、${use.full}/${use.n} 轮顶到 95% 以上`
      : '';
    return `预算在砍内容：${(truncatedShare * 100).toFixed(0)}% 的注入轮有指针被截断`
      + `（合计 ${summary.collapsed} 条缩成裸文件名、${summary.dropped} 条整个没列出）${detail}—— 先抬 maxChars，再谈放宽窗口`;
  }
  if (summary.perRound.windowLimit && summary.perRound.fullRounds / rounds > 0.5) {
    return `窗口基本用满（${summary.perRound.fullRounds}/${rounds} 轮顶到 ${summary.perRound.windowLimit} 条）`
      + '，且几乎没有被预算砍掉 —— 想再放宽只需动 maxPointers，maxChars 还够';
  }
  return `预算没有明显压力（${summary.truncatedRounds}/${rounds} 轮被截断）——窗口没顶到上限，是命中不够或 minScore 挡住了`;
}

/**
 * 第四句判据：预算把指针缩成裸文件名，到底伤不伤？
 * 「缩了 N 条」只说明预算顶到上限了，不说明砍掉的东西有没有用 —— 这里比的是
 * 「被缩的那几条后来被打开过吗」与「完整列出的那几条被打开过吗」。两边都要
 * 攒够被打开的样本（各 5 条）才敢比大小，否则只说形状。
 * @param {ReturnType<typeof summarizeUsage>} summary
 */
export function truncationVerdict(summary) {
  const t = summary?.truncation;
  if (!t || typeof t !== 'object') return '还没有截断记录可看';
  const legacyNote = t.legacy
    ? `；另有 ${t.legacy} 轮缩过但没记下缩的是哪几条（0.13.15 起才落盘）`
    : '';
  if (!t.rounds) {
    return t.legacy
      ? `缩过 ${t.legacy} 轮、但没记下缩的是哪几条（0.13.15 起才落盘）——「缩掉的有没有被用上」还答不了`
      : '还没有把指针缩成裸文件名的轮（预算没顶到过上限）';
  }
  if (!t.collapsed.pointers) {
    return `记了名单的 ${t.rounds} 轮里没有指针真的被缩（顶到上限也没缩到谁）${legacyNote}`;
  }
  const c = t.collapsed;
  const f = t.full;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const detail = `被缩成裸文件名的 ${c.pointers} 条里被打开过 ${c.opened} 条（${pct(c.openRate)}），`
    + `完整列出的 ${f.pointers} 条里 ${f.opened} 条（${pct(f.openRate)}）`;
  if (c.opened < 5 || f.opened < 5) return `${detail} —— 打开的样本太少（两边各要 5 条），先看形状${legacyNote}`;
  if (c.openRate > f.openRate) {
    return `${detail} —— 被缩的反而更容易被打开，预算确实在砍有用的东西：抬 maxChars 有据${legacyNote}`;
  }
  return `${detail} —— 被缩的并不比完整列出的更容易被打开：抬 maxChars 的收益看不出来${legacyNote}`;
}

/** 原因码 → 人话。统计里出现没列过的码时原样显示（别把新码藏起来）。 */
export const REASON_LABELS = {
  chitchat: '寒暄 / 答话（设计如此）',
  'too-short': '消息太短',
  'empty-message': '空消息',
  duplicate: '与上一轮重复',
  'store-not-configured': '没配库路径',
  'index-empty': '库里没有笔记',
  'no-hits': '一条都不匹配',
  'below-min-score': '被 minScore 拦住',
  // 命中了、却连一个裸文件名都塞不进预算（注入头 + 下限 160 字都放不下）：
  // 它和「没命中」是两回事，混在一个码里就分不清该抬预算还是该抬门槛。
  'budget-too-small': '预算太小，一条都放不下',
  suppressed: '这几条被门控拦下了（带进上下文很多次、一次都没被用上）',
  unspecified: '没记原因（早期日志）',
};

/** 原因码 → 人话（未知码原样返回，不编故事）。 */
export const reasonLabel = (code) => REASON_LABELS[code] ?? String(code ?? '');

/**
 * 给人看的层里要翻译的键名（Node 侧唯一一份：CLI 周报、`recall-stats` 都读它）。
 *
 * ⚠️ 面板 `client/client.js` 里另有一份同内容的表 —— 它是浏览器 bundle，import 不到这里。
 * 两份的**一致性由测试兜着**（`test/term-words.test.mjs` 逐对比较两边源码里的字面量），
 * 谁改了一边忘了另一边，测试会红。别再手抄第三份。
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const TERM_WORDS = [
  ['minScore', '相关度门槛'],
  ['maxChars', '字数上限'],
  ['maxPointers', '每次提醒条数'],
  ['collapsedIds', '缩掉的是哪几条'],
  ['usedCounted', '真正被读过的条数'],
  ['openRate', '被用上的比例'],
  ['budgetUse', '预算用量'],
  ['freeCap', '零代价上限'],
  ['legacy', '早期记录'],
  ['unaligned', '对不上号的旧记录'],
];

/**
 * 把判据句里的专业键名换成人话（见 TERM_WORDS）。CLI 周报与面板同一套词。
 * 顺带收掉中文之间多余的那个空格 —— 键名两侧本来带空格，直译会读成「抬 相关度门槛 只会…」。
 */
export function plainTerms(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [key, word] of TERM_WORDS) out = out.split(key).join(word);
  return out.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1');
}

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
