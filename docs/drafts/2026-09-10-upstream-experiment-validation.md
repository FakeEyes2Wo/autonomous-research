# Upstream Experiment Validation Verification

Date: 2026-09-10

Status: implementation and scoped review complete

## Outcome

Future AutoResearch calls receive domain-neutral scientific protocol guidance and planner-visible outer runtime constraints. Pre-work experiment designs return only after an explicit `proceed` review of the exact revision. Unresolved or malformed review outcomes pause normally, including repeated human revision. Minimal research post-work review is review-only, so it cannot approve a redesigned protocol against old execution.

Fresh and cached worker results use one basic validator before evidence or supervision. Completed results require a non-empty summary and at least one existing regular artifact whose real path remains inside the real run root. Malformed, failed, empty, missing, directory, traversal, outside, and escaping-symlink results pause with an actionable report. A present but invalid cached stage, including empty data, null `actionResult`, or null stage data, pauses without rerunning the worker.

These gates establish protocol acceptance and local artifact validity only. Budget matching, statistical sufficiency, scientific truth, and complete reproducibility remain planning, execution, evidence, and review responsibilities.

## TDD and verification evidence

- Initial RED: focused unit execution reported 9 intended failures covering absent runtime constraints, exact-design final review, invalid verdict handling, unresolved review, unsafe/missing artifacts, malformed worker output, and cached artifact revalidation.
- Initial GREEN: build and typecheck passed; focused unit suites passed 23/23; the focused minimal-loop integration suite passed 14/14 when rerun with the required sandbox permission.
- Cache-regression RED: `npm run build; node --experimental-strip-types --test test/unit/experiment-runner.test.ts` produced 18 tests with 12 passing and 6 failing. The failures were 2 standalone modes × cached `data={}`, `actionResult=null`, and `data=null`.
- Final focused GREEN: `npm run build; npm run typecheck; node --experimental-strip-types --test test/unit/experiment-runner.test.ts test/unit/service-runtime.test.ts test/unit/experiment-engineering.test.ts` exited 0. Build and typecheck passed; tests were 29 passed, 0 failed/cancelled/skipped/todo. The main agent independently repeated these suites on the final source with the same 29/29 result.
- Package-wide pre-final-fix baseline: the main agent ran `npm test` successfully with 149/149 tests and the included build passing. The final cache/prompt corrections were covered by the focused command above; a redundant full-suite rerun was intentionally omitted.
- Scoped `git diff --check` passed on final source (line-ending notices only). The shared engineering prompt is 578 words, below the approximately 800-word ceiling.
- Independent scoped review closed both final P2 findings: hypothesis-appropriate reflexion guidance and all 2 modes × 3 malformed cached-stage cases. No blocking finding remains.

## Boundaries and limitations

- No generated project, settings file, state schema, checkpoint format, provider schema, task fingerprint, routing policy, deployment, network resource, commit, branch, or `.git` content was changed.
- No metric-truth validation or arbitrary artifact command execution was added.
- Symlink escape coverage is conditional when Windows does not permit test symlink creation.
- Existing terminal completed runs are not retroactively revalidated.
