# AutoResearch 文档

更新日期：2026-09-13。

## 自动化科研设计规范

以下文档定义证据驱动的目标架构，覆盖实验失败后的主张修订、上下文管理、基础设施复用和记忆机制。文中明确区分现有能力与待实现要求；实施状态以对应代码和验收记录为准。

| 文档 | 内容 | 建议读者 |
|---|---|---|
| [自动化科研通式：证据、基础设施与记忆](autonomous-research/general-form.md) | 状态与行动通式，科研/执行/记忆三个循环，记忆分类与失效，设施能力登记、预算、数据曝光及评估 | 研究者、架构与实现人员 |
| [实验想法循环与上下文管理规范](autonomous-research/research-loop.md) | 主张/假设/协议/证据契约，失败分类，数据驱动修订，角色上下文包，持久化、恢复及验收标准 | 实验设计与运行时实现人员 |
| [实施状态与验收](autonomous-research/implementation-status.md) | 已交付行为、最终测试与审查、实现分支及明确边界 | 使用者、实现与验收人员 |

建议先读通式，再按循环规范理解一次实验如何从数据进入下一假设。进入代码实现时，分别核验已有设施、数据契约和验收条件。

本设计采用的核心规则：

- 失败报告成为有来源的下一轮输入；执行完成、测量有效和假设得到支持分别判定。
- 有效证据才能改变科学主张的支持状态；新假设保留父版本、反证和探索来源。
- 每次角色调用从持久记忆构建有预算、有来源的上下文，保留必要约束与反证。
- 科研系统记忆与被测 Agent 记忆按实验协议隔离；记录数据曝光和记忆版本。
- 复用现有 DSH 执行、恢复和预算设施；按实际需求接入数据版本或集中实验追踪服务。

## 使用与部署

| 入口 | 内容 |
|---|---|
| [项目 README](../README.md) | 安装、运行方式、workflow、实验工程与恢复 |
| [核心包](../packages/autoresearch/README.md) | 构建、研究与独立实验入口 |
| [Web 工作台](../packages/autoresearch-web/README.md) | 项目设置与 LaTeX/PDF 工作台 |
| [可选 CPA 接入](../packages/dsh-cpa/README.md) | 原生模型路由配置及接入边界 |

## 当前分类

| 分类 | 入口 | 约定 |
|---|---|---|
| 规范 | [autonomous-research/](autonomous-research/README.md) | 当前维护的科研通式、循环规范与实施状态 |
| 指南 | [guides/](guides/README.md) | 面向使用者的部署、工作台与 CLIProxyAPI 指引 |
| 验收 | [verification/](verification/README.md) | 验证、部署、完成报告、验收矩阵与当前状态 |
| 工作流 | [workflows/](workflows/README.md) | 从候选想法或实验记录交接到论文的执行手册 |
| 历史设计 | [archive/designs/](archive/designs/README.md) | 2026-08 设计原文，保留历史语义 |
| 草稿 | [drafts/](drafts/README.md) | 尚未归档为当前入口的设计与待办 |

`autonomous-research/implementation-status.md` 保持原位；其中记录的实现分支属于 branch-local 状态，尚未合并到 `main`，链接保持不变。

## 本次目录迁移

以下旧路径已迁移到新入口；引用应使用新路径，历史正文与证据文件保持原样。

| 旧路径 | 新路径 |
|---|---|
| `docs/2026-08-*.md`（16 份设计） | `docs/archive/designs/` |
| `docs/drafts/*-guide.md`（3 份指南） | `docs/guides/` |
| `docs/drafts/2026-09-*verification.md`、部署/完成报告、`acceptance-matrix.md`、`current-status.md` | `docs/verification/` |
| `candidate-to-paper-handoff/` | `docs/workflows/candidate-to-paper-handoff/` |
| `records-paper-handoff/` | `docs/workflows/records-paper-handoff/` |

## 历史材料

带日期的设计、[草稿目录](drafts/README.md)与 `superpowers/` 下的计划保留其写作时的背景。新设计涉及不同语义时，会在正文标明差异；例如假设是否被反驳应由协议和证据决定，不能机械地把 DRAW/LOSS 转换为 REFUTED。

2026-09-12 的两份原始讨论草稿已整理到 `autonomous-research/`；原路径保留跳转说明，正文统一维护在上述两份规范中。
