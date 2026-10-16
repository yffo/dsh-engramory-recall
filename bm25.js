/**
 * 极简 BM25 —— 只为「在几十到几百条 markdown 笔记里做中文友好的关键词召回」。
 *
 * 设计取舍（与 Engramory 的既有口径一致）：
 *   - 零依赖、零出网、零模型：不引入 embedding，不下载模型，不做语义近似。
 *   - 中文按「相邻双字」切分（和 memview 的检索口径相同），孤立单字（被标点隔开的那种）也留；
 *     ⚠️ 因此**单个汉字查不出四字以上的连写**（`代理节点` 里没有 `代`）：单字查询只能靠同义表兜。
 *   - 英文词元再按连字符/斜杠/点拆一层：`html-ppt` 若整体成一个词元，查询里的 `ppt`
 *     就永远匹配不上（2026-10-14 实测「ppt 传上去样式全没了」漏召回的根因）。
 *   - 同义扩展：中文口语（「飞书」「连不上」）与笔记里的英文写法（feishu / ENOTFOUND）
 *     之间靠一张手写别名表搭桥，权重打折（EXTRA_WEIGHT）—— 它是「猜」，不该完全盖过字面命中。
 *   - 打分只用于「排序 + 挑一行当片段」，不是可信度，也不写回任何文件。
 *
 * k1/b 取常见默认值（与 DSH-SEP 的 BM25 同参），便于对照。
 */

const K1 = 1.2;
/**
 * 长度归一的强度。0.75 是教科书默认值（也是我们最初抄的值），三把尺子都说它偏大：
 *
 * | 尺子 | B=0.75 | B=0.4 |
 * | --- | --- | --- |
 * | LongMemEval-S 500 题 | @1 87.8% · @5 97.4% · 覆盖 91.5% · MRR 0.9140 | @1 88.4% · @5 98.2% · 覆盖 92.5% · MRR 0.9196 |
 * | 合成基准 704 查询 | @1 49.9% · @4 66.6% · verbatim 98.2% | @1 50.4% · @4 67.5% · verbatim 98.7% |
 * | 真库对照 C（中立那把） | top1 141/181 · @4 168/181 | top1 150/181 · @4 177/181 |
 *
 * 机制：同一个词在长会话/长笔记里出现得更多，长度归一按 `len/avgLen` 把整篇压下去；
 * 当库里绝大多数是长文档时，这个惩罚就变成「谁长谁吃亏」，与相关性无关。
 * 代价在对照 A 上能看到（top1 45→43），但 A 拿文件名当查询、结构性偏袒短名，
 * 所以按一直以来的规矩：以对照 C 为准，A/B 只当「别掉分」的底线。
 * 扫过的值：0.2 / 0.3 / 0.4 / 0.5 / 0.6 / 0.75 / 0.9 —— 0.3~0.5 是一片平台，取中间偏下的 0.4。
 */
const B = 0.4;

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
 *   值   口径     桥     别名   对照A top1/@4   对照B top1/@4   对照C top1/@4
 *   0   20/21  10/10   5/5    20 / 79        134 / 144      118 / 140
 *   1   20/21  10/10   5/5    20 / 77        138 / 144      122 / 140
 *   3   20/21  10/10   5/5    21 / 91        141 / 146      122 / 141
 *   6   20/21  10/10   5/5    24 / 92        142 / 146      122 / 141
 *   8   20/21  10/10   5/5     —              —              122 / 145
 *  12   20/21  10/10   5/5    24 / 92        142 / 146      122 / 146
 *  16   20/21  10/10   5/5     —              —              123 / 146
 *  24   20/21  10/10   5/5    33 / 93        142 / 146      123 / 148
 *  32   20/21  10/10   5/5     —              —              123 / 148
 *  48   20/21  10/10   5/5     —              —              124 / 148
 *  96   20/21  10/10   5/5     —              —              123 / 148
 *
 * ── 为什么从 3 改到 24（2026-10-15 第二次定这个值时想清楚的）──
 *
 * 第一次取 3 的理由是「口径在 3 之后不再动，所以后面的增量全来自对照，而对照只是
 * 别掉分的底线」。那个理由有个**没被发现的漏洞**：对照 A 与对照 B **都拿标题当查询**，
 * 所以它们对标题权重是**结构性偏袒**的 —— 抬高标题权重几乎必然让这两组变好，那不是
 * 证据，是同义反复。拿它们当目标函数固然错，拿它们当「没变差就行」的护栏**也**证明
 * 不了抬高标题权重是安全的：它们根本测不出这件事。
 *
 * 于是补了**对照 C（正文独有词当查询）**：query 词取自某篇正文、且**任何**标题/描述
 * 里都没有它（df ≤ 3）。这时抬高标题权重只会让标题里恰好撞上这个词的**别的**笔记
 * 平白加分、把正确答案挤下去 —— 这是唯一能中立评价标题权重的构造。
 *
 * 对照 C 的结果：**从 0 到 96 一路不降**（118 → 122 → … → 148），在 **24** 到达平台，
 * 之后 32/48/96 一动不动。原先担心的「标题压过正文」现象**在数据里不存在**。
 * 机制上讲得通：同一篇笔记的每个 chunk 共用同一个标题，所以标题权重实质上是一个
 * **笔记级的话题先验**，而不是「标题党的胜利」。
 *
 * 取 **24**（= 第一个让不受偏袒的对照 C 到达平台的取值），不取 48/96 ——
 * 它们只多 1 个 top1、@4 一个不涨。口径在**所有**取值上都恒为 20/21，
 * 所以它对这个参数**没有分辨力**，不能拿它做任何取舍（这一点必须诚实地写下来，
 * 免得下一轮又有人拿「口径没动」当作「所以取哪个都行」）。
 */
const TITLE_EXTRA = 24;
/**
 * 标题重复是否**也**计入长度归一（默认 false = 计入，即当前实现）。
 *
 * 提出这个口子的理由（2026-10-15 合成基准暴露）：TITLE_EXTRA=24 会把每篇的长度
 * 撑大 24×标题词数×桶数，而 BM25 的分母 `tf + K1·(1-B+B·len/avgLen)` 直接用这个 len ——
 * 也就是说「标题权重」实际上是通过**惩罚长度**间接起作用的，标题命中本身的贡献早就饱和了
 * （tf 大时 `tf(K1+1)/(tf+…)` 上限就是 K1+1）。合成语料上把它从长度里摘出去（true）
 * 与 TITLE_EXTRA=0 谁更好，是「字段加权该不该污染长度归一」这个问题的直接实验。
 *
 * 真库对照 C（唯一对标题权重中立的构造）在 false 时选了 24，所以这个开关默认关；
 * 两个语料上的实测对比见 README「召回基准」一节与 bench/。
 */
const TITLE_LEN_EXCLUDED = false;
/**
 * 命中同义键时，把这个键**自身的字面碎片**降为弱证据（2026-10-15 合成基准发现）。
 *
 * 现象：桥组查询 `打包 崩了`（笔记正文里只有 build / crash，一个汉字都没有）命中率只有 27%。
 * 原因不在桥，而在查询自己的碎片：「了」「打」「包」这些字在**别的**笔记的随手记录里到处都是，
 * 它们按基础权重（1.0）计分，而真正桥到的 build/crash 只有 0.5 —— 噪声把桥压住了。
 *
 * 直觉上该把这些碎片直接剔掉（那条目标笔记里本来就没这些字），但**剔掉会误伤**：
 * `代理节点与部署` 里的 `代理` 既是同义键、也是笔记正文里的原词，剔掉它反而丢掉了真证据
 * （实测直接把 `test/recall.test.mjs` 的注入预算用例打红）。所以这里是**降权而不是剔除**：
 * 一个词既然被表认定为口语说法，它的字面碎片只算弱证据，真正桥到的技术词才是强证据。
 */
const BRIDGED_FRAGMENT_WEIGHT = 0.5;
/** 桥到的词项权重（见 BRIDGED_FRAGMENT_WEIGHT）。 */
const BRIDGE_WEIGHT = 1;
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
 * freshness 衰减：口径参考灵枢（`rust/src/freshness.rs`，半衰期 30 天），实现与调参是我们自己的。
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

    // ── 2026-10-15 第五波：通用技术口语 ────────────────────────────────
    // 前面几波是**从这个库挖出来的**（专有名词、某个人的叫法），换一个库就大面积失效。
    // 这一波换来源：只收**任何写中文技术笔记的人都会用的说法** ——「变慢」「装不上」
    // 「退不回去」「改表结构」「打日志」…… 不依赖哪个库的词，别人装上也能命中。
    // 判据没变：同一个概念的两种叫法，不是「相关的两件事」。宽词（请求/客户端/队列这些）
    // 故意配上更专的伴词，靠 BRIDGE_WEIGHT 之外的其它词项兜住精度。
    改表结构: ['migration', 'migrate', 'schema', 'ddl', 'alter'],
    回填: ['backfill', 'migration'],
    流水线: ['pipeline', 'ci', 'runner', 'workflow'],
    自动检查: ['ci', 'pipeline', 'runner', 'lint'],
    打日志: ['log', 'logging', 'logger'],
    日志: ['log', 'logging'],
    轮转: ['rotation', 'rotate', 'logrotate'],
    抢锁: ['lock', 'mutex', 'locking'],
    加锁: ['lock', 'mutex'],
    死锁: ['deadlock', 'lock', 'mutex'],
    并发: ['concurrency', 'concurrent', 'parallel', 'mutex'],
    调接口: ['api', 'http', 'request', 'curl'],
    请求: ['request', 'http', 'api', 'curl'],
    重试: ['retry', 'backoff'],
    退避: ['backoff', 'retry'],
    限流: ['ratelimit', 'throttle', 'rate'],
    发包: ['publish', 'npm', 'tarball'],
    发版: ['release', 'publish', 'version', 'tag'],
    版本号: ['version', 'semver', 'tag'],
    自动点网页: ['automation', 'playwright', 'puppeteer', 'selector'],
    自动化: ['automation', 'playwright', 'selenium'],
    选择器: ['selector', 'xpath'],
    找不着: ['search', 'ranking', 'recall', 'bm25'],
    排序: ['ranking', 'rank', 'sort', 'bm25'],
    命中率: ['recall', 'hit', 'precision'],
    时区: ['timezone', 'utc'],
    时间对不上: ['timezone', 'utc', 'offset'],
    时间戳: ['timestamp', 'epoch', 'utc'],
    升版本: ['upgrade', 'dependency', 'major', 'peer'],
    升级依赖: ['upgrade', 'dependency', 'node_modules'],
    版本打架: ['conflict', 'peer', 'dependency'],
    大版本: ['major', 'semver', 'breaking'],
    客户端: ['desktop', 'client', 'electron'],
    打包产物: ['bundle', 'dist', 'artifact'],
    镜像: ['image', 'docker', 'registry'],
    容器: ['docker', 'container', 'pod'],
    队列: ['queue', 'runner', 'wait'],
    变慢: ['latency', 'slow', 'p95'],
    响应慢: ['latency', 'slow', 'p95'],
    慢得没法用: ['latency', 'slow', 'timeout'],
    数算错了: ['wrong', 'mismatch', 'incorrect'],
    结果不对: ['wrong', 'mismatch', 'incorrect'],
    对不上: ['mismatch', 'wrong', 'inconsistent'],
    安装失败: ['install', 'failed', 'npm'],
    东西没了: ['loss', 'lost', 'missing', 'data loss'],
    数据丢了: ['loss', 'lost', 'missing', 'data loss'],
    内存一直涨: ['leak', 'rss', 'memory'],
    泄漏: ['leak', 'leakage'],
    版本冲突: ['conflict', 'peer', 'semver'],
    悄悄不生效: ['silent', 'silently', 'quiet'],
    静默失效: ['silent', 'silently', 'failure'],
    没报错: ['silent', 'quiet'],
    乱码: ['encoding', 'mojibake', 'utf8', 'gbk'],
    编码: ['encoding', 'utf8', 'gbk', 'charset'],
    退不回去: ['rollback', 'revert', 'undo'],
    回滚: ['rollback', 'revert'],
    跑两次: ['duplicate', 'idempotent', 'idempotency'],
    重复触发: ['duplicate', 'idempotent'],
    幂等: ['idempotent', 'idempotency', 'duplicate'],
    卡住不动: ['hang', 'stuck'],
    没响应: ['hang', 'timeout', 'unresponsive'],
    心跳: ['heartbeat', 'ping', 'watchdog'],
    配置不生效: ['config', 'override', 'precedence'],
    改了没用: ['config', 'stale', 'cache'],
    进程退出: ['crash', 'exit'],
    退出码: ['exit', 'code', 'status'],
    调用栈: ['stack', 'trace', 'traceback'],
    权限被拒: ['forbidden', 'denied', '403'],
    审计: ['audit', 'trail'],
    落盘: ['disk', 'persist', 'write'],
    常驻集: ['rss', 'memory', 'resident'],
    排队: ['queue', 'runner', 'wait'],
  }),
);

/** 中英混排分词：英文/数字按连续词元；汉字按**相邻双字**切，被标点/空格隔开的孤立单字也留下。 */
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

/**
 * 英文虚词：查询里带着它们不加分，只稀释真正有区分度的词。
 *
 * 为什么只在**查询侧**过滤、索引侧一个词不动：索引侧删词会同时改掉每篇的
 * `len`，那等于顺手动了长度归一 —— 长度归一刚在 2026-10-15 为 `TITLE_EXTRA`
 * 的事校准过，不该为了这个另起一轮。实测也支持这个选择：查询+索引都过滤
 * 90.0%、只过滤查询 90.8%（LongMemEval-S 前 120 题）。
 *
 * 数据来源：LongMemEval-S 500 题（英文），86.2% → 87.8% RecallAny@1、
 * Recall@5 90.7% → 91.7%、MRR@5 0.904 → 0.914。中文查询几乎不受影响
 * （中文词不进这张表）。
 *
 * 只收「语法词」：疑问词、be/do/have 的变位、介词、代词、限定词。
 * 刻意**不收**任何可能带语义的词（如 `time`、`name`、`like`）——
 * 那类词在短查询里往往是唯一的抓手，删了就是漏检。
 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'of', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'for', 'about', 'as', 'into', 'over', 'after', 'before',
  'it', 'its', 'my', 'me', 'we', 'our', 'you', 'your', 'he', 'him', 'she', 'her', 'they', 'them', 'their',
  'there', 'here', 'so', 'such', 'no', 'not', 'only', 'just', 'also', 'very', 'much', 'many', 'more', 'most', 'some', 'any', 'all',
]);

/**
 * 求助/建议类通用词（查询侧）。这些词是「同一类对话」的框架，不是话题：
 * 一次求助会话里几乎必有 tips / suggest / advice / thinking，于是任何一次同流派会话都会
 * 因为共现这几个框架词而被抬分 —— 那是 genre（同一类对话）在匹配，不是 topic 在匹配。
 * 最吃亏的是「说出偏好再问建议」的查询：它的实词（巧克力曲奇、鸡尾酒、卧室家具）才是信息，
 * 却被一堆框架词稀释成「又一场给建议的对话」。
 *
 * 实测（LongMemEval-S 500 题，2026-10-15，`bench/.tmp/recon-queryclean.mjs`）：
 *   · 查询侧去掉这一类词 → Any@1 88.4% → 89.2%、MRR 0.9202 → 0.9251；
 *     preference 分片 @1 46.7% → 60.0%，其余五个分片逐位不变。
 *   · 换成「按 df 比例自动丢高频查询词」的通用规则则全线下跌（df<0.35 → @1 87.6%、
 *     df<0.20 → 85.4%）⇒ 收益来自这一类词的**语义**，不是频次本身（补上一条更早的证伪：
 *     df 下限同样无效）。
 *   · 14 个词逐个消融：没有哪个词单独扛收益（去掉任意一个最多掉 1 题），15 词子集与
 *     35 词大表同分 ⇒ 收益是「一类词」，不是一个咒语。
 * 只收「在失败样本里真出现过」的写法：单复数不自动补齐（补了就是没量过的猜测）。
 */
const EN_REQUEST_STOPWORDS = new Set([
  'tips', 'suggest', 'suggestions', 'recommend', 'recommendations', 'advice',
  'think', 'thinking', 'idea', 'ideas', 'helpful', 'good', 'upcoming', 'weekend',
]);

/**
 * 查询词项：去重 + 丢掉英文虚词 + 丢掉求助/建议类框架词。
 * 三道保险都保留原样，宁可留噪声也不把查询清空：
 *   · 只剩一个词项的查询（很可能那个词就是全部信息，「tips」这种就别筛了）；
 *   · 全是虚词的查询（「what about this」这种），过滤后为空等于一条都召不回；
 *   · 去掉框架词后为空（「any tips?」）→ 退回只过虚词的结果，而不是清空。
 */
export function queryTerms(text) {
  const terms = [...new Set(tokenize(text))];
  if (terms.length < 2) return terms;
  const withoutFunction = terms.filter((term) => !EN_STOPWORDS.has(term));
  const base = withoutFunction.length ? withoutFunction : terms;
  const kept = base.filter((term) => !EN_REQUEST_STOPWORDS.has(term));
  return kept.length ? kept : base;
}

/** 查询里命中的同义键（按原文字面，大小写不敏感）。 */
export function matchedSynonymKeys(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const word of SYNONYMS.keys()) {
    const key = String(word).toLowerCase();
    if (key && s.includes(key)) out.push(key);
  }
  return out;
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
    // 正文口径的长度：不含后面的标题重复（见 TITLE_LEN_EXCLUDED）。
    const baseLen = tokens.length;
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
      len: (TITLE_LEN_EXCLUDED ? baseLen : tokens.length) || 1,
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
  // 文档频率：`search` 每轮现算的只是**本次查询**词项的 df，而片段挑选要在候选句子上
  // 再用一次 idf —— 现算就等于每篇笔记重扫全库。建索引时顺手记一份全量，两个口径同源。
  //
  // ⚠️ 口径必须与下面的 `docCount` **一致**（同一篇笔记切出的多个桶只算一次）：df 按桶数、
  // N 按笔记数时会出现 `df > N`，`log(1 + (N-df+0.5)/(df+0.5))` 直接变负 —— 命中越多分越低，
  // 片段挑选会反过来躲开证据句（2026-10-16 在「同 id 多桶」的用例上撞到，当时返回的是文件名）。
  const termsOfNote = new Map();
  for (const doc of prepared) {
    let terms = termsOfNote.get(doc.id);
    if (!terms) termsOfNote.set(doc.id, (terms = new Set()));
    for (const term of doc.tf.keys()) terms.add(term);
  }
  const docFreq = new Map();
  for (const terms of termsOfNote.values()) for (const term of terms) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  // 平均长度按「笔记」而不是「桶」统计：否则碎桶会把基准拉低，反而放松对长文的惩罚。
  const sum = [...totalLen.values()].reduce((n, v) => n + v, 0);
  return {
    docs: prepared,
    avgLen: sum / (totalLen.size || 1) || 1,
    // `docCount` 按**笔记**数（不是桶数）：idf 的分母必须是「多少篇里有这个词」。
    docCount: totalLen.size,
    docFreq,
  };
}

/**
 * 「挑哪句话当片段」的标题/描述折扣：标题与描述是在**复述提问**，不是证据。
 *
 * 病根（2026-10-16 地基句尺子定位）：查询里的口语词（「飞书」「连不上」）天然同时命中
 * 标题/描述和正文，于是按「命中几个词」排队的旧规则让**回声**压过了**正文里那句带
 * 决定性罕见词的话** —— 96 题里 47 题是这么丢的。注入行要带的是证据，不是回声。
 *
 * 打折而不是禁用：标题命中确实是「这篇讲什么」的强信号，只是不该赢过正文证据。
 * 0.6 与原型一致（原型在 tune 半上扫过 0.4/0.5/0.6/0.8，0.6 最好且不是尖峰）。
 */
const SNIPPET_TITLE_DISCOUNT = 0.6;
/** 片段（句子 + 邻句）的硬上限。截断本身交给渲染层（`render.js` 的 `clip`）。 */
const SNIPPET_MAX = 240;
/**
 * 短于这个字数的句子被认为「缺上下文」，触发邻句扩展。
 * 40 是原型扫出来的平台：再低则大量单句证据没机会带上线索，再高则长句也去拼邻句、
 * 平均注入行白涨字符（而预算是有限的）。
 */
const SNIPPET_NEIGHBOR_BELOW = 40;

/**
 * 句末标点：中英句号/问号/叹号/分号。换行也当句末（markdown 的短行列表就是这么排的）。
 * 用逐字符扫描而不是正则 split：位置要留着（见 `documentSentences` —— 邻句必须按**原文
 * 位置**拼，不能各自 trim 再拼，那样会把原文的换行吃掉，逐字口径就保不住地基了）。
 */
const SENTENCE_BREAKS = new Set(['。', '！', '？', '!', '?', '；', ';']);

/** 空白串：`trim` 与「切点是空白吗」共用，免得两处口径漂开。 */
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * 按换行 + 句末标点把一段文本切成句子，返回 `{start, end}` 位置（不含前后空白）。
 * 空句不产出；`#` 开头的行与 `---` 的过滤在 `documentSentences` 里做（那里才知道是正文）。
 */
function splitSentences(text) {
  const spans = [];
  const s = String(text ?? '');
  let start = -1;
  let end = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const brk = SENTENCE_BREAKS.has(ch) || ch === '\n';
    if (isSpace(ch)) {
      if (start >= 0) end = i;
      continue;
    }
    if (start < 0) start = i;
    if (brk) {
      spans.push({ start, end: i + 1 });
      start = -1;
    } else {
      end = i + 1;
    }
  }
  if (start >= 0) spans.push({ start, end });
  return spans;
}

/** 一条笔记的候选句：标题、描述、正文按行切完再按句切，按字段顺序排（并列时取靠前的）。 */
function documentSentences(doc) {
  // 每个字段各带一份原文：邻句扩展要按**原文位置**取窗口，所以句子得知道自己的源串与
  // 句列表。`kind` 是源串的标签，邻句只允许在**同一个源串内**合并 —— 跨字段（标题接正文）
  // 拼出来的东西不是任何原文的连续片段，逐字口径会立刻判它「不是地基句」。
  const sources = [
    { kind: 'title', text: String(doc.title ?? '') },
    { kind: 'description', text: String(doc.description ?? '') },
  ];
  // 正文先按换行切「行」，再在行内切句：`#` 开头/`---`/空白行整行丢掉 ——
  // 小标题是回声、分隔线是噪声，两者都不该冒充「正文里的证据」。
  const body = String(doc.body ?? '').split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---');
    })
    .join('\n');
  if (body) sources.push({ kind: 'body', text: body });
  // 字段顺序 = 并列时的优先顺序：靠前的字段赢。
  for (const source of sources) {
    source.spans = splitSentences(source.text).map((span) => ({ start: span.start, end: span.end }));
  }
  // 全局句序（跨字段）才是「前一句/后一句」的判据；`source` 不同则不合并（见上）。
  const candidates = [];
  for (const source of sources) {
    for (const span of source.spans) {
      candidates.push({ kind: source.kind, text: source.text.slice(span.start, span.end), ...span, source });
    }
  }
  return candidates;
}

/**
 * 挑一句当片段（新默认口径）：**IDF 加权 + 句子级 + 邻句扩展**。
 *
 * 与 `bestLine` 的区别不是「更聪明」，而是换了被优化的量：旧规则数「命中几个词」，
 * 于是满库都是的口语词和真罕见的证据词各算一分；这里按 `idf(term)` 求和，罕见词自然重。
 */
function pickSentence(doc, matched, options = {}) {
  const wanted = new Set(matched);
  const idf = options.idf ?? (() => 0);
  const scored = [];
  for (const candidate of documentSentences(doc)) {
    const terms = new Set(tokenize(candidate.text));
    let score = 0;
    for (const term of wanted) if (terms.has(term)) score += idf(term);
    if (score <= 0) continue; // 一个 matched 词都没命中的行不参与
    if (candidate.kind !== 'body') score *= SNIPPET_TITLE_DISCOUNT;
    scored.push({ candidate, score });
  }
  if (!scored.length) return clip(doc.title || doc.id, SNIPPET_MAX);
  scored.sort((a, b) => b.score - a.score); // 稳定排序：同分保持文档顺序（靠前的先）
  const { candidate } = scored[0];
  // 长句直接给，但**硬上限仍然是 240**：一整段几百字挤掉后面几条指针的预算，
  // 还不如给一句带省略号的证据。上限之内一个字都不裁，裁剪归渲染层。
  if (options.neighbor !== true || candidate.text.trim().length >= SNIPPET_NEIGHBOR_BELOW) {
    return clip(candidate.text, SNIPPET_MAX);
  }
  return withNeighbor(candidate, wanted);
}

/**
 * 邻句扩展：短句单独进上下文时读者看不到它指什么，把**命中同一个词**的前/后一句一起带上。
 * 只扩一句，且拼完不超 `SNIPPET_MAX` —— 预算是有限的，扩一句是补上下文，不是捞全文。
 *
 * 拼接走**原文窗口**（`[前.start, 后.end)`）而不是 `前 + ' ' + 后`：原文两句之间可能是
 * 换行或缩进，凭记忆拼一个空格会改掉正文字面，逐字口径的尺子立刻判「地基丢了」。
 * 空白由渲染层的 `clip` 折叠。
 */
function withNeighbor(candidate, wanted) {
  const source = candidate.source;
  const spans = source?.spans ?? [];
  const at = spans.findIndex((span) => span.start === candidate.start && span.end === candidate.end);
  if (at < 0) return candidate.text;
  for (const index of [at - 1, at + 1]) {
    const other = spans[index];
    if (!other) continue;
    const text = source.text.slice(other.start, other.end);
    const terms = new Set(tokenize(text));
    let hit = false;
    for (const term of wanted) if (terms.has(term)) hit = true;
    if (!hit) continue;
    const from = Math.min(candidate.start, other.start);
    const to = Math.max(candidate.end, other.end);
    if (to - from > SNIPPET_MAX) continue; // 拼完超上限就不拼，宁可只给那一句
    return source.text.slice(from, to);
  }
  return candidate.text;
}

/** 片段的 idf 口径：与打分同一个公式，`df` 取 `buildIndex` 记下的全量表（见 buildIndex 末尾）。 */
function makeIdf(docFreq, docCount) {
  return (term) => {
    const df = docFreq.get(term) ?? 0;
    return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  };
}

/**
 * 现行打分参数与片段策略的**活值**快照（只读）。
 *
 * 为什么要有它：报告、面板、文档都要回答「你现在到底按哪套参数在算」。
 * 只要有人把这些数字复制成第二份，改了代码而报告不变，那份报告就是在撒谎。
 * 所以这里不做任何计算，只把模块自己的常量端出来 —— 单一来源，读得到就是真的。
 * 测试对它做快照断言：任何一项变了都必须有人主动改测试，等于强制「改参数要留痕」。
 *
 * @returns {{bm25: object, bridge: object, snippet: object, recency: object, phraseBonus: number, scoreFloor: number, defaultLimit: number}}
 */
export function scoringProfile() {
  return {
    bm25: {
      k1: K1,
      b: B,
      // 标题重复是否排除在长度归一之外（见 TITLE_LEN_EXCLUDED）
      titleLengthExcluded: TITLE_LEN_EXCLUDED,
      // 标题/描述额外多计的词次数（字段加权；0 = 关）
      titleExtra: TITLE_EXTRA,
      // 单次查询最多参与打分的词项数
      queryTermCap: QUERY_TERM_CAP,
    },
    bridge: {
      // 命中同义键时，键自身字面碎片的降权（1 = 不降）
      bridgedFragmentWeight: BRIDGED_FRAGMENT_WEIGHT,
      // 桥到的技术词权重（没有键命中时退回 extraWeight）
      bridgeWeight: BRIDGE_WEIGHT,
      extraWeight: EXTRA_WEIGHT,
      synonymKeys: SYNONYMS.size,
    },
    snippet: {
      // 片段挑选口径：idf = 按 IDF 加权选句子；count = 老口径（命中词最多的那一行）
      picker: 'idf',
      // 标题/描述行在片段挑选里打的折（它们是复述提问，不是证据）
      titleDiscount: SNIPPET_TITLE_DISCOUNT,
      // 单条片段的字数上限
      maxChars: SNIPPET_MAX,
      // 邻句扩展：地基句短于这个长度才带上邻句（默认整机关闭）
      neighborBelow: SNIPPET_NEIGHBOR_BELOW,
      neighbor: false,
    },
    recency: {
      // 时间衰减参考半衰期（默认不启用，等库跨度上来再复测）
      suggestedHalfLifeDays: SUGGESTED_HALF_LIFE_DAYS,
    },
    // 整句子串命中奖励（0 = 机制在、已证伪、不启用，见 PHRASE_BONUS 注释）
    phraseBonus: PHRASE_BONUS,
    // 分数下限：低于它就当 0（衰减时的地板）
    scoreFloor: SCORE_FLOOR,
    // search 的默认返回条数
    defaultLimit: 5,
  };
}

/**
 * 召回：返回按分排序的命中（score > 0 才返回）。
 *
 * @param {{snippet?: 'idf'|'count', neighbor?: boolean}} [options]
 *   `snippet: 'count'` 是 2026-10-16 之前的行为（命中词最多的那一行、预先 clip 到 72），
 *   留着做对照与回退；`neighbor: true` 才开启邻句扩展（默认关：2026-10-16 实测它
 *   在合成题集与真实库上都不涨指标，只多花约 11 字/条，所以不默认付这笔钱）。三个参数的老调用方
 *   什么都不传，拿到的就是新默认。
 * @returns {Array<{id, score, snippet, matched, chars}>} `chars` = 这篇笔记整篇字数（不参与打分）
 */
export function search(index, query, limit = 5, options = {}) {
  const mode = options?.snippet === 'count' ? 'count' : 'idf';
  const neighbor = options?.neighbor === true;
  // 命中同义键时，这个键自身的字面碎片降权（见 BRIDGED_FRAGMENT_WEIGHT）。
  const bridged = matchedSynonymKeys(query);
  const fragments = new Set();
  for (const key of bridged) for (const term of tokenize(key)) if (term !== key) fragments.add(term);
  const base = queryTerms(query);
  const extras = expandQuery(query);
  if (!base.length && !extras.length) return [];

  // 整句子串命中的针（见 PHRASE_BONUS）。太短的查询不判：像「线上」这种两个字，
  // 逐字命中满库都是，只会制造噪声。
  const needle = PHRASE_BONUS > 0 ? String(query ?? '').trim().toLowerCase() : '';
  const usePhrase = needle.length >= 2;

  // 权重：普通词项 1；同义键自己的碎片 0.5；桥到的技术词 = BRIDGE_WEIGHT（没有键命中时退回 EXTRA_WEIGHT）。
  const bridgeWeight = bridged.length ? BRIDGE_WEIGHT : EXTRA_WEIGHT;
  const weights = new Map();
  for (const term of base) weights.set(term, fragments.has(term) ? BRIDGED_FRAGMENT_WEIGHT : 1);
  for (const term of extras) if (!weights.has(term)) weights.set(term, bridgeWeight);
  const terms = [...weights.keys()];

  const { docs, avgLen } = index;
  const df = new Map();
  for (const term of terms) {
    let n = 0;
    for (const doc of docs) if (doc.tf.has(term)) n += 1;
    df.set(term, n);
  }
  // 片段挑选那把 idf：索引里有全量表就用它；手搓的索引（测试里直接拼 `{docs, avgLen}` 那种）
  // 退回本次查询自己算出来的那份 —— 宁可口径窄一点，也不能因为缺字段就挑不出句子。
  const idf = makeIdf(index.docFreq ?? df, index.docCount ?? docs.length);
  const snippetOptions = { idf, neighbor };
  const pickSnippet = (doc, matched) => (
    mode === 'count' ? bestLine(doc, matched) : pickSentence(doc, matched, snippetOptions)
  );
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
    // `chars` = 这篇笔记的**整篇**字数（store.js 读文件时顺手记的）。它不参与打分，
    // 只为了让账本能算「整篇多少字、这轮只送出去多少字」——「记忆省了多少上下文」
    // 是可复算的事实，不该是个形容词。桶共享整篇字数，所以长笔记不会被算小。
    if (score > 0) hits.push({ id: doc.id, section: doc.section, score, snippet: pickSnippet(doc, matched), matched, chars: doc.chars ?? 0 });
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

/**
 * 旧口径挑一行当片段：命中查询词项最多的那一行（并列时取更靠前的），并预先 clip 到 72。
 * 只在 `options.snippet === 'count'` 时走这条路 —— 留它是为了能逐字节复现 2026-10-16 之前
 * 的注入文本（对照与回退都靠它）。新默认见 `pickSentence`。
 */
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
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  // 别把代理对切成半个（snippet 里的 emoji 会变成乱码）：切点前是高代理就往前让一位。
  const before = s.charCodeAt(cut - 1);
  if (cut > 0 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}
