# 论文解析、入库与检索表示：补充依据

日期：2026-09-16。主 Agent 阅读记录；供 [统一 RAG 方案](rag-design.md) 使用。没有安装或测跑以下工具。当前工具功能与论文实验分别标注，不用产品文档充当模型效果证明。

## 一手资料与实际阅读范围

| 来源 | 阅读范围 | 有用机制及边界 |
|---|---|---|
| [OmniDocBench](https://arxiv.org/html/2412.07626v1) | v1，正文 §3 数据与标注、§4 评估、§5 结果及结论 | 分别评测文字、公式、表格、阅读顺序，并按版面/语言等属性拆分；提示入库不能只以能提取文本为通过。这里不是用旧版榜单决定 2026 年的最佳 parser |
| [Late Chunking](https://arxiv.org/html/2409.04701v2) | 方法 §3 与 §4.1–4.3 实验/局限 | 长上下文模型先得到 token 表示，再按 chunk 范围 pooling。需访问兼容模型的 token 表示；普通只返回一个向量的 embedding API 未必支持。上下文无关或大块时收益不普遍，不作为首版前置依赖 |
| [PureDocBench](https://arxiv.org/abs/2605.07492) | 2026-05，一手摘要/元数据 | 用来源可追溯的生成文档及退化版本评价解析，提醒干净样例分数不能替代实际语料表现。未深入正文，不采纳其具体排名作为选型证据 |
| [TableParseMap / DEC](https://arxiv.org/abs/2608.09842) | 2026-08，一手摘要/元数据 | 针对真实大表、弱视觉线索和重建一致性；仅作复杂表格失败与选择性修复的近期线索，尚未核查全部方法/成本 |
| [DoclingDocument](https://docling-project.github.io/docling/concepts/docling_document/)、[ProvenanceItem](https://docling-project.github.io/docling/reference/docling_document/) | 官方数据模型与 provenance 定义 | 可保存文本/表格/图、文档层级、可用时的版面框；provenance 包含 page_no、bbox、charspan。字段存在不保证每篇解析正确，也不是所有 HTML 都有 PDF 页码 |
| [GROBID 坐标](https://grobid.readthedocs.io/en/latest/Coordinates-in-PDF/)、[FAQ](https://grobid.readthedocs.io/en/latest/Frequently-asked-questions/) | 官方全文/结构/公式/表格/合并元数据相关章节 | TEI 与坐标适合学术结构/参考文献；默认不等于完整表格单元格识别。FAQ 明确章节层级、公式上下标和语言质量限制；consolidation 可能把预印本 metadata 换成出版版，必须单独保留原始记录 |
| [arXiv API 手册](https://github.com/arXiv/arxiv-docs/blob/develop/source/help/api/user-manual.md) | 官方版本与 entry metadata 相关说明 | 保存 authors、published、updated、明确版本；不带 vN 的查询可能取最新，研究 run 必须记录实际版本 |
| [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)、[metadata retrieval](https://www.crossref.org/documentation/retrieve-metadata/) | 官方 API/来源说明 | DOI lookup、作者/日期/关系与更新信息可辅助核对；记录由出版者和来源提供，可能不完整。不是全文下载或引用语义支持的证明 |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | 官方 tokenizer、trigram、external-content 一致性段落 | 可建立轻量本地全文检索；unicode61 的连续字符 token 规则不等于中文分词，trigram 不命中少于 3 字符的全文查询；外部内容表索引由应用维护一致性 |

## 由此得到的实现判断

本轮核对出现了一个实际例子：OpenScholar 的 DOI 含 `025`，但正式出版日期是 **2026-02-04**。年份必须来自出版记录，不能从标识符猜测；其预印本与正式版的效果数字也需分别归属版本。[Nature 出版页](https://www.nature.com/articles/s41586-025-10072-4)

### 1. 每个结果的定位需要分清坐标系

SourceSpan 保存 document version、parser 输出 hash、文本段内 offset；PDF 另存实际 page number、bbox、原点及页尺寸。HTML 保留锚点/DOM 路径与文本 offset。文本规范化前后映射不能丢；解析器的第 8 页也可能与正文印刷页码 6 不同。

数字或公式来自 OCR 时标 `ocr`，经过 VLM 修复时另存派生版本和原图定位。高相关性分数不能覆盖原始解析警告。读取器打开指定版本后高亮能落在正确位置，才算定位链通过。

### 2. 表格应成为独立、可组合的检索单元

一个数值至少携带 row labels、column labels、metric/unit、caption、必要脚注和论文版本；多级表头不可直接压成无标题 CSV。比较两个论文的“提升 5%”之前检查相对/绝对、基线、split、预算与统计单位。

首版可完整保留小表；大表按行组切块并复制必要标题，再返回原表链接。缺上下文的单元格可以命中，但必须在用于生成数值结论前补读表头/脚注。

### 3. parser 以实际样例选择

开发语料至少覆盖：双栏英文、中文术语、跨页表、公式/上下标、扫描/低质量页、仅摘要来源。先比较可用 HTML 与一个 PDF adapter；观察失败后再引入第二 parser 或按页 OCR。不要同时部署所有解析工具。

质量检查包含题名/页数一致性、文本覆盖、顺序、关键数值/单位、表头配对、定位。人工核验小样本建立基线；解析器自报 confidence 未校准前只作诊断字段。

### 4. 检索辅助内容不能伪装原文

title + section_path + chunk 的确定性上下文前缀是廉价起点。模型生成 contextual summary、中文翻译、查询扩展应单独保存生成来源。embedding 可以包含这些辅助内容，最终引用仍要读回绑定版本的真实片段。

Late Chunking 与“让 LLM 为每块加一段解释”是不同方案；前者改向量计算顺序，后者产生新文本。是否采用，分别用同模型/同语料/同预算消融确定。

## 本轮检索记录

代表性查询：`scientific paper parsing benchmark tables citations Docling GROBID MinerU 2025 2026 OmniDocBench`、`site.sqlite.org fts5 unicode61 trigram Chinese tokenizer`、`site.crossref.org REST API metadata DOI relation preprint version arxiv`、`site.docling-project.github.io docling document provenance page_no bbox tables`、`site.grobid.readthedocs.io fulltext TEI coordinates references`、`site.arxiv.org "Late Chunking"`。

检索出现的社区帖子只作线索，本文机制与建议所依赖的技术事实均引用论文/官方资料。正文重点阅读和摘要线索明确分开；未复现论文结果，未认定任何解析器是本项目已经验证的最优选择。
