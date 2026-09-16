# Simplify Web and CPA Implementation Plan

> **For agentic workers:** This brief is executed in the current main checkout. Preserve existing dirty directory reorganization and all unrelated work.

**Goal:** Remove concrete duplication in the web workbench request guards and CPA route/CLI option handling while preserving every public response, validation boundary, default, and side effect.

**Architecture:** Keep the workbench's existing `validProject` and `documentFor` security checks, and add local throwing wrappers that centralize the repeated route guard plus its current `problem` code/message. Keep CPA route option names in one private list used by both normalization directions. Share the two CLI scripts' tiny argument/config loading primitives only when doing so reduces code and remains readable; otherwise document the decision.

**Tech Stack:** Existing JavaScript/ES modules, Node.js `node:test`, `yaml`, and package build scripts. No new dependencies, framework, public API, or service access.

## Global Constraints

- Modify only `packages/autoresearch-web/src/workbench.js`, `packages/dsh-cpa/scripts/install.mjs`, `packages/dsh-cpa/scripts/doctor.mjs`, `packages/dsh-cpa/src/config.mjs`, and this plan plus the verification document; add tests only for a real uncovered behavior boundary.
- Preserve canonical project roots, project allowlists, opaque document IDs, root binding, authentication/security checks, exact HTTP status/code/message/details mapping, and route ordering.
- Preserve CPA omitted-field semantics, including `false`, `0`, and empty/undefined distinctions; preserve native conversion and config validation boundaries.
- `install --uninstall` must not read a config file. Preserve default config, missing-argument behavior, parse/error ordering, dry-run/apply output, and doctor's no-network default.
- Do not remove tests/guardrails, add dependencies, access real credentials/providers, or stage/commit/reset/merge any changes.

## Task 1: Characterize and simplify workbench guards

**Files:**
- Modify: `packages/autoresearch-web/src/workbench.js:164-237,546-591`
- Test: existing `packages/autoresearch-web/test/workbench.test.mjs` and `packages/autoresearch-web/test/api.test.mjs`; add no test unless a real guard boundary is uncovered

**Interfaces:**
- Add private `projectOrThrow(id)` and `documentOrThrow(project, id)` wrappers around the existing async validators.
- Keep route-specific error behavior by allowing the document wrapper to retain `document_not_found` and the project wrapper to retain `project_not_allowed` with their current status and messages.

- [ ] Run the existing workbench/API baseline before edits.
- [ ] Replace the eight repeated project checks and four repeated document checks with local wrappers while retaining endpoint-specific body/content-type checks and build checks.
- [ ] Run focused workbench/API tests and inspect security/error response fields.

## Task 2: Share CPA route option keys

**Files:**
- Modify: `packages/dsh-cpa/src/config.mjs:30,179,199`
- Test: existing `packages/dsh-cpa/test/cpa.test.mjs`; add a test only if existing coverage does not protect false/zero/omitted route fields

**Interfaces:**
- Define one private `ROUTE_OPTION_KEYS` list (or equivalent immutable local collection) and use it for both normalized route creation and `routeToDshProfile` copying.
- Retain the existing `ROUTE_KEYS` validation set and every `!== undefined` guard so values such as `false` and `0` are copied exactly.

- [ ] Run the CPA baseline.
- [ ] Replace only the duplicated option-key literals with the shared local collection.
- [ ] Run CPA tests and compare representative compiled provider objects.

## Task 3: Audit the install/doctor CLI overlap

**Files:**
- Inspect and, only if net simpler: modify `packages/dsh-cpa/scripts/install.mjs` and `packages/dsh-cpa/scripts/doctor.mjs`
- Test: controlled temporary config/home smoke commands, with existing `packages/dsh-cpa/test/cpa.test.mjs` as characterization coverage

**Interfaces:**
- Candidate shared helpers are limited to `argv`, `has`, `valueAfter`, and `loadConfig` behavior; do not add a general CLI framework or new module if module boundaries/argument differences cost more than the duplicated lines.

- [ ] Compare the duplicated helpers and their script-specific ordering.
- [ ] If sharing is clearer and reduces production code, implement the smallest private helper while keeping uninstall before config loading.
- [ ] Otherwise leave both scripts unchanged and record why in verification.
- [ ] Smoke test default, `--config`, malformed/missing config, uninstall without config, and doctor without `--network` using controlled temporary paths only.

## Task 4: Verify and report

**Files:**
- Create: `docs/verification/2026-09-13-simplify-web-cpa.md`

- [ ] Record production-only before/after line and byte counts and the actual diff.
- [ ] Run fresh focused tests, each package's full test suite, and each package's build/typecheck command in scope.
- [ ] Document preserved invariants, CLI audit decision, exact commands/results, and any remaining intentional duplication.
