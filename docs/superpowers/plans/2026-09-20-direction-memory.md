# Project Direction Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a project-scoped, compact deny-list for explicitly abandoned or scientifically confirmed invalid directions, feed it into later idea generation and candidate selection, and keep it free of source artifacts and held-out details.

**Architecture:** Add an atomic JSON store at `<real projectDir>/.autoresearch/direction-memory.json` with a strict short-field allowlist. Idea generation renders matched entries into its existing bounded guidance input; scientific selection receives only mechanism keys and memory IDs and hard-excludes exact mechanism/idea matches. Ordinary run failures never write this store.

**Tech Stack:** TypeScript, Node `fs/promises`, SHA-256 canonical identities, Node test runner.

## Global Constraints

- Store only compact idea, elimination reason, avoid text, reason code, optional mechanism key/changed assumption, and bounded identity metadata.
- `reasonCode` is `confirmed_error` or `explicit_abandonment`.
- Never persist source refs, paths, code, full reports, complete results, metrics, samples, held-out details, or repair instructions.
- Project memory is shared across run directories for the same real project path and isolated across projects.
- Held-out evidence may produce only a generic eliminated-direction state; no test detail may be rendered to an actor.
- This is a user-requested project extension; it is not claimed as a feature of SoL-Pi §2.1/§2.2 (https://arxiv.org/html/2609.20519v1#S2).

---

### Task 1: Define the red tests and compact store contract

**Files:**
- Create: `packages/autoresearch/test/unit/direction-memory.test.ts`
- Create: `packages/autoresearch/src/memory/direction-memory.ts`
- Modify: `packages/autoresearch/src/memory/index.ts`

**Interfaces:**
- `ProjectDirectionMemoryStore.read()` reads the project JSON document.
- `ProjectDirectionMemoryStore.upsert(input)` returns an idempotent compact record.
- `ProjectDirectionMemoryStore.match(query)` returns only matching compact records.
- `render(records)` returns bounded, generic guidance with no source or held-out details.

- [x] **Step 1: Write failing tests** for cross-run sharing, cross-project isolation, idempotent upsert, strict whitelist, malformed-file failure, and generic rendering.
- [x] **Step 2: Run only `direction-memory.test.ts` and verify failure because the store is absent.**
- [x] **Step 3: Implement atomic read/upsert/match/render with a stable SHA-256 id, field bounds, JSON schema validation, per-path lock, temp-file rename, and no artifact-bearing fields.**
- [x] **Step 4: Re-run the focused tests and verify they pass.**

### Task 2: Enforce project-memory avoidance in scientific selection

**Files:**
- Modify: `packages/autoresearch/src/research/contracts.ts`
- Modify: `packages/autoresearch/src/research/candidates.ts`
- Modify: `packages/autoresearch/src/research/selection.ts`
- Modify: `packages/autoresearch/test/unit/research-selection.test.ts`

**Interfaces:**
- Extend `SelectionInput` with `avoidedMechanismKeys?: string[]` and `directionMemoryIds?: string[]`.
- Candidates matching an avoided mechanism are ineligible and receive `project_direction_memory:<memory-id>` reasons.
- No candidate is blocked merely because it shares a changed assumption; a new `mechanismKey` remains eligible.

- [x] **Step 1: Add failing selection tests for exact mechanism hard exclusion, same-idea/different-mechanism allowance, persisted reason IDs, and unchanged ordinary selection.**
- [x] **Step 2: Run the focused selection test and verify the new assertions fail.**
- [x] **Step 3: Implement deterministic hard exclusion and reason propagation without changing existing cost/novelty ordering.**
- [x] **Step 4: Run the focused selection tests and verify they pass.**

### Task 3: Feed compact memory into idea generation

**Files:**
- Modify: `packages/autoresearch/src/service/steps/idea.ts`
- Modify: `packages/autoresearch/test/unit/direction-memory.test.ts`

**Interfaces:**
- `runIdeaGeneration` loads the project store from `ctx.projectDir`, appends only bounded `render()` output to the idea-generator guidance input, and hard-rejects exact remembered proposal ideas before reflexion.
- The call is read-only; it must never infer or upsert memory from ordinary failures.

- [x] **Step 1: Add a provider-capture test proving a stored compact entry reaches the real idea-generator input and no source/path/metric text does.**
- [x] **Step 2: Run the focused test and verify it fails before integration.**
- [x] **Step 3: Add the minimal store read/render integration using the existing guidance field, preserving existing caller input.**
- [x] **Step 4: Run the focused test and verify it passes.**

### Task 4: Document the contract and run targeted verification

**Files:**
- Modify: `docs/superpowers/plans/2026-09-20-direction-memory.md`

- [ ] **Step 1: Run the direction-memory and selection unit tests.**
- [ ] **Step 2: Run package build/typecheck.**
- [ ] **Step 3: Record the exact commands and results in the handoff; do not run or modify cleanup worker files.**
