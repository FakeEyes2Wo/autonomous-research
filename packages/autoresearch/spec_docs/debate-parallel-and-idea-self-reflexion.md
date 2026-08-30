# Debate Parallel + Idea Self-Reflexion Spec

## 1. Objective

1. 将 Brainstorm debate 从串行改为按 candidate 并行。
2. 将 idea 阶段每个 hypothesis 的 `idea-falsifiability` + `idea-reviewer` 子检查改为 self-reflexion。

---

## 2. Debate Parallel

### 2.1 当前

```text
for each candidate:
  provider.run('brainstorm', perspective='debate')
  update candidate
  append to DEBATE.md
```

### 2.2 目标

```text
Promise.all([
  debate(candidate 1),
  debate(candidate 2),
  debate(candidate 3),
])
  ↓ 按原始顺序合并
  ↓ 统一写 DEBATE.md
```

### 2.3 数据边界

- 并行期间不修改共享 `candidates` 数组。
- 每个 candidate 独立运行，只读自己的内容。
- 返回每个 candidate 的：
  - revisedDirection
  - attack / support 列表
- 全部完成后按原顺序更新 candidates 并写 DEBATE.md。

### 2.4 代码位置

```text
src/brainstorm/pipeline.ts
function debate()
```

### 2.5 验收

1. 并行调用 3 个 debate subagent。
2. `DEBATE.md` 顺序与原始 candidates 顺序一致。
3. candidate 的 `direction` 修订仍生效。
4. `npm run typecheck` / `npm test` 通过。

---

## 3. Idea Self-Reflexion

### 3.1 当前

```text
idea-generator
  ↓
for each hypothesis:
  idea-falsifiability
  idea-reviewer
  lightHardGate
```

### 3.2 目标

```text
idea-generator
  ↓
for each hypothesis:
  idea-reflexion（self-reflexion loop）
  ↓
结构校验 + gate
```

一个 `idea-reflexion` 角色替代原来的：

- `idea-falsifiability`
- `idea-reviewer`

### 3.3 New Role

`idea-reflexion`

输入：

```ts
{
  runDir
  ideaPackage: string
  profile?: string
  treeSummary?: string
  plan?: string   // self-reflexion round text
  revisedIdeaPackage?: string
}
```

输出：

```ts
{
  is_falsifiable: boolean
  testable_implication: string
  unobservable_variables: string[]
  critique: string
  unaddressed_risks: string[]
  fatal_flaw_found: boolean
  revised?: IdeaPackage
}
```

### 3.4 Self-Reflexion Loop

复用：

```text
src/service/agent-loop.ts
runReflexion<T>()
```

```ts
const result = await runReflexion(
  (role, input, label) => runAgent(ctx, { role, input, label }),
  'idea-reflexion',
  {
    reflexion: (current, round) =>
      `Self-reflexion round ${round}: check falsifiability, unobservable variables, risks, and fatal flaws. Return an improved hypothesis or keep it if acceptable.`,

    buildInput: (current, round, reflexion) => ({
      runDir: ctx.runDir,
      ideaPackage: JSON.stringify(current.package),
      ...(current ? { plan: reflexion, revisedIdeaPackage: JSON.stringify(current.package) } : {}),
    }),

    parse: (result) => ({
      package: current.package,
      isFalsifiable: result.structured.is_falsifiable,
      ...
    }),
    ...
  },
)
```

### 3.5 Gating

`preGate` / `lightHardGate` 保留，但输入改为：

- `FalsifiabilityReport` 由 `idea-reflexion` 结果构造
- `SkepticReport` 也由 `idea-reflexion` 结果构造

### 3.6 Role Cleanup

删除：

- `idea-falsifiability`
- `idea-reviewer`

删除对应：

- prompt 文件
- role spec
- fake provider 分支

### 3.7 代码位置

```text
src/service/steps/idea.ts
src/agents/roles/research.ts
prompts/system/idea-reflexion.md
```

---

## 4. 非目标

- 不合并多个 hypothesis 到一次调用。
- 不改变 `lightHardGate` 的总体语义。
- 不改变 idea-generator 的初始生成逻辑。
- 不改变 figure / contract / rubric 现有流程。

---

## 5. 验收标准

1. Debate 并发完成，输出顺序稳定。
2. Idea 阶段不再调用 `idea-falsifiability` / `idea-reviewer`。
3. 每个 hypothesis 通过 `idea-reflexion` self-reflexion 后进入 gate。
4. `idea-reflexion` 能返回：
   - falsifiability
   - critique / risks
   - fatal flaw
   - revised hypothesis
5. `npm run typecheck` / `npm test` 通过。
