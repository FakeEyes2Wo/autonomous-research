# Research UI alignment — 2026-10-18

The Web UI now exposes the current research workflow and a dedicated native
sidebar entry. Existing uncommitted core changes were preserved.

## Behavior

- The native `sidebar.panellist` row and matching `main` key switch the main
  content area to the workbench. The conversation view unmounts; the workbench
  fills the page without an overlay, conversation split or resize grip. The
  official DSH brand remains visible, the collapsed rail has an accessible icon,
  and entering an already-open workbench keeps the existing iframe.
- **返回聊天**, other sidebar pages and session rows switch away normally,
  without reloading DSH. Shortcuts prefill the current research conversation
  and switch to it. New-session actions create a fresh research session while
  the workbench is mounted and return to normal native behavior on exit.
- Settings name the two modes “低调用流程” and “完整研究流程”; the UI fallback mode
  matches the core's `legacy` default. The budget preset is labelled “调度预算”
  and explains its distinction from scientific validation coverage.
- Paper improvement rounds and all 32 registered research/paper role routes
  are editable. The role table no longer duplicates its header.
- Native and standalone workbenches share five draft-only actions: start
  research, design experiments, review evidence, write a paper, refine a paper.
  Only refinement requires an existing paper; unsaved paper context is guarded.
- Prompts distinguish pilot calibration, formal validation, coverage gaps and
  evidence-supported conclusions. They do not force paper generation when
  starting research.
- Native navigation checks the live paper synchronously before either panel or
  session selection changes. Unsaved edits can cancel leaving, including edits
  whose context message has not arrived and cached edits from another project.
  In-flight saves prevent leaving. Confirmed discard exits; saving then leaving
  does not prompt again. The settings link also checks for unsaved settings and
  uses the native panel switch.

## Validation

| Check | Result |
| --- | --- |
| Web build | Passed |
| Web unit/integration suite | 91/91 passed |
| Settings browser test | Passed, including workflow mode, paper improvement rounds, experiment-designer routing, save/reload, revision conflicts and navigation guard |
| Standalone workbench browser test | Passed, including new draft actions, real Tectonic compilation/PDF, external edits, conflict protection, relocated package, desktop and mobile |
| Native panel browser test | Passed with real React, built client and document HTTP API: full page, repeated entry, cancellation before context delivery, save/discard and leave, guarded session selection, draft handoff to chat and session-hook cleanup |
| Isolated DSH 0.2.0-rc.1 host | Sidebar row, first/repeated entry, full-height main replacement, mobile rail, five actions, return to chat and switching to Plugins passed without reloading; no browser exceptions |
| Visual inspection | Native desktop/mobile and a full-page paper editing fixture inspected, alongside prior settings/standalone checks |
| Read-only code review | No blocking findings; installed DSH sources confirm native navigation APIs and conversation input availability while the conversation view is unmounted |

The isolated native host had no registered project or provider. Its check
verifies navigation and layout; it does not verify a live research run. The
standalone functional test uses a mock native chat bridge and real document
and compiler services. The native panel fixture uses deterministic native
session/layout services and real React/document services. No model requests
were sent and the user's live host was not restarted.

Browser tests initially timed out at `Runtime.enable` inside the sandbox.
The workbench test and isolated native check passed after running their
temporary browser outside the sandbox with approval. The interactive Browser
connector had no available browser, so the repository's browser harness was
used. Tectonic used the existing workspace-local cache.

The existing full live-workspace scripts were updated for the main-page
switch and draft-to-chat behavior; they were not run against the user's real
workspaces. The new fixture can be repeated with `npm run test:native-panel:browser`.
