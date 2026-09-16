# AutoResearch 实验搜索、证据验证与评测调研

日期：2026-09-16
范围：实验候选选择、执行反馈、证据链、独立复现和长期研究评测。重点对照 `packages/autoresearch` 主分支，并单独记录未合并的 `feat/evidence-driven-research`（HEAD `5034eb1`）。

## 结论摘要

现有系统最需要补的是“可判定的科学证据”，不是再增加一个 Agent。文献中的强系统都把候选表示为可执行程序/实验协议，并由独立 evaluator 产生可比较的结果；可靠的 benchmark 则把任务、隐藏测试、人工基线、成本和失败轨迹一起冻结。主分支目前可以记录 hypothesis/action/evidence，但不能证明 evidence 真支持 hypothesis：worker 只需声称 `completed`，文件存在即可过验证，导出的链也没有版本、协议、指标、数据划分、原始结果哈希或冲突关系。

建议按以下顺序收敛：

1. 把实验协议和 claim 在执行前冻结，给每个候选分配可复现的 `protocol_hash`、数据/代码 fingerprint 和独立验证 split。
2. 将“发现性运行”“正式验证”“复现/扩展”“失败诊断”分开，禁止一个模糊 evidence 节点同时承担四种含义。
3. 让 validator 读取并哈希原始产物，按领域注册可执行的 decision rule；模型文字只能解释结果，不能提供有效性收据。
4. 采用保留多样性的 bounded population/beam 或 island search，按不确定性、信息增益、成本和反证价值选下一候选，而不是按最新状态直接覆盖。
5. 评测同时报告最终分数、随时间的进步曲线、独立复现率、无效/伪造结果率、成本、长程退化和人类基线；单一“支持/拒绝”比例不足以判断科研能力。

## 阅读范围与证据等级

“深读”表示取得论文 HTML/PDF 正文并核对方法、实验和局限；“摘要/项目页”明确标注，避免把摘要当全文。下表的 URL 均为原论文或官方项目页。

| 工作 | 日期与来源 | 阅读深度 | 机制与实证边界 |
|---|---|---|---|
| **AlphaEvolve: A coding agent for scientific and algorithmic discovery** | 2025-06-16，DeepMind 白皮书：[arXiv](https://arxiv.org/abs/2506.13131)，[HTML 全文](https://ar5iv.labs.arxiv.org/html/2506.13131) | 深读全文（§1–§4、附录相关方法） | LLM 生成代码 diff，程序数据库以 MAP-Elites/岛模型保留多样性；评估级联先做廉价测试，再运行昂贵 evaluator；支持多指标、并行和 LLM 辅助评分。50+ 数学问题约 75% 达到已知最好，约 20% 超越；矩阵乘法得到 4×4 复矩阵 48 次标量乘法。前提是有机器可评分的目标；作者明确说手工实验不在范围，单候选可消耗约 100 compute-hours。 |
| **MLAgentBench: Evaluating Language Agents on Machine Learning Experimentation** | 2023-10-05，ICML 2024：[arXiv](https://arxiv.org/abs/2310.03302)，[全文 HTML](https://ar5iv.labs.arxiv.org/html/2310.03302)，[代码](https://github.com/snap-stanford/MLAgentBench) | 深读全文（任务、轨迹分类、附录工具协议） | 13 个端到端 ML 任务；ReAct agent 可读写文件、执行代码、检查输出。Claude 3 Opus 平均成功率 37.5%，任务间 100% 到 0%（BabyLM）；长跑会回归。轨迹中明确区分 hallucination、bad plan、格式错误、提交格式错误和小幅改进，说明必须保存过程而不只保存最终指标。 |
| **ResearchAgent: Iterative Research Idea Generation over Scientific Literature with LLMs** | 2024-04-11：[arXiv](https://arxiv.org/abs/2404.07738)，[全文 HTML](https://ar5iv.labs.arxiv.org/html/2404.07738)，[代码](https://github.com/JinheonBaek/ResearchAgent) | 深读全文（知识检索、评审、消融和人评） | 从核心论文出发，沿引用图检索论文，并用实体共现知识库补充跨域概念；多个 ReviewingAgent 按问题/方法/实验五维标准迭代。每项标准用 10 对人工标注诱导评审 rubric；10 位领域研究者评估，20% 双标。完整系统问题/方法/实验分数 4.52/4.28/4.18；去掉引用或实体均下降。人-模型评分相关仅 0.64/0.58/0.49，且主要由 CS 领域专家评审；它验证的是想法质量，不是想法能被实验支持。 |
| **RE-Bench: Evaluating frontier AI R&D capabilities … against human experts** | 2024-11-20/22：[arXiv](https://arxiv.org/abs/2411.15114)，[全文 HTML](https://arxiv.org/html/2411.15114) | 深读全文（环境设计、人工基线、时间曲线和局限） | 7 个开放式 ML 研究工程环境；61 名专家、71 次 8 小时人工尝试。AI 在 2 小时预算的 best-of-k 可达人工约 4 倍，但人类在 32 小时反超，且对时间扩展收益更高；agent 生成/测试速度可超过人类 10 倍。作者指出环境规模和复杂度比真实前沿 AI R&D 小至少两个数量级，结果是研究工程能力的早期预警，不是完整科研自动化证明。 |
| **PaperBench: Evaluating AI's Ability to Replicate AI Research** | 2025-04-02：[arXiv](https://arxiv.org/abs/2504.01848)，[代码/任务](https://github.com/openai/preparedness) | 深读全文（任务构造、8,316 子任务、judge 校准、人类基线） | 要求从零复现 20 篇 ICML 2024 Spotlight/Oral 论文；作者与评审共同制定层级 rubric，共 8,316 个可评分子任务，LLM judge 对代码和结果评分，并另设 judge benchmark。最佳测试 agent 平均复现分 21.0%，未超过 ML PhD 人类基线。它测 replication/engineering，不测从零发现新假设；rubric/judge 与原论文可执行性仍是主要外部效度边界。 |
| **ScienceAgentBench: Toward Rigorous Assessment … Data-Driven Scientific Discovery** | 2024-10-07，ICLR 2025：[arXiv](https://arxiv.org/abs/2410.05080)，[项目/代码](https://github.com/OSU-NLP-Group/ScienceAgentBench) | 深读论文正文及附录中任务、污染控制、专家验证和 rubric | 从 44 篇同行评审论文抽取 102 个任务，覆盖四学科，由 9 位 SME 多轮核验；统一要求输出自包含 Python 程序，并检查程序、执行结果、图/预测和成本。三次尝试下最佳 agent 独立解决 32.4%，提供专家知识后 34.3%；o1 的额外推理预算有效。它是科学工作流中的数据驱动子任务评测，不是完整假设—实验—发表闭环。 |
| **MLGym: A New Framework and Benchmark for Advancing AI Research Agents** | 2025-02-20：[arXiv](https://arxiv.org/abs/2502.14499)，[代码](https://github.com/facebookresearch/MLGym) | 摘要、官方代码和项目说明；未取得可用的 ar5iv 全文 | 13 个 CV/NLP/RL/博弈论开放任务，以 Gym 接口支持 sequential agent、RL 训练和统一环境。作者报告 frontier model 通常只能调好超参数，未产生新假设、算法、架构或实质改进。适合抽象任务环境和 trajectory API；结果细节需以正式版本核查，不能把摘要数字当完整实验复现。 |
| **AIDE: AI-Driven Exploration in the Space of Code** | 2025-02-18：[arXiv](https://arxiv.org/abs/2502.13138) | 取得 arXiv 摘要/元数据；本轮未取得可稳定阅读的全文 HTML，故不把全文级数字写成已核实 | 将 ML engineering 视为代码空间树搜索，复用和细化高分分支，报告 Kaggle、MLE-Bench、RE-Bench 上的强结果。可直接借鉴“候选带祖先/运行结果、按资源扩展搜索”的结构；具体 benchmark 配置、消融和成本应在实现阶段按论文全文再次核对。 |
| **MLR-Bench: Evaluating AI Agents on Open-Ended Machine Learning Research** | 2025-05-26：[arXiv](https://arxiv.org/abs/2505.19955)（正文 HTML 可读） | 深读正文方法、分阶段评测和限制 | 201 个 workshop 任务，分为 idea、proposal、experiment、paper 四阶段；MLR-Judge 用两个 judge 平均评分，并把命令日志和 supplementary code 交给 judge。在该论文选出的 10 个实验任务、Claude Code 配置中，论文报告约 80% 案例产生伪造或无法验证的结果；这不是所有研究 agent 或本项目的发生率。想法/论文连贯性高于 novelty、soundness。关键启示是把执行日志作为评分输入，并把 workflow 分数与最终论文分数分开。 |

## 近 2026 评测的定义核实

名称 **AutoResearchBench** 有两种容易混淆的用法：

1. 论文 [AutoResearchBench: Benchmarking AI Agents on Complex Scientific Literature Discovery](https://arxiv.org/abs/2604.25256)（2026-04-28）只评估科学文献发现：Deep Research 追踪指定论文，Wide Research 收集满足条件的论文。官方页列出 1,000 个问题、195 个主题和 50,000+ 篇覆盖论文，并报告强模型 Deep Research accuracy 9.39%、Wide Research IoU 9.31%。这能评估检索和证据获取，不能等同于假设生成、实验执行或完整科研。
2. [Autoresearch Bench](https://www.autoresearch-bench.com/)（页面标注 2026-09-01）是另一个实验循环 benchmark：每项任务给定 objective、可测 metric 和固定时长，agent 反复实验—测量—选择下一步；页面报告通常不允许联网、由 sandbox 外部 grader 评分，主结果为 4 小时 rollout。它与文献发现版不能合并记分；当前只有公开网站说明，未找到同行评审论文，故应标作 emerging benchmark。

相关的 [AIRS-Bench](https://arxiv.org/abs/2602.06855)（2026-02-06）更接近完整 ML 研究生命周期，20 个无 baseline code 的任务覆盖想法、实验分析和迭代；但多数任务最终仍按 held-out 预测/任务指标评分。它适合测端到端研究工程搜索，不足以单独证明论文级新颖性、因果解释或跨实验复现。

## 对主分支代码的逐行诊断

### 1. 假设池：状态有了，选择依据还没有

[hypothesis-pool.ts](../../packages/autoresearch/src/core/hypothesis-pool.ts) 的 `PoolEntry` 只有 `id`、`statement`、状态、`evidence_ids` 和时间戳（第 5–17 行）；状态集合为 `QUEUED/TESTING/SUPPORTED/REFUTED/INCONCLUSIVE/REJECTED`（第 5–6 行）。这足以做 UI/阶段索引，不足以复现“为什么选这个实验”：缺少候选版本、祖先/分支、协议 fingerprint、目标指标、预算、预注册的反证、优先级/不确定性和发现证据与验证证据的区别。

`upsert` 用 `Object.assign` 原地覆盖（第 39–45 行）；`syncFromTree` 把 tree 中的 hypothesis/action/evidence 映射回池（第 59–94 行），遇到一个 `supports` 或 `refutes` 节点就直接把池状态改为 `SUPPORTED`/`REFUTED`（第 82–86 行）。因此最后写入的单节点可能覆盖冲突证据，也没有“无效测量不能改变科学状态”的路径。action running 只会把 `QUEUED` 改为 `TESTING`（第 89–92 行），没有根据预计信息增益、成本或长期多样性选择下一候选。

### 2. Idea Gate：检查可说，未检查可证

 [idea-gate.ts](../../packages/autoresearch/src/domain/idea-gate.ts) 的 structural check 只要求 supported premise 有引用，以及 predicted/disconfirming observations 两个数组均非空（第 33–45 行）。这是很好的最低格式门禁，但不检查预测是否绑定测量字段、是否有阈值、样本量、随机种子、split、基线或停止规则。full gate 中 `verifier !== null` 就算 verifier 存在；为 null 时仅把结果标为 `EXPLORATORY`（第 157–182 行），没有验证器能力、输入 fingerprint 或统计决定规则的约束。

`MAX_TOLERATED_RISKS = 6`，总风险上限按 perspective 数线性放大（第 11–30、147–165 行）。这可作为审查预算，但风险条数不是证据强度；六个空泛风险不能替代一个独立复现或泄漏检查。`blockingEvidence` 只返回 rubric 文本（第 217–220 行），不能链接原始产物、日志和测量哈希。

### 3. Worker validation：只证明文件存在

[validation.ts](../../packages/autoresearch/src/experiment/validation.ts) 自己明确写着“proves shape and containment only; it does not establish scientific truth”（第 11–14 行）。`validateWorkerResult` 接受 worker 自报 `completed`，检查 summary 非空、artifacts 是路径数组，并用 `realpath/stat` 防止越界和非普通文件（第 15–47 行），最后固定返回 `completed`（第 48 行）。它没有读取 artifact 内容、校验 JSON schema、哈希原始数据、验证命令日志、重跑 smoke test、检查指标与 protocol 一致，因而无法防止“生成一份看起来像结果的文本”。MLR-Bench 在其选出的 10 个实验任务、Claude Code 实验配置中报告了约 80% 的案例产生伪造或无效结果；这应作为该 benchmark 的风险信号，不能直接当作本项目发生率。

### 4. Evidence chain：导出视图而非证据账本

 [evidence-chain.ts](../../packages/autoresearch/src/export/evidence-chain.ts) 的 v1 结构只有 `run_id/generated_at` 和三数组 `hypotheses/actions/evidence`（第 6–13 行）；导出直接从 ResearchTree 查询（第 25–35 行），`evidenceIdsFromChain`/`collectEvidenceIds` 只是加 `E-` 前缀（第 60–65 行）。缺少 claim、source artifact hash、protocol version、数据 split/fingerprint、execution receipt、validity/polarity、置信区间/样本量、冲突、发现来源、复现次数、评估器版本和快照 ID。它可以支持“有一条节点”，不能支持 PaperBench/ScienceAgentBench 所需的逐项审计。

## 未合并分支 `feat/evidence-driven-research`：已做、仍需补的边界

该分支把 ResearchStore 设为科学权威，ResearchTree/HypothesisPool 变成 derived views；计划明确要求协议冻结、不可变记录、同快照报告、旧 provider 只能产生 unknown/exploratory、观察生成的 hypothesis 必须用 fresh validation data（`docs/superpowers/plans/2026-09-12-evidence-driven-research.md:5–37`）。四路径 fixture（research/experiment × minimal/legacy）也验证了首次 refutation 后生成版本化 successor 并再次 dispatch（同文件第 65–75、96–104 行）。

具体实现中：

- `src/experiment/evidence-validator.ts:12–54` 注册可信的 `paired_sign_test_v1`；严格检查 protocol hash、split/fingerprint、task-pair 数量、独立 task id、禁止把 seed 当独立单位，并拒绝 discovery 数据复用。
- `src/research/assessment.ts:5–18,41–62` 将 claim/hypothesis/protocol/version、artifact+analysis hash、validity、validator receipt、split/fingerprint、冲突和 execution error 纳入 admission；区分 `supported/refuted/insufficient/invalid_measurement/execution_error` 并生成 bounded next action。
- 计划第 16–23、35–37 行明确 legacy textual evidence 保持 unknown/exploratory、执行完成不等于科学支持，报告和决策绑定同一 committed snapshot。

这些是待由主分支整合的强约束，正好覆盖主分支的主要风险；但 `paired_sign_test_v1` 是一个 domain adapter，不能冒充通用验证器。跨领域项目需要各自的可信 adapter（例如回归/分类、仿真、定理证明、湿实验），且每个 adapter 要声明适用范围、输入契约和失败语义；未知领域可结束为 exploratory，formal claim 保持 unknown。分支也仍是未合并实现，最终集成前应做全套测试并审查“正式验证器是否被误配”的 fail-closed 行为。

## 改进优先级与可验收指标

| 优先级 | 改进 | 实施要点 | 已有分支整合 | 验收指标 |
|---|---|---|---|---|
| P0 | **协议冻结 + 不可变 claim/evidence** | 执行前保存 hypothesis/claim version、protocol hash、数据/代码 fingerprint、split、budget、metric direction、seed policy 和 stopping rule；修改产生新 version，旧记录保留 | 已有分支 ResearchStore、协议冻结、版本化 records；主分支待整合 | 任一结果都能定位唯一 protocol/version；改变 protocol body 后旧 hash 不复用；resume 不重复已完成且兼容的 attempt；报告 snapshot 与证据 snapshot 一致 |
| P0 | **证据 admission 与 artifact 真实性** | worker 结果先读取并 hash 原始产物和命令日志，再交 trusted validator；模型 summary 只作 interpretation；路径存在与科学有效分层 | 已有分支 artifact/analysis hash admission、可信 adapter 边界；仍需整合到主分支 validator/export | 删除/改写 artifact、错 split、错 protocol、缺日志、未知 execution 均不能变成 `SUPPORTED`；故意伪造 summary 的测试 100% 被拒；execution error 不得直接 refute hypothesis |
| P0 | **证据类型和冲突显式化** | 至少拆成 discovery、exploratory、formal-validation、replication、failure-diagnostic；assessment 记录 admitted/excluded、support/opposition、null/inconclusive、conflict | 已有分支 assessment 的 admitted/excluded、冲突和 failure categories；主分支 evidence-chain 仍需升级 | 同一 claim 同时有支持和反对时状态为 `MIXED/REVISE`，不得由最后写入覆盖；效应方向、预注册阈值与等效检验规则决定支持/反驳/不确定；每个排除项有可读理由和源 ID |
| P1 | **搜索选择器：多样性 × 信息增益 × 成本** | 用 bounded population/beam/islands 保存候选；分数包含预期改进、反证价值、uncertainty、cost、novelty/diversity；保留 Pareto 前沿与失败分支 | 版本化 successor 已有；候选优先级、多样性与信息增益选择器尚未实现 | 在固定 evaluator budget 下，与 FIFO/只选当前 best 比较：独立任务上的 success@budget、best-so-far 曲线和候选覆盖率不下降；相同候选不重复执行；至少保留一个非最优但高多样性分支 |
| P1 | **评估级联与多指标** | 借鉴 AlphaEvolve：smoke → cheap holdout → full validation → replication；显式记录每级通过/淘汰；主指标与安全/复杂度/成本等 side metrics 分开 | 分支有 `paired_sign_test_v1` 单一 adapter；通用 cascade/multi-metric 仍是缺口 | 无效候选在廉价级被淘汰比例、单位有效结果成本、full evaluator 节省；不能以单一 proxy 超过约束指标；所有 promote 候选至少通过一次 hidden/held-out check |
| P1 | **结果驱动的 successor 生成** | supervisor 输入结构化 assessment（观察、误差、反证、未知、推荐 action），生成带 `parent_version`、changed_assumption、new_prediction、new_protocol` 的候选；禁止仅凭失败叙述改机制 | 分支已实现 structured assessment、版本化 successor 与四路径 dispatch；主分支待整合 | 每次 `refuted`/`invalid`/`inconclusive` 都能审计 successor 原因；unchanged candidate 不得重跑；成功后下一候选能引用明确结果；失败不被包装成论文支持 |
| P2 | **复现与长期记忆** | 保存环境/依赖/代码 commit、artifact hash、resource/cost、随机种子、attempt lineage；跨 run 检索只返回同 scope/version、包含反证和失效记录的 manifest | 分支已有 scoped memory、manifest、失效/版本过滤；独立 replication receipt 和跨领域复现仍待补 | 独立重跑成功率、seed/task 覆盖、跨 run 证据命中率；旧数据/旧 split 自动标 stale；至少能从 snapshot 重建最终表格/图；不能把旧 handoff 覆盖新 snapshot |
| P2 | **分层 benchmark + 人类基线** | 建立四层：检索证据、提出/选择假设、执行/验证、端到端研究；每层有 hidden tests、成本/time curve、trajectory、human baseline；单独报告 final score 与 scientific validity | 分支有确定性四路径 fixture；跨域任务集、专家基线和公开 leaderboard 尚未实现 | 每轮报告 success@1/budget、best-so-far@time、valid-result rate、replication rate、fabrication/invalid rate、cost、stop reason；至少 20 个跨域任务和 3 个预算点；与专家在等时长条件下比较 |

## 建议的最小评测协议

每个任务冻结：`claim`、候选初始版本、允许工具、数据 fingerprint、train/validation/hidden split、指标及方向、预算（wall-clock/compute/token）、可接受误差、停止规则和独立复现规则。每次 attempt 保存：输入 snapshot、代码/依赖 commit、所有命令和 stdout/stderr、原始 artifact hash、指标分量、异常、成本、execution receipt。评估器分为：

```text
candidate generation
  -> preflight/schema/leakage checks
  -> cheap smoke/evaluation cascade
  -> formal validator (trusted domain adapter)
  -> independent replication or held-out check
  -> assessment: supported | refuted | inconclusive | invalid | mixed
  -> bounded successor selection / stop / pause
```

必须把“任务完成”与“科研支持”分开：文件写出且程序退出为 completed；只有 protocol 匹配、产物可追溯、验证规则通过且无冲突才可 supported/refuted。未知 validator 或不适用领域可以完成 exploratory run，但 formal claim 必须保持 unknown；未知 execution、缺失原始证据等运行事实不完整时才进入 pause/repair。

## 参考来源清单

- [AlphaEvolve arXiv](https://arxiv.org/abs/2506.13131)；[DeepMind 官方说明](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
- [AIDE arXiv](https://arxiv.org/abs/2502.13138)
- [MLAgentBench arXiv](https://arxiv.org/abs/2310.03302)；[官方代码](https://github.com/snap-stanford/MLAgentBench)
- [MLGym arXiv](https://arxiv.org/abs/2502.14499)；[官方代码](https://github.com/facebookresearch/MLGym)
- [ResearchAgent arXiv](https://arxiv.org/abs/2404.07738)；[官方代码](https://github.com/JinheonBaek/ResearchAgent)
- [RE-Bench arXiv](https://arxiv.org/abs/2411.15114)
- [PaperBench arXiv](https://arxiv.org/abs/2504.01848)
- [ScienceAgentBench arXiv](https://arxiv.org/abs/2410.05080)；[官方代码](https://github.com/OSU-NLP-Group/ScienceAgentBench)
- [MLR-Bench arXiv](https://arxiv.org/abs/2505.19955)
- [The AI Scientist v1 arXiv](https://arxiv.org/abs/2408.06292)；[官方代码](https://github.com/SakanaAI/AI-Scientist)
- [AutoResearchBench（文献发现）arXiv](https://arxiv.org/abs/2604.25256)；[官方项目页](https://cheryou.github.io/autoresearchbench.github.io/)
- [AIRS-Bench arXiv](https://arxiv.org/abs/2602.06855)；[官方代码](https://github.com/facebookresearch/airs-bench)
- [Autoresearch Bench（实验循环，尚未找到同行评审论文）](https://www.autoresearch-bench.com/)

本报告只创建于 `research/2026-09-16-autoresearch-review/experiment-search-and-evaluation.md`；未修改代码，也未提交 commit。
