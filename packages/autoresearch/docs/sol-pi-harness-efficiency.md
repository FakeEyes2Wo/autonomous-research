# SoL-Pi Harness 效率机制适配

本文记录本项目对 SoL-Pi 四类效率机制的边界适配。论文为 *SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness*，arXiv:2609.20519v1；机制讨论见 [§2.4–2.5](https://arxiv.org/html/2609.20519v1)。论文所述动作融合意在消除中间模型往返，原文短引仅保留：“eliminating an intermediate model round trip.”

| 论文机制 | 章节 | 本项目适配 | 明确边界 |
| --- | --- | --- | --- |
| ActionFusion | §2.4 | `research_action_finish` 可在同一次工具调用中完成动作并追加已校验 evidence，兼容旧参数。 | 只合并本地动作写入与证据写入；不改 DSH history，也不宣称减少真实模型往返。 |
| OnlineCompact | §2.4 | provider 在角色输入边界使用 UTF-8 token 预算和无损重复字段引用，保留所有字段标签。 | 不重写 provider/DSH history；不实施论文所述 replay 后 history/cache rewrite。 |
| ObservationPack | §2.5 | `research_tree_query` 显式 opt-in 后，对超过默认阈值的只读 JSON 建立本地 handle，并由精确分页工具回取。 | 这是本地归档适配，不实现论文中的“两次传输后稳定 handle”延迟策略；小结果保持原样。 |
| EvidenceReducer | §2.5 | 对同一次归档输出生成确定性 verified receipt，校验引用、hash、字节数和可信退出 metadata。 | 不调用 small model 生成摘要；receipt 只证明字节/引用一致，科学状态始终 `unverified`，失败回退原文。 |

## 动作融合

`research_action_finish` 保持旧的完成参数，并接受可选的 `evidence` 数组。工具先完整校验状态、摘要、证据 verdict、内容和产物路径，然后更新动作、追加证据，最后只执行一次 `ResearchTree.save()`。校验失败不会写入半成品。该机制对应论文 §2.4 的动作边界思想；本项目没有改写 DSH history，也没有把融合调用宣称为真实 API 节省。

## 上下文预算与冗余表示

provider 的 prompt 预算现在复用 `policy/context.ts` 的 UTF-8 感知 `estimateTokens`，中文和其他非 ASCII 文本不再使用字符串长度除四的近似。角色边界对完全相同的可重复文本使用引用标记，同时保留每个输入字段标签，因此 required 科学输入、协议、来源、反证、冲突闭包和失败信号仍然逐项可见。DSH 的 history、stream hook 和 accounting 均保持只读。

## ObservationPack

`research_tree_query` 只有在显式传入 `packObservation: true` 时才归档大型只读 JSON 结果。默认阈值为 10 KiB；小结果原样返回。归档文件名绑定 SHA-256，metadata 记录字节数和明确传入的 task/direction owner；系统不会从自由文本猜归属。handle 只允许标准 observation-pack 路径，读取时检查真实路径、UTF-8 边界、文件名 hash、metadata 中的 `contentHash`、字节数及 schema。分页在很小的 byte limit 下也会推进到完整 UTF-8 字符。归档、路径或 metadata 失败均回退到原文结果。`research_observation_read` 用 handle 和页参数精确回取。

## 证据保留

`research_verified_receipt` 读取同一次归档的完整字节并检查原文引用、源 hash、字节数和归档保存的退出状态；缺少可信退出 metadata 时状态为 `unknown`。receipt 的 `scientificStatus` 固定为 `unverified`，表示字节与引用一致而不是科学结论成立。若确定性 receipt 序列化后不小于原文，则返回带原文的 fallback。文件读取和搜索没有交给模型摘要器。

## 可复现实验记录

以下是确定性 fixture 与定向 Node 用例的工程证据，不是对真实服务 API 节省的估计。

- 基线：2026-09-19 `npm test` exit 0，537 tests，pass 537，fail/cancelled/skipped 0，duration `304938.3642ms`，含 3 分钟 Windows 恢复 soak。
- 定向覆盖：动作融合兼容与失败无写入、ObservationPack 的 UTF-8 精确分页/路径逃逸/归档失败回退/hash 篡改、owner 归并、receipt 的精确 quote/hash/size fallback、工具注册与实际查询 pack 路径。
- 可复现效率记录：在 `packages/autoresearch` 执行 `npm run benchmark:harness`。脚本使用超过默认 10 KiB 阈值的真实 tree fixture，不覆盖阈值或 excerpt 配置，并通过真实 tool `execute` 和 `output.render` 比较完整查询响应、pack response 加一次精确 page 的完整渲染字节、融合前后工具调用数/渲染字节、receipt 渲染字节与 size gate，以及重复字段的 `estimateTokens` 与标签保留；融合数字指工具调用次数，不等同 LLM round trip。输出中的 `fixtureOnly: true` 明确这些是本地确定性 fixture 数值。
- 未提交保护文件 hash：`phases.ts=327BDD66F60161AB2D14E79EFA62621F1097E55958A0E06D95C82FE6740FD637`，`pipeline.ts=0C4BFEA04B575ADE7D89A6AC17A750BCDCA3D0C57FEB2EE628FC37C3B9C48B3E`，`paper-phases.test.ts=39238B14923C0E79BA7573451CB7D3F9C56F352678FF49005279C7DE7A9FEEC4`。

一次默认配置的本地记录为：完整查询渲染 12716 bytes，pack 响应 2470 bytes，加一次精确分页读取共 3289 bytes；融合工具调用数为 2→1，但渲染输出为 262→340 bytes，说明融合的工具调用收益可能伴随输出封装成本；receipt 渲染为 852 bytes 且科学状态仍为 `unverified`；重复上下文估算为 503→273 tokens。上述数值只描述确定性 fixture。
