# AutoResearch 最小泛化研究闭环设计

日期：2026-08-20
状态：approved design

## 1. 目标

用最少的新代码跑通一个不依赖 Athena 的通用研究闭环：

```text
idea → plan → work → evidence → decide
          ↑                    │
          └── continue/revise ─┘
                               ↓
                         paper | failure report
```

首个真实 benchmark 使用：

```text
docs/examples_articles/reliable_conflictive_multi_view_learning/
```

运行时只允许读取 `candidate.md`。目标论文正文、PDF、摘要和结论全部隐藏，只在
研究运行关闭后的独立评测阶段使用。

## 2. 范围

本闭环复用 DSH 的 Agent、Subagent、Tools、文件系统、shell、web、沙箱、审批和
模型路由。研究 Worker 直接用 DSH 写代码、检索允许的资料并运行分析或实验。

本闭环实现自己的最小 ResearchTree 和 research tools，但不实现 Athena adapter、
HypothesisPool、Provider Registry、DAG、通用实验运行器或 Scheduler。

现有 Athena 路径保留为历史/可选路径，不进入本闭环和首个 benchmark。

## 3. 最小架构

```text
AutoResearchService
├─ state.json
├─ research_tree.json
├─ 五个 research tools
└─ DSH subagents
   ├─ Rubric Generator / Reviewer
   ├─ Planner
   ├─ Research Worker
   ├─ Evidence Agent
   ├─ Supervisor
   └─ Writer
```

`AutoResearchService` 只负责调用 handoff、保存当前步骤、维护 ResearchTree、执行
decision 和恢复中断。

领域纪律放在普通 Markdown `PROFILE.md` 中，不建立 Profile Registry。Profile 只
说明允许/禁止的资料和行为、有效 evidence 的基本要求，以及论文/失败报告的交付
要求。目标论文 denylist 和隐藏文件隔离属于 benchmark runner，不写入 Profile。

## 4. ResearchTree 与 tools

ResearchTree 是 hypothesis、研究动作和 evidence 的事实源。只保存三类节点：

```ts
type ResearchNode = {
  id: string
  kind: "hypothesis" | "action" | "evidence"
  status: string
  parent?: string
  content: string
  artifacts?: string[]
}
```

关系通过 `parent` 表示：

```text
hypothesis
  └─ action
       └─ evidence
```

Hypothesis 最小状态：

```text
proposed → testing → supported | refuted | inconclusive
```

只提供五个 DSH tools：

- `research_hypothesis_add`：添加或修订 hypothesis；
- `research_action_start`：为 hypothesis 开始研究动作；
- `research_action_finish`：记录动作结果和产物；
- `research_evidence_add`：绑定 evidence 与结论；
- `research_tree_query`：按节点类型或状态查询。

Agent 不直接修改 `research_tree.json`。所有写入经过 tools，由
`AutoResearchService` 原子保存。`evidence_chain.json` 从 ResearchTree 确定性导出。

## 5. 最小结构化契约

Core 只依赖两个结构化结果。

Worker 执行结果：

```ts
type ActionResult = {
  status: "completed" | "failed"
  summary: string
  artifacts: string[]
}
```

Supervisor 决策结果：

```ts
type ResearchDecision = {
  action: "continue" | "revise" | "finish" | "fail"
  reason: string
}
```

其他内容继续使用文件：

```text
candidate.md
PROFILE.md
RUBRIC.md
PLAN-vN.md
work/cycle-N/
evidence_chain.json
DECISION.md
paper_draft.md
```

`state.json` 只保存当前 step、cycle、status、artifact paths 和 last error。

## 6. 完整 loop

### 6.1 Intake

读取 `candidate.md`，创建根 hypothesis。目标论文文件不挂载到运行目录。

### 6.2 Rubric

Rubric Generator 根据 `candidate.md + PROFILE.md` 生成任务专用 `RUBRIC.md`；独立
Reviewer 检查它是否可验证，随后冻结。

### 6.3 Plan

Planner 查询 ResearchTree，选择或新增 hypothesis，写 `PLAN-vN.md`。

### 6.4 Work

Research Worker 在 `work/cycle-N/` 中直接使用 DSH 工具完成检索、代码、分析或
实验，并返回 `ActionResult`。

低算力由 benchmark 样例筛选保证，不在 Profile 中规定 smoke/core/confirm 层级，
首版也不自动限制 CPU/GPU 时间。样例进入 benchmark 前由维护者离线确认不依赖
大规模预训练、多机集群或不可获得的资源。

### 6.5 Evidence

Evidence Agent 检查结果、日志、数据来源和产物，将 supports、refutes 或
inconclusive evidence 写入 ResearchTree。没有可验证 evidence 时不得进入论文。

### 6.6 Decide

Supervisor 查询 ResearchTree 并对照冻结 rubric：

- `continue`：继续当前方向；
- `revise`：生成新计划，只修改未来动作；
- `finish`：证据足够，进入论文；
- `fail`：没有可信结果，生成失败报告。

### 6.7 Paper

从 ResearchTree 导出 `evidence_chain.json`，复用 records-to-paper handoff，生成完整
`paper_draft.md` 和 `FINAL_REPORT.md`。所有论文数字必须来自 evidence；失败和无
结论动作不得删除。

首版 Markdown 论文必须包含摘要、相关工作、方法、实验、结果、局限和引用。

## 7. 目标论文隔离

Benchmark runner 只复制 `candidate.md` 和 `PROFILE.md` 到独立运行目录。

公开检索允许使用，但结果进入 Agent 上下文前必须按隐藏 metadata 过滤：

- arXiv ID 和目标 URL；
- 规范化标题；
- 作者组合；
- 本地文件哈希；
- 明显镜像和直接副本。

命中结果直接丢弃，不返回标题、摘要或 snippet。运行结束后扫描日志、引用和产物；
命中目标信息时标记 `LEAKAGE_FAIL`，本次 benchmark 无效。

研究运行关闭后，独立 evaluator 才能读取隐藏原论文、生成论文、evidence 和最终
报告，比较研究问题、方法、实验、结论、重合、遗漏和新方向。比较只生成
`BENCHMARK_REPORT.md`，不反馈给同一次运行继续修订，也不要求重新发现原论文方法。

## 8. 最小错误处理与恢复

- DSH subagent 或工具临时失败时重试一次；
- 第二次失败时把 action 标记为 failed，由 Supervisor 决定 revise 或 fail；
- evidence 与产物不一致时拒绝写入 Tree；
- ResearchTree 使用原子 JSON，加载失败时停止，不猜测修复；
- 每个步骤开始前写 `state.json`，完成后再推进；
- 重启后从未完成步骤继续；
- 人工 `stop` 保留 Tree、代码、日志和 evidence；
- 论文生成失败时保留研究产物，重试一次后生成失败报告；
- denylist 或隔离失效时立即 `LEAKAGE_FAIL`。

首版不建设错误码体系、任务队列、复杂事务或自动资源管理。

## 9. 运行目录

```text
run/
├─ input/candidate.md
├─ PROFILE.md
├─ RUBRIC.md
├─ PLAN-v1.md
├─ PLAN-v2.md
├─ state.json
├─ research_tree.json
├─ work/cycle-*/
├─ evidence_chain.json
├─ DECISION.md
├─ paper_draft.md
├─ FINAL_REPORT.md | FAILURE_REPORT.md
└─ BENCHMARK_REPORT.md
```

## 10. 测试与验收

确定性测试只覆盖：ResearchTree 关系和状态、五个 tools 的 parent/artifact 校验、
Tree 到 evidence 的导出、state 恢复，以及 denylist 过滤与泄漏检测。

Fake 集成测试跑两轮：第一轮 action failed/evidence inconclusive，Supervisor revise；
第二轮 evidence supported，Supervisor finish 并生成论文。

真实 v1 使用 `reliable_conflictive_multi_view_learning`，必须满足：

1. 运行时只读取 `candidate.md`；
2. 目标论文和镜像被过滤；
3. 生成并冻结 `RUBRIC.md`；
4. ResearchTree 包含 hypothesis、action、evidence；
5. DSH Worker 完成至少一次真实分析或实验；
6. 所有论文数字来自 `evidence_chain.json`；
7. 失败和无结论动作没有被删除；
8. 输出完整 `paper_draft.md` 和最终/失败报告；
9. 整个闭环没有调用 Athena；
10. 运行关闭后才生成 `BENCHMARK_REPORT.md`；
11. benchmark 不要求复现原论文方法；
12. 日志、引用和产物无目标论文泄漏。

## 11. 明确延期事项

- `TODO[AR-PDF-002]`：Markdown 闭环稳定后接入现有 Paper Engine，要求生成
  LaTeX/PDF；不阻塞 v1。
- `TODO[AR-BUDGET-003]`：根据首批真实运行数据增加 CPU/GPU/时间预算限制；限制
  资源使用，不规定 Agent 的实验策略。
- `TODO[AR-SCHEDULER-004]`：最小闭环稳定后，根据真实运行数据增加 hypothesis/
  action 优先级、依赖、并发和自动调度。
- `TODO[AR-BENCHMARK-005]`：选择第二篇低算力论文，在不修改 Core 的情况下验证
  泛化。

这些 TODO 均有明确触发条件，不是未完成的 v1 设计占位符。
