# 02 — CLAIMS & OUTLINE

`evidence_chain.json` → 判级 → 贡献 → outline → 契约。若由控制平面启动，读取 `RUBRIC.md(post-hoc)`：限制 claim 强度、指缺失证据；不得重定义指标/删不利实验/伪装预注册。

## 判级 rubric
| 级别 | 条件 | 处理 |
|---|---|---|
| strong | SOTA；或 SUPPORTED 且 vs_baseline 方向一致且改善 ≥1% | Results 主表 |
| weak | SUPPORTED 但 <1% 或方向不符 | 弱声明 |
| negative | REFUTED/INCONCLUSIVE/FAILED | 必须进 limitations |
| future | RUNNING / PROPOSED | Future work |

## result-to-claim（跨模型一批审）
只给 reviewer evidence + report 路径。输出每实验 `yes|partial|no` + revision + confidence。外部 baseline：正 Δ 且同设定才 `outperform`，否则 `competitive`。

## Claim Admission
SUPPORTED=retain；PARTIALLY_SUPPORTED=narrow；UNSUPPORTED=弱化/移除/limitations；CONTRADICTED=移除/limitation；NEEDS_CONFIRMATION=作者确认（不得留终稿）。修订跨节传播，abstract 最后改。

## 产出
`claims.md`（含 candidate_id）→ `CONTRIB-*` → `related_work_scaffold.md` → `outline.md` → `trace_exclusions.md` → `paper_acceptance_contract.md`（对抗谈判 ≤3 轮）。
