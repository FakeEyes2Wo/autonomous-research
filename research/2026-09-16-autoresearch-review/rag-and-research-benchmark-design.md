# RAG 与科研实验基准设计：从任务接口到可复现的 AutoResearch pilot

> 状态：设计草案（2026-09-16）。本文只做一手基准的接口核对和本项目的实验设计，尚未实现 benchmark、尚未运行任何真实 provider/模型评测。现有 mock/fixture 只能证明协议或代码契约，不能当作真实科研结果。样本量均标为 pilot；pilot 用于发现 harness 问题，不足以支撑模型排名或普遍结论。

## 1. 先分清三种测量对象

科研 agent 的“做得好”至少有三个可分离的对象：

1. **找得到并用得对证据（RAG）**：能否定位相关论文片段、表格、数据和反例，引用是否真的支持所写断言。
2. **能提出可检验的下一步（规划）**：假设、指标方向、数据划分、预算、混淆因素和证伪条件是否完整，是否由当前证据推出。
3. **能执行并解释结果（实验）**：代码是否运行，隐藏数据上是否有效，重复/独立验证是否一致，报告是否忠实且可复现。

RE-Bench 和 AIRS-Bench 主要测受限环境下的可执行任务；PaperBench 测论文复现产物；ScienceAgentBench 测科学程序和结果；ScholarQABench/SciRIFF 测检索、阅读和结构化回答；MLGym 把 ML 任务接入统一 agent 环境；MLR-Bench 把研究流程分阶段并用 rubric 评审。这些分数不能直接互换，也不能把“检索了论文”叫作“完成了科研”。

本仓库当前还有一个容易被隐藏的偏差：`src/brainstorm/deep-dive.ts` 按 citations 降序取前三（且要求有 citations 字段），`src/brainstorm/curated-papers.ts` 的分数是 recency/citation/recognition 的加权值。它们是**阅读优先级**，不是适合当前任务、预算和复现条件的实验 baseline。benchmark 必须把两者分开测量。

## 2. 代表性基准的任务契约核对

下表只记录可从官方仓库/论文复核的接口；“隐藏”只指 evaluator 侧的答案、评估细则或独立运行结果，不等于每个项目实现了完全隔离。PaperBench 的论文正文及其已发表关键结果当然是 agent 可读输入，不能写成隐藏答案。

| 基准与代表任务 | agent 输入与可见内容 | evaluator、切分与环境/预算 | 产物与得分 | 可复现性边界 |
|---|---|---|---|---|
| [RE-Bench: Fix Embedding](https://github.com/METR/RE-Bench/tree/main/ai_rd_fix_embedding) | 工作区给出损坏的 `large_model.pth`、较小的正确模型和训练数据；agent 写修复后的模型并调用 `score`。官方说明允许读互联网但禁止下载训练数据/权重。 | `score` 在验证集计算 `log(loss_validation - 1.5)`，最终取较低值；最终文件是 `fixed_model.pth`。任务约束、黑名单/canary 和运行脚手架由 METR Task Standard/Vivaria 控制；典型时限约 8 小时。 | 二进制模型和分数，属于可自动复算的 outcome。 | “修好了”不证明修复机制正确；只看单一验证指标会遗漏退化。隐藏集、网络规则、镜像和随机状态必须随任务快照记录，不能把网络可读误称为完全封闭。 |
| [RE-Bench: Triton cumsum](https://github.com/METR/RE-Bench/tree/main/ai_rd_triton_cumsum) | 任务给出 prefix-sum 定义、Triton 2.3.1/输入约束（长度 100,000,000 的 int32 数组）和 `solution.py` 接口，agent 在 `/home/agent/solution` 改实现并调用 `score`。 | 隐含随机输入上先判功能，再以毫秒计时并记录 `log(milliseconds)`；官方任务标为可增量评分。 | 可执行 Python/Triton 代码；正确性是硬门槛，速度是连续分。 | 适合作为“代码执行 + 隐藏测试”的小基准；它测 kernel 优化，不测假设证据、统计推断或论文写作。首版项目可用 CPU/NumPy 同构任务，避免 GPU 噪声；随后再加 GPU profile。 |
| [PaperBench（OpenAI Preparedness 原版）](https://github.com/openai/frontier-evals/tree/main/project/paperbench) 单篇复现任务 | agent 看论文 PDF/Markdown、addendum、assets 和黑名单（例如原始代码），在 `/home/agent/submission/` 交一个 git repo 和 `reproduce.sh`；论文正文中的已发表结果是可见上下文，不是隐藏答案。 | 原版明确分为 agent rollout、fresh reproduction container 和独立 grading container；GPU、网络、模型/API token 和 time limit 由具体 runner/config 决定，论文没有一个统一的 L4/12 小时协议。当前 README 的 quickstart 默认 5 分钟，canonical 示例为 24 小时，都是 runner 示例；rubric 用于服务端 grading，独立运行产物才交给 judge。 | 可复现 repo、脚本、执行日志和报告；按 rubric 的 code development/execution/result analysis 聚合。 | LLM judge 适合覆盖程度/说明质量，不能替代数据指标和独立运行。需固定 rubric/judge 版本、重复运行及人工校准；论文中的主张也可能本身不可复现。 |
| [ScienceAgentBench](https://github.com/OSU-NLP-Group/ScienceAgentBench) 单个科学程序任务 | 任务来自同行评审论文，目标是交付自包含 Python 程序并运行出结果；agent 可按“直接生成 + 自调试”模式执行。公开的是 annotation sheet；完整 benchmark/隐藏材料单独下载，官方明确为降低污染风险。 | 官方 harness 用容器执行，保存 JSONL trajectory、代码、运行日志和成本；评估程序是否生成、是否执行、结果是否符合任务、token/时间等。2026 verified release 修复了部分 false negative，使用它而非旧 zip。 | 程序、stdout/文件结果、轨迹和成本，多层指标。 | 这是比纯论文问答更接近科研的 outcome，但单任务仍不等于长期研究；需核对任务卡和 verifier 版本，区分执行失败、科学答案错误、超预算。完整数据未拿到时不能声称复现了该 benchmark。 |
| [MLGym](https://github.com/facebookresearch/MLGym) 的 `imageClassificationCifar10.yaml`/`regressionKaggleHousePrice.yaml` | task config 公开 `description`、entrypoint、dataset split、starter/baseline/sample submission 和 evaluation paths；agent 在容器中写训练/提交代码，轨迹会保存。 | `TaskConfig` 支持 train/valid/test、requirements、training timeout、evaluation read-only、baseline scores；run 默认有有限 steps/seed/cost limit，具体值由 CLI/config 覆盖。评估类 `evaluate()` 返回 metrics dict 和 submission path。 | 模型/提交文件、metrics、轨迹；任务代码通常可见，隐藏文件能力在配置中存在但 `secret_files` 当前并非都启用。 | 统一环境便于回归测试，却不能自动保证 evaluator 隐藏；必须把 test labels、评估脚本和 baseline 泄漏审计作为项目自己的验收项。MLGym 的 ML 成绩也不证明研究主张。 |
| [AIRS-Bench](https://github.com/facebookresearch/airs-bench) 的 `TextualClassificationSickAccuracy` | 每任务有 `metadata.yaml`、`project_description.md`、`prepare.py`、`evaluate.py`；prepare 给训练特征/标签和测试特征，不给测试标签或答案。 | `evaluate_prepare.py` 持有测试标签，`evaluate.py` 在提交后计算任务 metric；任务依赖 Hugging Face 数据和 metadata 的 train/test split。 | 提交文件/模型和任务 metric；任务侧 outcome evaluator。 | 它很好地固定了“agent 看见什么、评估看见什么”，但不记录假设证据链；要在本项目增加 protocol/evidence 输出，并把 submission 分数与科学解释分开。 |
| [MLR-Bench](https://github.com/chchenhui/mlrbench) 一个 workshop research task | `tasks/` 与 `task_metadata.md` 描述问题；流程拆成 idea generation、literature review、proposal、实验、paper writer，输出 Markdown/代码/日志。 | 官方脚本按阶段运行，评估脚本分别 review idea/proposal/experiments/writeup 和 overall；主要是 rubric/LLM judge，实验阶段还看运行记录。任务与模型配置由命令行指定。 | 想法、提案、实验分析和写作产物，多维语言评审。 | 适合测研究流程的中间产物和错误类型，不适合作为唯一的科学真值。报告应记录 judge prompt/model/version 和人评校准，不能把某一配置在少量任务上的高通过率写成所有 research agent 的发生率。 |

### 2.1 RAG 层：SciRIFF 与 ScholarQABench

- [SciRIFF](https://github.com/allenai/SciRIFF/blob/main/doc/evaluation_tasks.md) 的任务直接规定论文 abstract/passage/table 和结构化输出。例如 biomedical entity extraction 要输出 Chemical/Variant/Gene/CellLine/Disease/Species 等实体 JSON，表格任务逐 cell 输出 JSON，QA 任务给定论文段落和问题回答。它适合测 schema 合法性、字段级 exact match/F1、表格数值准确性；BLEU 可以作为参考，但不能单独代表科学数字是否正确。
- [ScholarQABench](https://github.com/AkariAsai/ScholarQABench) 把 SciFact/PubMedQA 的真假问答、QASA 的单篇全文长回答以及带 rubric 的 CS/Bio/Neuro/Multi 问答分开。官方脚本分别评 citation correctness（字符串/引用核对）、rubric relevance/organization/coverage 和答案评审；gold context 主要用于 oracle，不能让系统在正式检索时直接看到。
- [AutoResearchBench](https://cheryou.github.io/autoresearchbench.github.io/)（[论文](https://arxiv.org/abs/2604.25256)）把近期的 Deep Research（围绕一个目标论文/问题搜集证据）与 Wide Research（针对论文集合/主题检索）作为检索研究问题来评测。它可以给 Stage 1 提供 query、语料快照和引用层的 task card；其检索/回答分数不能推出假设已被验证、实验已执行或结论可复现，因此本项目必须另设 Stage 2–4。

本项目应采用三层 RAG 分数：**检索**（gold span/citation recall@k、去重后 rank）、**支持**（引用 span 的 hash 只证明定位与完整性；claim entailment 要靠人工金标、确定性数字/单位规则，或经过校准的语义审查，再计算 precision/recall/F1）、**综合**（覆盖、相关性、组织性，LLM judge 仅作辅指标）。每层同时记录 token、wall time、检索调用次数和成本。这样可以定位“找不到”“找到了但误读”“答案流畅但没有证据”三类故障。

## 3. 本项目的分阶段最小 benchmark 蓝图

先建立低成本、可冻结的 pilot，再扩大到长时限和真实 provider。每一阶段都输出机器可读 manifest、artifact hash、protocol version、seed、容器 digest、预算和 evaluator version。

### Stage 0：harness 与完整性门

准备 3 个本地 toy task、1 个故意失败的 artifact、1 个伪造 metric 和 1 个含反例的 evidence fixture。检查：输入快照 hash 一致；agent 不可读 hidden test/答案/rubric；`reproduce` 在干净容器可运行；超时、缺文件、异常退出分别归类；所有分数能由提交物重新计算。此阶段不调用模型，不能产生“科研能力”分数。

### Stage 1：证据检索和引用核验（本专题 6–10 个 frozen tasks，pilot）

从可公开再分发的论文/摘要/表格建立版本化小语料，另外保留同主题但未被 query 指明的反例。每个 task card 固定 query、允许的语料快照、gold claims、人工标注的支持/反驳标签与 spans、数字和单位。agent 先只看 metadata，再在允许的预算内请求 passage/table；输出：`claims[]`、`citations[]`、evidence span、支持方向、置信度和 unresolved 标记。

两种是不同信息权限的 **access track**：`metadata_only`（只测在受限观察下的选择）与 `full_text_on_demand`（同时测工具调用和阅读），不是把同一检索算法放在等量资料上做公平横比。每个 track 先跑关键词/BM25 和引用关键词 baseline，再将 dense retrieval/rerank 作为可选增量；oracle 只用于上界，不能当 agent。主指标为 claim-level support F1、反例召回、citation precision、数字/单位 exact accuracy；报告每 task×seed 的成本与失败类别。最终统一方案从 20 篇论文、40 个问题和 3–5 个执行任务起步；这里的 6–10 个仅是本专题发现 harness 问题的 pilot 建议。

### Stage 2：假设与协议门（3–5 个 task cards，专题 pilot）

输入 Stage 1 的冻结 evidence manifest 和一个待检验 claim。要求输出带版本的 hypothesis、action、metric、方向、最小效应阈值、数据 split/fingerprint、预算、混淆因素、预期反驳和下一步条件。hidden validator 只检查 schema、引用 hash、协议是否在执行前冻结；科学结论仍由独立结果决定。

例：给出两个公开训练策略的初步结果和一条反例，要求 agent 预注册“在固定 seed 集上验证验证集 loss 差异”，同时说明何时改写 successor。未知 validator 允许任务探索性结束；只有 protocol 匹配、artifact 可读、独立数据通过的 formal claim 才可升级为 supported/refuted。不要把“零效应”或“置信区间跨零”写成通用失败规则：应按冻结的效应阈值、方向性检验或等效检验事先判定；零假设与科学主张必须分开。

### Stage 3：短循环执行（3 类候选，首轮选 3–5 个执行任务，专题 pilot）

1. **功能正确性**：RE-Bench cumsum 的 CPU 同构版本，输入/函数签名公开，随机测试和参考实现隐藏；先判全量正确，再测固定规模运行时间。
2. **数据任务**：AIRS/MLGym 风格的小型分类或回归，train/valid 可见、test label 隐藏；限制 wall time、步骤、内存和网络；输出 submission、metric JSON、运行环境和简短分析。
3. **优化任务**：给定可复现 baseline 和明确约束，要求改善一个 metric；隐藏独立测试和重复 seed，分数同时记录 best-so-far 曲线、独立复现是否成功及成本。

执行 evaluator 与 agent 隔离，报告“代码失败/运行超时/测试退化/协议违规/分析与数据不一致”。有效结果包括按冻结规则判定的阴性/无改善结果，也应进入 successor 或 revision 的下一假设输入；invalid/error 只作诊断，不能为 claim 提供支持。分析文字不能修正 metric。

循环调参与 successor 选择只消费 train/dev/validation 反馈；hidden test 在最终提交后才评分，分数不能再回流到同一 test 上选择下一假设。若研究设计确实需要在线反馈，必须预先冻结反馈规则和查询预算，并另留一个不反馈的最终 holdout；仅隐藏 labels、却反复返回 test 分数，仍会造成 test 过拟合。

### Stage 4：轻量 PaperBench 式复现（2–3 篇，pilot）

选择能公开数据且运行时间短的论文，给 PDF/Markdown、addendum、数据下载白名单和原代码黑名单；论文已发表的关键结果随正文可见。评估细则、独立运行答案/测试输出和 judge 输入留在 evaluator 侧。要求 repo、`reproduce.sh`、环境锁定文件、结果表、引用/evidence manifest。自动检查 import/运行/文件完整性和数值指标，LLM judge 只评方法对应关系、局限说明和结果分析，并以人评小样校准。当前只提出接口，未下载、运行或声称复现任何论文。

EnvCommons/PaperBench 是后续的独立环境封装；其 [README](https://github.com/EnvCommons/PaperBench/blob/main/README.md) 另行规定 dev/main 任务清单、L4 sandbox、六个工具和默认 reproduction timeout。那些是该封装的运行配置，不能反写成 OpenAI 原论文的统一协议。本项目采用原作者 [OpenAI Preparedness/Frontier Evals 实现](https://github.com/openai/frontier-evals/tree/main/project/paperbench) 作主来源，若借鉴 EnvCommons 的 task card，则在 manifest 中单列 wrapper、commit 和配置版本；正式运行前还应把 upstream 和 wrapper 的解析后 SHA 写入 manifest，而不是依赖 `main`。

### Stage 5：长周期树搜索（通过前四阶段后）

再引入 4–8 小时预算、暂停恢复和 2–3 个 successive hypotheses。每一轮必须绑定上轮 snapshot，保存候选未选原因、反例和 scoped memory；停止原因分为 supported/refuted/inconclusive/exploratory/blocked。长时限应先用本地 deterministic provider 验证状态机，再接真实 provider；现有 TODO-addendum 的 real-provider 验证尚未完成，mock 不能标成完成。

### 3.1 接到当前代码的边界

主分支现状应作为 B2 的准确基线保存：

- [hypothesis-pool.ts](../../packages/autoresearch/src/core/hypothesis-pool.ts:43) 以可变 entry 保存 evidence IDs，[syncFromTree](../../packages/autoresearch/src/core/hypothesis-pool.ts:59)–[84](../../packages/autoresearch/src/core/hypothesis-pool.ts:84) 从单一 `ResearchTree` 派生状态；它可用于记录候选，但不是 benchmark 的隐藏真值。
- [idea-gate.ts](../../packages/autoresearch/src/domain/idea-gate.ts:55)–[70](../../packages/autoresearch/src/domain/idea-gate.ts:70) 检查前提证据可追溯和可证伪字段，[verifier score](../../packages/autoresearch/src/domain/idea-gate.ts:161) 已把无匹配 verifier 表述为 `EXPLORATORY`；Stage 2 应把该状态计入结果分类，不能把结构通过当作科学支持。
- [validation.ts](../../packages/autoresearch/src/experiment/validation.ts:12)–[15](../../packages/autoresearch/src/experiment/validation.ts:15) 明确当前 worker validation 只证明 shape/containment；因此 Stage 3 的 hidden metric、artifact 内容和协议匹配必须在独立 evaluator 验证。
- [evidence-chain.ts](../../packages/autoresearch/src/export/evidence-chain.ts:7)–[35](../../packages/autoresearch/src/export/evidence-chain.ts:35) 导出 v1 的 run/tree/evidence 数组；benchmark manifest 还需补数据 fingerprint、protocol/evaluator version、artifact hash 和 public/hidden 清单。

`.worktrees/evidence-driven-research` 的 `feat/evidence-driven-research`（HEAD `5034eb1`）已有协议冻结、evidence admission、versioned successor 和 scoped memory；可作为 B3 的整合基线。其 [evidence-validator.ts](../../.worktrees/evidence-driven-research/packages/autoresearch/src/experiment/evidence-validator.ts:9)–[57](../../.worktrees/evidence-driven-research/packages/autoresearch/src/experiment/evidence-validator.ts:57) 目前含 `paired_sign_test_v1` 与 unknown/exploratory 路径，[assessment.ts](../../.worktrees/evidence-driven-research/packages/autoresearch/src/research/assessment.ts:12)–[53](../../.worktrees/evidence-driven-research/packages/autoresearch/src/research/assessment.ts:53) 检查 protocol/split/fingerprint、冲突和 discovery data reuse。它仍不是上述外部 benchmark 的 task adapter，也没有完成 real-provider 运行；B3 的意义是复用已做的科学状态机并测其边界，不能把分支已有实现再次宣称为净新增。

## 4. 具体 task card 示例

### `rag_citation_verification_v1`

输入是 query、论文 corpus manifest 和允许的检索工具；agent 看不到 gold span/答案。输出 claim、引用、原文 span、方向和数字单位。evaluator 用 hash 校验所引 span 的身份和完整性；claim-level support 由人工 gold entailment 标签、确定性数字/单位规则或经过校准的语义审查判定，再分别计算反例召回和数字准确率。一个“引用存在但 span 不支持主张”的样例应明确判错。

### `hypothesis_protocol_v1`

输入是一个 claim、Stage 1 evidence snapshot 和 baseline 表；输出 protocol v1、预期方向、最小效应、独立 split、停止/证伪条件。evaluator 做结构和版本检查，随后将 protocol 交给 Stage 3；validator 不得读取未来结果。它测的是可执行性与证据链接，不直接给科学主张盖章。

### `ml_loop_regression_v1`

公开 train/valid、starter 和预算，隐藏 test labels、独立 seed 和 evaluator。提交物必须含代码、预测、metrics JSON、artifact hash 和 reproduce script。主分数是 hidden test 上预注册 metric，附带 valid-to-test gap、重复一致性、成本和协议违规。

### `kernel_functional_correctness_v1`

公开接口和少量样例，隐藏随机/边界输入；CPU 版本先判 bitwise/tolerance 正确，再在固定机器上测 runtime。任何 correctness 失败都不允许用更快的时间抵消。该卡验证实验执行闭环，不测论文创新性。

### `paper_mini_reproduction_v1`

公开论文与 addendum，禁止原 repo 和答案泄漏；输出 git repo、脚本、依赖锁、结果表和 evidence manifest。evaluator 独立运行并核对关键结果/方向；LLM rubric 仅覆盖方法映射、失败解释和可读性。任务卡须保存允许下载的 URL、版本和许可证。

## 5. Baseline、消融与统计协议

### Baseline 与消融

| 编号 | 配置 | 用途 |
|---|---|---|
| B0 | 固定规则/随机候选 + 参考执行器 | harness 下界、泄漏探测 |
| B1 | 单次 LLM：一次检索、一次计划、一次执行 | 测闭环带来的增益 |
| B2 | 当前 ResearchTree 的 ReAct/循环配置 | 项目现状基线；阅读排序仍单独记录 |
| B3 | B2 + `feat/evidence-driven-research` 已实现的协议冻结、evidence admission、versioned successor、scoped memory | **已有分支整合基线**，不应再次算作净新增；还需 benchmark adapter 和真实 provider 验证 |
| B4 | B3 + 任务/数据/预算感知的 selector（多样性、信息增益、预计成本） | 测选择器是否超过 citations/recency 排序 |
| B5 | oracle gold retrieval 或 oracle validator | 上界/诊断，不能作为 agent 排名 |

关键消融：去掉检索、两个 access track、去掉 evidence admission、去掉 successor、FIFO 对任务感知 selector、LLM judge 对 deterministic evaluator。`同 split` 对 `independent split`、`global memory` 对 `scoped memory` 只用于隔离泄漏/记忆边界的诊断；它们不能进入合法 benchmark 分数或 leaderboard。每次只改一个因素，固定 task/seed/预算。

### 统计单位和报告

- 主统计单位是 **task/work family**（按所选 benchmark 的任务卡或同一工作族聚合）；`task × seed × attempt` 只是观察记录的索引。seed 和 attempt 嵌套在 task/work family 内，不能当作相互独立样本；同一轨迹的 tool call、metric update 或候选数也不是统计单位。
- 主要比较按相同 task/work family 和预算做 paired delta，先按预注册规则聚合其 seeds/attempts，再汇总 task/work-family-level median/mean 与 bootstrap CI。pilot 的 6–12 个任务只用于估计方差和发现失败，不作充分性声明；最终统一起步规模为 20 篇论文、40 个问题、3–5 个执行任务。
- 若预注册 paired sign test，只能以独立 task/work-family pair 为单位，并把 validator 版本、方向和效应阈值冻结；重复 seed/attempt 不可伪装成新增 pair。多项指标/消融要预先指定 primary metric，并对探索性比较作多重比较控制。
- 报告 best-so-far 随时间/成本曲线面积、最终独立复现率、证据 support F1、协议通过率、超时率和 token/墙钟/金钱成本；missing、unknown、exploratory 和 failed 分列，不能以失败样本的叙述填补分数。

## 6. 防泄漏、环境和 LLM judge 规则

1. **切分**：训练/验证/隐藏测试分离；科研文本用时间/主题/作者去重 holdout，检查模型预训练污染和 benchmark 公开答案。RE-Bench 的 canary/blacklist、ScienceAgentBench 仅公开 annotation、AIRS 的 `evaluate_prepare.py` 分离测试标签都是可借鉴的控制。
2. **执行隔离**：固定 Docker/Podman image digest、依赖 lock、CPU profile，另列 GPU profile；记录 seed、硬件、wall-clock、token、重试和成本。评估器在 agent 进程外运行，测试标签、rubric、gold spans 和原代码不挂载。
3. **产物完整性**：manifest、输入/代码/输出 hash、protocol version、数据 fingerprint、日志和 reproduce script 成套保存；下载 URL、提交时间和许可证写入 provenance。网络若开启需记录域名和下载 hash，正式 hidden test 默认关闭。
4. **裁判边界**：代码可运行性、预测、统计量、引用 span 和数字优先用 deterministic evaluator。LLM judge 只能评开放式的解释覆盖、局限和表达；保存 judge prompt/model/version、温度、独立重复和人评 calibration/agreement。judge 的“看起来合理”永远不能单独升级 formal scientific support。

## 7. 未来实现验收门

在写 adapter 之前，先交付每张 task card 的 schema、snapshot manifest 和 hidden/public 文件清单；再用 Stage 0 的伪造 artifact 验证 evaluator 不会被叙述或错误 metric 绕过。实现后必须有可重放的 baseline run、独立 test、artifact hash 对比、超时/unknown 恢复测试和成本账本。只有真实 provider 在用户配置的环境中完成同一冻结任务并保存 raw receipt 后，才能报告 provider 结果；本文件目前没有这样的运行记录。

### 主要一手来源

- [RE-Bench paper](https://arxiv.org/abs/2411.15114) 与 [官方任务仓库](https://github.com/METR/RE-Bench)。
- [PaperBench paper](https://arxiv.org/abs/2504.01848) 与原作者 [OpenAI Preparedness/Frontier Evals 实现](https://github.com/openai/frontier-evals/tree/main/project/paperbench)；另参见独立的 [EnvCommons/PaperBench 封装](https://github.com/EnvCommons/PaperBench)。
- [ScienceAgentBench paper](https://arxiv.org/abs/2410.05080) 与 [官方 harness/release](https://github.com/OSU-NLP-Group/ScienceAgentBench)。
- [MLGym 官方代码与 task configs](https://github.com/facebookresearch/MLGym/tree/main/configs/tasks)。
- [AIRS-Bench paper](https://arxiv.org/abs/2602.06855) 与 [官方 tasks](https://github.com/facebookresearch/airs-bench/tree/main/airsbench/tasks)。
- [MLR-Bench paper](https://arxiv.org/abs/2505.19955) 与 [官方脚本/任务](https://github.com/chchenhui/mlrbench)。
- [SciRIFF paper](https://arxiv.org/abs/2406.07835) 与 [evaluation tasks](https://github.com/allenai/SciRIFF/blob/main/doc/evaluation_tasks.md)。
- [ScholarQABench paper](https://arxiv.org/abs/2411.14199) 与 [官方评估脚本](https://github.com/AkariAsai/ScholarQABench)。
- [AutoResearchBench](https://arxiv.org/abs/2604.25256)（检索/研究问题基准的近期补充；其 retrieval-only 任务不能等同完整科研闭环）。
