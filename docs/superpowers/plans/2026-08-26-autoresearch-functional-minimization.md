# Autoresearch Functional Minimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every existing public capability and artifact while removing redundant attrs, stateless classes, forwarding layers, duplicated registries, and duplicated algorithms from `packages/autoresearch/src`.

**Architecture:** Keep brainstorm, idea, experiment, research orchestration, and paper writing as separate feature modules. Pass one per-run context through named functions, centralize genuinely shared execution and persistence mechanisms, and retain classes only for public compatibility or stateful domain invariants.

**Tech Stack:** TypeScript 5 in strict NodeNext mode, Node.js 22, `node:test`, DSH role-agent provider interfaces, filesystem-backed JSON/Markdown checkpoints.

## Global Constraints

- Preserve package root exports, DSH tool names, tool schemas, output shapes, run-directory filenames, JSON schemas, prompts' business inputs, state transitions, checkpoint recovery, and human-review behavior.
- Internal interfaces may change completely.
- Keep brainstorm, idea, experiment, paper, and tools as independently understandable and testable features; do not merge them into a workflow DSL.
- Any implementation with the same semantics and reason to change must be shared; similar-looking business decisions with different semantics remain separate.
- Do not add dependencies, EventBus, DAG, task queue, dependency-injection framework, or a new error hierarchy.
- Temporary stage results stay in local parameters and return values, not long-lived attrs or a universal context bag.
- Use TDD for every behavior change and keep every task independently buildable and testable.
- Preserve unrelated user changes and stage only the files named by the current task.

---

## Preflight Baseline

- [ ] Run `npm run typecheck` from `packages/autoresearch`; expected exit code is 0.
- [ ] Run `npm test` from `packages/autoresearch`; expected exit code is 0.
- [ ] Record the passing test names in the implementation session notes. If either command fails before edits, stop and diagnose the baseline instead of treating the failure as a refactor regression.

---

## File Map

**Create**

- `packages/autoresearch/src/service/context.ts`: single research-run context and tree refresh.
- `packages/autoresearch/src/service/agent.ts`: shared role execution and stage persistence.
- `packages/autoresearch/src/service/review.ts`: shared human-review execution and recording.
- `packages/autoresearch/test/unit/service-runtime.test.ts`: shared runtime behavior.
- `packages/autoresearch/test/unit/review-gate.test.ts`: review mechanism behavior.
- `packages/autoresearch/test/unit/ranking.test.ts`: reusable brainstorm ranking behavior.
- `packages/autoresearch/test/unit/architecture.test.ts`: regression guard against forbidden forwarding classes and duplicate definitions.

**Modify**

- `packages/autoresearch/src/agents/roles/index.ts`, `agents/types.ts`, `agents/factory.ts`: derive role names from the role registry.
- `packages/autoresearch/src/service/steps/idea.ts`: stateless idea/rubric functions.
- `packages/autoresearch/src/service/steps/experiment.ts`: stateless experiment functions.
- `packages/autoresearch/src/service/steps/paper.ts`: stateless research-to-paper handoff.
- `packages/autoresearch/src/service/runner.ts`: explicit research loop using feature functions.
- `packages/autoresearch/src/service/autoresearch-service.ts`: one dependency attr and public compatibility.
- `packages/autoresearch/src/paper/context.ts`, `paper/phases.ts`, `paper/pipeline.ts`: functional paper runtime and checkpoint orchestration.
- `packages/autoresearch/src/brainstorm/ranking.ts`, `brainstorm/pipeline.ts`: functional ranking and brainstorm orchestration.
- `packages/autoresearch/src/core/utils.ts`: optional-file helper that only handles missing files.
- Existing unit/integration tests: consume canonical registries and pin compatibility.
- `packages/autoresearch/docs/simplified.md`: describe the final, smaller mental model.

**Delete after all callers migrate**

- `packages/autoresearch/src/service/agent-runner.ts`
- `packages/autoresearch/src/service/research-steps.ts`
- `packages/autoresearch/src/domain/idea-file.ts` (currently unreferenced forwarding class)

---

### Task 1: Make the role registry the only role-name source

**Files:**

- Modify: `packages/autoresearch/src/agents/roles/index.ts`
- Modify: `packages/autoresearch/src/agents/types.ts`
- Modify: `packages/autoresearch/src/agents/factory.ts`
- Modify: `packages/autoresearch/test/unit/schema-validity.test.ts`

**Interfaces:**

- Produces: `roleSpecs`, `RoleName = keyof typeof roleSpecs`, and `roleNames: readonly RoleName[]` from `agents/roles/index.ts`.
- Preserves: `RoleName` re-export from `agents/types.ts` and all existing `RoleAgentProvider` signatures.

- [ ] **Step 1: Replace the hand-maintained test list with a failing registry assertion**

In `schema-validity.test.ts`, import the registry values and delete the local `roles` tuple:

```ts
import { roleNames, roleSpecs } from '../../dist/agents/roles/index.js'

test('role names come from the role spec registry', () => {
  assert.deepEqual(roleNames, Object.keys(roleSpecs))
  assert.equal(new Set(roleNames).size, roleNames.length)
})
```

Change the schema loop to `for (const role of roleNames)`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run build && node --experimental-strip-types --test test/unit/schema-validity.test.ts`

Expected: build or test fails because `roleNames` and registry-derived `RoleName` are not exported.

- [ ] **Step 3: Derive the runtime list and type from `roleSpecs`**

Use this shape in `agents/roles/index.ts`:

```ts
export const roleSpecs = {
  ...generalRoleSpecs,
  ...brainstormRoleSpecs,
  ...researchRoleSpecs,
  ...paperRoleSpecs,
} as const satisfies Record<string, RoleSpec>

export type RoleName = keyof typeof roleSpecs
export const roleNames = Object.freeze(Object.keys(roleSpecs) as RoleName[])
```

Delete the handwritten `RoleName` union from `agents/types.ts`, then add:

```ts
import type { RoleName } from './roles/index.js'
export type { RoleName } from './roles/index.js'
```

Keep `RoleAgentProvider.run(role: RoleName, ...)` unchanged. Remove the old `satisfies Record<RoleName, RoleSpec>` cycle from `roles/index.ts`.

- [ ] **Step 4: Run schema and type verification**

Run: `npm run build && node --experimental-strip-types --test test/unit/schema-validity.test.ts`

Expected: both role-registry tests pass and every role schema is still validated.

- [ ] **Step 5: Commit the single-source change**

```bash
git add packages/autoresearch/src/agents packages/autoresearch/test/unit/schema-validity.test.ts
git commit -m "refactor: derive agent roles from registry"
```

### Task 2: Introduce one run context and shared agent execution functions

**Files:**

- Create: `packages/autoresearch/src/service/context.ts`
- Create: `packages/autoresearch/src/service/agent.ts`
- Create: `packages/autoresearch/test/unit/service-runtime.test.ts`
- Modify: `packages/autoresearch/src/service/run-session.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`

**Interfaces:**

- Produces: `RunContext`, `createRunContext()`, `reloadTree()`, `runAgent()`, `runStage()`, `structuredText()`, and `treeSummary()`.
- Preserves temporarily: `RunSession` as a type alias and the existing `RoleRunner`, allowing feature modules to migrate separately.

- [ ] **Step 1: Add failing tests for retry, logging-compatible output, transition, and file persistence**

Create `service-runtime.test.ts` with this helper and assertions:

```ts
async function makeContext(run: RoleAgentProvider['run']): Promise<RunContext> {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-runtime-'))
  const state = await createInitialState(runDir)
  const tree = await ResearchTree.load(runDir)
  return createRunContext(
    { provider: { run }, brainstorm: 'off' },
    runDir,
    state,
    tree,
    {
      parent: { id: 'agent-1', session: { id: 'agent-1' } },
      signal: new AbortController().signal,
    },
  )
}
```

```ts
test('runAgent retries once and returns the provider result', async (t) => {
  let calls = 0
  const ctx = await makeContext(async () => {
    calls += 1
    if (calls === 1) throw new Error('transient')
    return { text: 'ok', structured: { plan: 'P' }, stopReason: 'completed' }
  })
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))
  const result = await runAgent(ctx, {
    role: 'planner',
    label: 'plan',
    input: { runDir: ctx.runDir },
  })
  assert.equal(calls, 2)
  assert.equal(structuredText(result.structured, 'plan'), 'P')
})

test('runStage transitions and writes structured output', async (t) => {
  const ctx = await makeContext(async () => ({
    text: 'fallback', structured: { verdict: 'proceed' }, stopReason: 'completed',
  }))
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))
  const text = await runStage(ctx, {
    phase: 'experiment_reflexion',
    stepId: 'reflect-1',
    role: 'experiment-reflexion',
    label: 'reflect',
    input: { runDir: ctx.runDir },
    outputFile: 'EXPERIMENT_REFLEXION.md',
  })
  assert.equal(ctx.state.phase, 'experiment_reflexion')
  assert.deepEqual(JSON.parse(text), { verdict: 'proceed' })
  assert.equal(await readFile(join(ctx.runDir, 'EXPERIMENT_REFLEXION.md'), 'utf8'), text)
})
```

The helper must create a temp directory, `RunState`, `ResearchTree`, `createLogger(dir)`, and a provider whose `run` calls the supplied callback; each test removes its directory in `t.after()`.

- [ ] **Step 2: Run the focused test and verify missing exports**

Run: `npm run build && node --experimental-strip-types --test test/unit/service-runtime.test.ts`

Expected: FAIL because `service/context.js` and `service/agent.js` do not exist.

- [ ] **Step 3: Implement the context without duplicate provider attrs**

Use `Readonly<ResearchRunnerOptions>` itself as the stable dependency object:

```ts
export interface RunContext {
  readonly deps: Readonly<ResearchRunnerOptions>
  readonly runDir: string
  readonly state: RunState
  tree: ResearchTree
  readonly context: RoleExecutionContext
  readonly logger: Logger
}

export function createRunContext(
  deps: Readonly<ResearchRunnerOptions>,
  runDir: string,
  state: RunState,
  tree: ResearchTree,
  context: RoleExecutionContext,
): RunContext {
  return { deps, runDir, state, tree, context, logger: createLogger(runDir) }
}

export async function reloadTree(ctx: RunContext): Promise<void> {
  ctx.tree = await ResearchTree.load(ctx.runDir)
}
```

In `run-session.ts`, re-export `RunContext` as the temporary compatibility alias `RunSession`, and implement `reloadSessionTree` by calling `reloadTree`.

- [ ] **Step 4: Implement the shared executor**

`service/agent.ts` must expose these exact request shapes:

```ts
export interface AgentRequest {
  role: RoleName
  label: string
  input: RoleInput
}

export interface StageRequest extends AgentRequest {
  phase: RunPhase
  stepId: string
  outputFile?: string
}
```

`runAgent(ctx, request)` performs the existing `withRetry`, timing, success/error logging, and calls `ctx.deps.provider.run(request.role, request.input, ctx.context)`. `runStage(ctx, request)` performs `transition`, calls `runAgent`, serializes `structured ?? { text }`, and writes `outputFile` through `safeResolve` when supplied. Move `structuredText` and `treeSummary` here as pure functions.

- [ ] **Step 5: Make `ResearchRunner.run()` create the context once**

Keep the existing public `run(runDir, state, tree, context)` signature, but create one context at the top and pass its fields to legacy code until Tasks 3–5 finish. Do not call `setLogger`; leave that removal for Task 5.

- [ ] **Step 6: Run focused and baseline tests**

Run: `npm run build && node --experimental-strip-types --test test/unit/service-runtime.test.ts test/integration/minimal-loop.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit the runtime core**

```bash
git add packages/autoresearch/src/service/context.ts packages/autoresearch/src/service/agent.ts packages/autoresearch/src/service/run-session.ts packages/autoresearch/src/service/runner.ts packages/autoresearch/test/unit/service-runtime.test.ts
git commit -m "refactor: add shared research runtime"
```

### Task 3: Convert idea and rubric steps from class attrs to functions

**Files:**

- Modify: `packages/autoresearch/src/service/steps/idea.ts`
- Modify: `packages/autoresearch/src/service/research-steps.ts`
- Create: `packages/autoresearch/test/unit/architecture.test.ts`
- Test: `packages/autoresearch/test/unit/idea-gate.test.ts`
- Test: `packages/autoresearch/test/integration/minimal-loop.test.ts`

**Interfaces:**

- Produces: `ensureRubric(ctx, input)`, `runIdeaGeneration(ctx, input)`, and `runHypothesisRevision(ctx)`.
- Consumes: `RunContext`, `runAgent`, `structuredText`, and `treeSummary` from Task 2.

- [ ] **Step 1: Add a failing structural test**

Create `architecture.test.ts` and resolve source files relative to `process.cwd()`:

```ts
test('idea steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/service/steps/idea.ts'), 'utf8')
  assert.doesNotMatch(source, /export class IdeaSteps/)
  assert.match(source, /export async function ensureRubric/)
  assert.match(source, /export async function runIdeaGeneration/)
})
```

- [ ] **Step 2: Run the structural test and verify it fails**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts`

Expected: FAIL because `IdeaSteps` still exists.

- [ ] **Step 3: Replace the class with named functions**

Export these exact inputs and functions from `steps/idea.ts`:

```ts
export interface IdeaGenerationInput {
  idea: string
  profile: string
  failureDirections?: string
  insight?: string
  feedback?: string
}

export interface EnsureRubricInput {
  idea: string
  profile: string
  feedback?: string
}

export async function ensureRubric(ctx: RunContext, input: EnsureRubricInput): Promise<void>
export async function runIdeaGeneration(ctx: RunContext, input: IdeaGenerationInput): Promise<void>
export async function runHypothesisRevision(ctx: RunContext): Promise<void>
```

Convert `runFalsifiability` and `runIdeaReviewer` to unexported module functions taking `ctx`. Replace every `this.roleRunner.run` with `runAgent(ctx, ...)`, every tree serialization with `treeSummary(ctx.tree)`, `this.logger` with `ctx.logger`, and assurance lookup with a pure `resolveResearchAssurance(ctx.deps.paperOptions)`.

Define the assurance helper in the same module:

```ts
function resolveResearchAssurance(
  options: ResearchRunnerOptions['paperOptions'],
): 'draft' | 'submission' {
  const { assurance, effort } = options ?? {}
  if (assurance === 'draft' || assurance === 'submission') return assurance
  return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
}
```

- [ ] **Step 4: Keep the temporary façade buildable**

Change `ResearchSteps` idea methods to call the new functions using the request's `session` context. Do not recreate an `IdeaSteps` object and do not duplicate any idea algorithm in the façade.

- [ ] **Step 5: Run focused behavior and integration tests**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts test/unit/idea-gate.test.ts test/integration/minimal-loop.test.ts`

Expected: all tests pass with unchanged idea/rubric artifacts and calls.

- [ ] **Step 6: Commit the idea conversion**

```bash
git add packages/autoresearch/src/service/steps/idea.ts packages/autoresearch/src/service/research-steps.ts packages/autoresearch/test/unit/architecture.test.ts
git commit -m "refactor: make idea steps stateless"
```

### Task 4: Convert experiment steps from class attrs to functions

**Files:**

- Modify: `packages/autoresearch/src/service/steps/experiment.ts`
- Modify: `packages/autoresearch/src/service/research-steps.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Test: `packages/autoresearch/test/integration/minimal-loop.test.ts`

**Interfaces:**

- Produces: named functions `runPlanner`, `runMinimalVerification`, `runModelScout`, `runExperimentDesign`, `runExperimentReflexion`, `runResultReflexion`, `runInsightAbstractor`, `runWorker`, `runEvidenceAgent`, and `runSupervisor`.
- Consumes: the Task 2 runtime functions; preserves every current return type.

- [ ] **Step 1: Extend the failing structural test**

```ts
test('experiment steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/service/steps/experiment.ts'), 'utf8')
  assert.doesNotMatch(source, /export class ExperimentSteps/)
  for (const name of ['runPlanner', 'runExperimentDesign', 'runWorker', 'runSupervisor']) {
    assert.match(source, new RegExp(`export async function ${name}`))
  }
})
```

- [ ] **Step 2: Run the structural test and verify it fails**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts`

Expected: FAIL on `ExperimentSteps`.

- [ ] **Step 3: Convert every method without merging domain decisions**

Each exported function takes `ctx: RunContext` first and a second object containing only its current stage-specific fields:

```ts
export async function runPlanner(
  ctx: RunContext,
  input: { idea: string; profile: string },
): Promise<string>

export async function runMinimalVerification(
  ctx: RunContext,
  input: { planText: string },
): Promise<string>

export async function runModelScout(
  ctx: RunContext,
  input: { planText: string },
): Promise<string>

export async function runExperimentDesign(ctx: RunContext, input: {
  planText: string
  minimalVerification: string
  modelScout: string
  feedback?: string
}): Promise<string>

export async function runExperimentReflexion(ctx: RunContext, input: {
  planText: string
  minimalVerification: string
  modelScout: string
  initialDesign: string
}): Promise<string>

export async function runResultReflexion(
  ctx: RunContext,
  input: { planText: string; experimentDesign: string },
): Promise<string>

export async function runInsightAbstractor(ctx: RunContext, input: {
  planText: string
  experimentDesign: string
  failureDirections: string
}): Promise<string>

export async function runWorker(ctx: RunContext, input: {
  workDir: string
  planText: string
  experimentDesign: string
  minimalVerification: string
}): Promise<ActionResult>

export async function runEvidenceAgent(
  ctx: RunContext,
  input: { planText: string },
): Promise<void>

export async function runSupervisor(
  ctx: RunContext,
  input: { planText: string },
): Promise<ResearchDecision>
```

Use `runStage` for the six existing stage-shaped operations and `runAgent` for planner, worker, evidence, and supervisor. Keep the experiment-reflexion retry loop explicit in this module. Use `structuredText` and `treeSummary`; do not add an experiment factory or closure object.

- [ ] **Step 4: Update the temporary façade to direct delegation**

Make each `ResearchSteps` experiment method call the matching function with `request.session` plus the stage-only fields. The façade must contain no provider, logger, retry, parsing, or domain algorithm.

- [ ] **Step 5: Verify the complete research loop**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts test/integration/minimal-loop.test.ts test/integration/leakage-loop.test.ts`

Expected: all tests pass, including two supervisor cycles and evidence export.

- [ ] **Step 6: Commit the experiment conversion**

```bash
git add packages/autoresearch/src/service/steps/experiment.ts packages/autoresearch/src/service/research-steps.ts packages/autoresearch/test/unit/architecture.test.ts
git commit -m "refactor: make experiment steps stateless"
```

### Task 5: Remove research forwarding layers and centralize review execution

**Files:**

- Create: `packages/autoresearch/src/service/review.ts`
- Create: `packages/autoresearch/test/unit/review-gate.test.ts`
- Modify: `packages/autoresearch/src/service/steps/paper.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`
- Modify: `packages/autoresearch/src/service/autoresearch-service.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Delete: `packages/autoresearch/src/service/agent-runner.ts`
- Delete: `packages/autoresearch/src/service/research-steps.ts`
- Delete: `packages/autoresearch/src/service/run-session.ts`

**Interfaces:**

- Produces: `reviewGate(ctx, request)` and `runPaper(ctx)` as shared/function-specific entry points.
- Preserves: public `ResearchRunner` and `AutoResearchService` constructors and methods.

- [ ] **Step 1: Add failing review and architecture tests**

In `review-gate.test.ts`, create a temp `RunContext` with `reviewGates: []`, call:

```ts
const answer = await reviewGate(ctx, {
  gate: 'idea', title: 'Proceed?', detail: 'details',
})
assert.deepEqual(answer, { verdict: 'approve' })
assert.match(await readFile(join(ctx.runDir, 'HUMAN_REVIEW.md'), 'utf8'), /gate disabled/)
```

Extend `architecture.test.ts`:

```ts
test('research orchestration has no forwarding classes', async () => {
  for (const file of ['agent-runner.ts', 'research-steps.ts', 'run-session.ts']) {
    assert.equal(existsSync(join(process.cwd(), 'src/service', file)), false)
  }
  const paper = await readFile(join(process.cwd(), 'src/service/steps/paper.ts'), 'utf8')
  assert.doesNotMatch(paper, /export class PaperSteps/)
})
```

- [ ] **Step 2: Run tests and verify the missing function/files fail**

Run: `npm run build && node --experimental-strip-types --test test/unit/review-gate.test.ts test/unit/architecture.test.ts`

Expected: FAIL because `reviewGate` is absent and forwarding files/classes remain.

- [ ] **Step 3: Extract the review mechanism once**

Move the current skip conditions, reviewer call, `appendHumanReview`, and ask-failure downgrade into:

```ts
export interface ReviewGateRequest {
  gate: ReviewGateId
  title: string
  detail: string
}

export async function reviewGate(
  ctx: RunContext,
  request: ReviewGateRequest,
): Promise<HumanReviewAnswer>
```

Use `ctx.deps.reviewGates`, `ctx.deps.humanReviewOverride`, `ctx.deps.reviewer`, `ctx.context`, and `ctx.logger`. Keep idea/rubric/experiment/evidence verdict branching in `runner.ts`.

- [ ] **Step 4: Make the paper handoff a function**

Replace `PaperSteps` with `export async function runPaper(ctx: RunContext): Promise<void>`. Preserve no-evidence failure, evidence-chain export, state update, paper option composition, pipeline call, and log line exactly.

- [ ] **Step 5: Simplify public orchestration attrs**

`ResearchRunner` keeps one attr:

```ts
constructor(private readonly deps: Readonly<ResearchRunnerOptions>) {}
```

Create `ctx` once and directly call idea, experiment, review, and paper functions. Replace `this.roleRunner.treeSummary` with `treeSummary`, `reloadSessionTree` with `reloadTree`, and `this.logger` with `ctx.logger`. Delete `RoleRunner`, `ResearchSteps`, and `RunSession` files after imports reach zero.

Change `AutoResearchService` to one stored attr while preserving its public two-argument constructor:

```ts
private readonly deps: Readonly<{ provider: RoleAgentProvider; options: AutoResearchServiceOptions }>

constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
  this.deps = { provider, options }
}
```

- [ ] **Step 6: Run all research and review tests**

Run: `npm run build && node --experimental-strip-types --test test/unit/service-runtime.test.ts test/unit/review-gate.test.ts test/unit/architecture.test.ts test/integration/minimal-loop.test.ts test/integration/leakage-loop.test.ts`

Expected: all tests pass and the three forwarding files are absent.

- [ ] **Step 7: Commit the orchestration cleanup**

```bash
git add packages/autoresearch/src/service packages/autoresearch/test/unit packages/autoresearch/test/integration
git commit -m "refactor: remove research forwarding layers"
```

### Task 6: Convert paper phases to independent functions and one audit registry

**Files:**

- Modify: `packages/autoresearch/src/paper/context.ts`
- Modify: `packages/autoresearch/src/paper/phases.ts`
- Modify: `packages/autoresearch/src/paper/pipeline.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Create: `packages/autoresearch/test/unit/paper-phases.test.ts`

**Interfaces:**

- Produces: `PaperOptions`, a `PaperContext` containing one `deps` object, and named paper phase functions.
- Produces: `PAPER_AUDITS`, the sole proof/claim/citation/kill audit registry.
- Preserves: `PaperOptions` and all current phase artifacts.

- [ ] **Step 1: Add failing class and registry tests**

Add to `architecture.test.ts`:

```ts
test('paper phases are stateless functions', async () => {
  const source = await readFile(join(process.cwd(), 'src/paper/phases.ts'), 'utf8')
  assert.doesNotMatch(source, /export class PaperPhases/)
  assert.match(source, /export const PAPER_AUDITS/)
  assert.match(source, /export async function writePaper/)
})
```

In `paper-phases.test.ts` assert the exact unique audit mapping:

```ts
assert.deepEqual(PAPER_AUDITS, [
  { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
  { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
  { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
  { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
])
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts test/unit/paper-phases.test.ts`

Expected: FAIL because the class and local tuple still exist.

- [ ] **Step 3: Put paper options and stable dependencies in `PaperContext`**

Move `PaperOptions` from `phases.ts` to `context.ts`, keep its fields unchanged, and re-export it from `pipeline.ts`. Then add:

```ts
export interface PaperDependencies {
  readonly provider: RoleAgentProvider
  readonly options: Readonly<PaperOptions>
}

export interface PaperContext {
  readonly deps: PaperDependencies
  readonly paths: PaperPaths
  readonly content: PaperContent
  readonly agentContext: RoleExecutionContext
}
```

Keep paths, loaded content, and agent context as existing fields; do not add checkpoint or temporary phase outputs.

- [ ] **Step 4: Replace `PaperPhases` methods with named functions**

Export the exact function family:

```ts
export function resolveAssurance(options: Readonly<PaperOptions>): 'draft' | 'submission'
export async function readStyleProfile(runDir: string): Promise<string | undefined>
export async function planPaper(ctx: PaperContext): Promise<string>
export async function negotiateContract(ctx: PaperContext): Promise<string>
export async function generateFigures(ctx: PaperContext): Promise<string>
export async function writePaper(ctx: PaperContext, feedback?: string): Promise<void>
export async function reviewPaperDraft(ctx: PaperContext): Promise<void>
export async function enrichReferences(ctx: PaperContext): Promise<void>
export async function runPaperAudits(ctx: PaperContext): Promise<Record<string, unknown>>
export async function improvePaper(ctx: PaperContext, cp: PaperCheckpoint): Promise<void>
export async function polishPaper(ctx: PaperContext): Promise<void>
export async function writePaperReport(ctx: PaperContext, assurance: string, compileOk: boolean, audits: Record<string, unknown>): Promise<string>
```

All former `this.provider` and `this.options` accesses become `ctx.deps.provider` and `ctx.deps.options`. Keep each phase's loops and business rules separate.

- [ ] **Step 5: Drive audits from the exported registry**

Define:

```ts
export const PAPER_AUDITS = [
  { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
  { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
  { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
  { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
] as const satisfies readonly { name: string; role: RoleName; file: string }[]
```

Use it for cache reads, missing-role execution, result parsing, and output filenames. Do not retain a second tuple inside `runPaperAudits`.

- [ ] **Step 6: Adapt `paper/pipeline.ts` without changing its class yet**

Replace its `phases` attr with one `deps` attr and call the named functions. Build every `PaperContext` with the same `deps`. This keeps the task independently buildable before Task 7 removes the pipeline class.

- [ ] **Step 7: Run paper and full-loop tests**

Run: `npm run build && node --experimental-strip-types --test test/unit/paper-phases.test.ts test/unit/paper-workflow.test.ts test/unit/architecture.test.ts test/integration/minimal-loop.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit functional paper phases**

```bash
git add packages/autoresearch/src/paper packages/autoresearch/test/unit/paper-phases.test.ts packages/autoresearch/test/unit/architecture.test.ts
git commit -m "refactor: make paper phases stateless"
```

### Task 7: Replace `PaperPipeline` with a functional checkpoint orchestrator

**Files:**

- Modify: `packages/autoresearch/src/paper/pipeline.ts`
- Modify: `packages/autoresearch/src/service/steps/paper.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Test: `packages/autoresearch/test/unit/checkpoint.test.ts`
- Test: `packages/autoresearch/test/unit/paper-workflow.test.ts`
- Test: `packages/autoresearch/test/integration/minimal-loop.test.ts`

**Interfaces:**

- Produces: `runPaperPipeline(deps, request): Promise<PaperPipelineResult>` and `runCheckpointPhase()`.
- Removes: internal `PaperPipeline` class; it is not exported by the package root.

- [ ] **Step 1: Add a failing no-pipeline-class assertion**

```ts
test('paper pipeline is a functional checkpoint orchestrator', async () => {
  const source = await readFile(join(process.cwd(), 'src/paper/pipeline.ts'), 'utf8')
  assert.doesNotMatch(source, /export class PaperPipeline/)
  assert.match(source, /export async function runPaperPipeline/)
  assert.match(source, /async function runCheckpointPhase/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run build && node --experimental-strip-types --test test/unit/architecture.test.ts`

Expected: FAIL because `PaperPipeline` remains.

- [ ] **Step 3: Define the functional entry point**

```ts
export interface PaperPipelineRequest {
  runDir: string
  tree: ResearchTree
  evidencePath: string
  agentContext: RoleExecutionContext
}

export async function runPaperPipeline(
  deps: PaperDependencies,
  request: PaperPipelineRequest,
): Promise<PaperPipelineResult>
```

Move the current `run()` body unchanged in behavior and create paper contexts from `deps` plus request data.

- [ ] **Step 4: Extract the checkpoint mechanism, not a workflow abstraction**

Use this local helper:

```ts
async function runCheckpointPhase<T>(input: {
  paperDir: string
  checkpoint: PaperCheckpoint
  id: string
  run: () => Promise<T>
  commit: (value: T) => void
}): Promise<T | undefined>
```

It checks `checkpoint.phases[id]`, runs once, commits the result, saves the checkpoint, and returns the value. Keep phase order and conditionals explicit in `runPaperPipeline`.

- [ ] **Step 5: Update the research-to-paper handoff**

In `service/steps/paper.ts`, replace construction and `.run()` with one `runPaperPipeline({ provider: ctx.deps.provider, options }, request)` call. Do not add another adapter.

- [ ] **Step 6: Verify checkpoint and paper compatibility**

Run: `npm run build && node --experimental-strip-types --test test/unit/checkpoint.test.ts test/unit/paper-workflow.test.ts test/unit/architecture.test.ts test/integration/minimal-loop.test.ts`

Expected: all tests pass with unchanged checkpoint schema and paper filenames.

- [ ] **Step 7: Commit the functional pipeline**

```bash
git add packages/autoresearch/src/paper/pipeline.ts packages/autoresearch/src/service/steps/paper.ts packages/autoresearch/test/unit/architecture.test.ts
git commit -m "refactor: make paper pipeline functional"
```

### Task 8: Convert brainstorm ranking and pipeline to reusable functions

**Files:**

- Modify: `packages/autoresearch/src/brainstorm/ranking.ts`
- Modify: `packages/autoresearch/src/brainstorm/pipeline.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`
- Create: `packages/autoresearch/test/unit/ranking.test.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Test: `packages/autoresearch/test/integration/brainstorm-loop.test.ts`

**Interfaces:**

- Produces: function type `RankingStrategy`, default `rankCandidates`, and `runBrainstorm(deps, request)`.
- Removes: `DefaultRankingStrategy` and `BrainstormPipeline` classes.

- [ ] **Step 1: Add failing ranking and structure tests**

`ranking.test.ts` supplies two candidates and provider scores, then asserts deterministic order by total, evidence, and novelty:

```ts
const ranked = await rankCandidates(ctx, candidates, provider)
assert.deepEqual(ranked.map(({ id }) => id), ['strong', 'weak'])
assert.equal(ranked[0]?.total, 9)
```

Extend `architecture.test.ts`:

```ts
test('brainstorm orchestration and ranking do not hold dependency attrs', async () => {
  const pipeline = await readFile(join(process.cwd(), 'src/brainstorm/pipeline.ts'), 'utf8')
  const ranking = await readFile(join(process.cwd(), 'src/brainstorm/ranking.ts'), 'utf8')
  assert.doesNotMatch(pipeline, /export class BrainstormPipeline/)
  assert.doesNotMatch(ranking, /export class DefaultRankingStrategy/)
  assert.match(pipeline, /export async function runBrainstorm/)
})
```

- [ ] **Step 2: Run tests and verify class-based failures**

Run: `npm run build && node --experimental-strip-types --test test/unit/ranking.test.ts test/unit/architecture.test.ts`

Expected: FAIL because `rankCandidates`/`runBrainstorm` are absent and both classes remain.

- [ ] **Step 3: Make ranking a function strategy**

Define:

```ts
export type RankingStrategy = (
  ctx: BrainstormContext,
  candidates: CandidateDirection[],
  provider: RoleAgentProvider,
) => Promise<CandidateDirection[]>

export const rankCandidates: RankingStrategy = async (ctx, candidates, provider) => {
  const result = await provider.run('brainstorm', {
    runDir: ctx.runDir,
    perspective: 'score',
    plan: JSON.stringify(candidates, null, 2),
  }, ctx.agentContext)
  const scores = (result.structured as {
    scores?: Array<{
      candidateId?: string
      novelty?: number
      feasibility?: number
      evidence?: number
    }>
  } | undefined)?.scores ?? []
  const totals = new Map<string, {
    novelty: number
    feasibility: number
    evidenceScore: number
  }>()
  for (const score of scores) {
    if (!score.candidateId) continue
    const previous = totals.get(score.candidateId) ?? {
      novelty: 0, feasibility: 0, evidenceScore: 0,
    }
    totals.set(score.candidateId, {
      novelty: previous.novelty + (score.novelty ?? 0),
      feasibility: previous.feasibility + (score.feasibility ?? 0),
      evidenceScore: previous.evidenceScore + (score.evidence ?? 0),
    })
  }
  return candidates.map((candidate) => {
    const score = totals.get(candidate.id) ?? {
      novelty: 0, feasibility: 0, evidenceScore: 0,
    }
    return {
      ...candidate,
      ...score,
      total: score.novelty + score.feasibility + score.evidenceScore,
    }
  }).sort((a, b) =>
    b.total - a.total ||
    b.evidenceScore - a.evidenceScore ||
    b.novelty - a.novelty)
}
```

Change `BrainstormOptions.ranking` to this function type and invoke it directly. There must be only one scoring/aggregation implementation.

- [ ] **Step 4: Replace the pipeline class with explicit module functions**

Define:

```ts
export interface BrainstormDependencies {
  readonly provider: RoleAgentProvider
  readonly options: Readonly<BrainstormOptions>
}

export interface BrainstormRequest {
  readonly runDir: string
  readonly agentContext: RoleExecutionContext
}

export async function runBrainstorm(
  deps: BrainstormDependencies,
  request: BrainstormRequest,
): Promise<string>
```

Move each former private method to a named module function receiving `deps` and `BrainstormState`. Keep survey, frontier mining, wiki writing, knowledge graph, proposal, debate, ranking, reform, and handoff as separate functions and preserve their explicit order in `runBrainstorm`.

- [ ] **Step 5: Update `ResearchRunner` directly**

Replace `new BrainstormPipeline(...).run(...)` with `runBrainstorm({ provider: ctx.deps.provider, options: brainstormOptions }, { runDir: ctx.runDir, agentContext: ctx.context })`. Do not create a compatibility class because the package root does not export it.

- [ ] **Step 6: Verify ranking and the complete two-stage brainstorm**

Run: `npm run build && node --experimental-strip-types --test test/unit/ranking.test.ts test/unit/architecture.test.ts test/integration/brainstorm-loop.test.ts`

Expected: ranking tests and all survey/frontier/wiki/knowledge-graph artifact assertions pass.

- [ ] **Step 7: Commit brainstorm functionalization**

```bash
git add packages/autoresearch/src/brainstorm packages/autoresearch/src/service/runner.ts packages/autoresearch/test/unit/ranking.test.ts packages/autoresearch/test/unit/architecture.test.ts
git commit -m "refactor: make brainstorm pipeline functional"
```

### Task 9: Share optional I/O, remove dead wrappers, and enforce the final architecture

**Files:**

- Modify: `packages/autoresearch/src/core/utils.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`
- Modify: `packages/autoresearch/src/service/steps/idea.ts`
- Modify: `packages/autoresearch/src/service/steps/experiment.ts`
- Modify: `packages/autoresearch/src/paper/phases.ts`
- Modify: `packages/autoresearch/src/paper/pipeline.ts`
- Delete: `packages/autoresearch/src/domain/idea-file.ts`
- Modify: `packages/autoresearch/test/unit/architecture.test.ts`
- Modify: `packages/autoresearch/docs/simplified.md`

**Interfaces:**

- Produces: `readOptionalText(path): Promise<string | undefined>` as the only optional text-read mechanism.
- Enforces: no forwarding classes, no duplicate role union, no dead `RunFiles`, and no local `readText(...).catch(() => '')` copies.

- [ ] **Step 1: Add failing optional-I/O and architecture tests**

Add to `service-runtime.test.ts`:

```ts
test('readOptionalText ignores only missing files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-optional-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await readOptionalText(join(dir, 'missing.md')), undefined)
  await assert.rejects(() => readOptionalText(dir))
})
```

Add to `architecture.test.ts`:

```ts
test('removed wrappers and duplicate optional reads cannot return', async () => {
  assert.equal(existsSync(join(process.cwd(), 'src/domain/idea-file.ts')), false)
  const files = await sourceFiles(join(process.cwd(), 'src'))
  const joined = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  assert.doesNotMatch(joined, /readText\([^\n]+\)\.catch\(\(\) => ''\)/)
  assert.doesNotMatch(joined, /export type RoleName\s*=\s*\|/)
})
```

`sourceFiles` recursively returns `.ts` files using `readdir({ withFileTypes: true })`.

- [ ] **Step 2: Run focused tests and verify failures**

Run: `npm run build && node --experimental-strip-types --test test/unit/service-runtime.test.ts test/unit/architecture.test.ts`

Expected: FAIL because the helper is missing, `idea-file.ts` exists, and local optional-read copies remain.

- [ ] **Step 3: Implement precise optional-file handling**

Add to `core/utils.ts`:

```ts
export async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readText(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
```

Replace optional Markdown/text reads in runner, idea, experiment, paper phases, and paper pipeline with this helper. Preserve catches that intentionally handle malformed legacy JSON, failed external downloads, reviewer failures, or absent persisted state.

- [ ] **Step 4: Remove dead wrappers and update maintainer documentation**

Delete the unreferenced `RunFiles` class/file. Rewrite `docs/simplified.md` around this final call graph:

```text
AutoResearchService
  -> ResearchRunner (public compatibility boundary)
  -> one RunContext
  -> brainstorm / idea / experiment / paper functions
  -> runAgent / runStage / reviewGate
  -> ResearchTree + RunState + PaperCheckpoint
```

Document the rule that same-semantics mechanisms must be shared and that feature-specific decisions remain local.

- [ ] **Step 5: Run complete verification**

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript diagnostics.

Run: `npm test`

Expected: exit 0; every unit and integration test passes.

Run: `rg -n "export class (ResearchSteps|RoleRunner|IdeaSteps|ExperimentSteps|PaperSteps|PaperPhases|PaperPipeline|BrainstormPipeline|DefaultRankingStrategy|RunFiles)|export type RoleName\s*=" packages/autoresearch/src`

Expected: no matches.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Review compatibility artifacts explicitly**

Confirm the integration tests still assert all of these outputs: `input/idea.md`, `paper_wiki/_index.md`, `evidence_chain.json`, `paper/main.tex`, `FINAL_REPORT.md`, `FAILURE_REPORT.md`, research terminal state, and paper checkpoint behavior. Add a direct assertion only if one is missing; do not rename artifacts.

- [ ] **Step 7: Commit final cleanup and documentation**

```bash
git add packages/autoresearch/src packages/autoresearch/test packages/autoresearch/docs/simplified.md
git commit -m "refactor: enforce minimal autoresearch architecture"
```

---

## Final Acceptance Checklist

- [ ] Package root exports and public constructors remain compatible.
- [ ] All DSH tools retain their names, schemas, and output shapes.
- [ ] Every existing test plus the new runtime, review, ranking, paper-phase, and architecture tests passes.
- [ ] `ResearchRunner` stores one dependency object; `AutoResearchService` stores one dependency object.
- [ ] Stateful invariant owners (`ResearchTree`, `HypothesisPool`) remain classes.
- [ ] External adapters (`SubagentRoleAgentProvider`) and logging may remain classes because they own adapter/resource lifecycle.
- [ ] No stateless step, phase, ranking, or forwarding class remains.
- [ ] Role names and paper audit specs each have exactly one source of truth.
- [ ] Shared execution, review, optional I/O, ranking, evidence, checkpoint, and LaTeX-engine mechanisms each have one implementation.
- [ ] Brainstorm, idea, experiment, research orchestration, and paper writing remain separate modules with explicit control flow.
- [ ] No new dependency, workflow DSL, universal context, speculative abstraction, or output-format change was introduced.
