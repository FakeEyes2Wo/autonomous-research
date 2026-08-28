# Brainstorm 精选论文流程设计

## 目标

在 brainstorm 阶段，从已收集的论文记录中自动筛选出一份“精选论文”：

- 优先近两年论文；
- 近两年内越新越好；
- 引用数高；
- 被广泛认可（会议/综述/landmark/A 级信号）；
- 输出统一放在：
  ```text
  <runDir>/brainstorm/
  ```

## 输入

- `PaperRecord[]`
  - 来自：
    - `brainstorm/paper_records.json`
    - survey papers + frontier papers
  - 每个记录已包含：
    - `year`
    - `venue`
    - `citations`
    - `role`
    - `stage`
    - `clusterId` / `directionId`
    - `relevance`
    - 等字段

## 输出

1. 主数据文件：
   ```text
   <runDir>/brainstorm/curated_papers.json
   ```

2. 可读 Markdown：
   ```text
   <runDir>/brainstorm/curated_papers.md
   ```

3. 不写到当前目录、不写到 `paper_wiki/`，只写 `brainstorm/`。

## 保底数量

- 最终必须保留 **20 篇**。
- 如果满足“近两年”的论文不足 20 篇，则用其他论文补齐到 20 篇。
- 如果总论文数不足 20 篇，则输出全部可用论文，不强行虚构。

流程：

```text
第一轮：筛选近两年论文，按 score 排序，取前 20
第二轮：如果不足 20，从剩余论文中按 score 继续补
最终：curated_papers 固定输出 min(total, 20) 篇
```

## 精选规则

### 核心评分

```text
score = recency * 0.4 + citation * 0.35 + recognition * 0.25
```

### 1. 时效性 `recency`

```text
age = currentYear - paper.year
```

只考虑：

```text
age <= 2
```

评分：

```text
age = 0 -> 1.0
age = 1 -> 0.6
age = 2 -> 0.3
age > 2 -> 0
```

### 2. 引用数 `citation`

使用对数压缩，避免高引用论文完全压过其他论文：

```text
citationScore = min(log1p(citations) / log1p(maxCitations), 1)
```

如果 `citations` 缺失，则：

```text
citationScore = 0
```

### 3. 认可度 `recognition`

来自两个信号：

#### role / stage

```text
survey (综述)      = 1.0
landmark          = 1.0
frontier role A   = 0.9
method            = 0.7
critique / edge   = 0.5
frontier role B   = 0.5
frontier role C   = 0.3
```

#### venue 信号

```text
ICLR / NeurIPS / ICML / ACL / CVPR / EMNLP = 1.0
其他知名会议 / 期刊                        = 0.7
未知 venue                                 = 0.3
```

最终：

```text
recognition = roleScore * 0.7 + venueScore * 0.3
```

## 输出结构

`curated_papers.json`：

```json
{
  "schema": "autoresearch/curated-papers/v1",
  "generatedAt": "2026-...",
  "topN": 20,
  "criteria": {
    "maxAgeYears": 2,
    "weights": {
      "recency": 0.4,
      "citation": 0.35,
      "recognition": 0.25
    }
  },
  "papers": [
    {
      "id": "p1",
      "title": "...",
      "year": "2025",
      "venue": "ICLR 2025",
      "citations": 123,
      "url": "...",
      "role": "method",
      "stage": "survey",
      "clusterId": "C1",
      "directionId": null,
      "score": 0.87,
      "recency": 1.0,
      "citation": 0.65,
      "recognition": 0.91,
      "source": "qualified",
      "reason": "近两年、高引用、ICLR 认可度高"
    }
  ]
}
```

`curated_papers.md` 用于人工查看：

```markdown
# Curated Papers

| # | title | year | venue | citations | score | why |
|---|---|---|---|---|---|---|
| 1 | ... | 2025 | ICLR 2025 | 123 | 0.87 | 高引用 + 顶会 |
```

## 代码变更

### 新增文件

```text
src/brainstorm/curated-papers.ts
```

主要 API：

```ts
export interface CuratedPaperOptions {
  topN?: number          // 默认 20
  maxAgeYears?: number   // 默认 2
}

export interface CuratedPaper extends PaperRecord {
  score: number
  recency: number
  citation: number
  recognition: number
  reason: string
}

export function selectCuratedPapers(
  records: readonly PaperRecord[],
  options?: CuratedPaperOptions,
): CuratedPaper[]
```

### Pipeline 接入

在 `runBrainstorm` 中，当 `records` 合并完成后调用：

```ts
const curated = selectCuratedPapers(records, {
  topN: deps.options.curatedTopN,
  maxAgeYears: deps.options.curatedMaxAgeYears,
})

await writeCuratedPapers(runDir, curated)
```

写入函数：

```ts
export async function writeCuratedPapers(
  runDir: string,
  papers: CuratedPaper[],
): Promise<void> {
  const jsonPath = safeResolve(runDir, 'brainstorm', 'curated_papers.json')
  const mdPath = safeResolve(runDir, 'brainstorm', 'curated_papers.md')
  await atomicWriteJson(jsonPath, { ... })
  await writeText(mdPath, renderCuratedMarkdown(papers))
}
```

### 路径限制

所有写路径均基于：

```ts
safeResolve(runDir, 'brainstorm', ...)
```

这样自然限制在：

```text
<runDir>/brainstorm/
```

不会写到：

```text
当前目录
paper_wiki/
runDir 外部
```

## 配置

`BrainstormOptions` 新增：

```ts
export interface BrainstormOptions {
  // ...已有
  curatedEnabled?: boolean    // 默认 true
  curatedTopN?: number        // 默认 20
  curatedMaxAgeYears?: number // 默认 2
}
```

## 边界处理

1. `citations` 缺失
   - citation 分记为 0，靠 recency / recognition 排序。

2. `year` 缺失或无法解析
   - 不进入近两年候选；
   - 可保留在未入选列表或忽略。

3. 近两年论文不足 `topN`
   - 自动用其他论文补齐到 `topN`；
   - 补齐论文会在 `source` 字段标记为 `fallback`；
   - 如果总论文数仍不足 `topN`，则输出全部可用论文。

4. 重复论文
   - 使用已有 `paperKey` 去重。

5. 引用数异常大
   - 使用 `log1p` 压缩，避免单一论文主导。

## 验收标准

1. 生成文件位于：
   ```text
   <runDir>/brainstorm/curated_papers.json
   <runDir>/brainstorm/curated_papers.md
   ```

2. 不生成到当前目录。

3. 默认只选择近两年、按分数从高到低、最终固定 `topN` 篇；
   - 近两年不足时自动补足。

4. 排序结果符合：
   - 近两年优先；
   - 高引用优先；
   - 顶会/综述/landmark 优先。

5. `npm run typecheck` / `npm test` 通过。
