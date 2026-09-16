# Simplify Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated implementation in the experiment runner, paper normalization, and paper phase file writing while preserving every existing observable behavior.

**Architecture:** Keep the three existing public entry points and state machines. Add only private helpers: two runner finalization helpers for shared abnormal/completed handling, one normalization helper for shared insight cleanup, and one paper helper for shared `main.tex`/section materialization. Each caller retains its mode-specific inputs, report text, error semantics, and side effects.

**Tech Stack:** TypeScript, Node.js filesystem APIs, the existing `@athena/autoresearch` build and test scripts.

## Global Constraints

- Modify the three owned production files plus the explicitly assigned private-unused cleanup files: `packages/autoresearch/src/experiment/runner.ts`, `packages/autoresearch/src/brainstorm/normalize.ts`, `packages/autoresearch/src/paper/phases.ts`, `packages/autoresearch/src/brainstorm/deep-dive.ts`, `packages/autoresearch/src/brainstorm/pipeline.ts`, `packages/autoresearch/src/paper/pipeline.ts`, and `packages/autoresearch/src/service/steps/idea.ts`, plus the required verification documents.
- Preserve cached stage behavior: cached workers are validated and never dispatched again.
- Preserve budget/`ExperimentPauseError` pause handling, max-round pause behavior, failure report wording, `lastError`, `evidencePath`, and report status/cycle values.
- Preserve evidence export failures as warnings that do not prevent completion.
- Do not add dependencies or public APIs; private helpers only.
- Do not rewrite the experiment state machine or change survey metadata/extras semantics.
- Existing root baseline is 155/155 tests and typecheck passing; use focused suites during edits and a fresh package build/typecheck before handoff.

### Task 1: Characterize and simplify experiment terminal handling

**Files:**
- Modify: `packages/autoresearch/src/experiment/runner.ts:288-455`
- Test: existing `packages/autoresearch/test/unit/experiment-runner.test.ts` and `packages/autoresearch/test/integration/minimal-loop.test.ts` only if a real behavior gap is found

**Interfaces:**
- Add private helper for pause terminal persistence/reporting, parameterized by the run context, report inputs, cycle count, and reason.
- Add private helper for successful evidence export plus completed-state persistence/reporting, parameterized by mode-specific context and optional reason.
- Keep `runExperimentTask` legacy failure path and both mode-specific report/result shapes unchanged.

- [ ] Record focused baseline results for experiment runner tests.
- [ ] Extract the two private helpers without changing control flow, cached reads, or transition calls.
- [ ] Run focused legacy/minimal runner suites and inspect the diff for unchanged terminal semantics.

### Task 2: Share paper insight normalization

**Files:**
- Modify: `packages/autoresearch/src/brainstorm/normalize.ts:135-252`
- Test: existing normalization coverage if present; add only a characterization test for an uncovered fallback/array-cleaning behavior

**Interfaces:**
- Add private `toInsight(raw: ...)` returning `PaperInsight` and use it for both survey papers and frontier papers.
- Keep survey-info records’ field-by-field defaults and metadata/extras semantics exactly as currently emitted.

- [ ] Run the focused brainstorm/paper normalization tests as a baseline.
- [ ] Extract shared eight-array plus summary/finding/weakness/implication cleanup into `toInsight`.
- [ ] Run the focused normalization/integration suites and compare representative output fields.

### Task 3: Share paper source and section materialization

**Files:**
- Modify: `packages/autoresearch/src/paper/phases.ts:203-246,391-413`
- Test: existing `packages/autoresearch/test/unit/paper-phases.test.ts` and paper workflow tests

**Interfaces:**
- Add private helper that writes required `main.tex` and nested `sections` files, creating section directories as needed.
- Keep writer-only bibliography/failure-report/template writes and polisher-only polish log/compile/PDF copy behavior in their callers.

- [ ] Run focused paper phase tests as a baseline.
- [ ] Replace duplicate main/section loops with the helper while preserving write order and validation.
- [ ] Run focused paper tests and inspect generated file behavior.

### Task 4: Verify and report

**Files:**
- Create: `docs/verification/2026-09-13-simplify-core.md`

- [ ] Record actual before/after production line counts from `Get-Content` and the production-only diff statistics.
- [ ] Run fresh package build, typecheck, and focused suites; leave the root full suite to the parent coordinator.
- [ ] Document tests, preserved behavior, and any limits without claiming mathematical minimality.
