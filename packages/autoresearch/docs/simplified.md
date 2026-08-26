# Autoresearch 最小化架构

> 本文描述最终保留的调用结构和维护规则。核心目标是：**同一个语义只实现一次；业务决策留在所属功能附近；无状态步骤不使用 class 保存依赖。**

## 最终调用图

```text
AutoResearchService
  -> ResearchRunner (公开兼容边界，只保存一个 deps)
  -> 一个 RunContext
  -> brainstorm / idea / experiment / paper 功能函数
  -> runAgent / runStage / reviewGate
  -> ResearchTree + RunState + PaperCheckpoint
```

## 分层约束

- `AutoResearchService` 只保存 `{ provider, options }` 一个依赖对象。
- `ResearchRunner` 只保存 `Readonly<ResearchRunnerOptions>`，运行期间创建一次 `RunContext`。
- 有状态领域对象保留 class：`ResearchTree`、`HypothesisPool`。
- 外部适配器保留 class：`SubagentRoleAgentProvider`、Logger。
- 无状态步骤、阶段、ranking、pipeline 均为命名函数，不持有 provider/logger/options。
- `brainstorm`、`idea`、`experiment`、`paper` 保持独立模块，不合并成 workflow DSL。

## 单一事实来源

- Role 名称来自 `agents/roles/index.ts` 的 `roleSpecs`。
- Paper audit 规格来自 `paper/phases.ts` 的 `PAPER_AUDITS`。
- Human review 执行来自 `service/review.ts` 的 `reviewGate`。
- 可选文本读取来自 `core/utils.ts` 的 `readOptionalText`，只容忍 ENOENT。
- 共享 agent 执行来自 `service/agent.ts` 的 `runAgent` / `runStage`。
- 共享排序来自 `brainstorm/ranking.ts` 的 `rankCandidates`。

## 共享机制只有一个实现

- 重试、日志、结构化输出。
- 阶段状态迁移与文件落盘。
- human review 的跳过/询问/降级。
- evidence chain 导出。
- paper checkpoint 阶段执行。
- LaTeX engine 选择。

## 业务决策保持本地

- idea/rubric/experiment/evidence 各自的 approve/revise/reject 语义留在对应流程。
- brainstorm survey/frontier/wiki/KG 步骤留在 brainstorm 模块。
- paper 各阶段业务规则留在 paper 模块。
- 相似代码不得为了减少行数而强行合并。

## 验收标准

1. `ResearchRunner` 和 `AutoResearchService` 各只保存一个依赖对象。
2. 没有 `ResearchSteps`、`RoleRunner`、`RunSession`、`IdeaSteps`、`ExperimentSteps`、`PaperSteps`、`PaperPhases`、`PaperPipeline`、`BrainstormPipeline`、`DefaultRankingStrategy`、`RunFiles` 等无状态 class。
3. Role 名称、paper audit 规格均只有一个注册表。
4. `npm run typecheck` 与 `npm test` 全部通过。
