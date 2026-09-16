# candidate → paper RUNBOOK（总控）

执行者：DSH / Coding Agent。入口是**人类模糊 idea**（`candidate.md`），终点是论文或失败报告。本 RUNBOOK 只做编排；每阶段细节见对应模块文档。

## 0. AutoResearch 控制平面包装

ML v1 保持本 RUNBOOK 的 01–10 文件编号和产物契约不变，但由
`AutoResearchService` 增加两个控制步骤：

1. 01 完成后、02 开始前，根据任务类型生成并独立审查 `RUBRIC.md`；通过后冻结，
   后续 `EXPERIMENT_PLAN.md` 必须满足该 rubric。
2. 06 evidence 完成后、07 claims 开始前，Supervisor 根据 rubric、证据和预算决定
   继续实验、转向、请求用户或结束研究。继续/转向时生成新的 `PLAN-vN.md`，再执行
   相关的 02–06 模块；旧计划、旧实验和旧 evidence 不覆盖。

`AUTO_PROCEED=true` 只跳过常规 checkpoint，不跳过核心研究问题变化、外部数据、
预算扩容、低置信度 rubric 和无法可靠停止等高影响人工升级。

## 1. 输入与入口

```bash
# 最小入口
node ... run-candidate-to-paper.mjs \
  --candidate candidate.md \
  [--work-dir .] \
  [--mode auto|semi-auto] \
  [--engine auto|default|external|none] \
  [--evidence evidence_chain.json] \
  [--template plain_latex] [--latex-via none|local|overleaf]
```

## 2. 阶段顺序与产物

| # | stage | 模块 | 关键产物 | gate |
|---|---|---|---|---|
| 1 | candidate_intake | 01 | candidate.json（含 candidate_id） | schema 合法 |
| 2 | brainstorm | 02 | BRAINSTORM.md（1–3 方向） | ≥1 方向，否则 FAILURE_REPORT |
| 3 | ideation | 03 | IDEAS/*.md + hypotheses 入实验图/池 | 门禁 PASS/EXPLORATORY ≥1，否则重提 ≤2 |
| 4 | experiment_plan | 04 | EXPERIMENT_PLAN.md（预注册） | plan 覆盖所有 QUEUED hypothesis |
| 5 | experiment | 05 | 实验产物 + 状态 | 见 05 |
| 6 | evidence | 06（转 records-paper 01） | evidence_chain.json | extract exit 0 |
| 7 | claims_outline | 07（转 records-paper 02） | claims/outline/exclusions/contract | 无 NEEDS_CONFIRMATION |
| 8 | writing | 08（详细写作设计） | paper/*.tex + draft + bib | 无 TODO/FIXME/DATA_NEEDED |
| 9 | review | 09（转 records-paper 04） | trace_audit + 三审查 | verify PASS/WARN，审查无 FAIL |
| 10 | packaging | 10（转 records-paper 04） | packaging/ + 报告 | 终检 PASS/WARN |

## 3. RunSpec preset

见 `2026-08-16-candidate-to-paper-design.md` §3。ML v1 可把它作为内部顺序配置，
不要求实现通用 RunSpec/PipelineRunner。`experiment.config.engine` 与 `mode` 仍是仅有的
两个链路级开关。

## 4. ID 链强制

```text
candidate_id → hypothesis_id → experiment_id → E:/B: 标签
```

- 01 生成 `candidate_id`，后续每个模块产物必须带上游 ID。
- 03 入池时写 `HypothesisPool.origin_candidate_id`。
- 05 实验结算后写实验图；06 的 evidence_chain 行带 `candidate_id`。
- 09 的 verify-trace 校验 evidence 行 `candidate_id` 存在于 `candidate.json`。

## 5. 人工闸

| 闸 | 条件 | 决策 |
|---|---|---|
| brainstorm 后 | `AUTO_PROCEED=false` 或 brainstorm 为 interactive | 确认/修改选定方向 |
| outline 后 | `AUTO_PROCEED=false` | 确认 claims + outline + 验收契约 |
| 实验三停点 | `mode=semi-auto` | 批前批准 / baseline 确认 / VALIDATE 决策（见 05） |

`AUTO_PROCEED=true` 且 `mode=auto` 时全链无人值守。

## 6. 预算

| 维度 | 作用 | 耗尽行为 |
|---|---|---|
| `max_ideas` | ideation | 停止生成，进入 experiment_plan |
| `max_experiments` | experiment | 触发搜索预算 / VALIDATE 决策 |
| `max_paper_rounds` | review 内容修订 | 冻结最优版并标记未过项 |
| `max_tokens` | 全局 | 阶段间检查，置 WAITING |
| `project_time_limit` | 全局 | 置 WAITING；编译修复只受此限制 |

## 7. 失败与恢复

- 确定性脚本失败：按 stderr 修复后重跑该 stage。
- LLM 调用失败：重试 1 次，仍失败置 WAITING 保留产物。
- 实验-批判-修订循环上限 7；耗尽见 §8。
- 崩溃恢复：读 AutoResearch `state.json` 的当前 step 续跑；experiment 用
  Experiment Provider 的 `recover()`；evidence 源哈希未变则跳过重抽取。

## 8. 失败报告 vs 成功论文

- 成功：10 个 gate 全过 → `packaging/` + `FINAL_REPORT.md`。
- 失败：
  - brainstorm 无方向 / ideation 门禁全拒 / 实验 7 轮仍否定核心贡献 / review 轮次耗尽 → `FAILURE_REPORT.md`。
  - `mode=auto`：按预算换新 idea 重跑（保留失败轨迹）。
  - `mode=semi-auto`：置 WAITING 问人（换 idea / 降级 proposal / 停止）。
