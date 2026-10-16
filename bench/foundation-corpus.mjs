/**
 * 「地基句」题集：量的是**模型到底看没看见那句话**，而不是笔记有没有被找到。
 *
 * 为什么要有这把尺子：`bench/run.mjs` 量的是「召回到没召回到」（hit@1 / hit@K），
 * 但真正决定记忆有没有用的，是**注入进上下文的那一小段里有没有那句决定性的话**。
 * 全球调研里这条叫「保地基」：同一套题，朴素 BM25 的逐字保住率 36.8，做过分句与
 * 预算的系统 68.4（灵枢 hive-memory-bench 的公开数字）。我们此前没有这把尺子。
 *
 * 语料怎么造（三条防自欺的规矩）：
 *   1. **干扰句比地基句「更像命中」**：每篇笔记的 `## 什么情况` / `## 怎么好的` 里
 *      塞满查询里的**通用词**（口语域词、口语事件词、日志/复现/结论这类叙事词），
 *      地基句则只带一个**罕见词**。按「命中词数」挑行的老做法会挑中干扰句，
 *      按 IDF 挑行的做法才会挑中地基句 —— 这就是这把尺子要分开的两件事。
 *   2. **罕见词真的罕见**：`unique` 组里它只出现在一篇笔记里（df = 1），
 *      `shared` 组里三篇共用（考「找对笔记」顺带能不能保住句子）。
 *   3. **留出组不参与调参**：按 seed 把题分 `tune` / `heldOut` 两半，调参只看 tune。
 *
 * 语料是虚构的：没有真实项目名、路径、人名，术语是通用工程词汇。
 */
import { DOMAINS, EVENTS, BENCH_NOW } from './corpus.mjs';

/** 罕见词池：一半拉丁技术词、一半中文行话。**每个词在整份语料里都很稀有**（df 极小）。 */
export const RARE_TERMS = [
  'ENOTFOUND', 'ECONNRESET', 'sourcemap', 'peerDeps', 'snapshotId', 'deadlineExceeded',
  'idempotencyKey', 'retryBudget', 'tarball', 'utcOffset', 'ipc', 'coldStart', 'quorum',
  'shardKey', 'oplog', 'tombstone', 'watermark', 'fuzzSeed', 'sandboxProfile', 'sessionReplay',
  'readOnlyReplica', 'clockDrift', 'cacheStampede', 'circuitBreaker', 'samplingRate',
  'shadowTraffic', 'rollbackPoint', 'lockWait', 'queueBacklog', 'handleLeak', 'tailLatency',
  'jitterCap', 'backoffBase', 'probeEndpoint', 'warmupScript', 'standbySwitch', 'driftWindow',
  '影子库', '幂等键', '心跳包', '回填脚本', '灰度开关', '限流令牌', '冷启动', '脏读',
  '死信队列', '快照校验', '双写窗口', '时间线回溯', '折叠栈', '半开连接', '空转轮',
  '兜底路径', '只读副本', '主从延迟', '时钟漂移', '缓存击穿', '雪崩保护', '熔断阈值',
  '采样率', '影子流量', '灰度批次', '回滚点', '幂等窗口', '事务边界', '锁等待',
  '队列积压', '内存碎片', '句柄泄漏', '长尾延迟', '抖动上限', '退避基数', '心跳超时',
  '探针端点', '预热脚本', '冷备切换', '温备节点', '写放大', '读修复', '反压信号',
  '补偿事务', '窄表拆分', '宽表回填', '旁路开关', '灰度名单', '准入控制', '配额桶',
  '定向重放', '热补丁', '冷路径', '旁路埋点', '影子索引', '只写队列', '读扩散',
  '写屏障', '租约续期', '序列化边界', '分片再平衡', '副本追赶', '增量校验',
];

const KINDS = ['project', 'reference', 'feedback'];

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

/** 通用叙事词：出现在**每一篇**笔记里，专治「按命中词数挑行」。 */
const NARRATIVE = ['日志', '复现', '配置', '结论', '用例', '排查', '命令', '输出'];

/**
 * 造一篇笔记：干扰句用通用词铺满，地基句只带罕见词。
 * @returns {{doc: object, foundation: string, evidence: string[]}}
 */
function buildNote(rng, { index, domain, event, rare, group }) {
  const kind = pick(rng, KINDS);
  const id = `${kind}-${domain.key}-${event.key}-${index}.md`;
  const narr = pick(rng, NARRATIVE);
  const narr2 = pick(rng, NARRATIVE);
  // 地基句：三种写法，对应三种「要保住的东西」。
  const foundation = group === 'long'
    ? `把整条链路按时间顺序排开之后才看清，${domain.colloquial}这次的${event.colloquial}其实是 ${rare} 在切换时没有跟着刷新，每次请求都会退回旧值，${narr}里只留下一行不起眼的告警。`
    : group === 'dense'
      ? `${domain.colloquial}的${event.colloquial}根因就是 ${rare}：切换时 ${rare} 没有刷新，所以每次都退回旧值。`
      : `根因是 ${rare} 没有跟着一起更新 —— 每次${event.colloquial}都会退回旧值。`;
  const body = [
    '## 什么情况',
    `${domain.colloquial}那会儿出了${event.colloquial}，先把${narr}、${narr2}、复现步骤过了一遍，没看出问题。`,
    `现场是这样：${event.symptom}。这类${event.colloquial}以前也出现过，多半是自己手滑。`,
    `那天的排查记了好几页，${domain.colloquial}相关的${narr}、配置、时间线都写在里面。`,
    '',
    '## 怎么查的',
    foundation,
    `顺手看了${domain.metric}，取值和配置里写的一样，所以不是手滑写错。`,
    `复现跟${domain.colloquial}没关系，是另一台机器上的偶发，后来又出现两次。`,
    '',
    '## 怎么好的',
    `最后${domain.fix}，顺手把${event.guard}加进了回归用例。`,
    '结论是暂时的：等观测数据再多一周，可能还要调。',
  ].join('\n');
  const doc = {
    id,
    title: `${domain.colloquial}的时候${event.colloquial}`,
    description: `${domain.colloquial}${event.colloquial}：${event.symptom}`,
    aliases: [],
    body,
    mtimeMs: BENCH_NOW - Math.round((index * 1.31 + 2) * 86400000),
    // 以下字段不喂索引，只给指标与诊断用。
    dialect: 'colloquial',
    kind,
    domain: domain.key,
    event: event.key,
    rare,
    group,
  };
  return { doc, foundation, evidence: [rare] };
}

/** 查询三种写法：短（只有罕见词）/ 中（口语域词 + 罕见词）/ 长（真实口语句子）。 */
const QUERY_SHAPES = ['rare', 'mid', 'verbose'];

function queryFor(shape, domain, event, rare) {
  if (shape === 'rare') return rare;
  if (shape === 'mid') return `${domain.colloquial} ${rare}`;
  return `${domain.colloquial}的时候${event.colloquial}了，${rare}那块一直对不上，帮我看下`;
}

/**
 * 生成题集。
 * @param {{seed?: number, notes?: number}} [options]
 * @returns {{docs: object[], questions: object[], meta: object}}
 */
export function buildFoundationSet(options = {}) {
  const seed = options.seed ?? 20261016;
  const total = options.notes ?? 96;
  const rng = makeRng(seed);
  const docs = [];
  const questions = [];
  // 罕见词按**洗好的顺序**发：`unique` / `dense` / `long` 一人一个（df = 1），
  // `shared` 按三篇一组共用一个（考「找对笔记」时顺带能不能保住句子）。
  // 洗牌是确定性的（同一个 seed 每次一样），池子比题目多，保证不撞词。
  const pool = RARE_TERMS.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let rareCursor = 0;
  const nextRare = () => pool[rareCursor++ % pool.length];
  /**
   * 组别 / 形态 / 留出**各自独立抽**。
   * ⚠️ 第一版按 `i % 8`、`i % 3` 取模分配，结果 `heldOut` 与查询形态完全重合
   * （`i % 3 === 0` 既是 heldOut 又是 `rare` 形态），于是「留出组 87.5% vs 调参组 10.9%」
   * 这种假象就出来了 —— 那不是泛化，是两个变量被绑在了一起。三个维度必须分开抽。
   */
  const plan = [];
  for (let i = 0; i < total; i += 1) {
    const groupDraw = rng();
    const group = groupDraw < 0.10 ? 'long' : groupDraw < 0.25 ? 'dense' : groupDraw < 0.45 ? 'shared' : 'unique';
    const shape = QUERY_SHAPES[Math.floor(rng() * QUERY_SHAPES.length) % QUERY_SHAPES.length];
    plan.push({ i, group, shape, heldOut: rng() < 0.34 });
  }
  // shared 组按三篇一组共用罕见词：凑不满三个的组退回 unique，免得出现「两人共享」的半组。
  const sharedIndexes = plan.filter((p) => p.group === 'shared').map((p) => p.i);
  const sharedTerm = new Map();
  for (let k = 0; k + 2 < sharedIndexes.length; k += 3) {
    const term = nextRare();
    for (const idx of sharedIndexes.slice(k, k + 3)) sharedTerm.set(idx, term);
  }
  for (const p of plan) if (p.group === 'shared' && !sharedTerm.has(p.i)) p.group = 'unique';

  for (const p of plan) {
    const domain = DOMAINS[(p.i * 5) % DOMAINS.length];
    const event = EVENTS[(p.i * 3 + Math.floor(p.i / DOMAINS.length)) % EVENTS.length];
    const rare = p.group === 'shared' ? sharedTerm.get(p.i) : nextRare();
    const { doc, foundation, evidence } = buildNote(rng, { index: p.i, domain, event, rare, group: p.group });
    docs.push(doc);
    questions.push({
      id: `fq-${p.i}`,
      q: queryFor(p.shape, domain, event, rare),
      gold: doc.id,
      foundation,
      evidence,
      shape: p.shape,
      group: p.group,
      domain: domain.key,
      event: event.key,
      heldOut: p.heldOut,
    });
  }
  const meta = {
    seed,
    notes: docs.length,
    questions: questions.length,
    groups: [...new Set(questions.map((q) => q.group))].sort(),
    shapes: QUERY_SHAPES,
    tune: questions.filter((q) => !q.heldOut).length,
    heldOut: questions.filter((q) => q.heldOut).length,
  };
  return { docs, questions, meta };
}
