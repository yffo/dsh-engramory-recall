# 第三方来源与许可

本仓库是**独立实现**（作者 yffto），不是任何项目的 fork、镜像或官方版本。它实现了一套「一事一文 + `MEMORY.md` 索引」风格的记忆库，并在上面自研了召回、度量、护栏、归档、面板与 MCP 服务器。

下列部分**移植/派生自第三方**，按 MIT 许可保留其版权声明。

---

## 1. `tinqiao-oss/engramory`（MIT）

- 仓库：<https://github.com/tinqiao-oss/engramory>
- npm（其 DSH 适配器）：`dsh-engramory` v0.2.5，即上游仓库的 `adapters/dsh/plugin/`
- 对齐基线：**v0.2.5 / 上游提交 2026-09-24**
- 版权：`Copyright (c) 2026 Beijing Tinqiao Technology Co., Ltd.`

### 借用与对齐范围（截至 0.14.0 的实际状态）

**0.14.0 起，本仓库没有逐字复制的上游代码或文本。**此前（0.13.x 及更早）有两处是逐字移植，已在 0.14.0 全部重写，历史如实记录在下面。

| 本仓库文件 | 与上游的关系 | 现在是什么 |
|---|---|---|
| `index-guard.js` | **0.13.x：逐字移植**（`refuseOversizedIndex()` / `verdict()` / `countLines()`）；**0.14.0 起：按同一判定口径重写** | 本仓库自己的实现（结构、命名、注释、错误文案都是我们写的），判定口径与前版**逐条等价**，由 `test/index-guard-equivalence.test.mjs` 的固定矩阵锁定。口径本身来自 Engramory 协议：索引硬上限 **200 行 / 25 600 字节**（谁先到算谁）、只拒绝增长（缩小的重写永远放行，防死锁）、字节判据取原始 buffer、行数算法对末尾换行不敏感、basename 大小写不敏感 |
| `skill.js` | **0.13.x：正文与 `description`/`whenToUse` 逐字沿用**；**0.14.0 起：纪律一致、措辞与章节结构为本仓库自己的** | 技能名 `engramory` 与注册方式沿用生态惯例（同名技能只会生效一个，本插件不抢也不覆盖）；纪律条目一条不少，18 条纪律的逐条对照见 0.14.0 的 CHANGELOG 说明 |
| `docs/format.md` | 规范层面的引用：格式约定（索引形态、一行一指针、四类事实、frontmatter 字段、归档命名）来自上游 `rules-snippet.md` 与 `templates/MEMORY.md` | 本仓库的 **Format v1**：由我们定义、版本化、并写明**与上游规范的差异表**（文件名规则、必填字段、上限执行方式、召回与度量、版本与迁移）。我们**不声称与上游规范二进制兼容**，只兼容同一风格的历史库 |

除以上三处，本仓库其余部分（检索、门控、注入预算、账本与判据、写入闸门与审计、体检、可逆归档、面板、MCP、尺子与测试）与上游**没有任何关系**：不是移植、也不是派生。

### 上游许可原文

```
MIT License

Copyright (c) 2026 Beijing Tinqiao Technology Co., Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 只是「想法借鉴」的部分（不含代码或文本）

- 自动归档的确定性分层思路（追加式章节整段搬家、可回滚）参考了社区插件（灵枢 `dsh-memory`、`dsh-mneme`）的公开说明，实现为 `archive.js`。
- 「别名/同义词桥」的用法参考同类插件的公开描述，实现为 `bm25.js` 的同义表与 `aliases` 字段。
- 可选语义接缝（`semantic.js` / `llm.js`）使用宿主提供的 LLM 句柄，思路来自社区插件的公开说明。

以上均只借鉴思路，**没有复制代码或文本**。

---

## 3. 名字说明

上游明确声明：本项目永远只是 `tinqiao-oss/engramory`（npm `dsh-engramory`），其它 owner 下的同名仓库不是它的 fork 或新版本。本仓库是**另一个独立项目**（`dsh-engramory-recall`，作者 yffto），与上游无隶属关系；两者都注册了同名技能 `engramory`，同时安装时只会生效一个（本插件对此做了容错处理，不报错、不覆盖）。
