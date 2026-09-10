# Upstream Experiment Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and verification-before-completion task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make future AutoResearch runs plan against their actual runtime constraints, require acceptance of the exact experiment protocol, and reject structurally invalid or unsafe worker artifacts before evidence or supervision.

**Architecture:** Add a small typed experiment-pause module and a common worker/artifact validator; keep the bounded planner-facing runtime summary beside the experiment steps that consume it. Handle expected stops in both standalone and research runners while keeping unrelated provider failures exceptional.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, built-in `node:test`, Markdown prompts/docs.

## Global Constraints

- Change AutoResearch itself only; do not inspect or mutate generated projects.
- Preserve public provider schemas, task fingerprints, old terminal runs, and minimal mode's optional-role behavior.
- Allow at most two pre-work redesigns and require `proceed` for the exact returned design; post-work review is review-only.
- Artifact checks prove only local shape/path/file validity, not scientific truth.
- No settings migration, auto-routing mutation, arbitrary command execution, network work, commits, or branch changes.

---

### Task 1: Runtime constraints and scientific protocol prompts

**Files:** Modify `src/agents/types.ts`, `src/agents/roles/general.ts`, `src/experiment/steps.ts`, shared/role prompts; test `test/unit/experiment-engineering.test.ts`.

- [x] Add failing behavioral tests that capture planner input for legacy/minimal paths and assert literal effective mode, cycle/round cap, routing state/known route source, and review policy without claiming an inherited model.
- [x] Run focused tests and record RED.
- [x] Add optional `runtimeConstraints` input rendering and a deterministic helper fed only by the frozen policy plus runner cap; forward it in `runPlanner` and `runMinimalPlan`.
- [x] Tighten the shared/role prompts for protocol versioning, pilot/formal separation, whole-run cost accounting, reproducibility/provenance, smoke-test limits, and hypothesis-appropriate designer choices.
- [x] Run focused tests to GREEN.

### Task 2: Exact-design acceptance and expected pause handling

**Files:** Modify `src/experiment/steps.ts`, `src/experiment/runner.ts`, `src/service/runner.ts`; test `test/unit/experiment-runner.test.ts` and focused integration tests.

- [x] Add failing tests for two revise verdicts plus final proceed, malformed verdict, unresolved automatic revise in standalone/research, repeated human revise, and post-work minimal revise with cached worker reuse.
- [x] Run focused tests and record RED.
- [x] Introduce a typed workflow-pause error and make `runExperimentReflexion` review the initial design plus each of at most two redesigns, returning only an explicitly accepted exact candidate.
- [x] In post-work minimal review, disallow redesign and pause on revise; in the human pre-work gate, pause if the second reviewed design still requests revision.
- [x] Catch only the typed expected pause in standalone/research runners, persist `PAUSED` plus a clear report, and retain existing behavior for unrelated provider errors.
- [x] Run focused tests to GREEN.

### Task 3: Common worker artifact validation

**Files:** Create `src/experiment/validation.ts`; modify `src/experiment/steps.ts`, `src/experiment/runner.ts`, `src/service/runner.ts`; test focused unit/integration files.

- [x] Add failing table-driven tests for malformed/failed results, empty artifacts, missing files, directories, traversal, outside absolute paths, and escaping symlinks; add valid in-root and cached-result cases.
- [x] Run focused tests and record RED.
- [x] Implement asynchronous validation against the real run root and regular files, returning an actionable typed pause reason.
- [x] Remove the worker's unstructured-success fallback and invoke the common validator for fresh and cached work before evidence/supervisor stages in all four paths; reuse it in the service runner's existing local-risk checks.
- [x] Run focused tests to GREEN.

### Task 4: Documentation and verification

**Files:** Modify `packages/autoresearch/README.md`, `docs/drafts/research-runtime.md`; create `docs/drafts/2026-09-10-upstream-experiment-validation.md`.

- [x] Document exact-design acceptance, basic artifact validity, planner-visible effective constraints, expected pauses/resume, and the boundary between runtime enforcement and scientific review responsibility.
- [x] Run focused tests, build, typecheck, and `git diff --check`; record exact RED/GREEN commands and current limitations.
- [x] Review the diff against A–E, confirm shared guidance remains under about 800 words, and send `READY_FOR_REVIEW` before final report polish.
