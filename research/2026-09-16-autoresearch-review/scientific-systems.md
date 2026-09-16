# 端到端自主科研系统文献与当前实现审查

审查日期：2026-09-16（只纳入截至该日期已经公开的资料）

## 结论先行

当前 main 已有 ResearchTree、HypothesisPool、结果复盘和洞见抽象，但还没有把“新假设为何由哪条证据产生”编码成树上的血缘关系，也没有把协议、原始产物、验证器版本和负结果作为可冻结、可审计的科学状态。最直接的漏洞在：

- packages/autoresearch/src/service/steps/idea.ts:122-125 追加新假设时只写 status/artifacts，没有 parent；因此每轮假设在数据结构上都是根节点。
- packages/autoresearch/src/service/runner.ts:248-256 先同步树、运行结果复盘和洞见，再重新生成假设；新假设没有绑定到本轮 evidence 或产生洞见的 action，失败方向只能以提示文本传递。
- packages/autoresearch/src/service/runner.ts:359-505 的 minimal 路径只执行一次并无新假设入口。
- packages/autoresearch/src/core/research-tree.ts:37-60 只强制 action/evidence 有父节点，并未强制 hypothesis 的父节点类型、证据来源或版本；packages/autoresearch/src/core/hypothesis-pool.ts:59-95 也只按节点 id 同步状态，不能表达“修订假设”“证据不适用”或候选之间的竞争关系。

分支 .worktrees/evidence-driven-research 已完成大部分基础设施：冻结协议、哈希和不可变来源、证据准入、失败签名、版本化 claim/hypothesis、提交决策、作用域记忆和上下文隔离。这些能力应优先合并/复用；论文带来的净新增应集中在“多分支候选搜索与预算分配、独立反证/审查、实验计划合同、跨实验知识协作、可量化的候选排序和公开失败评估”，避免重写已有 store。

## 一手论文矩阵

| 论文（准确标题） | 一手 URL / 时间 | 阅读深度 | 方法与实验要点 | 证据范围与限制 | 对当前项目可用改变 |
|---|---|---|---|---|---|
| **The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery** | [arXiv:2408.06292](https://arxiv.org/abs/2408.06292)，2024-08-12；作者项目 [SakanaAI/AI-Scientist](https://github.com/SakanaAI/AI-Scientist) | 深读原预印本正文的方法、实验与限制 | 原版 v1 从人提供的 ML 代码模板开始，依次生成研究想法、做 novelty 检查、用 Aider 修改代码、运行实验、生成图表、写论文并用自动 reviewer 评估；覆盖 diffusion、transformer language modeling、learning dynamics，论文声称每篇成本低于 $15。 | 依赖主题专用的人写模板，实验空间和领域迁移受限；只做计算 ML；自动 reviewer 不是独立科学验证，原文也讨论错误实现、幻觉和安全风险。v1 不包含 v2 的模板自由树搜索或 workshop 投稿结果。 | 保留端到端阶段和 artifact 记录；把模板/领域依赖显式标注为 provenance，避免把自动评分当支持证据。 |
| **Agent Laboratory: Using LLM Agents as Research Assistants** | [arXiv:2501.04227](https://arxiv.org/abs/2501.04227)，2025-01-08；[项目页](https://agentlaboratory.github.io/) | 深读全文的三阶段架构、human/co-pilot 对比、模型和成本实验、限制性结果 | Literature Review→Experimentation→Report Writing；PhD/Postdoc/ML Engineer/SW Engineer/Professor 等专门角色协作，mle-solver 通过评分、自反思和自动修复迭代代码，paper-solver 迭代写作。15 篇 autonomous 论文由 10 名博士生抽评；co-pilot 在阶段检查点给人反馈。论文报告 gpt-4o 每篇约 $2.33，且人评整体约 3.5–4.0/10；自动评分约 6.1/10，明显高估。 | 主要是人给定 research idea 的 ML 辅助，不是开放世界发现；MLE-Bench 子集不能代表科学有效性；人评样本小、主题有限，模型版本和成本会变化。 | 在现有 runner 中引入显式角色输出契约和阶段检查点；把 human feedback 写成可追溯 revision record，而不是普通字符串；把自动 evaluator 与人工/独立 evaluator 的差距作为质量指标。 |
| **Towards an AI co-scientist** | [arXiv:2502.18864](https://arxiv.org/abs/2502.18864)，2025-02-26；[Google Research 页面](https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-powered-co-scientist/) | 深读全文的 Supervisor/worker/记忆架构、generate-debate-evolve/tournament、专家与湿实验评价、限制 | 基于 Gemini 2.0 的异步多 agent；Supervisor 管队列和资源，专门 agent 生成、排序、辩论、演化假设，持久 context memory 支持长时迭代。评价含 15 个 curated research goals、11 个专家比较、1,200 个 adversarial goals；药物再利用、肝纤维化 organoid、抗菌耐药机制有计算/湿实验合作验证。 | 只访问开放文献，可能漏掉付费论文和失败/负结果；图表等多模态信息利用不足；专家偏好和 Elo 是主观/自动评价，并非 ground truth；湿实验规模小且依赖领域专家。 | 把 HypothesisPool 从平面队列升级为候选锦标赛：生成→独立批评→成对比较→演化；保存每次比较的证据和模型/预算；将“未知/未验证”与支持分开，额外审查角色按信息不足条件可选触发。 |
| **AgentRxiv: Towards Collaborative Autonomous Research** | [arXiv:2503.18102](https://arxiv.org/abs/2503.18102)，2025-03-23；[AgentRxiv 项目页](https://agentrxiv.github.io/) | 深读全文的共享 preprint 机制、单/多 laboratory 实验、成本和冗余分析、novelty 限制 | 多个 Agent Laboratory 实验室向共享服务器上传/检索报告，持续复用先前研究。MATH-500 上，访问自身历史报告相对 baseline 提升 11.4%，多实验室共享达到 13.7%；平均每篇约 1.36h、$3.11，三实验室 120 篇总成本 $279.6，相比单实验室 $92，说明墙钟加速与总成本/重复工作存在权衡。 | 任务是推理/提示技术，不是现实科学发现；共享论文会引入重复、错误传播和检索偏差；多实验室实验更多说明协作效率，不证明新知识。 | 新增 project/branch 级“研究报告索引”和去重：候选发布前提取 claim、protocol、evidence hash；检索时返回支持、反对、重复和未知；并行实验须记录重复率、总 token/cost 与墙钟收益，不能只看最佳分数。 |
| **The AI Scientist-v2: Workshop-Level Automated Scientific Discovery via Agentic Tree Search** | [arXiv:2504.08066](https://arxiv.org/abs/2504.08066)，2025-04-10；[SakanaAI/AI-Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2) | 深读全文的 v1 对照、四阶段树搜索、VLM 反馈、ICLR workshop 人审和失败分析 | 去掉人写模板，先以高层方向+Semantic Scholar 形成想法，再由 Experiment Progress Manager 管理四阶段树：初始可行性、超参、主实验、ablation；每个节点生成计划和 Python，执行、保存 numpy 指标、绘图，VLM 检查图；LLM evaluator 选下一阶段根节点。三篇全自动投稿，一篇平均 6.33、约 top 45%，论文报告负结果。 | 只过 1/3，workshop 接收门槛远低于主会；作者指出正当性不足、数据重叠风险、图注错误和需要更广实验。树搜索成本和复杂度上升。 | 直接把当前 ResearchTree 扩为“候选假设→实验动作→结果→分析/ablation”的分层树；节点记录 plan/code/error/metrics/figures/reviewer；阶段结束前由 evaluator 做剪枝，同时保留被剪枝原因，禁止只保留最佳结果。 |
| **Kosmos: An AI Scientist for Autonomous Discovery** | [arXiv:2511.02824](https://arxiv.org/abs/2511.02824)，2025-11-04 | 仅阅读 arXiv 摘要和可核实的公开技术摘要；未将其计入正文重点阅读五篇 | 给定开放目标和数据集，最多运行 12h，数据分析 agent 与文献检索 agent 通过结构化 world model 共享状态，摘要报告约 200 rollouts、平均 42,000 行代码、1,500 篇论文/次；报告陈述绑定代码或一手文献，展示跨多个生物医学/材料案例。 | 摘要级证据不能审查全部实验细节；陈述准确率不等于发现选择、因果性或可复现性；案例数少且依赖数据集和领域合作者。 | 将“共享世界模型”落实为结构化 ResearchContext：区别 observation、interpretation、claim、source；每个 cycle 只允许读取适用范围的记录，并显示冲突/未知；长循环用周期摘要而不是把所有 prose 塞回 prompt。 |
| **FARS: A Fully Automated Research System Deployed at Scale** | [arXiv:2606.31651](https://arxiv.org/abs/2606.31651)，v1 2026-06-30，v2 2026-07-13；[open-fars/openfars](https://github.com/open-fars/openfars) | 深读摘要和可获取的全文方法片段（Planning/Experiment/Auditability），结果与限制；arXiv HTML 在本次会话间歇性降级 | 规模化 AI-for-AI：共享 workspace 记录 proposal、code、logs、results、manuscript；166 篇完整论文覆盖 67 个细分主题，282 份结构化 review 覆盖 140 篇。Planning 不给 worker 自由目标，而生成机器可读的两级 experiment contract；五类任务是 environment、baseline、main、effectiveness、analysis；每项有顺序步骤，JSON 校验后执行。Experiment 阶段把 orchestration 与执行分开，每项有独立计划和 review，effectiveness gate 后才做 analysis，并保留负结果。 | 论文自己报告窄实验范围、方法学不足和 integrity 问题；公共部署的 review 是自愿者样本，166 篇论文并非均达到可发表质量。大规模产出证明吞吐/可审计性，不证明真实科学突破。 | 优先采用 contract + gate：冻结协议后 worker 不得改 metric、split、stopping rule；每个实验 item 独立 receipt；主实验失败应自动进入 repair/replicate/revise 而非由 supervisor prose 覆盖；公开全量失败和完整 artifact 指标。 |

## 阅读范围与深度

正文重点阅读 5 篇：AI Scientist v1、Agent Laboratory、AgentRxiv、AI co-scientist、AI Scientist-v2；另阅读 FARS 的 Planning/Experiment/Auditability 相关章节片段；Kosmos 仅阅读摘要和可核实公开技术摘要，未计入 5 篇。对应精确 URL 为：[v1](https://arxiv.org/abs/2408.06292)、[Agent Laboratory](https://arxiv.org/abs/2501.04227)、[AgentRxiv](https://arxiv.org/abs/2503.18102)、[AI co-scientist](https://arxiv.org/abs/2502.18864)、[v2](https://arxiv.org/abs/2504.08066)、[FARS](https://arxiv.org/abs/2606.31651)、[Kosmos](https://arxiv.org/abs/2511.02824)。

## main 分支缺口（相对当前代码）

### 1. 假设血缘不完整

- service/runner.ts:127-139 创建根假设并同步 pool。
- service/steps/idea.ts:69-127 生成/反思/门控候选，但 :123 无 parent、无来源 evidence id、无候选的预测/反事实字段。
- runner.ts:248-256 在本轮 evidence 之后调用新一轮 idea generation，却没有向函数传递本轮 evidence/action 的结构化 id。
- core/research-tree.ts:37-60 允许 hypothesis 无 parent，也不限制 parent 必须是 hypothesis/evidence/action 的合法关系；update() 还允许任意 parent 改写。

结果：树可以展示节点，却不能回答“哪个证据促成了哪次修订”“被拒绝候选为何被拒绝”“新假设是否只是在复述旧结果”。

### 2. evidence 不是科学合同

runner.ts:229-244 执行 worker 并调用 evidence agent，但当前 ResearchTree 节点只有自由文本/status/artifacts。没有冻结 metric、controls、split、seed、预算、stopping rule、代码/数据/treatment/model fingerprint，也没有验证器版本与原始字节哈希。因此 supervisor 的 continue/revise/finish/fail（runner.ts:280-300）可能基于 prose 做科学判断。

### 3. 失败可见但不可区分

runner.ts:250-253 把 failureDirections 和 insight 传回 idea agent，但 hypothesis-pool.ts:77-93 只把 evidence verdict 映射成 SUPPORTED/REFUTED/INCONCLUSIVE；执行错误、验证失败、数据复用、预算耗尽和真正 refutation 没有不同状态。这样会误把“实验坏了”当作“假设错了”。

### 4. minimal/standalone 断开研究闭环

runMinimal() 在 runner.ts:359-505 生成一个计划并执行一次；即使 post-result synthesis 运行（470-471），也没有 runIdeaGeneration、候选 parent、版本化协议或第二次验证。论文体系显示低配路径仍需明确合同、独立检查和修订策略；否则 minimal 只能是一次性任务执行器。

## feat/evidence-driven-research 分支已做能力（不要重复实现）

以下结论来自只读审查 .worktrees/evidence-driven-research，提交 5034eb1；该分支尚未合并到 main。

- **冻结科学合同和可恢复 cycle**：src/service/research-cycle.ts:21-70 在 worker 前从 planner 输出冻结 claim、hypothesis、protocol、fingerprints、decision rule，并写 frozen.json；78-90 记录 unknown receipt，避免未知执行被静默重试。
- **原始来源、不可变快照与单一 CURRENT 指针**：src/service/research-cycle.ts:108-146 捕获 artifact、验证 evidence、生成 assessment；src/research/store.ts:88-149,195-242 校验记录哈希、历史不能覆盖/丢弃、父快照和版本必须前进，并用锁保护 commit。
- **证据准入和失败分类**：src/research/assessment.ts:4-64 检查 claim/hypothesis/protocol 版本、protocol hash、来源路径/哈希、验证器、split/fingerprint、执行未知/错误、重复 unit；生成 failure_signature 和 repair/revise/replicate/pause。
- **证据驱动版本修订**：src/research/revision.ts:4-43 要求新候选改变 statement/prediction、引用已有 admissible evidence、填写 prediction/falsification/rationale，并冻结新 protocol；无证据或相同候选不能修订。
- **范围受限上下文**：src/service/research-context.ts:9-35 只把当前 committed snapshot、冻结 protocol、适用 evidence 发给 role；worker 不读历史 evidence/held-out answer/treatment-specific memory，减少泄漏。
- **结构化研究记忆**：src/memory/research-experience.ts:52-128 将 observation 与 interpretation 分开，按 protocol/split 记录 applicability、source hashes、依赖；src/memory/store.ts:88-172 检测版本冲突、依赖失效并沿依赖传播 invalidated。

## 论文带来的净新增（相对该分支）

1. **树搜索预算器**：分支已有单一 active hypothesis 的版本化修订，但没有 v2 式每阶段多节点并行树。新增 ExperimentNode/CandidateBranch 只应作为 ResearchStore 的上层索引，复用不可变 source/evidence；每节点至少含 parent snapshot、plan hash、attempt receipt、score、failure category、prune reason、token/compute cost。
2. **候选锦标赛与独立反方**：co-scientist 的 debate/tournament 和 AgentRxiv 的多实验室协作都要求同一目标下并行候选、互相可见。新增 challenge/review 角色，输出 opposing evidence、confounders、novelty/feasibility/impact 分项；任何分数都必须标注自动/人评和不确定性。
3. **机器可执行 experiment contract**：FARS 的两级 contract 可包在现有 protocol 之上：环境→baseline→main→effectiveness→analysis，每项有 ordered steps、验收条件、独立 review。协议冻结已经存在，新增是将 protocol 细化为 item/step 并让 worker receipt 逐项对账。
4. **负结果/失败公开化**：v2 负结果、FARS 全量 corpus 和 AgentRxiv 成本/重复分析都支持把被剪枝、失败、invalid measurement 单独持久化并进入后续检索。不能只在 failureDirections 自然语言中短暂存在。
5. **跨 run 研究索引与规模检索**：分支的 `research-context/select.ts` 已有 opposing evidence、unresolved conflicts 和 dependency freshness 选择；净新增应是跨 run/branch 的 claim-protocol-evidence 索引、去重召回、覆盖率和检索效果评测，而不是重做冲突选择。
6. **评估校准面板**：Agent Laboratory 的自动/人评落差、v1/v2 的自动审稿局限和 Kosmos 的 statement accuracy 都说明应同时记录：自动 evaluator、独立 evaluator、人审（若有）、证据有效性，不能用单一总分替代。
7. **公开规模评估**：FARS 的 166/67/282/140 指标启发测试集应包含全量 attempts（成功、失败、未知、被剪枝），报告吞吐、成本、重复率、证据准入率、修订率、独立复现率，而非只报最终论文数。

## 建议实施顺序（只作为工程建议，不是论文已证明效果）

本节按该专题描述整合与扩展事项；跨专题最终顺序以 [统一改造方案](proposal.md#10-落点顺序和实施边界) 为准。假设血缘、minimal/standalone 的证据闭环已在未合并分支实现，下面对应事项是整合核验，不能计为净新增研发。

### P0：合并并接通分支能力

1. 先审查并合并分支的 research-cycle.ts、research/、memory/、research-context/ 与对应测试；main 的 runner 应委托 freezeResearchCycle → worker receipt → assessResearchCycle → commitResearchDecision。
2. 保留 ResearchTree 作为 UI/兼容视图；科学结论以 ResearchStore/CURRENT.json 为准，避免两套状态互相覆盖。
3. 将 idea.ts 的候选结构化输出映射为 versioned hypothesis/claim，候选若无 admissible evidence 只能 proposed/exploratory。

### P1：补全假设血缘和合同

- 扩展 idea 输入：parentHypothesisId、sourceEvidenceIds、failureCategory、alternatives、prediction、falsification；在 idea.ts:122-125 创建 hypothesis 时写合法 parent 和 source refs。
- ResearchTree.add/update 增加 kind-compatible parent、禁止环、禁止已冻结节点被原地改写；修订用新 id/version。
- 把 FARS 五类 item/step 映射到 protocol 的 experiment_items，worker 每项写 receipt，effectiveness gate 失败时仅允许 repair/replicate/revise。

### P2：多候选搜索、独立反方和共享检索

- 在 HypothesisPool 上增加候选分数、预算、状态转移和 prune reason；每个候选都必须保留 source/evidence lineage。
- 并行候选由不同 role/model 生成；在 evidence 不足、候选分数接近或存在未解决冲突时，可选触发 challenge agent 寻找反例、混淆因素和替代解释，winner 仍由规则化 evidence admission 决定。
- 按 protocol/split/fingerprint 查询 memory，命中相似实验时阻止重复或要求解释；跨 run 只复用 validated-in-scope record，并评测索引召回和重复拦截效果。

### P3：核验 minimal/standalone 闭环并扩展规模评估

- 整合时核验分支已有 minimal/standalone 的 run → assess → bounded revision → decision；进一步接入逐项 experiment contract。预算不足明确 pause，不把一次 post-result prose 当新科学证据。
- 新增全量运行指标：candidate count、node success/failure/unknown、admission rate、duplicate rate、cost、wall-clock、human-vs-auto score gap、independent replication。
- 报告必须列出失败、被剪枝候选和未验证主张；只有有协议、原始来源和验证器的 claim 才能输出 supported/refuted。

## 相关候选（本次未纳入正文重点阅读，供后续扩展）

- [Autonomous LLM-driven research from data to human-verifiable research papers](https://arxiv.org/abs/2404.17605)，2024-04，data-to-paper：已核对一手摘要；分步生成假设、分析与论文，并回溯信息流。适合补充报告数值追踪的早期工作；摘要明确复杂任务仍需人工协作，本轮未读完整方法。
- [Robin: A multi-agent system for automating scientific discovery](https://arxiv.org/abs/2505.13400)，2025-05：文献/数据分析 agent 交替提出和更新假设，适合比较“半自主闭环”。
- [AIDE: AI-driven exploration in the space of code](https://arxiv.org/abs/2502.13138)，2025：代码状态树搜索；可作为 v2 实验树的工程先例，但不是完整科学系统。
- [The Virtual Lab of AI agents designs new SARS-CoV-2 nanobodies](https://www.nature.com/articles/s41586-025-09442-9)，Nature 2025（[2024 预印本](https://www.biorxiv.org/content/10.1101/2024.11.11.623004v1)）：已核对出版页与摘要，领域实验验证先例，适合比较纯计算 pipeline 与 wet-lab；本轮未读完整方法。
- [ResearchAgent: Iterative research idea generation over scientific literature with large language models](https://arxiv.org/abs/2404.07738)，2024：文献驱动 idea 迭代和多 reviewer，适合补 novelty/feasibility gate。
- [OpenScholar: Synthesizing scientific literature with retrieval-augmented language models](https://arxiv.org/abs/2411.14199)，2024：文献检索与来源绑定，可补 citation/provenance 评估。
- [MLAgentBench: Evaluating Language Agents on Machine Learning Experimentation](https://arxiv.org/abs/2310.03302)，2023/2024：实验代理基准，适合做 worker/repair 的回归集。
- [The Hitchhiker's Guide to Autonomous Research](https://pubmed.ncbi.nlm.nih.gov/42566370/)，2026-08-07：截至审查日期已公开的综述，可用于后续覆盖 taxonomy、能力增强和 evaluation，但本次不以综述替代系统论文。

## 证据与判断边界

论文中的“接受率、准确率、专家偏好、成本和等价研究时间”都是各自任务/模型/数据/审稿协议下的结果，不能直接证明当前项目会获得相同提升。上文的工程建议是根据论文揭示的结构性问题和当前代码缺口推导出的设计方向；实施前仍需用本项目的真实 provider、预算、数据和独立评估复测。
