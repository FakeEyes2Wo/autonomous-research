# Implementation and acceptance matrix

Update: [actual local DSH web deployment](2026-09-09-dsh-web-deployment.md) now verifies native profile/client graph loading, Settings → AutoResearch rendering and project settings reads. Core tests are 117/117 and Web tests 16/16. Earlier temporary-host-only limitations below remain historical for this local deployment; real CPA/model/runtime acceptance is still pending.

| Area | Status | Evidence / limitation |
|---|---|---|
| DSH anchor | supported | `0.1.5-alpha.1`; upgrade record is in `dsh-upgrade-record.md` |
| Reproducible core build / package assets | supported (local) | offline lockfile installation into a new temporary directory, typecheck/build and 116/116 tests; final tarball contains 10 templates and passes 19 research/paper tests; Node.js minimum version is not separately verified |
| Core settings | supported | direct read → validate → revision-checked patch → conflict tests |
| Web package/API | supported | 13/13 local tests: loopback, exact Host/Origin, JSON MIME, CSRF, allowlist, malformed JSON/body shapes and path projection |
| Web SlotCore factory | supported | public `SlotCore` factory loads/registers/unloads; temporary Cordis host also verifies `webServer` injection and API disposal; real DSH Loader/profile remains a release gate |
| DSH alpha.1 client graph metadata | limited | `dsh.client` web/external/inject metadata is validated against the package peer contract; the published CLI exposes backend `dsh.bundle` loading, not a public browser-graph Loader, so full native client graph loading is not claimed |
| Browser UI | supported | temporary React/Chromium render, budget save/reload, empty numeric value reset, validation field paths, role save conflict/reload and project deselection |
| Minimal workflow | supported (targeted) | plan → worker → local evidence → supervisor, risk/evidence gates, explicit deep-dive opt-in, bounded cycles and checkpoint recovery; targeted integration suite is 9/9, including missing result-event recovery without rerunning the worker; real-model/runtime acceptance remains separate |
| Runtime hard token enforcement | limited | request hooks and the usage ledger are implemented; this batch has no native end-to-end model call, so immutable request attribution and enforced hard cut-off remain acceptance work |
| CPA configuration adapter / installer | supported (local contract) | optional adapter, safe installer and shared `nativeConfig` mapping are covered by 13 tests, including installation-state ownership/path binding and Windows path casing; no secret or model network call is made |
| CPA real endpoint model request | pending | CLI Proxy/CPA credentials and a user-selected endpoint have not been exercised in this verification |
| Claude adapter | pending | provider capability and protocol acceptance not implemented |
| Semantic auto-escalation | pending | role tier selection is usable; `escalateTo`/`escalateOn` runtime signals are not wired |
| Hidden retry enforcement | pending | policy intent exists; native request-level acceptance remains outstanding |
| PDF/LaTeX reader | TODO | see `TODO.md`; no implicit compilation or arbitrary path/command support |

The matrix intentionally distinguishes a passing local contract test from a
production DSH Loader/profile deployment. The package is optional and does not
modify a user's profile merely by being installed.

Final local commands, review fixes and counts are recorded in
[2026-09-09 verification](2026-09-09-verification.md).
