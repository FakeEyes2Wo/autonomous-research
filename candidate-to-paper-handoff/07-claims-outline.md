# 07 — CLAIMS & OUTLINE

目标：把 evidence_chain 判级、聚合贡献、出大纲与验收契约。执行细节复用 `records-paper-handoff/02`。

## 输入

- 汇总全部研究 cycle 的 `research/final-evidence-chain.json`，并通过
  `records-paper/<run_id>/evidence_chain.json` 兼容现有下游
- 冻结的 `RUBRIC.md`
- 全部 `PLAN-vN.md` 与 AutoResearch 最终 decision

## 步骤

1. 按冻结的任务 rubric 判级 strong/weak/negative/future；不得只读取最后一轮或只保留
   有利结果。
2. result-to-claim 一批审（跨模型 fresh thread）。
3. Claim Admission 五标签：SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED / NEEDS_CONFIRMATION。
4. 聚合 2–4 条 `CONTRIB-*`；写 `related_work_scaffold.md`。
5. 写 `outline.md`、`trace_exclusions.md`。
6. **写 mapping 块**（供 08 脚本生成矩阵，脚本只取值不判断语义）：

```markdown
## Evidence mapping（claim → experiment，脚本从这里取映射）
| claim_id | candidate_id | hypothesis_ids | experiment_ids | baseline_ids | admission_label | allowed_wording | domain_extra |
|---|---|---|---|---|---|---|---|
| claim-1 | cand-3f9a | hyp_... | exp_... | B-... | SUPPORTED | <final_claim 原文> | {environment: kaggriculture} |
```

7. 对抗谈判 `paper_acceptance_contract.md`（≤3 轮）。

## candidate 链差异

- `claims.md` 每行必须保留 `candidate_id`（来自 evidence_chain）。
- 每条 `CONTRIB-*` 记录成员 `experiment_ids` 及其 `candidate_id`。
- mapping 块覆盖所有 `strong/weak` claim；`domain_extra` 为领域可变字段（不同领域论文自行扩展）。
- contract 增加断言：论文 claims 可回溯到 `candidate_id → hypothesis_id → experiment_id → E:/B: 标签`。

## Gate

- 无 NEEDS_CONFIRMATION 残留；contract accepted（或显式 contested）。

## 人工闸

`AUTO_PROCEED=false` 时在 outline 后暂停。

## 产出

`claims.md` / `related_work_scaffold.md` / `outline.md` / `trace_exclusions.md` / `paper_acceptance_contract.md`
