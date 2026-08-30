# Reflexion Retry Implementation Spec

> 本 spec 描述如何为通用 `runReflexion` 增加“结果校验 + 同轮重试 + 失败回退”机制。
> 主要解决 `idea-reflexion` 返回不完整 `IdeaPackage` 导致的崩溃。

---

## 1. Objective

1. 每轮 reflexion 结果先经过 `validate`。
2. 如果无效，把缺失字段反馈给模型并重试同一轮。
3. 重试次数可配置，默认 `2`。
4. 重试仍无效时保留当前有效值，不崩溃。
5. 最终失败写入 `failure_report_reflexions/`。

---

## 2. Type Changes

### `ReflexionOptions<T>`

```ts
export interface ReflexionOptions<T> {
  reflexion: (current: T, round: number) => string
  buildInput: (current: T | undefined, round: number, reflexion: string) => RoleInput
  parse: (result: RoleOutput) => T
  apply?: (value: T, round: number) => Promise<void>
  rounds?: number

  // 新增
  validate?: (value: T) => string[]
  maxRetriesPerRound?: number   // default 2
  onAbnormalExit?: (info: ReflexionAbnormalInfo) => Promise<void>
}
```

### `ReflexionAbnormalInfo`

```ts
export interface ReflexionAbnormalInfo {
  role: RoleName
  round: number
  stopReason:
    | 'agent_error'
    | 'max_rounds'
    | 'fatal_flaw'
    | 'quality_low'
    | 'timeout'
    | 'rejected'
    | 'invalid_output'   // 新增
  context?: unknown
  result?: unknown
  error?: unknown
}
```

### `FailureStopReason`

`src/core/failure-reflexion.ts` 增加：

```ts
'invalid_output'
```

---

## 3. `runReflexion` Implementation

### 3.1 Inner Retry Helper

```ts
async function runWithRetry(
  input: RoleInput,
  label: string,
  round: number,
  fallback: T,
): Promise<{ value: T; ok: boolean }> {
  const retries = maxRetriesPerRound ?? 2
  let feedback = ''

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const output = await safeRun(
      attempt === 0
        ? input
        : buildInput(fallback, round, reflexion(fallback, round) + '\n\n' + feedback),
      label,
      round,
    )
    const value = parse(output)
    const errors = validate?.(value) ?? []

    if (errors.length === 0) {
      return { value, ok: true }
    }

    feedback = `Your output is invalid. Missing fields: ${errors.join(', ')}. Please return a complete valid result.`
  }

  return { value: fallback, ok: false }
}
```

### 3.2 Loop Integration

```ts
let current = parse(await runWithRetry(
  buildInput(undefined, 0, ''),
  `${role} generate`,
  0,
  parse(await ...),  // fallback?
).value)
```

> 实际实现中，初始生成也应使用 `runWithRetry`；fallback 可使用第一次生成的原始值。

对于 reflexion 轮：

```ts
const { value: next, ok } = await runWithRetry(
  buildInput(current, round, reflexion(current, round)),
  `${role} reflex ${round}`,
  round,
  current,   // fallback = current
)

if (!ok) {
  await onAbnormalExit?.({
    role,
    round,
    stopReason: 'invalid_output',
    context: { current },
    result: next,
  })
  break  // 或保留 current 继续，取决于语义
}

if (next === current) break
await apply?.(next, round)
current = next
```

---

## 4. IdeaPackage Validator

### 4.1 Required Fields

```ts
const REQUIRED_IDEA_FIELDS: (keyof IdeaPackage)[] = [
  'statement',
  'intervention',
  'expected_effect',
  'supported_premises',
  'predicted_observations',
  'disconfirming_observations',
  'sources',
]
```

### 4.2 Validator

```ts
export function validateIdeaPackage(pkg: IdeaPackage): string[] {
  const missing: string[] = []

  for (const field of REQUIRED_IDEA_FIELDS) {
    const value = pkg[field]
    if (Array.isArray(value) && value.length >= 0) continue
    if (typeof value === 'string' && value.trim().length > 0) continue
    missing.push(String(field))
  }

  return missing
}
```

### 4.3 容错

对以下字段允许缺省：

```text
inference_chain
```

在 `IdeaPackage` 规范化时：

```ts
pkg.inference_chain ??= []
```

---

## 5. Caller Changes

### `src/service/steps/idea.ts`

在 `runIdeaReflexion` 的 `runReflexion` 调用中新增：

```ts
validate: validateIdeaPackage,
maxRetriesPerRound: 2,
```

同时保留：

```ts
onAbnormalExit: async (info) => {
  await writeFailureReflexion(ctx.runDir, {
    role: info.role,
    stage: 'idea',
    round: info.round,
    stopReason: info.stopReason === 'invalid_output' ? 'invalid_output' : info.stopReason,
    context: { pkg: currentPkg, missing: info.context?.missing },
    result: info.result,
  })
}
```

### `src/paper/phases.ts`

Rubric / Contract 暂不强制 validate，但接口保留。

---

## 6. Failure Recording

当 `validate` 一直失败：

```text
stopReason: 'invalid_output'
```

写入：

```text
<runDir>/failure_report_reflexions/failure_*.json
```

内容包含：

```text
role
stage
round
stopReason
missingFields
context
result
```

---

## 7. Tests

### 7.1 Unit Test: retry succeeds

```txt
fake call 1: returns invalid revised (missing supported_premises)
fake call 2: returns valid revised
expect: final pkg = valid revised
expect: apply called with valid revised
```

### 7.2 Unit Test: retry fails

```txt
fake calls all return invalid
expect: final pkg = current
expect: onAbnormalExit called with stopReason='invalid_output'
```

### 7.3 Integration Test

```txt
idea-reflexion fake returns incomplete revised first, complete revised second
expect: runIdeaGeneration does not crash
expect: generated hypotheses preserved
```

---

## 8. Acceptance Criteria

1. `validate` 返回缺失字段时触发同轮重试。
2. 重试成功后使用修复后的结果。
3. 重试失败时保留当前有效值。
4. 不引发 `structuralCheck` 崩溃。
5. `invalid_output` 记录写入 failure reflexions。
6. `npm run typecheck` / `npm test` 通过。
