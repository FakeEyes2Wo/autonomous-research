# Simplify Boundary Brief

Parent plan: `2026-09-13-code-simplification.md`. This worker owns only the assigned production files: provider, settings service/index, tools index, request ledger, and research tree (plus focused tests only if a real boundary is unprotected). Existing dirty directory reorganization and other workers' files remain untouched.

## Exact steps

1. In `providers/subagent-provider.ts`, extract the repeated native start, request binding, ownership registration, result wait, text extraction, budget-error propagation, and disposal sequence into a private helper. Keep one-shot and JSON-repair differences explicit in options: repair kind, tool filter, label, prompt/schema, and logger behavior. Preserve release-before-dispose ordering and propagate budget failures before normal stop handling.
2. In `settings/service.ts`, retain each operation's lock and candidate construction, then share a private commit helper for v2 validation, YAML serialization, external revision check, atomic write, and document assembly. Preserve save/patch error paths and strict validation behavior. Remove duplicate exports from `settings/index.ts`.
3. In `tools/index.ts`, remove the identity `defineTool` wrapper and private `loadTree` forwarding helper. Keep `ToolDefinitionLike` as the contextual type constraint and call `ResearchTree.load` at its existing call sites.
4. In `policy/request-ledger.ts`, make `settleRequest` call `settleEntry` after the existing idempotency and lookup checks, preserving charged/reserved/totals updates and unknown/known usage semantics.
5. In `core/research-tree.ts`, merge duplicate imports without changing symbols or runtime behavior.
6. Run focused provider/settings/ledger/tools/research-tree tests and package type/build checks. Record production-only actual before/after/diff counts and fresh test output in `docs/verification/2026-09-13-simplify-boundary.md`.

## Invariants

- Public exports, persisted formats, settings revision and lock semantics, strict migration/validation boundaries, request accounting, provider ownership release/dispose ordering, budget error precedence, tool schemas, and research-tree behavior remain unchanged.
- Do not alter token estimation (including CJK behavior), merge strict validation with permissive migration, or merge loaders with different error boundaries.
- No dependencies, frameworks, APIs, tests removed, or unrelated files modified.
