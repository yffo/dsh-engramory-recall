/**
 * 合成语料 + 查询集：给召回质量造一把**可复现**的尺子。
 *
 * 为什么需要它：`scripts/recall-probe.mjs` 跑的是真实记忆库 —— 数字最可信，但内容
 * 不能进仓库（私人事实），而且换台机器、换个库就对不上。这里补上公开的那一半：
 * 同一 seed 每次生成完全相同的语料，谁都能 `npm run bench` 复算。
 *
 * 尺子不被自己掰弯的几条规矩：
 *   1. **笔记只用术语写法**（前端构建 / 进程退出），**查询只用口语写法**（打包 / 崩了），
 *      两者字面不重叠 —— 这道题考的是同义桥，不是字符串匹配。
 *   2. **所有笔记共用同一套模板措辞**（真实库里 project 模板就是这样），于是「域 + 事件」
 *      两个词是唯一判别信号，跟真实库一样容易混淆。
 *   3. **35% 的笔记写成英文术语版**（cache / latency），此时中文口语查询要跨语言才命中。
 *   4. 桥接词按 seed 固定切成**公开组**与**留出组（held-out）**：调同义表时只看公开组，
 *      留出组只用来汇报泛化 —— 避免「把尺子改成自己想要的样子」。
 *   5. 语料是虚构的：没有人名、真实路径、真实笔记内容。测试里有一条断言专门守它。
 */

const DAY_MS = 86400000;
/** 固定"现在"，否则 mtime 一漂，分数就跟着漂，A/B 不可比。 */
export const BENCH_NOW = Date.parse('2026-10-15T00:00:00Z');

/** 16 个域：`zh` 是笔记里的术语写法，`colloquial` 是用户嘴里的说法，`token` 是域内特征词。 */
export const DOMAINS = [
  { key: 'build', zh: '前端构建', colloquial: '打包', en: 'build', token: 'sourcemap', probe: '清缓存重新构建一次', fix: '固定 lockfile 与 node 版本', metric: '构建耗时' },
  { key: 'cache', zh: '查询缓存', colloquial: '缓存', en: 'cache', token: 'ttl', probe: '用同一参数连打两次', fix: '把失效键与 ttl 收进一处配置', metric: '命中率' },
  { key: 'migration', zh: '数据库迁移', colloquial: '改表结构', en: 'migration', token: 'backfill', probe: '在影子库上重放一次', fix: '把回填拆成可重跑的小步', metric: '行数' },
  { key: 'pipeline', zh: 'CI 流水线', colloquial: '自动检查', en: 'pipeline', token: 'runner', probe: '本地跑同一组命令', fix: '固定 runner 镜像标签', metric: '排队时长' },
  { key: 'auth', zh: '鉴权', colloquial: '登录态', en: 'auth', token: 'token', probe: '用过期 token 手工重放', fix: '把刷新逻辑收到一个模块里', metric: '401 比例' },
  { key: 'logging', zh: '日志采集', colloquial: '打日志', en: 'logging', token: 'rotation', probe: '对比采集端与落盘文件', fix: '给轮转加大小上限', metric: '落盘延迟' },
  { key: 'locking', zh: '并发加锁', colloquial: '抢锁', en: 'concurrency', token: 'mutex', probe: '并发起八个进程', fix: '把锁粒度降到单条记录', metric: '等待时长' },
  { key: 'memory', zh: '内存占用', colloquial: '吃内存', en: 'memory', token: 'rss', probe: '连续跑三十分钟看曲线', fix: '复用大对象池', metric: '常驻集' },
  { key: 'http', zh: '接口请求', colloquial: '调接口', en: 'http', token: 'retry', probe: '用 curl 复现同一个请求', fix: '退避重试加抖动', metric: 'P95' },
  { key: 'publish', zh: '包发布', colloquial: '发包', en: 'publish', token: 'tarball', probe: '在空目录里装一次', fix: '发版前核对 pack 清单', metric: '安装体积' },
  { key: 'automation', zh: '浏览器自动化', colloquial: '自动点网页', en: 'automation', token: 'selector', probe: '关掉无头模式手工点一遍', fix: '选择器改用稳定属性', metric: '失败率' },
  { key: 'ranking', zh: '检索排序', colloquial: '找不着', en: 'ranking', token: 'bm25', probe: '固定查询集跑一遍', fix: '提高字段权重', metric: '命中率' },
  { key: 'timezone', zh: '时区换算', colloquial: '时间对不上', en: 'timezone', token: 'utc', probe: '两端各打一次时间戳', fix: '统一存 UTC、只在渲染时换', metric: '偏差分钟' },
  { key: 'dependency', zh: '依赖升级', colloquial: '升版本', en: 'dependency', token: 'peer', probe: '用全新 node_modules 装一次', fix: '锁到小版本区间', metric: '冲突数' },
  { key: 'backup', zh: '备份恢复', colloquial: '找回文件', en: 'backup', token: 'snapshot', probe: '从快照恢复到空目录', fix: '给快照加校验和', metric: '可恢复点' },
  { key: 'desktop', zh: '桌面宿主', colloquial: '客户端', en: 'desktop', token: 'ipc', probe: '在打包产物里复现', fix: '把通道名收进常量', metric: '崩溃次数' },
];

/** 14 类事件：`zh` 是笔记里的写法，`colloquial` 是用户的说法，`symptom` 是现象描述。 */
export const EVENTS = [
  { key: 'crash', zh: '进程退出', colloquial: '崩了', en: 'crash', symptom: '日志末尾只有一行栈，退出码 1', symptomEn: 'the process exits with code 1 and a single stack line', signal: '退出码', guard: '退出码断言' },
  { key: 'slow', zh: '响应变慢', colloquial: '慢得没法用', en: 'latency', symptom: 'P95 从 200ms 涨到 4s', symptomEn: 'P95 climbs from 200ms to 4s', signal: '耗时直方图', guard: '耗时上限' },
  { key: 'wrong', zh: '结果不对', colloquial: '数算错了', en: 'wrong-result', symptom: '同一输入两次跑出不同结果', symptomEn: 'the same input yields two different results', signal: '校验和', guard: '结果快照' },
  { key: 'install', zh: '安装失败', colloquial: '装不上', en: 'install-failed', symptom: '报 peer dependency 冲突', symptomEn: 'a peer dependency conflict is reported', signal: '安装日志', guard: '安装冒烟' },
  { key: 'loss', zh: '数据丢失', colloquial: '东西没了', en: 'data-loss', symptom: '重启后记录少了一半', symptomEn: 'half the records are gone after restart', signal: '行数对账', guard: '行数对账' },
  { key: 'denied', zh: '权限被拒', colloquial: '没权限', en: 'forbidden', symptom: '返回 403 且审计里没有对应条目', symptomEn: 'a 403 with no matching audit entry', signal: '状态码', guard: '权限用例' },
  { key: 'leak', zh: '内存增长', colloquial: '内存一直涨', en: 'leak', symptom: '常驻集只涨不落', symptomEn: 'the resident set only grows', signal: '常驻集曲线', guard: '长跑用例' },
  { key: 'conflict', zh: '版本冲突', colloquial: '版本打架', en: 'conflict', symptom: '两个依赖要不同的大版本', symptomEn: 'two dependencies want different majors', signal: '解析树', guard: '版本区间检查' },
  { key: 'silent', zh: '静默失效', colloquial: '悄悄不生效', en: 'silent-failure', symptom: '不报错但结果没有变化', symptomEn: 'no error, but the result never changes', signal: '结果差异', guard: '变更断言' },
  { key: 'duplicate', zh: '重复触发', colloquial: '跑了两次', en: 'duplicate', symptom: '同一条任务出现两遍', symptomEn: 'the same job runs twice', signal: '任务 id', guard: '幂等键' },
  { key: 'hang', zh: '无响应', colloquial: '卡住不动', en: 'hang', symptom: '进程还在但不再输出', symptomEn: 'the process lives but stops printing', signal: '心跳', guard: '心跳超时' },
  { key: 'config', zh: '配置不生效', colloquial: '改了没用', en: 'config', symptom: '配置文件被更高优先级的那份覆盖', symptomEn: 'a higher-priority file overrides the config', signal: '生效值', guard: '配置快照' },
  { key: 'mojibake', zh: '编码错乱', colloquial: '乱码', en: 'encoding', symptom: '中文变成问号', symptomEn: 'Chinese text turns into question marks', signal: '字节序', guard: '编码断言' },
  { key: 'rollback', zh: '回滚困难', colloquial: '退不回去', en: 'rollback', symptom: '迁移脚本没有反向路径', symptomEn: 'the migration has no reverse path', signal: '反向脚本', guard: '回滚演练' },
];

const KINDS = ['project', 'reference', 'feedback', 'user'];

/** 通用填充句：只增加篇幅与噪声，不参与判别 —— 真实笔记里这种话也占大头。 */
const FILLER = [
  '当时手上还有别的活，所以先记一笔，免得下次从零查。',
  '结论是暂时的：等观测数据再多一周，可能还要调。',
  '这次的改动只动了两处，其余保持原样。',
  '同一台机器上另一个项目也复现过类似现象，判据不一样。',
  '排查过程中留下的临时脚本已经删掉，只把结论留在这里。',
];

import { SYNONYMS } from '../bm25.js';

/** 反查表：技术词 → 能桥到它的口语键。用来判断「这组词表里到底有没有桥」。 */
const KEYS_FOR_VALUE = (() => {
  const map = new Map();
  for (const [key, values] of SYNONYMS) {
    for (const value of values) {
      const term = String(value).toLowerCase();
      if (!map.has(term)) map.set(term, []);
      map.get(term).push(key);
    }
  }
  return map;
})();

export const keysFor = (term) => KEYS_FOR_VALUE.get(String(term).toLowerCase()) ?? [];

/** 查询里的「内容单元」：中文逐字 + 拉丁词。用来判断这条查询在笔记里有没有字面落点。 */
export function queryUnits(query) {
  const units = new Set();
  for (const token of String(query).toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? []) units.add(token);
  return units;
}

/**
 * 字面重叠率：查询的内容单元有多大比例能在笔记正文/标题/描述里找到字面落点。
 * 0 表示「字面上完全对不上」—— 这种查询要命中就只能靠同义桥或别名。
 */
export function literalOverlap(query, doc) {
  const units = [...queryUnits(query)];
  if (units.length === 0) return 0;
  const haystack = `${doc.title}\n${doc.description}\n${doc.body}`.toLowerCase();
  let hit = 0;
  for (const unit of units) if (haystack.includes(unit)) hit += 1;
  return hit / units.length;
}

const textOf = (doc) => `${doc.title}\n${doc.description}\n${doc.body}`.toLowerCase();

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** 留出判定：同一对桥接词永远落在同一组（0–9 的哈希里 0/1/2 为留出 ≈ 30%）。 */
export function holdOutOf(domainKey, eventKey) {
  const s = `${domainKey}|${eventKey}`;
  let h = 7;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 1000;
  return h % 10 < 3;
}

/** 口语体笔记：作者用自己的话记的（真实库里「飞书连不上」这类标题就是这么来的）。 */
function bodyColloquial(d, e, rng) {
  const noise = `${pick(rng, FILLER)} ${pick(rng, FILLER)}`;
  return [
    '## 什么情况',
    `${d.colloquial}的时候${e.colloquial}，${e.symptom}。`,
    `盯着${d.metric}看了一会儿，拐点很明显。`,
    '',
    '## 怎么查的',
    `先${d.probe}，再看${e.signal}。环境差异排掉之后就稳定复现了。`,
    `顺便看了 ${d.token}，取值和配置里写的一样，所以不是手滑写错。`,
    '',
    '## 怎么好的',
    `${d.fix}，顺手把${e.guard}加进了回归用例。${noise}`,
  ].join('\n');
}

function bodyZh(d, e, rng) {
  const noise = `${pick(rng, FILLER)} ${pick(rng, FILLER)}`;
  return [
    '## 现象',
    `${d.zh}出现「${e.zh}」：${e.symptom}。${d.metric}在监控里能看到拐点。`,
    '',
    '## 排查',
    `先${d.probe}，再看${e.signal}。排除掉环境差异之后，问题稳定复现。`,
    `顺带确认了 ${d.token} 的取值与预期一致，所以不是配置写错。`,
    '',
    '## 处理',
    `${d.fix}，并把${e.guard}加进回归用例。${noise}`,
  ].join('\n');
}

const NOISE_EN = [
  'Kept the temporary script out of the repo; only the conclusion stays here.',
  'The conclusion is provisional until another week of metrics lands.',
  'Only two spots changed this time, everything else was left alone.',
  'A second project on the same box showed a similar shape with a different trigger.',
  'Cleaned up the throwaway probe script; the finding is the only thing worth keeping.',
];

function bodyEn(d, e, rng) {
  const noise = `${pick(rng, NOISE_EN)} ${pick(rng, NOISE_EN)}`;
  return [
    '## Symptom',
    `${d.en} ${e.en}: ${e.symptomEn}. The ${d.metric} dashboard shows a knee at the same minute.`,
    '',
    '## Diagnosis',
    `Reproduce by ${d.probe}; then read the ${e.signal}. After ruling out environment drift it reproduces every time.`,
    `Checked ${d.token} as well — the value matches what the config says, so it is not a typo.`,
    '',
    '## Fix',
    `${d.fix}, and add a ${e.guard} to the regression suite. ${noise}`,
  ].join('\n');
}

/**
 * 生成语料与查询。
 * @param {{seed?: number, englishShare?: number, aliasShare?: number}} [options]
 * @returns {{docs: Array, queries: Array, meta: object}}
 */
export function buildCorpus(options = {}) {
  const seed = options.seed ?? 20261015;
  const englishShare = options.englishShare ?? 0.3;
  const colloquialShare = options.colloquialShare ?? 0.2;
  const aliasShare = options.aliasShare ?? 0.2;
  const rng = makeRng(seed);
  const docs = [];
  const queries = [];
  const bridgeDropped = [];

  // 域 × 事件的笛卡尔积：16 × 14 = 224 篇。同域不同事件、同事件不同域都成了近邻干扰项。
  for (const d of DOMAINS) {
    for (const e of EVENTS) {
      const idx = docs.length;
      const dice = rng();
      // 桥样本：域词与事件词都在同义表里有桥键的单元格，强制写成英文术语体裁 ——
      // 这样查询（口语键）与正文（技术词）两侧都能被构造校验，命中即为「表真的被用上了」。
      const domainKeys = keysFor(d.en);
      const eventKeys = keysFor(e.en);
      const bridgeCandidate = domainKeys.length > 0 && eventKeys.length > 0;
      const dialect = bridgeCandidate
        ? 'en'
        : dice < englishShare ? 'en' : dice < englishShare + colloquialShare ? 'colloquial' : 'zh';
      const kind = pick(rng, KINDS);
      const id = `${kind}-${d.key}-${e.key}.md`;
      const zhTitle = `${d.zh}：${e.zh}`;
      const enTitle = `${d.en} ${e.en}`;
      const colloquialTitle = `${d.colloquial}的时候${e.colloquial}`;
      const title = dialect === 'en' ? enTitle : dialect === 'colloquial' ? colloquialTitle : zhTitle;
      const description = dialect === 'en'
        ? `${d.en} ${e.en}：${e.symptomEn}`
        : dialect === 'colloquial'
          ? `${d.colloquial}${e.colloquial}：${e.symptom}`
          : `${d.zh}出现「${e.zh}」：${e.symptom}`;
      // 作者点名的别名：真实库里只有一部分笔记会写，所以这里也只发给一部分。
      // 口径要说清楚 —— 别名发给谁，谁就在口语查询里直接命中；没发的只能靠同义表去猜。
      const hasAlias = rng() < aliasShare;
      const aliases = hasAlias
        ? [dialect === 'colloquial' ? zhTitle : colloquialTitle, dialect === 'en' ? zhTitle : enTitle].filter(Boolean)
        : [];
      const doc = {
        id,
        title,
        description,
        aliases,
        body: dialect === 'en' ? bodyEn(d, e, rng) : dialect === 'colloquial' ? bodyColloquial(d, e, rng) : bodyZh(d, e, rng),
        // 时间上错开：让「新旧」这一维有跨度可测（衰减默认关闭，但消融要能量）。
        mtimeMs: BENCH_NOW - Math.round((idx * 1.37 + 3) * DAY_MS),
        // 以下字段不喂索引，只给指标与诊断用。
        dialect,
        kind,
        domain: d.key,
        event: e.key,
        token: d.token,
      };
      docs.push(doc);
      const heldOut = holdOutOf(d.key, e.key);
      /**
       * 桥组（构造校验）：查询词取自同义表的口语键，且**在笔记里一个字都没有**；
       * 表里对应的技术词则必须在正文里字面在场。命中 ⇒ 表被用上了；不命中 ⇒ 桥没接上。
       * ⚠️ 口径边界：这组用的是引擎自己读的那张表，所以它证明的是「管道通不通」，
       * 不是泛化；泛化看留出组（表里那批没参与调参的词族）。
       */
      if (bridgeCandidate) {
        const haystack = textOf(doc);
        const clean = (keys) => keys.filter((key) => ![...key].some((ch) => haystack.includes(ch)));
        const domainKey = clean(domainKeys)[0];
        const eventKey = clean(eventKeys)[0];
        if (domainKey && eventKey) {
          queries.push({
            id: `q-bridge-${d.key}-${e.key}`,
            q: `${domainKey} ${eventKey}`,
            gold: id,
            style: 'bridge',
            dialect,
            heldOut,
            bridgedBy: [domainKey, eventKey],
          });
        } else {
          bridgeDropped.push(`${id}（${domainKey ? '' : `域词 ${d.en} 的口语键都带字面碎片`}${!domainKey && !eventKey ? '；' : ''}${eventKey ? '' : `事件词 ${e.en} 的口语键都带字面碎片`}）`);
        }
      }
      queries.push({
        id: `q-verbatim-${d.key}-${e.key}`,
        q: dialect === 'en' ? `${d.en} ${e.en}` : dialect === 'colloquial' ? `${d.colloquial} ${e.colloquial}` : `${d.zh} ${e.zh}`,
        gold: id,
        style: 'verbatim',
        dialect,
        heldOut,
      });
      const tail = pick(rng, ['', '', '，怎么查', ' 又出现了', ' 怎么办']);
      queries.push({
        id: `q-colloquial-${d.key}-${e.key}`,
        q: `${d.colloquial} ${e.colloquial}${tail}`.trim(),
        gold: id,
        style: 'colloquial',
        dialect,
        heldOut,
      });
      queries.push({
        id: `q-keyword-${d.key}-${e.key}`,
        q: `${e.colloquial} ${d.token}`,
        gold: id,
        style: 'keyword',
        dialect,
        heldOut,
      });
    }
  }

  const dial = (name) => docs.filter((x) => x.dialect === name).length;
  const meta = {
    seed,
    notes: docs.length,
    queries: queries.length,
    zhNotes: dial('zh'),
    englishNotes: dial('en'),
    colloquialNotes: dial('colloquial'),
    aliasedNotes: docs.filter((x) => x.aliases.length > 0).length,
    heldOutNotes: docs.filter((x) => holdOutOf(x.domain, x.event)).length,
    bridgeQueries: queries.filter((x) => x.style === 'bridge').length,
    bridgeDropped,
    // 同义表对这套词汇的覆盖率：表是按真实库长的，换一套词就未必有桥 —— 这个数字就是证据。
    domainWords: DOMAINS.length,
    domainCovered: DOMAINS.filter((x) => keysFor(x.en).length > 0).length,
    eventWords: EVENTS.length,
    eventCovered: EVENTS.filter((x) => keysFor(x.en).length > 0).length,
  };
  return { docs, queries, meta };
}
