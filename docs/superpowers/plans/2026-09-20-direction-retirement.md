# Direction Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically retire only canonical refuted or explicitly abandoned research directions by persisting compact project memory first, then deleting exact managed direction artifacts through a durable, resumable cleanup queue while protecting successful, shared, live, and user-owned data.

**Architecture:** Add a direction-owned manifest and a project-scoped cleanup queue under `projectDir/.autoresearch/cleanup`. New run outputs are registered at their generation boundaries with a stable hypothesis-version/lineage direction identity. The service creates and advances cleanup tasks after committed decisions and during startup/resume; the queue persists memory and tombstones before hash-checked, symlink-safe deletion. Existing runs without ownership evidence remain explicitly blocked.

**Tech Stack:** TypeScript/Node.js ESM, node:fs/promises, SHA-256 content hashes, existing `ResearchStore`, runtime job store, `FileMemoryStore`/project memory adapter, node:test temporary fixtures.

## Global Constraints

- A normal execution failure, invalid measurement, pause, budget exhaustion, external block, or unknown job never implies scientific refutation or abandonment.
- Automatic refutation requires a committed canonical assessment with `category: hypothesis_refuted`, `claim_status: refuted`, and validated formal opposing evidence under the frozen protocol.
- Abandonment requires an explicit direction-level abandon record/API and reason; `RunState.status === FAILED` is insufficient.
- Compact project-global memory is durable before any deletion and contains only idea, disposition, reason, and avoid-repeat guidance plus short hashes/IDs.
- Deletion targets are exact, pre-registered, hash-checked paths contained within managed run roots; symlink/junction escapes, changed bytes, live jobs, unknown jobs, shared references, and user-owned paths block the task.
- Existing paper files and unrelated agent-owned files are protected.
- Deleted source bytes are represented by tombstones; resume/load must recognize tombstones and must not silently recreate or admit deleted source as formal evidence.

---

### Task 1: Add direction ownership and cleanup contracts

**Files:**
- Create: `packages/autoresearch/src/cleanup/contracts.ts`
- Create: `packages/autoresearch/src/cleanup/direction-id.ts`
- Modify: `packages/autoresearch/src/research/contracts.ts` only if the explicit abandonment disposition needs a shared canonical type
- Test: `packages/autoresearch/test/unit/direction-retirement-contracts.test.ts`

**Interfaces:**
- Produce `DirectionRef`, `ManagedArtifact`, `DirectionManifest`, `CleanupTask`, `CleanupTaskState`, `RetirementDisposition`, `TombstoneRecord`.
- Produce `directionId(input: { projectId: string; branchId: string; claim: VersionRef; hypothesis: VersionRef; protocolHash?: string }): string`.
- Produce validators that reject malformed IDs, absolute paths, traversal, duplicate targets, and non-managed roots.

- [ ] Write tests for stable IDs across retries, distinct hypothesis versions, invalid target paths, and explicit `refuted`/`abandoned` dispositions.
- [ ] Run the focused test and verify it fails because the contracts/factory are absent.
- [ ] Implement the smallest immutable contract and validation layer.
- [ ] Run the focused test and verify it passes.
- [ ] Refactor only after green; keep all paper files untouched.

### Task 2: Register managed direction outputs at generation boundaries

**Files:**
- Create: `packages/autoresearch/src/cleanup/manifest.ts`
- Modify: `packages/autoresearch/src/service/research-cycle.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`
- Modify: `packages/autoresearch/src/experiment/runner.ts`
- Modify: `packages/autoresearch/src/experiment/steps.ts`
- Modify: `packages/autoresearch/src/experiment/runtime-adapter.ts`
- Modify: `packages/autoresearch/src/experiment/artifact-manifest.ts` only where artifact ownership is captured
- Test: `packages/autoresearch/test/unit/direction-manifest.test.ts`

**Interfaces:**
- `openDirectionManifest(runDir, direction): Promise<DirectionManifest>` creates an immutable manifest before generated outputs are written.
- `registerManagedArtifact(runDir, manifestId, input): Promise<ManagedArtifact>` records exact relative path, hash, producer, and ownership class.
- `registerManagedTree(...)` enumerates only a bounded managed subtree using `lstat`/`realpath`; it rejects symlink/junction escapes.
- `loadDirectionManifest` verifies its content hash and ownership identity.

- [ ] Test that normal research cycles register their `work/cycle-XX`, `cycles/cycle-XX`, generated reports, raw candidate capture, runtime graph, collection, artifact, and log paths automatically.
- [ ] Test that standalone experiment stage markers and `work/experiment-cycle-XX` are registered automatically.
- [ ] Test that copied `input/idea.md`/`candidate.md` are marked generated copies only when the service copied an external candidate; user input and `runDir === projectDir` are protected.
- [ ] Test that a runtime artifact copied into `research/sources` records both runtime and content-addressed locations.
- [ ] Run focused tests and verify RED.
- [ ] Add registration calls at the existing freeze/work/collection/report boundaries, deriving direction identity from the active hypothesis version and protocol, never from a mutable statement alone.
- [ ] Run focused tests and verify GREEN.

### Task 3: Consume the existing project-global compact memory integration

**Files:**
- Modify: `packages/autoresearch/src/cleanup/queue.ts` to consume `ProjectDirectionMemoryStore`
- Do not modify: `packages/autoresearch/src/memory/*` (owned by memory_design)
- Test: `packages/autoresearch/test/unit/project-retirement-memory.test.ts`

**Interfaces:**
- Queue calls the existing `ProjectDirectionMemoryStore(projectDir).upsert({ idea, eliminationReason, avoid, reasonCode, mechanismKey, changedAssumption })` before deletion.
- Queue uses the existing store's idempotent record ID/content as the cleanup task memory receipt; no second memory schema or path is introduced.
- Cleanup status can read the existing store's compact records without persisting raw code/log/results.

- [ ] Test queue memory integration is project-global across two run directories.
- [ ] Test first write succeeds, retry does not duplicate, and the existing store's strict compact allowlist remains enforced.
- [ ] Run focused tests and verify RED.
- [ ] Implement atomic append/upsert with the existing lock/hash conventions.
- [ ] Run focused tests and verify GREEN.

### Task 4: Add tombstone-aware ResearchStore source validation

**Files:**
- Create: `packages/autoresearch/src/cleanup/tombstones.ts`
- Modify: `packages/autoresearch/src/research/store.ts`
- Modify: `packages/autoresearch/src/research/assessment.ts` only to reject unavailable/tombstoned sources from new formal admission
- Test: `packages/autoresearch/test/unit/research-tombstone.test.ts`

**Interfaces:**
- `writeTombstone(runDir, record): Promise<TombstoneRecord>` writes immutable tombstones only after the cleanup task and project memory receipt are durable.
- `loadTombstones(runDir)` validates the tombstone's task ID, memory ID/hash, direction manifest ID/hash, and exact source path/hash ownership.
- `ResearchStore.validate` accepts a missing source only when that complete cleanup provenance matches an exact tombstone `(sourceId, path, hash)`.
- New assessments must classify tombstoned source use as unavailable and never admit it as formal evidence.

- [ ] Test a snapshot loads after its direction-only source blob is deleted and tombstoned with complete cleanup provenance.
- [ ] Test a hand-written or mismatched tombstone cannot bypass validation.
- [ ] Test a new commit/assessment cannot reuse a deleted source as formal evidence.
- [ ] Test mismatched tombstone path/hash still fails closed.
- [ ] Run focused tests and verify RED.
- [ ] Implement tombstone lookup without rewriting immutable historical snapshots.
- [ ] Run focused tests and verify GREEN.

### Task 5: Implement durable cleanup queue and safe deletion executor

**Files:**
- Create: `packages/autoresearch/src/cleanup/queue.ts`
- Create: `packages/autoresearch/src/cleanup/executor.ts`
- Create: `packages/autoresearch/src/cleanup/runtime.ts`
- Create: `packages/autoresearch/src/cleanup/index.ts`
- Modify: `packages/autoresearch/src/core/utils.ts` for a logger flush/barrier only
- Test: `packages/autoresearch/test/unit/direction-cleanup-queue.test.ts`

**Interfaces:**
- `enqueueRetirement(input): Promise<CleanupTask>` creates an immutable task before deletion.
- `advanceCleanupQueue(projectDir, options?): Promise<CleanupSummary>` processes pending tasks and persists `pending | memory_saved | waiting_live | deleting | completed | blocked` transitions.
- `inspectCleanupProtection(task): Promise<ProtectionResult>` checks run state, all relevant graph/job receipts, unknown jobs, active process ownership, shared/success references, exact hashes, and user-owned boundaries.
- `deleteManagedArtifacts(task): Promise<CleanupResult>` performs bounded exact-target quarantine/purge, handles runtime artifact copies, JobLogs, supervisor logs, logger output, raw proposal/reflexion files, and content-addressed blobs only when unreferenced.

- [ ] Test an end-to-end temporary fixture: enqueue refuted direction, write compact memory, delete every owned sentinel, persist tombstone, and finish.
- [ ] Test a crash/interruption after memory and during deletion; retry resumes without duplicate memory and without deleting changed bytes.
- [ ] Test ordinary failure, budget pause, unknown/running job, shared artifact, successful direction reference, user input, symlink escape, and changed target all block safely.
- [ ] Test `runDir === projectDir` blocks deletion of ambiguous input/user paths.
- [ ] Run focused tests and verify RED.
- [ ] Implement queue locking, task replay, bounded path checks, hash checks, live-job checks, logger flush, quarantine/purge, and explicit blocked reasons.
- [ ] Run focused tests and verify GREEN.

### Task 6: Add explicit abandonment and automatic lifecycle integration

**Files:**
- Modify: `packages/autoresearch/src/service/research-cycle.ts`
- Modify: `packages/autoresearch/src/service/runner.ts`
- Modify: `packages/autoresearch/src/service/autoresearch-service.ts`
- Modify: `packages/autoresearch/src/experiment/runner.ts`
- Modify: `packages/autoresearch/src/experiment/steps.ts`
- Test: `packages/autoresearch/test/unit/direction-retirement-lifecycle.test.ts`

**Interfaces:**
- Add an explicit direction-level abandon helper that records reason and direction lineage without mapping generic `FAILED` to abandonment.
- `retireCanonicalDirection(ctx, disposition)` derives the exact hypothesis version/lineage, writes task plus compact project memory, and invokes queue advancement.
- Startup/resume and post-decision paths call `advanceCleanupQueue(projectDir)` automatically; cleanup errors remain task state and do not become scientific evidence.

- [ ] Test canonical formal negative assessment automatically enqueues and advances cleanup.
- [ ] Test explicit abandon automatically enqueues; supervisor fail/worker failure/pause do not.
- [ ] Test refuting an old hypothesis cannot remove a newer successful hypothesis in the same run.
- [ ] Test startup/resume sees a completed tombstone and skips revalidation/redispatch of deleted sources.
- [ ] Run focused lifecycle tests and verify RED.
- [ ] Implement hooks only after `ResearchStore` commit and output synchronization, while preserving queue retry semantics.
- [ ] Run focused lifecycle tests and verify GREEN.

### Task 7: Add tool factory seam and full verification

**Files:**
- Create: `packages/autoresearch/src/cleanup/tools.ts`
- Modify: `packages/autoresearch/test/unit/` only for cleanup-owned tests
- Do not modify: `packages/autoresearch/src/tools/index.ts`, `packages/autoresearch/src/index.ts` (owned by harness_efficiency)

**Interfaces:**
- Export `createCleanupTools(deps)` for the owning harness agent to register; no manual invocation is required for the main lifecycle.
- Tools expose read-only queue status and explicit abandon request creation, while execution remains service-integrated and protected.

- [ ] Test factory shape independently without changing registration ownership.
- [ ] Run cleanup unit/integration tests in the package.
- [ ] Run typecheck/build and the full existing suite, confirming the three dirty paper files are preserved.
- [ ] Review `git diff` and `git status`; do not commit.

## Verification Commands

Run from `packages/autoresearch`:

```powershell
npm run build
node --experimental-strip-types --test test/unit/direction-retirement-contracts.test.ts
npm run typecheck
npm test
```

Use only `mkdtemp` temporary fixtures for destructive behavior tests. Never invoke cleanup against the repository's existing `runs/` or user project directories.
