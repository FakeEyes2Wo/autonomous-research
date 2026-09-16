# 01 — INTAKE & EVIDENCE

任意来源记录 → `evidence_chain.json`（Data-Aware）。adapter 即 source provider；当前实现 `athena`，未来 wandb/csv/mlflow。

```bash
records-paper-trace.mjs extract --adapter <adapter> --source-root <root> \
  [--work-dir .] [--baselines baselines.yaml] [--run-id <id>] [--force|--resume]
```

## Adapter 必须产出
- `task`：来源任务元数据；`primary_metric="primary"`；`direction` 原样。
- `sota_experiment_id`：SUCCEEDED 实验中按 direction 取 primary 最优。
- `baselines[]`：内部 baseline 自动识别；外部来自 `baselines.yaml`。
- `experiments[]`：每实验一行；`outcome` 按来源状态翻译；`metrics/deltas/evidence_refs` 只收现成字段。
- `candidate_id`：读 HypothesisPool 的 `origin_candidate_id` 映射，无则 null。
- `future[]`：PROPOSED 无实验 + RUNNING。

## 幂等 / digest
输出存在：`--force` 覆盖；`--resume` 且源哈希未变跳过。脚本生成 `record_digest.skeleton.md`（全部数字）；agent 只填解释不改数字。

产出：`evidence_chain.json` + `record_digest.skeleton.md` / `record_digest.md`。
