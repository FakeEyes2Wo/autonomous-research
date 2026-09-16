搜索到的论文的相关信息可以简单做一个rag。
这个rag还需要进一步设计如 

搜索到论文的表头，以及如何进一步做rag



完成过后对于autonomas research 的benchmark需要制作
这里需要观测其他的Research Agent 他们的 experiment是如何制作的

## 2026-09-16 探索记录与后续交付

**最新范围：benchmark 暂缓。** 当前优先实施论文目录、原文检索、研究循环接入、阅读界面与长任务恢复；保留必要的软件测试。C1 benchmark、C3 混合检索对照及下述 L3/L4 暂不安排，不作为 RAG 交付前置条件。

实施依据为 **[总路线图](docs/superpowers/plans/2026-09-16-rag-research-roadmap.md)**，以及 [A：文献与检索](docs/superpowers/plans/2026-09-16-rag-foundation.md)、[B：研究闭环与长任务](docs/superpowers/plans/2026-09-16-rag-research-runtime.md)、[C：评测与阅读界面](docs/superpowers/plans/2026-09-16-rag-evaluation-workbench.md)。用户已授权实施；功能进度与验证边界见[实现验收记录](docs/verification/2026-09-16-research-rag-runtime.md)。

文献阅读和方案入口：[TODO 驱动的 RAG 与科研评测方案](research/2026-09-16-autoresearch-review/rag-design.md)。关键词 RAG 已实现，benchmark 未开展。

- [x] L0：确定论文目录表头与来源契约，记录身份、作者、版本、读取范围、原文定位和入库状态；迁移已有 `PaperRecord` 时标记未核实内容。
- [x] L1：建立带原文片段/表格出处的关键词检索基线，处理摘要/全文、版本去重、中英查询与证据不足；索引可重建。
- [x] L2：把检索结果接入 `ResearchContext` 与假设生成；保留反证和数据使用边界；实验 baseline 按任务、数据、指标、预算和复现条件选择。
- [ ] L3（暂缓）：在冻结试点评测上比较向量混合召回和重排序，收益成立后再启用；图检索、层级摘要、多跳搜索按实际失败模式追加。
- [ ] L4（benchmark 暂缓）：建立 AutoResearch benchmark 的公开输入、隐藏 evaluator、任务环境、预算、产物和复现契约；试点及研究性能对照不纳入当前实施。长任务恢复的功能测试仍保留。
- [x] 文献阅读入口：接入已登记论文目录及原文命中定位，复用工作台 PDF 组件；阅读请求不隐式触发下载、解析或编译。
- [x] 已有项目探索与 init 分流：主 agent 可调用 `project_paper_run`，捕获有界源码、生成带出处的贡献候选，再进入研究和论文流程；恢复复用项目身份及预算。
- [x] 持久实验与已有项目完整联调：主 agent 在预算内补充验证，任务图、结果准入及论文交接已通过最终审查；完整真实论文生成未验收。
- [ ] 两小时受控长时验收：运行中，完成后记录终态、重启、重复提交、结果丢失和预算证据。24 小时脚本单独提供，不把未运行的时长记为通过。

阅读依据：

- [科学文献 RAG 方法](research/2026-09-16-autoresearch-review/rag-literature-methods.md)
- [论文解析与入库](research/2026-09-16-autoresearch-review/rag-ingestion-notes.md)
- [索引更新与长期记忆](research/2026-09-16-autoresearch-review/rag-index-and-memory.md)
- [其他科研 Agent 的实验接口与 benchmark 设计](research/2026-09-16-autoresearch-review/rag-and-research-benchmark-design.md)

原先 20 篇不同工作、40 个核对问题和 3–5 个研究任务的 benchmark pilot 继续暂缓。软件功能测试不等同于科研质量评测；真实模型探索的暂停记录也不等同于完整论文生成成功。



