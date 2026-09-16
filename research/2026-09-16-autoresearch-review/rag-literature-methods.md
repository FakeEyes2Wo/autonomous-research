# 科学文献 RAG：方法、证据边界与首版落地方案

审查日期：2026-09-16（只采用不晚于该日期的版本）。本文讨论的是在现有论文检索和证据链上增加可追溯取证的增强型 RAG，不替换现有 ResearchTree。统一实施顺序见 [rag-design.md](./rag-design.md)：R0 先做关键词检索，dense retrieval 和 rerank 由评测结果决定是否加入。本报告服务于根目录 TODO 的三个连续目标：把已检索论文做成可追溯的简单 RAG，确定论文表头和证据字段，再为 AutoResearch benchmark 建立可复现的评测集。论文中的效果是其论文设置下的结果，不能直接当作本项目的效果保证。

## 结论先行

目标是形成一条窄而可审计的增强 RAG 链路：权威元数据和可访问正文入库 → 词法召回（R0）→ 经评测确认有增益后再加向量召回和小候选集重排 → 按 claim 生成答案 → 每个 claim 绑定原文片段和论文标识 → 判定支持/反驳/部分支持/未知 → 证据不足时拒答。这个闭环比直接让模型“总结论文”更适合现有 ResearchTree/evidence 记录，也能为后续 benchmark 留下可计算的中间结果。

当前 main 已有 `PaperRecord` 的 title/arxivId/doi/url/year/venue/citations/abstract 以及 methods/experiments/results/limitations 等字段（`packages/autoresearch/src/brainstorm/paper-record.ts:21-30`）；`paper/references.ts:13-21,82-156` 可下载引用 PDF、写入 SHA-256 和 `citations.json`。它们是元数据和文件证据的起点，但还不能表示作者、版本、全文/摘要边界、section/page/span、抓取时间、解析器/embedding 版本或“该句由哪一片段支持”。证据分支的 `research-context/select.ts:62-142` 已经处理 scope、opposing evidence、unresolved conflict 和 stale dependency；RAG 应输出可被它消费的不可变 source refs，而不是重做这些选择逻辑。

## 论文核验矩阵

“正文重点”表示阅读了论文的主要方法和实验段落；“摘要/数据段”表示只核对了摘要及公开数据说明，结论范围相应收窄；“摘要+实现”表示没有把实现细节误写成论文实验。每条记录只总结一次，避免把矩阵中的结论重复成无来源的建议。

| 论文（时间；一手链接） | 阅读深度 | 方法/实验中对本项目有用的事实 | 边界与可用改变 |
|---|---|---|---|
| **OpenScholar: Synthesizing Scientific Literature with Retrieval-augmented LMs**（arXiv v1：2024-11-21；Nature 正式版题为 *Synthesizing scientific literature with retrieval-augmented language models*，published/version of record：2026-02-04；[arXiv](https://arxiv.org/abs/2411.14199)；[Nature](https://www.nature.com/articles/s41586-025-10072-4)；[repo](https://github.com/akariasai/openscholar)） | 正文方法、数据和评测重点阅读 | 用 45M 开放论文、约 237M passage embeddings，组合专用 bi-encoder、cross-encoder 和生成器；先生成草稿，再依据 self-feedback 继续检索、重写并核验引用。arXiv v1 报告 OpenScholar-8B correctness 高于 GPT-4o 5%、高于 PaperQA2 7%；Nature 正式版更新为高 6.1% 和 5.5%。两版都报告 ScholarQABench 有 2,967 个专家问题、208 个跨 CS/物理/神经/生物医学长答案，且引用准确率接近专家。 | 45M 开放语料、训练模型和成本不适合首版；开放获取覆盖会偏向某些领域，专家偏好和自动分数也不等于完整科学正确性。可落地的是“两阶段召回 + 重排 + 迭代核验”的形状，以及记录每个 citation 的 passage，而非训练 8B 模型。arXiv 和 Nature 结果必须按版本分开记录。 |
| **Language agents achieve superhuman synthesis of scientific knowledge**（PaperQA2；arXiv v1 submitted 2024-09-10，v2 2024-09-26；[arXiv](https://arxiv.org/abs/2409.13740)；[repo](https://github.com/Future-House/paper-qa)；[PDF](https://storage.googleapis.com/fh-public/paperqa/Language_Agents_Science.pdf)） | 正文方法、LitQA2 和 ContraCrow 重点阅读；实现 README 核验 | agent 先查找论文，再收集证据和引用论文并重新取证；论文提示在其设置中要求多来源 evidence pieces，不足时继续搜索或明确不足。论文用 LitQA2 比较检索、总结、矛盾检测，报告三类真实文献任务达到/超过领域专家；随机生物论文中检测到每篇 2.34±1.99 个矛盾，人工核验率 70%。官方包支持本地 PDF index、GROBID sections 或 overlap chunks，返回带 source/context 的答案对象。 | “superhuman”依赖其语料、提示、模型和人工比较设置；公开 repo 与内部工具不同，不能假定所有论文结果可复现。论文中的固定证据数量不是所有问题的门槛；首版按 claim coverage、来源独立性和开发集校准的判定规则决定是否继续搜索或 abstain。矛盾检测是独立高成本能力，不是简单 RAG 的必需件。 |
| **Fact or Fiction: Verifying Scientific Claims**（2020-04-30，EMNLP 2020；[arXiv](https://arxiv.org/abs/2004.14974)；[repo](https://github.com/allenai/scifact)） | 正文任务定义、标注和基线重点阅读 | SciFact 把任务拆成：从研究摘要中检索包含证据的文档，判断 claim 是 SUPPORTS/REFUTES，并抽取 rationale；约 1.4K 专家 claim 配有证据摘要、标签和 rationale。标注含复核与独立重标，论文报告 label/rationale 一致性，且域适配优于 Wikipedia/新闻训练。 | 它是 claim-verification benchmark，不是端到端长文 RAG；证据主要是摘要，不能证明正文实验细节。首版应仿照它把生成拆成 claim-level verifier：`supports/refutes/partial/unknown` 和 exact span；“没有证据”必须是 unknown/abstain，不能改写成 refutes。 |
| **SciFact-Open: Towards open-domain scientific claim verification**（2022-10-25，EMNLP Findings 2022；[arXiv](https://arxiv.org/abs/2210.13777)；[repo](https://github.com/dwadden/scifact-open)） | 摘要、数据构建和误差现象核验 | 将开放域规模扩到 500K research abstracts，用 pooling 标注四个模型的 top predictions；小语料训练的系统在此至少下降 15 F1。数据特别暴露“证据只支持 claim 的特殊情形”这类语义相似但逻辑不足的样本。 | pooling 不是完整穷尽标注，500K 摘要也不是全文语料。它给首版 benchmark 的直接启发是加入 special-case、相似但不支持和真正反驳三种负例，并分别测 retrieval 与 entailment；不能把 top-k 命中当作支持。 |
| **QASPER: A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers**（2021-06，NAACL 2021；[ACL Anthology](https://aclanthology.org/2021.naacl-main.365/)；[PDF](https://aclanthology.org/2021.naacl-main.365.pdf)） | 摘要及正文数据/评测段落核验 | 5,049 个问题覆盖 1,585 篇 NLP 论文；提问者先读标题和摘要，再提出需要全文的问题，回答者必须给 answer 和 supporting evidence paragraphs。模型与人工在答案上至少差 27 F1，在 evidence selection 上至少差 32 F1，说明长上下文不等于找到了正确段落。 | 只覆盖 NLP、以单篇论文问答为主，不能代表开放域多论文综述。应把“回答文本”和“证据段列表”分开存储，benchmark 同时测 evidence recall/precision；对只有 abstract 的问题必须显式标记不可回答，而不是让模型补全文细节。 |
| **SciRerankBench: Benchmarking Rerankers Towards Scientific Retrieval-Augmented Generated LLMs**（2025-08-12 v1；2025-09-24 v2；[arXiv](https://arxiv.org/abs/2508.08742)） | 正文方法、干扰构造、指标和结果重点阅读 | 以 OpenAlex 开放论文覆盖物理/化学/生物/地理/数学，隔离 reranker 而不是假定 context 已经优质；对 5 个相关 + 95 个随机噪声、语义相似但逻辑无关（SSLI）等设置评测 13 rerankers 和 5 个 LLM families，使用 Recall@10、answer containment 等指标。结果显示 reranker 对逻辑无关的近义干扰仍困难，生成模型推理能力会限制最终质量。 | 规模和 13×5 组合不适合首版全量复刻，且自动 answer 指标不能替代 claim entailment。先做小型冻结 fixture：每个问题配相关段、随机段、近义错误段、反方段；比较 BM25、dense、简单融合和一个 cross-encoder 的 Recall@k 与支持率，再决定是否引入专门 reranker。 |
| **Atlas: Customizing Large Language Models for Reliable Bibliographic Retrieval and Verification**（2025-12，WASP；[ACL Anthology](https://aclanthology.org/2025.wasp-main.14/)；[PDF](https://aclanthology.org/2025.wasp-main.14.pdf)） | 摘要与公开方法/评测说明核验 | 三阶段 BibTeX 获取流程比较 Crossref resolver、普通 GPT 提示和 verification-guided GPT，以 Crossref ground truth 测 coverage、completeness、metadata accuracy。提示可改善覆盖，但权威 resolver 才是元数据锚点。 | 它验证的是 bibliographic metadata，不是论文内容支持关系；workshop 结果也不能外推到所有 DOI。直接改变是：LLM 只能提出候选，title/author/year/DOI 用 Crossref/OpenAlex/Semantic Scholar 规范化并保留 raw response；元数据无法核实就降级为 candidate，不能生成正式 citation。 |
| **SciRAG: Adaptive, Citation-Aware, and Outline-Guided Retrieval and Synthesis for Scientific Literature**（2025-11-18；[arXiv](https://arxiv.org/abs/2511.14362)；[repo](https://github.com/yale-nlp/SciRAG)） | 正文方法、评测设置重点阅读 | 该工作将 adaptive sequential/parallel retrieval、最多一跳 forward/backward citation expansion、outline–critic–solve 和 bottom-up backtracking 组合起来；对 SciFact、PubMedQA、QASA、ScholarQA 等测 correctness 与 Citation F1，并做小规模专家标注。其可借鉴的是先拆 outline/子问题、发现证据不足再扩搜，并在证据链上标出段落角色。 | 一跳图扩展和 LLM judge/outline 选择会放大错误，专家样本小，且是较新的预印本，声称优于 OpenScholar/PaperQA2 需要独立复现。首版跳过多跳 citation graph 和多 agent 规划，只保留“低置信度触发一次改写查询”；图检索列为 v2。 |
| **What Should I Cite? A RAG Benchmark for Academic Citation Prediction (CiteRAG)**（2026-01-21；[arXiv](https://arxiv.org/abs/2601.14949)；[repo](https://github.com/LQgdwind/CiteRAG)） | 摘要与官方数据/代码说明核验 | 提供 list-level 和 position-level academic citation prediction：7,267/8,541 个实例、约 554K 论文语料，并用 hybrid RAG 与对比学习 embedding 做候选引用。可作为后续“引用候选排序”评测来源。 | citation prediction 只问“应引用哪篇”，不保证该篇支持生成的句子，不能代替 entailment/abstention。首版不引入其专用训练模型；先保存候选列表、排名分数和最终被 claim 采用的 citation，未来再做 list/position 指标。 |

## 首版数据契约与检索流水线

### 1. 论文表和证据表

保留现有 `PaperRecord` 作为展示/分析兼容层，在旁边增加可追溯字段（字段名可由主 agent 最终定稿）：

```text
PaperSource
  paper_id, title, authors[], year, venue, doi, arxiv_id, canonical_url
  source_kind: abstract | fulltext_html | fulltext_pdf | metadata_only
  access_url, retrieved_at, version, license, content_hash
  parser, parser_version, metadata_verified_by[], supersedes_id?

EvidenceSpan
  evidence_id, paper_id, chunk_id, section, page?, start_offset?, end_offset?
  text, text_hash, source_kind, index_version, retrieved_at
  verification: metadata_verified | span_verified | not_verified

RetrievalReceipt
  receipt_id, query_id, paper_id, chunk_id, retrieval_route, rank
  lexical_score?, dense_score?, rerank_score?, index_version, retrieved_at

ClaimAssessment
  claim_id, statement, claim_span_relations[]
  claim_span_relations: { evidence_id, relation: supports | refutes | partial | unknown }[]
  status: supported | refuted | mixed | unknown | abstained
  abstained, abstention_reason?, opposing_evidence_ids[], unresolved_conflict?
  threshold_profile, dev_calibration_revision
```

`content_hash` 是复现实验和证据分支 dependency freshness 的连接点；`page/offset/section` 让审核者可回到原文。摘要是 `source_kind=abstract`，只能支持摘要覆盖的内容；全文问题若没有可定位正文，输出 `unknown` 或 abstain。query、召回路线、rank 和分数属于一次检索的 `RetrievalReceipt`，不是证据片段固有属性；supports/refutes 等关系属于某个 claim 与 span 的 `ClaimAssessment`，同一片段可以在不同 claim 下有不同关系。标题、作者和 DOI 的规范化来源必须独立于 LLM 生成，保留原始 URL 和抓取时间，避免“论文存在”与“这句话被论文支持”混成一个布尔值。

### 2. 低成本检索顺序

1. 将研究问题切成可验证的短 query/claim，保留方法名、数据集、指标、别名和否定词；不要只用一个长自然语言 query。
2. R0 只做关键词/BM25 检索，先在受控论文目录和全文片段上记录 top-k、paper_id、chunk_id 和 `RetrievalReceipt`，同时完成领域、年份、开放全文、版本等元数据过滤。R0 的结果作为后续比较基线。
3. 只有在 R0 benchmark 有固定结果后，才评测 dense embedding 召回；若 Recall@k 或 evidence support 有稳定增益，再将 dense 候选与关键词候选去重合并。再以同样方式评测 cross-encoder/受约束 LLM rerank，最多处理 40 个候选，输出固定 JSON；生成模型不能自由改写候选文献。
4. 取 top 6–10 个段落生成草稿；每个句子先形成 claim，再绑定一条或多条 EvidenceSpan。引用链接指向 canonical paper，审核链接指向 exact span；没有绑定证据的句子只能是明确的推断/背景，不能伪装成论文结论。
5. 对每个 claim 做轻量 entailment 检查：支持、反驳、部分支持、未知。阈值在开发集上校准并随 `threshold_profile` 版本化；模型自报的 confidence 不能直接当概率。若出现 opposing evidence 或 unresolved conflict，不要静默丢弃一方：保存双方 span 和适用条件；一方在校准规则下占优时可输出带反方引用的 supported/refuted，否则输出 `mixed`/`unknown`，必要时再 abstain。只有最强段落低于校准阈值、只有 abstract 而问题要求实验细节、或文献版本/hash 不明等情况下，才返回 abstain 或“证据不足”，并记录原因。`unknown` 不等于 `refutes`。
6. 首版允许一次 query 改写/补检索；仍无合格证据就结束。跨 run 的索引和缓存可以复用，但答案必须带 index/content 版本，供后续 freshness 检查。

### 3. 与当前项目的接点

- main 的 `PaperRecord` 继续服务 wiki/knowledge graph；新增 Source/Evidence 记录由 RAG 产出，避免把检索分数塞进 `methods` 或 `insights` 自由文本。
- `paper/references.ts` 的 PDF 下载与 SHA-256 是 ingestion 的可复用入口；下载失败不能自动判定论文无效，仍需记录 `metadata_only`/`access` 状态。
- evidence 分支已有 `scope`、`polarity`、`unresolvedConflict`、dependency version/hash 和预算排除原因。RAG 只需提供 `source_refs`、`relation` 和依赖 hash；不要重新实现一套冲突或 freshness 选择器。
- 论文 provider 返回的数组只能视为候选发现结果。进入正式 EvidenceSpan 前，必须能回到权威元数据和原文片段；“搜索到”不等于“读到”。

## Benchmark 设计（TODO 的下一阶段）

先做小而冻结的端到端集，再考虑复刻公开大 benchmark。每条样本保存 `corpus_cutoff`、语料/解析器/index hash、query、gold paper/chunk、gold relation 和允许 abstain 的标记；切分按论文或主题隔离，避免同一论文的版本泄漏到 train/test。

| 层次 | 样本与指标 | 必须暴露的失败 |
|---|---|---|
| 元数据 | Atlas 风格 DOI/title/year/author exact match、coverage、duplicate rate | LLM 编造 DOI、同题不同版本、预印本/正式版混淆 |
| 召回/重排 | SciFact/QASPER 风格 paper/chunk Recall@k、MRR/nDCG、evidence precision/recall；SciRerankBench 风格加入随机、近义逻辑错误、反方干扰 | 相似词命中但没有回答所需关系；正确段被 top-k 挤掉 |
| 证据判定 | claim-level support/refute/partial/unknown F1、span overlap/containment、unsupported-claim rate | 只引用摘要证明正文实验；把 special-case 当普遍结论；把无证据写成反驳 |
| 拒答和系统 | coverage、abstention rate、selective risk（非拒答样本的错误率）、citation completeness、平均延迟/请求成本 | 低置信度仍生成确定语气；冲突证据被静默丢掉；缓存/版本变化后无法复核 |

最小 fixture 至少包括：一个直接支持、一个直接反驳、一个只支持特殊情形、一个语义相似但逻辑无关、一个摘要支持但全文细节缺失、一个多论文结论冲突、一个没有答案、一个重复/版本更新样本。人工抽样审核应检查“claim 是否被 exact span 支持”，不能只给整段答案打主观分。后续再将 QASPER/SciFact(-Open) 的公开数据适配进测试集，并以 OpenScholar 的 ScholarQABench、PaperQA2 的 LitQA2 作为外部对照；外部数据的 license、语料截点和领域差异要单独记录。

## 首版明确不做的组件

1. 训练 OpenScholar 式 8B 模型、建设数千万论文 datastore，或为项目维护全量 passage embedding。
2. 多跳 citation graph、outline/critic/backtracking、多 agent 并行检索；SciRAG 的自适应思想可保留为 v2 的低置信度触发策略。
3. Self-RAG 的 reflection-token 微调、PaperQA2 的完整矛盾发现流程、通用网页 fallback。论文内容优先从受控开放语料和已有 PDF 取证，不能用不受控网页填补缺失。
4. CiteRAG 的专用 citation prediction 训练和大规模 benchmark；先实现可追溯候选排序和 claim entailment。
5. 表格/图片 OCR、多模态图表解释、实验室数据等需要独立标注和解析质量评估的能力。

这些删减保留了文献中最稳定的共同要求：可定位的证据、独立的检索与重排、权威元数据、冲突显式化和证据不足时拒答。它们能直接形成当前项目的可观察中间产物，后续再用 benchmark 结果决定是否增加模型或图检索复杂度。

## 相关候选（未计入重点阅读）

- **Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection**（2023-10-17；[arXiv](https://arxiv.org/abs/2310.11511)）：提供“按需检索 + 生成后批评”的训练范式；首版只借用 abstention/二次检索概念，不训练 reflection tokens。其通用 benchmark 和共享生成器的自评不能保证科学 citation entailment。
- **Corrective Retrieval Augmented Generation**（2024-01-29；[arXiv](https://arxiv.org/abs/2401.15884)）：检索评估器低置信度时纠错、过滤或补搜；科学场景不应默认开放网页 fallback，首版以二次本地 query 或 abstain 替代。检索评估器的跨域可靠性仍需本项目 fixture 验证。
- **SciFact / QASPER / SciRerankBench** 的公开代码和数据适合后续 benchmark 适配；它们的领域、标注单位和开放语料差异不能合并成一个未经说明的总分。

## 阅读清单与深度统计

- **正文方法/实验重点阅读 5 篇**：OpenScholar、PaperQA2、SciFact、SciRerankBench、SciRAG。
- **摘要 + 数据/评测段落核验 2 篇**：SciFact-Open、QASPER。
- **摘要/官方实现或公开说明核验 2 篇**：Atlas、CiteRAG。
- **摘要线索核验 2 篇**：Self-RAG、CRAG；两篇分别计数，均未将摘要当作正文阅读。
- **按论文逐篇合计 11 篇**：OpenScholar 的 arXiv 与 Nature 是同一工作的两个版本，合并为上面的 1 篇并在矩阵中分开记录版本日期/结果；其余论文逐篇计数。
- **一手 URL 总表**：OpenScholar [arXiv](https://arxiv.org/abs/2411.14199)/[repo](https://github.com/akariasai/openscholar)/[Nature 页面（2026-02-04）](https://www.nature.com/articles/s41586-025-10072-4)；PaperQA2 [arXiv](https://arxiv.org/abs/2409.13740)/[repo](https://github.com/Future-House/paper-qa)；SciFact [arXiv](https://arxiv.org/abs/2004.14974)/[repo](https://github.com/allenai/scifact)；SciFact-Open [arXiv](https://arxiv.org/abs/2210.13777)/[repo](https://github.com/dwadden/scifact-open)；QASPER [ACL](https://aclanthology.org/2021.naacl-main.365/)；SciRerankBench [arXiv](https://arxiv.org/abs/2508.08742)；Atlas [ACL](https://aclanthology.org/2025.wasp-main.14/)；SciRAG [arXiv](https://arxiv.org/abs/2511.14362)/[repo](https://github.com/yale-nlp/SciRAG)；CiteRAG [arXiv](https://arxiv.org/abs/2601.14949)/[repo](https://github.com/LQgdwind/CiteRAG)；Self-RAG [arXiv](https://arxiv.org/abs/2310.11511)；CRAG [arXiv](https://arxiv.org/abs/2401.15884)。
