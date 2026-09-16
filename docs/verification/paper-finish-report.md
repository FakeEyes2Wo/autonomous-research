# Paper iframe finish report

Date: 2026-09-10

## Delivered

- In `embedded=1&workspaceManaged=1`, the parent owns workspace selection.
  The iframe loads `/projects`, posts `ready`, and only then accepts same-origin
  `select-project` messages from `window.parent`.
- Each parent selection refreshes the project registry. Known projects switch
  immediately, unknown projects remain pending until the refresh finds them,
  and `null` clears the paper panel without selecting the first project.
- The iframe echoes `select-project.selectionId` in every paper `context`
  message. The native shell uses that value to reject stale A→B→A context.
- Workspace drafts keep their document identity, saved source and revision in
  page memory. A delayed save updates the cached base without losing newer
  typing, including when the user returns to A before the old response arrives.
- If a dirty document disappears or its workspace root changes, its draft stays
  visible as an orphan. Save and compile are blocked, the notice explains that
  it cannot be written to a replacement file, and an explicit reload/document
  selection/new-document action discards it after confirmation. Clean deletion
  clears the document and asks the user to select another file. A removed
  workspace keeps a dirty orphan visible and copyable so it is not an invisible
  `beforeunload` warning.

## Validation

- `npm --prefix packages/autoresearch-web run build` — passed after the final
  paper and native changes.
- `npm --prefix packages/autoresearch-web test` — passed, 53/53 tests.
- `npm --prefix packages/autoresearch-web run test:browser` — passed. Settings
  screenshot: `C:\Users\80163\AppData\Local\Temp\autoresearch-web-browser-profile-jCdDk8\dsh-autoresearch-settings.png`.
- `node test/workbench-browser.mjs` from `packages/autoresearch-web` — the
  elevated Chromium harness completed successfully. The execution bridge did
  not forward its JSON summary; produced screenshots are
  `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-ZfFnHx\workbench-desktop.png`
  and `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-ZfFnHx\workbench-mobile.png`.
- `node --check`, UTF-8/replacement-character/mojibake scan and `git diff
  --check` passed for the paper iframe source and browser regression.

## Files changed for this handoff

- `packages/autoresearch-web/src/workbench-client.js`
- `packages/autoresearch-web/test/workbench-browser.mjs`
- `packages/autoresearch-web/test/browser-render.test.mjs`
- `packages/autoresearch-web/README.md`
- `docs/superpowers/plans/2026-09-10-conversational-workbench.md`
- `docs/guides/2026-09-10-conversational-workbench-guide.md`

## Remaining acceptance

The real DSH host acceptance is owned by the main session. It must verify the
native workspace/session bridge against the newly built package. No real model
research request was sent by these checks.
