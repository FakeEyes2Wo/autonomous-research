# 05 — EXPERIMENT

目标：按预注册的 `EXPERIMENT_PLAN.md` 获取证据。引擎四选：`default`（当前 = Athena）、`external`、`none`、`auto`。半自动模式提供三个 human-in-the-loop 停点。

## 1. 引擎解析

`experiment.config.engine = auto | default | external | none`

| engine | 行为 |
|---|---|
| `default` | 使用当前 Domain Profile 的 Experiment Provider（ML v1 = Athena，PREPARE→SEARCH→VALIDATE） |
| `external` | 强制消费已有记录；找不到完整记录 → FAIL |
| `none` | 不跑实验：结果表留空，按 proposal 纪律写论文 |
| `auto` | 按 §1.1 顺序检测 |

### 1.1 auto 检测顺序

1. 入口给了 `--evidence <evidence_chain.json>` → `external`。
2. 默认 Provider 的实验目录存在且状态为 COMPLETED 且 ≥1 已结算实验 → `external`。
3. 有实验目录但未 COMPLETED → `default` + `recover()` 续跑（不重跑）。
4. 无实验目录 → `default` 全新运行。
5. `default` Provider 不可用且没有外部记录 → `none`，写 `experiment_provider_degraded`。

歧义保护：有 `RUNNING` 实验时，`auto` 和显式 `external` 都拒绝把半成品当 external（除非用户显式提供完整 `--evidence`）。

## 2. 默认 Provider 流程（ML v1：Athena）

```text
PREPARE  → baseline + frozen evaluator + EDA worktree
SEARCH   → 按 EXPERIMENT_PLAN 从 HypothesisPool.queued() 供给候选
VALIDATE → 冻结 SOTA 的最终评估（test 仅此一次）
```

- 结算回写池：WIN→SUPPORTED；DRAW/LOSS→REFUTED；无 best→INCONCLUSIVE。
- 每实验写 traceable artifacts（logs/metrics/tables）；主指标是唯一允许进论文的数字。
- 预算：`max_experiments` 映射该 Provider 的搜索预算。
- Core 只消费“执行实验并返回 evidence 引用”，不读取 Provider 内部类型与状态格式。

## 3. 半自动模式（mode=semi-auto）三停点

| 停点 | 状态 | 人工决策 | 续跑 |
|---|---|---|---|
| 每批实验启动前 | `WAITING: approve_batch` | 批准/修改/取消本批（batch = QUEUED 前 N，N=concurrency） | resume |
| baseline 后 | `WAITING: baseline_ready` | 确认 baseline 指标与 evaluator 冻结 | resume 进 SEARCH |
| 搜索耗尽/进 VALIDATE 前 | `WAITING: validate_decision` | 追加预算 / VALIDATE / 停止 | Provider 提供的预算/阶段工具 |

`mode=auto` 下三点自动通过。

## 4. external 引擎

- 输入：`--evidence <evidence_chain.json>` 或可自动检测的已完成实验记录。
- 不跑新实验；确认 `evidence_chain.json` 的 `provenance.files` 可解析。
- 候选 hypotheses 与 evidence 行的 `candidate_id` 不匹配 → WARN（只影响追溯链，不阻塞）。

## 5. none 引擎（proposal 模式）

- 结果表骨架数值留空；论文只写“设计 + 预期观察 + 可证伪条件”，不写实测数字。
- 下游 `evidence_traceable` 闸按 proposal 纪律降级（未观测值不得生成）。

## Gate

- default：Provider 状态 COMPLETED（或半自动停点状态合法）。
- external：evidence_chain 存在且 schema 合法。
- none：plan 存在且数值单元格全空。

## 产出

- 默认 Provider 的实验产物（树/状态/artifacts）
- 或用户提供的 `evidence_chain.json`（external）
- 或数值为空的 plan（none）

## 泛化边界

新增实验平台 = 新增 Experiment Provider，提供“运行预注册计划 + 返回 evidence 引用 + 可恢复状态”；不改 Core 与下游。
