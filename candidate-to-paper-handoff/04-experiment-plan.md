# 04 — EXPERIMENT PLAN（预注册）

目标：在看到实验结果**之前**冻结实验设计。表结构先定、数值后填（Spark-to-Paper pre-registration；可信实验规则沿用 `2026-08-15-autoresearch-figures-and-experiment-design.md`）。

## 输入

- `HypothesisPool.queued()`（本 candidate 的全部 PASS/EXPLORATORY 候选）
- `candidate.json` / `BRAINSTORM.md`
- 已通过独立 Reviewer 并冻结的 `RUBRIC.md`
- 任务元数据（若 Domain Profile 已解析则复用）

## 步骤

1. 从 `RUBRIC.md` 提取主指标、baseline、数据划分、重复测量、证据要求和停止条件；
   缺少可执行定义时返回 rubric 修订，不得自行补成更宽松标准。
2. 对每个 hypothesis 写实验设计条目：

```yaml
- hypothesis_id: hyp_...
  candidate_id: cand-3f9a
  independent_variable: <只改一个核心变量>
  controlled_variables: [...]
  datasets: [{dataset_id, train_split, valid_split, test_split, test_visible: false}]
  seeds: [0, 1, 2]
  metric: <主指标名>
  direction: maximize | minimize
  tolerance: 0.0
  statistical_test: {method: win_draw_loss | paired_bootstrap | none, ...}
  ablation: {type: remove_component | replace_component | ..., target_component: ...}
```

3. 冻结**结果表骨架**（数字留空）：

```markdown
| Variant | Dataset A (valid) | Dataset B (valid) | Δ vs baseline | outcome |
|---|---|---|---|---|
| baseline |  |  | — | — |
| hyp_...  |  |  |  |  |
```

4. 明确每个 claim 需要的证据：`claim → experiment(s) → metric` 映射写进 plan，并
   标明对应 rubric 条目。
5. 文献基线：若 baselines.yaml 有外部 paper baseline，写进 plan 并在实验侧只做可比设定。
6. 写 `EXPERIMENT_PLAN.md`（含上面的 YAML + 表骨架 + evidence map）。

## 规则

- plan 一旦冻结，实验阶段不得改 datasets/splits/metric/baseline 定义；缺资源时**留空数值**，不许换更省事的评测。
- 实验阶段不得回改已冻结 rubric；只能为未来 cycle 提交新计划。
- 消融：每个被论文主张的组件必须有至少一行 remove/replace 消融计划。
- test 只在 VALIDATE 对最终 SOTA 暴露一次。

## Gate

- 所有 `queued()` 候选都有设计条目且覆盖 `candidate_id` 和适用 rubric 条目；缺一个
  → FAIL 回修。

## 产出

- `<run_dir>/EXPERIMENT_PLAN.md`
