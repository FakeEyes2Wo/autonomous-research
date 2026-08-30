# 初始 Idea 深挖 + Paper Wiki + Baseline 设计

## 目标

在已有初始 idea 时，不做广挖，直接深挖最相似的论文，并把这些论文作为 baseline / related work 注入 idea generation。

**关键原则：复用 brainstorm 已有的论文搜索能力，不新设计一套搜索流程。**

## 复用的现有能力

| 能力 | 位置 | 用途 |
|---|---|---|
| `paper-survey` | brainstorm roles | 查找相关论文/综述 |
| `paper-frontier-miner` | brainstorm roles | 查找目标方向最相关论文 |
| `normalizeSurveyPapers` / `normalizeFrontierPapers` | `brainstorm/normalize.ts` | 规范化论文 |
| `mergePaperRecords` | `brainstorm/normalize.ts` | 去重合并 |
| `renderPaperWiki` | `brainstorm/wiki-render.ts` | 程序化生成 paper wiki |
| `writeWikis` / `paperWikiPath` | `brainstorm/pipeline.ts` | 写入 `paper_wiki/*.md` |
| `selectCuratedPapers` | `brainstorm/curated-papers.ts` | 精选/baseline 候选 |

不新增 `paper-deep-dive` 角色，不重新定义搜索协议。

## 触发时机

```text
已有 candidate / input/idea.md
    ↓
读取 idea + profile
    ↓
【新增】runInitialDeepDive
    ↓
研究循环
```

## 流程

```text
idea + profile
    ↓
复用 paper-survey（聚焦深挖模式）
    ↓
复用 paper-frontier-miner（针对该 idea 方向）
    ↓
mergePaperRecords（去重合并）
    ↓
程序化 renderPaperWiki + writeWikis
    ↓
paper_wiki/*.md
    ↓
baseline 选择
    ↓
baselines.json / baselines.md
    ↓
注入 idea-generator
```

## 搜索复用方式

### 1. `paper-survey`

复用现有角色，向它传入聚焦 plan：

```text
Target idea: <idea>

Mode: deep-dive
- 不要做广域综述。
- 找到与上面 idea 最相似、最可能成为 direct baseline 的论文。
- 返回 10-20 篇。
- 对最像的直接 baseline 标记 baseline: true。
- 其余标记为 related。
```

### 2. `paper-frontier-miner`

复用现有角色，把 idea 构造成一个方向传入：

```text
selectedDirections: [{
  id: 'idea',
  name: '<idea name>',
  statement: '<idea>',
  evidence: []
}]
```

用它补充近两年、最相关的前沿 baseline。

### 3. 数据归一化

继续使用：

```ts
normalizeSurveyPapers(rawSurvey)
normalizeFrontierPapers(rawFrontier)
mergePaperRecords(...)
```

## 输出文件

```text
<runDir>/brainstorm/deep_dive_papers.json
<runDir>/brainstorm/baselines.json
<runDir>/brainstorm/baselines.md
<runDir>/paper_wiki/*.md
```

## Baseline 选择规则

```text
第一优先级：
  paper-survey / frontier-miner 返回中 baseline: true 的论文

第二优先级：
  最相似的前 3 篇

第三优先级：
  没有外部 baseline
  → 自行设计 baseline
  → 写入 baselines.md
```

自行设计 baseline 示例：

```text
- 去掉本方法的简化版本
- 随机/启发式 baseline
- 现有公开模型的最强配置
```

## 注入 Idea Generator

### `RoleInput` 新增

```ts
readonly relatedPapers?: string
readonly baselines?: string
```

### `idea-generator` prompt 新增

```text
## Related papers / baselines

<相关论文与 baseline>

要求：
- 说明与最相似论文的差异。
- 明确与哪些 baseline 比较。
- 有外部 baseline 则设计对比实验。
- 无外部 baseline 则自行设计公平 baseline。
```

## 代码接入

### 新增文件

```text
src/brainstorm/deep-dive.ts
```

### 主要函数

```ts
export interface DeepDiveRequest {
  runDir: string
  idea: string
  profile: string
  agentContext: RoleExecutionContext
}

export interface DeepDiveResult {
  relatedPapers: string
  baselines: string
}

export async function runInitialDeepDive(
  deps: BrainstormDependencies,
  request: DeepDiveRequest,
): Promise<DeepDiveResult>
```

内部只调用已有角色和已有 normalize / wiki / curated 函数。

### ResearchRunner 接入

读取 idea/profile 后、第一次 idea generation 前：

```ts
const deepDive = await runInitialDeepDive(
  { provider, options },
  { runDir, idea: candidate.raw, profile, agentContext: context },
)

await runIdeaGeneration(ctx, {
  idea: candidate.raw,
  profile,
  relatedPapers: deepDive.relatedPapers,
  baselines: deepDive.baselines,
})
```

## 配置

```ts
export interface BrainstormOptions {
  deepDiveEnabled?: boolean   // 默认 true
  deepDiveTopN?: number       // 默认 15
}
```

## 边界情况

| 情况 | 处理 |
|---|---|
| 搜索返回 0 篇 | 不注入 related work，走 self-designed baseline |
| 未标记 baseline | 选最相似前 3 篇 |
| 只有老论文 | 仍作为 background/baseline |
| 搜索失败 | 不阻塞研究循环，降级为 self-designed baseline |

## 验收标准

1. 复用 brainstorm 已有搜索角色，不新增搜索协议。
2. 有 idea 时直接深挖，不广挖。
3. `baselines.json / .md` 写入 `brainstorm/`。
4. 相似论文生成 `paper_wiki/*.md`。
5. idea-generator 收到 related papers / baselines。
6. 无 baseline 时自动 self-designed baseline。
7. `npm run typecheck` / `npm test` 通过。
