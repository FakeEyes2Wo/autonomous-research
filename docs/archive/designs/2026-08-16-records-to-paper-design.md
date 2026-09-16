# 已有实验记录 → 论文（仍有效）

日期：2026-08-16
状态：design（第二入口；`candidate → paper` 阶段 6–10 复用本链路）

## 原则

- 程序只做溯源：`extract`（任意来源 → `evidence_chain.json`）与 `verify`（论文标签 × 证据链 → `trace_audit.json`）。
- 其余全部 handoff：intake / claims / writing / review 都是 Markdown 执行手册。
- 不建设 RunSpec/Provider/Gate 框架。

## 流程

```text
Source Adapter（当前 athena）→ evidence_chain.json
  → claims（判级 + Claim Admission 五标签 + 贡献聚合）
  → outline + 验收契约
  → writing（role-aware 图 + 真实 bib + abstract 最后）
  → review（verify-trace + 三零上下文审查 + 有界修订）
  → packaging
```

## 数据契约（唯一程序化部分）

- `evidence_chain.json`：task / baselines / experiments / future / provenance；`result_integrity_mode=data-aware`；每行可带 `candidate_id`。
- 标签：`% evidence: E:<experiment_id>` / `B:<baseline_id>`（±1 行匹配）。
- `trace_audit.json`：PASS/WARN/FAIL + per-experiment 覆盖与数值匹配 + stale 检测。

## 关键规则

- 数字只来自 evidence 或 report artifact 原文；`DATA_NEEDED` 不得进入终稿。
- `REFUTED/INCONCLUSIVE/FAILED` 必须写 limitations，不可靠排除躲掉。
- bib 走 DBLP/CrossRef，否则 `[VERIFY]`。
- reviewer 零上下文、跨模型、fresh thread。
- 核心贡献全 unsupported → `FAILURE_REPORT.md`，不强行成功。

## 泛化边界

- 新增来源 = 新增 Source Adapter（wandb/csv/mlflow…），不改下游。
- 论文模板 / 编译 / 图生成使用既有降级链；`evidence_chain.json` 是唯一跨来源契约。
