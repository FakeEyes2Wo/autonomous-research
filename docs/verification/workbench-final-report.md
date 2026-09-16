# DSH AutoResearch workbench final report

Date: 2026-09-10

## Scope

This handoff completed the mobile native sidebar ownership/measurement path, the pending PDF load identity path, and the follow-up native workspace session creation path. No `paper/main.tex` or `paper-2/main.tex` file was changed.

## Changes

- `packages/autoresearch-web/src/native-workbench-client.js`
  - Uses the public `ctx.get('layout').toggleSidebar()` API for cramped mobile layouts.
  - Measures the visible viewport width when the DSH shell keeps a wider internal layout.
  - Tracks initial/external, owned, released, and idle sidebar ownership so manual expansion is not folded back by `ResizeObserver`; cleanup restores only a collapse owned by the workbench, including after desktop resize.
  - Scopes native new-session actions to the mounted workbench and creates fresh `auto-research` sessions through `remote.session.create({ workspaceId, agentPreset })`; fresh creation never reads a remembered session ID.
  - Uses the explicit workspace-row target, or the currently selected workspace for the global action; an absent target is reported instead of falling back to a different directory or preset.
  - Opens only the latest parallel fresh-session result, restores the original `uiWorkspace.startSession` method on cleanup, and surfaces structured remote errors in the workbench status.
  - Reads the public client `SessionSummary.projectionValues.agentPreset` field so reloaded AutoResearch sessions remain recognized.
- `packages/autoresearch-web/src/workbench-client.js`
  - Keeps a pending PDF identity containing generation, project, document, version, and task.
  - Reuses/skips a same identity/version load across polls; version, project, document, or generation changes invalidate the prior task.
  - Late PDF completion checks the complete current identity before updating the document preview.
  - Reuses the existing one-second confirmed-navigation window after an accepted embedded exit, preventing a second iframe `beforeunload` prompt while preserving cancellation and expired-window draft protection.
- `packages/autoresearch-web/src/workbench-sync.js`
  - Adds the pending PDF target decision guard and identity helper.
- `packages/autoresearch-web/test/factory.test.mjs`
  - Adds sidebar ownership, viewport metrics, fresh-session isolation/concurrency, scoped native action/cleanup, missing-target, and projected preset identity coverage.
- `packages/autoresearch-web/test/verify-workspace-switch-live.mjs`
  - Exercises folder expansion, an exact native workspace session identity, workbench project selection, session-target cwd, AutoResearch mode, and the restored native default new-session path without sending a model request.
- `packages/autoresearch-web/README.md` and `docs/guides/2026-09-10-conversational-workbench-guide.md`
  - Explain that clicking a folder only expands it, while selecting a session or using the folder-row `+` changes the active research directory.
- `packages/autoresearch-web/test/workbench-sync.test.mjs`
  - Adds same pending PDF and identity mismatch coverage.
- `packages/autoresearch-web/test/workbench-pdf-load.browser.mjs`
  - Confirms a stalled PDF does not block editing and that 6.5 seconds of polling issues one PDF request for the same pending version.
- `packages/autoresearch-web/test/verify-live.mjs`
  - Adds effective mobile paper width/writing mode checks, condition based rail settling, mobile open/selection/close navigation checks, and exact research session identity preservation.
- `packages/autoresearch-web/test/workbench-browser.mjs`
  - Selects managed documents by exact relative path instead of assuming the first same-content document, establishes the local-dirty conflict precondition before editing the same disk file, verifies a second-project save against its API source while a different project draft remains cached, models the parent removing an iframe immediately after an accepted exit, and explicitly selects the replacement document in the orphan flow.

## Verification

Commands run from `packages/autoresearch-web`:

```text
node --check src/native-workbench-client.js
node --check src/workbench-client.js
node --check src/workbench-sync.js
node --check test/factory.test.mjs
node --check test/workbench-pdf-load.browser.mjs
node --check test/verify-live.mjs
npm run build
npm test                         # 57/57
npm run test:browser             # passed
node test/workbench-pdf-load.browser.mjs # passed; one request during the pending window
node test/workbench-browser.mjs  # passed
node test/verify-live.mjs --log C:\Users\80163\AppData\Local\Temp\autoresearch-live-final-20260910\dsh-web.stdout.log --workspace autonomous-research # passed
node --test test/factory.test.mjs # 19/19
node test/verify-workspace-switch-live.mjs --log C:\Users\80163\AppData\Local\Temp\autoresearch-live-final-20260910\dsh-web.stdout.log --workspace "TEST paper" --session session-40304343-bcea-475b-b87e-cd7c1f6e829a --verify-native-default # passed
```

`factory.test.mjs` passed 16/16 and `workbench-sync.test.mjs` passed 6/6 within the 57-test Web suite. The final `node test/workbench-browser.mjs` run completed with `status: passed`, including real LaTeX compilation/PDF rendering, managed conflict preservation, generated-document discovery, embedded exit, relocation, and orphan flows. Its final mock-host screenshots are under `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-TDQzDd`.

## Real DSH acceptance

The original PID 198708 was absent. A hidden DSH web instance was started and verified as DSH at `http://127.0.0.1:3080/` (without exposing its token): cmd wrapper PID 26220 and actual DSH node PID 43984. Startup log: `C:\Users\80163\AppData\Local\Temp\autoresearch-live-final-20260910\dsh-web.stdout.log`; stderr was empty. The live command completed with `status: passed` and confirmed:

- existing `autonomous-research` workspace/session selection and same-session return;
- native compiler availability, rendered real PDF, and editable source;
- desktop resize/collapse and mobile 390x844 layout;
- mobile root width 390px with a 56px grid rail, center/paper visible width 334px;
- horizontal writing mode for title/editor;
- mobile sidebar open button, workspace/session selection by research session identity, manual expansion surviving observer measurement, close button, and paper restoration;
- no real model research request.

Final screenshots:

- Desktop: `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-kIRdKA\dsh-workbench.png`
- Mobile 390x844, navigation closed and paper visible: `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-kIRdKA\dsh-workbench-mobile.png`

Core 121 tests were not rerun, per scope; no real model request was sent; no paper main files were written.

## Follow-up workspace-session acceptance

The original failure was reproduced at the exact `TEST paper` workspace-row `+`. Native `sessions.create({ workspaceId })` selected the configured default preset, whose persona still used the obsolete `text` key; DSH reported `agent-preset/invalid` because `prefix` was required. The preset file was backed up and that single key was corrected separately, then validated with the installed persona runtime schema.

While the workbench is mounted, native folder-row and global new-session actions now create a fresh AutoResearch session in the exact native workspace. The final live check confirmed `TEST paper`, `AutoResearch · 连续对话`, membership in the `TEST paper` workspace, and session target cwd `D:\teskdesk\TEST paper`. After leaving the workbench, the same workspace-row `+` successfully created a native default session without another `new session failed` warning. No prompt was sent and the empty `TEST paper` directory was not modified.

Final `TEST paper` screenshot: `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-7cQMwx\test-paper-autoresearch-session.png`.

## Session-cwd tool binding and final deployment

The follow-up core review found that the DSH session cwd was correct but relative `runDir` and `projectDir` tool arguments still used the host process cwd. `packages/autoresearch/src/tools/workspace-paths.ts` now resolves non-empty relative research paths against the calling agent session's immutable `header.cwd`. Absolute paths and calls without an agent context keep their prior meaning; a calling agent without an absolute session cwd fails closed. Empty paths remain unchanged until each tool's existing required-path validator rejects them. Project settings and figure API tools also read their declared `projectDir` argument.

The core build passed, the focused tools suite passed 6/6, and the complete core suite passed 126/126. The Web focused factory suite remained 19/19 and its final build passed. The installed `@athena/autoresearch` and `@athena/autoresearch-web` packages are junctions to this repository, so the host needed a restart to load the new core tool wrappers.

Immediately before restart, the expanded native sidebar showed 20 visible session rows and zero running sessions. The verified DSH node PID 43984 was stopped, and a hidden replacement was started at `http://127.0.0.1:3080/`: wrapper PID 53512, DSH node PID 68752. Its stdout log is `C:\Users\80163\AppData\Local\Temp\autoresearch-live-workspace-final-20260910-113143\dsh-web.stdout.log`; stderr was empty.

The fresh blank AutoResearch session was not automatically exposed in a new browser's native session list after the host restart. The existing workbench resume/adopt path reattached the same `session-40304343-bcea-475b-b87e-cd7c1f6e829a` without creating another ID. The final read-only check reported `TEST paper`, `AutoResearch · 连续对话`, and target cwd `D:\teskdesk\TEST paper`. No model request was sent and no user paper was written.
