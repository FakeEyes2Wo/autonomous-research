# SoL-Pi Harness Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, opt-in harness efficiency mechanisms inspired by SoL-Pi while preserving the project's scientific context and evidence invariants.

**Architecture:** Keep DSH history immutable. Add pure `src/harness` helpers for action fusion, UTF-8 aware prompt budgeting, observation packing/reading, and verified receipts. Expose only filesystem-safe, explicitly enabled tool paths; large query outputs are archived before handles are returned, and any archive failure falls back to the original result.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, SHA-256, existing `ResearchTree`, existing `policy/context.ts` token estimator, Node test runner.

## Global Constraints

- Preserve required role prompt sections and existing protocol/source/counter-evidence/conflict closure records.
- Do not rewrite DSH history or claim provider replay rewriting; efficiency evidence is deterministic fixture evidence only.
- Observation packing is opt-in and applies to large read-only query results; small results remain unchanged.
- Receipts are deterministic and contain exact quotes, source hash, byte size, and verified status; no model-generated summaries.
- Keep the total English quote from SoL-Pi to six words: “eliminating an intermediate model round trip.”

---

### Task 1: Harness primitives

**Files:**
- Create: `packages/autoresearch/src/harness/action-fusion.ts`
- Create: `packages/autoresearch/src/harness/observation-pack.ts`
- Create: `packages/autoresearch/src/harness/verified-receipt.ts`
- Create: `packages/autoresearch/src/harness/context-budget.ts`
- Create: `packages/autoresearch/test/unit/harness-efficiency.test.ts`

**Interfaces:**
- `fuseActionFinish(input)` validates action status/summary/evidence before returning one deterministic action plus evidence write plan.
- `packObservation(text, options)` returns unchanged small output or an archive handle plus UTF-8-safe excerpt; `readObservation(handle, page)` validates the handle and returns exact byte/page content.
- `createVerifiedReceipt(source)` hashes and verifies exact archived bytes and returns receipt metadata.
- `estimateContextTokens(text)` delegates to the project's Unicode-aware estimator; `compactContextSections(sections, budget)` removes only declared redundant optional sections.

- [ ] Write failing tests for legacy compatibility, atomic validation, archive failure fallback, UTF-8 pagination, path traversal rejection, exact receipt quotes/hash/bytes/status, and token estimates.
- [ ] Run the focused test and observe expected missing-module failures.
- [ ] Implement the minimal pure helpers and archive abstraction.
- [ ] Run the focused test again and refactor only after green.

### Task 2: Tool integration and action fusion

**Files:**
- Modify: `packages/autoresearch/src/tools/index.ts`
- Modify: `packages/autoresearch/src/index.ts`
- Create: `packages/autoresearch/src/tools/observation-tools.ts`
- Create/modify: `packages/autoresearch/test/unit/tools.test.ts` as needed

**Interfaces:**
- Extend `research_action_finish` with optional `evidence` entries; validate all entries before exactly one tree save, preserving old calls.
- Register opt-in `research_observation_read` and `research_verified_receipt` tools with schemas and JSON renderers.
- Reject handles outside the configured run directory and never pass user paths to unrestricted reads.

- [ ] Add failing integration tests for one-save fusion, failed validation with no writes, tool registration, and safe exact reads.
- [ ] Implement integration and exports.
- [ ] Run focused tool tests.

### Task 3: Provider context assembly

**Files:**
- Modify: `packages/autoresearch/src/providers/subagent-provider.ts`
- Create/modify: `packages/autoresearch/test/unit/subagent-provider.test.ts`

**Interfaces:**
- Use `policy/context.ts` `estimateTokens` for prompt and feedback budgets, including non-ASCII input.
- Compact only optional duplicate fields at the role boundary; preserve required bound prompt sections and research-context rendered records.

- [ ] Add a failing test showing Unicode budget correctness and retention of required scientific sections/negative evidence.
- [ ] Implement bounded compaction and corrected estimates without changing DSH APIs/history.
- [ ] Run provider-focused tests.

### Task 4: Documentation and validation

**Files:**
- Create: `packages/autoresearch/docs/sol-pi-harness-efficiency.md`

- [ ] Document the four mechanisms, explicit opt-in/fallback behavior, exact receipt guarantees, and deterministic fixture measurement limits.
- [ ] Cite SoL-Pi §2.4–2.5 with Chinese paraphrase and the single permitted six-word quote.
- [ ] Run `npm run build` and focused Node tests; report results without claiming real API savings.
