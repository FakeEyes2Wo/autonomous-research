# Simplify Boundary Verification

Scope is limited to the assigned production files and the brief plan. The existing directory reorganization and other workers' edits were preserved.

## Production source delta

Counts below are from `git diff --numstat` against the current checkout baseline; tests and documentation are excluded.

| File | Added | Removed | Result |
| --- | ---: | ---: | ---: |
| `src/providers/subagent-provider.ts` | 59 | 54 | +5 |
| `src/settings/service.ts` | 12 | 14 | -2 |
| `src/settings/index.ts` | 0 | 2 | -2 |
| `src/tools/index.ts` | 37 | 45 | -8 |
| `src/policy/request-ledger.ts` | 1 | 4 | -3 |
| `src/core/research-tree.ts` | 1 | 3 | -2 |
| **Total** | **110** | **122** | **-12** |

The six production files total 87,987 bytes at `HEAD` and 86,287 bytes after the refactor, a 1,700 byte reduction. Byte totals include the checkout's original line-ending representation and are reported separately from the line diff.

The provider helper adds a small structured options object to make role versus repair differences visible. It centralizes native start, request binding, ownership registration, result waiting, text extraction, budget error precedence, release, and disposal. Continuable text extraction now uses the same extractor. Settings keeps locks and candidate construction in each caller while sharing the validated v2 commit path. Tools retain `ToolDefinitionLike` contextual typing while removing identity and forwarding helpers. Ledger settlement delegates to `settleEntry`; research-tree imports are merged.

## Fresh verification

- `npm run build` — passed.
- `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) — passed after the final source edits.
- `node --experimental-strip-types test/unit/subagent-provider.test.ts` — 19 passed, 0 failed; the added regression verifies that no-session-id initial streams are attributed to `pending-*` for the role and `pending-repair-*` for JSON repair.
- `node --experimental-strip-types test/unit/settings-service-v2.test.ts` — 3 passed, 0 failed.
- `node --experimental-strip-types test/unit/settings-validation-v2.test.ts` — 3 passed, 0 failed.
- `node --experimental-strip-types test/unit/request-ledger.test.ts` — 13 passed, 0 failed.
- `node --experimental-strip-types test/unit/request-accounting.test.ts` — 2 passed, 0 failed.
- `node --experimental-strip-types test/unit/tools.test.ts` — 6 passed, 0 failed.
- `node --experimental-strip-types test/unit/research-tree.test.ts` — 2 passed, 0 failed.

An additional `--noUnusedLocals --noUnusedParameters` audit remains blocked by unrelated concurrent worker edits in `brainstorm`, `experiment`, `paper`, `service/steps`, and `core/human-review`; it also reported missing `pauseExperiment` symbols in the worker-owned experiment runner. The assigned files introduced no such diagnostics after removing the unused settings migration import and provider listener disposer field while retaining listener registration.
