# Idea Generation（仍有效）

日期：2026-08-16
状态：design（candidate→paper 的 `ideation` step 执行此设计）

## 形态

独立 handoff step：`brainstorm → 候选生成 → 门禁 → 落盘/入池`。不建设独立 Service；DSH subagent + Markdown prompt 承载。

## Brainstorm（双模）

| 模式 | 触发 | 行为 |
|---|---|---|
| interactive | `AUTO_PROCEED=false` | 一次一问 → 2–3 方向带权衡 → 人选定 |
| autonomous | `AUTO_PROCEED=true` / 零输入 | 发散 5–10 方向 → 批评 → 收敛 1–3 |

产物：`BRAINSTORM.md`（Inputs / Directions / Selected / Rejected+why）。零输入且文献不可用：自治写失败报告，不硬编方向。

## 候选生成与门禁

- 每方向生成 1–5 条结构化候选：statement / intervention / expected_effect / premises / predicted_observations / disconfirming_observations。
- 门禁：structural → falsifiability → pre_gate → methodology/statistics 两视角 → hard_gate。
- 阈值沿用生产校准值：`MAX_TOLERATED_RISKS=6`、`max_total_risks(N)=6N-1`、`fatal_flaw` 短路。
- 全拒：同线程带 rejection 重提 ≤2 次；耗尽返回空并告警，绝不静默。

## 落点

- `PASS/EXPLORATORY` → proposal 落 `IDEAS/`；hypothesis 入实验图 + HypothesisPool（QUEUED）。
- `REJECT` → 池 REJECTED + gate_summary。
- 池记录 `origin_candidate_id`。

## 泛化边界

输入源可插拔：零输入 / 一句话方向 / `evidence_chain.json` / 本地 corpus；文献工具默认 paper_scout→fetch→markdown→rag，失败降级 web/local corpus。
