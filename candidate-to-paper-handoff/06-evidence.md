# 06 — EVIDENCE

目标：把 experiment 阶段的产物归一为本轮 `evidence_chain.json`，并在研究结束时
合并成下游唯一消费的 `final-evidence-chain.json`。执行细节复用
`records-paper-handoff/01`。

## 输入

- 默认 Provider（当前 Athena）：其实验产物 + 可选 HypothesisPool
- external：用户提供的 `evidence_chain.json`

## 步骤

1. 默认 / none 引擎：用当前 Domain Profile 的 Source Adapter 跑 `extract`，输出 `<run>/records-paper/<run_id>/evidence_chain.json`。
2. external 引擎：直接确认用户提供的 evidence_chain schema 合法，不重新抽取。
3. `candidate_id` 注入：Source Adapter 读 HypothesisPool 的 `origin_candidate_id` 映射填 `experiments[].candidate_id`；无映射置 null。
4. 生成 `record_digest.skeleton.md`；agent 补 `record_digest.md`（不改数字）。
5. 将本轮 evidence 保存到 `research/cycle-N/`；继续研究时不得覆盖旧轮次。
6. 返回 AutoResearch Supervisor，根据冻结 rubric、累计 evidence 和剩余预算决定
   继续、转向、请求用户或结束。
7. 只有决定结束研究后，才把所有 cycle 的成功、失败和阴性结果确定性合并为
   `research/final-evidence-chain.json`，并复制为 records-to-paper 约定的
   `records-paper/<run_id>/evidence_chain.json` 后进入 07。

## Gate

- extract exit 0；`result_integrity_mode == "data-aware"`。
- external：evidence_chain 可解析且含 `provenance.files`。

## 产出

- `research/cycle-N/evidence_chain.json`
- 研究结束时：`research/final-evidence-chain.json`
- 下游兼容入口：`records-paper/<run_id>/evidence_chain.json`
- `records-paper/<run_id>/record_digest.md`
