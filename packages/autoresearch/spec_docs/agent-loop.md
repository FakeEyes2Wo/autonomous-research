# Generic Self-Reflexion Agent Loop Spec

## 1. Objective

抽取一个通用“生成 → self-reflexion → 再生成”循环，供 Rubric / Contract 等相同模式的 AI 任务复用。

Figure 不纳入此通用循环，走独立的视觉 réflexion spec。

## 2. Public API

```ts
export type AgentCall = (
  role: RoleName,
  input: RoleInput,
  label: string,
) => Promise<RoleOutput>

export interface ReflexionOptions<T> {
  reflexion: (current: T, round: number) => string
  buildInput: (current: T | undefined, round: number, reflexion: string) => RoleInput
  parse: (result: RoleOutput) => T
  apply?: (value: T, round: number) => Promise<void>
  rounds?: number   // default 3
}

export async function runReflexion<T>(
  call: AgentCall,
  role: RoleName,
  options: ReflexionOptions<T>,
): Promise<T>
```

## 3. Behavior

```text
call(role, buildInput(undefined, 0, ''))
  -> parse -> T
  -> apply(T, 0)

for round = 1..rounds:
  question = reflexion(current, round)
  next = call(role, buildInput(current, round, question))
  if next === current: break
  apply(next, round)
  current = next

return current
```

## 4. Implemented Callers

| Caller | role | type T |
|---|---|---|
| `ensureRubric` | `rubric-generator` | `string` |
| `negotiateContract` | `contract-negotiator` | `string` |

## 5. File Locations

```text
src/service/agent-loop.ts          # generic loop
src/service/steps/idea.ts          # rubric caller
src/paper/phases.ts                # contract caller
```

## 6. Exclusions

- Figure does not use this loop.
- State machine is not moved into the loop.
- No new AI role is introduced.

## 7. Acceptance Criteria

1. Rubric / Contract both pass through `runReflexion`.
2. `reflexion` text is task-specific.
3. `apply` side effects still happen per round.
4. `rounds` defaults to 3 and stops on unchanged value.
5. `npm run typecheck` / `npm test` pass.
