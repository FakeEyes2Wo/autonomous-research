# Records-to-Paper RUNBOOK

已有实验记录 → 论文。01、02、04 独立可替换，写作复用 `../candidate-to-paper-handoff/08-writing.md`；步骤/恢复由 `AutoResearchService` 保存。

## 常量
`AUTO_PROCEED=true`；`MAX_PAPER_ROUNDS=5`；`MAX_CONTRACT_ROUNDS=3`；编译修复不限轮（只受时间预算）；论文路径 `overleaf→local→none`。

## 产物
```text
<run_root>/records-paper/<run_id>/
  evidence_chain.json  RUBRIC.md(post-hoc)  record_digest.md
  claims.md  related_work_scaffold.md  outline.md
  paper_acceptance_contract.md  trace_exclusions.md  trace_audit.json
  paper/  packaging/  FINAL_REPORT.md [FAILURE_REPORT.md]
```

## 阶段与 gate
| 阶段 | 模块 | gate |
|---|---|---|
| INTAKE | 01 `extract` | exit 0 + schema 合法 |
| CLAIMS | 02 | 无 NEEDS_CONFIRMATION；contract accepted/contested |
| WRITING | candidate 08（复用） | 无 TODO/FIXME/DATA_NEEDED；bib 卫生 |
| REVIEW | 04 `verify-trace` | PASS/WARN；编译过；三审查无 FAIL |
| PACKAGING | 04 终检 | PASS/WARN；三审查 JSON 齐全 |

## 铁律
1. 数字只来自 evidence 或 report 原文；标签 `E:`/`B:`。
2. writer 不审自己的稿；三审查 fresh、跨模型、零上下文。
3. 阴性结果写正文，不可排除。
4. bib 走 DBLP/CrossRef，否则 `[VERIFY]`。
