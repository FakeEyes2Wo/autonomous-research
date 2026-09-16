# candidate → paper 全流程（仍有效）

日期：2026-08-16
状态：design（2026-08-20 控制平面的默认端到端流程）

## 流程

```text
candidate.md
  → candidate.json + candidate_id
  → BRAINSTORM.md（双模）
  → IDEAS/*.md + hypotheses（TS 门禁）
  → EXPERIMENT_PLAN.md（预注册：表结构先定、数值后填）
  → Experiment Provider（默认 Athena；engine=auto|athena|external|none）
  → evidence_chain.json（Source Adapter 归一）
  → claims / outline / 验收契约
  → writing（role-aware 图 + bib）
  → review（verify-trace + 三审查 + 有界修订）
  → packaging / FINAL_REPORT 或 FAILURE_REPORT
```

阶段实现 = `candidate-to-paper-handoff/01–10`；控制平面只负责启动、恢复、预算与 gate。

## 四段 ID 强追溯

```text
candidate_id → hypothesis_id → experiment_id → E:/B: 论文标签
```

每个阶段产物必须带上游 ID；`verify-trace` 校验 evidence 行的 `candidate_id` 存在于 `candidate.json`。

## 人工闸

- brainstorm 后 + outline 后（`AUTO_PROCEED=false`）。
- Experiment Provider 半自动三停点：批前批准 / baseline 后 / VALIDATE 前。

## 失败语义

- 实验-批判-修订循环上限 7；耗尽且核心贡献 unsupported → `FAILURE_REPORT.md`（保留失败轨迹）。
- semi-auto：循环耗尽先 WAITING 问人（换 idea / 降级 proposal / 停止）。
- 阴性结果全程保留到 limitations。

## 泛化边界

- 实验执行方统一为 **Experiment Provider**；默认实现 Athena，`external` 消费已有 evidence，`none` 只出 proposal/失败报告。
- 证据契约统一 `evidence_chain.json`；论文契约统一 `E:`/`B:` 标签与 `trace_audit.json`。
- 目录：`<run_root>/` 下 `research/`（RUBRIC/PLAN/cycles/final-evidence）与 `records-paper/`（01–04 产物），不写死平台路径。
