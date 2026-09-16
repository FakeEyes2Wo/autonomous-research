# RAG 检索索引与长期记忆一致性审查（2026-09-16）

范围：GraphRAG、HippoRAG/HippoRAG 2、RAPTOR、LightRAG 及 2026 年的版本感知/增量检索工作；重点讨论重解析、重嵌入、摘要失效、长任务 resume 的固定 index generation、多租户边界和图关系证据追溯。本报告只写设计审查，不修改运行代码或 TODO。总体入口见 [rag-design.md](rag-design.md)；本文把其中的 **R0 关键词检索基线**作为首版基准，hybrid（关键词 + dense）属于后续可选、需单独评测的增强路线。

## 结论摘要

1. **索引是派生物，source record 才是事实源。** 向量、实体、边、社区报告和树摘要都必须带输入内容 hash、解析/切块/embedding 指纹和 index generation；相似度命中只是候选，不能直接当作证据。
2. **首版不应默认上全局图。** 先做 [rag-design.md](rag-design.md) 定义的 R0 关键词检索（目录与已入库原文片段），带 tenant/scope/version 过滤并保留原始 chunk 与 locator；hybrid（关键词 + dense）作为后续可选对照路线。用可冻结的 generation manifest 支持 resume、回放和审计；只有出现可复现的跨文档、多跳或全局主题失败，才按查询类型增加局部图、事件连接或层级摘要。
3. **更新采用新 generation + 原子发布。** source 变化先生成新的 revision 和候选 generation；固定旧版本的 run 不因新 revision 自动失效，只有显式更新 generation 才切换。新 generation 内受影响的 chunk、embedding、实体/关系、summary 和缓存做依赖闭包失效，再在 staging 中重建；撤稿或权限撤销则产生独立的访问/失效事件，不能绕过授权继续读旧内容。
4. **“增量”不等于“只追加”。** 新增文档通常可局部追加；文档内容、解析器、切块规则、embedding 模型或实体规范化变化会扩大失效范围。RAPTOR/GraphRAG 的上层摘要和社区结构尤其需要重新验证，不能因为叶子向量已更新就继续使用旧摘要。

## 证据规则与原文状态

下列论文均核对 arXiv 页面日期和版本；GraphRAG、HippoRAG、HippoRAG 2、RAPTOR、LightRAG、动态 RAPTOR、KAIR、VersionRAG、SAG 的 HTML/正文已阅读。表中“论文结果”只复述原文实验；“对本项目的推断”是设计判断。摘要里的“支持增量”不能扩大解释为跨进程事务、删除传播或证据正确性证明。

### 1. GraphRAG

**From Local to Global: A Graph RAG Approach to Query-Focused Summarization**，Edge et al.，arXiv [2404.16130](https://arxiv.org/abs/2404.16130)，HTML [v2](https://arxiv.org/html/2404.16130v2)，提交 2024-04-24，当前正文 v2 标注 2025-02-19。论文把文本切成 TextUnits，LLM 抽取实体、关系和 claims，以 Leiden 构造层级社区，再为社区生成自底向上的报告；查询时并行生成 community answers，再 reduce 成 global answer。正文明确指出实体/关系是抽象提取，重复实例会聚合，分析中实体匹配使用 exact string；chunk 越大调用越少但可能降低早段信息召回。约百万 token 的两个语料上，作者以 LLM judge 比较 global sensemaking，报告 GraphRAG 在 comprehensiveness/diversity 上优于 vector RAG。局限是评测只覆盖两个语料和无 gold answer 的全局问题，作者自己要求进一步研究跨领域泛化与 fabrication；社区摘要也不是原文证据。对本项目的推断：图适合“全局主题/关系网络”查询，原始 TextUnit 必须保留为 citation leaf；任何 entity/edge/community report 都需携带其 text-unit 依赖，依赖变化时沿图和摘要闭包失效。官方 [CLI](https://microsoft.github.io/graphrag/cli/) 有 `update`/`standard-update`，输出 schema 用 `period`/`size` 支持 incremental merge，但文档没有给出本项目所需的跨服务提交或通用删除保证。

### 2. HippoRAG 与 HippoRAG 2

**HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models**，Gutiérrez et al.，arXiv [2405.14831](https://arxiv.org/abs/2405.14831)，HTML [v3](https://arxiv.org/html/2405.14831v3)，提交 2024-05-23，v3 2025-01-14。HippoRAG 用 LLM OpenIE 建 open KG，将 phrase/passage 节点连接起来，再用 Personalized PageRank 一步做多跳 passage retrieval。论文报告多跳 QA 最高约 20% 改善，单步 retrieval 相比 IRCoT 约低 10–20 倍成本、快 6–13 倍；但正文误差分析的 100 个 MuSiQue 错例中，48% 是 NER、28% OpenIE、24% PPR，作者还明确说规模扩大后的效率和效果尚未验证。**From RAG to Memory: Non-Parametric Continual Learning for Large Language Models（HippoRAG 2）**，arXiv [2502.14802](https://arxiv.org/abs/2502.14802)，HTML [v2](https://arxiv.org/html/2502.14802v2)，提交 2025-02-20，v2 2025-06-19。HippoRAG 2 将 query-to-triple、passage integration、LLM recognition filtering 和 PPR 合并，论文在 factual/sense-making/associative 三类任务报告相对强 embedding baseline 平均约 7 个百分点的 associative 改善；同时指出旧结构方法会在非目标任务退化，且关联任务随 corpus 扩张仍会下降。对本项目的推断：PPR 是关系扩散排序器，不是关系真实性证明；实体/三元组抽取必须保留 source span、抽取模型和版本，关系冲突要回到原文核对。若采用，只作为查询时的局部候选扩展，不能让旧图 generation 污染新的 resume。

### 3. RAPTOR 与动态 RAPTOR（adRAP/postQFRAP）

**RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval**，Sarthi et al.，arXiv [2401.18059](https://arxiv.org/abs/2401.18059)，HTML [全文](https://arxiv.org/html/2401.18059)，提交 2024-01-31 v1。RAPTOR 对 chunk 递归 embedding、聚类、摘要，形成多层树；查询可 tree traversal 或 collapsed-tree 检索。作者报告 GPT-4 + RAPTOR 在 QuALITY 上达到 82.6%，相对当时基线有大幅提升；正文的注释研究发现约 4% 摘要含轻微 hallucination，未观察到对该 QA 结果的明显影响。构建 token/time 对文档长度近似线性，意味着频繁变更会重复付费。**Recursive Abstractive Processing for Retrieval in Dynamic Datasets**，Chucri et al.，arXiv [2410.01736](https://arxiv.org/abs/2410.01736)，HTML [全文](https://arxiv.org/html/2410.01736)，提交 2024-10-02 v1。adRAP 用在线 GMM/局部聚类把新增文档放入树，并对变化节点及祖先重做摘要；删除可移除 chunk 后重算祖先，但作者说明频繁删除需要权衡保持 cluster 或局部重算，大量新增仍可能需要全树重建。postQFRAP 把 query-focused recursive summarization 放到已有动态 retriever 后面，减轻索引维护，却增加推理时摘要调用，且作者承认摘要会使原始来源更难追溯。对本项目的推断：摘要节点必须是带覆盖范围、输入 hash 和 verifier verdict 的 cache；源变化要使覆盖它的摘要及祖先失效。首版可只存原文 chunk，后续仅在有全局/长文档指标时启用局部 tree，并强制回答引用 leaf。

### 4. LightRAG

**LightRAG: Simple and Fast Retrieval-Augmented Generation**，Guo et al.，arXiv [2410.05779](https://arxiv.org/abs/2410.05779)，HTML [v3](https://arxiv.org/html/2410.05779v3)，提交 2024-10-08，v3 2025-04-28。LightRAG 用 LLM 从文本构造实体/关系图，结合 low-level/high-level keyword 的双层查询，将图结构和向量检索结果共同送入生成器。论文的增量算法对新文档重复抽取并把新节点/边与旧集合取 union，声称避免整库重建；其 Legal 实验中将 GraphRAG 的大量社区报告调用与较小的 keyword/retrieval 开销作对比。正文也明确是四个语料、特定模型和设置下的实验。关键边界是：union 适合追加，但论文没有证明内容修改、实体合并、边冲突、摘要失效、删除 tombstone、跨 generation resume 的一致性；“历史数据仍可访问”也不等于旧关系仍然有效。对本项目的推断：可借鉴 dual-level routing 和轻量局部图，但每条边必须保留产生它的 chunk ids、span、extraction fingerprint 和 source revision，删除/修订只能产生新 generation 并标记旧边 retired。

### 5. 2026 年相关材料

**Finding What Matters: Anchoring Context Knowledge with Evolving Indices for Iterative Retrieval（KAIR）**，Wu et al.，arXiv [2601.16462](https://arxiv.org/abs/2601.16462)，HTML [v2](https://arxiv.org/html/2601.16462v2)，2026-01-23 提交、2026-05-31 修订。KAIR 的“evolving index”是在一次迭代检索上下文中由 LLM 按 step 加入关键词/RDF 关系，用来判断知识是否足够并生成下一查询；四个多跳 QA 数据集上，作者报告相对若干 baseline 的提升。它是 query-local 的 in-context anchoring index，不是跨任务持久的 corpus index；实验使用最多四步、固定 top-5 文档，图结构方法在其表中并不自动优于 vanilla RAG。对本项目的推断：可把它借鉴成一次 run 内的 query scratchpad，必须随 call/step 持久化并随 resume 固定，不应写入跨 run 的 canonical memory。

**VersionRAG（2025 对照材料）: Version-Aware Retrieval-Augmented Generation for Evolving Documents**，Huwiler et al.，arXiv [2510.08109](https://arxiv.org/abs/2510.08109)，HTML [全文](https://arxiv.org/html/2510.08109)，2025-10-09。它把 document/version/content/change 作为显式层级图，按 content、version、change 三类意图路由；100 个手工问题、34 个技术文档上，作者报告 DeepSeek-R1 70B 的 90% 总准确率（naive RAG 58%、GraphRAG 64%）及 97% 更少的 indexing tokens。限制是数据集中在 Node.js/Spark/Bootstrap，隐式变化检测仍为 60%，文档需能稳定抽出版本信息；结果由 GPT-4.1 judge 并人工复核。对本项目的推断：它最直接支持 `source revision`、validity interval 和 change node，而不是把新旧版本混成一个 embedding 命中。

**SAG: SQL-Retrieval Augmented Generation with Query-Time Dynamic Hyperedges**，Wu et al.，arXiv [2608.12129](https://arxiv.org/abs/2608.12129)。页面显示 v1 于 2026-08-12 提交、v2 于 2026-08-24 撤稿，当前标为 *withdrawn*；因此其 2026 结果不能作为稳定证据或采纳承诺。撤稿前的正文主张用 append-only event-entity 表和 query-time SQL join 表示 n-ary 事件，不建全局图，每个证据仍回到原始 chunk；这一思路说明“查询时局部结构”可能比维护全局图更简单，但仅可作为待复核设计线索。

## 一致性模型：source、derived index 与 generation

### 1. 必要记录

首版和高级版都共享以下最小契约：

| 对象 | 必要字段 | 作用 |
|---|---|---|
| `SourceRevision` | `tenantId`, `projectId`, `documentId`, `revisionId`, `contentHash`, `locator`, `sourceTimestamp`, `validFrom/validTo`, ACL/scope | 事实来源和版本选择；版本选择与 ACL 判定分开；删除也写 tombstone，不直接丢历史 |
| `ChunkRecord` | `chunkId`, `revisionId`, `textHash`, `span/start-end`, chunker fingerprint, parent document | 原始证据叶；切块规则变化会改变依赖 |
| `DerivedRecord` | type（embedding/entity/edge/summary）, `inputIds`, input hash, model/parser/prompt fingerprint, status, error | 任何派生物都可追溯、可重建、可失效 |
| `IndexGeneration` | `generationId`, parent generation, source manifest hash, builder version, embedding fingerprint, graph/tree schema, ACL policy, status, createdAt | 查询和 resume 的固定快照；只发布 `ready` generation |
| `RetrievalManifest` | query hash, `generationId`, selected ids, excluded ids, scores, filters, evidence links, rendered hash | 复现一次上下文；分数用于排序，不是事实置信度 |

`generationId` 是长任务的关键：开始一个 cycle/attempt 时记录它，resume 默认继续使用同一 generation。Source 出现新 revision 只表示有可选的新版本，不会自动使固定旧版本 run 失效；只有显式更新/迁移时才新建 retrieval attempt 并选择新 generation，不能静默切到“当前最新”索引。撤稿或 ACL/权限撤销是独立的强制访问事件，可能阻断旧 generation；版本选择和授权判定必须分别记录。历史报告保留回答当时的 generation 和 source revision，若证据已不再获准访问则保留失效凭据/访问事件而不绕过撤销。

### 2. 变更和失效闭包

按以下规则做重解析/重嵌入和摘要失效：

1. **内容 hash 与所有依赖 fingerprint 都未变**：只有在 parser、chunker、tokenizer、embedding model/dimension/metric、实体/关系 schema、摘要 prompt/model 等相关 fingerprint 均未变时，才不重解析、不重嵌入并复用相同 `ChunkRecord`/derived records；任何 fingerprint 缺失都按保守策略重建。
2. **内容 hash 变、parser/chunker 未变**：在显式构建的新 generation 中只重解析该 document revision；对删除的旧 chunk 写 tombstone，对新增/修改 chunk 重建 embedding、实体和关系；沿 `inputIds` 反向索引使 summary/community/tree/cache 进入 `stale`。
3. **parser/chunker fingerprint 变**：该 document 全部重新切块；旧 chunk 不原地更新，生成新的 chunk ids；所有依赖旧 chunk 的图/树节点失效。
4. **embedding model/dimension/metric 变**：不在同一 generation 混用向量；新建相应 embedding family 或 generation，完成 backfill 后再发布。
5. **实体规范化、关系 schema、摘要 prompt/model 变**：至少重建受影响的 entity/edge/summary 层；如果无法准确计算影响闭包，按整库 graph/tree generation 重建。
6. **删除/撤销**：source revision 写 `tombstoned`，新 generation 的 retrieval filter 排除它；derived records 标记 retired。原文和 locator 的保留受 ACL、撤稿/删除要求和项目 retention policy 约束，必要时只保留 content hash、失效凭据和访问事件，不能为了恢复而绕过撤销授权；物理回收延迟到策略允许且没有获准的活动 generation/审计引用后。删除不能抹掉历史回答的 provenance，但也不保证历史原文仍可被重新读取。

构建顺序是 `source manifest → chunks → embeddings/lexical → optional graph/tree → validation → ready marker → atomic CURRENT_INDEX`。任何中间崩溃只留下 staging generation；`CURRENT_INDEX` 只指向完整、校验通过的 generation。若采用本地文件，generation manifest 和 marker 要原子替换；跨服务器需要一致存储或专用索引服务，不能把单机文件 rename 当作分布式提交。

## 首版路线与高级路线取舍

### 首版（P0，建议先做）

- source manifest + content-addressed chunks；记录 `contentHash`, `revisionId`, `tenant/scope`, `validFrom/validTo`。
- R0 关键词检索（目录/已入库原文片段），先 metadata/ACL 过滤，再按用途和版本选择排序；同一个 logical chunk 使用稳定 id，更新使用新 revision。hybrid（关键词 + dense）保留为后续可选路线，必须与 R0 在相同预算下 paired evaluation 后再启用。
- embedding generation 与模型 fingerprint 固定；保存 query 的 `generationId`，resume 不能跨代漂移。
- raw chunk 是唯一可直接引用的 evidence；返回 chunk id、document locator、span 和 source hash。向量 score 只表示候选排序。
- append/update/delete 采用 outbox 或 job 状态机：`queued → parsing → embedding → validating → ready/failed`；失败不会让旧 generation 半更新。
- 定期全量 rebuild 作为一致性基线；先测 freshness、stale-hit、citation support 和成本，再决定是否增加图。

首版适合当前记录级 memory/context：memory record 可保存 retrieval manifest hash 和 source revision，context contract 固定 generation；运行恢复先验证 generation manifest，失配则产生 `INDEX_STALE` 并重新 assemble。它的缺点是跨文档关系由 query-time 多轮检索承担，可能漏掉全局主题和长链证据，但故障面小、易删除、易重建。hybrid 只作为之后的可选增量，不能改变 R0 的首版验收基线。

### 高级路线（P1/P2，按失败模式启用）

| 组件 | 何时值得用 | 一致性和证据要求 | 代价/风险 |
|---|---|---|---|
| 局部实体/关系图（HippoRAG/LightRAG 风格） | 多跳问题持续漏中间 passage，且 edge recall 有独立评测 | edge → source span/chunk/revision；PPR/图遍历只扩展候选，最终仍回 raw chunk | OpenIE/NER/实体合并错误；图维护和冲突处理 |
| 层级摘要树（RAPTOR/adRAP 风格） | 全局主题或长文档综合明显优于 chunk top-k | summary 覆盖范围、输入 hash、摘要 model/prompt、verifier verdict；叶子永不删除 | 更新可能向祖先扩散；摘要 hallucination 和来源追溯成本 |
| community reports（GraphRAG 风格） | 同一语料有大量 global sensemaking 查询 | community/relationship/text-unit 依赖闭包；报告失效不能继续服务新 generation | LLM indexing 成本高；LLM judge 结果不能证明事实准确 |
| query-local anchor/event join（KAIR/SAG 线索） | 只需当前 query 的多跳结构，避免全局图维护 | scratch index 绑定 query/call/generation；事件回原文；SAG 当前 arXiv 已撤稿 | 每次查询有额外推理或 SQL 负载；不可当持久 memory |

选择逻辑应是 query router：事实单跳先走 R0 关键词基线（hybrid 可作为后续可选分支）；带明确版本/时间走 revision filter；多跳走局部扩展；全局主题才走社区/层级摘要。每个复杂路由都保留 R0 对照，做 paired evaluation。图的节点数、边数或 embedding hit rate 不是采用理由；必须证明 raw evidence recall、答案正确性、成本和失效恢复改善。

## 图关系的证据追溯

把图当作导航结构而不是事实数据库：

1. 一个 `EdgeRecord` 至少保存 `subjectId/objectId/relation`, `sourceChunkIds`, `sourceSpans`, `sourceRevisionIds`, extraction fingerprint、created generation 和 lifecycle。
2. 关系若来自多个 chunk，保存每个支持和反驳 span；不能只保存合并后的 description 或 edge weight。PPR/Leiden 权重是排序信号，不是支持强度。
3. entity merge、synonym、normalization 是可撤销 derived decision；出现冲突时保留原实体/边并标 `disputed`，由查询或 verifier 选择，不删除原始提取。
4. summary/community/tree 节点必须列出覆盖 leaf ids、被排除的 leaf ids、生成器 fingerprint 和验证结果。回答使用 summary 时，必须为**每个事实主张**展开足够的 raw spans/chunks 以覆盖其语义；只展开一个 leaf 不足以支持含多个主张的摘要。无法达到覆盖要求则返回“索引摘要候选”，不能当作已证实结论。
5. source revision/tombstone 改变后，旧 edge 不应悄悄指向新文本；新 edge 使用新 revision id。历史 answer 的 evidence manifest 固定旧 generation，便于审计“当时为什么命中”；若旧证据已因撤稿/权限事件不可访问，只保留策略允许的 hash/失效凭据，不绕过访问撤销。

## 多租户与官方工程资料

- Microsoft GraphRAG 官方 [index overview](https://microsoft.github.io/graphrag/index/overview/)、[CLI](https://microsoft.github.io/graphrag/cli/) 和 [outputs](https://microsoft.github.io/graphrag/index/outputs/) 展示了 TextUnit→entity/relationship→community/report 的依赖；`update`/`standard-update` 与 community 的 `period`/`size` 支持更新合并，但没有把其本地输出目录提升为分布式事务。
- Pinecone 官方 [multitenancy](https://docs.pinecone.io/guides/index-data/implement-multitenancy) 建议每 tenant 一个 namespace：upsert/query/update/delete 都显式指定 namespace，删除 namespace 是不可逆的；其 [data modeling](https://docs.pinecone.io/guides/index-data/data-modeling) 还警告 upsert/update/delete 后读取可能暂时看不到最新版本（eventual consistency）。本项目若采用类似后端，generation 发布不能只依赖“写成功”，要等待索引可见性确认。
- Qdrant 官方 [multitenancy](https://qdrant.tech/documentation/manage-data/multitenancy/) 提供 payload partition、user-defined shard 和 tiered multitenancy；小租户共享过滤，大租户可独立 shard，但共享 shard 的全局查询和资源/隔离权衡不同。租户过滤必须在检索入口强制注入，不能依赖 LLM 记得加 filter；图和 summary 也要有 tenant/scope 字段。

因此，首版可以用本地文件或单机向量库做 generation staging；当需要跨服务器写入、租户 offboarding、并发更新或活动 resume 时，应把 source manifest、generation pointer、outbox 和 ACL 放到有一致性语义的服务化存储，并对向量后端的可见性/删除延迟做显式检查。

## 长任务 resume 协议

每个 `RetrievalManifest` 和 `ContextManifest` 固定：`runId`, `cycleId`, `attemptId`, `generationId`, source manifest hash, embedding/parser fingerprints, query/filter hash, selected evidence ids, rendered context hash。恢复时按顺序：

1. 读取 generation manifest 和 source manifest；generation 不存在、未 ready 或 hash 不符时进入 `INDEX_STALE`/人工边界。新 source revision 本身不使固定旧版本 run 自动失效；版本选择由显式更新决定，ACL/撤稿变化则单独产生访问事件并可能立即阻断读取。
2. 不改变已提交 attempt 的 evidence；新 generation 只能通过新的 retrieval attempt 选择，并记录原因（显式 source revision update、model migration、索引修复）。版本选择和 ACL 判定分别记录，不能以“选了旧版本”绕过权限。
3. 对 pending build job 用 idempotency key 对账；后端不可查询时保持 unknown，不能重复提交。旧 generation 只在 retention policy 和当前授权允许时供旧 attempt 读取；被撤销的证据必须阻断或脱敏，不能为恢复绕过撤销。
4. 生成 answer 时保存 selected raw chunks、graph/tree derived ids 和最终 provenance；若某 derived record 在 generation 内失效，整个 retrieval attempt 失败并重新组装，而不是悄悄删掉一条证据。

## 故障注入与验收

每个断点至少重复 20 次，并和无注入对照比较。验收对象是 generation、source lineage、evidence 和租户边界，不只看答案字符串。

| 注入点 | 预期行为 | 失败判据 |
|---|---|---|
| source manifest 写入前/后 | 只发布完整 manifest；半写文件进入 staging/quarantine | CURRENT generation 指向不完整 manifest |
| parse/chunk 中途崩溃 | 重启按 content/revision/chunker fingerprint 复用或补做，chunk ids 不冲突 | 新旧 revision 混写、重复 chunk、无 locator |
| embedding 返回前/后 | 单个 job 可按 idempotency 对账；失败不污染 ready generation | 向量存在但 fingerprint/hash 缺失，或重复计费无解释 |
| embedding 模型/维度迁移 | 新 embedding family/generation backfill 后发布 | 同一 generation 混用维度/模型，旧 query 静默漂移 |
| 文档修改/删除后查询 | 新 revision 只在显式发布的新 generation 中生效；受影响 summary/edge/cache 被 stale；固定旧 generation 仍按版本和 ACL 读取 | 未选择新 generation 却静默混入新文本，或旧摘要引用已改文本 |
| summary/community 更新中崩溃 | 旧 ready generation 继续服务；新 generation 不完整则不发布 | 半新社区报告与旧边混合服务 |
| resume 固定 generation | 继续原 generation 或显式产生新 retrieval attempt | resume 无记录地切到最新 generation |
| 两个 builder/发布者并发 | 一个 generation pointer 原子发布；另一个冲突重试/废弃 | pointer 回退、generation 覆盖或 source manifest 不匹配 |
| 图边/摘要追溯 | 每条 edge/summary 能回到 raw chunk/span/revision | 只能给 edge weight/summary，无法回到原文 |
| tenant ACL/filter | tenant A 永不看到 B 的 chunk、edge、summary、缓存；跨租户查询必须显式授权 | 任一检索或 graph expansion 越权 |
| 后端删除/读取延迟 | 等待可见性确认并记录 freshness lag；未知状态暂停 | 删除后立即读仍返回旧数据却被当作新事实 |

通过门槛：

- 0 个 ready generation 的 hash/依赖不一致；0 个 stale derived record 被新 generation 查询使用。
- 对仍获准保留和访问的证据，100% 已发布 answer 的 raw evidence 可按 manifest 重现；被撤稿、删除或撤销授权的证据按 retention policy 保留 hash/失效凭据并产生访问事件，不得为达到恢复率而绕过撤销。graph/tree 只作为可追踪的导航和压缩层。
- 支持 provider idempotency/query 时无重复 index job；不支持时 unknown 不自动重提。
- source 修改、删除、parser/embedding 迁移和 resume 都能得到可解释的 generation 选择或失效闭包；撤稿/权限撤销产生独立访问事件；不能用删除历史文件“修复”或绕过授权。
- tenant isolation、ACL、generation pin 和 tombstone 作为独立测试维度报告；不以 embedding Recall 单项替代事实支持率。

建议指标：freshness lag、stale-hit rate、affected-record reprocess ratio、embedding/LLM indexing tokens、raw evidence recall@k、citation support rate、answer correctness、generation mismatch rate、resume success、duplicate job rate、ACL violation count 和每租户成本。

## 限制与决策边界

这些论文的主要实验是多跳 QA、长文档或 global sensemaking，不是本项目的科研证据链、跨服务器调度或删除合规测试；论文分数不能直接转成科研可靠性承诺。GraphRAG/LightRAG 的图和报告会引入 LLM 抽取/摘要误差；HippoRAG 的 NER/OpenIE/PPR 有已报告失败；RAPTOR 的摘要有已报告轻微 hallucination；HippoRAG 2 的 continual 结果仍在有限 benchmark 上。KAIR 是 query-local evolving index，不能当持久 memory。SAG 的当前页面已撤稿，只保留其 append-only/query-time 结构作为待验证线索。官方 Pinecone/Qdrant/GraphRAG 文档是工程语义，不能替代一致性或科学有效性实验。

首版决策应以“可固定 generation、可重建、可追溯、可删除、可隔离”为完成条件；高级图/树路线只有在 paired baseline 证明 raw evidence recall、长任务恢复和总成本改善后才进入默认路径。
