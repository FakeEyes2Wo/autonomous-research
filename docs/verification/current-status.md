# Current implementation status

This short record supersedes stale historical notes in older drafts.

- Current core verification (2026-09-10): `packages/autoresearch` `npm test` (including build) passes 121/121, and the installer/preset regression passes 1/1. The installer assertion covers the installed persona source prefix and spawn/fork subagent provider, tool-name, and continuable-background fields. This run does not recertify Web, live DSH, or browser acceptance; earlier counts and deployment claims below are historical checkpoints.

- Current workbench verification (2026-09-10): the unified Web build passes, `npm test` passes 57/57 (including factory 16/16 and sync 6/6), the settings browser check passes, the stalled-PDF browser regression observes one request during 6.5 seconds of same-version polling while the editor stays usable, and `test/workbench-browser.mjs` finishes with `status: passed` across compilation/PDF, managed conflict, discovery, embedded exit, relocation and orphan flows. Real DSH acceptance passes at `http://127.0.0.1:3080/` on node PID 43984 (cmd wrapper 26220): a 390×844 viewport has a 56 px rail and 334 px of visible paper, manual navigation expansion survives observation, closing it restores the paper, and desktop/exit cleanup returns to the same research session and draft. The accepted real-host desktop/mobile screenshots are under `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-kIRdKA\`; the final mock-host browser artifacts are under `C:\Users\80163\AppData\Local\Temp\autoresearch-workbench-browser-TDQzDd\`.

- User-requested research workbench and portable settings update: [conversation workbench guide](../guides/2026-09-10-conversational-workbench-guide.md). The common settings UI has three primary controls (model source, research intensity and paper output). The top-left native entry opens LaTeX editing and local PDF.js preview above the current native conversation, with explicit Tectonic compilation, outer/bottom spacing and a return to the same session. One native DSH workspace directory is one research project; production does not maintain a second project registry or selector. Source and successful PDF metadata can move with that workspace. Core engine/headless code no longer forces machine-specific paths or a local proxy.

- Real web profile deployment (2026-09-09, explicitly requested by the user): DSH starts, native browser graph loads, Settings → AutoResearch renders, and the allowlisted project settings GET returns 200. Installation fixes and the latest core 117/117 / Web 16/16 checks are in [the deployment record](2026-09-09-dsh-web-deployment.md). This supersedes the earlier real-profile release gate for this local deployment only.
- Latest local verification (2026-09-09): core 116/116, Web 13/13 plus browser flow, CPA 13/13; clean temporary core installation/build/tests and packaged research/paper tests also pass. Review fixes and reproducible commands are in [the verification record](2026-09-09-verification.md).
- Verified DSH anchor: `0.1.5-alpha.1`. Any `0.1.0-rc.6` mention is historical only.
- Provider/model and credentials remain native DSH Models/credentials data. The host chooses the settings path (usual default `.dsh/settings.yaml`); the Web package does not infer or rewrite it.
- `@athena/autoresearch-web` is optional. A production host composes the native Cordis row and uses the injected native workspace registry as the sole directory authority. `standaloneProjects: true` plus a reviewed allowlist exists only as an explicit fallback for a standalone test host without that registry. Installation alone does not change a profile, credentials, or global settings.
- Verified: public SlotCore factory, a temporary Cordis host with `webServer`/settings service injection and clean disposal, alpha.1 `dsh.client` metadata contract, core settings read/validate/patch/conflict flow, API security tests, and temporary React/Chromium render/save/reload flow.
- Real profile browser loading was verified as recorded above; the earlier temporary-only browser-graph limitation is historical.
- The workbench acceptance run is deterministic: shortcuts only populate the native draft, and the check neither sends a real LLM request nor asks AutoResearch to modify the user's paper; `paper/main.tex` and `paper-2/main.tex` were unchanged. Not claimed as complete: real CPA endpoint model smoke (the CPA configuration/installer mock/nativeConfig contract is covered), Claude adapter, runtime semantic escalation, hidden retry enforcement, literature search/full-text PDF reader, and real-model/runtime acceptance beyond the targeted minimal suite.
- Budget settings are persisted and the runtime hook/ledger work is present, but changing a project budget does not retroactively add tokens to an existing run. Resume does not clear `budget_exhausted`; an explicit reviewed run-budget adjustment/recovery entry point remains TODO.

The remaining literature reader extensions are tracked in [TODO.md](../drafts/TODO.md). The user explicitly brought the LaTeX/PDF workbench subset into the current scope.

See the detailed [acceptance matrix](acceptance-matrix.md) for supported,
limited, pending, and TODO areas.

Unaccepted CPA, Claude, semantic escalation, and hidden-retry work is tracked
in [TODO-addendum.md](../drafts/TODO-addendum.md).
