# Conversational workbench bounded review

Review scope is limited to the 2026-09-10 conversational-workbench increment. `packages/autoresearch-web/` is untracked, so the review uses source/test snapshots rather than `git diff` as evidence. The initial baseline is recorded below and the final Web evidence and reviewed hashes appear in the verdict. Core 121/121 was not rerun because the final increment changed only Web.

## Baseline snapshot

- `src/workspace-projects.js` — `D2D7585A0493681BA593687BFA86D75FAD2A211528F0C5FF2FB672EAEFE53DA5`
- `src/index.js` — `451EC1ADA7F4D53BA858DF7EF252C434FF871DF11C06D403567B2B7CFB73D292`
- `src/workbench.js` — `3958E99ACA96F3D0615E002F2B783B427333AF5839FF3D5C7B5D2D6804D513CD`
- `test/api.test.mjs` — `461C2E1576DD50D37499F0E2E772E3EA9D2E4266CF26D4D4F13F917715B196D1`
- `test/workbench.test.mjs` — `694FED1BD37BBFA068DA0727705284849E1286B908CA78C62A9824ED2EA8AFFE`
- `test/native-host.test.mjs` — `BED61D928878B3BE32DBAFDE1B16764F3A78193405FEAE5FE2967B151C85C183`

## Backend requirements review

### Resolved — legacy config was exposed before the native registry attached

`src/workspace-projects.js` uses `config.projects` whenever `workspaceRegistry` is unavailable, and `src/index.js` injects only `webServer`. Therefore a normal late-service startup window exposes a separately registered legacy directory through projects, workbench document access, and settings access before the native workspace registry becomes authoritative. `test/api.test.mjs` (`a registry that becomes available after plugin setup takes over the fallback permanently`) explicitly demonstrates and preserves this behavior: the first `registry.list()` returns `legacy`, then a later native registry takes over.

This conflicted with the accepted boundary that a research project is exactly a native DSH workspace and the native registry is the sole directory authority. Reproduction needed no race machinery: construct the registry with `ctx.get('workspaceRegistry') === undefined` and `config.projects: [{ id: 'legacy', root }]`; `list()` and `find('legacy')` authorized the root.

The fix makes the default fail closed and requires a top-level `standaloneProjects: true` opt-in for an explicit standalone test host that intentionally uses `config.projects`. Once a native registry appears it remains the sole source. TDD evidence: the new default regression first failed by returning `legacy`; after the fix, affected API, native-host, and core-integration tests passed 19/19.

### Passed boundaries

- Registry records are re-read for requests, and record deletion invalidates project access.
- Document identities include the canonical root that created them; a root change invalidates old document IDs, build queries, and PDF access.
- Canonical-root checks and symlink rejection remain in discovery/document/PDF paths.
- The shared API still applies loopback, same-origin, and CSRF checks before workbench/settings writes.

## Frontend final-increment review

### Resolved — invalidated cached document hid an unsaved workspace draft

The prior client restored a cached draft only when its opaque `documentId` still existed in the latest listing. Root changes or deleted paper directories therefore hid the draft and left phantom dirty state. The final client presents such drafts as visible orphaned content, disables save/compile, and requires confirmed reload/selection before discarding it. A clean deleted document is cleared, and a removed workspace keeps a dirty draft visible for copying. Browser coverage exercises dirty deletion, orphan reload into a replacement document, and clean deletion.

### Resolved — delayed context after A → B → A

The parent previously accepted paper-frame context using only `projectId`, so an old A context delivered after a rapid A → B → A switch could replace current document/dirty/busy state. The parent now increments `selectionId`, includes it in `select-project`, and requires project plus selection identity on context. The paper child stores the parent-provided string ID and echoes it on context. Parent unit coverage checks the A → B → A predicate; browser coverage checks distinct IDs across managed workspace changes.

### Native resolved — selecting an ordinary session was overridden

The native workspace effect treated an ordinary or legacy current session as a trigger to create/open an AutoResearch session. It now keeps that native session selected and leaves the original conversation pane/input usable. Research shortcuts remain disabled until the user invokes the explicit “启动科研会话” action; only that action calls the binding path.

## Final source-review verdict

The two final findings are closed. Native sidebar state distinguishes an initial external collapse from a workbench-owned collapse, releases ownership when the user opens navigation, restores an owned collapse on desktop/exit cleanup, and does not let `ResizeObserver` immediately fold manual navigation back. PDF loading records generation, project, document and version; same-version polling reuses the pending task, while a changed identity invalidates it and prevents late completion from reaching the new selection.

Fresh verification passed the unified build and Web 57/57 (factory 16/16, sync 6/6), the settings browser check, and the stalled-PDF browser regression. The latter kept the editor usable and issued one PDF request across 6.5 seconds of polling. Real DSH acceptance at `http://127.0.0.1:3080/` (node PID 43984, cmd wrapper 26220) passed with a real PDF, native draft-only shortcut, same-session return and mobile navigation interaction. At 390×844 the closed navigation is a 56 px rail and the paper has 334 px visible width; manual expansion remains open until the user closes it, then the paper returns. Desktop/exit cleanup preserved the same research session and draft. The main session inspected the final desktop and mobile screenshots under `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-kIRdKA\` and accepted them.

The final `node test/workbench-browser.mjs` run completed with `status: passed` after its fixture selected exact document identities, established a dirty edit against the same disk file, distinguished current clean state from another workspace's cached draft, removed the embedded iframe immediately when the parent accepted its exit, and selected the orphan replacement explicitly. The accepted exit reuses the existing one-second navigation window, so the immediate iframe unload does not prompt twice; a cancelled exit or an expired window still protects dirty drafts. Core 121/121 and installer/preset 1/1 were not rerun because this increment changed only Web. No real model request was sent, neither user paper main file was modified, and no blocking issue remains in the bounded increment.

Final reviewed snapshot:

- `src/workspace-projects.js` — `154DB12A8DA93D15A87F2B7CE710F28B2D759A6F86EF286B85046DBF86CAAF86`
- `src/index.js` — `451EC1ADA7F4D53BA858DF7EF252C434FF871DF11C06D403567B2B7CFB73D292`
- `src/workbench.js` — `3958E99ACA96F3D0615E002F2B783B427333AF5839FF3D5C7B5D2D6804D513CD`
- `src/workbench-client.js` — `02592732FE3CC9F64E4ED1721F778F7C710538278DA7A315D6E1F9C0358FCA0D`
- `src/workbench-sync.js` — `E7A4EEAC0D7FA9C256FC5B681964BDC774A471BFD6E37DDB7C43C55302A467FA`
- `src/native-workbench-client.js` — `B2C0E5D8FE690EEF322F303B0B066187615752472E99B0A22D9CCC5F04677888`
- `test/api.test.mjs` — `5F048104394941BCC477DD6495DB3D68D2D8734BF8308B299A8671A808FFAEC0`
- `test/workbench.test.mjs` — `694FED1BD37BBFA068DA0727705284849E1286B908CA78C62A9824ED2EA8AFFE`
- `test/native-host.test.mjs` — `933F25312E17ED35725892F18A38794141343ABBA390F6F904BB48E9B18429CC`
- `test/factory.test.mjs` — `E40D90223991400AD922DD99979427F748C4F8C7AEC5305B4D82E324FCD7E8A3`
- `test/workbench-browser.mjs` — `A27994E5686779158626BAE7B7974103C3CB513D3706ED60079C2F613FEBEAE7`
- `test/workbench-pdf-load.browser.mjs` — `F4D8E176E909C7BEC709E0AB9C10B027669EB4C2D299A1ECC7A66FFD1BD8FB93`
