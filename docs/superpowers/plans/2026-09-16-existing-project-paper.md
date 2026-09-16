# Existing-project paper workflow implementation plan

> Use subagent-driven-development with scoped ownership and task reviews. Implementation explicitly authorized by user; this is an addition to the active RAG/runtime plan.

**Goal:** main agent dispatches existing-project discovery and paper generation from its initial task handling.
**Architecture:** add an opt-in service/tool entrypoint; reuse frozen policy, request ledger, scientific admission and paper pipeline. See ../specs/2026-09-16-existing-project-paper-design.md.
**Tech Stack:** current TypeScript/Node, existing DSH subagent provider, local immutable ResearchStore sources.

## E1: Project discovery and init dispatch

Read `.superpowers/sdd/2026-09-16-rag-research-roadmap/existing-project-discovery.md` for exact entrypoint analysis. Create `src/project/{inventory,discovery,contracts}.ts`, `src/service/project-paper.ts` as needed; add project-explorer role and prompt; modify `src/service/autoresearch-service.ts`, `src/tools/index.ts`, `src/index.ts`, path binding and `presets/auto_research/agent.cordis.yml`. Provider change narrowly enforces tool-free project-explorer; coordinate that file before editing. Avoid edits to service/research-cycle.ts and service/steps/idea.ts (B2) and literature modules (A5/B1).

- [ ] Write failing bounded inventory/path/secret exclusion tests using real temporary files.
- [ ] Implement bounded sorted inventory with byte/hash SourceRefs, coverage omissions, no source writes/no execution.
- [ ] Write fake-provider discovery tests rejecting invented source IDs and preserving historical-unverified labels.
- [ ] Run synthesis through normal provider/ledger after run bootstrap; persist discovery/candidate source manifest and checkpoint; no raw host subagent calls.
- [ ] Add project_paper_run tool with projectDir/runDir/maxCycles/paper options consistent with existing contracts; relative paths bind to main-agent workspace.
- [ ] Reuse normal ResearchRunner with brainstorm off for the selected candidate, explicitly honor user request to enter paper after evidence gate. No bypass of evidence/compile/audit requirements.
- [ ] Persist canonical project identity and workflow origin; resume validates and reuses it even when only runDir is supplied. Old runs remain compatible.
- [ ] Update init persona to distinguish existing-project paper, new research, standalone experiment and resume on first task turn. No side effects on plugin registration or GET.
- [ ] Build/typecheck and focused service/provider/tool/path/paper compatibility tests. Record exact outputs and report; parent commits/reviews.

## E2: RAG and runtime integration

Depends on E1 + A5/B1/B4. Add project discoveries to source-grounded candidate and literature context with correct project/role policy. Supplementary verification uses durable jobs if a compatible executor/protocol exists. Unsupported scientific validators remain unknown/exploratory. Test generated source IDs flow through retrieval/context and evidence gate without promotion by prose.

## E3: Real-provider functional validation

Paid model calls now authorized; use existing configured provider/model with small explicit token/role-call caps. Use an isolated, non-secret synthetic project and record exact code/config fingerprints, model routes, receipts and generated artifacts. Verify init main-agent tool routing and/or service workflow dispatch distinctly, source-linked discovery, hypothesis/paper handoff, resume and budget. No benchmark scores or statistical quality claims. Existing `run-headless.mjs` can modify global profile/permission settings; do not use those setup side effects as part of smoke validation. Prefer existing headless profile plus workspace-local overlay or direct configured adapter with owned-session accounting. Connectivity already returned READY via existing DSH profile; this is connectivity only, not end-to-end success.
