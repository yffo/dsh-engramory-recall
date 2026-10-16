# 安装、自检、发版，以及在别的宿主里用

> 本文是**说明书**，[README](../README.md) 是**门面**。日常安装只用 README 里那三条命令；
> 这一份给「装完要确认接线没接错」「要改代码」「要发版」「要在别的宿主里用」的人。

覆盖：安装 / 卸载（含两个真实踩过的坑）、测试与自检的全部命令、发版流程与发布排错表、
别的宿主（零依赖 stdio MCP 服务器，只读）。

> 插件的默认值与旋钮见 [how-it-works.md](./how-it-works.md)；为什么这么设计见 [limits.md](./limits.md)。

---

## 安装 / 卸载

```bash
npm i dsh-engramory-recall                                          # 从 npm 装
dsh plugin --profile <profile> add /path/to/dsh-engramory-recall     # 或从源码目录装
dsh plugin --profile <profile> remove dsh-engramory-recall
```

安装后确认 profile 的 `node_modules/dsh-engramory-recall` 软链指向真实目录。
软链断链时宿主只会打印一行 `skipping profile bundle`，插件整轮不加载却不影响其它功能，
这个坑踩过一次，代价是三天无效测量。

**`dsh plugin` 是全有或全无的**：它每次都会重装 profile 的整个依赖集，所以只要
`package.json` 里有任何一个 spec 解析不了（版本被 registry 下架、被供应链策略拦住、
指向已删的路径），添或删任何插件都会一起失败，而且报错说的是那个无关的包。
排查时看 `.plugin-manager/logs/operation-*/pnpm.log`，别盯被操作的那个包。

## 测试与自检

```bash
npm test        # 分词 / BM25 / 切桶 / 门控 / 闸门 / 索引闸门 / 技能注册 / 体检 / 审计 / 沉淀提醒 / 归档 / 打包 / 路由 / 注入路径总装 / 面板渲染（七个页签）/ 公开基准 harness / MCP 服务器（含 JSON-RPC 帧与 stdio 主循环）/ 脏数据 fuzz / 语义接缝（含 host-embed）
npm run check   # 接线自检：配置键认不认、库路径对不对、装的是哪一份、包清单漏没漏文件
npm run probe   # 召回质量探针：3 组 query + 三道对照，跑在真实记忆库上
npm run probe -- --save   # 把这次结果存成基线，之后每次跑自动比对
npm run bench:check       # 合成基准 + 和 bench/expectations.json 对账（CI 跑的就是它）
npm run bench:foundation  # 地基句尺子：注入的那一行里有没有决定性那句话（--check 对账 / --store 真库 / --replay 账本重放）
npm run bench:bridges     # 同义表覆盖率尺子：死值、覆盖、使用面、逐键消融（--ablate / --json / --store）
npm run bench:seam        # 语义接缝的代价与天花板（四种坏提供方 + 作弊上界 + 融合模式对照）
npm run bench:guard       # 把握度门槛（guarded）的尺子：保护集/争夺集拆开看，--fake-cos 量垃圾提供方
                          #   （首次要先 `--collect` 打真端点采一次数，之后离线复扫不花 API 钱）
npm run bench:ceiling     # 池宽天花板：任一提供方在公开数据集上的上界 + 每查询要发多少东西
npm run bench:embed       # embeddings 接缝：--fake 量管线与代价 / --real 用真端点量质量（--store 才上真库）
npm run bench:probe       # 探针卷子本身：174 条真 query 的词面名次分布、保护区/争夺区、池内召回上界（--json）
npm run recall:stats      # 召回打开率尺子：注入/打开/零命中、位置级曲线、预算、原因分布、注入分、minScore 代价曲线（数据源 .engramory-recall.jsonl）
npm run embed:check       # 参考提供方自检：探一次 embeddings 接口，报维度与耗时（不打印密钥）
npm run bench:rewrite     # 宿主模型当改写提供方：真调用量代价与收益（要本机有 dsh；--offline 只重算）
npm run bench:mcp         # MCP 这一层：冷启动、每步往返、协议帧字节数
npm run mcp:smoke         # 拿脚本当 MCP 客户端，把服务器拉起来走一遍真实对话
node bench/longmemeval.mjs --data bench/.tmp/longmemeval_s_cleaned.json   # 公开基准（数据要自己下，264MB）
```

CI 跑 `npm test`、`npm run bench:check`、`npm run bench:foundation -- --check` 三件事。后者是防「数字悄悄漂走」的：任何一项
跟期望值的偏差超过 2 个百分点就红；桥组容差 3pt、verbatim 组 1pt（它们掉下来多半是我们改坏了）。
分数低不红 —— 绝对值会随语料演化，卡死绝对值只会逼人去改尺子；漂了才红，因为那说明
要么是回归、要么是刻意改动而没人说清楚。

上面这些命令大多要在克隆出来的仓库里跑：`test/` 与 `bench/` 不在 npm 包的 `files` 白名单里
（例外是 `scripts/recall-stats.mjs` —— 它读的是你自己库里的日志，装在包里的用户也该能跑，
所以它跟着 `usage.js` 一起发布）。
发布出去的是运行时真正需要的那十几个文件（`npm pack --dry-run` 可核），
其中 `package.test.mjs` 会从 `index.js` 递归跟所有 `./x.js` 的 import，逐个核对是否都在白名单里。
这个检查已经抓到过两次真事故（漏 `audit.js`、漏 `archive.js`），两次的后果都是
别人装上一装就 `ERR_MODULE_NOT_FOUND`、整个插件加载失败。

`npm run check` 覆盖的五种**静默失效**（不报错、只是从此不干活）：配置键打错字、
库路径指空、profile 里跑的不是你改的那份、`files` 白名单漏文件、这一行被 `enabled: false` 关掉。
它还会**活体探一次语义接缝**：按「patch 整段替换」的真实语义算出生效配置，配了真提供方就真发一次请求
（用的是内置的 3 条假文档，**不碰你的真库**）并报 `code` / 池宽 / 融合 / 耗时；配的是 `host-embed` 这种
只能在 App 内跑的提供方时它会说明原因而不是假装通过。同一节还会比**仓库代码的 mtime 与 DSH 进程的启动时间**：
进程比代码旧就警告「App 里跑的是旧模块，改代码要重启」—— Node 会缓存 ESM 模块，
**配置会热重载、代码不会**（实测踩到：改完 0.12.x 的代码，App 里仍然执行着几小时前加载的那份）。
它顺带跑一遍 `node --check` 校验客户端 bundle 的语法（面板写坏了不会连累宿主加载）。
唯一做不了的是活体守卫测试：守卫只拦 `write`/`edit` 工具调用，脚本写盘会绕过去，
所以脚本最后打印的是要由 agent 亲手执行的两个方向探针（完整的四条见上面「写入闸门」一节的复现表）。

## 发版（打 tag 就发，不用长期 token）

```bash
# 1. 改 package.json 的 version + 写 CHANGELOG
# 2. 本地三条门槛全过（CI 里跑的是同样三条）
npm test && npm run bench:check && npm pack --dry-run
# 3. 提交、打 tag、推上去 —— 剩下的交给 GitHub Actions
git commit -am "release: 0.9.1" && git tag -a v0.9.1 -m "0.9.1" && git push origin main --tags
```

`.github/workflows/release.yml` 会在 tag 推上去后跑：校验 tag 与 `package.json` 一致 → 测试与基准
→ `npm publish --provenance` → `npm run release:verify`（**直查版本端点**，把 registry 上的
`dist.shasum` 与本地 `npm pack` 的逐字比对 —— 退出码不算数，这才算数）。tag 早打过、当时发不出去
的情况用 `gh workflow run release.yml` 手动触发，版本以 `package.json` 为准。

它**不用任何长期 token**：走 npm 的 Trusted Publisher（GitHub OIDC）。npm 包的
Settings → Trusted Publisher → GitHub Actions 要填四个字段，一个都不能错：

| 字段 | 填什么 |
| --- | --- |
| Organization or user | `yffo` |
| Repository | `dsh-engramory-recall` |
| Workflow filename | `release.yml`（只写文件名，别写 `.github/workflows/`） |
| Environment | 留空（workflow 里没有 `environment`，填了就必然对不上） |

为什么非要走这条路：长期 token 正在被 npm 关掉（bypass 2FA 的 token 直接发布 2027-01 起失效），
而普通 token 每次发布都要 6 位 OTP —— 人肉发版迟早卡在口令上（2026-10-15 就卡过一次，`EOTP`）。

### 发不出去时，先看这两行日志

2026-10-15 的 0.9.0 首发布连挂两次，两次的报错都是**假线索**，真因只在日志里：

| 日志里出现 | 真因 | 修法 |
| --- | --- | --- |
| `404 Not Found - PUT https://registry.npmjs.org/<pkg>`，紧挨着一句 bypass-2FA 提示 | `actions/setup-node` 的 `registry-url` 会写一行 `_authToken=${NODE_AUTH_TOKEN}` 并塞占位值 `XXXXX-XXXXX-XXXXX-XXXXX`；npm 只要在配置里看到 token 就**不再走 OIDC**，于是拿假 token 去 PUT | 去掉 `registry-url`；workflow 里已加一步断言 `_authToken` 为空（只打有无、不打值） |
| `ENEEDAUTH need auth ... npm adduser` | npm 把 OIDC 交换的失败**全吞掉**（`lib/utils/oidc.js` 只写一行 verbose 就返回 undefined），所以「没绑定」和「字段不符」长得一模一样 | 看预检步的 `交换接口 HTTP …`（见下）；或给 publish 加 `--loglevel verbose`，日志里会出现 `Failed token exchange request with body message: …` |
| `交换接口 HTTP 404` + `OIDC token exchange error - package not found` | 这个包在 npm 上**没有任何 Trusted Publisher 绑定**（注意它不说「没绑定」，说的是「包找不到」——registry 惯用的模糊话术） | 去 Settings → Trusted Publisher → GitHub Actions 绑上那四个字段 |
| `交换接口 HTTP 401` + `OIDC token exchange error - unauthorized` | id-token 本身没拿到或被拒（`permissions: id-token: write` 缺失、或请求里带的是假 token） | 检查 workflow 的 `permissions` |
| `交换接口 HTTP 201` + `{"token": …}` | **这就是成功** —— registry 用 `201 Created` 表示新建了一个临时 token（不是 200）。预检的判据是「回包里有没有 `token`」，不是 HTTP 码 | 什么都不用做，往后走 |

工作流里那步「**预检 OIDC 交换**」就是为这张表服务的：它自己发一次与 `npm publish` 内部完全相同的
交换请求（`POST /-/npm/v1/oidc/token/exchange/package/<name>`），把 registry 的原话打印出来，
并且排在测试之前 —— 缺绑定时 30 秒就失败，不必先烧两分钟测试。

还有一条同类的假线索：runner 上 Node 22 自带的 npm 是 10.x，而 Trusted Publisher 要
**npm ≥ 11.5.1**，所以 workflow 第一步就 `npm install -g 'npm@^11.5.1'` —— 少了这步也会报
ENEEDAUTH，看起来像「Trusted Publisher 没配好」，其实只是 npm 太老。

还没配 Trusted Publisher 时可以手动发（临时文件里放 token，用完删）：

```bash
npm publish --access public --userconfig=/tmp/npmrc-<名字>
npm run release:verify                                       # 发完必须验证
```

## 别的宿主：MCP 服务器（只读）

`mcp.js` 是一个零依赖的 MCP（Model Context Protocol）stdio 服务器。它只做一件事：**让你在别的宿主里也能读同一份记忆**。全部只读、全部本机、零模型调用。

| 工具 | 作用 |
|---|---|
| `engramory_search` | 同一个 BM25 内核（中文分词、177 条同义桥、别名、字段加权） |
| `engramory_read` | 按文件名读一篇笔记的原文（只认库里根目录的 `.md`，路径一律拒） |
| `engramory_status` | 库在哪、多少篇、索引几行几字节、指纹 —— 先确认读的是不是你以为的那个库 |
| `engramory_list` | 清单：文件名 · 类型 · 描述 · 字符数（`kind` 可按四类筛、`limit` 1–50 默认 20）。库陌生时先看这里 |
| `engramory_usage` | 账本摘要：注入过几条、打开率、一个字都没进的轮次、按来源拆分、预算用量、被打开最多的几篇（`days` / `top`） |

资源与提示：

| 类型 | 名字 | 说明 |
|---|---|---|
| 资源 | `engramory://index` | `MEMORY.md` 全文：库的入口地图，客户端可以先读它再决定搜什么 |
| 资源 | `engramory://note/<文件名>` | 每篇笔记一篇资源，客户端可以直接列出来读 |
| 提示 | `recall` | 参数 `query`：先搜、再挑最相关的一篇打开、带着它回答（提示里写死「只读，不许写文件」） |
| 提示 | `curate` | 无参：把本次会话里定下来的事实整理成 Format v1 草稿，**交给你确认后自己写文件** |

`engramory_usage` 只读账本，所以它有几条自我约束：账本不存在 / 窗口内一行都没有 / 老行没有用量字段，三种情况分别说三种不同的话，**都不印 0**（缺数据不是 0）；`used` 与 `usedCounted` 是两个口径，两个数都印出来并说明差别；末尾永远带一句「这是代理指标」。

```jsonc
// Claude Code / Claude Desktop / Cursor 之类的 mcpServers 配置
{
  "mcpServers": {
    "engramory": {
      "command": "node",
      "args": ["/path/to/node_modules/dsh-engramory-recall/mcp.js", "--store", "~/memory/engramory"]
    }
  }
}
```

```bash
# 装了这个包就有了一个可直接调用的命令
engramory-recall-mcp --store ~/memory/engramory      # 库路径也可以用环境变量 ENGRAMORY_STORE
npm run mcp:smoke                                    # 自证：拉起来走一遍完整对话，打印收发记录
npm run bench:mcp                                    # 这一层的数字：冷启动、每步往返、协议帧多大

# Claude Code 也可以一条命令挂上（等价于上面那段 JSON）
claude mcp add engramory -- engramory-recall-mcp --store ~/memory/engramory
```

这一层的代价（本机真实库 **71 篇**、5 次冷启动取中位数；`npm run bench:mcp` 复算）：

| 指标 | 值 | 说明 |
|---|---|---|
| 冷启动 | 40 ms | 含 Node 启动、加载索引、`initialize` 往返 |
| `tools/list` | < 1 ms | 清单是静态的 |
| `engramory_search` | 103 ms | 首次检索要为 71 篇建一次索引，之后同进程走缓存 |
| `engramory_status` | 3 ms | 只读索引头 |
| 协议帧合计 | 5242 字节 | 一次完整对话（initialize + 五工具 + 资源 + 提示）的 stdout 总量 |
| 依赖 | 0 | 不装任何东西，进程起来就能说 MCP |

延迟随机器变化，能跨机复算的是**帧的字节数与依赖性**，以及两条常驻断言：`npm run bench:mcp`
要求 stdout 上只准有 JSON-RPC 帧（混进任何一行非 JSON，这次运行就直接失败），
`npm run mcp:smoke` 用脚本当客户端把五个工具、索引资源、两个提示与越界读全部走一遍。

**这一层是怎么验的（如实写）**：本机没有可用的第三方已登录宿主 —— Claude Code 2.1.142 装是装了，
但 `claude -p` 报 `401 Invalid API key`（`~/.claude.json` 里没有 `oauthAccount`），Gemini CLI 也没有凭据，
所以「在别人的宿主里点一下」这一步不是在真宿主里完成的，而是这样做的：

1. **官方 MCP SDK 当客户端**（`@modelcontextprotocol/sdk@1.32.1`，临时目录装的，不进仓库、不进包）
   连**发布出去的那份产物**（`npm pack` → 装进临时前缀 → 调 `.bin/engramory-recall-mcp`）：
   5 工具 / 3 资源 + 1 模板 / 2 提示全部走通，路径穿越被拒，全程 61 ms 无异常；
2. **裸 stdio 帧**（`npm run mcp:smoke`，仓库自带）：12 帧一问一答，帧序与错误码逐条断言；
3. 两个宿主配置片段按各自官方文档写（上面的 JSON、以及 `claude mcp add` 命令行形式），
   **未在本机端到端跑过** —— 你那边登录后，`claude mcp add engramory -- engramory-recall-mcp --store ~/memory/engramory`
   一条命令就能补上这最后一步。

**为什么它是只读的**：写入闸门、归档、体检这些能力依赖宿主工具层的钩子（`tools/pre-execute`），
别的宿主没有这套接口；硬做一个「谁都能写」的版本，等于把 fail-closed 的闸门换成一句口头约定。
所以跨宿主给的是**看**的能力，治理留在家用版里。它也不 import 任何宿主包 ——
在别的宿主里最坏是「没被用上」，不会「装上就崩」。
