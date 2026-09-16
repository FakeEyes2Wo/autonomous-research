# 近期研究与综述补充

检索日期：2026-09-16。本文由主 Agent 阅读和整理，与三份子 Agent 报告互补。全文阅读指查看了全文中的相关方法、实验和限制章节，不表示复现了作者实验或逐页核查了全部附录。没有获取全文的来源明确标注。

## 近期直接相关研究

| 编号 | 论文与一手来源 | 版本与阅读范围 | 机制及证据边界 | 对本项目的启示（设计判断） |
|---|---|---|---|---|
| R01 | [IDEAgent: Agentic Quality-Diversity Search for Research Idea Generation](https://arxiv.org/abs/2607.22375) | 2026；读取 HTML v1 §3、§7、§9 | 用想法谱系与活动、历史、拒绝档案协调质量和多样性；有针对性的修复和细化。Yield 衡量通过质量阈值且互相不同的想法集合。作者实验覆盖 32 个计算机科学主题；评估主要依赖模型裁判，未验证这些想法的实际实验效果。 | 保留所有候选及淘汰理由，对机制而非措辞去重；同一想法的小修改归入同一谱系。质量筛选后再选下一实验；本项目还须加入资源可执行性条件，不能直接照搬论文的评分门槛。 |
| R02 | [ScientistOne: Towards Human-Level Autonomous Research via Chain-of-Evidence](https://arxiv.org/abs/2605.26340) | 2026；读取 HTML v1 §3–6、§9 | 区分引用、数值、方法和结论主张，组织可追溯证据链；并行探索后筛选、消融。审计核对分数复现、规则遵守、引用存在性、方法与代码一致性。研究包含 75 篇系统生成论文；部分审计仍依赖 LLM，引用存在不代表语义支持，基准适配也限制排名解释。 | 现有 snapshot 可作为数值主张的根；追加 claim→metric→artifact 及 method→code 映射。报告按快照生成，独立核对正式表格和关键方法，审计结果不自动代表新颖性认证。 |
| R03 | [Beyond Execution: Auditing Experimental Fidelity in LLM-Driven Scientific Research](https://arxiv.org/abs/2608.26753) | 2026-08；读取 HTML v1 框架、实验、讨论及附录部分检查逻辑 | ABE-Ralph 把复现要求写成结构、流程、评估约束；使用数量、语义与代码检查，限定故障修复的允许变化。作者研究 30 项复现任务，并另测发现任务。结构检查存在只核对模块出现的局限，语义审查也不能提供通用正确性证明。 | OOM 后改变 batch/数据量必须经过协议约束判断。增加实际数据样本、训练预算、必要组件运行回执；可执行成功、协议有效、科学支持分别登记。不要把 AST 中出现类名当成方法已经正确实现。 |
| R04 | [AI Research Agents Narrow Scientific Exploration](https://arxiv.org/abs/2605.27905) | 2026；读取 HTML v1 实验设计、主结果、附录生成统计 | 以共享种子文献研究四类框架、六个模型，分析有效生成想法的语义覆盖、对种子依赖及相关论文引用代理。该版本报告 37,802 个有效想法。研究发现探索集中；这是该模型/语料/代理指标下的观察，不能推断所有自主科研系统都无法创新，引用代理也不是已实现的研究影响。 | 添加竞争解释、问题重述、跨机制候选；监测有效不同机制数量和重复实验比例。语义距离用作候选查重辅助，不能单独决定科学价值或淘汰有效复验。 |
| R05 | [Autonomous Research for Open-Ended Problems: A Case Study on Telecom Ticket Retrieval](https://arxiv.org/abs/2609.13073) | 2026-09；已核实一手摘要，未深入全文 | 开放式工业检索任务的长期案例，报告自动化效果与操作负担，指出窄超参数搜索与开放研究的能力差异。仅作为近期案例线索，未复核成本与效果口径。 | 后续验证应加入真实跨周任务、停机恢复及人工介入记录；不能只跑短小单元测试。 |
| R06 | [Data-Efficient Language Modeling: From Frontier Advancement to Principle-Guided Model Improvement](https://arxiv.org/abs/2609.10702) | 2026-09；已核实一手摘要，未深入全文 | Qiushi Engine 的有限数据语言模型长期研究案例，连接性能改进、原则发现和原则指导的后续实验。暂不采纳摘要中的榜单结果作为本项目架构有效性的证明。 | 可将“发现有效改动→解释机制→预测新条件→独立验证”作为后续研究链评测任务，而非只测最终指标。 |

全文入口：[R01](https://arxiv.org/html/2607.22375v1)、[R02](https://arxiv.org/html/2605.26340v1)、[R03](https://arxiv.org/html/2608.26753v1)、[R04](https://arxiv.org/html/2605.27905v1)。所有效果均为作者在其设置下的报告，本轮没有复现实验。

## 用于查漏补缺的综述

| 编号 | 来源 | 阅读程度与用途 |
|---|---|---|
| S01 | [AI for Auto-Research: Roadmap & User Guide](https://arxiv.org/abs/2605.18661)；[作者维护目录](https://worldbench.github.io/awesome-ai-auto-research) | 核对摘要、全文目录及研究范围。覆盖科研生命周期，用于扩展检索词；网页标题使用 “A Survey”，与 arXiv 标题不同，按同一来源去重。 |
| S02 | [AutoResearch AI: Towards AI-Powered Research Automation for Scientific Discovery](https://arxiv.org/abs/2605.23204) | 一手摘要及[作者项目页](https://mr-tieguigui.github.io/Autoresearch/)。将工作流、验证及领域边界一起讨论，用作范围框架，非新系统实验证据。 |
| S03 | [Autonomous Research Agents: A Survey of AI Scientists and the Verification Gap](https://arxiv.org/html/2608.05179v1) | 读取 §3、§11、§13 部分、§14–15。强调成果可核验性及材料披露；其样本、编码方式和部分标签一致性限制泛化。页面提交日期写 2026-06，但编号为 2608，本报告保留编号并标注年份，不据此断定精确首发月份。 |
| S04 | [What's Missing in Autonomous Research? A Systematization of Systems, Benchmarks, and Verification](https://haizhaoyang.github.io/research/autoresearch-survey.html) | 阅读作者项目页的系统矩阵及验证分类，作为检索索引；没有逐篇复核其全部系统评级，不直接接受其“无系统达到某级别”的全称结论。 |
| S05 | [The Hitchhiker's Guide to Autonomous Research: A Survey of Scientific Agents](https://pubmed.ncbi.nlm.nih.gov/42566370/) | 核对出版记录与摘要；2026 TPAMI 版本，另有 2025 预印本。全文未完成阅读，仅纳入综述目录。 |
| S06 | [From AI for Science to Agentic Science: A Survey on Autonomous Scientific Discovery](https://arxiv.org/abs/2508.14111) | 核对一手摘要；跨领域自主科学背景，未深入全文。 |
| S07 | [From Automation to Autonomy: A Survey on Large Language Models in Scientific Discovery](https://arxiv.org/abs/2505.13259) | 核对一手摘要；自主程度分类背景，未深入全文。 |

## 论文以外的一手工程项目

[Karpathy autoresearch 的 program.md](https://github.com/karpathy/autoresearch/blob/master/program.md) 将可变训练代码、固定评估和单次训练预算分开，保存试验结果并迭代。这里按代码/实验项目引用，不称其为同行评审论文。它适合提醒本项目给 experiment adapter 明确“哪些能改、哪些冻结、什么算一次可比较试验”，其特定训练预算不能直接套用到所有科研任务。

## 本轮检索边界

检索将 autonomous research / AI scientist / automated scientific discovery、实验搜索与验证、长程 Agent 与持续执行分开。主 Agent 使用综述和近期论文交叉回溯，三个子 Agent 分别阅读端到端系统、实验搜索与评测、长程运行资料。

主 Agent 实际使用的代表性检索式包括：

- `autonomous AI scientist automated scientific discovery survey 2026 research agents papers`
- `AI Scientist v2 Agent Laboratory AgentRxiv AI co scientist Kosmos paper`
- `long horizon agents long running memory durable execution research paper 2026`
- `"AI for Auto-Research: A Survey"`
- `"autonomous research" "2608" arxiv`、`"autonomous research" "September" "2026" paper`
- `"AI Research Agents Narrow Scientific Exploration" arxiv`
- `"ScientistOne" "Chain" arxiv`
- `"IDEAgent: Agentic Quality-Diversity" arxiv`
- `"Beyond Execution: Auditing Experimental Fidelity" arxiv`

一手来源以 arXiv 全文、正式出版页面、作者项目/仓库和官方工程文档为主。搜索引擎日期与第三方摘要仅用于定位，版本与内容冲突时以实际阅读的一手版本为准；未确认的细节不纳入结论。部分请求遇到限流，重试后继续阅读；一个作者站的大 PDF 超过工具大小限制，改用 arXiv HTML。

这是截至检索日的广覆盖工程调研，不是穷尽性系统综述；没有声称检索到了世界上所有论文，也没有把摘要核实、全文阅读、代码审查和实际复现混为一谈。领域专用机器人、化学/生物实验室系统仅作结构参考；本轮重点是当前项目可运行的计算型科研。未进行付费实验或在线基准复现。
