# Current-idea similarity survey verification — 2026-09-20

This feature adds a current-idea discovery report before a fresh planner in both legacy and minimal workflows. It uses arXiv, Crossref and Semantic Scholar adapters; model roles propose varied queries and compare retrieved candidates. The report is advisory context, not scientific evidence, refutation, a novelty proof or a corpus/index update.

## Usage and boundary

Newly normalized project settings and new runs default to:

```yaml
workflow:
  currentIdeaSearch: enabled
budget:
  currentIdeaSearch:
    minRounds: 3
    maxRounds: 5
    queriesPerRound: 4
    maxRequests: 80
    maxCandidates: 200
    maxDurationMs: 600000
    nearestLimit: 20
```

`workflow.currentIdeaSearch: never` disables the new search. It is independent of the older `workflow.deepDive` toggle and of `literature.mode` (curated corpus retrieval). The search budget has exactly the seven project settings shown above; there is no public provider-list, mailto, or discovery-context-size setting. The host adapter supports a supplied User-Agent and optional Semantic Scholar key; no key is required by default.

The planner hook runs after initial brainstorming/idea generation. That initial stage therefore has no newly generated current-idea report. Once available, a report can enter planner and permitted idea-review context only with a matching current-target binding. Worker allowlists and pinned corpus generations remain unchanged. Historical frozen run policies with no search setting, and existing runs with no policy snapshot, stay off rather than acquiring new paid/network work implicitly.

The semantic fingerprint includes statement, profile, scope, mechanism, prediction, falsification, measurement, decision rule, alternatives, assumptions, terminology and cross-domain analogs. Configuration/provider/parser identity is separate; both bind a durable survey. Run/cycle/source IDs alone do not create a new semantic target. Checkpoint, raw HTTP/model receipts, pool and report are under `brainstorm/current-idea-survey/<ideaFingerprint>/<configFingerprint>/`; source bytes use `research/sources/<sha256>`.

## Confirmed engine checks

The initial engine gate ran `npm run build`, the four explicit `discovery-{query-planner,providers,coordinator,reviewer}.test.ts` files, and `npm run typecheck`: build/typecheck exited 0; **28/28** focused tests passed. This is historical Task 1 evidence, not a claim about the later integration changes or the full package suite.

The focused checks included actual adapter response envelopes, raw/parsed source separation, corrupt-source rejection, exact excerpt/candidate/alias validation, query shortfalls, provider spacing/429 deferral, timeout including a stalled response body, capped retention without stopping minimum rounds, durable dispatch debit, known receipt/model recovery without replay, unknown-model fail-closed behavior, incremental crash-time accounting, and single-owner stale-lock recovery.

Validated corrections preserve content-bound semantic judgments across rounds and use them before retention/final-nearest truncation. Repeated provenance/rank hits alone do not trigger another semantic review; materially new or conflicting observations invalidate stale judgments and remain eligible for exploration. Focused integration checks also cover the complete current-idea identity, settings bounds, matching report pointers, and byte-verified context/exposure bindings. Similarity remains advisory and does not expand worker access or scientific authority.

A crash during the short stale-lock recovery-guard section intentionally fails closed. An abandoned `execution.recovery.lock` needs explicit reconciliation after checking ownership; the engine does not steal that guard automatically.

## Reusable controlled benchmark

From `packages/autoresearch`, after the current source owner's build is complete:

```powershell
node --experimental-strip-types --test test/integration/idea-survey-recall.test.ts
node --experimental-strip-types scripts/benchmark-idea-survey-recall.mjs --output <artifact-directory>
```

Use a new or empty artifact directory for each benchmark execution. The harness rejects a populated directory so previously cached surveys cannot silently reduce the measured effort of a new comparison. Resume is exercised separately inside each fresh benchmark run.

The test uses real provider adapters with injected offline HTTP fixtures, a fake clock, actual `ResearchStore` capture and disk-byte rehashing. Two scenarios contain four known public identifiers and synthetic literal-word decoys:

| Scenario | First-round anchor | Anchor introduced by later search |
|---|---|---|
| Delegated authority | CaMeL, arXiv `2503.18813` | Macaroons, DOI `10.14722/ndss.2014.23212` (2014) |
| Reuse of retrieved text | RAG, arXiv `2005.11401` | REST, arXiv `2311.08252` |

Macaroons/REST appear only on a specific second-round mechanism query, then a third-round cross-domain query. This makes additional rounds do observable retrieval work. Abstracts are short original paraphrases. Fixture author fields and decoy identifiers are synthetic, not claims about published metadata.

The comparison is **an explicit single literal-query reference versus a multiround multifacet controller**. It is not a comparison against the old model-driven papersurvey implementation. Provider response mappings and reviewer judgments are deterministic fixtures: results measure control flow, provenance and retained coverage, not live retrieval recall or model semantic quality.

The benchmark records known anchors collected, retained, shortlisted and reviewed; first-seen round; query/provider attempts; planner/reviewer callback counts; decoys; verified source hashes; and unchanged-resume call deltas. The focused test passed **1/1**, and the standalone artifact generator exited **0**, against the coordinated built engine dated 2026-09-20 15:54:20–15:54:21 UTC. Both commands ran without building or changing engine sources.

| Observed metric, across both scenarios | Single literal-query reference | Multiround multifacet controller |
|---|---:|---:|
| Known anchors collected | 2/4 | 4/4 |
| Known anchors retained | 2/4 | 4/4 |
| Known anchors shortlisted | 2/4 | 4/4 |
| Known anchors with validated review | 2/4 | 4/4 |
| Queries | 2 | 24 |
| Fixture adapter HTTP attempts | 6 | 72 |
| Planner callbacks | 0 | 6 |
| Reviewer callbacks | 2 | 4 |
| Live HTTP / paid models | 0 / 0 | 0 / 0 |

Macaroons and REST were first collected in round **2**; CaMeL and RAG in round **1**. Each scenario included two literal-word decoys. Both controller resumes added **0 HTTP, 0 planner, and 0 reviewer calls**. The controller completed three rounds per scenario; its additional review call handled the newly found anchor rather than repeating the same comparison on every round. These outcomes establish the intended fixture behavior, not a general claim that twelve times as many requests doubles real-world recall.

Persisted local artifacts are at `%TEMP%\autonomous-research-idea-survey-20260920\task-3-controlled-benchmark\benchmark-summary.json`, including exact module hashes/timestamps, per-request queries, stage metrics and callback inputs. The tested coordinator SHA-256 is `d9c41c7cc11b22d0ffc8db4e9b8de17c55fba85012bffd3cfee9153d16ea32c5`. Each scenario/variant directory retains its actual raw/parsed source bytes and report/checkpoint artifacts. Final full-suite status is recorded below.

## Actual public-provider smoke

The independently executed smoke used the fixed public query `retrieval based speculative decoding` on 2026-09-20 at approximately 15:16:48–15:16:52 UTC. It made exactly **3 actual HTTP requests**, one page of at most five results per provider, with **0 model calls and 0 retries**. Body limit was 2,000,000 bytes and per-request timeout 20 seconds.

| Provider | Observed HTTP/outcome | Candidates | Captured body bytes | REST observation |
|---|---|---:|---:|---|
| arXiv | 200 / ok | 5 | 13,642 | Exact arXiv `2311.08252`, returned fourth |
| Crossref | 200 / ok | 5 | 12,192 | Matching REST title, returned fifth |
| Semantic Scholar | 429 / rate_limited | 0 | 174 | Unavailable in this attempt; no Retry-After header |

All **13 captured SourceRefs** (3 raw responses plus 10 parsed observations) passed actual disk-byte SHA-256 verification. This establishes live endpoint/parsing/provenance behavior for those requests, not exhaustive coverage or semantic ranking. Semantic Scholar's throttled response is preserved, not treated as successful empty search. No unpublished idea was sent.

Local artifacts were inspected by root at `%TEMP%\autonomous-research-idea-survey-20260920\network-smoke-U9WxQN\summary.json`, with per-provider receipts and content-addressed sources in that directory. These machine-local artifacts are not repository fixtures.

The equivalent reusable harness is explicitly opt-in and outside normal test discovery:

```powershell
node scripts/verify-idea-survey-network.mjs --allow-network --output <new-smoke-directory>
```

It accepts no custom project query, makes no model calls, persists bounded raw/parsed responses and reports HTTP errors/429 honestly. Adding this harness did not trigger another live run.

Both new `.mjs` entry points passed `node --check`. Invoking the network harness without `--allow-network` exited **1** with its usage error before loading providers or issuing a request, as intended.

## Integration verification status

The following results are confirmed by the source owner/root's recorded runs or the separately logged Web verification. Scopes overlap; these counts are not additive.

| Validation scope | Observed result |
|---|---|
| Task 2 focused lifecycle/context/settings checks | 84 passed |
| Final exposure/context checks | 5/5 passed |
| Direct settings bounds and pointer-integrity checks | 9/9 passed |
| Core `npm run typecheck` | Exit 0 |
| Final standard core `npm test` | 771/771 passed; 0 failed, cancelled, skipped or todo; exit 0 |
| Web `npm run build` | Exit 0 |
| Web normal `npm test` | 84/84 passed, 0 skipped, exit 0 |
| Web literature tests explicitly mapped to current main-worktree core | 7/7 passed, 0 skipped, exit 0 |

The Web settings integration test directly imports the main worktree's built core settings. The normal Web literature fallback initially used the installed dependency link to the original workspace; the targeted seven-test follow-up closed that limitation using a Temp-only Node resolver mapped to the current main-worktree core exports. Actual resolved paths and SHA-256 hashes were logged, without changing dependencies or source files. Logs are under `%TEMP%\autonomous-research-idea-survey-20260920\web-verification-20260920T155952Z\` and `web-current-core-20260920T160353Z\`.

The first standard core `npm test` completed with **771 total, 769 passed, 2 failed, 0 skipped**, exit **1**, in **845,249 ms**. Both failures were exact role-list assertions in `existing-project-research-e2e.test.ts`: its offline setup omitted the explicit `currentIdeaSearch: never` setting. The source owner added that one test-settings field; no runtime feature change was made for this fix. The corrected file then passed **4/4**, exit **0**, in **22,710 ms** (`existing-project-research-e2e-green.log` in the same Temp scratch).

**Final standard core `npm test` passed: 771/771, exit 0**, with **0 failed, cancelled, skipped or todo**, in **1,074,493.5874 ms**. The final Windows three-minute recovery test also passed, in **180,246.3255 ms**. Root recorded the completed run in `%TEMP%\autonomous-research-idea-survey-20260920\final-core-full-suite-rerun.log`. This full run includes the corrected offline fixture described above.

## Remaining limits

- Candidate comparison uses provider metadata and available abstract excerpts; it is not a full-paper semantic evaluation or a scientific validity test.
- The live Semantic Scholar request returned HTTP 429. Successful arXiv/Crossref pages do not establish complete provider coverage.
- Controlled 2/4-versus-4/4 anchor coverage reflects deterministic fixture responses and judgments, not live retrieval recall or measured model quality.
- An abandoned recovery guard requires explicit ownership reconciliation; unresolved model outcomes fail closed rather than silently repeating paid work.
