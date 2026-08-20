# 03 — IDEATION

目标：把 BRAINSTORM.md 的选定方向变成结构化 hypothesis（可实验）与 proposal（可读文档）。本模块就是 `2026-08-16-idea-generation-design.md` 的 stage 化执行手册。

## 输入

- `<run_dir>/BRAINSTORM.md`（1–3 方向）
- 文献证据（同上模块）

## 步骤

1. 对每个 `chosen=yes` 方向，Ideator 按 `prompts/ideation.md` 生成 1–5 条结构化候选。
2. TS 门禁逐候选执行：
   - structural → falsifiability → pre_gate → methodology/statistics 两视角 → hard_gate
   - 阈值照搬 Python 生产值：`MAX_TOLERATED_RISKS=6`、`max_total_risks(N)=6N-1`、`fatal_flaw` 短路
3. 门禁全拒：同线程带 rejection 重新提案，`MAX_GATE_RETRIES=2`；耗尽返回空并告警。
4. 落点：
   - `PASS/EXPLORATORY` → `IDEAS/<idea_id>.md`（proposal）+ 实验图注册 hypotheses + `HypothesisPool.upsert(QUEUED)`
   - `REJECT` → `HypothesisPool.upsert(REJECTED, gate_summary)`
5. ID 链：池记录 `origin_candidate_id = <candidate_id>`；proposal 头部带 `candidate_id`。

## Gate

- 至少 1 个 `PASS/EXPLORATORY`；否则重提 ≤2 次后 FAIL → FAILURE_REPORT 或（semi-auto）WAITING 问人。

## 产出

- `IDEAS/<idea_id>.md`（每 idea）
- `IDEA_GENERATION_REPORT.md`（存活率、可实验率、预算）
- 实验图新增 PROPOSED hypotheses；HypothesisPool QUEUED/REJECTED
