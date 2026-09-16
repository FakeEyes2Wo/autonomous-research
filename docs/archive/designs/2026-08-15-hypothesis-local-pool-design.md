# HypothesisPool 生命周期索引（仍有效）

日期：2026-08-15；2026-08-20 保留
状态：**仍有效**。首版只实现 ML v1 实际使用的字段与迁移，不做完整通用 Provider API。

## 定位

- **实验图（当前实现为 Athena ResearchTree）是实验事实源**；HypothesisPool 是跨阶段生命周期与论文元数据索引。
- 两者冲突时以实验图结论为准；池写失败不得阻塞实验结算。

## 池记录核心字段

```jsonc
{
  "pool_id": "hyp_...",            // = 实验图中的 hypothesis id
  "hypothesis": { "statement": "...", "intervention": "...", "expected_effect": "..." },
  "pool_status": "QUEUED",
  "origin": "ideation | manual | paper_revision | gap_mining",
  "origin_candidate_id": "cand-...",   // candidate→paper 链路根 ID，非该链路为 null
  "gate_summary": { "verdict": "PASS", "blocking_factor": null },
  "experiment_ids": [],
  "best_metric": null,
  "comparison_outcome": "WIN | DRAW | LOSS | null",
  "paper_refs": [],
  "negative_result": false
}
```

## 状态机

```text
QUEUED → SELECTED → RUNNING → SUPPORTED / REFUTED / INCONCLUSIVE
QUEUED → REJECTED（门禁拒绝）
SUPPORTED/REFUTED/INCONCLUSIVE → PROMOTED_TO_PAPER / NEGATIVE_RESULT / ARCHIVED / SUPERSEDED
PROMOTED_TO_PAPER / NEGATIVE_RESULT → ARCHIVED
```

## 关键规则

1. 入池前按语义去重；重复只更新 `updated_at`。
2. 实验结算回写：WIN→SUPPORTED；DRAW/LOSS→REFUTED；无 best→INCONCLUSIVE。
3. 论文回写：正文引用→PROMOTED_TO_PAPER；limitations 引用→NEGATIVE_RESULT；不写→ARCHIVED。
4. 新 SOTA 胜出时，其祖先链标记 SUPERSEDED。
5. 四段 ID 追溯：`candidate_id → hypothesis_id → experiment_id → paper evidence tag`；池保存 `origin_candidate_id`。

## 查询 API（首版最小集）

`queued / running / supported / refuted / inconclusive / negative_results / promoted_to_paper / upsert / reconcile / export_for_paper`

## 泛化边界

实验图可替换为任意平台实现；池只依赖“hypothesis id + 状态 + 实验结论 + 论文归属”这个最小契约。
