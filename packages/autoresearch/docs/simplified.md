# Autoresearch 泛化与简化方案

> 本文记录当前代码的泛化方向。总目标是：**减少 class 属性、减少 enum/字符串联合、减少函数入参与出参**，同时处理代码中人工标注的 TODO。

---

## 1. 目标与原则

1. **数据驱动取代硬编码**
   - 角色、阶段、审核门、LaTeX 引擎等都用“注册表 + 数据”描述。
   - 新增一项只改数据，不改业务函数。

2. **接口尽量少**
   - 能用一个对象就不用三个参数。
   - 能返回一个领域对象就不返回多个零散结果。

3. **域之间解耦**
   - `brainstorm`、`research`、`paper`、`general` 四类角色明确分离。
   - 不互相感知内部字段。

4. **保留类型安全，但不增加心智负担**
   - 没有必要时不引入泛型、不引入多套 Input 接口。
   - enum 通过 `const` 数组 + `typeof` 派生，单一事实来源。

---

## 2. 当前已完成的改造

- `agents/factory.ts` 已从 330 行缩减为纯 Prompt/Schema 入口。
- `agents/roles/` 已按域拆分：
  - `general.ts`：不好归类的通用角色
  - `brainstorm.ts`
  - `research.ts`
  - `paper.ts`
  - `index.ts`：统一注册表
- `RoleInput.candidate` 已改为 `idea`，避免与业务中的 Idea 概念割裂。
- `objectSchema` 和 `cleanSchemaNode` 已抽到 `agents/schema.ts`。
- `RoleSpec` 已成为纯数据：
  ```ts
  interface RoleSpec {
    sections: readonly (keyof RoleInput)[]
    outputSchema?: JsonSchema
  }
  ```

---

## 3. 核心简化策略

### 3.1 减少 class attrs

把“多个独立配置字段”收拢成聚合对象：

```ts
// 改造前
class ResearchRunner {
  provider
  maxCycles
  paperOptions
  reviewer
  reviewGates
  humanReviewOverride
  idea
  brainstorm
  logger
}

// 改造后
class ResearchRunner {
  constructor(
    private readonly provider: RoleAgentProvider,
    private readonly options: ResearchRunnerOptions,
    private logger: Logger = createLogger(),
  ) {}
}
```

### 3.2 减少 enum / 字符串联合

用 `const` 数组作为唯一来源：

```ts
const RUN_PHASES = [
  'intake',
  'brainstorm',
  'rubric',
  'ideation',
  'hypothesis_revision',
  'plan',
  'minimal_verification',
  'experiment_design',
  'experiment_reflexion',
  'work',
  'evidence',
  'result_reflexion',
  'decide',
  'paper',
  'failed',
] as const

export type RunPhase = typeof RUN_PHASES[number]
```

同样处理：

- `RoleName`
- `ReviewGateId`
- `ReviewVerdict`
- `EvidenceVerdict`
- `PoolStatus`
- `HumanReviewMode`
- `LogLevel`

### 3.3 减少函数入参 / 出参

用 request/context 对象取代长参数列表：

```ts
// 改造前
runStage(
  runDir, state, phase, stepId,
  role, label, input, context, outputFile?
)

// 改造后
runStage({
  session,
  phase,
  stepId,
  role,
  label,
  input,
  outputFile,
})
```

出参优先返回领域对象：

```ts
// 改造前
exportEvidenceChain(runDir, runId, tree): Promise<string>

// 改造后
exportEvidenceChain(input: {
  runDir: string
  runId: string
  tree: ResearchTree
}): Promise<{
  chain: EvidenceChain
  file: string
}>
```

### 3.4 不做的事

- 不引入 DAG / EventBus / 任务队列 / 数据库。
- 不把 `RoleInput` 拆成 4 套复杂泛型接口。
- 不把每个 role 拆成单独文件；按域拆即可。
- 不引入依赖注入框架。
- 不为“可能未来用到”的抽象增加代码，除非当前已有 TODO 或明确复用点。

---

## 4. 目标目录结构

```text
src/
  agents/
    factory.ts
    schema.ts
    types.ts
    roles/
      general.ts
      brainstorm.ts
      research.ts
      paper.ts
      index.ts
      types.ts
  brainstorm/
    pipeline.ts
    ranking.ts
    handoff.ts
  core/
    phase.ts          # RUN_PHASES 等常量
    state-store.ts    # StateStore
    research-tree.ts
    hypothesis-pool.ts
    human-review.ts
    utils.ts
  domain/
    idea.ts
    idea-gate.ts
    files.ts
    idea-file.ts
  export/
    evidence-chain.ts
  paper/
    pipeline.ts
    engine.ts         # LatexEngine 注册表
    audit.ts
    checkpoint.ts
    references.ts
    index.ts
  providers/
    subagent-provider.ts
  security/
    index.ts
  service/
    runner.ts
    run-session.ts
    autoresearch-service.ts
  session/
    store.ts
    auto-mode.ts
    last-run.ts
  tools/
    index.ts
```

---

## 5. 逐目录方案

### 5.1 `agents`

**现状**
- `RoleName` 是手写 32 项字符串联合。
- `RoleAgentProvider.run(role, input, context)` 3 个入参。
- `RoleInput` 仍是扁平大接口，但已按语义分组。

**建议**

1. 派生 `RoleName`：
   ```ts
   // roles/index.ts
   export type RoleName = keyof typeof roleSpecs
   ```
   `types.ts` 只做 re-export，避免手动同步。
   > 循环依赖注意：如果 `types.ts` 反向依赖 `roles/index.ts`，可以把 `RoleInput` / `RoleExecutionContext` 移到独立的 `agent-types.ts`，让 `roles/types.ts` 从该文件导入；`roles/index.ts` 只负责产出 `RoleName`。

2. Provider 入参收敛为 1 个：
   ```ts
   export interface AgentRequest {
     role: RoleName
     input: RoleInput
     context: RoleExecutionContext
   }

   export interface RoleAgentProvider {
     run(request: AgentRequest): Promise<RoleOutput>
   }
   ```

3. 保留扁平 `RoleInput`，不拆多套 Input 接口：
   - 减少理解成本。
   - 每个 role 的 `sections` 已经控制实际渲染哪些字段。

4. `general.ts` 作为兜底：
   - 后续不好归类的角色直接放这里。
   - 不强行塞进 brainstorm/research/paper。

---

### 5.2 `brainstorm`

**现状问题**
- 方法参数多：
  - `propose(runDir, seed, wikiIndex, context)`
  - `debate(runDir, seed, wikiIndex, candidates, context)`
  - `reform(runDir, seed, wikiIndex, ranked, context)`
- `CandidateDirection` / `RankedDirection` 两套相似接口。
- TODO：ranking 算法写死，不能替换，search 阶段无法复用。
- TODO：handoff 用正则从 markdown 反向解析。

**建议**

1. 引入 `BrainstormContext`：
   ```ts
   interface BrainstormContext {
     runDir: string
     seed: string
     wikiIndex: string
     agentContext: RoleExecutionContext
   }
   ```

2. 抽取可替换 ranking：
   ```ts
   interface RankingStrategy {
     rank(
       ctx: BrainstormContext,
       candidates: CandidateDirection[],
       provider: RoleAgentProvider,
     ): Promise<RankedDirection[]>
   }

   class DefaultRankingStrategy implements RankingStrategy { ... }
   ```
   为了不增加 class attrs，`ranking` 作为 `BrainstormOptions` 的可选字段注入：
   ```ts
   interface BrainstormOptions {
     ranking?: RankingStrategy
     ...
   }

   class BrainstormPipeline {
     constructor(
       private readonly provider: RoleAgentProvider,
       private readonly options: BrainstormOptions,
     ) {}
   }
   ```
   这样类仍保持 2 个 attrs，同时 ranking 可替换、后续 search 阶段可复用。

3. 消除 handoff 正则：
   ```ts
   interface IdeaHandoff {
     direction: string
     cheapTest: string
     backups: string[]
   }

   private async reform(
     ctx: BrainstormContext,
     ranked: RankedDirection[],
   ): Promise<IdeaHandoff>
   ```
   直接写 `input/idea.md` 和 `PROFILE.md`，不再用正则抽取。

4. 合并候选接口：
   ```ts
   interface CandidateDirection {
     id: string
     source: string
     direction: string
     evidence: string[]
     cheapTest: string
     risk: string
     total?: number
     novelty?: number
     feasibility?: number
     evidenceScore?: number
   }
   ```

---

### 5.3 `core`

**现状问题**
- 大量手写字符串联合。
- `state.ts` 的 `transition(state, phase, stepId, data)` 4 个入参。
- `withRetry(operation, label, attempts)` 3 个入参。
- `ResearchTree` / `HypothesisPool` 部分方法参数偏多。

**建议**

1. 用 `const` 数组派生枚举：
   - `RunPhase`
   - `RunStatus`
   - `ReviewGateId`
   - `EvidenceVerdict`
   - `PoolStatus`
   - `LogLevel`

2. 引入 `StateStore`：
   ```ts
   class StateStore {
     constructor(private readonly runDir: string) {}

     load(): Promise<RunState | undefined>
     save(state: RunState): Promise<RunState>
     transition(state: RunState, phase: RunPhase, stepId: string): Promise<RunState>
     appendEvent(event: Omit<RunEvent, 'time'>): Promise<void>
   }
   ```

3. `withRetry` 对象化：
   ```ts
   withRetry({
     operation,
     label,
     attempts = 2,
   })
   ```

4. `ResearchTree.add` 对象化：
   ```ts
   add({
     kind,
     content,
     id?,
     status?,
     parent?,
     artifacts?,
   })
   ```

5. `HypothesisPool` 字段改名：
   - `origin_candidate_id` → `origin_idea_id`
   - `syncFromTree(tree, { originIdeaId? })`

6. 删除 `ResearchTree.path()` 等低价值方法。

---

### 5.4 `domain`

**现状问题**
- `idea-gate.ts` 中 `lightHardGate` 4 个入参。
- `files.ts` 的文件函数反复传 `runDir`，且 `readCandidate` 依赖正则。
- 领域模型命名仍残留 `Candidate`。

**建议**

1. Gate 入参聚合：
   ```ts
   interface GateInput {
     structural: StructuralCheckReport
     falsifiability: FalsifiabilityReport
     reviews?: SkepticReport[]
     validationPlan?: ValidationPlan
   }

   preGate(input: GateInput): GateDecision
   lightHardGate(input: GateInput): GateDecision
   ```

2. `GateDecision` 元信息分组：
   ```ts
   interface GateDecision {
     idea_id: string
     gate_phase: 'pre_gate' | 'full'
     verdict: GateVerdict
     rubric_version: string
     item_scores: RubricItemScore[]
     blocking_factor: string | null
   }
   ```
   保持数据结构，但函数只接收一个 `GateInput`。

3. 引入 `RunFiles`：
   ```ts
   class RunFiles {
     constructor(private readonly runDir: string) {}

     readIdea(): Promise<ResearchIdea>
     readRubric(): Promise<string>
     writeRubric(text: string): Promise<string>
     readPlan(version: number): Promise<string>
     writePlan(version: number, plan: string): Promise<string>
   }
   ```
   减少 `runDir` 重复传入。

4. 命名统一：
   - `Candidate` → `ResearchIdea`
   - `readCandidate` → `readIdea`
   - `candidatePath` 对外可以保留兼容名，内部统一 `idea`。

---

### 5.5 `export`

**现状问题**
- `EvidenceChain` 中 `hypotheses/actions/evidence` 是 `unknown[]`。
- `exportEvidenceChain(runDir, runId, tree)` 3 个入参。
- Paper 审计无法直接使用结构化数据，只能靠正则。
- 对应 `paper/index.ts` 的 TODO。

**建议**

1. 类型化：
   ```ts
   import type { ResearchNode } from '../core/types.js'

   export interface EvidenceChain {
     schema: 'autoresearch/evidence-chain/v1'
     run_id: string
     generated_at: string
     hypotheses: ResearchNode[]
     actions: ResearchNode[]
     evidence: ResearchNode[]
   }
   ```

2. 输出对象 + 路径：
   ```ts
   export interface EvidenceChainResult {
     chain: EvidenceChain
     file: string
   }

   export async function exportEvidenceChain(input: {
     runDir: string
     runId: string
     tree: ResearchTree
   }): Promise<EvidenceChainResult>
   ```

3. 增加 helper：
   ```ts
   export function collectEvidenceIds(tree: ResearchTree): string[]
   export function evidenceMap(chain: EvidenceChain): Map<string, ResearchNode>
   ```

---

### 5.6 `paper`

**现状问题**
- `PaperContext` 9 个字段。
- 多个方法 4～5 个入参。
- `auditPaper(runDir, knownEvidenceIds)` 依赖字符串 ID + LaTeX 正则。
- `runCompileLoop(paperDir, fix, maxRounds)` 3 个入参。
- LaTeX 引擎 if/else 会持续膨胀，对应 TODO。
- `paper/index.ts` 中 numericClaimAudit 的 TODO 需要通过 EvidenceChain 解决。

**建议**

1. `PaperContext` 分组：
   ```ts
   interface PaperPaths {
     runDir: string
     paperDir: string
   }

   interface PaperContent {
     planText: string
     matrixText: string
     contractText: string
     figuresLatex: string
     styleProfile?: string
     evidencePath: string
   }

   interface PaperContext {
     paths: PaperPaths
     content: PaperContent
     agentContext: RoleExecutionContext
   }
   ```

2. 方法统一接收 `ctx`：
   ```ts
   private plan(input: {
     runDir: string
     evidencePath: string
     matrixText: string
     context: RoleExecutionContext
   }): Promise<string>

   private contract(ctx: PaperContext): Promise<string>
   private figures(ctx: PaperContext): Promise<string>
   private write(ctx: PaperContext, feedback?: string): Promise<void>
   ```

3. 审计消费 EvidenceChain：
   ```ts
   auditPaper(input: {
     runDir: string
     chain: EvidenceChain
   }): Promise<AuditReport>
   ```
   `numericClaimAudit` 改为基于结构化 evidence ID 判断，不再只依赖 `% evidence:` 正则。

4. LaTeX 引擎抽象：
   ```ts
   interface LatexEngine {
     name: string
     command: string
     args(paperDir: string): string[]
     env?(): Record<string, string>
   }

   const latexEngines: Record<string, LatexEngine> = {
     latexmk: { ... },
     tectonic: { ... },
     xelatex: { ... },
     pdflatex: { ... },
   }
   ```
   `compilePaper` 只做查表调用，后续新增引擎只需加配置。

5. `runCompileLoop` 对象化：
   ```ts
   runCompileLoop({
     paperDir,
     fix,
     maxRounds = 5,
   })
   ```

---

### 5.7 `providers`

**现状问题**
- `SubagentRoleAgentProvider.run(role, input, context)` 3 个入参。
- 多个 `Like` 接口相似。

**建议**

1. `run` 接收 `AgentRequest`：
   ```ts
   async run(request: AgentRequest): Promise<RoleOutput> {
     const { role, input, context } = request
     const prompt = await buildPrompt(role, input)
     ...
   }
   ```

2. 合并近似接口：
   - `SubagentStartRequestLike`
   - `SubagentResultLike`
   - `SubagentRunLike`
   统一收敛为一个 `SubagentRuntime` 接口。

3. 保持 class attrs 2 个：
   - `runtime`
   - `providerName`

---

### 5.8 `security`

**现状**
- 已非常轻量，函数入参少。
- 不建议为了泛化而增加抽象。

**建议**
- 基本不动。
- 可选：将 `PaperMetaLike` 重命名为 `PaperMetadata`，与 `EvidenceChain` 风格统一。
- `detectLeakage` 保持返回 `string[]`，够用即可。

---

### 5.9 `service`

**现状问题**
- `ResearchRunner` 9 个 class attrs，是全项目最大问题。
- `runStage` 9 个入参。
- `runIdeaGeneration` 9 个入参。
- `reviewGate` 6 个入参。
- `ResearchRunContext extends RoleExecutionContext {}` 是空接口，冗余。

**建议**

1. `ResearchRunner` 收拢为 3 个 attrs：
   ```ts
   class ResearchRunner {
     constructor(
       private readonly provider: RoleAgentProvider,
       private readonly options: ResearchRunnerOptions,
       private logger: Logger = createLogger(),
     ) {}
   }
   ```

2. 引入 `RunSession`：
   ```ts
   interface RunSession {
     runDir: string
     state: RunState
     tree: ResearchTree
     context: RoleExecutionContext
   }
   ```

3. `runStage` 对象化：
   ```ts
   interface StageRequest {
     session: RunSession
     phase: RunPhase
     stepId: string
     role: RoleName
     label: string
     input: RoleInput
     outputFile?: string
   }

   private runStage(request: StageRequest): Promise<string>
   ```

4. `runIdeaGeneration` 对象化：
   ```ts
   interface IdeaGenerationRequest {
     session: RunSession
     idea: string
     profile: string
     failureDirections?: string
     insight?: string
     feedback?: string
   }
   ```

5. `reviewGate` 对象化：
   ```ts
   interface ReviewGateRequest {
     session: RunSession
     gate: ReviewGateId
     title: string
     detail: string
   }
   ```

6. 删除空接口：
   - `ResearchRunContext` 直接使用 `RoleExecutionContext`。

7. `AutoResearchService` 的 `reviewer` / `reviewGates` 合并为 `options`，减少 attrs。

---

### 5.10 `session`

**现状问题**
- `'auto' | 'on' | 'off'` 在多处重复。
- `profileDir` 反复传参。

**建议**

1. 定义 `HumanReviewMode`：
   ```ts
   export const HUMAN_REVIEW_MODES = ['auto', 'on', 'off'] as const
   export type HumanReviewMode = typeof HUMAN_REVIEW_MODES[number]
   ```
   在 `session/auto-mode.ts` 导出，`service`、`tools`、`brainstorm` 共用。

2. 可选合并 `SessionStore`：
   ```ts
   class SessionStore {
     constructor(private readonly profileDir?: string) {}

     readAutoMode(): Promise<boolean>
     writeAutoMode(enabled: boolean): Promise<boolean>
     readLastRun(): Promise<LastRunInfo | undefined>
     writeLastRun(runDir: string): Promise<LastRunInfo>
   }
   ```

---

### 5.11 `tools`

**现状问题**
- 多个 tool 参数 schema 重复。
- `createResearchRunTool` 手写长字段映射。
- 多个 enum 字符串在 schema 里重复。

**建议**

1. 共享 schema 常量：
   ```ts
   const humanReviewModeSchema = {
     type: 'string',
     enum: HUMAN_REVIEW_MODES,
   }

   const jsonOutput = {
     schema: { type: 'object', additionalProperties: true },
     render: renderJson,
   }
   ```

2. 抽 args → options 转换：
   ```ts
   function toResearchRunOptions(args: Record<string, unknown>): ResearchRunOptions {
     return {
       runDir: String(args.runDir),
       candidatePath: asString(args.candidatePath),
       ...
     }
   }
   ```

3. 工具里的 `'hypothesis' | 'action' | 'evidence'` 改为从 `ResearchNodeKind` 常量派生。

---

### 5.12 根 `index.ts`

**现状**
- 只是服务装配和工具注册。

**建议**
- 保持公开 API 稳定。
- 如果 `RoleName` 改为派生类型，注意避免循环依赖。
- 不把内部重构暴露到入口。

---

## 6. 人工 TODO 处理清单

| 位置 | TODO | 处理方式 | 目标文件 |
|---|---|---|---|
| `brainstorm/pipeline.ts` | rank 算法应可替换，并可在 search 阶段复用 | 抽取 `RankingStrategy`，默认实现注入 | `brainstorm/ranking.ts` |
| `brainstorm/pipeline.ts` | handoff 正则应通过流程优化掉 | 返回 `IdeaHandoff` 结构化对象，直接写文件 | `brainstorm/handoff.ts`、`domain/idea-file.ts` |
| `paper/index.ts` | 证据链导出应使用 `EvidenceChain` 对象，减少正则消耗 | `EvidenceChain` 类型化并提供 `collectEvidenceIds` / `evidenceMap` | `export/evidence-chain.ts`、`paper/audit.ts` |
| `paper/index.ts` | 其他 LaTeX 引擎待适配 | 抽象 `LatexEngine` + 注册表 | `paper/engine.ts` |

---

## 7. 实施阶段

### Phase 1：常量与类型派生
- `RunPhase`
- `ReviewGateId`
- `HumanReviewMode`
- `RoleName`
- 共用 schema 常量
- 风险最低，TypeScript 可快速验证。

### Phase 2：Brainstorm 泛化
- `BrainstormContext`
- `RankingStrategy`
- `IdeaHandoff`
- 解决两个 brainstorm TODO。

### Phase 3：EvidenceChain 结构化
- 类型化 `EvidenceChain`
- `exportEvidenceChain` 返回对象
- Paper 审计改用它
- 解决 `paper/index.ts` 正则 TODO。

### Phase 4：Paper 引擎与上下文
- `LatexEngine` 注册表
- `PaperContext` 分组
- `runCompileLoop` 对象化
- 解决 LaTeX 引擎 TODO。

### Phase 5：Service 大收口
- `ResearchRunner` attrs 降为 3
- `RunSession`
- `StageRequest`
- `IdeaGenerationRequest`
- `ReviewGateRequest`
- 工作量最大，逐步迁移。

### Phase 6：清理重复
- `StateStore`
- `RunFiles`
- `SessionStore`
- 删除空接口
- 删除低价值方法

---

## 8. 验收标准

1. **无行为变化**
   - 所有现有流程仍可运行。
   - 生成的 Prompt、Schema、状态文件内容保持兼容。

2. **类 attrs 明显减少**
   - `ResearchRunner`：9 → 3
   - `AutoResearchService`：3 → 2
   - `PaperPipeline`：保持 2
   - `BrainstormPipeline`：保持 2（ranking 放进 `BrainstormOptions`，不新增 attr）

3. **enum 不再手写维护**
   - 主要字符串联合均由 `const` 数组派生。
   - `RoleName` 由 `roleSpecs` 派生。

4. **长参数函数消除**
   - 不再出现 6 个以上入参的私有方法。
   - `runStage`、`runIdeaGeneration`、`reviewGate`、`lightHardGate`、`exportEvidenceChain` 等均为 1 个对象入参。

5. **TODO 全部有明确落点**
   - 每个 TODO 都能在目标目录中找到对应模块。

6. **TypeScript 严格模式通过**
   - 每阶段执行：
     ```bash
     npm run typecheck
     ```
