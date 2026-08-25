# AutoResearch ML-first 精简控制平面设计

日期：2026-08-20
状态：approved design

## 1. 目标与优先级

AutoResearch 继续作为独立 TypeScript DSH 插件运行。它复用 DSH 的 Agent、
Subagent、Goal、Workflow、Tools、Skills、持久化、沙箱、审批和模型路由能力，
只新增研究控制语义，不再实现一套新的 Agent Runtime 或工作流基础设施。

实施优先级固定为：

1. 端到端控制平面；
2. 研究质量闭环；
3. 自主迭代；
4. 通用化。

首个可用版本聚焦机器学习领域，从真实 candidate 走到可追溯论文包。当前
Python Athena 暂时作为实验引擎；AutoResearch Core 不绑定其内部类型，便于
未来替换。

## 2. 与现有文档的关系

本设计是在现有 `docs/autoresearch` 设计上的收敛，不重新设计已经存在的领域
流程。

直接沿用：

- `2026-08-16-candidate-to-paper-design.md` 与
  `candidate-to-paper-handoff/`：ML 默认端到端执行流程；
- `2026-08-16-records-to-paper-design.md` 与
  `records-paper-handoff/`：已有实验记录直接进入论文的第二入口；
- `2026-08-16-idea-generation-design.md`：brainstorm、候选生成和 idea 门禁；
- `2026-08-15-hypothesis-local-pool-design.md`：假设生命周期语义；
- `2026-08-15-autoresearch-figures-and-experiment-design.md`：可信实验、消融和
  论文图规则；
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`：论文模板、编译、
  Reviewer 和 Packaging 规则；
- `evidence_chain.json` 与 `verify-trace`：实验到论文的确定性追溯契约。

本设计收缩旧版 `RunSpec + PipelineRunner + StageContext + ProviderRegistry +
GateRunner + EventBus` 方案。首版不实现这些通用框架；现有 handoff 承载领域
知识，TypeScript 代码只负责统一启动、状态恢复、自主决策和 DSH 接线。

## 3. 架构边界

```text
DSH
├─ Agent / Subagent / Goal / Workflow
├─ Tools / Skills / Model Routing
├─ Sandbox / Approval / Persistence
└─ Cordis Service / Event / Realm
   │
   └─ @athena/autoresearch
      ├─ AutoResearchService
      ├─ 精简状态与运行记录
      ├─ 研究策略硬检查
      ├─ ML Domain Profile
      └─ AthenaExperimentProvider
```

职责边界：

- DSH 负责怎样运行 Agent、工具、插件和长流程；
- AutoResearch 负责研究处于什么状态、下一步做什么以及为什么；
- Provider 负责完成领域工作，不得直接推进 AutoResearch 顶层状态；
- `AutoResearchService` 是顶层状态的唯一写者；
- Agent 建议必须经过预算、冻结规则和人工升级检查后才能生效；
- 不自建 RPC、事件总线、任务队列、数据库或 DAG 引擎。

## 4. DSH 上的最小实现形态

首版只注册一个主要 Cordis Service：

```text
AutoResearchService
├─ run / resume / status / stop
├─ handoff 步骤推进
├─ 自主研究循环
├─ rubric 冻结与关键 gate
└─ state.json / events.jsonl
```

Rubric、策略判断和记录写入先作为普通函数或内部模块，不注册为独立 Service。
Provider 也优先作为普通 Cordis Service 注入，不建设独立 Worker 平台。

建议的首版文件：

```text
packages/autoresearch/
├─ src/
│  ├─ index.ts
│  ├─ service.ts
│  ├─ state.ts
│  ├─ rubric.ts
│  ├─ profiles/ml.ts
│  └─ providers/athena.ts
└─ prompts/
   ├─ supervisor.md
   ├─ rubric-generator.md
   └─ rubric-reviewer.md
```

Python Athena 通过薄适配器接入：

```text
AutoResearchService
  → AthenaExperimentProvider
    → Athena DSH tool/service
      → 当前 Python Athena
```

Python 的启动、恢复和输出转换由 Athena 插件负责。AutoResearch 只消费“执行
实验并返回 evidence 引用”的结果，不读取 `ResearchState`、`ResearchTree` 或
Python 进程状态格式。

## 5. ML Domain Profile

首版只实现一个真实组合 `ml.default`：

```text
ml.default
├─ discovery         现有文献检索与 gap mining
├─ ideation          DSH subagent + 现有 idea-generation handoff
├─ rubric            ML rubric Generator + 独立 Reviewer
├─ experiment        Python AthenaExperimentProvider
├─ evidence          evidence_chain.json + verify-trace
└─ publication       candidate/records-to-paper handoff
```

代码层不为每项能力预先建立大型 interface。Profile 只负责选择现有实现；出现
第二个真实领域后，再从实际差异中提炼最小 Provider 契约。

所有实现仍遵守三个边界：输入使用简单数据和 ArtifactRef，输出使用结构化结果
和 ArtifactRef，不直接修改 AutoResearch 顶层状态。

## 6. 状态与恢复

每个运行只保留两个控制文件：

```text
.athena/autoresearch/<run_id>/
├─ state.json
└─ events.jsonl
```

`state.json` 只保存恢复所需内容：当前 phase/step、运行状态、rubric 和计划引用、
当前 step id、产物引用、预算使用量以及最近错误。

`events.jsonl` 仅用于排错和解释，不承担完整事件溯源。记录分为四类：

- `state`：阶段或状态变化；
- `result`：Provider、rubric 或质量门结果；
- `decision`：继续、转向、停止或人工决定；
- `error`：失败与降级原因。

每条记录只需要时间、类型、step id 和数据。

恢复规则：

1. 步骤开始前保存当前 step id；
2. 步骤完成后保存产物引用并推进；
3. 重启后读取 `state.json`；
4. 未完成步骤使用相同 step id 重试；
5. Athena 内部恢复继续委托 Athena；
6. Provider 的失败不能被当作 gate 通过。

不实现哈希链、因果 ID、复杂 reducer、独立 Budget Ledger 或大量事件 DTO。

## 7. 运行状态与研究循环

顶层流程：

```text
INTAKE
  → RESEARCH
      discovery → ideation → experiment → evidence → decision
      decision → 继续 / 转向 / 请求用户 / 结束研究
  → PUBLICATION
  → COMPLETED
```

运行状态只使用 `RUNNING`、`WAITING`、`PAUSED`、`FAILED` 和 `COMPLETED`。

Supervisor 每轮读取任务、冻结 rubric、当前计划、最新证据和剩余预算，输出下一
步动作与简短理由。判断因素包括预期信息增益、成功概率、执行成本、对核心主张
的影响、rubric 满足情况和剩余预算。这些是 Supervisor 的决策依据，不建设单独
的数值优化服务。

Core 只做四项硬检查：

1. 不得突破预算；
2. 不得修改已冻结 rubric 和已完成实验记录；
3. 计划修订只能影响未来步骤；
4. 高影响或低置信度决定必须请求用户。

计划使用简单版本文件：

```text
PLAN-v1.md
PLAN-v2.md
PLAN-v3.md
```

新版说明修改原因和生效步骤，旧版保持不变。

需要人工确认的情况：修改核心研究问题、引入新外部数据或高成本资源、申请扩大
预算、Rubric Reviewer 置信度不足，以及 Supervisor 无法可靠决定继续或停止。
普通假设排序、实验选择和低成本路线调整自动执行。

## 8. 动态 Rubric 与质量闭环

每次 candidate-to-paper 运行在首个实验前生成 `RUBRIC.md`：

```text
任务与领域信息
  → Rubric Generator
  → 独立 Rubric Reviewer
  → 通过后冻结
```

Reviewer 检查 rubric 是否可由实际证据判断、是否覆盖该 ML 任务的主要风险、
是否在实验结果出现前定义，以及是否违反核心约束。最多自动修订两轮；仍不通过
则进入 `WAITING` 请求用户。

Rubric 根据 ML 任务变化：分类任务关注数据泄漏、数据划分、基线、随机种子和
稳定性；LLM 评测关注数据污染、Judge 偏差、模型版本和 prompt 冻结；系统实验
关注吞吐、延迟、硬件环境、预热和重复测量。

Core 固定四条跨任务约束：

1. 主要指标和评估方式必须在实验前确定；
2. 论文主张必须链接到实验或产物；
3. 失败、DRAW 和负结果不得删除；
4. 未达到 rubric 的结果不能包装成已证实结论。

质量检查只放在三个关键位置：实验前确认 rubric 已冻结，实验后确认形成可追溯
evidence，写作前确认每个核心 claim 有足够 evidence。

`records-to-paper` 的实验已经发生，其动态 rubric 只能用于证据判级和写作门禁，
必须标明为事后评估，不能伪装成预注册标准。

## 9. ML v1 端到端数据流

```text
candidate.md
  → candidate.json + candidate_id
  → Task Profile + frozen RUBRIC.md
  → BRAINSTORM.md + IDEAS/*.md + hypotheses
  → preregistered EXPERIMENT_PLAN.md
  → Python Athena PREPARE / SEARCH / VALIDATE
  → cycle evidence_chain.json
  → autonomous decision
      ├─ 继续实验
      ├─ 返回 ideation 转向
      ├─ 请求用户
      └─ 结束研究
  → final-evidence-chain.json
  → claims + outline
  → writing + figures
  → review + verify-trace
  → packaging
```

既有强追溯链保持不变：

```text
candidate_id → hypothesis_id → experiment_id → paper evidence tag
```

每轮产物独立保存，旧轮次不覆盖：

```text
research/
├─ RUBRIC.md
├─ PLAN-v1.md
├─ PLAN-v2.md
├─ cycle-01/
├─ cycle-02/
└─ final-evidence-chain.json
```

最终 evidence 汇总所有轮次，包括失败和阴性结果，再交给现有
records-to-paper handoff。汇总产物保存在 `research/final-evidence-chain.json`，并复制
为 `records-paper/<run_id>/evidence_chain.json` 以保持现有下游契约不变。

## 10. HypothesisPool 的首版范围

保留现有 HypothesisPool 设计中的生命周期语义和与 candidate/hypothesis/
experiment/paper 的追溯关系，但代码只实现 ML v1 实际使用的字段和迁移。

首版需要：候选等待实验、实验中、已支持、已否定、证据不足、进入论文、作为
负结果以及归档。复杂查询、完整通用 Provider API 和第二领域字段在真实需求出现
后增加。

Athena 的 ResearchTree 继续是实验事实源，HypothesisPool 继续是跨阶段生命周期
和论文元数据索引。两者冲突时以 Athena 实验结论为准。

## 11. 失败、降级与恢复

首版只使用四种处理结果：

- `RETRY`：临时 LLM、工具或 Provider 失败；
- `WAITING`：需要用户、凭据、预算或外部资源；
- `DEGRADED`：存在明确的低能力替代路径；
- `FAILED`：无法继续且没有可信降级路径。

LLM 或普通 Provider 调用失败自动重试一次。确定性脚本失败时保留 stderr 和现场，
不让 LLM 猜测成功。所有降级写入运行记录和最终报告，任何检查执行失败都不能
默认放行。

沿用现有降级链：

```text
文献检索：首选来源 → web/local corpus → WAITING
论文编译：Overleaf → local TeX → Markdown
论文绘图：draw.io MCP → HTML/SVG → native SVG
实验入口：Athena → external evidence → none
```

`external evidence` 只能进入 records-to-paper；`none` 只能产出 proposal 或失败
报告，不能生成包含伪实验结果的论文。

沿用现有有界循环：idea 门禁最多重提两次，论文内容审稿默认最多五轮；自主研究
循环受实验、token 和项目时间预算约束；LaTeX 编译修复不设轮数，只受项目总
时间限制。

预算耗尽时，证据足够则进入论文阶段；证据不足则进入 `WAITING` 或生成
`FAILURE_REPORT.md`，负结果仍进入最终 evidence 和 limitations。

## 12. 测试与验收

单元测试只覆盖会导致错误研究结论的确定性逻辑：状态恢复、rubric 冻结、预算与
人工升级、跨轮 evidence 合并、负结果保留、claim/evidence 标签校验，以及
Provider 失败不能通过 gate。

集成测试使用 fake DSH subagent 和 fake Athena，走通完整 candidate-to-paper。
至少覆盖第一轮证据不足产生 `PLAN-v2` 并继续实验、第二轮达到 rubric 后结束研究，
以及关键步骤中断后的恢复。

真实 ML 验收要求：

1. 从 `candidate.md` 启动，无需人工逐阶段操作；
2. 生成并冻结任务专用 `RUBRIC.md`；
3. Python Athena 至少完成一个真实实验；
4. `final-evidence-chain.json` 同时保留成功、失败和阴性结果；
5. 每个论文核心数字通过 `verify-trace`；
6. 核心证据不足时生成失败报告，不强行包装论文；
7. 成功时始终产出 Markdown draft，环境允许时产出 LaTeX/PDF；
8. 中断后可以恢复；
9. 最终报告列出预算、计划修订、降级、人工介入和未满足项。

防作弊验收主动修改论文数字、删除负结果或回改 rubric，最终检查必须拒绝通过。

## 13. 实施里程碑

### M1：DSH 控制平面

建立精简 `AutoResearchService`，接入现有两个 handoff 入口，保存步骤与恢复位置，
包装当前 Python Athena，并跑通单轮 ML 端到端流程。

### M2：研究质量闭环

增加动态 rubric、独立审查和冻结，接入实验预注册、evidence 汇总、verify-trace、
阴性结果保留和失败报告。

### M3：自主迭代

加入 evidence 后的 Supervisor 决策、未来计划修订和预算内多轮
`ideation → experiment → evidence`，完成真实 ML 端到端验收。

### M4：通用化

从 ML 实际代码中抽取最小 Domain Profile 接口。只有第二个真实领域接入时，才
校正接口和增加通用能力。

ML v1 的完成定义是 M1–M3 全部通过；M4 不阻塞首个可用版本。

## 14. 明确延期事项

- `TODO[AR-EXP-PROVIDER-002]`：第二个实验引擎通过相同能力验收后，移除
  AutoResearch Core 对 Python Athena 启动方式、目录和状态格式的默认假设；
  Athena 继续作为可选 ML Provider。
- `TODO[AR-DOMAIN-002]`：ML v1 稳定后选择第二个真实领域，以实际接入验证
  Domain Profile；在此之前不增加空壳领域实现。

这些 TODO 是具有触发条件和退出标准的延期需求，不是待补设计占位符。

## 15. 首版不做

- 多用户服务部署；
- 远程 Provider；
- 数据库、消息队列和完整事件溯源；
- 自定义 Agent Runtime；
- DAG 编辑器；
- Provider 市场或 SDK；
- 第二领域实现；
- 为旧版 API 泛化设计中的每个概念预建类和 interface。

## 16. 已嵌入的既有文档

本设计的执行基线、动态 rubric、自主循环和代码精简边界已同步写入：

- 总体与实现边界：TS 插件设计、泛化设计、详细设计、协议/Paper Engine、API
  泛化设计和旧实现草稿；
- 领域规则：HypothesisPool、idea generation、可信实验/消融/论文图设计；
- 真实入口：candidate-to-paper、records-to-paper 设计及两个总控 RUNBOOK；
- `README.md` 当前执行基线与关键决策索引。

后续修改应同时维护本文件、受影响的领域文档和对应 RUNBOOK，避免再次形成互相
冲突的平行设计。

## 17. 不依赖 Athena 的最小泛化闭环

M4 的第一步已收敛为
[`2026-08-20-minimal-generalized-research-loop-design.md`](2026-08-20-minimal-generalized-research-loop-design.md)：
一个由 DSH 原生 Worker、最小 ResearchTree、五个 research tools 和
`plan → work → evidence → decide` 构成的闭环。

该闭环首个 benchmark 使用 `docs/examples_articles/reliable_conflictive_multi_view_learning`
的 `candidate.md`，目标论文严格隐藏；闭环不调用 Athena。现有 Athena 路径继续作为
可选 ML 路径，不是泛化闭环的运行依赖。
