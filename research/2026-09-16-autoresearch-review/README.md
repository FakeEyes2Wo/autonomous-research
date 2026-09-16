# AutoResearch 文献调研与改造方案

检索截止：2026-09-16。交付状态：**调研与设计供审阅；审阅后实施**。本轮没有修改运行代码、合并分支或运行付费实验。

## 第二轮：结合 TODO 的 RAG 与 benchmark 专项

实施入口：**[详细实现计划与批次](../../docs/superpowers/plans/2026-09-16-rag-research-roadmap.md)**。已分解为文献检索、研究运行时、评测与界面三个子计划，包含接口、代码落点、失败测试、迁移与验收；仍处于审阅阶段。

最新范围调整：用户要求 **benchmark 暂缓**。当前计划只安排文献 RAG、研究接入、阅读界面和长任务恢复，保留软件测试；下文与专题中的 benchmark 调研作为后续参考，不作为当前实施前置条件。

用户继续要求探索论文 RAG、论文表头与科研实验评测。新增的 **[统一 RAG 方案](rag-design.md)** 覆盖根 TODO，给出了字段表、来源/版本/原文片段结构、关键词到混合检索的递进路线、当前代码接点和分层 benchmark。

配套：[科学文献 RAG 阅读](rag-literature-methods.md)、[解析与入库依据](rag-ingestion-notes.md)、[图检索及索引一致性](rag-index-and-memory.md)、[其他研究 Agent 的实验接口与本项目 pilot](rag-and-research-benchmark-design.md)。新增阅读范围各见对应文档，不并入下文第一轮的 24 篇统计。

关键新增发现：已有 paper wiki/KG 与 PDF 下载可复用，但缺少原文片段检索契约；deep-dive 按引用次数挑 baseline，需要改为按任务和复现条件匹配。第二轮将简单文献 RAG 单独提前交付，先做可追溯关键词基线，再据评测增加 dense/rerank/图检索。[根 TODO](../../TODO.md) 已增加未完成交付项与报告入口。

## 建议先读

1. **[完整改造方案](proposal.md)**：现状对照、三条路线、六项改进、架构、代码落点、实施顺序与验收方法。
2. [端到端自主科研系统](scientific-systems.md)：AI Scientist v1/v2、Agent Laboratory、co-scientist、AgentRxiv、Kosmos、FARS。
3. [实验搜索与评测](experiment-search-and-evaluation.md)：AlphaEvolve、AIDE、ResearchAgent、MLAgentBench、MLGym、RE-Bench、PaperBench、ScienceAgentBench、MLR-Bench、两种 AutoResearchBench 与 AIRS-Bench。
4. [长程运行系统](long-horizon-runtime.md)：MemGPT、Reflexion、Voyager、AgentFold、DeepAgent、MAGE、METR、Auto-RecSys，以及 Anthropic/Temporal 官方工程资料。
5. [近期论文与综述补充](recent-papers-and-surveys.md)：IDEAgent、ScientistOne、实验忠实度审计、探索收窄研究、2026 年 9 月案例及七项综述/综述项目。

专题报告保留各自的分析；跨专题的架构选择、优先级和实施范围以完整改造方案为准。

## 最重要的代码发现

**main 与未合并分支的能力不同。** 当前 main 为 `f415dff`；本地 `feat/evidence-driven-research@5034eb1` 已实现四条运行路径的证据反馈、版本化假设修订、冻结协议、原始来源绑定、作用域记忆和 unknown 回执暂停。这些不应再列成从零开发。

因此，之前“缺少结构化结果→新假设血缘”的判断只适用于 main。第一步应审查并整合已有分支，随后增加它仍缺少的候选选择和持久作业协调。[源码证据与能力对照](proposal.md#1-结论与基线)列出了具体文件。

已有分支的历史记录报告 232 项测试通过；本轮未重新运行，不将该数字作为当前集成验证结论。工作区已有其他未提交改动，本轮报告不包含对它们的修改或还原。

## 推荐改变

| 顺序 | 改变 | 用户能观察到的改善 | 主要依据 |
|---|---|---|---|
| P0 | 整合已有证据分支，统一 ResearchStore 事实源 | 每个新假设都能追到父版本、结果与协议；统一 ResearchTree 继续展示 | 本地代码差距审查 |
| P1a | 持久 job controller：提交、查询、收集、取消、恢复、预算 | 控制器重启后接回仍在运行的实验，复用已完成结果；未知状态不盲目重交 | [Auto-RecSys](https://arxiv.org/abs/2609.10922)、[Temporal 官方文档](https://docs.temporal.io/) |
| P1b | 候选档案与实验选择器 | 保留竞争解释，按区分解释的能力、可执行性和成本选择下一实验 | [AI Scientist-v2](https://arxiv.org/abs/2504.08066)、[IDEAgent](https://arxiv.org/abs/2607.22375)、[AlphaEvolve](https://arxiv.org/abs/2506.13131) |
| P1c | 逐项实验协议、依赖任务、多产物验证 | 环境/基线/正式实验分别验收，只重做失效步骤；方法与结果可对账 | [FARS](https://arxiv.org/abs/2606.31651)、[Beyond Execution](https://arxiv.org/abs/2608.26753) |
| P2a | 当前任务交接包、可展开上下文、经过测试的程序经验 | 长历史下保留必要反证；有效工程修复可复用，源记录失效后停止复用 | [MAGE](https://arxiv.org/abs/2606.06090)、[AgentFold](https://arxiv.org/abs/2510.24699)、[Voyager](https://arxiv.org/abs/2305.16291) |
| P2b | 主张—数值—代码—引用审计与规模评测 | 最终报告能定位每个数值的原始数据，并暴露失败、冲突和未知 | [ScientistOne](https://arxiv.org/abs/2605.26340)、[PaperBench](https://arxiv.org/abs/2504.01848) |

这些是基于文献和代码的设计推断，论文没有直接验证本项目的改动。候选并发初版设为 1；新增 agent 角色按具体审查需求触发。先使用本地可靠执行后端，再依据真实需求接入远端队列或工作流平台。

## 结果如何影响下一轮 prompt

建议由已提交快照构建输入：**当前目标/协议 + 已验证观察 + 支持与反证 + 未知和执行故障 + 候选历史 + 剩余预算**。模型提出新候选时必须给出父版本、来源证据、改变的假设、可观察预测与下一实验；随后由选择器决定执行哪项。

例如训练 OOM 进入执行修复；有效测量否定预测进入科学修订。两者产生不同下一动作，不能都归结为“实验失败，重新想一个点子”。检索上下文保留反证，不因 token 不够而省略决定所必需的记录。完整输入/输出示例见 [方案 §6](proposal.md#6-改进四按当前任务构造上下文并能回查完整记录)。

## 调研范围和阅读记录

用户要求的“所有相关论文”按广覆盖检索执行，但本报告不宣称穷尽全球文献。重点是可迁移到当前计算型科研系统的闭环、搜索、验证、长期记忆和运行时；湿实验专用系统作为补充参考。

三个子 Agent 分别阅读系统、实验搜索/评测、长程运行；主 Agent 查漏补缺、核对近期研究并对照代码。按各报告的阅读记录：

| 分组 | 阅读方法/实验/限制等正文重点章节 | 另行标注的范围 |
|---|---:|---|
| 端到端系统 | 5 篇 | FARS 方法片段；Kosmos 摘要；Robin、Virtual Lab 等补充线索 |
| 搜索与评测 | 7 篇 | AIDE、MLGym 摘要/项目资料；近期 benchmark 定义核实 |
| 长程系统 | 8 篇 | 两篇 Anthropic 工程文章、Temporal 官方文档 |
| 主 Agent 近期补充 | 4 篇 | 两篇 9 月案例摘要；综述 S03 部分章节；其他综述摘要/目录 |
| **合计** | **24 篇不同论文的正文重点章节** | 不包含摘要核实、工程文档或综述部分阅读；不表示逐页审读全部附录 |

每项均附一手链接及适用边界。摘要级条目没有被写成全文验证；自动评分、作者报告的准确率、等价研究时间和 workshop 接收率没有被当成本项目效果。检索式、限流情况及版本问题见近期补充报告末尾。本轮未复现论文实验。

## 实施后怎样验证

- **可靠性：** 故障注入覆盖提交窗口崩溃、重复回执、控制器竞争、未知远端状态、取消未确认、预算恢复。
- **长程持续性：** 做真实跨进程/跨会话持续运行，报告恢复耗时、人工介入、重复提交、资源增长与丢失状态。
- **科研收益：** 固定模型和总预算，比较 main、整合分支、候选选择器及上下文/经验组件的逐项消融；报告有效证据成本、独立复现率、探索覆盖与全量失败。

采用改动的依据是可重复的可靠性和任务收益。设计细节及可执行验收条件见完整方案 §3–11。
