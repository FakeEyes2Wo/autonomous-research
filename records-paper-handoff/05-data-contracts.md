# 05 — 程序化数据契约

实现：`packages/autoresearch/scripts/records-paper-trace.mjs`（`extract` / `verify`，纯确定性）。

## CLI
```bash
extract --adapter <adapter> --source-root <root> [--work-dir .] [--baselines baselines.yaml] [--run-id <id>] [--force|--resume]
verify  --evidence <run>/evidence_chain.json --paper <run>/paper --exclusions <run>/trace_exclusions.md [--candidate-json candidate.json] --out <run>/trace_audit.json
```

## evidence_chain.json（evidence-chain/v1）

顶层：`schema, run_id, adapter, result_integrity_mode="data-aware", sota_experiment_id, task{title,target,primary_metric,direction,domain}, baselines[], experiments[], future[], provenance{adapter,files{sha256}}`。

`experiments[]` 行：
```jsonc
{ "experiment_id": "exp_x", "candidate_id": "cand-x", "hypothesis_id": "hyp_x",
  "label": "...", "statement": "...", "intervention": "...",
  "status": "SUCCEEDED", "outcome": "SUPPORTED", "parent_id": "...",
  "metrics": { "primary": {"value": 84.7, "direction": "maximize"}, "<name>": {...} },
  "deltas": {"vs_baseline": 6.0, "vs_parent": 2.0},
  "evidence_refs": {"report": "sha256:...", "evidence": "sha256:..."},
  "error": null, "source": {"type": "adapter", "file": "...", "json_pointer": "..."} }
```
规则：`candidate_id` 由 Source Adapter 从 HypothesisPool.origin_candidate_id 映射，无则 null；`deltas` 不可比→null；`future[]` 不参与覆盖检查。

## 标签与 trace_audit.json

```latex
% evidence: E-exp_x     % experiment
% evidence: B-base_x    % baseline（与数字同行或 ±1 行）
```
```jsonc
{ "verdict": "PASS|WARN|FAIL", "evidence_hash": "sha256:...",
  "per_experiment": [{"experiment_id", "tagged_in", "value_match": "exact|approx|not_found|null", "excluded", "ok"}],
  "uncovered": [], "unknown_tags": [], "stale": false }
```

## verify 规则
1 未知 E:/B: 标签→FAIL；2 SUPPORTED/REFUTED/INCONCLUSIVE/FAILED/SUCCEEDED 未覆盖且未排除→FAIL；3 exclusions 无效→FAIL；4 tag ±1 行数值不匹配→WARN；5 provenance 源哈希变化→FAIL；6 evidence 缺失→FAIL；7 candidate_id 非 null 且不在 candidate.json→FAIL（无 `--candidate-json` 则跳过）。

## 确定性
同输入同 verdict；生成后由 provenance 哈希冻结。单测覆盖：10 行 fixture、SOTA/baseline、RUNNING、外部 baseline、幂等、标签/覆盖/数值/stale、candidate 链校验。
