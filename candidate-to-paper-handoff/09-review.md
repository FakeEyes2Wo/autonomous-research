# 09 — REVIEW

目标：确定性校验 + 三个零上下文审查 + 有界修订。执行细节复用 `records-paper-handoff/04` 的 REVIEW 段。

## 步骤

1. `verify-trace`（带 `--candidate-json candidate.json`，启用 candidate_id 链校验）。
2. Manuscript Gate：`DATA_NEEDED/TODO/FIXME` 为空。
3. 编译修复循环：不限轮次，只受 `project_time_limit`。
4. 三个零上下文审查（fresh thread、跨 model family、只给路径）：
   - paper-claim-audit：逐数字对 evidence + report；检查四舍五入/选 best seed/Δ 算错/图注表值/EDA 图/消融完整性。
   - citation-audit：存在性 + 元数据 + 语境支持。
   - kill-argument：最强拒稿 memo；压标题/摘要范围过度。
5. 修订循环 ≤ `MAX_PAPER_ROUNDS`；FAIL 必修，WARN 记录。
6. Bounded recovery：核心贡献全 UNSUPPORTED/CONTRADICTED → `FAILURE_REPORT.md`，回到 experiment 的 bounded recovery（上限 7）。

## candidate 链差异

- verify 检查 `evidence.experiments[].candidate_id` 非 null 时必须存在于 `candidate.json`。
- 三审查的 issue 报告额外标注涉及的 `candidate_id`。

## Gate

- `trace_audit` PASS/WARN；编译过；三审查无 FAIL。

## 产出

- `trace_audit.json`
- `paper_claim_audit.{md,json}` / `citation_audit.{md,json}` / `kill_argument.{md,json}`
- 修订后的 `paper/`
