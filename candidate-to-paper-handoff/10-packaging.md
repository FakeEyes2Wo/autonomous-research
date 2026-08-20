# 10 — PACKAGING

目标：终检后打包，出 FINAL_REPORT 或 FAILURE_REPORT。执行细节复用 `records-paper-handoff/04` 的 PACKAGING 段。

## 步骤

1. 终检 `verify-trace`（要求 PASS/WARN）。
2. 打包：

```text
packaging/
  paper.pdf / paper_draft.md / paper_sources.zip
  evidence_chain.json / trace_audit.json
  paper_claim_audit.json / citation_audit.json / kill_argument.json
  RUBRIC.md / PLAN-v*.md
  bibliography.bib
  [FAILURE_REPORT.md]
  FINAL_REPORT.md
```

3. FINAL_REPORT 必含：

```markdown
- candidate_id → hypothesis_ids → experiment_ids 链摘要
- rubric 引用与冻结时间；研究 cycle、计划修订和最终停止理由
- 预算使用、降级、人工介入和仍未满足的 rubric 条目
- Submission-ready: yes | no
- trace_verdict / paper_claim_audit / citation_audit / kill_argument
- citation_validity% / figure_editability% / review_precision%
```

4. 若 09 触发 bounded recovery：`FAILURE_REPORT.md`（原始 idea、已试方法、全部实验、证据不足原因），`Submission-ready: no`。

## Gate

- 终检 PASS/WARN；三审查 JSON 齐全且无 FAIL；否则禁打包。

## 产出

- `packaging/` 全部产物
- `FINAL_REPORT.md` 或 `FAILURE_REPORT.md`
