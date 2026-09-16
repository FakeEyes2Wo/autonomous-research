# Workspace Entry Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Make entering an AutoResearch workspace reliable and detect the observed DSH preset import failure before presenting an installation as usable.

**Architecture:** Keep native DSH workspace/session authority. Preserve explicit `agentPreset: 'auto-research'` creation through the remote API, then refresh/observe the public local session store before opening. Bind workbench subscriptions to Cordis service lifetimes. Check preset imports from the actual DSH host resolution root, including transitive imports.

**Tech Stack:** JavaScript ESM, Node >=22.19, Cordis, React, node:test, Windows local development and Linux DSH deployment.

## Global Constraints

- Only subagents may change application code, tests, manifests, scripts, or deployed code. Controller handles analysis, planning, orchestration, read-only review, and verification.
- Preserve all pre-existing user changes. Implement in `.worktrees/workspace-entry-repair` on `fix/workspace-entry-repair`; integrate only task-owned changes after review, without committing unrelated changes on main.
- Preserve workspace ID to server-authoritative project ID and canonical path boundaries. Do not introduce caller-controlled filesystem paths or invent local DSH session records.
- Keep `agentPreset: 'auto-research'`, ordinary-session separation, generation cancellation, authentication, credentials, and existing workspace data intact.
- No model messages or research jobs during verification. A bounded empty session creation is permitted for acceptance.
- Do not mass upgrade or downgrade the DSH tree. Record actual runtime versions; repair observed missing dependencies at an exact version matching the consumer and preserve the package-manager lockfile.

## Evidence and data flow

The live workspace has ID `7554573c-5940-4857-8d8c-a943667388eb`, path `/home/ironmoon/test_autoresearch`, an API-visible project mapping, and no sessions. Browser clicking the workspace row plus button reaches `remote.session.create`. The host calls `ensureSession` before `workspace.attachSession`. Preset mounting fails importing `@deepseek-ai/dsh-workflow-worker-thread` because its peer `@deepseek-ai/dsh-workflow` is absent. This explains the empty membership; it does not establish a bad path or missing project mapping.

The host CLI is 0.1.5-alpha.1 but several runtime packages, including the failing consumer, are 0.1.5-rc.2. A direct import sweep found only workflow-worker-thread failing among 23 preset module specifiers. Fixing this import alone does not yet prove mounting succeeds.

Local and live `ISessions.create()` do not expose agentPreset. Both expose `list.getSnapshot()`, `list.subscribe()`, `refresh()`, and synchronous `open(id)` which rejects unknown IDs. The current bridge bypasses the native create method's synchronous local projection guarantee. The projects map is fetched once, and hook/subscriptions currently capture services once.

### Task 1: Repair native workbench session and workspace state

**Files:**
- Modify: `packages/autoresearch-web/src/native-workbench-client.js`
- Modify if needed for the module dependency: `packages/autoresearch-web/package.json`, `packages/autoresearch-web/package-lock.json`
- Test: `packages/autoresearch-web/test/factory.test.mjs`; a focused additional native lifecycle test may be added and included in the test command if it keeps tests clearer.

**Interfaces:** Preserve bridge `bind(target, legacyCwd, beforeOpen)`, `createFresh(workspaceId)`, `cancel()`, `dispose()`, and existing hook cleanup API. Use public DSH list/refresh APIs and Cordis `ctx.inject` lifecycle. Do not call native `sessions.create` with unsupported agentPreset.

- [x] Add failing behavior tests before implementation. The delayed-store case must model the actual open constraint:
  ```js
  const byId = {};
  const sessions = { list: { getSnapshot: () => ({ byId }), subscribe },
    refresh: async () => { byId.created = { sessionId: 'created' }; notify(); },
    open: id => { assert.ok(byId[id], 'unknown session'); opened.push(id); } };
  // remote create returns {ok:true,value:{sessionId:'created'}} before list publication.
  assert.equal(await bridge.createFresh('ws-a'), 'created');
  assert.deepEqual(opened, ['created']);
  ```
  Cover both bind and fresh creation, already-visible session, delayed publication, refresh failure/timeout, cancellation while waiting, and no leftover subscribers/timers. Cover canceled saved-session conflict with zero second creation requests. Keep preset/import errors unchanged and visible.
- [x] Add tests for no current session with a ready recent workspace (global new action chooses recent workspace); no workspaces and loading state (no arbitrary create); project list initially empty then workspace becomes available; HTTP/malformed mapping failure; stale responses after workspace switch; services injected after mount and replaced/disposed; root mode off still reads no optional services.
- [x] Run focused tests and record genuine RED output. Do not relax session.open mocks to hide the race.
- [x] Implement remote creation followed by bounded, cancellable local visibility synchronization. Subscribe before rechecking, request `sessions.refresh()` when missing, verify byId before open; use a useful failure message when no visibility arrives. Check generation before saved-ID retry and after every await. Persist resume identity only when the current result is ready to open.
- [x] Make no-argument new-session resolution follow DSH current/recent workspace behavior using native store data. Preserve explicit workspace IDs and do not choose an arbitrary workspace while loading. Update empty-state status even when identity fields are unchanged.
- [x] Refresh validated project mappings on workspace membership/readiness changes, guarding stale/disposed requests and avoiding unbounded loops or canceling in-flight creation on an equivalent mapping update. Keep separate resource subscription and selection lifetimes. Use Cordis injection for late services and reliable cleanup; ensure workspace UI module is declared for loading if required.
- [x] Run build and the Web package test suite once, plus focused new tests. Self-review, commit only owned changes in the isolated worktree, and write a report with RED/GREEN commands, output, changed files, and concerns. Do not integrate or deploy until controller review.

### Task 2: Check DSH preset runtime dependencies and repair deployment

**Files:**
- Create: `packages/autoresearch/scripts/check-dsh-runtime.mjs`
- Modify: `packages/autoresearch/scripts/install-dsh-plugin.mjs`, `packages/autoresearch/package.json`
- Test: `packages/autoresearch/test/unit/check-dsh-runtime.test.ts`, `packages/autoresearch/test/unit/install-dsh-plugin.test.ts`
- Document: `packages/autoresearch/docs/dsh-runtime-check.md`

**Interfaces:** `npm run check:dsh -- --dsh-package <absolute path to host dsh/package.json>` must check from the explicitly selected runtime. Allow the installer to accept `--dsh-package` and run the same preflight before writing its profile/preset files. Offline installer use without this option must clearly state that copying configuration does not validate runtime readiness and give the check command; do not force access to a user's global DSH in unit tests.

- [x] Add failing temporary-runtime fixture tests. A fixture plugin imports an absent peer:
  ```js
  // fixture plugin index.js
  import 'missing-workflow-peer';
  export default {};
  ```
  Assert the check fails with the consuming plugin and transitive missing package identified; supplying the peer makes it pass. Include subpath exports, unavailable runtime, readable version report, and explicit installer preflight failure leaving package/patch/preset content untouched.
- [x] Run focused tests, capture RED; implement the minimal ESM runtime checker. Walk named preset plugin rows including nested groups, skip Cordis builtin names and statically disabled rows, support tagged disabled expressions conservatively without eval. Resolve/import against the chosen host package (not the plugin's own dev dependency tree); capture all failed imports and nonzero exit. Report CLI and selected core runtime versions without claiming that imports prove the full preset mounted. Imports must not call apply(), create sessions, read credentials, or launch model calls.
- [x] Add `check:dsh` command and integrate optional explicit preflight before installer mutations. Document exact-version peer repair, lockfile preservation, version drift observations, and required final real session-create acceptance. Do not implement a general deployment manager or automatic broad package upgrades.
- [x] Run focused runtime/installer tests, core build/typecheck, self-review, and commit only owned changes in the shared repair worktree. Produce a report and await task review.
- [x] After controller review, integrate both reviewed task diffs into the user's current checkout preserving their existing changes. Deploy only reviewed changed code to `/home/ironmoon/autonomous-research`; do not overwrite remote manifests that have deployment-specific peer additions. Run checker against `/home/ironmoon/.local/node_modules/@deepseek-ai/dsh/package.json`, install the confirmed missing workflow peer at `0.1.5-rc.2` in the host prefix preserving its lockfile, and rerun checker. If additional mount failures appear, report precise evidence before choosing the smallest repair.
- [x] Rebuild affected packages on the server, restart only the identified user's DSH web instance with the existing profile and host/port configuration. Preserve settings/credentials/workspace storage. Redact tokens in logs. Controller then verifies live browser row-plus creation, membership, selected session and loaded paper workspace, no model message sent. Record import check separately from mount/UI success.

## Verification and reports

Task reports and review packages live in `.superpowers/sdd/2026-09-15-workspace-entry-repair/`. Each task gets separate spec/quality review; final review covers both tasks and deferred findings. Record failures honestly. The final result must distinguish local verified changes, deployed changes, runtime checks, and live workspace-entry acceptance.

## Execution status

- Task1 implementation and task-scoped reviews passed at1323eaf; final combined review identified two additional actual-component lifecycle regressions, now in one aggregate subagent fix wave.
- Task2 checker/installer implementation3ab325a passed spec and quality review; temporary-runtime tests7/7, core build/typecheck passed.
- Exact missing-peer environment repair is complete independently; old-code browser acceptance succeeded after stable initialization. No further dependency installation is needed.
- Final code integration/deployment remains pending the final fix and scoped re-review. Controller prepared a nonmutating integration patch check and a constrained deployment brief; only the deployment subagent will apply code.

## Live acceptance follow-up: Cordis single-service injection

After deployingff4718f, auth/native host work but native paper overlay disappears. Root actual browser CDP console capture (not only unhandled exceptions) identifies `TypeError: Reflect.has called on non-object` at `installInjectedNativeResearchSessionHook`, followed by slot entry crashed in shell.overlay. CSS link remains and iframe load aborts, confirming mount then React effect failure. Actual Cordis inject accepts a required-service array or configuration map; helper currently passes bare string uiWorkspace, while prior unit mock incorrectly accepts it.

Bounded follow-up plan: implementing subagent changes that call to the supported array form, adds regression using actual installed Cordis lifecycle/API (not a permissive mock), runs focused tests+build and commits in repair worktree. Root obtains scoped review; deployment subagent integrates/deploys only this follow-up diff, rebuilds/restarts. Root repeats browser acceptance including CDP console errors. Existing reviewed changes stay in place; no user data/model operations.

