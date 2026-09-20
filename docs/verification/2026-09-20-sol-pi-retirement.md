# SoL-Pi Efficiency and Direction Retirement Verification

状态：定向验证、确定性效率 fixture 与 root 全量验证均已完成并通过。

## 论文依据与章节映射

依据论文 [SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness](https://arxiv.org/html/2609.20519v1)（arXiv:2609.20519v1）。论文四项机制与本地适配的对应关系如下：

| 论文机制 | 论文位置 | 本项目适配 |
| --- | --- | --- |
| ActionFusion | §2.4 | `research_action_finish` 可把完成动作和 evidence 记录合并为一次本地工具调用及一次 tree save，并保留旧调用兼容。 |
| OnlineCompact | §2.4 | 只在角色输入边界做 UTF-8/token 预算与无损重复字段表示；保留原文、来源、协议、反证、冲突与失败信号，不改写 DSH history 或 provider replay/cache。 |
| ObservationPack | §2.5 | `research_tree_query` 显式 opt-in 后归档大型只读 JSON，返回 handle 与摘录；精确 UTF-8 分页读取工具按 handle 回取原文。它不是论文所述的两轮传输后稳定 handle 延迟策略。 |
| EvidenceReducer | §2.5 | 本地确定性 receipt 校验同一次归档的引用、content hash、字节数、schema 与可信状态元数据；不调用 small model 生成摘要，也不把科学结论标为 validated。 |

清理与方向退休是本项目的扩展，来源对应论文的 harness 效率边界与搜索生命周期，而不是论文另一个机制：

| 论文位置 | 本地扩展 | 具体边界 |
| --- | --- | --- |
| §2.1 Harness Auto-Research for Token Efficiency | 冻结的方向身份、manifest 与 generation boundary | 以 claim/hypothesis/protocol 的冻结谱系确定方向边界，并记录可核验的生成归属。 |
| §2.2 Broad-to-Deep Harness Search | direction-scoped receipt、不可变 manifest、cleanup queue 与 tombstone | 对可安全删除的专属产物执行可续跑清理；跨方向引用、用户已有内容、共享或未知归属保留。 |

上述清理扩展服务于本项目的生命周期安全，不能据此宣称论文已经实现了同样的清理机制或真实模型节省。

## 已验证基线与确定性 fixture

- 基线：2026-09-19 `npm test` exit 0，537 tests，pass 537，fail/cancelled/skipped 0，duration `304938.3642ms`，包含 3 分钟 Windows 恢复 soak。
- 最终全量：`npm test` exit 0，592 tests，pass 592，fail/cancelled/skipped/todo 0，duration `391360.003ms`；包含 3 分钟 Windows recovery `180153.5164ms`。
- `node scripts/benchmark-harness-efficiency.mjs` exit 0：完整查询渲染 `12716` bytes；pack 响应 `2470` bytes；加一次精确 page recall 的总量 `3289` bytes。
- ActionFusion fixture：工具调用 `2→1`；完整渲染输出 `262→340` bytes。该数字只表示工具调用数和封装输出，不等同整任务 LLM round trip 数。
- Context fixture：估算 tokens `503→273`，`labelsPreserved` 为 true；收益 gate 会在替换表示不更省时保留原文。
- Receipt fixture：最终渲染 `852` bytes；字节、引用与归档内容 `verified`，科学状态 `unverified`。
- 以上均为本地确定性 fixture，不能外推真实 LLM/API token 节省、模型性能或美元成本。

## 本轮验证状态

- `npm run typecheck`：exit 0（最新 store 变更后重跑）。
- `npm test` 内部 build：已通过；最终全量结果为 exit 0、592/592 通过，fail/cancelled/skipped/todo 均为 0。
- `node scripts/benchmark-harness-efficiency.mjs`：exit 0，数值见上。
- `git diff --check`：exit 0；仅有 CRLF warning。
- Windows runtime-soak、测试夹具的项目身份/logger 修复及 controller 断开时的 `EPIPE` 消息匹配均已覆盖；actual kill、exit 1、未解决任务归零、预算归零和 unhandled error 禁止等安全断言未减弱。
- 本轮源码改动由 subagents 完成，root 进程负责协调、审查与验证。

原有五个 dirty 文件本轮未修改，其 SHA-256 保持不变：

| 文件 | SHA-256 |
| --- | --- |
| `packages/autoresearch/src/paper/phases.ts` | `327BDD66F60161AB2D14E79EFA62621F1097E55958A0E06D95C82FE6740FD637` |
| `packages/autoresearch/src/paper/pipeline.ts` | `0C4BFEA04B575ADE7D89A6AC17A750BCDCA3D0C57FEB2EE628FC37C3B9C48B3E` |
| `packages/autoresearch/test/unit/paper-phases.test.ts` | `39238B14923C0E79BA7573451CB7D3F9C56F352678FF49005279C7DE7A9FEEC4` |
| `docs/verification/2026-09-16-paper-aris-taint-analysis.baseline.txt` | `30E228CC51750C5674878CA6B4106604A958C5E04D0CA966BBDAFAE66FE370BE` |
| `docs/verification/2026-09-16-paper-aris-taint-analysis.md` | `1A3D22AF7450C32B8F14B3DEC1D424A3D1533A79923FCFC719F3FE029D648BC9` |

## 当前能力与保护边界

归档与清理会核对精确路径、真实路径、symlink/junction、文件名 hash、metadata 中的 `contentHash`、字节数和 schema，并依据 boundary inventory 区分 direction、shared、unknown 与 user-existing。未能证明独占归属的内容不会因为 worker 或模型返回了一个路径就变成可删除产物；捕获的 research source 由可信 receipt 登记，source tombstone、lineage 和 cleanup queue 支持任务断点续跑。

已退休方向重新 resume 时会跳过 research view 重建，避免读取已清理的 raw source，同时继续推进 cleanup 队列。这里的“可恢复”仅指任务断点、队列状态和边界登记可续跑，不保留已删除的代码或实验备份。

新方向可以携带 parent 中完全相同的旧 assessment/evidence 作为历史来历；这类历史证据不会绕过新 formal 准入，已 tombstone 的 source 仍不可作为新 formal 输入。

## 已知限制

- 尚未测量真实 LLM/API 的节省，也没有真实 API 成本或模型性能数据；fixture 只证明本地调用、渲染和 token 估算的可复现差异。
- receipt 只能证明字节、引用、hash、schema 和可信状态元数据一致，不能验证科学结论；没有可信 exit metadata 时状态为 unknown/不适用。
- 无法证明归属的路径按 unknown/shared/user 保护；真实 shared/success/active/live 引用会阻止清理。
- 精确 `mechanismKey` 与结构化 idea 去重不能覆盖全部语义等价关系。
- 结构化最小 lineage、tombstone 与完整性校验仍保留；它们不是科学结论验证器。
