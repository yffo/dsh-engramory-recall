/**
 * 探针用的三张配对表（真实中文口语 query → 期望命中的笔记）。
 *
 * 为什么单独放一个文件：`bench/bridge-coverage.mjs`（同义表覆盖率尺子）也要用同一批
 * 真实查询来量「哪些键真的被走到过」—— 尺子必须和探针跑同一张卷子，否则两个数字不可比。
 * 放在这里而不是各写一份，是为了避免抄错、也避免「改了探针忘了改尺子」。
 */
/** 口语 query → 期望命中的笔记 id（不含 .md）。加配对时请用真实说法，别写书面语。 */
export const PAIRS = [
  ['飞书又连不上了', 'reference-feishu-getaddrinfo-enotfound'],
  ['代码拉下来是空的，装依赖就报错', 'reference-npm-ci-enoent-empty-clone'],
  ['数据库地址写在配置里就报错', 'reference-prisma-7-schema-url'],
  ['图片生成突然用不了了', 'reference-minimaxi-dns-hijack'],
  ['截图说没有权限', 'reference-peekaboo-tcc-permission'],
  ['报表页变成一堆原始数据了', 'reference-zod-validation-report-degradation'],
  ['编辑器一刷新就崩', 'reference-next-blocknote-ssr-and-build-traps'],
  ['浏览器起不来', 'reference-browser-harness-chrome-instance'],
  ['填表单的时候内容重复了两遍', 'reference-browser-harness-fill-input-duplicate'],
  ['浏览器任务报会话冲突', 'reference-browser-use-session-conflict'],
  ['换个库去调模型就失败了', 'reference-chatopenailike-deepseek-incompatible'],
  ['命令行工具报 fetch 没有定义', 'reference-mmx-cli-fetch-undefined'],
  ['ppt 传上去样式全没了', 'reference-html-ppt-inline-assets'],
  ['记忆库怎么体检', 'reference-engramory-doctor'],
  ['原生模块编译不过', 'reference-better-sqlite3-node-version'],
  ['线上服务全挂了，报 502', 'reference-yffto-pm2-502-recovery'],
  ['密钥被我提交到仓库里了', 'reference-secret-hygiene-in-repo'],
  ['登录完又跳回登录页', 'reference-next-prefetch-auth-redirect-cache'],
  ['本地跑得好好的，上线就不行', 'reference-local-and-production-environment'],
  ['视频生成跑不动', 'project-local-comfyui-video'],
  ['选品那个能不能自动做', 'project-1688-sourcing-automation'],
];

/**
 * 桥探针：专压**同义表**的十条 —— 故意用大白话去问那些笔记里全是英文/术语的东西。
 *
 * 为什么单列一组而不混进口径：同义表的手写桥是「中文口语 → 本库实际用词」的映射，
 * 它有没有用，只有用大白话问才看得出来。混进口径会被稀释成一个看不出因果的平均分。
 * 加桥时优先让这一组涨；如果某条桥在这组里没有任何一条 query 用到它，那它就是猜测，
 * 应该删掉 —— 一张没人走的桥不值得维护。
 */
export const BRIDGE_PAIRS = [
  ['梯子又抽风了', 'reference-yffto-us-proxy-node'],
  ['那个旧系统怎么删干净', 'reference-openclaw-removal-playbook'],
  ['证书快到期了', 'reference-acme-webroot-behind-1panel-openresty'],
  ['分享图是怎么生成的', 'reference-selfhosted-og-image-satori'],
  ['选品那套怎么做的', 'project-1688-sourcing-automation'],
  ['沙箱里为什么写不了文件', 'reference-dsh-sandbox-memory-write-path'],
  ['工作区怎么交接', 'reference-workspace-and-handoff'],
  ['服务挂了怎么自己起来', 'reference-yffto-pm2-502-recovery'],
  ['旧系统卸载之后还有残留', 'reference-memmy-removal-playbook'],
  ['知识库怎么把质量守住', 'reference-kb-entry-quality-gate'],
];

/**
 * 别名探针：专压**笔记自己声明的 `aliases:`**（frontmatter，计两遍权重）。
 * 这几条 query 里的关键词在全局同义桥里**一个都没有**，所以只有别名能救它们 ——
 * 这样才测得出别名这个机制到底有没有在工作，而不是被别的机制顺手救了。
 *
 * ★ 已知取舍（实测数字，不藏）：`reference-selfhosted-og-image-satori.md` 的别名里有「社交卡片」，
 * 而「卡片」是个通用词 —— 带着它：别名探针 5/5、对照 B 135；删掉它：别名探针 4/5、对照 B 136。
 * **这个换法是有意选的**，不是没发现：前者是人真会那么问的话，后者是把我自己归档时写的长
 * 标题截 30 字当 query，属于合成出来的口味。如果你更看重对照 B，删掉那个别名即可。
 */
export const ALIAS_PAIRS = [
  ['社交卡片是怎么生成的', 'reference-selfhosted-og-image-satori'],
  ['老记忆系统怎么迁走的', 'reference-memmy-removal-playbook'],
  ['换会话的时候怎么交接', 'reference-workspace-and-handoff'],
  ['网站打不开是不是进程挂了', 'reference-yffto-pm2-502-recovery'],
  ['旧系统卸载之后还有残留', 'reference-memmy-removal-playbook'],
];

/**
 * 宽卷（2026-10-15 加）：把探针从 36 条扩到 ~150 条，压掉「1 条 query = 2.8 个点」的噪声。
 *
 * 为什么非加不可：36 条时两家端点、四个档位的差异全落在同一团噪声里（真库 83.3~88.9 就是
 * 1~2 条的差别），等于在噪声里挑数字。加了这一卷之后，`rrf` 与 `trust`、池 10 与 20 的差别
 * 才看得见方向。
 *
 * 写法规矩（下一批加的时候照着来）：
 *  1. 一条笔记换 2~3 个**不同角度**问：口语抱怨 / 间接场景 / 症状描述；优先用**不是笔记标题里的词**，
 *     这样才落在词面第 2~10 名 —— 那一段才是重排真正能挣分的区间（第 1 名只能被弄坏）；
 *  2. 只写「这一篇笔记自己就能回答」的问题。答案要跨两篇的题不要：它测的是别的机制，混进来只会
 *     让归因变糊；
 *  3. 加完必须跑 `npm run bench:probe` 看名次分布：**落在第 0 名（词面 500 名内都找不到）的题要改**——
 *     池子由词面产生，这种题超出现有架构，留着只会污染平均分。
 */
export const WIDE_PAIRS = [
  // ── 飞书 / 装依赖 / 数据库 / 图片生成 / 截图（症状类，换措辞问）──
  ['飞书文档打不开，别的网站都正常', 'reference-feishu-getaddrinfo-enotfound'],
  ['调飞书接口有时候整片超时', 'reference-feishu-getaddrinfo-enotfound'],
  ['为什么只有飞书的域名解析不出来', 'reference-feishu-getaddrinfo-enotfound'],
  ['同事克隆下来跑不起来，说没有 package.json', 'reference-npm-ci-enoent-empty-clone'],
  ['流水线上装依赖第一步就挂了', 'reference-npm-ci-enoent-empty-clone'],
  ['升级完 ORM 之后启动就连不上数据库', 'reference-prisma-7-schema-url'],
  ['schema 里那个数据库地址字段不让写了', 'reference-prisma-7-schema-url'],
  ['生成图片的接口返回内网 IP', 'reference-minimaxi-dns-hijack'],
  ['海螺那边的域名被解析到 10 开头了', 'reference-minimaxi-dns-hijack'],
  ['截屏一直弹系统授权', 'reference-peekaboo-tcc-permission'],
  ['桥接进程报 error 1', 'reference-peekaboo-tcc-permission'],
  ['报表有一行数据不对，整页就成了白板', 'reference-zod-validation-report-degradation'],
  ['报表页字段校验不过就整页降级', 'reference-zod-validation-report-degradation'],

  // ── Next.js / 主题 / 弹窗 / OG 图 ──
  ['编辑器在服务端渲染时报 window 未定义', 'reference-next-blocknote-ssr-and-build-traps'],
  ['css 里写注释把构建搞崩了', 'reference-next-blocknote-ssr-and-build-traps'],
  ['本地想连生产的库调试怎么做', 'reference-next-blocknote-ssr-and-build-traps'],
  ['深色模式有些地方没变', 'reference-css-theming-hardening'],
  ['打印出来一片黑', 'reference-css-theming-hardening'],
  ['var() 静默失效怎么查', 'reference-css-theming-hardening'],
  ['弹窗背景变糊了', 'reference-admin-modal-overlay-traps'],
  ['弹窗里的样式丢了', 'reference-admin-modal-overlay-traps'],
  ['拖拽区把折叠点击吞了', 'reference-admin-modal-overlay-traps'],
  ['分享链接没有缩略图', 'reference-selfhosted-og-image-satori'],
  ['OG 图里中文不显示', 'reference-selfhosted-og-image-satori'],
  ['字体怎么打包进函数里', 'reference-selfhosted-og-image-satori'],

  // ── 浏览器自动化 ──
  ['自动化的浏览器连不上', 'reference-browser-harness-chrome-instance'],
  ['默认配置下起不来 Chrome', 'reference-browser-harness-chrome-instance'],
  ['自动填表的时候内容重复输入了两遍', 'reference-browser-harness-fill-input-duplicate'],
  ['自动输入的内容变成双份', 'reference-browser-harness-fill-input-duplicate'],
  ['两个任务抢同一个会话报错', 'reference-browser-use-session-conflict'],
  ['两个自动化任务同时跑会报会话冲突', 'reference-browser-use-session-conflict'],

  // ── 模型接入 / CLI / 演示文稿 ──
  ['langchain 那层接国产模型报参数错', 'reference-chatopenailike-deepseek-incompatible'],
  ['换个模型就调不通了', 'reference-chatopenailike-deepseek-incompatible'],
  ['这个命令行工具说 fetch 没定义', 'reference-mmx-cli-fetch-undefined'],
  ['node 里 fetch 不是内置的吗，它为什么说不存在', 'reference-mmx-cli-fetch-undefined'],
  ['发出去的演示文稿没有样式', 'reference-html-ppt-inline-assets'],
  ['单文件 HTML 里的图要内联吗', 'reference-html-ppt-inline-assets'],

  // ── 记忆库自身（doctor / 守卫 / 沙箱 / 上架 / 版本 / 召回）──
  ['记忆库有没有毛病怎么查', 'reference-engramory-doctor'],
  ['体检为什么不查冲突', 'reference-engramory-doctor'],
  ['任何项目里的 MEMORY.md 都被拦', 'reference-engramory-indexpath-pinning'],
  ['守卫为什么拦别的目录', 'reference-engramory-indexpath-pinning'],
  ['沙箱里写不进文件', 'reference-dsh-sandbox-memory-write-path'],
  ['符号链接该指向哪边', 'reference-dsh-sandbox-memory-write-path'],
  ['自己写的插件怎么上架', 'reference-dsh-plugin-market-listing'],
  ['DSH 有官方插件市场吗', 'reference-dsh-plugin-market-listing'],
  ['装插件时提示一个不相干的包坏了', 'reference-dsh-plugin-manager-all-or-nothing'],
  ['插件操作全失败', 'reference-dsh-plugin-manager-all-or-nothing'],
  ['官方新版 DSH 上这插件还能用吗', 'reference-engramory-on-official-dsh'],
  ['声明版本上限小于当前，是不是不兼容', 'reference-engramory-on-official-dsh'],
  ['召回插件装在哪', 'reference-engramory-recall-plugin'],
  ['改完代码为什么不生效', 'reference-engramory-recall-plugin'],
  ['注入的消息为什么用 plugin: 前缀', 'reference-engramory-recall-plugin'],
  ['中文口语搜不到东西', 'reference-engramory-recall-tuning'],
  ['长笔记总霸榜怎么办', 'reference-engramory-recall-tuning'],
  ['寒暄消息也会注入记忆吗', 'reference-engramory-recall-tuning'],
  ['本机跑语义检索用哪个模型', 'reference-local-embedding-endpoint'],
  ['不想把笔记发出去怎么接语义', 'reference-local-embedding-endpoint'],
  ['embedding 模型要下多大', 'reference-local-embedding-endpoint'],
  ['DSH 里第三方模型的配置存哪', 'reference-dsh-model-config-internals'],
  ['那个 key 存在哪个文件里', 'reference-dsh-model-config-internals'],
  ['设置页里模型旁边那个绿点是读哪儿', 'reference-dsh-model-config-internals'],

  // ── 部署 / 证书 / 线路 / 密钥 ──
  ['网站打不开，报 502', 'reference-yffto-pm2-502-recovery'],
  ['服务器重启之后服务没自己起来', 'reference-yffto-pm2-502-recovery'],
  ['非交互 ssh 里 pm2 找不到', 'reference-yffto-pm2-502-recovery'],
  ['证书续期失败', 'reference-acme-webroot-behind-1panel-openresty'],
  ['申请证书时 80 端口被占', 'reference-acme-webroot-behind-1panel-openresty'],
  ['续期之后怎么同步副本', 'reference-acme-webroot-behind-1panel-openresty'],
  ['出国线路慢，是线路问题还是配置问题', 'reference-cross-border-line-diagnosis'],
  ['IPv6 是不是比 IPv4 快', 'reference-cross-border-line-diagnosis'],
  ['美国节点现在用什么协议', 'reference-yffto-us-proxy-node'],
  ['旧协议退役了吗', 'reference-yffto-us-proxy-node'],
  ['仓库里是不是有密码', 'reference-secret-hygiene-in-repo'],
  ['文档里写连接串示例算泄漏吗', 'reference-secret-hygiene-in-repo'],
  ['把密钥提交上去了怎么补救', 'reference-secret-hygiene-in-repo'],
  ['本地没问题，服务器上就出问题', 'reference-local-and-production-environment'],
  ['两边环境差在哪', 'reference-local-and-production-environment'],
  ['本地跑一百遍都没事，CI 第一次就报错', 'reference-ci-catches-silent-platform-hardcoding'],
  ['正则里写死 /Users/ 有什么问题', 'reference-ci-catches-silent-platform-hardcoding'],
  ['本地好好的上线就崩', 'reference-local-and-production-environment'],

  // ── 流水线 / 原生模块 / 测试 / 归档 ──
  ['部署命令只有第一条在远程执行', 'reference-jenkins-ssh-quoting'],
  ['ssh 引号被吞了', 'reference-jenkins-ssh-quoting'],
  ['推送之后 Jenkins 没反应', 'reference-jenkins-webhook-not-building'],
  ['webhook 触发了但没构建', 'reference-jenkins-webhook-not-building'],
  ['装依赖时原生模块编译报错', 'reference-better-sqlite3-node-version'],
  ['node 升到新版本之后这个库装不上', 'reference-better-sqlite3-node-version'],
  ['memos 插件起不来是不是因为它', 'reference-better-sqlite3-node-version'],
  ['测试跑完进程不退出', 'reference-node-test-unref-timer'],
  ['CI 报 cancelledByParent', 'reference-node-test-unref-timer'],
  ['依赖自身超时的测试会永久挂住', 'reference-node-test-unref-timer'],
  ['归档任务自己喂自己跑不停', 'reference-termination-of-self-feeding-transforms'],
  ['守卫写得比问题还宽', 'reference-termination-of-self-feeding-transforms'],
  ['知识库词条怎么校验', 'reference-kb-entry-quality-gate'],
  ['词条摘要要多少字', 'reference-kb-entry-quality-gate'],
  ['主题切换颜色不对', 'reference-lightningcss-light-dark-lowering'],
  ['深色浅色一起取值的函数被降级了', 'reference-lightningcss-light-dark-lowering'],
  ['自己写 MCP 服务器要注意什么', 'reference-mcp-stdio-server'],
  ['MCP 进程不回包', 'reference-mcp-stdio-server'],
  ['发 npm 报 EPERM', 'reference-publish-plugin-to-npm'],
  ['shasum 怎么对齐', 'reference-publish-plugin-to-npm'],
  ['把 memmy 删干净', 'reference-memmy-removal-playbook'],
  ['删了又被写回来', 'reference-memmy-removal-playbook'],
  ['openclaw 的残留清一下', 'reference-openclaw-removal-playbook'],
  ['旧系统的足迹清单', 'reference-openclaw-removal-playbook'],
  ['工作区在哪', 'reference-workspace-and-handoff'],
  ['新窗口怎么接手', 'reference-workspace-and-handoff'],
  ['从 iCloud 搬到哪了', 'reference-workspace-and-handoff'],
  ['登录成功还是回到登录页', 'reference-next-prefetch-auth-redirect-cache'],
  ['预取缓存里存了跳转结果', 'reference-next-prefetch-auth-redirect-cache'],
  ['macOS 升级后辅助功能读不到界面', 'reference-ghost-os-accessibility-macos26'],
  ['权限没法从父进程继承', 'reference-ghost-os-accessibility-macos26'],
  ['之前修过的登录 bug 记在哪', 'reference-next-prefetch-auth-redirect-cache'],

  // ── 项目与偏好 ──
  ['个人主页怎么部署的', 'project-by-yffto-cicd'],
  ['站点登录链路修过什么', 'project-by-yffto-cicd'],
  ['知识库 wiki 在哪', 'project-by-yffto-cicd'],
  ['站点改动历史在哪', 'project-by-yffto-cicd-history'],
  ['每一批改动的原文', 'project-by-yffto-cicd-history-2'],
  ['为什么不用自研记忆系统', 'project-memory-system-choice'],
  ['最后为什么选 engramory', 'project-memory-system-choice'],
  ['多 agent 秘书那套怎么设计的', 'project-multi-agent-secretary'],
  ['以前那个 memos 记忆系统', 'project-old-memos-system'],
  ['还有哪些没闭环的活', 'project-open-todos'],
  ['遗留待办在哪看', 'project-open-todos'],
  ['Teum 那个 RPA 做到哪了', 'project-teum-rpa'],
  ['电商客服自动化', 'project-teum-rpa'],
  ['哪些信息已经过时了', 'project-expired-information'],
  ['选品能不能自动化', 'project-1688-sourcing-automation'],
  ['本地生成视频那套怎么搭的', 'project-local-comfyui-video'],
  ['杨总的偏好有哪些', 'user-profile-and-preferences'],
  ['回复之前要注意什么', 'user-profile-and-preferences'],
  ['协作上的红线是什么', 'feedback-collaboration-and-safety-rules'],
  ['危险操作要不要先问', 'feedback-collaboration-and-safety-rules'],
  ['松 A 门禁是什么意思', 'feedback-gate-tiers-loose-a'],
  ['性能预算降成参考线了', 'feedback-gate-tiers-loose-a'],
  ['过儿在长对话里会变味', 'feedback-identity-drift'],
  ['多轮之后称呼变了', 'feedback-identity-drift'],
  ['收尾别重复提醒', 'feedback-no-repeat-pending-reminders'],
  ['剩下的活要不要每轮问', 'feedback-no-repeat-pending-reminders'],
  ['跨项目复用的坑记在哪', 'feedback-reusable-workflow-lessons'],
  ['可复用的做法有哪些', 'feedback-reusable-workflow-lessons'],
];

/**
 * 所有卷子合起来的完整卷 —— 换端点/换档位的对照表（`npm run bench:embed`）用这一份，
 * 数字才可比；`bench/probe.mjs` 也按这一份算名次分布。
 */
export const ALL_PAIRS = [...PAIRS, ...BRIDGE_PAIRS, ...ALIAS_PAIRS, ...WIDE_PAIRS];
