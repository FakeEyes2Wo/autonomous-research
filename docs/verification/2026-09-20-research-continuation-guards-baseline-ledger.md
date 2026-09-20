# Research Continuation Guards Baseline Ledger

The implementation baseline is the complete dirty working state captured before this feature, not `HEAD`.

- Source branch/HEAD: `feat/sol-pi-efficiency-retirement` / `02d6fbaa288a049b18ee6c460e576d8f4586eb36`.
- Frozen dirty paths: 46 (26 tracked changes and 20 untracked files).
- Immutable manifest and file backups: `C:\Users\80163\AppData\Local\Temp\autonomous-research-continuation-baseline-f5aea675ea60451fb7ad9503a1c9b69d\baseline-manifest.json` and `files\`.
- SHA-256 source/destination records: `file-sha256.tsv` and `destination-sha256.tsv` in that directory; each of 46 paths verified equal when this worktree was created.
- The original repository was rechecked after capture and still matched the captured porcelain-v2 status exactly.
- Root independently rehashed the 46 baseline entries after isolation and confirmed `46/46`; the isolated worktree baseline build exited `0`.

Review this feature against the baseline as follows. Do not treat the pre-existing paper implementation as this feature's diff.

1. Read the manifest and make a map from `files[].path` to `files[].sha256`.
2. For every mapped path, hash the current worktree file. A changed hash is a feature modification to a baseline file; inspect it with `git diff --no-index -- <backupRoot>\files\<path> <worktree>\<path>`.
3. For tracked paths absent from the map, use `git diff HEAD -- <path>`; for untracked paths absent from the map, inspect them as newly created feature files.
4. Require the review report to name the baseline manifest, all changed baseline paths, all new paths, the exact build/typecheck/test commands, and the result. Do not stage, commit, push, delete, or restore baseline paths.

After the reviewer approves integration, a fresh integration subagent must use this same manifest to copy only reviewed Task 1/2 deltas to the original workspace. It must compare any modified baseline path against `files\<path>`, retain every unrelated baseline byte, then rehash all 46 original entries. Synchronization is incomplete if any baseline hash differs unexpectedly or either workspace becomes staged.

Review recovery changes for explicit frozen-criterion linkage: known sources may use their established identity, while new sources must carry valid `criterionIds`; host checks IDs and bytes only, and coverage review supplies the semantic relevance judgment. Review paper changes for phase ordering: authorized delivery may precede final criterion evaluation, but no done/checkpoint/compile marker is total-completion evidence without captured delivery bytes and final coverage review.

Review terminal behavior separately from cleanup: terminal state blocks research replay, acceptance synthesis, and historical scientific rewrites, but must preserve the existing authorized `finalizeDirectionRetirement` / `advanceCleanupQueue` path for bounded legal refutation/explicit-abandonment cleanup, audit, and tombstones. Keep `direction-cleanup-e2e.test.ts`. A done/checkpoint/compile marker cannot independently prove the whole goal, while a byte-captured genuine compile log may be evidence for its specifically linked artifact criterion.

## Task 1 review round 1

The initial baseline-relative inventory and pre-review snapshot are retained as the review-0 reference. Do not replace them with the current fix-round source. Important findings requiring the scoped follow-up delta are: cached legacy finish must not override new opposing evidence/new review; a known failed follow-up must be able to retry in a new generation; derived acceptance must not impose empirical-science requirements on every goal; and an accepted recovery must survive a crash between control publication and run-state publication. Review the repair against the Task 1 snapshot with `generate-baseline-context-diff.ps1 -FeatureSnapshotRoot <task-1 snapshot>`; include newly created files and exclude `.superpowers/sdd`.

Fix round 1 addressed all four original Important findings. Review discovered one separate `retryOf` defect: explicit matching must be exclusive and cannot be preempted by an earlier generic candidate. Fix round 2 is deliberately limited to the implementation worker's two-file `task-1-fix2-base` comparison. Preserve the round-1 review package and do not create the accepted Task 2 baseline until that repair is approved.

Task 1 and its Fix 2 were approved. Root independently rehashed the original source baseline at acceptance: all 46/46 entries matched with zero differences. The accepted Task 2 baseline is `.superpowers/sdd/2026-09-20-research-continuation-guards/feature-snapshots/task-2-accepted-baseline/feature-manifest.json` (29 Task 1 feature paths with bytes/SHA-256), with the original Temp manifest retained as fallback for every path absent from that feature snapshot. Scratch remains excluded from all feature inventory and integration.

Audit generator rule: inventory candidates are the union of Git status paths, original dirty-baseline manifest paths, and accepted feature-snapshot paths. This catches a deleted accepted untracked file or a dirty file restored to HEAD even when Git status no longer reports it. Preserve raw SHA-256/bytes; normalize line endings only for readable review diff presentation. Retain the complete `.superpowers/sdd/2026-09-20-research-continuation-guards` archive as audit evidence and never copy it into the original product workspace.

Task 2 freeze package was generated after the implementation worker explicitly confirmed freeze. It is normalized only for diff presentation and retains exact byte inventory/snapshot records. Worker-reported validation at freeze: scoped tests 197/197 pass, post-final ownership tests 27/27 pass, receipt checks 7/7 pass, and build/typecheck exit 0. The package contains 18 implementation source/test/prompt paths plus this ledger's setup-owned entry; prior unchanged paper edits and all scratch paths are excluded. Task 2 remains in review until an independent reviewer approves it.

Task 2 review opened Fix Round 1 for two Important findings: ownership/baseline lookup must canonicalize Windows alternate-case aliases so an old file cannot be promoted or captured through a case variant; and corrupt frozen/worker-root/attempt JSON must become a persisted classified PAUSED result rather than an unclassified throw. Before code changes, retain the existing review freeze and capture the full cumulative Task 1 + Task 2 feature state against the original dirty baseline. That full snapshot, rather than the 19-path Task 2 scoped freeze, is the Fix Round 1 diff base so unchanged Task 1 paths do not leak through fallback comparison.

Fix Round 1 also aligns the existing `existing-project-research-e2e.test.ts:115` fixture with accepted behavior: an unchanged second paper-resume sentinel returns PAUSED with zero calls, rather than rejecting. Preserve its first-sentinel, formal-evidence, checkpoint, ledger, role, job, and science assertions; this is a test-only correction owned by the Task 2 worker and falls back to HEAD in the pre-fix snapshot.

Pre-fix root verification evidence, not a final green claim: `npm test` exited 1 after 696 tests with 695 pass and one failure at that stale second-paper-resume fixture; elapsed time was 420591.533 ms. `npm run typecheck` exited 0 and the Windows three-minute soak passed. `node scripts/benchmark-harness-efficiency.mjs` exited 0 with fixture-only calls 2 to 1, estimated context 503 to 273, observation 12716 to 3289 including the 512-source-byte page, fusion output 262 to 340, and receipt verified/science unverified.

The temporary backup also contains `baseline-tools\capture-continuation-baseline.ps1` (SHA-256 `819041C225BB8B5B996487D89182F3FFA303E582EF030C9A742C375EB6CBA5B3`), retained for audit. Its worktree copy was removed after the hash-verified backup, so it is not product diff.

## Final approved verification record

Final whole-feature review approved the 42-path feature snapshot after the consolidated final-fix re-review: all three whole-feature Important findings were addressed and no Important or Critical findings remained. The frozen cumulative feature state is `.superpowers/sdd/2026-09-20-research-continuation-guards/feature-snapshots/final-fixed-cumulative-freeze/feature-manifest.json`; its normalized cumulative review is `final-fixed-cumulative-review.diff`, and its six-path final-fix delta is `final-fix-review.diff`. The final-fix review changed six recorded paths and independently confirmed the other 36 snapshot hashes unchanged.

Root final verification ran `npm test` in the isolated worktree: exit `0`; 728 tests passed, 0 failed, 0 cancelled, 0 skipped, and 0 todo; duration `465824.1527 ms`. This includes the three-minute Windows recovery soak (`180431.6915 ms`). Root also recorded final `npm run typecheck` exit `0`, `git diff --check` exit `0`, and `node scripts/benchmark-harness-efficiency.mjs` exit `0`. The fixture-only benchmark measured calls 2 to 1, estimated context 503 to 273, observation bytes 12716 to 3289 (`2470` packed response plus `819` rendered page; source content `512` bytes), and fusion output bytes 262 to 340. Its receipt remains verified while scientific status is unverified. The earlier 709/709 full-suite result and the earlier 695/696 stale-fixture failure remain historical evidence, not replacements for this final result.

The original repository was still on `feat/sol-pi-efficiency-retirement` at `02d6fbaa288a049b18ee6c460e576d8f4586eb36`, with no staged entries; root rehashed all 46 preserved dirty baseline entries with zero differences before integration. The final integration manifest is generated from the final feature snapshot plus this final ledger record. It binds every one of the six reviewed baseline-overlap deltas to the corresponding original SHA-256 from the Temp baseline manifest and excludes scratch, `dist`, `node_modules`, and `logs`. It authorizes only a future fresh integration agent to perform the guarded dry-run/apply; it does not mean synchronization has occurred.

The delivered controls remain bounded by the stated limits: coverage review is semantic assessment rather than a formal host proof of completeness; controller artifact validation does not provide host-shell isolation; legacy proof-less caches pause rather than replay; and fixture/provider tests and the efficiency benchmark do not establish live-model behavior or scientific correctness. No external `usenix2027` records were modified.
