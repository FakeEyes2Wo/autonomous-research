# Idea-Reflexion Retry Scheme

## 1. Problem

`idea-reflexion` 返回的 `revised` 可能不是完整 `IdeaPackage`，例如缺少：

```text
supported_premises
predicted_observations
disconfirming_observations
sources
```

直接替换 `currentPkg` 会导致后续 `structuralCheck` 崩溃。

## 2. Retry Goal

当 `revised` 不完整时：

1. 不直接使用；
2. 把缺失字段反馈给模型；
3. 重试同一轮 reflexion；
4. 多次仍失败时，退回原始/当前有效 package；
5. 绝不因为 LLM 部分输出导致流程崩溃。

## 3. Validation

定义：

```ts
function validateIdeaPackage(pkg: IdeaPackage): string[] {
  const missing: string[] = []
  if (!pkg.statement) missing.push('statement')
  if (!pkg.intervention) missing.push('intervention')
  if (!pkg.expected_effect) missing.push('expected_effect')
  if (!Array.isArray(pkg.supported_premises)) missing.push('supported_premises')
  if (!Array.isArray(pkg.predicted_observations)) missing.push('predicted_observations')
  if (!Array.isArray(pkg.disconfirming_observations)) missing.push('disconfirming_observations')
  if (!Array.isArray(pkg.sources)) missing.push('sources')
  return missing
}
```

可选容错字段：

```text
inference_chain -> 可默认为 []
```

## 4. Retry Loop Design

### 4.1 Within One Reflexion Round

```text
idea-reflexion 返回 revised
  ↓
validate(revised)
  ↓
valid?
  yes -> 使用 revised
  no  -> 生成 feedback:
         "revised is missing: supported_premises, ..."
          ↓
         用同一 round 重新调用 idea-reflexion
          ↓
         retry <= maxRetriesPerRound
          ↓
         still invalid -> 忽略 revised，保留 currentPkg
```

### 4.2 Parameters

```text
maxRetriesPerRound = 2
```

### 4.3 Feedback Prompt

```text
Your revised hypothesis is invalid:
- missing: supported_premises, predicted_observations
Please return a complete IdeaPackage with all required fields.
```

## 5. Implementation Location

```text
src/service/steps/idea.ts
```

可在 `runIdeaReflexion` 内增加一个 `reflexWithRetry` 辅助：

```ts
async function reflexWithRetry(
  ctx: RunContext,
  currentPkg: IdeaPackage,
  round: number,
): Promise<{ pkg: IdeaPackage; value: ... }>
```

或者把 retry 逻辑放进通用 `runReflexion`，增加：

```ts
validate?: (value: T) => string[]
maxRetriesPerRound?: number
```

## 6. Generic Option (Recommended)

在 `ReflexionOptions<T>` 增加：

```ts
validate?: (value: T) => string[]
maxRetriesPerRound?: number   // default 0 or 2
```

`runReflexion` 在每轮解析后：

```text
if validate(next).length > 0 && retries < maxRetriesPerRound:
  retry same round with feedback
```

## 7. Downgrade Strategy

| 情况 | 行为 |
|---|---|
| revised 完整 | 使用 revised |
| revised 不完整但重试后完整 | 使用修复后的 revised |
| revised 始终不完整 | 保留当前有效 package |
| 没有 revised | 保留当前有效 package |
| 最终仍无有效 package | 走 failure reflexion 记录并拒绝该 hypothesis |

## 8. Failure Recording

如果重试耗尽仍无法得到合法 package：

```text
writeFailureReflexion(..., {
  stopReason: 'max_rounds',
  context: { originalPkg, revised },
})
```

## 9. Acceptance Criteria

1. `revised` 不完整时不会崩溃。
2. 每轮最多重试 2 次。
3. 重试后仍失败则回退到当前有效 package。
4. 失败会写入 `failure_report_reflexions/`。
5. `npm run typecheck` / `npm test` 通过。
