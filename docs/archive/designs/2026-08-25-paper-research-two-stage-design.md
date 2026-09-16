# Paper 调研两阶段设计（Broad Survey + Direction/Frontier）

日期：2026-08-25
状态：implemented
涉及模块：`BrainstormPipeline`、`paper-survey` / `direction-select` / `paper-frontier-miner` / `paper-wiki-writer`、`paper_wiki/` 与 `paper_wiki/kg/` 产物

## 1. 目标

把当前“一次挖 30 篇 → 直接写 A 级 wiki → 立刻 brainstorm”的调研流程，拆成两个阶段：

1. **Stage 1：Broad Survey（广度调研）**
   - 先不锁定研究问题。
   - **最重要的第一步：找到相关领域已有的 survey / review 综述论文**，以综述为骨架理解领域。
   - 再结合综述和原始论文扫描整个领域地图：有哪些子方向、各自代表性工作、当前热点、明显空白。
   - 产出：一篇 `SURVEY_OVERVIEW.md` + 一批轻量 survey wiki 条目（综述本身也必须有 wiki 条目）。

2. **Stage 2：Direction Selection + Latest / Frontier Mining（选方向 + 最新深挖）**
   - 基于 survey 选出 1–3 个候选 direction。
   - 对选定 direction 查询“最新前沿/最新防线”文献（最近 1–2 年、顶会/arXiv 最新）。
   - 产出：方向选择记录 + 一批 focused/latest wiki 条目。

**硬要求：两阶段的所有论文都进入同一个 `paper_wiki/`**，并带 stage 标记，后续 brainstorm 可以一次看到完整上下文。

---

## 2. 现状与问题

当前流程：

```text
paper-miner（Seed=None 时自选一个方向 + 挖 30 篇）
  → paper-wiki-writer（只给 15-20 篇 A 写 wiki）
  → brainstorm propose/debate/score/chair
  → input/idea.md
```

问题：

- 没有优先检索领域综述：缺少以 survey/review 为骨架的领域地图，容易漏掉 taxonomy 和已总结的开放问题。
- 过早锁定方向：Seed 为空时，`paper-miner` 一开始就“自选方向”，广度不够。
- 广度与深度混在一次调用里：没有先建立领域地图，就直接进入高相关论文筛选。
- wiki 只覆盖 A 级：B/C 级、综述和后续补充的最新文献没有结构化沉淀。
- 没有独立的“选 direction 后再查最新”步骤，最新工作容易漏掉。

---

## 3. 目标流程

```text
Stage 1: Broad Survey
──────────────────────────────────────────────────────
[seed 或空]
   │
   ▼
paper-survey
   │  ① 先检索相关领域的综述/survey/review 论文（必须）
   │  ② 以综述为骨架构建 cluster 地图
   │  ③ 补充 landmark/method/critique 论文
   ▼
survey_pool.json（60-100 篇 + 至少 3-5 篇综述，覆盖 ≥5 个子方向）
   │
   ▼
paper-wiki-writer（stage=survey）
   │
   ▼
paper_wiki/_index.md（含 stage、cluster/direction 列）
paper_wiki/ *_survey.md / SURVEY_OVERVIEW.md（综述列表 + 领域地图）

Stage 2: Direction Selection + Latest
──────────────────────────────────────────────────────
paper_wiki/_index.md
   │
   ▼
direction-select（从 survey 中选出 1-3 个 direction）
   │
   ▼
paper-frontier-miner（对每个 direction 查最新文献）
   │
   ▼
paper-wiki-writer（stage=latest，补入 focused/deep wiki）
   │
   ▼
合并 paper_wiki/_index.md（survey + latest）
   │
   ▼
brainstorm propose/debate/score/chair
   │
   ▼
input/idea.md
```

新版 BrainstormPipeline 内部顺序：

```text
resolveSeed
→ survey()
→ writeSurveyWikis()
→ selectDirections()
→ frontierMine()
→ writeFrontierWikis()
→ rebuildMergedWikiIndex()
→ propose()
→ debate()
→ scoreAndRank()
→ chair()
→ handoff()
```

---

## 4. Stage 1：Broad Survey

### 4.1 角色：`paper-survey`

新增独立角色 `paper-survey`，职责单一；旧 `paper-miner` 已移除。

输入（Plan section）：

```text
Seed: <人类 seed 或 None>
Stage: survey
Goal: breadth, and FIRST find domain surveys/reviews
Min surveys: 3-5
Min clusters: 5
Min papers: 60
Max papers: 100
```

执行顺序（写入 prompt，作为硬性要求）：

1. **先搜索相关领域的 survey / review / 综述论文**，来源包括但不限于：
   - arXiv `cs.*` 下的 survey/review
   - 顶会 tutorial / 综述 track
   - Google Scholar / Semantic Scholar / OpenAlex 搜索 `"<领域> survey"`、`"<领域> review"`
   - 知名期刊综述、Foundations and Trends 系列
2. **用综述作为骨架**，把综述给出的 taxonomy / roadmap / open problems 转化为 cluster。
3. 再从综述引用和最新检索中补充 landmark、method、critique、edge 论文。
4. 如果找不到综述或综述数量不足，必须降低置信度并明确写出“该领域缺少综述，以下为自建地图”，不能假装找到。

输出 schema（结构化）：

```ts
{
  overview: string;                 // 一段领域地图总结，必须基于找到的综述
  surveys: Array<{                  // ★ 最重要的输出：领域综述本身
    id: string;                     // s001, s002...
    title: string;
    arxivId?: string;
    doi?: string;
    url: string;
    year: string;
    venue: string;
    citations: number;
    scope: string;                  // 该综述覆盖的领域范围
    taxonomy: string[];             // 综述中提出的子方向/分类
    openQuestions: string[];        // 综述点出的开放问题
    recommendedDirections: string[];// 综述建议的未来方向（如有）
  }>;
  clusters: Array<{
    id: string;                     // c01, c02...
    name: string;                   // 子方向名
    summary: string;                // 该子方向在做什么、核心争议
    sourceSurveyIds: string[];      // 该 cluster 主要依据哪些综述
    representativePaperIds: string[]; // 指向 papers 里的 id
    openQuestions: string[];        // 该子方向的开放问题/空白
  }>;
  papers: Array<{
    id: string;                     // s001, s002...（综述本身也占一个 id）
    title: string;
    arxivId?: string;
    doi?: string;
    url: string;
    year: string;
    venue: string;
    citations: number;
    abstract: string;
    clusterId: string;              // 属于哪个子方向
    isSurvey: boolean;              // 是否本身就是综述/survey 论文
    role: 'landmark' | 'method' | 'critique' | 'survey' | 'edge';
    oneLiner: string;               // 一句话贡献
    keyFinding: string;
    weakness: string;               // 最具体的一个失败点/局限
    implication: string;            // 对后续选题的启示
  }>;
}
```

硬约束：

- **必须找到 ≥3 篇（默认 3–5 篇）相关领域的真实 survey/review 论文**，这是 Stage 1 的首要验收项。
- 综述论文必须进入 `surveys` 数组，同时进入 `papers` 且 `isSurvey=true`、`role='survey'`。
- 每个 cluster 必须能指出依据的综述 `sourceSurveyIds`；不能凭空造 cluster。
- 总论文数 ≥ 60（可配置）。
- 子方向（cluster）≥ 5。
- 每个 cluster 至少 3 篇代表论文。
- 必须覆盖 landmark、method、critique、survey 四类。
- 真实文献，不得编造；按 arXiv/DOI 去重。
- 不要求一次性判断“A/B/C”，`role` 表示在领域地图中的位置。

### 4.2 Stage 1 Wiki 产物

- `paper_wiki/s001.md` …：每篇 survey 论文一个轻量卡片（综述论文的卡片要突出其 scope / taxonomy / open questions）。
- `paper_wiki/_survey.md`：**领域综述总览**，必须包含：
  - `## Found Surveys`：找到的相关综述列表（标题、年份、覆盖范围、优劣）。
  - `## Cluster Map`：基于综述 taxonomy 形成的子方向地图。
  - `## Open Problems`：综述和各 cluster 共同暴露的开放问题。
  - `## Missing Survey`：如果综述不足，明确标注该领域综述覆盖缺口。
- `paper_wiki/_index.md`：统一索引，使用新增列，并让 `isSurvey=true` 的论文有标记。

Survey wiki 卡片模板（比 deep wiki 更轻，每篇 ≤ 150 词）：

```markdown
# <Title>
- meta: arxiv/doi, year, venue, cluster: <clusterId>, role: <role>
- type: survey | landmark | method | critique | edge

## 一句话
## 关键发现 / scope
## 失败点/局限 / 综述未覆盖处
## 对选题的启示
```

---

## 5. Stage 2：Direction Selection + Latest

### 5.1 角色：`direction-select`

职责：基于 survey wiki，从广度地图中选出 1–3 个最值得深挖的方向。

输入：

- `paper_wiki/_survey.md`（必须包含 Found Surveys / Cluster Map）
- `paper_wiki/_index.md`（survey 部分）
- 优先从综述的 `recommendedDirections` / `openQuestions` 中寻找方向，而不是只从单篇论文的 weakness 中找。

输出 schema：

```ts
{
  directions: Array<{
    id: string;                     // d1, d2...
    name: string;
    statement: string;              // 一个可证伪/可展开的 direction
    why: string;                    // 为什么值得选
    evidence: string[];             // 至少 3 个 survey paper id / wiki 路径
    cheapTest: string;              // 最小验证
    risk: string;
  }>;
  selectedId: string;               // 主 direction
  backups: string[];                // 备用 direction id
}
```

也可复用 `brainstorm` 角色的 `propose` 逻辑，但建议独立角色，让“选 direction”成为可观察中间产物。

### 5.2 角色：`paper-frontier-miner`

职责：对已选 direction 做“最新防线/最新前沿”定向深挖。

输入：

```text
Selected directions: <JSON>
Latest window: last 12 months（可配置）
Target venues: <可选，如 ICLR/NeurIPS/ICML/arXiv>
Existing survey paper ids: <用于去重>
```

输出 schema：

```ts
{
  papers: Array<{
    id: string;                     // l001, l002...
    title: string;
    arxivId?: string;
    doi?: string;
    url: string;
    year: string;
    venue: string;
    citations: number;
    abstract: string;
    directionId: string;            // d1/d2...
    relevance: 'A' | 'B' | 'C';     // 相对该 direction 的直接相关度
    whyLatest: string;              // 为什么是最新值得关注的
    novelty: string;                // 相对已有工作的增量
    weakness: string;               // 具体可攻击/可改进点
  }>;
}
```

硬约束：

- 每个 direction 至少 5 篇最新论文（默认）。
- 只返回近 1–2 年的真实论文。
- 与 survey 阶段重复的论文必须用 `existingPaperIds` 排除或标记为 “already in survey”，不重复写 wiki。
- 不得编造。

### 5.3 Stage 2 Wiki 产物

- `paper_wiki/l001.md` …：每篇 latest/focused 论文一个完整 wiki（沿用现有六节模板，300 词内）。
- `paper_wiki/_directions.md`：方向选择记录（selected + backups + why）。
- `paper_wiki/_index.md` 更新，加入 latest 条目。

---

## 6. 领域地图小型知识图谱（Paper Knowledge Graph）

目标：把 Stage 1 的领域地图和 Stage 2 的最新方向，自动转成一个小型、可查询、可可视化、可给 LLM 作为上下文的纸质知识图谱。

### 6.1 概念模型

节点类型：

| 节点类型 | 说明 | 例子 |
|---|---|---|
| `Survey` | 相关领域综述 | RLVR 综述、Test-Time Scaling 综述 |
| `Cluster` | 综述 taxonomy 衍生出的子方向 | 过程奖励、长度敏感性、因果 fidelity |
| `Paper` | 单篇论文（survey 论文也是 Paper，同时带 Survey 类型） | DeepSeek-R1 |
| `Direction` | 候选/选定研究方向 | d1, d2 |
| `OpenProblem` | 综述或 cluster 指出的开放问题 | 缺少标签级因果探针 |

边类型：

| 边类型 | 方向 | 含义 |
|---|---|---|
| `SURVEY_COVERS` | Survey → Cluster | 这篇综述覆盖了该子方向 |
| `CLUSTER_CONTAINS` | Cluster → Paper | 该子方向包含这篇论文 |
| `SURVEY_REVIEWS` | Survey → Paper | 综述中讨论/引用了这篇论文 |
| `DIRECTION_BASED_ON` | Direction → Cluster / Survey / OpenProblem | 方向来源于哪个子方向、综述或开放问题 |
| `OPEN_PROBLEM_IN` | OpenProblem → Cluster | 开放问题属于哪个子方向 |
| `LATEST_BUILDS_ON` | latest Paper → Paper / Survey | 最新工作建立在哪些已有工作/综述之上 |
| `SIMILAR_TO` | Paper → Paper | 同一方向、类似方法或可比工作（可选，用于聚类） |

### 6.2 数据格式

统一使用简单的 JSON 图，不引入数据库：

```json
{
  "schema": "autoresearch/paper-kg/v1",
  "nodes": [
    {
      "id": "survey:s001",
      "type": "Survey",
      "label": "A Survey of RLVR",
      "properties": { "year": 2025, "url": "https://arxiv.org/abs/...", "stage": "survey" }
    },
    {
      "id": "cluster:c01",
      "type": "Cluster",
      "label": "过程奖励",
      "properties": { "summary": "...", "sourceSurveyIds": ["survey:s001"] }
    },
    {
      "id": "paper:p001",
      "type": "Paper",
      "label": "DeepSeek-R1",
      "properties": { "year": 2025, "clusterId": "c01", "role": "landmark", "stage": "survey" }
    }
  ],
  "edges": [
    { "id": "e001", "source": "survey:s001", "target": "cluster:c01", "type": "SURVEY_COVERS" },
    { "id": "e002", "source": "cluster:c01", "target": "paper:p001", "type": "CLUSTER_CONTAINS" }
  ]
}
```

该格式可再导出为：
- **Graphology JSON**：`graphology` 的 `Graph.fromJSON` / `toJSON` 可直接读写。
- **Cytoscape elements**：给 HTML 可视化页面使用。

### 6.3 开源库选型

#### 主选：Graphology（数据/算法层）

- 纯 JavaScript/TypeScript 图库，内存中运行，无服务器依赖，适合当前 TS 管线。
- 支持有向图、节点/边属性、JSON 导入导出。
- 生态包：
  - `graphology-metrics`：中心性、密度、modularity、diameter 等。
  - `graphology-components`：连通分量。
  - `graphology-communities-louvain`：Louvain 社区发现，可用于自动校验/合并 cluster。
  - `graphology-layout-forceatlas2`：生成力导向布局，供可视化使用。
  - `graphology-shortest-path` / `graphology-dag`：路径和 DAG 分析。
- 参考：
  - https://github.com/graphology/graphology
  - https://graphology.github.io/standard-library/

#### 可视化层：Cytoscape.js

- 成熟的开源图论可视化库，适合小型知识图谱。
- 可直接加载 `nodes/edges` JSON。
- 可生成自包含 HTML：`paper_wiki/kg/kg.html`，人工和 Agent 都能查看。
- 参考：
  - https://js.cytoscape.org/
  - https://github.com/cytoscape/cytoscape.js
- 备选：`vis-network`（https://visjs.org/），如果只需要简单网络图，也可以用；Cytoscape 在布局和图论概念上更完整。

#### 可选 RDF 语义层

- `N3.js`：Turtle/N3 流式读写，适合 RDF 序列化。
  - https://github.com/rdfjs/N3.js
- `rdflib.js`：RDF/JS 查询，适合未来接入 SPARQL / 开放知识库。
  - https://github.com/linkeddata/rdflib.js
- 当前阶段不必须；若以后要与外部 KG 互操作，再增加这一层。

#### Python 参考（如果后续做离线分析）

- `networkx` + `pyvis`：分析 + HTML 可视化。
- `kglab`（DerwenAI）：更完整的 KG 构建层，但偏重。
- 因为当前调研管线是 TypeScript，优先不引入 Python 运行时。

**结论：采用 `graphology` 作为图谱计算层，`cytoscape` 作为可视化层。二者都是 npm 可安装的开源库，体积小、无外部服务。**

### 6.4 产物

在 `paper_wiki/kg/` 下生成：

```text
kg.json              # 规范 JSON 图（唯一事实源）
kg.graphology.json   # Graphology JSON 导出（可选，内容通常相同）
kg.html              # 自包含 Cytoscape 可视化页面
SUMMARY.md           # 图谱摘要：节点类型统计、主要 cluster、桥接节点、开放问题
```

### 6.5 与流程的集成

推荐在 Stage 1 写完 survey wiki 后立即构建第一版 KG，Stage 2 写入 latest 后再增量更新：

```text
survey()
  → writeSurveyWikis()
  → buildPaperKnowledgeGraph(survey)      # 生成 kg.json / kg.html / SUMMARY.md
  → selectDirections()                     # 输入里加入 SUMMARY.md
  → frontierMine()
  → writeFrontierWikis()
  → rebuildPaperKnowledgeGraph(survey, frontier, directions)
  → propose/debate/score/chair
```

知识图谱对下游的作用：

- `direction-select` 不只读 wiki 文本，还能读 `SUMMARY.md`、查询/kg 高中心性综述和 cluster。
- 可用 `graphology-communities-louvain` 自动发现 paper 群落，用于校验 LLM 生成的 cluster 是否合理。
- 可用中心性识别 landmark 论文和综述，避免只依赖 LLM 主观排序。
- 可用连通分量发现“孤立子方向/冷门方向”。

### 6.6 代码落点

新增纯 TS 模块，不需要新的 LLM role：

```text
src/brainstorm/knowledge-graph.ts
  - buildPaperKnowledgeGraph({ survey, frontier, directions })
  - writePaperKnowledgeGraph(runDir, kg)
  - exportGraphologyJson(kg)
  - exportCytoscapeHtml(kg)
  - buildSummaryMarkdown(kg)
```

类型可放在：

```text
src/brainstorm/kg-types.ts
```

该模块只依赖 `graphology` / `cytoscape` 的序列化和算法能力，不改变现有 LLM prompt 契约。

---

## 7. 统一 Paper Wiki 与接口

### 7.1 是否需要统一接口？

**需要，而且应该作为 Stage 1 / Stage 2 之间的核心契约。**

如果不统一，会出现以下分叉：

- `paper-wiki-writer` 要维护两套输入格式，Prompt 和 Schema 重复。
- 知识图谱 builder 无法用同一套函数处理 survey 与 latest 论文。
- 去重逻辑必须分别写，容易漏掉跨阶段重复。
- `_index.md`、`kg.json` 和下游 `direction-select` 要反复适配两种字段。

因此设计为：**LLM 角色可以返回各自的原始结构，但进入 pipeline 后必须先归一化成统一的 `PaperRecord[]`，之后 wiki、KG、索引、去重都只消费这一种接口。**

### 7.2 按功能拆分 PaperRecord

不再把全部字段堆在一个 interface 里，而是按功能拆成四层：
**文献身份 → 领域定位 → 可用洞察 → 阶段专有扩展**，最后用判别联合组合。

```ts
export type WikiStage = 'survey' | 'latest'

export type SurveyRole =
  | 'survey'      // 综述论文
  | 'landmark'    // 里程碑工作
  | 'method'      // 方法论文
  | 'critique'    // 批判/分析论文
  | 'edge'        // 边缘/后续再看

export type FrontierRole = 'A' | 'B' | 'C'

// ── 1. 文献身份：任何论文都有的引用信息 ──────────────────────────
export interface PaperMeta {
  id: string                    // s001 / l001，全局唯一
  title: string
  arxivId?: string
  doi?: string
  url?: string
  year?: string
  venue?: string
  citations?: number
  abstract?: string
}

// ── 2. 可用洞察：paper-wiki 与知识图谱共用的核心分析字段 ─────────
export interface PaperInsight {
  oneLiner: string
  keyFinding: string
  weakness: string
  implication: string
}

// ── 3. Survey 阶段专有：领域地图位置 + 综述特性 ───────────────────
export interface SurveyPaperExtras {
  stage: 'survey'
  role: SurveyRole
  clusterId?: string            // 主 cluster（单主题时可填）
  clusterIds?: string[]         // 多 cluster（综述通常跨多个子方向）
  sourceSurveyIds: string[]     // 被哪些综述覆盖/引用
  isSurvey?: boolean            // 是否本身就是综述
  surveyScope?: string          // 如果是综述：覆盖范围
  taxonomy?: string[]           // 如果是综述：给出的分类体系
  openQuestions?: string[]      // 如果是综述：指出的开放问题
  recommendedDirections?: string[] // 如果是综述：建议的未来方向
}

// ── 4. Latest 阶段专有：定向深挖位置 + 最新性说明 ─────────────────
export interface FrontierPaperExtras {
  stage: 'latest'
  role: FrontierRole
  directionId: string
  sourceSurveyIds?: string[]    // 该最新工作建立在哪些综述/旧工作上
  whyLatest: string
  novelty: string
}

// ── 5. 组合：判别联合。调度方只认 PaperRecord，具体阶段可用 discriminant ──
export type SurveyPaper = PaperMeta & PaperInsight & SurveyPaperExtras
export type FrontierPaper = PaperMeta & PaperInsight & FrontierPaperExtras
export type PaperRecord = SurveyPaper | FrontierPaper
```

功能边界说明：

| 分层 | 职责 | 消费方 |
|---|---|---|
| `PaperMeta` | 论文是谁、可引用的元数据 | 去重、索引、引用、KG 节点 |
| `PaperInsight` | 这篇论文对后续研究有什么用 | wiki 正文、KG SUMMARY、direction-select |
| `SurveyPaperExtras` | 在领域地图中的位置和综述 taxonomy | survey wiki、cluster map |
| `FrontierPaperExtras` | 在选定方向中的最新位置和增量 | latest wiki、方向深挖 |
| `PaperRecord` | 统一入口，判别联合 | paper-wiki-writer、KG builder、去重、索引 |

### 7.3 归一化函数

```ts
function normalizeSurveyPapers(survey: SurveyResult): SurveyPaper[]
  // 把 surveys + papers 都转成 SurveyPaper[]
  // 综述论文: id=s001, role='survey', isSurvey=true

function normalizeFrontierPapers(frontier: FrontierResult, directionMap): FrontierPaper[]
  // 把 latest papers 转成 FrontierPaper[]
  // 每个条目带 stage='latest'、directionId、role=A/B/C

function mergePaperRecords(surveyPapers: SurveyPaper[], frontierPapers: FrontierPaper[]): PaperRecord[]
  // 按 arxivId/doi/url/title 去重
  // 确保同一篇论文不会同时出现在 survey 与 latest
```

### 7.4 下游只依赖 PaperRecord

```text
PaperRecord[]
  ├── paper-wiki-writer（统一输入，只按 stage 决定 light/full）
  ├── paper_wiki/_index.md（统一行格式）
  ├── knowledge-graph builder（统一建节点/边）
  ├── 去重（跨阶段）
  └── direction-select / brainstorm（统一引用 id）
```

### 7.5 统一索引

新 `_index.md` 建议格式：

```markdown
# Paper Wiki Index

| id | title | type | stage | cluster/direction | wiki |
|---|---|---|---|---|---|
| s001 | ... | survey | survey | c01 | paper_wiki/s001.md |
| s002 | ... | landmark | survey | c02 | paper_wiki/s002.md |
| l001 | ... | method | latest | d1 | paper_wiki/l001.md |
| l002 | ... | critique | latest | d1 | paper_wiki/l002.md |
```

说明：

- `id` 加前缀区分阶段：`s*` = survey，`l*` = latest。
- `stage` 字段参与排序：brainstorm 默认先看 survey 地图，再深入 latest。
- `type` 在 survey 阶段用 `survey / landmark / method / critique / edge` 表达领域角色；在 latest 阶段可复用 `A / B / C` 或继续用 role。
- 综述论文在 `type=survey` 且 `stage=survey`，在 wiki 中要额外可见。
- 所有论文都写 wiki，不再只写 A 级。为控制成本，survey 卡片轻量、latest 卡片完整。

---

## 8. Prompt 变化

### `paper-survey.md`

新增 Prompt，关键约束：

```text
你是论文调研员（Stage 1: Broad Survey）。

最重要的任务：先找到相关领域的 survey / review / 综述论文。
- 至少要找到 3-5 篇真实、权威、可验证的领域综述。
- 领域综述必须作为整个调查的骨架，cluster 划分必须能追溯到综述 taxonomy。
- 如果找不到足够综述，必须明确标注“该领域综述覆盖不足”，不得假装存在。

然后是建立领域广度地图，不锁定单一方向。
必须返回 surveys、至少 5 个 cluster、至少 60 篇真实论文。
每篇论文必须给出 clusterId、oneLiner、keyFinding、weakness、implication。
综述论文本身也必须进入 papers，并标记 isSurvey=true / role=survey。
```

### `direction-select.md`

新增 Prompt，关键约束：

```text
你是方向选择器。
先读 Stage 1 survey wiki 和 paper_wiki/kg/SUMMARY.md。
优先从综述的 recommendedDirections / openQuestions 和知识图谱中高中心性 cluster / survey 中选择 1-3 个方向。
每个方向必须引用至少 3 篇 survey wiki 或 kg 节点 id。
不要提前进入具体方法设计，不要编造最新论文。
```

### `paper-frontier-miner.md`

新增 Prompt，关键约束：

```text
你是定向前沿矿工（Stage 2）。
只针对给定 direction 查询最新 1-2 年文献。
必须返回真实、可验证、可去重的论文。
如果论文已在 survey 中出现，不要重复写入；只返回新增论文。
```

### `paper-wiki-writer.md`

改造为可接收 `stage`：

```text
You are the Paper Wiki Writer.

Read the Plan section. It contains:
- papers: PaperRecord[]（统一接口，每条自带 stage / role）
- stageHint: survey | latest | mixed（可选，用于批量模式）

Each PaperRecord has the same shape; only the interpretation differs:
- stage=survey: write lightweight survey cards (<=150 words each).
- stage=latest: write full wiki pages (<=300 words each).
- role=survey / isSurvey=true: 在卡片中突出 scope、taxonomy、open questions。
```

---

## 9. 代码改动建议

### `src/agents/types.ts`

新增 RoleName：

```ts
'paper-survey'
'direction-select'
'paper-frontier-miner'
```

### `src/agents/roles/brainstorm.ts`

新增 role specs：

```ts
'paper-survey': {
  sections: ['plan'],
  outputSchema: objectSchema({
    overview: { type: 'string', required: true },
    surveys: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
    clusters: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
    papers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
  }),
},
'direction-select': {
  sections: ['plan'],
  outputSchema: objectSchema({
    directions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
    selectedId: { type: 'string', required: true },
    backups: { type: 'array', required: true, items: { type: 'string' } },
  }),
},
'paper-frontier-miner': {
  sections: ['plan'],
  outputSchema: objectSchema({
    papers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
  }),
},
```

### `src/brainstorm/pipeline.ts`

新增通用类型与归一化模块：

```text
src/brainstorm/paper-record.ts   # PaperRecord / WikiStage / PaperRole
src/brainstorm/normalize.ts      # normalizeSurveyPapers / normalizeFrontierPapers / mergePaperRecords
```

把 `mine` 拆成：

```ts
private async survey(ctx): Promise<SurveyResult>
private async normalizeSurvey(ctx, survey): Promise<PaperRecord[]>
private async writeSurveyWikis(ctx, records)
private async buildKnowledgeGraph(ctx, records, clusters, directions?)
private async selectDirections(ctx, records, kg): Promise<SelectedDirection[]>
private async frontierMine(ctx, directions, existingPool): Promise<PaperRecord[]>
private async normalizeFrontier(ctx, frontierPapers): Promise<PaperRecord[]>
private async mergeAndDedupe(ctx, surveyRecords, frontierRecords): Promise<PaperRecord[]>
private async writeFrontierWikis(ctx, records)
private async rebuildWikiIndex(ctx, records)
private async rebuildKnowledgeGraph(ctx, records, clusters, directions)
```

保留现有 `propose` / `debate` / `scoreAndRank` / `chair` 作为 Stage 2 之后的正式 ideation。

### 新增依赖

```text
graphology                       # 图数据结构和算法
graphology-metrics               # 中心性/密度/模块度等
graphology-communities-louvain   # 社区发现，自动聚类校验
graphology-layout-forceatlas2    # 力导向布局
cytoscape                        # 生成自包含 HTML 可视化
```

可选（如果做 RDF/SPARQL 互操作）：

```text
n3 | rdflib.js
```

### 文件产物

```text
brainstorm/
  SEED.md
  survey_pool.json          # Stage 1 原始返回
  selected_directions.json  # direction-select 结果
  frontier_pool.json        # Stage 2 原始返回
  paper_records.json        # ★ 统一归一化后的 PaperRecord[]，下游唯一事实源
paper_wiki/
  _survey.md
  _directions.md
  _index.md
  s*.md
  l*.md
  kg/
    kg.json
    kg.html
    SUMMARY.md
```

> 已移除旧的 `paper-miner` 兼容路径；新流程只使用 `paper-survey`、`direction-select`、`paper-frontier-miner` 和统一 `PaperRecord`。不再生成 `paper_pool.json`。

---

## 10. 配置项

在 `BrainstormOptions` 增加：

```ts
interface BrainstormOptions {
  idea?: string

  // 两阶段调研
  surveyMinSurveys?: number     // 默认 3，最重要：至少找到 3 篇相关领域综述
  surveyMinPapers?: number      // 默认 60
  surveyMinClusters?: number    // 默认 5
  latestWindowYears?: number    // 默认 1
  latestPerDirection?: number   // 默认 5
  maxSelectedDirections?: number // 默认 3
  wikiMode?: 'light-all' | 'full-selected' // 默认 light-all + full latest

  // 知识图谱
  enableKnowledgeGraph?: boolean // 默认 true
  kgLayout?: 'forceatlas2' | 'circle' | 'grid' // 默认 forceatlas2
  kgCommunityDetection?: boolean // 默认 true，使用 graphology-communities-louvain
}
```

---

## 11. 验收标准

1. **Stage 1 首先找到 ≥3 篇相关领域真实 survey/review 综述**，且综述进入 `paper_wiki/`。
2. 无 human seed 时，系统先产出领域地图，再选 direction，不再一开始锁定单方向。
3. 两阶段论文都归一化为统一的 `PaperRecord[]`，`paper_records.json` 成为下游唯一事实源。
4. `paper_wiki/` 中同时存在 survey 与 latest 两类条目，且都可在 `_index.md` 中检索。
5. `_survey.md` 中有 `Found Surveys`、`Cluster Map`、`Open Problems` 三部分，cluster 能追溯到综述 taxonomy。
6. `direction-select` 的输出能在 `_directions.md` 中找到，且引用 ≥3 篇 survey wiki。
7. `paper-frontier-miner` 返回的最新增量论文都写入 `paper_wiki/`，不与 survey 重复。
8. 现有 brainstorm ideation 仍能基于合并后的 wiki 输出 `input/idea.md`。
9. 自动生成 `paper_wiki/kg/kg.json`、`kg.html`、`SUMMARY.md`，节点至少覆盖 Survey / Cluster / Paper / Direction / OpenProblem。
10. 图谱能够从 survey + frontier 结构化结果确定性重建，不依赖额外 LLM 调用。
11. `direction-select` 可以看到图谱摘要或图谱 JSON，并能定位高中心性综述/子方向。
12. 所有新 role 都有输出 schema；`npm run typecheck` 与 `npm test` 通过。
13. 真实调用中不出现编造论文/URL，重复论文被去重；如果找不到综述，系统必须显式标记综述覆盖缺口而不是假装找到。

---

## 12. 实施路线（建议按阶段落地）

### Phase 1：数据契约与 Prompt

- 新增 `paper-survey` / `direction-select` / `paper-frontier-miner` 三个 role。
- 新增 `paper-survey.md` / `direction-select.md` / `paper-frontier-miner.md`。
- 定义 `SurveyResult`、`SelectedDirection`、`FrontierPaper` 等类型。
- 定义统一的 `PaperRecord` / `WikiStage` / `PaperRole`。
- 实现 `normalizeSurveyPapers()` / `normalizeFrontierPapers()` / `mergePaperRecords()`。
- 修改 `paper-wiki-writer.md`，输入统一为 `PaperRecord[]`，按 `stage` 决定 light/full。
- 测试：单元测试只校验 schema、归一化和 prompt 可加载。

### Phase 2：BrainstormPipeline 两阶段编排

- 把 `mine()` 替换为 `survey()` + `selectDirections()` + `frontierMine()`。
- 保留 `propose/debate/score/chair` 作为正式 ideation。
- 写出 `survey_pool.json`、`selected_directions.json`、`frontier_pool.json`、`paper_records.json`。
- 移除旧 `paper-miner` role 与旧 `paper_pool.json` 产物，不保留兼容路径。

### Phase 3：统一 Paper Wiki

- `normalizeSurveyPapers()` / `normalizeFrontierPapers()` / `mergePaperRecords()` 串联。
- 生成统一 `paper_records.json`，作为 wiki / KG / 索引的唯一输入。
- `writeSurveyWikis()` / `writeFrontierWikis()` / `rebuildWikiIndex()` 全部消费 `PaperRecord[]`。
- `_survey.md` 包含 `Found Surveys` / `Cluster Map` / `Open Problems`。
- `_directions.md` 保存 direction 选择记录。
- 索引加入 `type`、`stage`、`cluster/direction`。

### Phase 4：小型知识图谱

- 安装 `graphology`、`graphology-metrics`、`graphology-communities-louvain`、`graphology-layout-forceatlas2`、`cytoscape`。
- 实现 `src/brainstorm/kg-types.ts` 与 `src/brainstorm/knowledge-graph.ts`。
- 从 survey + frontier 结果确定性构建 KG。
- 输出 `paper_wiki/kg/kg.json`、`kg.html`、`SUMMARY.md`。
- `direction-select` 输入中传入 `SUMMARY.md`。

### Phase 5：验证与调优

- 跑 `npm run typecheck`、`npm test`。
- 用真实一次零 seed 运行验证：
  1. 找到 ≥3 篇领域综述；
  2. 生成 survey wiki + KG；
  3. 选出 direction；
  4. 查到 latest 论文；
  5. 最终输出 `input/idea.md`。
- 记录一次运行成本，若 wiki/图谱太大，再增加摘要截断或聚类降维。

---

## 13. 可选的后续增强

- 为 survey 增加“coverage 缺口检测”：如果某个 cluster 的 latest 论文过少，提示该方向冷门或已死。
- 为 `direction-select` 增加多视角投票（gap / feasibility / novelty），复用现有 brainstorm ranking。
- 把 `paper_wiki` 导出为可跨 run 复用的知识库，而不是单次运行临时文件。
- 若“最新防线”具体指安全/防御类研究，只需要把 direction/seed 限定到该领域，Stage 2 的 frontier miner 仍然按同一机制工作。
