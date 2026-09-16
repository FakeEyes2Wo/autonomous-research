# Simplify Core Verification

Date: 2026-09-13

The implementation brief is [2026-09-13-simplify-core.md](../superpowers/plans/2026-09-13-simplify-core.md). The source changes are frozen for coordinator review.

## Changes verified

- `packages/autoresearch/src/experiment/runner.ts` uses one private terminal persistence helper for failed/paused outcomes and one private completion helper for evidence export and completed-state persistence. Cached stages, pause classification, max-round reports, export warnings, `lastError`, and mode-specific result shapes remain at their original call sites.
- `packages/autoresearch/src/brainstorm/normalize.ts` uses private `toInsight` for the shared cleaned insight fields. Survey-info defaults and metadata/extras construction remain field-by-field unchanged.
- `packages/autoresearch/src/paper/phases.ts` uses private `writePaperSections` for nested section files while preserving writer `main.tex → references.bib → sections` ordering and polisher `main.tex → sections` ordering. Failure report, template, polish log, compilation, and PDF-copy behavior remain in their respective phases.
- Private unused imports/parameters assigned during coordination were removed from `brainstorm/deep-dive.ts`, `brainstorm/pipeline.ts`, `paper/pipeline.ts`, `service/steps/idea.ts`, `core/human-review.ts`, and `src/index.ts`; side-effecting calls were retained.

## Line counts and diff

Counts use PowerShell `Get-Content` for the current file and `git show HEAD:<path>` for the baseline.

| Production file | Before | After | Delta | Diff (+/-) |
|---|---:|---:|---:|---:|
| `experiment/runner.ts` | 498 | 505 | +7 | 81/74 |
| `brainstorm/normalize.ts` | 281 | 270 | -11 | 3/14 |
| `paper/phases.ts` | 462 | 462 | 0 | 14/14 |
| `brainstorm/deep-dive.ts` | 81 | 80 | -1 | 0/1 |
| `brainstorm/pipeline.ts` | 497 | 496 | -1 | 4/5 |
| `paper/pipeline.ts` | 274 | 274 | 0 | 1/1 |
| `service/steps/idea.ts` | 220 | 219 | -1 | 2/3 |
| `core/human-review.ts` | 53 | 53 | 0 | 1/1 |
| `src/index.ts` | 207 | 205 | -2 | 0/2 |
| **All changed production files** | **2573** | **2564** | **-9** | **108/119** |

The three primary owned files total 1241 lines before and 1237 after, a net reduction of 4 lines. The requested 65–95 line reduction estimate was not reached, and no formatting compression or comment deletion was used to manufacture a reduction.

The final line-ending-independent comparison is recorded in `.runs/simplification/normalized-source-metrics.json`. It decodes UTF-8, normalizes CRLF/CR to LF, and records per-file and per-group byte/LOC deltas. Across all modified production groups it reports 240930 → 236693 UTF-8 bytes (-4237) and 5031 → 5013 LOC (-18), including the new dsh-cpa CLI from a zero baseline.

## Checks

- `npm run build` — passed.
- `npm run typecheck` — passed.
- `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` — passed.
- `node --experimental-strip-types --test test/unit/experiment-runner.test.ts test/integration/minimal-loop.test.ts test/unit/paper-phases.test.ts test/unit/brainstorm-max-papers.test.ts test/integration/brainstorm-loop.test.ts` — 37 passed, 0 failed.
- After the writer ordering fix: `node --experimental-strip-types --test test/unit/paper-phases.test.ts test/unit/paper-workflow.test.ts` — 8 passed, 0 failed, including section-write failure with bibliography retained.
- `git diff --check` — passed; Git only reports the repository's existing LF/CRLF conversion warning.

The coordinator should run the repository full suite once after all workers' changes are present. The added writer ordering regression covers the partial-output boundary that the earlier characterization suites did not exercise.
