# Brainstorm 子代理韧性设计（历史参考）

> 最终实现采用更简方案：程序化生成 paper wiki + DSH 原生 subagent 生命周期。
> 下文中的 LLM 分批/checkpoint/自定义超时属于可选历史设计。
> 当前默认代码已移除 `paper-wiki-writer` 调用，也不再由自研 provider 实现 subagent 超时；
> 长任务生命周期由 DSH continuable subagent 管理。
> 背景：`paper-wiki-writer` 单次调用需要写大量 paper wiki，缺少中间落盘和超时机制。

---

## 1. 目标

1. **可观察**：每个 paper wiki 写入后立刻落盘，能从磁盘看到进度。
2. **可恢复**：中断/超时后重新运行，只补写未完成的 paper，不重复已完成部分。
3. **可控耗时**：一次子代理调用只处理一小批，避免单次调用过长。
4. **可终止**：子代理超过阈值能自动超时并取消，而不是无限等待。
5. **兼容现有流程**：不改变 `BrainstormPipeline` / `paper-wiki-writer` 对外角色行为，不改变最终文件格式。

---

## 2. 问题根因

当前 `writeWikis` 是“一次性大请求”：

```ts
const result = await provider.run('paper-wiki-writer', {
  runDir,
  plan: JSON.stringify({ papers: records, stageHint: stage }, null, 2),
}, ctx.agentContext)

const wikis = result.structured?.wikis ?? {}
for (const [id, markdown] of Object.entries(wikis)) {
  await writeText(paperWikiPath(runDir, id), markdown)
}
```

问题：

- 所有写入都发生在 subagent 返回之后。
- 如果 subagent 长时间不返回，磁盘上没有任何进度。
- 没有超时，没有取消，没有分批，没有检查点。
- 失败后重跑会重新请求所有论文。

---

## 3. 设计总览

```text
paper-wiki-writer 韧性机制
├── A. 分批调用
│     ├── BrainstormOptions.wikiBatchSize
│     └── writeWikis 按批调用 paper-wiki-writer
├── B. 增量检查点
│     ├── paper_wiki/_wiki_checkpoint.json
│     └── 每批/每篇写入后更新 doneIds
├── C. 可见进度
│     ├── 每篇 wiki 独立文件
│     └── 每次落盘后刷新 checkpoint
├── D. 超时取消
│     ├── RoleAgentProvider 超时配置
│     └── SubagentRoleAgentProvider 超时后 dispose + 抛错
└── E. 自动恢复
      ├── 启动时跳过已完成论文
      └── 失败后重跑只处理 pending
```

---

## 3.5 首选方案：程序化 paper wiki 生成

`PaperRecord` 在 survey/frontier 阶段已经包含：

- 标题、年份、venue、arxiv/doi/url、引用数
- `oneLiner`
- `keyFinding`
- `weakness`
- `implication`
- `abstract`
- 集群/方向/来源综述等上下文

因此 **paper wiki 可以完全程序化生成**，不需要等 LLM subagent 写完整篇 wiki。

### 实现

新增：

```text
src/brainstorm/wiki-render.ts
```

核心函数：

```ts
export function renderPaperWiki(paper: PaperRecord): string
```

`writeWikis` 默认直接：

```ts
for (const paper of records) {
  await writeText(paperWikiPath(runDir, paper.id), renderPaperWiki(paper))
}
```

### 默认策略

```ts
wikiMode?: 'programmatic' | 'llm'
// 默认 'programmatic'
```

- `programmatic`：零 LLM 调用，立即落盘，速度快且稳定。
- `llm`：保留原有 `paper-wiki-writer` 作为可选的深度增强模式。

> 该方案已落地，并已通过集成测试：默认不再调用 `paper-wiki-writer`，但仍会生成完整 `paper_wiki/*.md`。

---

## 4. 机制 A：分批调用

### 4.1 配置项

在 `BrainstormOptions` 增加：

```ts
export interface BrainstormOptions {
  // ... 已有字段

  /** 每次 paper-wiki-writer 处理的论文数量 */
  wikiBatchSize?: number

  /** 单次 subagent 超时毫秒数（未配置时用默认） */
  subagentTimeoutMs?: number
}
```

默认值：

```ts
const DEFAULT_WIKI_BATCH_SIZE = 5
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000
```

### 4.2 `writeWikis` 改为分批

```ts
async function writeWikis(
  deps: BrainstormDependencies,
  ctx: BrainstormState,
  records: readonly PaperRecord[],
  stage: 'survey' | 'latest',
): Promise<void> {
  if (records.length === 0) return

  const batchSize = deps.options.wikiBatchSize ?? DEFAULTS.wikiBatchSize
  const checkpoint = await loadWikiCheckpoint(ctx.runDir, stage)
  const pending = records.filter((paper) => !checkpoint.doneIds.includes(paper.id))

  if (pending.length === 0) return

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const result = await deps.provider.run('paper-wiki-writer', {
      runDir: ctx.runDir,
      plan: JSON.stringify({ papers: batch, stageHint: stage }, null, 2),
    }, ctx.agentContext)

    const wikis = (result.structured as { wikis?: Record<string, string> } | undefined)?.wikis ?? {}
    const missing = batch.filter((paper) => !wikis[paper.id])
    if (missing.length > 0) {
      throw new AutoResearchError(
        `paper wiki missing ${missing.length} ${stage} papers in batch: ${missing.map((p) => p.id).join(', ')}`,
        'AGENT_FAILED',
      )
    }

    for (const paper of batch) {
      const markdown = wikis[paper.id]
      if (!markdown) continue
      await writeText(paperWikiPath(ctx.runDir, paper.id), markdown)
      checkpoint.doneIds.push(paper.id)
      checkpoint.updatedAt = nowIso()
      await saveWikiCheckpoint(ctx.runDir, stage, checkpoint)
    }
  }
}
```

关键点：

- `paper-wiki-writer` 每次只看到一小批，避免一次处理几十篇。
- 每篇写入后立即更新 checkpoint。
- 后续调用不会重复写已完成论文。

---

## 5. 机制 B：检查点

### 5.1 文件位置

```text
paper_wiki/_wiki_checkpoint.json
```

### 5.2 数据结构

```ts
export interface WikiCheckpoint {
  schema: 'autoresearch/paper-wiki-checkpoint/v1'
  stage: 'survey' | 'latest'
  doneIds: string[]
  failedIds: string[]
  updatedAt: string
}
```

### 5.3 读写 API

建议放到新模块：

```text
src/brainstorm/wiki-checkpoint.ts
```

```ts
export async function loadWikiCheckpoint(
  runDir: string,
  stage: WikiStage,
): Promise<WikiCheckpoint> {
  const file = safeResolve(runDir, PAPER_WIKI_DIR, WIKI_CHECKPOINT_FILE)
  try {
    return await readJson<WikiCheckpoint>(file)
  } catch {
    return {
      schema: 'autoresearch/paper-wiki-checkpoint/v1',
      stage,
      doneIds: [],
      failedIds: [],
      updatedAt: nowIso(),
    }
  }
}

export async function saveWikiCheckpoint(
  runDir: string,
  stage: WikiStage,
  checkpoint: WikiCheckpoint,
): Promise<void> {
  checkpoint.updatedAt = nowIso()
  await atomicWriteJson(
    safeResolve(runDir, PAPER_WIKI_DIR, WIKI_CHECKPOINT_FILE),
    checkpoint,
  )
}
```

### 5.4 兼容旧运行

如果目录里已经有部分 `paper_wiki/*.md` 但没有 checkpoint，建议初始化时扫描已有文件：

```ts
async function initCheckpointFromDisk(runDir: string, stage: WikiStage, records: readonly PaperRecord[]): Promise<WikiCheckpoint> {
  const cp = await loadWikiCheckpoint(runDir, stage)
  const existing = new Set(
    (await readdir(paperWikiDir(runDir)).catch(() => []))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, '')),
  )
  for (const paper of records) {
    if (existing.has(paper.id) && !cp.doneIds.includes(paper.id)) {
      cp.doneIds.push(paper.id)
    }
  }
  await saveWikiCheckpoint(runDir, stage, cp)
  return cp
}
```

这样老运行目录也可以增量恢复。

---

## 6. 机制 C：可见进度

1. **每篇一个文件**
   - `paper_wiki/{paper.id}.md`
   - 这是最直观的进度信号。

2. **每个批处理更新日志**
   - 写批处理开始/结束日志：
     ```ts
     logger.info(`[paper-wiki] stage=${stage} batch ${i / batchSize + 1}/${Math.ceil(pending.length / batchSize)}`)
     ```
   - 可以引入 Logger 到 `BrainstormPipeline`/`writeWikis`。

3. **checkpoint 文件实时更新**
   - 目录里存在 `_wiki_checkpoint.json` 且 `doneIds` 持续增长，就能确认没有卡死。

4. **可选：进度文件**
   - 可在 `paper_wiki/_progress.json` 记录每个 batch 状态：
     ```ts
     interface WikiProgress {
       stage: string
       total: number
       done: number
       currentBatch: number
       updatedAt: string
     }
     ```
   - 不是必需，checkpoint 已足够。

---

## 7. 机制 D：超时与取消

### 7.1 Provider 层超时

当前 `SubagentRoleAgentProvider.run` 没有超时：

```ts
const run = await this.runtime.start(this.providerName, {
  ...
  signal: context.signal,
})
const result = await run.result  // 可能永远等待
```

改为：

```ts
export interface SubagentProviderOptions {
  providerName?: string
  defaultTimeoutMs?: number
  timeouts?: Partial<Record<RoleName, number>>
}
```

在 `run` 中：

```ts
async run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
  const timeoutMs = this.options.timeouts?.[role]
    ?? this.options.defaultTimeoutMs
    ?? DEFAULT_SUBAGENT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`subagent ${role} timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const signal = context.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal

  const run = await this.runtime.start(this.providerName, {
    ...,
    signal,
  })

  try {
    const result = await Promise.race([
      run.result,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason ?? new Error(`subagent ${role} timed out`))
        }, { once: true })
      }),
    ])
    ...
  } finally {
    clearTimeout(timer)
    await run.dispose().catch(() => {})
  }
}
```

> 如果运行环境不支持 `AbortSignal.any`，可以手动创建一个 `AbortController` 并转发两个信号，或者在 `run.result` 外使用 `Promise.race` + 定时器。

### 7.2 超时错误语义

建议新增错误类型：

```ts
export class SubagentTimeoutError extends Error {
  readonly kind = 'AGENT_TIMEOUT'
  constructor(readonly role: RoleName, readonly timeoutMs: number) {
    super(`subagent ${role} timed out after ${timeoutMs}ms`)
    this.name = 'SubagentTimeoutError'
  }
}
```

这样上层可以区分：

- 模型主动失败
- 子代理超时
- 外部取消

### 7.3 取消传播

- `context.signal` 继续透传给 runtime。
- `run.dispose()` 在超时/普通完成/异常时都调用。
- 超时后抛出 `SubagentTimeoutError`，`ResearchRunner`/`BrainstormPipeline` 可以捕获并：
  - 立即停止当前 run；
  - 或标记当前阶段失败并进入可恢复状态。

---

## 8. 机制 E：自动恢复

### 8.1 恢复语义

`writeWikis` 每次开始时：

```ts
const checkpoint = await loadWikiCheckpoint(runDir, stage)
const pending = records.filter((paper) => !checkpoint.doneIds.includes(paper.id))
```

如果上一轮已经完成部分论文，重跑只补写剩余部分。

### 8.2 与现有 run 恢复的衔接

当前 `ResearchRunner` 已有 `state.phase === 'paper'` 恢复逻辑，但 brainstorm 阶段没有阶段性 checkpoint。

建议在 `brainstorm` 阶段也保存阶段状态：

```text
brainstorm/_stage_checkpoint.json
```

例如：

```ts
export interface BrainstormStageCheckpoint {
  schema: 'autoresearch/brainstorm-stage-checkpoint/v1'
  stage: 'survey' | 'directions' | 'frontier' | 'ideation'
  updatedAt: string
  wikiStageDone?: 'survey' | 'latest'
}
```

`runBrainstorm` 恢复时：

- 如果 `survey` 已完成，加载已有 `survey_pool.json`、已有 wiki、已有 checkpoint。
- 如果 `frontier` 已完成，加载 `frontier_pool.json` 和 `paper_records.json`。
- 如果 `directions` 已完成，加载 `selected_directions.json`。
- 如果 `ideation` 已完成，加载已有 `IDEA.md`，直接返回。

### 8.3 重新运行策略

最简单且稳妥的策略：

- 超时/失败后，**下一次运行从 brainstorm 阶段重新开始**，但：
  - `paper_wiki` 中已存在的 `*.md` 不覆盖（或根据 checkpoint 跳过）。
  - 已完成的 `survey_pool.json` 可复用。
- 后续如果需要增量恢复，再引入完整的 brainstorm stage checkpoint。

---

## 9. 配置建议

```ts
export interface BrainstormOptions {
  ranking?: RankingStrategy

  surveyMinSurveys?: number
  surveyMinPapers?: number
  surveyMinClusters?: number
  latestPerDirection?: number
  latestWindowYears?: number
  maxSelectedDirections?: number
  enableKnowledgeGraph?: boolean

  // 新增韧性配置
  wikiBatchSize?: number
  subagentTimeoutMs?: number
  wikisStrict?: boolean
}
```

默认推荐：

```ts
const DEFAULTS = {
  ...
  wikiBatchSize: 5,
  subagentTimeoutMs: 10 * 60_000,
}
```

`wikisStrict` 控制缺失 wiki 是否硬失败：

- `true`：缺一篇就失败（保持当前行为）。
- `false`：允许缺失并写入 warning，继续后续阶段。

---

## 10. 代码落点

| 机制 | 文件 |
|---|---|
| 分批 + checkpoint | `src/brainstorm/pipeline.ts` |
| checkpoint 数据模型 | 新增 `src/brainstorm/wiki-checkpoint.ts` |
| 路径常量 | `src/brainstorm/handoff.ts` |
| 子代理超时 | `src/providers/subagent-provider.ts` |
| 超时错误类型 | `src/core/utils.ts` 或新增 `src/providers/errors.ts` |
| BrainstormOptions | `src/brainstorm/pipeline.ts` |
| Brainstorm 阶段恢复 | `src/brainstorm/pipeline.ts` / `src/brainstorm/stage-checkpoint.ts` |

---

## 11. 迁移顺序

1. **先做分批 + checkpoint**
   - 最小风险，直接解决“无进度、无法恢复”。
   - 每篇写完立即落盘，日志可观察。
   - 即使超时机制还没做，也能看到是否在推进。

2. **再做 subagent 超时**
   - 在 `SubagentRoleAgentProvider` 加 `timeoutMs`。
   - 先给 `paper-survey`、`paper-wiki-writer`、`paper-frontier-miner` 等长任务加超时。
   - 超时后 `dispose` 并抛出明确错误。

3. **最后做 brainstorm 阶段 checkpoint**
   - 让整个 brainstorm 可从 `survey` / `frontier` / `ideation` 阶段恢复。
   - 这是最完整但改动最大的方案。

---

## 12. 验收标准

1. **进度可见**
   - 运行中 `paper_wiki/` 下会持续出现新的 `*.md` 文件。
   - `_wiki_checkpoint.json` 的 `doneIds` 持续增长。

2. **可恢复**
   - 模拟中断后重跑，已完成的 wiki 不会被重复生成。
   - 未完成的 paper 会被补写。

3. **超时有效**
   - 超过 `timeoutMs` 后，subagent 会被 dispose，日志出现 timeout 错误。
   - 不会无限等待。

4. **行为兼容**
   - 正常成功路径生成的 `paper_wiki/*.md` 内容不变。
   - `brainstorm` 最终输出 `input/idea.md` 和 `PROFILE.md` 不变。

5. **测试通过**
   - `npm run typecheck`
   - `npm test`
   - 新增针对 checkpoint、分批、超时的单元测试。
