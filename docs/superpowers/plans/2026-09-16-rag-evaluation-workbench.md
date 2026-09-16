# C：评测、文献阅读界面与检索增强 Implementation Plan

**交付状态（2026-09-16）：C2 与 C4 功能测试及实际两小时运行已通过；C1/C3 暂缓。** 以下保留实施时的任务步骤，实际结果及启动版本边界见[验收记录](../../verification/2026-09-16-research-rag-runtime.md)。24 小时运行未执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供从论文目录跳转到原文证据的阅读入口，并验证研究闭环与作业恢复的正确性。

**Architecture:** Web 只使用服务端已登记 ID，全链路测试复用 A/B 的来源、科研状态和作业回执。benchmark 与混合检索对照保留为暂缓设计，不作为当前依赖。

**Tech Stack:** 核心包 Node/TypeScript 测试与 CLI、Web React/PDF.js、独立评估进程/隔离执行环境、现有 provider 接口。

## Global Constraints

- 最新用户指示：benchmark 暂时不管。**当前只执行 C2、C4；C1/C3 暂缓。** 暂不制作 benchmark 数据、任务集、评分系统或消融报告；必要的软件测试继续保留。

- 遵循[总计划](2026-09-16-rag-research-roadmap.md)；不把 pilot 规模当作统计充分性。
- 完整 `packages/...` 路径相对仓库根；未标 Web 的 `src/`、`test/`、`scripts/` 路径相对 `packages/autoresearch/`，标 Web 的相对 `packages/autoresearch-web/`。
- 资料原文可以包含论文答案；隐藏的是参考标签、评估器和正式实验测试数据，两者规则不能混同。
- 模拟、真实 provider 和长时间运行结果分开；没有实际运行记录时不能填入“通过”。
- GraphRAG、视觉/OCR、多机调度属于触发后另行设计的扩展，不是本轮交付的隐含依赖。

---

## C1：冻结试点与独立 evaluator（暂缓，不执行）

**Dependencies:** 与 A1 并行设计 task card；检索运行依赖 A5，执行任务依赖 B4。

**Files — Create:**

- `packages/autoresearch/src/benchmark/contracts.ts`、`manifest.ts`、`retrieval-evaluator.ts`、`execution-evaluator.ts`、`report.ts`。
- `packages/autoresearch/scripts/benchmark.mjs`。
- `packages/autoresearch/benchmarks/pilot/public/tasks.json`、`corpus-manifest.json`、`README.md`。
- `packages/autoresearch/test/unit/benchmark-retrieval.test.ts`、`benchmark-manifest.test.ts`、`test/integration/benchmark-isolation.test.ts`。
- 人工 gold 存 evaluator 专属目录，**不放 Agent 可读工作区**；公开测试中的 synthetic gold 只验证计分代码，不充当正式隐藏评测。

**Interfaces:**

```ts
export interface BenchmarkManifest {
  schema: 'autoresearch/benchmark/v1'; id: string; taskFamily: string
  source: { upstream: string | null; revision: string | null; license: string }
  publicInputs: { path: string; sha256: string }[]
  corpusHash: string | null; evaluatorVersion: string; environmentHash: string
  metric: { name: string; direction: 'min' | 'max'; tolerance: number }
  limits: { wallMs: number; modelTokens: number; costMicros: number }
  feedback: 'dev_only' | 'none'; finalHoldoutId: string
}
export interface RetrievalGold {
  questionId: string; workFamily: string; answerable: boolean
  relevantSpanIds: string[]; opposingSpanIds: string[]
  requiredConditions: string[]
}
export interface RetrievalScore {
  recall: number | null; reciprocalRank: number | null
  opposingRecall: number | null; invalidCitationCount: number
}
export declare function scoreRetrieval(gold: RetrievalGold,
  retrievedIds: string[], availableIds: string[]): RetrievalScore
export declare function verifyManifest(root: string, manifest: BenchmarkManifest): Promise<void>
```

- [ ] 写计分器测试并确认失败：

```ts
const gold = { questionId: 'q1', workFamily: 'w1', answerable: true,
  relevantSpanIds: ['s1','s2'], opposingSpanIds: ['s2'], requiredConditions: ['same budget'] }
const score = scoreRetrieval(gold, ['s1','s1','made-up'], ['s1','s2'])
assert.equal(score.recall, 0.5)
assert.equal(score.opposingRecall, 0)
assert.equal(score.invalidCitationCount, 1)
```

- [ ] 去重后计算 Recall@k/MRR；无 relevant gold 的问题 recall 为 null，不填 1。加 nDCG 时另存明确 graded relevance，不把相似度当人工相关等级。支持率由 claim-span 金标/校准审查计算，hash 只检验出处。
- [ ] 选择 20 个不同 work、40 个人工核对问题，按 work family 分 dev/test（目标各 10 work/20 问，跨论文问题相关 work 同组）。覆盖单篇方法/数值8、多篇比较8、反证8、无答案8、中英短词/版本问题8；类别允许重叠时在 manifest 明记，不能混加总数。
- [ ] 每个答案记录原文版本/位置、适用条件、支持与反证，第二次复核有争议项。受版权限制的正文不直接提交仓库，只保留允许分发的 fixture 或下载/hash manifest；全文不可获取作为单独 access track，不混进全文可见对照。
- [ ] 第一轮执行 pilot 固定 3 张 CPU 任务卡：

| task | Agent 输入 | 产物与确定性裁判 | 研究意义/边界 |
|---|---|---|---|
| `linear-regression-shift-v1` | 合成 train/dev CSV、标准化+ridge starter、允许修改的正则化/特征规则 | 预测 CSV、代码、reproduce 脚本；独立 test MSE，检查行数/ID/有限数值 | 测 baseline、开发反馈、正式分割和数值复现，不声称真实领域发现 |
| `nonlinear-classification-v1` | 含非线性及冗余特征的 train/dev、线性分类 starter | 预测概率、特征选择/模型代码；独立 test log loss | 测失败→新假设和成本约束，不同 seed 嵌套在任务内 |
| `inclusive-prefix-sum-v1` | 公开函数接口与小样例、朴素参考性能 | Node 模块导出 `prefixSum(input: Float64Array): Float64Array`；隐藏边界输入先正确性，再固定机器计时 | 借鉴 RE-Bench 的可执行优化结构；这是自建 CPU 任务，不能报告成 RE-Bench 原分数 |

- [ ] task 环境首版使用固定 Node 和 lockfile，不依赖 GPU。数据 generator/evaluator 放独立评估环境；公开 train/dev 可复用，test seed/labels 不挂载。数值任务由模型提交算法，评估器重新执行，不信任其自报 metrics.json。
- [ ] 数据生成器固定为版本化 PRNG + Box–Muller 标准正态，训练/开发/正式样本数1200/400/400、特征8维。回归目标 `y=3*x0-2*x1+0.1*noise`，后6个无关特征在 train/dev/test 的尺度分别为1/10/10；分类目标以 `sigmoid(2*x0*x1-x2)` 采样标签。train/dev seed 为17/23，正式 seed 在 evaluator 冻结且不公开。公式作为公开任务定义，允许解析基线；这两项只测执行、分割与复现能力，不能计为“发现未知机制”。log loss 概率裁剪到 `[1e-7,1-1e-7]`。
- [ ] prefix sum 裁判覆盖长度0/1/31/1024/10000/1000000及整数值[-4,4]，先与参考实现逐项比对，再固定机器热身5轮/测量30轮取中位数；记录机器负载与运行时版本。三个任务的 evaluator 都先用正确参考提交、错列/NaN/作弊自报分数提交验证，再允许评模型。
- [ ] 真正 provider 评测采用独立容器或 OS 身份：Agent 只可读 public input 和自身输出，evaluator gold 不在其挂载/工具路径中。仅分两个目录不算隔离；若宿主工具仍可读 gold，拒绝运行 hidden track。实际环境镜像/运行时 digest 在冻结 manifest 时取得并写入，拒绝浮动 tag。
- [ ] task manifest 预算全部为必填、正值；实际运行前冻结同模型/上下文/总费用，不设置“无限”默认值。开发反馈可进入 successor；最终 test 只在最终提交评分。多个查询预算的在线反馈实验须另有不反馈 holdout。
- [ ] 添加入口 `node scripts/benchmark.mjs validate --manifest <file>`、`run --manifest <file> --arm <name> --output <dir>`；默认不启用真实 provider，传 `--provider real` 才读取现有 provider 配置且仍受预算约束。
- [ ] 构建后运行三个测试；隔离测试注入特殊 hidden marker，检查 prompt、embedding输入、日志、缓存无该内容，并从 Agent 执行环境直接尝试读 gold 路径应失败。完整隔离还需核查挂载/工具边界，marker 测试不是单独充分证明。
- [ ] 提交 `feat(benchmark): freeze pilot tasks and independent evaluators`。

## C2：文献目录、检索与 PDF/HTML 原文跳转

**Dependencies:** A5；不依赖实验 job 全部完成。

**Files — Create:** `packages/autoresearch-web/src/literature.js`、`literature-client.js`、`literature.css`、`test/literature.test.mjs`、`test/literature-browser.mjs`。

**Modify:** Web `src/index.js`、`core-bridge.js`、`contract.js`/`.d.ts`、`workbench-client.js`、`workbench-assets.js`、`package.json`；核心新增 `src/literature/service.ts`，通过 `./literature` export 提供受限 API。

**Interfaces — 在现有 `/api/autoresearch` 下：**

```text
GET  /literature/papers?projectId=&afterId=&limit=
GET  /literature/search?projectId=&q=&generationId=
GET  /literature/source?projectId=&documentId=       支持 PDF Range
GET  /literature/span?projectId=&spanId=&generationId=
POST /literature/import                            显式入库
POST /literature/index                             显式构建，返回 operationId
GET  /literature/operations?projectId=&operationId=  只读进度
```

服务端先用现有 project registry 找 root，再核对 document/span 所属项目与访问策略。客户端不传本地路径。POST 沿用现有 same-origin/CSRF；GET 不触发下载/解析/索引/实验。source 返回原始 PDF 或经过服务端抽取的安全文本视图，不直接同源执行外部 HTML。

核心 `LiteratureService` 方法映射：`listPapers`→A2分页；`search`→A5 retrieve；`getSource(documentId)`→校验后读取 DocumentVersion/对象；`getSpan(spanId,generationId)`→验证归属后读 SourceSpan；`importSources(manifest)`→A2/A3；`buildIndex()`→A4；`getOperation(operationId)`→持久化操作记录。前三个读接口和 getSpan 不执行模型调用，write 接口返回 `{operationId,status}`，异常使用固定 `{code,message}`，不返回本地路径或原始堆栈。

- [ ] 先写 API 测试：通过已登记文档取 PDF range，检查 206/Content-Range；错误 project/document 组合返回404；读取函数调用计数变化，而 acquire/index 调用次数为0。

```js
assert.equal(response.statusCode, 206)
assert.equal(response.headers['content-type'], 'application/pdf')
assert.equal(hooks.acquireCalls, 0)
assert.equal(hooks.indexCalls, 0)
assert.equal((await otherProjectRequest()).statusCode, 404)
```

测试沿用 `test/workbench.test.mjs` 的 mock req/res，新增 literature handler 的依赖注入对象：`getProject, listPapers, search, getSource, getSpan, importSources, buildIndex, getOperation`；每项均由核心 service 对应方法实现，测试提供计数 stub。

- [ ] 实现分页、generation 指定与 span 查询；search query 最长 2000 字符，limit 1–100；无 generation 返回“尚未建索引”状态，不自动启动 index。索引操作状态单独为 queued/running/completed/failed，不借用科学 run 状态。
- [ ] 列表默认展示标题、作者、年份/版本、读取范围、相关性、入库状态；其余 15 字段通过展开详情/列设置展示。只有摘要、解析部分失败、引用待核对要有清楚文字。
- [ ] 命中结果显示原文摘录、章节/页码、版本与引用按钮；点击 PDF 定位页码，有可靠坐标才高亮；缺坐标只显示页+摘录。HTML 用纯文本/受控结构展示，不执行原文脚本。
- [ ] 请求绑定 project/document/generation/requestId；快速切项目/切版本时 AbortController 取消旧请求，旧响应不能覆盖新视图。复用现有 PDF.js 加载/销毁处理。
- [ ] 在 Web package test 脚本加入 literature.test.mjs，新增 `test:literature:browser`。浏览器场景包括切项目、版本变化、404/无法全文、局部解析、中文搜索、键盘操作和长标题布局。
- [ ] 运行 Web `npm run build`、`npm test`、`npm run test:literature:browser`，必要时现有 `test:workbench:browser`；提交 `feat(web): browse registered literature and cited source spans`。

## C3：混合召回与有界 rerank 的实验开关（暂缓，不执行）

**Dependencies:** A5 + C1 的冻结检索集；只有 lexical 基线报告已存在才启动。

**Files:** 新增核心 `src/literature/embedding.ts`、`hybrid.ts`、`rerank.ts`、`test/unit/literature-hybrid.test.ts`、`test/integration/literature-retrieval-ablation.test.ts`；扩展 index manifest、settings 与 benchmark arms。

**Interfaces:**

```ts
export interface EmbeddingAdapter {
  model: string; revision: string; dimensions: number
  embed(texts: string[], signal: AbortSignal): Promise<{
    vectors: number[][]; inputTokens: number; costMicros: number | null
  }>
}
export interface RankItem { id: string; score: number }
export declare function reciprocalRankFusion(lists: RankItem[][],
  rankConstant: number): RankItem[]
export interface Reranker {
  model: string; revision: string
  rank(query: string, spans: SourceSpan[], signal: AbortSignal): Promise<RankItem[]>
}
```

- [ ] 写 RRF 测试并确认失败：

```ts
const ranked = reciprocalRankFusion([
  [{id:'a',score:100},{id:'b',score:1}],
  [{id:'b',score:0.99},{id:'a',score:0.98}],
], 60)
assert.equal(ranked[0]?.score, 1/61 + 1/62)
assert.deepEqual(ranked.map(x => x.id), ['a','b']) // 同分稳定 ID 排序
```

- [ ] 先接一个已配置且可计量的 embedding provider，模型/revision/dimension/归一化/输入前缀写入 configHash。缺 provider 时明确 unavailable，不能静默调用另一个收费模型。初版精确 cosine 搜索，不引入 ANN 服务。
- [ ] 缓存键为 source span hash + retrievalText hash + encoder revision + 输入配置 + exposure partition；文档版本/处理配置变化只重算受影响项。维数错误、NaN、空向量拒绝发布 generation。
- [ ] lexical/dense 各召回最多40，RRF 默认 k=60 合并、同源重叠去重；rerank 最多40候选，输出 ID 必须是输入子集且唯一，不能改写 evidenceText。k/topN 是冻结的基线参数，不宣称最优。
- [ ] embedding、query rewriter、reranker 与生成器均记 actor exposure；隐藏资料不可因中间模型调用泄漏。超时/预算不足可退回 lexical，但 receipt 必须写实际 route、失败原因和已消耗费用，报告按 fallback 分层。
- [ ] 对照 arms：cards、lexical、dense、hybrid、hybrid+rerank、同预算 long-context，oracle evidence 仅诊断上界。固定 corpus/access track、chunker、生成模型、上下文和总预算；索引成本另列并报告多轮摊销。
- [ ] 开发集选参数后冻结，一次性运行 test。默认模式升级的拟定门槛：无来源/隔离回归，检索召回和答案支持有改善证据，总费用在 task cap 内；pilot 置信度不足则继续保留 lexical。不能在反复查看同一 test 后修改配置再称独立验证。
- [ ] 构建后运行两个测试文件；运行真实模型评测必须有实际预算配置与回执。提交 `feat(literature): add evaluated hybrid retrieval adapters`。

## C4：全链路、恢复与长时间运行验收

**Dependencies:** B4；不依赖 C1/C3 或 benchmark 数据。

**Files:** 新增 `packages/autoresearch/test/integration/research-rag-e2e.test.ts`、`runtime-soak.test.ts`、`scripts/runtime-soak.mjs`、`test/fixtures/jobs/soak-config.json`；修改核心/Web README 与根待办的完成证据链接。

**Interfaces:** 复用 A5 receipts、B3 JobReceipt、B4 ArtifactManifest，不依赖 BenchmarkManifest。soak 配置为 `{schema:'autoresearch/soak/v1',jobs:JobSpec[],restartAfterMs:number[],outputDir:string}`，由本地受控作业组成；输出 `{runId,startedAt,endedAt,controllerRestarts,duplicateSubmissions,lostResults,unresolvedJobs,peakRssBytes,logBytes,budgetAfterRestart}`，每项由原始日志/数据库查询计算。

- [ ] 先写端到端 fixture：论文方法支持 H1→dev 有效阴性→保留反证→候选 H2→新 protocol/job→独立验证。断言每一新候选都有父版本及可回查来源，不能由 fake provider 直接写 supported 状态。

```ts
assert.equal(report.duplicateSubmissions, 0)
assert.equal(report.lostResults, 0)
assert.ok(report.budgetAfterRestart.spent >= beforeRestart.spent)
assert.equal(finalSnapshot.hypotheses.find(h => h.id === revisedId)?.version, revisedVersion)
```

report 来自对 job/usage/准入 key 的实际扫描，beforeRestart 为控制器退出前持久化读数；不得把计数器默认0当通过。

- [ ] 快速 CI 用真实子进程完成3–5分钟恢复测试：提交窗口、收集窗口、索引更新、取消、磁盘写错误。受控 fault hook 仅在测试编译/测试配置中可用。
- [ ] 本地可靠性验证运行2小时：固定每个任务1–5分钟，控制器至少重启3次；包含一个取消未确认与一个强制 unknown，用于证明暂停行为。无真实模型也可验证，但报告明确标为本地受控作业。
- [ ] 24小时持续验证独立于默认单测，通过 `node scripts/runtime-soak.mjs --duration-hours 24 --config test/fixtures/jobs/soak-config.json --output <dir>` 显式启动；监督器负责预算/日志/磁盘上限，执行方跟踪直到终态并收集报告，不能只启动后台进程就标完成。
- [ ] 真实 provider 的 benchmark 运行暂缓；已有 docs/drafts/TODO-addendum 中的真实 CPA 验证保持原状态，不能以这里的 mock/恢复测试勾选完成。
- [ ] 最终功能验证记录包含环境与代码指纹、闭环调用轨迹、检索/曝光/上下文记录、产物 hash、资源账本、恢复事件和未解决项。当前不制作 main/各组件性能对照、消融或科研质量评分。
- [ ] 核心 `npm run typecheck`、`npm test`；涉及 Web 时跑对应完整检查。提交 `test(research): verify grounded research and durable execution end to end`；只有相关真实证据已保存才勾选对应实现待办。

## 扩展触发条件

| 扩展 | 启动依据 | 新增实验 |
|---|---|---|
| GraphRAG/引用多跳 | 多论文关联问题反复漏检，单跳与 rerank 无法解决 | 同语料/预算的图检索消融，计入建图和增量刷新成本 |
| OCR/视觉表格 | 未回答问题主要由扫描页或表格解析失败引起 | 页/单元格级解析金标，数值/单位/脚注准确率 |
| ANN/外部向量库 | 精确搜索延迟或内存实测超过产品预算 | recall–latency–memory 对照与索引恢复测试 |
| 远程作业/多机 | 本地资源不足且有明确授权后端 | 该后端 submit/inspect/collect/cancel 能力验证和提交窗口故障注入 |

这些扩展不作为首批完成条件，也不预先安装其依赖。
