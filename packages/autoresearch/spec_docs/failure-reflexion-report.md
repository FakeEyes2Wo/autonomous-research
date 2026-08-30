# Reflexion 异常失败记录设计

## 1. Objective

当 reflexion loop 非正常结束或失败时：

1. 保存该次 reflexion 的：
   - 结果
   - 输入 context
   - 失败原因
2. 由于内容可能很长，不直接写入 `FAILURE_REPORT.md`，而是写入专门目录。
3. 最终 `FAILURE_REPORT.md` 自动引用该目录。

## 2. Directory Layout

```text
<runDir>/failure_report_reflexions/
  _index.json
  _index.md
  20260830-153000-idea-reflexion-abc.json
  20260830-153001-rubric-generator-def.json
  ...
```

最终：

```text
<runDir>/FAILURE_REPORT.md
```

## 3. Record Schema

每一条异常 reflexion 记录为一个 JSON 文件：

```json
{
  "schema": "autoresearch/failure-reflexion/v1",
  "time": "2026-08-30T15:30:00.000Z",
  "role": "idea-reflexion",
  "stage": "idea",
  "round": 2,
  "stopReason": "fatal_flaw",
  "error": "optional error message",
  "context": {
    "runDir": "...",
    "input": "...",
    "current": "..."
  },
  "result": {
    "structured": "...",
    "text": "..."
  }
}
```

`stopReason` 建议值：

```text
fatal_flaw
quality_low
timeout
agent_error
max_rounds
rejected
```

## 4. Index Files

### `_index.json`

```json
{
  "schema": "autoresearch/failure-reflexion-index/v1",
  "entries": [
    {
      "file": "...",
      "time": "...",
      "role": "idea-reflexion",
      "stopReason": "fatal_flaw"
    }
  ]
}
```

### `_index.md`

用于最终报告引用：

```markdown
# Failure Reflexions

| time | role | stopReason |
|---|---|---|
| ... | idea-reflexion | fatal_flaw |
```

## 5. Core API

新增：

```text
src/core/failure-reflexion.ts
```

```ts
export interface FailureReflexionRecord { ... }

export async function writeFailureReflexion(
  runDir: string,
  record: FailureReflexionRecord,
): Promise<string>   // returns file path
```

```ts
export async function appendFailureReflexionIndex(
  runDir: string,
  entry: FailureReflexionIndexEntry,
): Promise<void>
```

```ts
export async function loadFailureReflexionIndex(
  runDir: string,
): Promise<FailureReflexionIndexEntry[]>
```

```ts
export async function writeFailureReportWithReflexions(
  runDir: string,
  baseReport: string,
): Promise<void>
```

说明：

- `writeFailureReportWithReflexions` 会读取 `failure_report_reflexions/_index.md`，并追加到最终 `FAILURE_REPORT.md`。
- 如果目录不存在，则只写 base report，保持当前行为。

## 6. Generic Reflexion Integration

在 `runReflexion` 的 `ReflexionOptions` 中增加：

```ts
export interface ReflexionOptions<T> {
  ...
  onAbnormalExit?: (info: {
    role: RoleName
    round: number
    stopReason: string
    context: unknown
    result: unknown
    error?: unknown
  }) => Promise<void>
}
```

`runReflexion` 在以下情况调用：

```text
fatal_flaw / shouldReject
  -> onAbnormalExit({ stopReason: 'fatal_flaw' })

quality 不达标且达到最大轮数
  -> onAbnormalExit({ stopReason: 'max_rounds' })

agent call throws
  -> onAbnormalExit({ stopReason: 'agent_error', error })

timeout / cancel
  -> onAbnormalExit({ stopReason: 'timeout' })
```

## 7. Caller Integration

### Idea

```ts
await runReflexion(call, 'idea-reflexion', {
  ...,
  onAbnormalExit: async (info) => {
    await writeFailureReflexion(ctx.runDir, {
      role: info.role,
      stage: 'idea',
      round: info.round,
      stopReason: info.stopReason,
      context: { runDir: ctx.runDir, pkg },
      result: info.result,
      error: info.error,
    })
  },
})
```

### Rubric

```ts
onAbnormalExit: async (info) => {
  await writeFailureReflexion(ctx.runDir, {
    role: info.role,
    stage: 'rubric',
    ...
  })
}
```

### Contract

```ts
onAbnormalExit: async (info) => {
  await writeFailureReflexion(ctx.runDir, {
    role: info.role,
    stage: 'paper-contract',
    ...
  })
}
```

### Figure

Figure 不走通用 loop，但可以在 `generateFigures` 的 catch / 失败分支中调用：

```ts
await writeFailureReflexion(ctx.paths.runDir, {
  role: 'figure-generator',
  stage: 'paper-figure',
  ...
})
```

## 8. Final Failure Report

所有现有失败写入点改为：

```ts
await writeFailureReportWithReflexions(runDir, content)
```

而不是：

```ts
await writeFailureReport(runDir, content)
```

新报告结构：

```markdown
# FAILURE_REPORT

## Reason

...

## Failure Reflexions

See the following files for detailed reflexion context:

- failure_report_reflexions/20260830-...-idea-reflexion.json
- ...
```

## 9. File Changes

| File | Change |
|---|---|
| `src/core/failure-reflexion.ts` | 新增核心 API |
| `src/service/agent-loop.ts` | 增加 `onAbnormalExit` |
| `src/service/steps/idea.ts` | 接入 onAbnormalExit |
| `src/paper/phases.ts` | contract / figure 接入 |
| `src/domain/files.ts` | `writeFailureReport` 改为引用目录版本或保留兼容 |
| `src/experiment/runner.ts` | 失败写入点改用新函数 |
| `src/service/runner.ts` | 失败写入点改用新函数 |
| `src/service/autoresearch-service.ts` | 顶层 catch 改用新函数 |
| `src/service/steps/paper.ts` | no evidence 失败改用新函数 |

## 10. Acceptance Criteria

1. 非正常 reflexion 结果会写入 `failure_report_reflexions/`。
2. 每个文件包含 role / round / reason / context / result。
3. `_index.md` 自动更新。
4. 最终 `FAILURE_REPORT.md` 引用该目录。
5. 没有异常 reflexion 时，`FAILURE_REPORT.md` 行为与当前一致。
6. `npm run typecheck` / `npm test` 通过。
