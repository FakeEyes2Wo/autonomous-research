# Research Continuation Guards Implementation Plan

> **For agentic workers:** Implement sequentially: Task 1, Task 2, then the integration review. Do not start Task 2 before Task 1 is accepted.

**Goal:** Make generic research completion depend on independently reviewed, frozen goal acceptance and protect direction ownership from worker-declared stale artifacts.

**Architecture:** Keep scientific records and `assessEvidence` authoritative for science. Add a hash-bound continuation-control layer (`research/continuation.ts`, `service/continuation.ts`) for acceptance, coverage review, follow-ups, stop/resume, and reviewer idempotency. Tighten the existing worker-to-assessment registration seam around controller-issued work directories without replacing trusted controller mixed-root receipts.

**Tech Stack:** TypeScript ESM, Node `fs/promises` realpath/lstat, existing `ResearchStore`, request ledger, Node test runner.

**Implementation workspace:** `.superpowers/sdd/2026-09-20-research-continuation-guards`. Each completed task writes its reviewable handoff there; Task 1's required report is `.superpowers/sdd/2026-09-20-research-continuation-guards/task-1-report.md`.

## Global constraints

- The 46-file baseline in `docs/verification/2026-09-20-research-continuation-guards-baseline-ledger.md` belongs to earlier paper work and must remain intact; review against that manifest, never against HEAD alone.
- Do not modify/delete `usenix2027` records or assert that external papers proposed this controller behavior. Do not add invented research citations.
- No commit, push, staging, HTTP API, web API, or arbitrary-shell security claim.
- Terminal runs never rerun research, manufacture acceptance, or alter historical scientific determinations; existing `finalizeDirectionRetirement` / `advanceCleanupQueue` safety-checked cleanup, audit, and tombstone hooks remain authorized. Legacy nonterminal state never passes the new acceptance gate automatically.
- `maxCycles` is a frozen cumulative total; role/token/money budgets are monotonic across resume.
- A report, paper completion, tests green, empty candidate list, or one supported hypothesis is never independent completion proof.

---

### Task 1: Frozen acceptance, review continuation, and safe recovery

**Files:**

- Create: `packages/autoresearch/src/research/continuation.ts`
- Create: `packages/autoresearch/src/service/continuation.ts`
- Modify: `packages/autoresearch/src/research/contracts.ts`, `research/store.ts`, `service/research-cycle.ts`, `service/runner.ts`, `service/types.ts`, `service/autoresearch-service.ts`, `startup/prepare.ts`, `tools/options.ts`, `tools/index.ts`, `scripts/session-startup.mjs`, and the coverage-reviewer prompt/role registration seams.
- Create: `packages/autoresearch/test/unit/research-continuation.test.ts` and `packages/autoresearch/test/unit/research-continuation-recovery.test.ts`.
- Modify: focused existing research-store, request-ledger, startup, tool-options, runner, and paper-workflow tests only when their public contract changes.

**Interfaces:**

- `AcceptanceInput`, `FrozenAcceptanceContract`, `AcceptanceCriterion { id, required, text, evidenceKind: 'artifact'|'review'|'scientific', origin: 'explicit'|'derived' }`, `CoverageDecision`, `FollowupItem`, `ContinuationStop`, `RecoveryInput`.
- `freezeAcceptance(input, goalProfileRubric): FrozenAcceptanceContract` rejects empty/duplicate/missing required IDs and labels resolved defaults `derived`.
- `continuationInputHash({ acceptance, assessmentAndEvidence, queue, controlRevision })` excludes ledger totals and review output/snapshot hashes.
- `loadOrReviewContinuation(ctx, input)` persists/reuses `continuation/reviews/<hash>.json`, uses deterministic `coverage-review:<hash>` task IDs, and routes every supervisor finish/list exhaustion/no-candidate case to the reviewer.
- `validateRecovery(ctx, { changedCondition, criterionIds?, newEvidencePaths? })` treats the condition as caller-declared prose, captures only run-relative source bytes, verifies monotonic control changes, criterion IDs, and hashes, and returns a monotonic control revision. An existing source may use its known criterion identity; each new file must explicitly link frozen `criterionIds`. Reviewer—not wording/path matching—judges semantic relevance.

- [ ] Add red unit fixtures with explicit artifact, review, and scientific criteria plus a derived contract. Assert evidence-kind validation and matching proof type, derived visibility, rejection of empty/duplicated criteria, blocking for a missing required criterion, and rejection of changed hashes/forged refs.
- [ ] Add a fake coverage provider test: a supervisor `finish`, no candidate, paper-complete marker, tests-green message, and one supported hypothesis each call the reviewer and remain nonterminal until all required criteria are met, unblocked, and source refs rehash.
- [ ] Add finish/follow-up regressions: a cached legacy finish cannot win after new opposing evidence or a changed coverage input; an identically completed follow-up stays deduplicated, while a failed one may retry only in a new hash-bound generation/control revision.
- [ ] Add reviewer-only `retryOf` tests for a newly captured file that cannot identify its original failed task: allow only `repair` with the same frozen criterion IDs, same known mechanism key, new bytes, and `changedCondition`; reject user-provided retry IDs and any running/unknown reopen.
- [ ] Add scientific-gate tests: unknown provenance, unsupported claims, missing formal assessment, and an investigation follow-up without a protocol cannot complete or overwrite/demote existing supported scientific evidence. A derived `scientific-claims` criterion defaults to `when-scientific-claims` without keyword classification of the frozen goal/profile/rubric. Assert reviewer `not_applicable` requires nonempty rationale plus captured `sourceRefs`, and host accepts it only with no known formal protocol and no explicit scientific obligation. Explicit required science or known formal science remains applicable and invokes `assessEvidence`.
- [ ] Implement immutable contract/decision/follow-up types and canonical hashing in `research/continuation.ts`; exclude mutable ledger/decision write effects from the review identity.
- [ ] Implement service manifests and read-only coverage dispatch. Bind every input/output ref to bytes, account paid calls through the existing ledger, reuse the same review on unchanged resume, and persist `pause`, `no_feasible_followup`, and `budget_exhausted` with structured `resumeCondition`.
- [ ] Add follow-up queue tests: reviewer `investigate`, `repair`, and `replicate` items enter the next planner in the same run, share stable fingerprints/criterion links/source refs, deduplicate exact repeats, and permit a genuine new gap beyond cycle four. For an empty queue, assert one invariant/boundary pass and one cross-check/interaction pass each return no compliant task before `no_feasible_followup`. Assert completed items reopen only with a relevant captured source plus explicit `changedCondition`, never a prose rewrite or global snapshot change.
- [ ] Integrate only the public helpers at `service/research-cycle.ts` / `service/runner.ts`: after assessment and before any finish, consume queue then coverage-review; a revision still uses existing candidate admission. Freeze a default acceptance and max-cycles cap at run creation, inherit them and cumulative ledger budgets on resume, and issue paired `decision-C-rN` / `candidate-batch-C-rN` identities for explicit revisions. Never spread an old decision into a new snapshot.
- [ ] Add paper-delivery ordering tests: an authorized paper phase may create and capture its actual delivery before paper-related criteria are evaluated, but its done/checkpoint/compile marker alone cannot independently complete the total goal. A byte-captured real compile log or delivery may satisfy its linked artifact criterion; final coverage review must still bind all required criteria.
- [ ] Add recovery/identity red tests: unchanged PAUSED startup has no `nextAction`, `session-startup` does not recommend retry, and makes zero additional paid calls. A valid captured new source with caller-declared `changedCondition` creates one control revision while only its bytes/hash—not its natural-language cause—are host-verifiable; a budget increase/control revision makes one new review; prose-only changes, global snapshot wording, ledger spending, and review snapshots alone do not. Assert globally unique decision and batch IDs and no max-cycle reset. Add a legacy nonterminal fixture that creates exactly one derived-contract migration record, submits it to review, and cannot silently finish.
- [ ] Add tool ingress validation: `research_run` accepts optional `acceptance` and `recovery` with `additionalProperties: false`; malformed recovery paths/criteria reject. `startup/prepare` remains read-only and exposes a recovery action only for validated changed input.
- [ ] Supplement the recovery tests with criterion-linkage cases: an existing source reuses its known criterion identity with new bytes; a new source must name valid frozen `criterionIds`; missing/unknown IDs reject. The host checks IDs and hashes only, while the coverage reviewer judges semantic relevance, so path or wording similarity is not evidence.
- [ ] Add a crash-recovery fixture between accepted-recovery publication and run-state publication. Resume must reconcile the durable transaction/journal, reuse the accepted recovery, preserve budgets, and make no duplicate review call.
- [ ] Run focused continuation, recovery, startup, request-ledger, research-store, tool-options, and paper regression tests; run build and typecheck. Record precise commands/results in the review ledger without committing.

**Acceptance:** A run can complete at the cap only with a fresh verified complete decision. Insufficient review budget pauses as `budget_exhausted`. An unchanged pause never costs another review. Science records remain independent from non-scientific continuation artifacts.

### Task 2: Worker artifact ownership and receipt admission guard

**Files:**

- Modify: `packages/autoresearch/src/experiment/steps.ts`, `experiment/validation.ts`, `experiment/runtime-adapter.ts`, `experiment/runner.ts`, both service runners where their compatibility paths invoke the shared validation, `service/research-cycle.ts`, `service/continuation.ts`, relevant worker prompt(s), and the worker-specific direction registration seam.
- Do not replace: `cleanup/manifest.ts` public trusted-controller mixed-root registration API.
- Create: `packages/autoresearch/test/unit/worker-artifact-ownership.test.ts`.
- Modify: `direction-registration.test.ts`, `direction-manifest.test.ts`, and runner/minimal-runner tests where controller-issued `workDir` becomes required.

**Interfaces:**

- Plain `runWorker` in `experiment/steps.ts` centrally applies `validateWorkerResult(runDir, issuedWorkDir, value)` to fresh and cached model results, using service `work/cycle-XX` or standalone `work/experiment-cycle-XX` roots.
- `rehydrateVerifiedCompletedGraphAction(...)` in `runtime-adapter.ts` rebuilds only a host-receipt/collection/hash verified durable action; cached durable stages ignore self-reported artifacts.
- `registerWorkerDirectionArtifacts({ runDir, workDir, frozenManifest, action })` verifies the applicable real-path/receipt boundary, verifies current direction-manifest ownership for each plain-worker path, and refuses outside-root, missing-boundary, unknown/shared/user/pre-boundary, or changed-byte same-path entries before any `captureSource` or receipt promotion.
- Continuation task work persists task-local pre-intent baseline and immutable validated-result receipt; replay verifies both and never creates scientific snapshot/direction state.

- [ ] Add plain-worker fixtures for a post-boundary `raw`/mixed-root artifact, a preexisting `user.json` under issued workDir, a new regular issued-workDir file, an old raw unknown file, and a cached plain result whose bytes change. The invalid cases pause/reject without receipt or redispatch; only the new file captures.
- [ ] Add durable fixtures: verified graph/host receipt `research/sources/*` rehydrates successfully; forged stage artifact strings are ignored in favor of canonical host action; a collection/source hash mutation rejects. A graph, producer, or kind alone is insufficient.
- [ ] Add continuation fixtures: preexisting task work and cached validated-result byte changes reject; a valid immutable receipt replays without new scientific direction/snapshot state.
- [ ] Add a forged-receipt test that attempts to claim ownership by `producer`/`kind`, and a regression showing a legitimate trusted controller mixed-root receipt plus `logs/direction-copy.log` continues to register under its explicit existing API.
- [ ] Centralize fresh/cached plain validation in `experiment/steps.ts`; thread the controller-issued root through both runners. Add the narrowly scoped durable rehydration helper in `runtime-adapter.ts`; delete outer loose validation only after the central proof paths cover both modes.
- [ ] Implement the worker-only registration helper. At the `assessResearchCycle` seam, validate ownership before `captureSource`, direction registration, or evidence receipt creation. A boundary error must become an explicit pause; do not catch-and-warn then capture the untrusted artifacts.
- [ ] Mark/retain all pre-boundary and mixed-root artifacts as unknown according to existing manifest rules. Preserve legal refutation/explicit-abandonment cleanup ordering (compact memory before deletion). Ensure corrupt/old metadata and execution errors never create `confirmed_error` memory.
- [ ] Update prompts so workers may only create current-workDir artifacts and may not delete, move, or overwrite existing records. State that this boundary does not sandbox arbitrary shell behavior.
- [ ] Update `FakeAgentProvider` / `EvidenceProvider` fixtures to create real artifacts under `input.workDir`; do not exempt tests from issued-workDir validation.
- [ ] Run ownership, registration/manifest, cleanup safety, minimal/standard runner, and direction-retirement regression tests, then build/typecheck. Verify current new artifact admission and all rejection cases.
- [ ] Keep `direction-cleanup-e2e.test.ts` in the regression set and verify a terminal run may advance only the established safety-checked cleanup/audit/tombstone hooks, never scientific replay or acceptance synthesis.

**Acceptance:** Worker strings cannot elevate old/raw/user/shared files to direction-owned evidence. The existing controller receipt path remains compatible, and no test represents this as host-shell isolation.

### Task 3: Integration review against the dirty baseline

**Files:**

- Modify: `docs/verification/2026-09-20-research-continuation-guards-baseline-ledger.md` with command outcomes and changed-path inventory.
- Do not modify: baseline paper files except where a Task 1/2 change is explicitly necessary and reviewed against the Temp backup.

- [ ] Compare every baseline manifest hash with the worktree. For a modified baseline path, diff it against `<Temp baseline>\files\<path>`; for a path absent from the manifest use `git diff HEAD -- <path>` or inspect the new untracked file.
- [ ] Review continuation control identity for ledger self-invalidation, silent acceptance substitution, completed-follow-up reopening, cap reset, old terminal mutation, and duplicate decision/batch IDs.
- [ ] Review receipt flow from worker output to `captureSource`/direction registration and prove boundary rejection occurs before capture; verify the trusted mixed-root controller API is still covered.
- [ ] Run `npm run build`, `npm run typecheck`, and `npm test` from `packages/autoresearch`, plus the focused suites above. Append commands, results, and any unresolved risk to the ledger.
- [ ] Leave the worktree unstaged and uncommitted. Hand the baseline-relative diff plus verification evidence to a fresh reviewer.
- [ ] After review approval, have the integration subagent compare every proposed source file with the Temp baseline manifest and synchronize only Task 1/2 changes back to `C:\Users\80163\Desktop\挑战杯_2026\autonomous-research`. It must preserve all 46 baseline paths byte-for-byte unless that exact path has a reviewed Task 1/2 delta against its Temp backup, rehash all 46 original entries after synchronization, and leave both worktrees unstaged/uncommitted.
