# 泛化与极简（收敛摘要）

日期：2026-08-15 起草；2026-08-20 收敛
状态：**M4 参考，不是 ML v1 实现基线**。

## 当前原则

1. ML v1 只实现一个真实 Domain Profile（`ml.default`），不为每个能力预建 interface/class。
2. 出现第二个真实领域后，再从实际差异中提炼最小契约。
3. Core 只保存控制语义：状态、rubric 冻结、预算、人工升级、evidence 追溯；不建设通用 DAG/Provider 框架。

## 保留的泛化边界

- 实验执行方：**Experiment Provider**（当前实现：Athena）。
- 证据来源：**Source Adapter**（当前实现：athena；未来 wandb/csv/mlflow）。
- 论文模板 / 编译 / 图生成 / 文献：固定降级链即可，不需要抽象层。
- 领域规则通过 **Domain Profile** 选择，而非代码分支。

## 已被取代

RunSpec + PipelineRunner + StageContext + ProviderRegistry + GateRunner + EventBus 全套通用框架不再实现；handoff 承载领域流程，`AutoResearchService` 承载统一启动与恢复。
