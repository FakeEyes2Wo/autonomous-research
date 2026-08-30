# 泛化 AgentLoop 设计（精简版）

## 核心接口

```ts
export async function runReflexion<T>(
  ctx: RunContext,
  role: RoleName,
  options: {
    reflexion: (current: T, round: number) => string
    buildInput: (current: T | undefined, round: number, reflexion: string) => RoleInput
    parse: (result: RoleOutput) => T
    apply?: (value: T) => Promise<void>
    rounds?: number   // 默认 2
  },
): Promise<T>
```

## 新增字段说明

| 字段 | 作用 |
|---|---|
| `reflexion` | 每个任务自定义的“问自己的问题/反思提示” |
| `buildInput` | 构造输入，接收 `current / round / reflexion` |
| `parse` | 解析 AI 返回的领域对象 |
| `apply` | 可选副作用 |
| `rounds` | 反思轮数，默认 2 |

`reflexion` 是必填，因为不同任务反思内容不同。

---

## 实现

```ts
export async function runReflexion<T>(
  ctx: RunContext,
  role: RoleName,
  { reflexion, buildInput, parse, apply, rounds = 2 }: {
    reflexion: (current: T, round: number) => string
    buildInput: (current: T | undefined, round: number, reflexion: string) => RoleInput
    parse: (result: RoleOutput) => T
    apply?: (value: T) => Promise<void>
    rounds?: number
  },
): Promise<T> {
  let current = parse(await runAgent(ctx, {
    role,
    label: `${role} generate`,
    input: buildInput(undefined, 0, ''),
  }))
  await apply?.(current)

  for (let round = 1; round <= rounds; round += 1) {
    const question = reflexion(current, round)
    const next = parse(await runAgent(ctx, {
      role,
      label: `${role} reflex ${round}`,
      input: buildInput(current, round, question),
    }))
    if (next === current) break
    await apply?.(next)
    current = next
  }

  return current
}
```

---

## 使用示例

### Rubric

```ts
await runReflexion(ctx, 'rubric-generator', {
  reflexion: (rubric, round) =>
    `Self-reflexion round ${round}: identify weaknesses in this rubric and rewrite an improved version.\n\nCurrent rubric:\n${rubric}`,

  buildInput: (current, round, reflexion) => ({
    runDir: ctx.runDir,
    idea,
    profile,
    treeSummary: treeSummary(ctx.tree),
    ...(current ? { plan: reflexion } : {}),
  }),

  parse: (result) => structuredText(result.structured, 'rubric') ?? result.text,

  apply: async (rubric) => {
    await writeRubric(ctx.runDir, rubric)
  },
})
```

### Contract

```ts
await runReflexion(ctx, 'contract-negotiator', {
  reflexion: (contract, round) =>
    `Self-reflexion round ${round}: review this contract for untestable assertions, missing evidence coverage, and overclaim risks. Return only the improved contract.\n\nCurrent contract:\n${contract}`,

  buildInput: (current, round, reflexion) => ({
    runDir,
    evidenceChainPath,
    paperPlan,
    paperMatrix,
    ...(current ? {
      paperContract: current,
      plan: reflexion,
    } : {}),
  }),

  parse: (result) => result.structured?.contract ?? result.text,

  apply: async (contract) => {
    await writeText(contractPath, contract)
  },
})
```

> Figure 不走这个泛化 AgentLoop。Figure 有独立的视觉 self-reflexion 设计：
> `docs/figure-vision-reflexion-design.md`

---

## 设计原则

1. `role` 作为参数，不放进对象。
2. `reflexion` 必填，按任务自定义反思问题。
3. `buildInput` 接收 `current / round / reflexion`，可把反思文本放入 `plan` 或任意字段。
4. `parse` 只负责解析。
5. `apply` 只负责副作用。
6. `rounds` 默认 2。

## 不做的事

- 不把状态机并入。
- 不增加新 role。
- 不强制统一反思文本。
- 不要求强制停止条件。

## 落点

```text
src/service/agent-loop.ts
```

后续迁移：

```text
ensureRubric
negotiateContract
```

Figure 单独处理。
