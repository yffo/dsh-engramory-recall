/**
 * 极简 BM25 —— 只为「在几十到几百条 markdown 笔记里做中文友好的关键词召回」。
 *
 * 设计取舍（与 Engramory 的既有口径一致）：
 *   - 零依赖、零出网、零模型：不引入 embedding，不下载模型，不做语义近似。
 *   - 中文用「单字 + 相邻双字」切分（和 memview 的检索口径相同），够用且可解释。
 *   - 英文词元再按连字符/斜杠/点拆一层：`html-ppt` 若整体成一个词元，查询里的 `ppt`
 *     就永远匹配不上（2026-10-14 实测「ppt 传上去样式全没了」漏召回的根因）。
 *   - 同义扩展：中文口语（「飞书」「连不上」）与笔记里的英文写法（feishu / ENOTFOUND）
 *     之间靠一张手写别名表搭桥，权重打折（EXTRA_WEIGHT）—— 它是「猜」，不该完全盖过字面命中。
 *   - 打分只用于「排序 + 挑一行当片段」，不是可信度，也不写回任何文件。
 *
 * k1/b 取常见默认值（与 DSH-SEP 的 BM25 同参），便于对照。
 */

const K1 = 1.2;
const B = 0.75;

/**
 * 同义扩展项的权重：字典里搭出来的桥，命中也不该完全压过查询里的原词。
 *
 * ⚠️ 这个数**试过改成 0.8，最后退回了 0.5** —— 记在这里免得后人再走一遍。
 *
 * 起因是真的：中文没有分词，短查询的词项就是它的**相邻双字**；查询里混着通用谓语时，
 * 谓语拆出来的双字往往全库罕见（df 低）→ IDF 偏高，人手写的同义桥反倒只拿一半权重。
 * 当时量到的数是：
 *   w=0.5 → 口语 query 19/22
 *   w=0.8 → 口语 query 20/22（代价：中文标题 top1 133/141 → 132/141）
 *
 * 但那个 19/22 是在**同义表还没补全时**量的。等同一批里最后几条桥补完，在同一份语料上
 * 重量，**0.5 和 0.8 的三项数字一模一样**（口径 19/21、对照 A 22/82、对照 B 136/142）
 * —— 那 1 分是补桥带来的，被记到了权重头上。既然换不来任何可测收益，就不该动它。
 *
 * 教训：**A/B 要在最终状态上做**。中途量出来的差值，可能只是「另一半还没做完」。
 */
const EXTRA_WEIGHT = 0.5;
/**
 * 字段加权：标题与描述里的词额外多计几遍（BM25F 的廉价近似）。
 *
 * 出处：灵枢 `dsh-memory` 的 `scoreEntry`（`lib/index.js:127-129`）给标题 3 分、
 * 标签 2 分、正文 1 分，理由是「在标题里出现」本身就是强信号。我们原来把
 * title/description/body 拼成一坨等权处理（`buildIndex`），于是「一篇长笔记
 * 正文里偶然提过一次」和「标题就叫这个」拿一样的分。
 *
 * 用「多计几遍」而不是真做字段分离：BM25 的长度归一化会跟着一起变，
 * 而短笔记的标题命中本来就该更值钱。
 *
 * 实测（2026-10-15，60 篇 / 172 chunk，指纹 c9f7fcbf9426）：
 *   值   口径     桥     别名   对照A top1/@4   对照B top1/@4
 *   0   20/21  10/10   5/5    20 / 79        134 / 144
 *   1   20/21  10/10   5/5    20 / 77        138 / 144
 *   3   20/21  10/10   5/5    21 / 91        141 / 146
 *   6   20/21  10/10   5/5    24 / 92        142 / 146
 *  24   20/21  10/10   5/5    33 / 93        142 / 146
 *
 * 取 3（灵枢那个 3:1 的设计值），**刻意不取扫描的极值**：口径是唯一的目标数，
 * 而它在 3 之后**一步都不再动** —— 说明后面那些增量全来自对照，而 README 写明
 * 「对照只是别掉分的底线」。拿对照当目标函数去调参，正是 EXTRA_WEIGHT 那次
 * 「把功劳记错对象」的同一个坑。3 已吃下绝大部分收益（对照A @4 +12、对照B top1 +7），
 * 且**没有任何一项变差**。真要往上抬，上面这张表就是证据。
 */
const TITLE_EXTRA = 3;
/**
 * 整句子串命中奖励：文档里逐字出现了整条查询时加的分。
 *
 * 出处：灵枢 `dsh-memory`（`lib/index.js:133`，它加 2 分）。
 * 对中文特别有意义：没有分词器时「浏览器起不来」被拆成 `浏览/览器/器起/起不/不来`，
 * 通用谓语的碎片反而 IDF 更高；而整句子串命中是**不需要分词器**的强证据。
 *
 * ⚠️ 风险（诚实写明）：这条奖励的是「逐字引用了查询」的笔记 —— 而那正是我们
 * 踩过两次的自污染形态（调优笔记抄了探针 query 就霸榜）。
 *
 * **实测否决（2026-10-15，在 TITLE_EXTRA=3 之上）**：
 *   PHRASE_BONUS   口径     对照A top1   对照B top1
 *       0         20/21      21         141
 *       2         20/21      20         142
 *       5         20/21      19         142
 *      10         20/21      17         142
 * 口径一步不动，对照A 单调恶化（21 → 17）—— 奖励「抄了查询的笔记」确实会把
 * 更该命中的那篇挤下去，与自污染的机理一致。**所以保持 0，机制留在代码里当证据**：
 * 将来若有人想加，先看这张表。常量与实现都保留，是为了让这次否决可复现，不是待办。
 */
const PHRASE_BONUS = 0;
/**
 * 单次查询最多参与打分的词项数（IDF 选词的 cap，抄 hindsight
 * `engine/search/bm25_term_selection.py`，与灵枢 `cn_recall_grams` 的 cap 同源）。
 * 超长消息里高频词对每个候选都加分，会淹没真正特异的词；只留最特异的这么多个。
 * 短查询本来就少于这个数，完全不受影响。
 */
const QUERY_TERM_CAP = 24;

/**
 * freshness 衰减：照抄灵枢 `rust/src/freshness.rs` 的口径（半衰期 30 天）。
 *
 * 它解决的是我们此前完全没有的一维：**同样匹配强度下，新的记忆该排在旧的前面**。
 * 原式 `decay = exp(-gamma × Δt)`，`gamma = ln2 / 半衰期`，Δt 按天，floor 到 SCORE_FLOOR。
 *
 * 我们省掉了它的 `protected_floor`（`importance × 乘子 ≥ 0.70`）：那层依赖人工标注的
 * importance 字段，而 Engramory 的笔记没有这个字段；等真需要时再从 frontmatter 读。
 */
/**
 * 灵枢原式的半衰期。**只作为参考值导出**：我们的库跨度只有 30 余天，这个值实测无净收益
 * （见 index.js 的 decayHalfLifeDays 注释），所以默认不启用；等库跨度上来后从它开始复测。
 */
export const SUGGESTED_HALF_LIFE_DAYS = 30;
const SCORE_FLOOR = 0.001;
const DAY_MS = 86400000;

/** 按「距上次改动多少天」算衰减乘子；无 mtime 或关闭衰减时恒为 1。 */
function decayFactor(mtimeMs, halfLifeDays, now) {
  if (!halfLifeDays || !mtimeMs) return 1;
  const ageDays = (now - mtimeMs) / DAY_MS;
  if (!(ageDays > 0)) return 1;
  return Math.max(SCORE_FLOOR, Math.min(1, Math.exp((-Math.LN2 / halfLifeDays) * ageDays)));
}

/**
 * 时间乘性加权（抄 hindsight `engine/search/reranking.py:35-37` 的 recency ±10% 口径）。
 *
 * 与上面 decay 的分工：decay 是**无界指数衰减**（半衰期 30 天能把半年前的笔记压到接近 0，
 * 实测会把基础事实类老笔记挤出召回位）；这里是**有界乘性扰动** —— 库内最新的一篇 ×(1+w)、
 * 最旧的一篇 ×(1−w)，中间的线性插值。w 默认 0（关闭），因为它的效果必须用 28 条查询实测。
 *
 * 为什么不用「距今多少天」而用「库内相对新旧」：我们库的时间跨度会变（现在 31.6 天，
 * 将来可能是两年），绝对天数的阈值很快失效；相对新旧永远把最新的顶上去、最旧的压下去，
 * 幅度还恒被 w 夹住。
 *
 * 2026-10-14 实测（28 条查询 / 51 篇笔记，扫 w = 0 / 0.05 / 0.1 / 0.15 / 0.2）：
 *   w=0    27/28   top1 21/28   对照组 26/28
 *   w=0.05 27/28   top1 21/28   对照组 26/28   ← 与关闭完全同分
 *   w=0.1  27/28   top1 21/28   对照组 25/28   ← 开始伤对照组
 *   w=0.15 27/28   top1 21/28   对照组 24/28
 *   w=0.2  26/28   top1 21/28   对照组 24/28   ← 连 recall 都掉
 * 结论：**没有任何净收益**，w≥0.1 起还要拿对照组（用文件名当查询，本该稳中）去换。
 * 与 decay 同因——库里「旧」的那批恰好是 feedback/user-profile 这类基础事实，
 * 压它们等于压正确答案。代码留着，等库真出现半年以上跨度再复测。
 */
function recencyBoost(mtimeMs, oldestMs, newestMs, weight) {
  if (!weight || !mtimeMs || !(newestMs > oldestMs)) return 1;
  const f = (mtimeMs - oldestMs) / (newestMs - oldestMs);
  return 1 + weight * (2 * Math.min(Math.max(f, 0), 1) - 1);
}

/**
 * 中文口语 → 技术写法的别名表。
 *
 * 键按**查询原文字面**匹配（includes），不走分词 —— 否则「连不上」会被切成「连不/不上」，
 * 三字口语永远查不到表。
 *
 * 收录纪律：只收「同一件事的两种叫法」，不收情绪近义词；键不短于 2 字（单字太泛，
 * 会污染一大批无关查询）。宁缺毋滥 —— 每多一条就多一分误召回。
 */
export const SYNONYMS = new Map(
  Object.entries({
    飞书: ['feishu', 'lark'],
    连不上: ['enotfound', 'econnrefused', 'timeout', 'dns'],
    打不开: ['404', '500', 'notfound'],
    查不到: ['404', 'notfound'],
    没反应: ['timeout', 'hang'],
    报错: ['error', 'exception'],
    超时: ['timeout'],
    崩了: ['crash'],
    卡住: ['hang', 'stuck'],
    样式: ['css', 'style'],
    样式全没: ['css', 'assets'],
    样式丢: ['css', 'assets'],
    没样式: ['css', 'assets'],
    丢失: ['missing', 'lost'],
    上传: ['upload', 'presign'],
    下载: ['download'],
    打包: ['build', 'bundle'],
    部署: ['deploy', 'release'],
    构建: ['build'],
    缓存: ['cache'],
    数据库: ['db', 'database', 'pg_dump', 'prisma'],
    登录: ['login', 'auth', 'prefetch', 'redirect', 'hydration'],
    权限: ['permission', 'auth'],
    截图: ['screenshot', 'peekaboo', 'tcc'],
    字体: ['font', 'woff'],
    主题: ['theme'],
    深色: ['dark'],
    浅色: ['light'],
    布局: ['layout'],
    接口: ['api'],
    搜索: ['search'],
    索引: ['index'],
    内存: ['memory'],
    备份: ['backup', 'restore', 'pg_dump'],
    域名: ['domain', 'dns'],
    证书: ['cert', 'ssl', 'tls', 'acme', 'certbot', 'letsencrypt', 'webroot'],
    密码: ['password', 'secret'],
    代理: ['proxy', 'trojan', 'hysteria2', 'vless', 'vmess', 'mihomo', 'clash', 'socks5', 'tunnel'],
    节点: ['node', 'ping', 'relay', 'tunnel'],
    // ── 2026-10-14 扩容 ──────────────────────────────────────────────────
    // 证据：探针里 3 条口语 query 打不中目标笔记（「浏览器起不来」「数据库地址写在
    // 配置里就报错」「换个库去调模型就失败了」），根因都是**字面零重叠** —— 口语说的
    // 和笔记里写的不是同一个词。这一批就是补这些桥。
    //
    // 纪律：只收「同一件事的两种叫法」，不收「相关的两件事」。宽词（比如把「地址」
    // 直接映射到 url/host）会把不相干的笔记一起抬上来，EXTRA_WEIGHT=0.5 也压不住 ——
    // 每加一批都要跑回归对照（文件名当查询 / 中文标题当查询），掉分就退。
    浏览器: ['browser', 'chrome', 'chromium', 'playwright', 'puppeteer'],
    起不来: ['unavailable', 'failed', 'crash', '不可用', '打不开', '不工作'],
    用不了: ['unavailable', 'failed', 'broken', '不可用', '失效'],
    连接串: ['database_url', 'dsn', 'url'],
    数据库地址: ['database_url', 'dsn'],
    配置: ['config', 'env'],
    模型: ['model', 'llm', 'deepseek', 'openai', 'gpt'],
    调模型: ['api', 'llm', 'deepseek', 'openai'],
    调用: ['api', 'call'],
    依赖: ['deps', 'dependencies', 'node_modules', 'package'],
    装不上: ['enoent', 'failed'],
    没权限: ['permission', 'denied', 'forbidden', 'tcc'],
    权限不足: ['permission', 'denied', 'tcc'],
    空仓库: ['empty', 'clone'],
    重复: ['duplicate', 'dup'],
    原始数据: ['json', 'raw'],
    编辑器: ['editor', 'blocknote', 'codemirror'],
    表单: ['form', 'input'],
    图片: ['image', 'img'],
    生成: ['generate'],
    刷新: ['reload', 'refresh'],
    崩: ['crash'],
    失败: ['failed', 'error', 'failure'],
    上线: ['production', 'deploy', 'release', 'prod'],
    线上: ['production', 'prod', 'online'],
    本地: ['local', 'localhost', 'dev', '本机'],

    // ── 下面这批是**挖出来**的，不是想出来的 ──────────────────────────
    // 方法：先问「语料里真实存在哪些有区分度的锚点词」（df 低 = 专有名词/技术栈名），
    // 再倒推杨总会用哪句大白话去问它。**语料里不存在的锚点一个都不写** —— 写了也永远
    // 是零分，只会让表看起来很长。所以这张表是「中文口语 → 本库实际用词」的桥，
    // 不是通用词典。换一个库，这张表就该重挖。
    梯子: ['proxy', 'trojan', 'hysteria2', 'vless', 'vmess', 'mihomo', 'clash', 'socks5'],
    翻墙: ['proxy', 'tunnel', 'trojan', 'hysteria2'],
    科学上网: ['proxy', 'tunnel', 'hysteria2'],
    节点慢: ['ping', 'relay', 'mbps'],
    线路: ['relay', 'tunnel', 'mbps', 'route'],
    网速: ['mbps', 'ping'],
    卸载: ['uninstall', 'removal', 'purge', 'prune'],
    删干净: ['uninstall', 'removal', 'purge', 'prune'],
    残留: ['removal', 'launchd', 'launchctl', 'prune'],
    自启: ['launchd', 'launchctl', 'systemd', 'resurrect', 'bootout', 'disown'],
    开机启动: ['launchd', 'systemd', 'resurrect', 'bootout'],
    进程: ['process', 'pm2', 'systemd', 'resurrect'],
    服务: ['service', 'pm2', 'systemd', 'daemon'],
    续期: ['renew', 'certbot', 'acme', 'webroot'],
    过期: ['renew', 'expired', 'certbot'],
    分享图: ['og', 'opengraph', 'satori', 'ogimageurl'],
    缩略图: ['og', 'opengraph', 'satori'],
    选品: ['sourcing', 'seller', 'temu', 'ecommerce'],
    选款: ['sourcing', 'seller', 'temu'],
    电商: ['ecommerce', 'seller', 'temu', 'rpa'],
    体检: ['doctor', 'audit', 'auditstore'],
    巡检: ['doctor', 'audit'],
    沙箱: ['sandbox', 'writableroots', 'workspaceroot'],
    写不进去: ['sandbox', 'writableroots', 'write'],
    工作区: ['workspace', 'worktree', 'handoff'],
    交接: ['handoff', 'worktree', 'workspace'],
    暗色: ['dark', 'light-dark', 'data-theme', 'theme'],
    夜间模式: ['dark', 'light-dark', 'data-theme'],
    样式失效: ['light-dark', 'color-mix', 'css'],
    跳转: ['redirect', 'prefetch'],
    预取: ['prefetch', 'redirect'],
    首屏: ['hydration', 'ssr', 'render'],
    端口: ['eaddrinuse', 'port', 'address'],
    图床: ['upload', 'presign', 's3'],
    打印: ['printtopdf', 'print', 'pdf'],
    幻灯片: ['ppt', 'presentation'],
    演示: ['ppt', 'presentation'],
    记忆库: ['engramory', 'memory', 'bm25'],
    召回: ['recall', 'search', 'bm25'],
    归档: ['archive', 'history'],
  }),
);

/** 中英混排分词：英文/数字按连续词元，汉字拆单字并补相邻双字。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9_+.#/-]{2,}/g) ?? []) {
    out.push(w);
    // 再拆一层：`html-ppt` → html + ppt；`css/js` → css + js。只取长度 ≥2 的碎片，
    // 免得把版本号（v0.2.3）炸成一堆单字符噪声。
    if (/[-/.]/.test(w)) {
      for (const part of w.split(/[-/.]+/)) if (part.length >= 2) out.push(part);
    }
  }
  for (const run of s.replace(/[^\u4e00-\u9fff]/g, ' ').split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 查询词项去重（打分时同一词项不重复计权）。 */
export function queryTerms(text) {
  return [...new Set(tokenize(text))];
}

/** 按原文字面捞同义词；返回已去重的扩展词项（不含查询自身的词）。 */
export function expandQuery(text) {
  const s = String(text ?? '').toLowerCase();
  const base = new Set(queryTerms(text));
  const out = [];
  for (const [word, syns] of SYNONYMS) {
    if (!s.includes(word)) continue;
    // 同义词表里的词**必须先过一遍 tokenize** 再当词项用：库里的词项是「英文整词 +
    // 汉字相邻双字」，所以中文同义词（如 `不可用`）直接拿去 `doc.tf.has()` 永远查不到，
    // 是一条只会静默失效的路（2026-10-14 实测发现）。英文同义词 tokenize 后仍是自身，
    // 不受影响；`html-ppt` 这类还能顺带贡献 html + ppt 两个碎片。
    for (const syn of syns) {
      for (const term of tokenize(syn)) if (!base.has(term)) out.push(term);
    }
  }
  return [...new Set(out)];
}

/**
 * 建索引：docs = [{ id, title, description, body, lines, aliases, mtimeMs }]
 * 只保存词频与长度，检索时现算 —— 语料是几十 KB 级，不值得上倒排表。
 *
 * @param {{halfLifeDays?: number, recencyWeight?: number, now?: number}} [options]
 *   `halfLifeDays` 缺省或为 0 时**关闭**衰减（乘子恒为 1）—— 实测无净收益，见 index.js
 *   同名配置的注释；显式传天数才启用。`recencyWeight` 是另一维（有界 ±w 的时间加权，
 *   见 recencyBoost），缺省 0 = 关闭。`now` 便于测试注入时间。
 */
export function buildIndex(docs, options = {}) {
  const halfLifeDays = options.halfLifeDays ?? 0;
  const recencyWeight = options.recencyWeight ?? 0;
  const now = options.now ?? Date.now();
  // 相对新旧需要库内的时间跨度（见 recencyBoost）：先扫一遍 mtime 定两端。
  const times = docs.map((doc) => Number(doc.mtimeMs) || 0).filter((n) => n > 0);
  const oldestMs = times.length ? Math.min(...times) : 0;
  const newestMs = times.length ? Math.max(...times) : 0;
  const prepared = docs.map((doc) => {
    const text = [doc.title, doc.description, doc.body].filter(Boolean).join('\n');
    // 笔记自己声明的别名（frontmatter `aliases:`）按重复两遍计入，算作者点名的同义钩子；
    // 没写 aliases 的笔记不受影响。
    const aliases = Array.isArray(doc.aliases) ? doc.aliases.filter(Boolean).join(' ') : '';
    const tokens = tokenize(aliases ? `${text}\n${aliases} ${aliases}` : text);
    // 字段加权：标题/描述里的词额外多计几遍（见 TITLE_EXTRA）。默认关闭时整段不执行。
    if (TITLE_EXTRA > 0) {
      const head = [doc.title, doc.description].filter(Boolean).join('\n');
      if (head) for (let i = 0; i < TITLE_EXTRA; i += 1) tokens.push(...tokenize(head));
    }
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return {
      ...doc,
      tf,
      len: tokens.length || 1,
      // 整句子串命中用的小写全文（见 PHRASE_BONUS）。关闭时不建，省一份内存。
      plain: PHRASE_BONUS > 0 ? text.toLowerCase() : '',
      decay: decayFactor(doc.mtimeMs, halfLifeDays, now),
      boost: recencyBoost(doc.mtimeMs, oldestMs, newestMs, recencyWeight),
    };
  });
  // 切桶的长笔记：同一个 id 的所有桶共享「整篇长度」。若各桶只按自身长度归一，
  // 267KB 的巨兽会靠 45 个短桶在长度惩罚里白占便宜（2026-10-14 实测霸榜因此升到 27/30）。
  const totalLen = new Map();
  for (const doc of prepared) totalLen.set(doc.id, (totalLen.get(doc.id) ?? 0) + doc.len);
  for (const doc of prepared) doc.len = totalLen.get(doc.id) ?? doc.len;
  // 平均长度按「笔记」而不是「桶」统计：否则碎桶会把基准拉低，反而放松对长文的惩罚。
  const sum = [...totalLen.values()].reduce((n, v) => n + v, 0);
  return { docs: prepared, avgLen: sum / (totalLen.size || 1) || 1 };
}

/**
 * 召回：返回按分排序的命中（score > 0 才返回）。
 * @returns {Array<{id, score, snippet, matched}>}
 */
export function search(index, query, limit = 5) {
  const base = queryTerms(query);
  const extras = expandQuery(query);
  if (!base.length && !extras.length) return [];

  // 整句子串命中的针（见 PHRASE_BONUS）。太短的查询不判：像「线上」这种两个字，
  // 逐字命中满库都是，只会制造噪声。
  const needle = PHRASE_BONUS > 0 ? String(query ?? '').trim().toLowerCase() : '';
  const usePhrase = needle.length >= 2;

  const weights = new Map();
  for (const term of base) weights.set(term, 1);
  for (const term of extras) if (!weights.has(term)) weights.set(term, EXTRA_WEIGHT);
  const terms = [...weights.keys()];

  const { docs, avgLen } = index;
  const df = new Map();
  for (const term of terms) {
    let n = 0;
    for (const doc of docs) if (doc.tf.has(term)) n += 1;
    df.set(term, n);
  }
  const hits = [];
  // IDF 选词（抄 hindsight `engine/search/bm25_term_selection.py`，与灵枢 `cn_recall_grams`
  // 的 cap 同源）：长查询里塞满 "at"/"step"/"worker" 这类满库都是的词，它们对**每个**候选
  // 都加分，会把真正特异的词（如「飞书」）淹没掉。实测：1190 字的消息里含「飞书那边一直连不上」，
  // 改头尾取样让它进了 query，飞书笔记仍然召不回——就是被这堆高频词压下去的。
  // 按 df 升序只保留最特异的 QUERY_TERM_CAP 个词项；短查询本来就少于 cap，完全不受影响。
  // ⚠️ 只能对「库里真的出现过」的词排名：df === 0 的词压根不加分（`doc.tf` 里查不到），
  // 若让它们参与排序，最特异的 24 个名额会被日志里的 step37 / worker139 这类词占满，
  // 真正有区分度的「飞书」反而被挤出 cap —— 实测那样连一条都召不回（注入 0 条）。
  const useful = terms.filter((term) => (df.get(term) ?? 0) > 0);
  let active = terms;
  if (useful.length > QUERY_TERM_CAP) {
    const keep = new Set(
      useful
        .slice()
        .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (weights.get(b) ?? 0) - (weights.get(a) ?? 0))
        .slice(0, QUERY_TERM_CAP),
    );
    active = terms.filter((term) => (df.get(term) ?? 0) === 0 || keep.has(term));
  }
  for (const doc of docs) {
    let score = 0;
    const matched = [];
    for (const term of active) {
      const f = doc.tf.get(term);
      if (!f) continue;
      matched.push(term);
      const n = df.get(term);
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += weights.get(term) * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avgLen)));
    }
    // 两个时间维都乘在最后：它们都是「同强度下排序微调」，不该混进 BM25 的饱和曲线。
    // decay 无界（指数，默认关）、boost 有界（±w，默认关），各自独立开关。
    score *= doc.decay ?? 1;
    score *= doc.boost ?? 1;
    // 整句子串命中：加在乘性调整之后，是纯粹的加法微调，不参与 BM25 的饱和曲线。
    if (usePhrase && score > 0 && doc.plain.includes(needle)) score += PHRASE_BONUS;
    if (score > 0) hits.push({ id: doc.id, section: doc.section, score, snippet: bestLine(doc, matched), matched });
  }
  hits.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  // 长笔记切桶后同一 id 会有多条命中，只留分最高的那一桶。否则 267KB 的巨兽靠几十个桶
  // 就能把召回位占满（2026-10-14 实测切桶前它霸榜 17/30）。
  const best = new Map();
  for (const hit of hits) {
    const seen = best.get(hit.id);
    if (!seen || hit.score > seen.score) best.set(hit.id, hit);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

/** 挑一行当片段：命中查询词项最多的那一行（并列时取更靠前的）。 */
function bestLine(doc, matched) {
  const wanted = new Set(matched);
  const candidates = [doc.title, doc.description, ...String(doc.body ?? '').split('\n')]
    .map((line) => String(line ?? '').trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('---'));
  let best = '';
  let bestCount = -1;
  for (const line of candidates) {
    const terms = new Set(tokenize(line));
    let count = 0;
    for (const term of wanted) if (terms.has(term)) count += 1;
    if (count > bestCount) {
      best = line;
      bestCount = count;
    }
  }
  return clip(best || doc.title || doc.id, 72);
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
