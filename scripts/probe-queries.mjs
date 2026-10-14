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

