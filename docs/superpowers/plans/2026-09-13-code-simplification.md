# Code Simplification Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent tasks. The user requires subagents to author source and tests; the parent coordinates, reviews, verifies and writes prose. Preserve other workers' edits.

**Goal:** Reduce duplicated implementation and unnecessary indirection in the current main checkout while preserving public interfaces and observable behavior.

**Architecture:** Reuse small private helpers or existing contracts where concrete repetition already exists. Keep research, configuration and presentation responsibilities in their existing packages. Do not introduce a general workflow framework or cross-package utility dependency.

**Tech Stack:** Existing TypeScript/JavaScript packages, Node test runners and package build scripts. No new dependencies or service requirements.

## Global constraints

- Preserve the completed directory reorganization, user changes and existing deletions; do not stage, commit, reset or merge unrelated work.
- Work against the current main checkout. The evidence-driven research branch at `.worktrees/evidence-driven-research` remains separate and unchanged.
- Preserve exported APIs, persisted formats, precedence/default rules, errors, resume behavior, budgets, human decisions, cancellation and security boundaries.
- Measure production-source additions and deletions separately from tests and documentation. Fewer physical lines alone do not prove simpler behavior.
- Do not remove tests, guardrails, compatibility interfaces or comments just to reduce counts. New abstractions need concrete repeated callers.
- A pure refactor must preserve characterization tests; add tests only where a real behavior boundary is otherwise unprotected.
- Workers own disjoint files, document their exact implementation and test commands in task briefs, and hand off stable source for independent review.

## Baseline

Parent ran the current packages before edits: core 155/155 tests, Web 60/60, CPA 13/13; all passed. Logs are in `.runs/simplification/`. Current source files had no preexisting modifications; earlier directory and README edits remain outside this refactor.

## Task boundaries and acceptance

### Research workflow internals

Owner: `simplify_core`. Exact brief: `2026-09-13-simplify-core.md`.

- [x] Consolidate repeated standalone experiment terminal persistence without changing pause/failure/report distinctions.
- [x] Reuse PaperInsight field normalization while preserving survey/frontier defaults and metadata.
- [x] Reuse writer/polisher TeX section persistence while preserving phase-specific artifacts.
- [x] Build, run focused workflow tests and report net production changes.
- [x] Independently review behavior and abstraction cost.

### Configuration and role boundaries

Owner: `simplify_boundary`. Exact brief: `2026-09-13-simplify-boundary.md`.

- [x] Share the native one-shot/JSON-repair attempt lifecycle inside `providers/subagent-provider.ts`, preserving repair filters, labels, budgeting and cleanup order.
- [x] Share settings document commit mechanics inside `settings/service.ts`; retain lock scope and strict validation, and remove duplicate exports from `settings/index.ts`.
- [x] Remove identity/forwarding helpers from `tools/index.ts`, reuse settlement accounting in `policy/request-ledger.ts`, and consolidate duplicate imports in `core/research-tree.ts`.
- [x] Verify provider, settings, ledger and tool behavior and independently review the diff.

### Web and optional CPA

Owner: `simplify_web_cpa`. Exact brief: `2026-09-13-simplify-web-cpa.md`.

- [x] Consolidate repeated project/document guards in `packages/autoresearch-web/src/workbench.js`, preserving canonical paths, allowlists, opaque IDs and exact HTTP errors.
- [x] Use one route-option key list in `packages/dsh-cpa/src/config.mjs`, preserving omission and false/zero values.
- [x] Share install/doctor CLI configuration handling only if the small helper reduces both duplication and reading cost; retain uninstall's no-config behavior and argument/error ordering.
- [x] Verify Web/CPA behavior with local fixtures and independently review the diff. Do not probe real credentials or providers.

## Final verification

- [x] Review each source diff independently and resolve substantive findings through its implementation worker.
- [x] Run fresh full core, Web and CPA suites plus applicable package build/type checks after stable edits.
- [x] Record actual source delta and tests in a concise verification document, explaining any intentionally retained complexity.
- [x] Confirm no changes to the separate evidence-driven worktree and no accidental staging of the directory reorganization.

Final acceptance: `docs/verification/2026-09-13-code-simplification.md`. All three review scopes approved after preserving repair accounting IDs and restoring writer side-effect ordering. Parent final tests: core 157, Web 60, CPA 13; strict unused TypeScript checks passed. Normalized production-source change: -4,237 UTF-8 bytes and -18 lines across 20 changed files, including the new CLI helper. Source changes remain unstaged in the current checkout.
