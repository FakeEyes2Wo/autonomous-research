# Current Idea Similarity Survey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a receipt-backed, durable, multi-provider similarity survey for the current research idea and expose its neutral overlap context to planning and idea-review roles.

**Architecture:** Build a pure discovery engine under `literature/discovery` with injected HTTP, clock, sleep, object-store, query-planner, and semantic-reviewer dependencies. The engine persists a broad deduplicated pool and compact report under the run directory, then the service runner invokes it whenever the semantic current idea changes before a planner freeze. `research-context` exposes only hash-verified candidate artifacts to approved ideation roles; a separate discovery exposure receipt records the final model dispatch without creating literature-span sources or changing scientific evidence and worker allowlists.

**Tech Stack:** TypeScript ESM, Node `fetch`/`AbortSignal`, existing `ResearchStore`, `ContextRecord` sealing/selection, project YAML settings migration, Node test runner, and the existing `RoleAgentProvider`.

## Global Constraints

- Default discovery uses `workflow.currentIdeaSearch: enabled`, with 3–5 rounds, 4 queries per round, engine `maxRequests: 80`, a 200-candidate retained pool after fusion, 20 nearest candidates, and engine `maxDurationMs: 600000`.
- Every accepted candidate must trace to a real provider HTTP receipt and stored response bytes; model output cannot invent paper IDs, metadata, excerpts, or receipts.
- arXiv, Crossref, and Semantic Scholar are the initial public providers. Semantic Scholar uses its relevance endpoint only; a 429 defers that provider while arXiv/Crossref proceed. Provider throttling, unavailable sources, invalid responses, and partial rounds remain explicit coverage gaps.
- Search request/candidate/time budgets are distinct from final context-token budget. All network, sleep, model, and clock dependencies are injectable; no test waits on live providers.
- An empty result never proves novelty. Similarity output remains advisory and cannot create `Evidence`, `confirmed_error`, refutation, cleanup, protocol allowlist IDs, or worker literature sources.
- Discovery records are run-scoped layer-3 artifact records with candidate lifecycle and neutral polarity. They are permitted for `planner`, `idea-generator`, `idea-reflexion`, and `hypothesis-reviser`; `research-worker`, `paper-survey`, and `direction-select` are excluded.
- No normal survey path imports abstracts into the literature corpus, publishes an index generation, refreshes a pinned generation, expands a worker allowlist, or adds import UI. Existing explicit library-ingest operations remain unchanged.
- `workflow.currentIdeaSearch: 'never'` is the explicit off switch. `workflow.deepDive: 'never'` suppresses the old deep-dive role but does not silently disable this independent search. `brainstorm: 'never'` still permits discovery of a supplied idea.
- Old frozen run policies that lack `currentIdeaSearch` remain immutable and do not gain paid/network work from a new default; existing runs with no policy snapshot also stay off. Only newly normalized settings or an audited policy update opt in.
- Frozen/running experiment and ordinary paused/waiting resume paths do not insert a survey. An unchanged resume makes zero discovery HTTP or model calls. Production constructs and runs the actual configured engine when discovery dependencies are omitted; only explicit test/offline injection disables network calls.
- Use the public API behavior documented at [arXiv](https://info.arxiv.org/help/api/user-manual.html), [Crossref REST](https://github.com/CrossRef/rest-api-doc), [Crossref rate limits](https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/), and [Semantic Scholar tutorial](https://webflow.semanticscholar.org/product/api/tutorial); keep source comments next to adapters.

---

### Task 1: Receipt-backed discovery engine and semantic comparison

**Files:**

- Create: `packages/autoresearch/src/literature/discovery/contracts.ts`
- Create: `packages/autoresearch/src/literature/discovery/query-planner.ts`
- Create: `packages/autoresearch/src/literature/discovery/providers.ts`
- Create: `packages/autoresearch/src/literature/discovery/checkpoint.ts`
- Create: `packages/autoresearch/src/literature/discovery/coordinator.ts`
- Create: `packages/autoresearch/src/literature/discovery/reviewer.ts`
- Create: `packages/autoresearch/src/literature/discovery/index.ts`
- Modify: `packages/autoresearch/src/literature/index.ts` to export the discovery contracts and coordinator entry point.
- Create: `packages/autoresearch/test/unit/discovery-query-planner.test.ts`
- Create: `packages/autoresearch/test/unit/discovery-providers.test.ts`
- Create: `packages/autoresearch/test/unit/discovery-coordinator.test.ts`
- Create: `packages/autoresearch/test/unit/discovery-reviewer.test.ts`

**Interfaces:**

- `DiscoveryConfig`, `CurrentIdeaIdentity`, `DiscoveryQuery`, `HttpReceipt`, `DiscoveryCandidate`, `SimilarityAssessment`, `SimilaritySurveyReport`, and `DiscoveryProviderName` are defined in `discovery/contracts.ts`; internal `DiscoveryCheckpoint` is defined in `discovery/checkpoint.ts`.
- `fingerprintIdea(idea)` is the canonical semantic target fingerprint. `SimilaritySurveyReport.ideaFingerprint` and `DiscoveryContextBinding.ideaFingerprint` must equal it; execution binding remains separate and never changes this identity. The illustrative signatures below defer to the authoritative engine contracts.
- `planDiscoveryQueries(input: { idea: CurrentIdeaIdentity; round: number; priorQueries: readonly DiscoveryQuery[]; priorCoverage: readonly string[]; callback: QueryPlannerCallback; maxQueries: number }): Promise<DiscoveryQuery[]>` validates nonempty, distinct, facet-diverse model queries and caps the result.
- `DiscoveryProvider.search({ query, page, pageSize, signal, now }): Promise<{ receipt: HttpReceipt; candidates: DiscoveryCandidate[]; hasMore: boolean }>` is the sole provider adapter boundary. Adapters accept an injected `fetch`, `ResearchStore.captureBytes` source sink, `readSource` verifier, and rate state; they return only candidates tied to their receipt. Failed responses still produce durable receipts, while successful candidate metadata must be rehashable from the captured `SourceRef`.
- `runSimilaritySurvey(input: { runDir: string; idea: CurrentIdeaIdentity; config: DiscoveryConfig; providers: readonly DiscoveryProvider[]; queryPlanner: QueryPlannerCallback; reviewer: SimilarityReviewerCallback; sourceStore: DiscoverySourceStore; clock: DiscoveryClock; signal: AbortSignal }): Promise<SimilaritySurveyReport>` resumes a matching checkpoint, persists every attempt, and returns a partial report on bounded degradation.
- `reviewSimilarity(input: { idea: CurrentIdeaIdentity; candidates: readonly DiscoveryCandidate[]; excerpts: readonly CandidateExcerpt[]; callback: SimilarityReviewerCallback; readSource(ref: import('../../research/contracts.js').SourceRef): Promise<Uint8Array> }): Promise<SimilarityAssessment[]>` rejects unknown candidate IDs, out-of-range excerpt offsets, aliases absent from provider receipts, excerpt hashes that do not rehash from a stored source, and unbounded follow-up queries.
- `SimilaritySurveyReport.counts` always includes `collected`, `retained`, `shortlisted`, `reviewed`, and `omitted`; `stopReason` records whether the floor/diversity condition, diminishing returns, a budget/wall/abort boundary, provider unavailability, or no results ended the run.

- [ ] **Step 1: Write failing contract and query-planning tests.**

```ts
test('varied planner covers mechanism, synonym, assumption, and cross-domain facets', async () => {
  const queries = await planDiscoveryQueries({
    idea: fixtureIdea('attenuable delegated authorization'),
    round: 1,
    priorQueries: [],
    priorCoverage: [],
    callback: async () => fixtureQueriesWithParaphrases(),
    maxQueries: 4,
  })
  assert.deepEqual(new Set(queries.flatMap(query => query.dimensions)), new Set([
    'problem', 'mechanism', 'terminology', 'cross-domain',
  ]))
})

test('empty, duplicate, and model-invented query entries are rejected', async () => {
  await assert.rejects(() => planDiscoveryQueries({
    idea: fixtureIdea('idea'), round: 1, priorQueries: [], priorCoverage: [],
    callback: async () => [{ id: 'q1', text: '', dimensions: [], origin: 'model' }],
    maxQueries: 4,
  }), /query/i)
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/discovery-query-planner.test.ts`.

Expected: FAIL because the discovery contracts and planner do not exist.

- [ ] **Step 2: Implement the contracts and bounded query planner.**

Use canonical JSON hashes for separate idea/config fingerprints. Idea identity includes statement, profile, scope, mechanism, prediction, falsification, measurement, decision rule, alternatives, assumptions, terminology, cross-domain analogs and engine version. Configuration identity includes numeric budgets, selected providers, parser version and engine version. Normalize query whitespace/case before duplicate checks. Require at least two distinct dimensions in the first round, carry `origin: 'review-followup'` only for reviewer-suggested queries, and retain rejection reasons. A shortfall against the requested query count records incomplete coverage without a paid planner replay. Never accept a model-provided paper identifier as a provider result.

- [ ] **Step 3: Write failing provider adapter tests with fixture HTTP.**

```ts
test('crossref paginates with query.bibliographic and keeps response receipt', async () => {
  const calls: string[] = []
  const provider = crossrefProvider({
    fetch: async (url) => {
      calls.push(String(url))
      return jsonResponse(crossrefPage({ offset: calls.length - 1, total: 2 }))
    },
    sourceStore: fakeResearchStore(),
    rateState: fakeRateState(),
  })
  const result = await provider.search({ query: fixtureQuery('contextual caveats'), page: 1, pageSize: 2, signal: new AbortController().signal, now: () => 0 })
  assert.equal(result.receipt.outcome, 'ok')
  assert.match(calls[0]!, /query\.bibliographic=/)
  assert.doesNotMatch(calls[0]!, /query\.title=/)
  assert.equal(result.candidates[0]!.providerHits[0]!.receiptId, result.receipt.id)
})

test('rate limited response honors Retry-After and records degradation', async () => {
  const sleeps: number[] = []
  const result = await runProviderWithRetry({ response: http429('2'), sleep: async ms => { sleeps.push(ms) } })
  assert.deepEqual(sleeps, [2000])
  assert.equal(result.receipt.outcome, 'rate_limited')
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/discovery-providers.test.ts`.

Expected: FAIL until the adapters exist.

- [ ] **Step 4: Implement provider adapters and HTTP receipt persistence.**

Implement bounded response readers, URL/query construction, pagination, parser validation, status classification, `ResearchStore.captureBytes` source capture, and `Retry-After` parsing. Use arXiv `start` pagination and documented spacing; use Crossref `query.bibliographic` with bounded offset pagination; use only Semantic Scholar relevance search and defer that provider on 429 while others continue. Capture bounded raw error responses too; a transport failure with no received body may have a null source reference. Parsed observations have separate captured sources and parser provenance. Cap bodies before parsing and make waits/reads abortable.

- [ ] **Step 5: Write failing deduplication, ranking, and budget tests.**

```ts
test('different wording survives union ranking while literal decoys do not fill the shortlist', async () => {
  const report = await runSimilaritySurvey(fixtureRun({
    providers: [providerWithPages(fixtureMacaroons, fixtureLiteralDecoys)],
    queryPlanner: fixtureVariedPlanner(),
    reviewer: fixtureReviewer(),
    config: { ...defaultSimilaritySurveyConfig, minRounds: 3, maxRounds: 3, nearestLimit: 2 },
  }))
  assert.equal(report.nearest.some(candidate => candidate.aliases.some(alias => alias.value === '10.14722/ndss.2014.23212')), true)
  assert.equal(report.counts.collected >= report.counts.shortlisted, true)
  assert.equal(report.nearest.length, 2)
})

test('empty providers produce a partial/no-results report and no novelty claim', async () => {
  const report = await runSimilaritySurvey(fixtureRun({ providers: [unavailableProvider()] }))
  assert.ok(['partial', 'no_results'].includes(report.status))
  assert.match(report.gaps.join('\n'), /unavailable|coverage/i)
  assert.equal('novel' in report, false)
})

test('request, candidate, and wall budgets are independent and cumulative on resume', async () => {
  const firstRun = fixtureRun({ abortAfterAttempts: 5 })
  const first = await runSimilaritySurvey(firstRun)
  const firstHttpCalls = firstRun.httpCalls
  const firstModelCalls = firstRun.modelCalls
  const resumedRun = fixtureRun({ checkpoint: first, abortAfterAttempts: 10 })
  const resumed = await runSimilaritySurvey(resumedRun)
  assert.equal(resumed.receipts.length <= 10, true)
  assert.equal(resumed.receipts.filter(receipt => receipt.outcome === 'ok').length >= first.receipts.filter(receipt => receipt.outcome === 'ok').length, true)
  assert.equal(resumed.queries.filter(query => query.id === first.queries[0]?.id).length, 1)
  assert.equal(resumedRun.httpCalls, firstHttpCalls + (resumed.receipts.length - first.receipts.length))
  assert.equal(resumedRun.modelCalls, firstModelCalls + 1)
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/discovery-coordinator.test.ts`.

Expected: FAIL until coordinator state, ranking, source verification, and stop logic are implemented.

- [ ] **Step 6: Implement checkpointed coordination, reciprocal-rank fusion, and honest stopping.**

Persist `checkpoint.json`, `receipts/*.json`, model receipts, `report.json`, and the broad `pool.json` under `runDir/brainstorm/current-idea-survey/<ideaFingerprint>/<configFingerprint>/`. Reuse only receipts whose captured sources rehash correctly. Maintain cumulative attempts/time with original dispatch timestamps and incremental crash accounting; execution binding stays separate. Known durable outcomes recover without repeat calls; unknown HTTP outcomes are recorded without blind replay, and unknown model outcomes pause. Schedule providers with per-provider spacing, bounded 429/5xx retries and explicit gaps. Complete minimum rounds unless a hard boundary intervenes; only then may documented low yield plus diversity stop early. RRF plus facet/provider exploration proposes candidates without literal-overlap or recency filters. Preserve valid content-bound semantic judgments across rounds, use them before retention/nearest limits, and re-review materially changed/conflicting observations. More raw hits alone must not erase a known nearest match or cause repeated semantic review. The 200-candidate retention cap never stops retrieval.

- [ ] **Step 7: Write failing semantic-review and forged-receipt tests, then implement reviewer validation.**

The reviewer fixture must compare the four paraphrased anchor abstracts (Macaroons DOI `10.14722/ndss.2014.23212`, CaMeL `arXiv:2503.18813`, RAG `arXiv:2005.11401`, and REST `arXiv:2311.08252`) without copying long source text. Assert that a reviewer cannot add a candidate ID, alias, excerpt, or citation seed absent from the receipt-backed input, that every returned excerpt proof rehashes from its captured `SourceRef`, and that follow-up queries are re-entered through the bounded coordinator rather than executed directly by the model.

Persist assessment hashes, `collected/shortlisted/reviewed` counts, provider coverage, uncertainty, and gap notes in the report. A reviewer result can be partial or uncertain; it cannot set a novelty, refutation, or scientific-support field.

- [ ] **Step 8: Run the focused engine suite and review the artifact contract.**

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/discovery-query-planner.test.ts test/unit/discovery-providers.test.ts test/unit/discovery-coordinator.test.ts test/unit/discovery-reviewer.test.ts`; then `npm run typecheck`.

Expected: all discovery unit tests pass and TypeScript accepts the exported contracts. Inspect a fixture report to confirm raw receipt IDs, aliases, rehashable source references, pool/nearest separation, cumulative budgets, and explicit provider degradation.

### Task 2: Current-idea lifecycle, context provenance, settings, and exposure

**Files:**

- Create: `packages/autoresearch/src/literature/discovery/context.ts`
- Create: `packages/autoresearch/src/research/current-idea.ts`
- Modify: `packages/autoresearch/src/experiment/steps.ts` at the `runPlanner` and `runMinimalPlan` seams, plus `packages/autoresearch/src/service/types.ts`, `packages/autoresearch/src/service/research-context.ts`, `packages/autoresearch/src/research-context/types.ts`, `packages/autoresearch/src/providers/subagent-provider.ts`, and `packages/autoresearch/src/agents/types.ts`. Preserve the existing service-runner deep-dive path; no runner refactor is needed for this feature.
- Modify: `packages/autoresearch/src/settings/schema.ts`, `settings/migration.ts`, and settings validation tests to add `workflow.currentIdeaSearch` and `budget.currentIdeaSearch` defaults and bounds.
- Modify: `packages/autoresearch/src/agents/roles/index.ts`, `agents/roles/brainstorm.ts`, and role prompt registration for `idea-query-planner` and `idea-similarity-reviewer`.
- Create: `packages/autoresearch/test/unit/discovery-context.test.ts`
- Create: `packages/autoresearch/test/unit/current-idea.test.ts`
- Modify: `packages/autoresearch/test/unit/brainstorm-max-papers.test.ts`, `packages/autoresearch/test/unit/auto-mode.test.ts`, `packages/autoresearch/test/integration/planner-literature-freeze.test.ts`, and relevant settings tests.
- Create: `packages/autoresearch/test/integration/current-idea-survey-loop.test.ts`
- Modify: `packages/autoresearch/test/integration/minimal-loop.test.ts`, `existing-project-research-e2e.test.ts`, and `research-compatibility.test.ts` only for explicit offline discovery injection and lifecycle assertions.

**Interfaces:**

- `selectCurrentIdea({ intakeIdea, profile, snapshot }): CurrentIdeaIdentity` chooses active hypothesis fields and the current decision candidate, falling back to intake idea/profile before the first snapshot. `fingerprintIdea` includes the full scientific target fields listed in Task 1. Search policy and parser identity belong to `configFingerprint`; run/cycle/source references remain execution provenance.
- `effectiveCurrentIdeaSearch(settings, policySnapshot?): 'enabled' | 'never'` applies the new-run default and the immutable historical-policy rule without using a missing field from an old frozen snapshot as an opt-in.
- `DiscoveryContextBinding { surveyId, ideaFingerprint, reportHash, selectedRecordIds, sourceRefs, exposurePath }` is attached to `ResearchContextRequest.discovery`; it is separate from `ResearchContextRequest.literature`. The adapter must attach it only when `ideaFingerprint` matches the current target; a stale report is omitted rather than relabeled.
- `buildDiscoveryContext({ runDir, report, scope, role, maxContextChars }): Promise<{ records: ContextRecord[]; binding: DiscoveryContextBinding }>` captures and rehashes raw receipts, parsed excerpts, and reviewer report before sealing neutral artifact records. It returns no `RegisteredLiteratureSource` values.
- `prepareDiscoveryExposure({ runDir, binding, context, prompt, role }): Promise<DiscoveryExposureReceipt>` verifies report/source hashes, selected artifact IDs, and rendered prompt inclusion. `finishDiscoveryExposure(receipt, 'sent' | 'unknown')` appends the terminal outcome. The provider must not place this receipt in `RoleOutput.literatureSources`.
- `ensureCurrentIdeaSurvey(ctx, idea): Promise<SimilaritySurveyReport | undefined>` reuses a matching durable survey and runs a new one only for a changed fingerprint. It is called before the first planner and before a planner after a changed revision.

- [ ] **Step 1: Write failing settings and current-idea selection tests.**

```ts
test('migrated defaults enable discovery while explicit deep-dive never suppresses it', () => {
  const settings = migrateProjectSettings({ version: 2 })
  assert.equal(settings.workflow.currentIdeaSearch, 'enabled')
  assert.equal(effectiveCurrentIdeaSearch(settings), 'enabled')
  assert.equal(effectiveCurrentIdeaSearch({ ...settings, workflow: { ...settings.workflow, currentIdeaSearch: 'never' } }), 'never')
})

test('current revision fingerprint changes while an unchanged resume makes no HTTP or model calls', async () => {
  const before = selectCurrentIdea(fixtureIdeaState('delegated bearer restrictions'))
  const after = selectCurrentIdea(fixtureIdeaState('contextual caveat attenuation'))
  assert.notEqual(fingerprintIdea(before), fingerprintIdea(after))
  const first = await runFixture({ idea: before, discovery: offlineDiscovery() })
  const resumed = await resumeFixture(first, { idea: before, discovery: offlineDiscovery() })
  assert.equal(resumed.discoveryCalls.http, 0)
  assert.equal(resumed.discoveryCalls.model, 0)
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/current-idea.test.ts test/unit/auto-mode.test.ts test/integration/planner-literature-freeze.test.ts`.

Expected: FAIL until settings migration and current-idea identity exist.

- [ ] **Step 2: Implement settings migration and current-idea identity.**

Add `workflow.currentIdeaSearch` and `budget.currentIdeaSearch` exactly as specified in the design, validate integer ranges and `minRounds <= maxRounds`, and preserve existing settings revision/unknown-field behavior. Newly normalized settings default to enabled; historical frozen policy snapshots with no field stay off until an audited update; existing runs with no policy snapshot also stay off. Implement deterministic extraction of the selected/current hypothesis, revision text, mechanism, assumptions, terminology, and cross-domain analogs. Keep the query cache key independent of the current idea fingerprint so an idea change invalidates comparison but may reuse verified query receipts; keep execution binding separate from semantic target identity.

- [ ] **Step 3: Write failing context provenance and exposure tests.**

```ts
test('discovery context rehashes captured sources and excludes workers', async () => {
  const built = await buildDiscoveryContext(fixtureDiscoveryContext())
  assert.equal(built.records.every(record => record.kind === 'artifact' && record.lifecycle === 'candidate'), true)
  assert.deepEqual(built.records[0]!.accessRoles, ['hypothesis-reviser', 'idea-generator', 'idea-reflexion', 'planner'])
  assert.equal(built.records.some(record => record.accessRoles?.includes('research-worker')), false)
  await assert.rejects(() => buildDiscoveryContext(fixtureDiscoveryContext({ mutateCapturedExcerpt: true })), /hash|source|provenance/i)
})

test('discovery exposure records unknown on transport failure without literature sources', async () => {
  const output = await runProviderWithDiscoveryExposure(fixtureDiscoveryContext({ transport: 'throw' }))
  assert.equal(output.literatureSources, undefined)
  assert.equal(readDiscoveryExposure(output.runDir).status, 'unknown')
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/discovery-context.test.ts test/unit/current-idea.test.ts`.

Expected: FAIL until the context adapter and provider boundary exist.

- [ ] **Step 4: Implement context binding and narrow discovery exposure.**

Add discovery records before the current `!snapshot && !literature` return in `researchContextForInput`, while preserving the worker exclusion and existing literature behavior. Include a required compact summary and bounded closest-overlap excerpts; if context budget clips the pool, persist excluded IDs and a coverage note. Re-read every captured `ResearchStore` source and compare its hash before `sealContextRecord`. Compare the report's `ideaFingerprint` with the freshly selected current target immediately before binding; omit a stale report rather than attaching it to a changed initial or revised idea. Extend task fingerprints with the immutable discovery report/record content hash so a changed report cannot replay a stale model task.

At `subagent-provider.ts`'s final rendered prompt boundary, call `prepareDiscoveryExposure` when the assembled context contains discovery records. Persist `prepared`, then `sent` or `unknown` after transport. Do not use `prepareLiteratureExposure`, `RegisteredLiteratureSource`, `allowed_literature_span_ids`, or scientific evidence for this path.

- [ ] **Step 5: Write failing lifecycle integration tests.**

```ts
test('given idea and post-brainstorm candidate each survey exactly once before planner', async () => {
  const given = await runFixture({ candidateSource: 'input', discovery: offlineDiscovery() })
  const brainstormed = await runFixture({ candidateSource: 'brainstorm', discovery: offlineDiscovery() })
  assert.equal(given.discoveryCalls.beforePlanner, 1)
  assert.equal(brainstormed.discoveryCalls.beforePlanner, 1)
})

test('changed current hypothesis surveys before the next planner while unchanged resume reuses the report', async () => {
  const first = await runFixture({ discovery: offlineDiscovery() })
  const resumed = await resumeFixture(first, { changedHypothesis: true })
  assert.equal(resumed.discoveryCalls.changedFingerprint, 1)
  const unchanged = await resumeFixture(first, { changedHypothesis: false })
  assert.equal(unchanged.discoveryCalls.total, first.discoveryCalls.total)
})

test('explicit disabled/frozen paths make no discovery calls', async () => {
  const disabled = await runFixture({ currentIdeaSearch: 'never', discovery: offlineDiscovery() })
  const frozen = await resumeFrozenExperiment({ discovery: offlineDiscovery() })
  assert.equal(disabled.discoveryCalls.total, 0)
  assert.equal(frozen.discoveryCalls.total, 0)
})

test('old frozen policy without currentIdeaSearch remains zero-call', async () => {
  const resumed = await resumeFixture({ policySnapshot: { workflow: { deepDive: 'auto' } }, discovery: offlineDiscovery() })
  assert.equal(resumed.discoveryCalls.total, 0)
})
```

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/integration/current-idea-survey-loop.test.ts test/integration/minimal-loop.test.ts test/integration/planner-literature-freeze.test.ts`.

Expected: FAIL until runner lifecycle hooks and offline dependency injection are connected.

- [ ] **Step 6: Integrate runner lifecycle without changing scientific admission.**

Place the centralized hook immediately before `runAgent` in `runPlanner` and `runMinimalPlan`, after the current target is loaded and before a plan is frozen. The service runner and standalone callers must not add a second search call or run discovery for a continuation's direct non-scientific planner. Keep the existing `runInitialDeepDive` call path and its semantics unchanged; current-idea search is an additional independent survey, and `workflow.deepDive: 'never'` must not suppress it when `workflow.currentIdeaSearch` is enabled. On later cycles, the helper runs only when the semantic target hash changes. Do not call it in terminal, `PAUSED`, `WAITING`, paper-checkpoint, or frozen experiment resume branches. Pass the report only through `researchContextForRole` to planner, idea generator, idea reflexion, and hypothesis reviser; do not broaden discovery access to paper-survey or direction-select. Similarity output remains advisory and cannot change `assessEvidence`, candidate admission, cleanup, or worker allowlists.

- [ ] **Step 7: Run focused lifecycle checks and inspect durable artifacts.**

Run from `packages/autoresearch`: `npm run build`; then `node --experimental-strip-types --test test/unit/current-idea.test.ts test/unit/auto-mode.test.ts test/integration/current-idea-survey-loop.test.ts test/integration/minimal-loop.test.ts test/integration/planner-literature-freeze.test.ts test/integration/existing-project-research-e2e.test.ts test/integration/research-compatibility.test.ts`; then `npm run typecheck`.

Expected: offline lifecycle tests pass; old explicit deep-dive/off fixtures retain their semantics; report, checkpoint, receipt, context, and exposure files are hash-consistent; no literature generation binding or worker allowlist changes occur.

### Task 3: Controlled recall fixture, optional network smoke, and integration review

**Files:**

- Create: `packages/autoresearch/test/fixtures/idea-survey-recall.ts` with paraphrased metadata/abstract fixtures for Macaroons, CaMeL, RAG, and REST plus literal-word decoys.
- Create: `packages/autoresearch/test/integration/idea-survey-recall.test.ts`
- Create: `packages/autoresearch/scripts/benchmark-idea-survey-recall.mjs` for reusable offline artifact generation.
- Create: `packages/autoresearch/scripts/verify-idea-survey-network.mjs` with mandatory `--allow-network`; it is outside normal test discovery.
- Modify: `docs/verification/2026-09-20-idea-similarity-survey.md` with controlled benchmark and verification outcomes after implementation.

- [x] **Step 1: Add a controlled recall benchmark.**

Compare an explicitly constructed single literal-query reference against the varied multi-round controller. The reference is not the prior model-driven papersurvey implementation. Use two public-anchor scenarios with real provider adapters and offline response envelopes: CaMeL/Macaroons and RAG/REST. The differently worded Macaroons/REST anchors first appear on a second-round mechanism query, then a third-round cross-domain query; other queries return base work and literal decoys. Record anchors collected, retained, shortlisted and reviewed, first-seen round, provider/query effort, callback counts, source-byte verification and zero-call unchanged resume. Label the result `controlled fixture benchmark`, not general web recall or live model quality.

Observed: new focused integration test 1/1 passed; reusable artifact command exited 0. Across both scenarios, reference/controller anchor coverage was 2/4 versus 4/4 at every stage, with 6 versus 72 fixture HTTP attempts. Both controller resumes added zero calls. Exact build identity and limits are in the verification document.

- [x] **Step 2: Add an explicit live-provider smoke path.**

With explicit `--allow-network`, search only the fixed public query `retrieval based speculative decoding`: one five-result relevance page per provider, no retries/models, bounded body/time, disk-backed raw/parsed source capture and rehash verification. Record actual provider statuses, response sizes and degradation. No unpublished project idea is accepted as input. Network failure or throttling is reported honestly and never runs in the normal offline suite. The already executed three-request smoke is recorded separately from fixture benchmark metrics.

Observed live smoke: arXiv 200/5 results including exact REST ID, Crossref 200/5 including REST title, Semantic Scholar 429/0. Three requests, zero models/retries, thirteen captured SourceRefs verified. The promoted harness passed syntax validation and rejected missing opt-in before network dispatch; promotion did not repeat the live calls.

- [ ] **Step 3: Perform the integration review before source implementation is approved.**

Check every design requirement against the two implementation tasks: real HTTP receipt lineage, varied query facets, pagination, cross-provider union ranking, alias preservation, durable resume, changed-idea invalidation, bounded rate/error/abort handling, honest partial coverage, source rehashing, discovery exposure status, role access, lifecycle hooks, explicit off behavior, and no RAG/index/worker mutation. Scan the plan for unresolved placeholders and verify every interface name matches the design. Leave the worktree unstaged and uncommitted for root鈥檚 review.

- [ ] **Step 4: After root approval, run the full package verification.**

Run from `packages/autoresearch`: `npm test`, `npm run typecheck`, and `npm run build`. Preserve the original 728-test baseline as historical evidence; report the new test counts, controlled recall output, optional smoke outcome, and any provider degradation separately.
