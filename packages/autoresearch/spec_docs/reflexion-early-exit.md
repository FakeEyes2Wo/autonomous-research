# Reflexion Loop Early Exit Spec

## 1. Objective

在 self-reflexion 循环中加入提前跳出机制，避免“永远反思”或达到 3 轮上限后仍然浪费。

## 2. Current Loop

```text
generate
  ↓
reflex 1
  ↓
reflex 2
  ↓
reflex 3
  ↓
停止
```

当前只有：

- 不变则停止
- 硬上限 `rounds = 3`

## 3. Early Exit Mechanisms

### 3.1 Convergence Detection

如果本轮输出与上一轮几乎相同，则提前停止：

```ts
normalize(output) === normalize(current)
// 或
similarity(current, next) > 0.95
```

适用：

- Rubric markdown
- Contract markdown
- Idea package JSON
- Figure latexIncludes

这是一个最基本、最安全的跳出条件。

### 3.2 Quality Score Threshold

让每个 reflexion 返回一个自评质量分：

```ts
qualityScore?: number   // 0 - 1
```

如果：

```ts
qualityScore >= 0.85
```

则提前停止。

适用：

- `idea-reflexion`
- `rubric-generator self-reflexion`
- `contract-negotiator self-reflexion`

### 3.3 Fatal Flaw Rejection

如果 reflexion 发现致命问题：

```ts
fatal_flaw_found === true
```

则立即停止并拒绝/标记该产物：

```text
stop early
→ reject / failed
```

适用：

- `idea-reflexion`
- `contract-negotiator`
- `figure-generator`

### 3.4 Diminishing Returns

计算相邻两轮改进量：

```ts
delta = similarity(current, next) 或 editDistance(current, next)
```

如果改进量连续低于阈值，则提前停止：

```text
improvement 很小
  ↓
继续无意义
```

### 3.5 Hard Budget

保留硬上限：

```text
rounds = 3
```

并加入：

```text
maxTokens / costBudget / timeBudget
```

如果预算耗尽，无条件停止。

### 3.6 Deterministic Structural Checks

对于可程序化检查的产物，使用非 AI 检查：

- Figure:
  - 图片是否生成
  - 脚本是否报错
  - latexIncludes 是否引用所有脚本
  - 是否嵌入主标题
- Contract:
  - 是否包含 10-20 条 assertion
  - 每条 assertion 是否有 evidence 标记
- Rubric:
  - 是否包含必要 metric / criteria

结构化检查通过即可提前停止，不依赖 LLM 自评。

### 3.7 Probe Cascade / Verifier Gate

参考现有工程机制，可以用一个轻量 verifier 对输出做 pre-check：

```text
LLM reflexion
  ↓
轻量 verifier（规则/打分）
  ↓
pass -> stop
fail -> continue
```

这在搜索到的材料中也被描述为：

- Training-Free Inference-Time Self-Reflection and Cost-Bounded Early Stopping
- Recall-Controlled Probe Cascade / Early Abort

### 3.8 Timeout / Cancellation

当前已有 subagent timeout。在 reflexion 循环中也要：

```text
每轮检查 AbortSignal
超时/取消 -> 立即停止
```

---

## 4. Recommended Design

给 `runReflexion` 增加可选 early-exit 回调：

```ts
export interface ReflexionOptions<T> {
  ...
  shouldStop?: (current: T, next: T, round: number) => boolean
  shouldReject?: (next: T, round: number) => boolean
  quality?: (next: T) => number
}
```

默认逻辑：

```text
if shouldReject(next)  -> stop and reject
if shouldStop(current, next) -> stop
if quality(next) >= 0.85 -> stop
if improvement < epsilon for 2 rounds -> stop
if round >= 3 -> stop
```

## 5. File Impact

```text
src/service/agent-loop.ts
src/service/steps/idea.ts
src/paper/phases.ts
```

## 6. Acceptance Criteria

1. 所有 reflexion loop 都支持提前跳出。
2. 默认仍为 3 轮硬上限。
3. 不变 / 相似度高 / 质量分达标 / fatal flaw 都触发提前停止。
4. 现有 subagent timeout 仍然生效。
5. `npm run typecheck` / `npm test` 通过。

## 7. References

- [Training-Free Inference-Time Self-Reflection and Cost-Bounded Early Stopping](https://arxiv-org.ezproxy.obspm.fr/html/2608.18884v1#1)
- [Doomed from the Start: Early Abort of LLM Agent Episodes via a Recall-Controlled Probe Cascade](https://arxiv-org.ezproxy.obspm.fr/html/2607.06503v1#3)
- [Reflection Loop Pattern](https://github.com/nibzard/awesome-agentic-patterns/blob/main/patterns/reflection.md#1)
- [Refinement Halting Condition](https://inferensys.com/glossary/recursive-error-correction/iterative-refinement-protocols/refinement-halting-condition)
- [Convergence Protocol](https://inferensys.com/glossary/recursive-error-correction/iterative-refinement-protocols/convergence-protocol)
- [Iterative Improvement is Not Monotonic, Necessitating Early Stopping](https://browse-export.arxiv.org/pdf/2509.06822#5#3)
