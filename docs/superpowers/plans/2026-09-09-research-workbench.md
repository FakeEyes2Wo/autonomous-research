# Research workbench and simple settings implementation plan

> For agentic workers: use subagent-driven-development and bounded parallel tasks. Preserve the shared workspace's existing changes; no unsolicited commits or worktree migration of this ongoing task.

**Goal:** Simplify AutoResearch settings, implement a project-backed LaTeX/PDF workbench with a return to native DSH, and document CLIProxyAPI subscription login.

**Architecture:** Keep the native DSH settings slot and existing settings validation/revision API. Add a same-origin `/autoresearch/` page linked from settings, backed by `/api/autoresearch/workbench/*` APIs. Source files live in the allowlisted project; builds are explicit and isolated; PDF rendering assets ship with the package.

**Tech stack:** Existing Node ESM host and React DSH factory, browser JavaScript, local PDF.js, Tectonic discovered from PATH or explicit host configuration.

## Global constraints

- User design: left LaTeX editor, right PDF preview, return to native DSH tools.
- User portability: no user-specific paths, OS-specific shell commands, CDN runtime dependency, or project secrets in configuration. Allowlisted roots may be relative to the DSH launch directory. Detect compiler availability and preserve editing without it.
- Default common settings: model source (inherit native DSH by default), research intensity, paper output. Preserve existing advanced settings and show custom values honestly.
- Manual save/build; revision conflicts preserve unsaved text; viewing PDFs never starts compilation.
- Only allowlisted projects and opaque document/build IDs; reject traversal and symlink escape; writes require existing same-origin/CSRF checks; no browser-supplied commands.
- PDF responses check magic bytes and bounded size/range. UI displays source revision and whether preview is older.
- New papers use `paper/main.tex` (or a unique sibling when occupied). Read requests do not create files. Existing project papers can be selected.
- Native settings retain `inject: ['locale', 'slots']` and unique `autoresearch` locale namespace.

## Task 1: Workbench host and tests (backend worker)

Files: `src/workbench.js`, `src/index.js`, `src/index.d.ts`, `test/workbench.test.mjs`, isolated import fixture in `test/api.test.mjs` under `packages/autoresearch-web`.

- [x] Add failing behavioral tests for document discovery/create/save, conflicts, compile state, PDF reads and access boundaries.
- [x] Implement `createWorkbench(config)` handler integrated after common access checks and before settings-service availability checks.
- [x] API contract: GET `/workbench/documents?projectId` -> `{documents:[{id,name}],engine:{available,name}}`; POST same with `{projectId}` creates paper and returns document; GET `/workbench/document?projectId&documentId` -> `{id,name,source,revision,pdf?}`; PUT same with `{projectId,documentId,expectedRevision,source}` -> document. POST `/workbench/build` with project/document/revision -> `{id,status,sourceRevision,...}`; GET `/workbench/build?projectId&buildId` polls `{id,status,sourceRevision,diagnostics,pdf?}`; PDF `{version,url}` references GET `/workbench/pdf?projectId&documentId&version`.
- [x] Compile with fixed argv, no shell, untrusted Tectonic, bounded timeout/output/concurrency; missing compiler is controlled. Resolve PATH or `config.workbench.compiler` host setting, never hardcoded drive paths.
- [x] Run host tests and report changed contract details before frontend integration.

## Task 2: Simple settings (settings worker)

Files: `src/client.js`, `test/browser-render.test.mjs`, `test/factory.test.mjs` under Web package.

- [x] Refactor default screen to 3 simple controls, advanced details collapsed; retain existing revision/validation/conflict logic.
- [x] Add prominent `打开科研工作台` link to `/autoresearch/?projectId=<opaque id>` and native model settings guidance.
- [x] Show short human status instead of full hash; readable Chinese copy; no horizontal overflow. Preserve advanced overrides and unsaved navigation guard.
- [x] Update browser regression assertions for the new UI, preserve actual save/conflict coverage; portable browser discovery via env/PATH/platform defaults.

## Task 3: Workbench UI and portable package (root)

Files: `src/workbench.html`, `src/workbench-client.js`, `src/workbench.css`, `src/workbench-assets.js`, build script/package metadata, workbench browser test.

- [x] Build split editor/preview, project/paper selection, create/save/build actions, status/logs, PDF page/zoom controls and download link.
- [x] Serve local PDF.js assets and page through exact allowed resource map; no CDN/fonts dependency.
- [x] Return link uses native same-origin `/`, works independent of localhost port. Warn before navigation losing edits.
- [x] Exercise real save/compile/PDF rendering with a temporary project and installed Tectonic; test missing compiler and narrow viewport.

## Task 4: Review, deployment and guide

- [x] Verify official CLIProxyAPI Codex OAuth and OpenAI subscription/API distinction; write Windows steps plus portable notes without accessing credentials or invoking a model.
- [x] Review independent tasks, run meaningful package tests/build/browser tests and package dry-run.
- [x] Rebuild local linked package; restart only our verified DSH process and inspect real native settings/workbench navigation.
- [x] Update docs with actual results and portability limits; no claims of cross-OS testing unless performed.
