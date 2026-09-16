# A：文献目录、入库与关键词检索 Implementation Plan

**交付状态（2026-09-16）：A1–A5 已实现并通过独立复审。** 以下保留实施时的任务步骤；当前入口、实际测试和边界见[验收记录](../../verification/2026-09-16-research-rag-runtime.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付能导入论文、返回有原文出处的检索结果、保存可重放记录的本地文献库。

**Architecture:** SQLite registry 保存规范记录，hash 对象库保存不可变字节；解析器产生有定位的 span。索引按 generation 发布，检索只消费已发布且有访问权限的资料。

**Tech Stack:** TypeScript ESM、Node >=22.19.0、node:sqlite/FTS5、node:test、parse5、PDF.js。

## Global Constraints

- 遵循[总计划](2026-09-16-rag-research-roadmap.md)的全部边界；这里只新增文献能力，不改变科研结论的准入规则。
- 完整 `packages/...` 路径以仓库根目录表示；省略前缀的 `src/`、`test/`、`scripts/`、`prompts/`、package 文件统一相对 `packages/autoresearch/`。测试命令也在该目录执行。
- `evidenceText` 与生成的 `retrievalText` 分开；hash 证明完整性，不能证明主张被支持。
- 解析完成不代表模型已阅读；模型读取范围只由最终 prompt/工具回执确定。
- 每个 task 的示例测试是首个失败测试，后面的用例表也是必须完成的验收范围。

---

## A1：事务存储、来源契约与能力探针

**Files — Create:**

- `packages/autoresearch/src/literature/contracts.ts`：公共类型与运行时输入校验。
- `packages/autoresearch/src/literature/catalog.ts`：异步 registry API。
- `packages/autoresearch/src/literature/catalog-worker.ts`：SQLite 连接、迁移和事务。
- `packages/autoresearch/src/literature/objects.ts`：原始字节落盘/读取/hash 校验。
- `packages/autoresearch/test/unit/literature-storage.test.ts`。
- `packages/autoresearch/test/fixtures/literature.ts`：临时目录 helper。

**Interfaces — 后续所有任务使用 camelCase；导出历史 schema 时显式转换，不混用 snake_case：**

```ts
export type Hash = string // 校验为 64 位小写十六进制
export type Locator =
  | { kind: 'text'; start: number; end: number; unit: 'utf16'; sourceHash: Hash }
  | { kind: 'html'; anchor: string; start: number; end: number; sourceHash: Hash }
  | { kind: 'pdf'; page: number; itemStart: number; itemEnd: number; sourceHash: Hash }
export interface Visibility {
  projectId: string
  partitionId: string // 服务端授权的曝光分区，不能由模型自行授予
  runId?: string
  split?: string
  roles: string[]
  policyHash: Hash
}
export interface Work {
  id: string; title: string; authors: string[] | null
  aliases: { kind: 'doi' | 'arxiv' | 'url'; value: string }[]
  metadataSources: Hash[]; status: 'candidate' | 'verified_metadata'
}
export interface DocumentVersion {
  id: string; workId: string; versionLabel: string | null
  sourceUrl: string | null; rawHash: Hash; mediaType: string
  fetchedAt: string; visibility: Visibility
  publicationDate: string | null; updatedAt: string | null
  sourceKind: 'abstract' | 'full_text'; license: string | null
}
export interface SourceSpan {
  id: string; workId: string; documentId: string; parserFingerprint: Hash
  kind: 'paragraph' | 'table'; sectionPath: string[]
  evidenceText: string; retrievalText: string; locator: Locator
  contentHash: Hash; visibility: Visibility
  quality: 'accepted' | 'needs_review'; sourceKind: 'abstract' | 'full_text'
  table?: { headers: string[][]; rows: string[][]; caption: string; notes: string[] }
}
export interface AnalysisCard {
  id: string; workId: string; revision: number
  origin: 'author_reported' | 'agent_analysis'; text: string; spanIds: string[]
  verification: 'legacy_unverified' | 'located' | 'reviewed'
  coverage: 'metadata' | 'abstract' | 'sections' | 'full_text'
  generator: { model: string; promptHash: Hash } | null
}
export interface SqlStatement { sql: string; params: (string | number | null)[] }
export interface Catalog {
  transact(statements: SqlStatement[]): Promise<Record<string, unknown>[][]>
  close(): Promise<void>
}
// catalog.ts / objects.ts
export declare function openCatalog(root: string): Promise<Catalog>
export declare function putObject(root: string, bytes: Uint8Array): Promise<Hash>
export declare function readObject(root: string, hash: Hash): Promise<Uint8Array>
```

Catalog SQL API 仅包内部调用，不能暴露为工具/Web API。初始表：`works(id,body)`、`aliases(kind,value,work_id)`、`documents(id,work_id,raw_hash,body)`、`spans(id,document_id,body)`、`cards(id,work_id,revision,body)`、`imports(input_hash,body)`；body 为校验后的 JSON，关系列有外键。aliases 的 `(kind,value)` 唯一，cards 的 `(id,revision)` 唯一。后续 A4/A5 在迁移中增加 generations/receipts 表。

- [ ] 添加 worker 探针测试：最低 Node 与当前 Node 均能创建 FTS5、开启外键、rollback，并在同一路径关闭后重新打开。
- [ ] 写入以下对象完整性测试，先运行确认因模块缺失失败。helper 在同一任务创建：用 `mkdtemp(join(tmpdir(),'ar-lit-'))` 包裹 callback，在 finally 中只删除该测试创建的目录；有 Catalog 的测试必须先 close。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { putObject, readObject } from '../../dist/literature/objects.js'
import { withLibrary } from '../fixtures/literature.ts'
test('重复导入相同原文得到相同对象，读取逐字节一致', async () => {
  await withLibrary(async root => {
    const bytes = new TextEncoder().encode('Table 1: 0.42 ± 0.03')
    const first = await putObject(root, bytes)
    assert.equal(await putObject(root, bytes), first)
    assert.deepEqual(await readObject(root, first), bytes)
  })
})
```

- [ ] 实现 `sha256(bytes)`、临时文件写入/flush/发布、读取复核；对象提交在数据库引用之前。崩溃留下未引用对象可以回收，数据库不得引用尚不存在的对象。
- [ ] 在 worker 中用 `BEGIN IMMEDIATE → statements → COMMIT`，异常 ROLLBACK；启用 `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`，busy timeout 1000ms。每个请求带 requestId；worker 异常终止时拒绝所有 pending promise，不能永久挂起。
- [ ] migration 在事务内写 `PRAGMA user_version`；未知未来版本报 `SCHEMA_TOO_NEW`。数据库损坏报 `CATALOG_CORRUPT`，不能当空库重建。
- [ ] 运行 `npm run build` 后执行 `node --experimental-strip-types --test test/unit/literature-storage.test.ts`；补齐事务中途失败、篡改对象、中文路径、worker 退出、两连接竞争测试。
- [ ] 单独提交 A1 文件；提交信息 `feat(literature): add transactional catalog and immutable source objects`。

## A2：身份归并、论文表头与旧记录导入

**Files:** 新增 `src/literature/identity.ts`、`metadata.ts`、`source-events.ts`、`src/literature/import.ts`、`src/literature/views.ts`、`test/unit/literature-identity.test.ts`、`test/unit/literature-import.test.ts`；修改 `src/brainstorm/paper-record.ts`、`src/brainstorm/pipeline.ts`、`src/brainstorm/wiki-render.ts`。路径均在 `packages/autoresearch/` 下。

**Interfaces:**

```ts
export interface IdentityInput { title: string; doi?: string; arxivId?: string; url?: string }
export interface IdentityResult {
  aliases: Work['aliases']; arxivVersion: number | null; titleKey: string
}
export declare function normalizeIdentity(input: IdentityInput): IdentityResult
export declare function resolveMetadata(input: IdentityInput, options: {
  fetch: typeof fetch; signal: AbortSignal
}): Promise<{ work: Work; rawResponses: Uint8Array[]; conflicts: string[] }>
export interface SourceEvent {
  id: string; documentId: string; createdAt: string
  kind: 'correction' | 'retraction' | 'access_revoked'; sourceHash: Hash; reason: string
}
export declare function recordSourceEvent(catalog: Catalog, event: SourceEvent): Promise<void>
export declare function importLegacy(catalog: Catalog, root: string,
  input: { bytes: Uint8Array; runId: string }): Promise<{ imported: number; skipped: number; conflicts: string[] }>
export declare function listPapers(catalog: Catalog,
  input: { limit: number; afterId?: string }): Promise<{ rows: PaperRow[]; nextId: string | null }>
export interface PaperRow {
  work: Work; versions: DocumentVersion[]; cards: AnalysisCard[]
  acquisition: 'metadata_only' | 'abstract_only' | 'acquired' | 'unavailable'
  parse: 'pending' | 'partial' | 'complete' | 'failed'
  index: 'not_indexed' | 'indexed'; exposureReceiptIds: string[]
}
```

- [ ] 先写身份测试：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIdentity } from '../../dist/literature/identity.js'
test('arXiv 工作身份与文档版本分开', () => {
  const a = normalizeIdentity({ title: 'A', arxivId: 'arXiv:2401.01234v1' })
  const b = normalizeIdentity({ title: 'A', arxivId: '2401.01234v2' })
  assert.deepEqual(a.aliases, b.aliases)
  assert.equal(a.arxivVersion, 1)
  assert.equal(b.arxivVersion, 2)
})
```

- [ ] 运行该测试确认失败；实现 DOI 去 resolver 前缀/大小写标准化、arXiv 新旧 ID 及版本分离、URL 主机标准化。URL 不任意删除 query，不 lower-case 整条 URL。
- [ ] 归并规则：相同已验证 alias 可归到同一 Work；输入同时命中两个 Work 时创建 conflict，不自动合并；只有标题时创建 provisional Work，以导入来源 hash+记录位置防止重复导入。模型提供的 DOI 只作为 candidate alias，核对元数据后才能作为跨记录合并依据。
- [ ] metadata adapter 按 DOI 查询 Crossref、按 arXiv ID 查询官方元数据；保存原响应、时间、HTTP 状态与字段来源，标题/作者/标识符有冲突则维持 candidate。缺 DOI 的论文可用 arXiv/已核对出版社记录验证，不强制每篇都有 DOI；只有 URL/标题时保留待核对，不能让模型补全作者。API 429 按 Retry-After 有界重试，失败回传缺口。接口依据见[已读入库笔记](../../../research/2026-09-16-autoresearch-review/rag-ingestion-notes.md)。
- [ ] 显式元数据 refresh 或人工核对可以登记更正/撤稿/访问撤销 SourceEvent，保留证据 hash 和事件时间；不因文献更新就篡改旧版本。撤销访问后不能继续通过旧缓存读正文；允许保留的最小历史 metadata/hash 按原项目规则保存。
- [ ] `importLegacy` 读取旧 JSON 并保存原始字节；同一 import hash 幂等。旧 insight → `legacy_unverified` card，旧 abstract 来源不明时同样是 card，不能伪造原文 span。已有 PDF 仅在实际重算 hash、核对标题/版本后登记。
- [ ] 新表头按设计报告的 15 字段映射 `PaperRow`；未知作者显示“未核实”，未阅读显示“未阅读”；解析和索引状态不能冒充模型读取状态。为 PaperMeta 增加可选 `workId`/`documentVersionId`，不改变旧必填字段。
- [ ] 导入在显式开启 literature 时执行；pipeline 仍输出兼容 `paper_records.json`，新增 canonical ID 映射文件。wiki 新增阅读范围和来源链接，不改变 KG 的含义。
- [ ] 构建后分别执行 `literature-identity.test.ts`、`literature-import.test.ts`；覆盖 DOI 大小写、相同标题不同论文、冲突别名、重复导入、旧 JSON 缺字段和非法 schema。
- [ ] 提交 `feat(literature): register paper identity and migrate legacy cards`。

## A3：获取原文、解析与片段定位

**Files:** 新增 `src/literature/acquisition.ts`、`src/literature/parsing.ts`、`src/literature/parsers/text.ts`、`html.ts`、`pdf.ts`、`src/literature/spans.ts`；新增 `test/unit/literature-parsing.test.ts`、`test/unit/literature-acquisition.test.ts` 和 `test/fixtures/literature/` 下的双栏/表格/摘要/损坏源；修改 `src/paper/references.ts`、`package.json` 与本包 lockfile。

**Interfaces:**

```ts
export interface ParseInput { document: DocumentVersion; bytes: Uint8Array }
export interface ParseResult {
  spans: SourceSpan[]; parserFingerprint: Hash
  status: 'complete' | 'partial' | 'failed'
  issues: { code: string; locator: Locator | null; message: string }[]
}
export interface Parser { fingerprint: Hash; parse(input: ParseInput): Promise<ParseResult> }
export interface FetchReceipt {
  requestedUrl: string; finalUrl: string; fetchedAt: string
  status: number; contentType: string; rawHash: Hash | null
  error: 'timeout' | 'unavailable' | 'too_large' | 'invalid_type' | null
}
export declare function acquire(root: string, url: string,
  options: { fetch: typeof fetch; signal: AbortSignal; maxBytes: number }): Promise<FetchReceipt>
export declare function parseText(input: ParseInput): Promise<ParseResult>
export declare function parseHtml(input: ParseInput): Promise<ParseResult>
export declare function parsePdf(input: ParseInput): Promise<ParseResult>
```

- [ ] 先写 HTML 表格测试：fixture 使用 `<table><caption>Latency (ms)</caption><tr><th>Method</th><th>p95</th></tr><tr><td>A</td><td>12.5</td></tr></table>`，登记为已保存原文并构造完整 DocumentVersion。测试断言：

```ts
const parsed = await parseHtml({ document, bytes })
const table = parsed.spans.find(span => span.kind === 'table')
assert.deepEqual(table?.table?.rows, [['A', '12.5']])
assert.equal(table?.table?.caption, 'Latency (ms)')
assert.equal(table?.locator.sourceHash, document.rawHash)
assert.equal(table?.sourceKind, 'full_text')
```

DocumentVersion fixture 的 id/workId 固定为 `doc-html`/`work-html`，rawHash 实际计算，mediaType=`text/html`，versionLabel/sourceUrl/publicationDate/updatedAt/license 为 null，fetchedAt 固定 ISO 字符串，visibility 使用该 fixture 项目、`public-literature` 分区、空 run/split 与所有测试角色。不得使用虚构全零 hash 通过来源核验。

- [ ] 确认测试失败后安装锁定 `parse5@8.0.0`、`pdfjs-dist@6.3.289`，并检查最低 Node 的安装/build；后者与现有 Web PDF.js 版本一致。参考作者[parse5 tag](https://github.com/inikulin/parse5/tree/v8.0.0)、[PDF.js release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289)。
- [ ] HTML 用 `parse5.parse(html,{sourceCodeLocationInfo:true})`，按 DOM 章节和段落提取；忽略 script/style/nav，保留表格 caption/header/footnote。HTML start/end 是原始解码字符串 UTF-16 offset，anchor 记录稳定 DOM 路径；无 id 不编造出版社锚点。
- [ ] PDF 用 `getDocument({data: bytes}).promise` 和逐页 `getTextContent()`；保存 page、text item 区间及转换后的页坐标（如具备），页码从 1 开始。双栏阅读顺序不可靠、乱码或无文本页标 needs_review；首版不自动把 PDF 文本拼成可靠表格。释放 page/document 资源，解析任务可取消。
- [ ] 文本保留原解码字符串，normalize 后另存 retrievalText，避免 offset 漂移。按章节/段落切分，首版默认最大 2000 Unicode code points，父段/邻段 ID 保存到解析报告；大段按句界拆分，表格按完整行拆分并重复表头。该字符预算不冒充模型 token 数；后续开发集比较 chunk 配置。
- [ ] acquire 流式读取，默认 30s deadline/32MiB 上限，按实际字节截断；重定向后同样核对类型、大小与来源。fetch mock 可注入；source_unavailable 不自动换成生成摘要。搜索 adapter 必须保存 query/provider/time/raw-response hash；首版入口接受宿主的显式搜索回执和本地登记文件。
- [ ] references 复用获取与对象存储，但保持旧 citations.json/旧下载接口返回值兼容。GET 阅读端点不能调用 acquire。
- [ ] 构建并运行两个测试文件；覆盖中英/CRLF offset、抽象全文区别、HTML 表头合并单元格、损坏 PDF、扫描页、超时、过大响应、已有 PDF hash 不符。
- [ ] 提交 `feat(literature): ingest source versions and locate parsed evidence`。

## A4：可重建索引 generation 与中英关键词基线

**Files:** 新增 `src/literature/tokenize.ts`、`src/literature/index-generation.ts`、`src/literature/lexical.ts`、`test/unit/literature-index.test.ts`、`test/integration/literature-index-recovery.test.ts`；扩展 A1 migration。

**Interfaces:**

```ts
export interface IndexGeneration {
  id: string; manifestHash: Hash; corpusHash: Hash; configHash: Hash
  partitionIds: string[]; documentIds: string[]; spanIds: string[]
  status: 'building' | 'validated' | 'active' | 'retired' | 'failed'
  tokenizerVersion: 'cjk12-en-v1'; createdAt: string
}
export interface BuildOptions { expectedActiveId: string | null; maxSpans: number }
export declare function tokenize(text: string): string[]
export declare function buildGeneration(catalog: Catalog, root: string,
  spans: SourceSpan[], options: BuildOptions): Promise<IndexGeneration>
export declare function publishGeneration(catalog: Catalog, root: string,
  id: string, expectedActiveId: string | null): Promise<void>
export declare function getActiveGeneration(catalog: Catalog): Promise<IndexGeneration | null>
```

- [ ] 添加 tokenizer 测试并确认失败：

```ts
import { tokenize } from '../../dist/literature/tokenize.js'
assert.ok(tokenize('反证 RAG-2').includes('反证'))
assert.ok(tokenize('反证 RAG-2').includes('反'))
assert.ok(tokenize('反证 RAG-2').includes('rag'))
assert.deepEqual(tokenize('   '), [])
```

- [ ] 规则固定：NFKC+英文小写用于检索字符串；英文数字连续段、汉字 unigram 与相邻 bigram；原文不改。不要把未转义 query 直接交给 MATCH；将合法 token 逐个引用后 OR 组合，最多 64 token，空输入返回 invalid_query。
- [ ] 为每个曝光分区构建独立 FTS5 表/文件，避免隐藏资料参与可见语料 IDF/向量训练。`title,section,body` 权重先固定为 `3,2,1` 并记入 configHash；BM25 排序分数低者优先，相同分数按 span ID 排序。分区只能来自服务端授权，不接受模型指定新分区。
- [ ] 每个 generation manifest 绑定所有 raw/parser/chunker/tokenizer 指纹及排序配置；版本变化创建新 generation。进度在文档级 checkpoint，复用须同时匹配来源与处理指纹。
- [ ] 构建到 staging，校验 span 数、来源可读/hash、FTS 一致性后关闭/flush index 文件并原子发布目录；随后事务 CAS 更新 active 指针。指针 CAS 失败保留 validated generation，不能覆盖他人刚发布的版本。
- [ ] 旧 active 标 retired 但仍可被 pinned run 读取；failed/staging 不可被检索。当前权限变化由查询时策略再校验，不能靠旧 generation 放行。
- [ ] catalog 增加 `generation_pins(run_id,generation_id,created_at)`，复合键唯一；回收仅删除无任何 pin/receipt 引用且已 retired 的派生索引。原文删除/保留走来源权限规则，不能以“可重放”为由忽略撤销要求。
- [ ] 故障测试：在写第 N 文档、发布目录后/更新指针前退出；重启读取旧 active，完成新版发布后切换一次。双 publisher 只有一个 CAS 成功。缺失对象停止构建而非跳过后宣称完整。
- [ ] 构建后运行两个测试文件，提交 `feat(literature): publish reproducible lexical index generations`。

## A5：检索、回执和可独立使用的命令入口

**Files:** 新增 `src/literature/retrieve.ts`、`src/literature/receipts.ts`、`src/literature/index.ts`、`scripts/literature.mjs`、`test/unit/literature-retrieval.test.ts`、`test/integration/literature-cli.test.ts`；修改 `package.json` 添加 `./literature` export，migration 增加 receipts/exposures。

**Interfaces:**

```ts
export interface RetrievalRequest {
  query: string; generationId: string; projectId: string; runId: string
  role: string; purpose: 'survey' | 'baseline' | 'revision' | 'citation'
  split?: string; partitionIds: string[]; policyHash: Hash
  requiredSpanIds?: string[] // 来自服务端已登记的反证/冲突关系
  maxResults: number; maxChars: number
}
export interface RetrievalHit { span: SourceSpan; rank: number; score: number; route: 'lexical' | 'dense' | 'hybrid' }
export interface RetrievalReceipt {
  id: string; request: RetrievalRequest; candidateSpanIds: string[]
  selectedSpanIds: string[]; manifestHash: Hash; createdAt: string
  outcome: 'ok' | 'no_match' | 'source_unavailable' | 'parse_failed' | 'budget_exhausted'
  elapsedMs: number; modelCost: number | null
}
export interface ExposureReceipt {
  id: string; previousId: string | null; retrievalReceiptId: string; callId: string; actor: string
  spanIds: string[]; renderedHash: Hash
  status: 'prepared' | 'sent' | 'unknown'
}
export declare function retrieve(catalog: Catalog, root: string,
  request: RetrievalRequest): Promise<{ hits: RetrievalHit[]; receipt: RetrievalReceipt }>
export declare function recordExposure(catalog: Catalog, receipt: ExposureReceipt): Promise<void>
export declare function replay(catalog: Catalog, root: string,
  receiptId: string): Promise<{ spans: SourceSpan[]; manifestHash: Hash }>
```

- [ ] 首个测试构建两个项目/分区，各含同一检索词；通过已授权分区检索，检查不返回另一分区。测试同时断言：

```ts
assert.ok(result.hits.every(hit => hit.span.visibility.projectId === request.projectId))
assert.deepEqual(result.receipt.selectedSpanIds, result.hits.map(hit => hit.span.id))
assert.equal((await replay(catalog, root, result.receipt.id)).manifestHash,
  result.receipt.manifestHash)
```

测试数据使用 A3 的登记/解析和 A4 构建 API；禁止手工伪造未保存的 span 绕过来源验证。request 中 generationId 来自 buildGeneration，policyHash 与 fixture 的服务端策略一致。

- [ ] 实现 `validate scope → 打开 pinned generation → 过滤授权分区/文档 → 排序 → 重叠去重 → 完整 span 装包 → 保存 receipt`。requiredSpanIds 即使没有进入关键词 top-k 也按 ID 加载并核对版本/权限，写入候选与最终选择记录；缺失/无权读取返回 REQUIRED_SOURCE_UNAVAILABLE，必需集合超过 maxChars 返回 LITERATURE_CONTEXT_INSUFFICIENT。不把完整 span 截断成半行；预算不足时只减少可选 span，B1 再与内部必要记录一起做整体 context 闭包。
- [ ] 将实际发送记录与检索记录分开：检索选中不等于入 prompt；B1 最终 context 排除掉的片段不能出现在该 call 的 exposure。调用前持久化 prepared，发送后以新 ID/previousId 追加 sent 事件；崩溃不确定则追加 unknown，科学数据曝光按保守规则处理。不得覆盖原回执。
- [ ] 增加命令 `import --project --records`、`ingest --project --manifest`、`index --project`、`search --project --query --generation`、`replay --project --receipt`；参数解析拒绝未知 flag，输出 JSON。ingest manifest 显式列出已登记本地文件或 URL、工作身份、来源种类和权限。
- [ ] 添加示例命令到 `packages/autoresearch/README.md`：`node scripts/literature.mjs search --project ./test-project --query '反证' --generation <已返回的generationId>`。真实 ID 取前一个命令输出，不在代码里硬编码示例。
- [ ] CLI 子进程测试使用测试生成的真实临时项目与 JSON；检索/replay 不联网。覆盖零命中、generation 不存在、撤销访问、短中文查询、恶意 MATCH 运算符作为普通文本、相同输入排序稳定、receipt 篡改。
- [ ] 构建后运行两个测试文件与 `npm run typecheck`，再执行核心包 `npm test`；提交 `feat(literature): add scoped retrieval receipts and CLI`。

## A 完成标准

- [ ] 同一来源/配置重复入库不会产生无意义重复资料；全文、摘要、未核实旧卡片可明确区分。
- [ ] 每个可引用结果回到特定原文版本与定位；无法定位的片段不进入正式引用包。
- [ ] Windows 中文路径、最低 Node、损坏来源、重启索引和访问变化用例均有结果记录。
- [ ] 本计划的来源、检索、命令行及恢复用例通过；不依赖 C1 benchmark，不声称优于其他检索方法。
