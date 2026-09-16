# Startup Routing and Recovery Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans task by task. The user's latest selection narrows the preceding startup design to automatic routing and recovery.

**Goal:** Route existing-project papers, new research, standalone experiments and resume requests to the correct existing engine using verified project/run metadata.

**Architecture:** The main agent interprets intent; a read-only `research_prepare` checks paths and persisted workflow identity and returns a concrete next tool action. Existing runners remain execution owners. Session bindings are hints revalidated against disk; project-local discovery replaces the global last-run shortcut.

**Tech Stack:** TypeScript, Node >=22.19.0, native node:test, existing DSH tool schemas and PowerShell.

## Global Constraints

- Work only in `.worktrees/rag-research`, branch `feat/rag-research`.
- No benchmark work or changes to global DSH settings.
- Preparation never creates a run, invokes a model, reads secrets or changes a budget.
- Existing authorization for paid models and bounded supplementary verification remains valid.
- Defer ResearchBrief propagation, new role DAG and research_dispatch from the larger draft.
- No claim of a host first-turn hook: the main agent calls preparation under its persona.

## Task 1: Read-only routing and recovery

**Files:** `packages/autoresearch/src/startup/prepare.ts`, `test/unit/startup-prepare.test.ts`.

**Interfaces:** Export `prepareStartup(input, context?)`. Input contains `intent: 'project-paper' | 'research' | 'experiment' | 'resume' | 'ambiguous'`, absolute `projectDir`, optional `runDir`, optional `task`. Context may contain a trusted `sessionRunDir`. Result contains `status: 'ready' | 'needs-input' | 'blocked' | 'resumable' | 'terminal'`, `reason`, optional `workflow`, `runDir`, `nextAction: {tool, args}`, `candidates`, `runStatus`, `phase`. Keep result types exported for consumers.

- [x] Write failing behavior cases for each new route, explicit-project identity mismatch, unique/multiple/no resume candidates, session preference, corrupt state, terminal and PAUSED handling, experiment recovery, and unchanged filesystem after preparation.

```ts
const result = await prepareStartup({ intent: 'resume', projectDir });
assert.equal(result.status, 'resumable');
assert.equal(result.nextAction?.tool, 'research_run');
assert.equal(result.nextAction?.args.runDir, existingRun);
```

- [x] Run `node --experimental-strip-types --test test/unit/startup-prepare.test.ts` and capture expected missing-function failures before implementation.
- [x] Implement bounded direct-child scan of `<projectDir>/.autoresearch/runs`; use actual canonical project identity, validate state and workflow, never infer intent merely from files. An occupied directory cannot start a new task. Require explicit distinct runDir for new tasks, so the main agent chooses one once. On resume choose explicit run, valid matching session hint, then unique project-local active run; ambiguous or corrupt metadata yields no executable action. RUNNING/WAITING can resume same engine; PAUSED exposes reason without auto-retry; terminal exposes summary only. Legacy runs without verified identity require explicit recovery inputs rather than silent rebinding.
- [x] Verify tests green and read-only behavior; review outcomes against the larger draft's narrowed scope.

## Task 2: Standalone experiment identity and recoverable input

**Files:** `src/service/project-paper.ts`, `src/experiment/runner.ts`, `src/service/autoresearch-service.ts`, dedicated experiment identity tests.

**Interfaces:** Extend persisted project identity workflow to `experiment`, preserving research/project-paper callers. Add frozen `.autoresearch/experiment-request.json` containing version, task, profile, maxRounds; task/profile must match existing manifest hashes before resume action construction.

- [x] Write and run failing tests for wrong-project/wrong-workflow reuse, exact task/profile recovery and legacy compatibility.
- [x] Bind new experiment runs before state/input mutations; persist exact effective task/profile/maxRounds for recovery. Generic research resume must reject experiment identities, and experiment execution must reject research identities. Existing explicit legacy experiment calls remain supported only when manifest/task/profile match; do not auto-adopt identity-less legacy runs during preparation. Historical terminal main runs with neither identity nor experiment metadata retain a read-only status view without new metadata or model dispatch. Rejected admission must not synchronize or rewrite research outputs.
- [x] Run focused experiment and project-paper regression tests.

## Task 3: CLI entry and session prompt

**Files:** `scripts/start-session.mjs`, `scripts/session-startup.mjs`, `prompts/session/autoresearch.md`, `test/unit/session-startup.test.ts`.

**Interfaces:** CLI supports `--project-dir` and `--run-dir`; reusable prompt builder calls `prepareStartup` for --resume and emits research_prepare guidance. No global last-run fallback.

- [x] Write and run failing tests using controlled temporary projects and persisted run fixtures. Assert generated action routes and that foreign last-run is irrelevant.
- [x] Resolve project paths from invocation cwd and relative runDir from the selected project workspace, matching the spawned DSH session's cwd. Perform resume checks before profile installation. Refuse ambiguous/invalid automatic resume without selecting arbitrary newest run. No-run-dir resume may select the unique verified local run. Prompt explains all four intents and PAUSED/WAITING/terminal distinctions.
- [x] Run script tests and `node --check scripts/start-session.mjs`.

## Task 4: Tool and preset integration

**Files:** `src/tools/startup.ts`, `src/index.ts`, preset persona, `test/unit/startup-tools.test.ts`, relevant registration tests.

- [x] Write failing tests for session cwd default, missing cwd, relative path binding, no cross-session resume, and native tool registration/schema.
- [x] Register `research_prepare`, retaining existing execution tools. Track successful run results in a per-agent session map; revalidate hints on each preparation. Do not expose sessionRunDir as a model argument. Resolve paths from caller session, never plugin cwd. Emit no execution action for ambiguity/blocked/terminal.

```ts
const result = await prepareTool.execute({ intent: 'resume' }, exec);
assert.equal(result.nextAction.args.runDir, selectedRun);
```

- [x] Update persona to prepare first, select an explicit intent, execute returned nextAction and preserve user options. New task chooses a runDir once; resume keeps it and its existing budget. Independently review all integration changes.
- [x] Run core test suite, typecheck and build. Record results; paid smoke only if needed to resolve a model-integration uncertainty. Update design status and verification document to distinguish this implemented subset from deferred work.
