# 04 — REVIEW & PACKAGING

## REVIEW
1. `verify-trace`：FAIL 逐条修，WARN 优先修数值。
2. Manuscript Gate：`DATA_NEEDED/TODO/FIXME` 为空。
3. 编译修复：不限轮，只受时间预算；日志原文喂回。
4. 三审查（fresh、跨模型、只给路径）：
   - paper-claim-audit：数字 vs evidence/report；四舍五入/选 seed/Δ/图注/EDA/消融。
   - citation-audit：存在性 + 元数据 + 语境；REPLACE/REMOVE 人工确认。
   - kill-argument：200 词最强拒稿理由，压标题/摘要范围。
5. 修订 ≤ `MAX_PAPER_ROUNDS`；FAIL 必修，WARN 记录。
6. Bounded recovery：核心贡献全 unsupported/contradicted → `FAILURE_REPORT.md`，不强行成功。

## PACKAGING
终检 PASS/WARN 后打包：paper.pdf/draft/sources.zip + evidence_chain.json + trace_audit.json + evidence/citations.json + evidence/*.pdf + 三审查 JSON + bib + FINAL_REPORT（verdict、citation_validity%、figure_editability%、review_precision%）。

## 铁律
verifier-as-truth；审计后改论文必须重跑受影响审查与 verify-trace。
