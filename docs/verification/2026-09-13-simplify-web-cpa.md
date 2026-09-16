# Web and CPA simplification verification

Scope is limited to `packages/autoresearch-web/src/workbench.js`, `packages/dsh-cpa/src/config.mjs`, `packages/dsh-cpa/scripts/install.mjs`, `packages/dsh-cpa/scripts/doctor.mjs`, and the new `packages/dsh-cpa/scripts/cli.mjs`. The plan brief is [2026-09-13-simplify-web-cpa.md](../superpowers/plans/2026-09-13-simplify-web-cpa.md).

The workbench now uses private `projectOrThrow` and `documentOrThrow` wrappers around the existing safe validators. All eight project route guards and four document route guards retain their existing status, error code, message, canonical-root check, allowlist check, opaque ID check, and root binding. The CPA config module uses one private `ROUTE_OPTION_KEYS` collection for validation and profile copying, retaining `!== undefined` handling for omitted values, `false`, and `0`.

The CLI audit supported a small shared module. `scripts/cli.mjs` owns the existing argv slice, flag/value lookup, and YAML parse/native conversion. `install.mjs` still short-circuits uninstall before `loadConfigFile`, so `--uninstall` does not read `--config`; default config, parse errors, and output ordering remain unchanged. `doctor.mjs` still defaults to static checks and only enables network checks with `--network`.

Production source counts use UTF-8 bytes, JavaScript string character count, and newline count as LOC. The baseline is `HEAD` for existing files and zero for the new helper.

| Production file | Before bytes/chars/LOC | After bytes/chars/LOC | Delta bytes/chars/LOC |
| --- | ---: | ---: | ---: |
| `packages/autoresearch-web/src/workbench.js` | 35,670 / 35,670 / 616 | 34,967 / 34,967 / 626 | -703 / -703 / +10 |
| `packages/dsh-cpa/src/config.mjs` | 12,822 / 12,822 / 210 | 12,657 / 12,657 / 211 | -165 / -165 / +1 |
| `packages/dsh-cpa/scripts/install.mjs` | 1,288 / 1,288 / 30 | 901 / 901 / 17 | -387 / -387 / -13 |
| `packages/dsh-cpa/scripts/doctor.mjs` | 740 / 740 / 19 | 425 / 425 / 9 | -315 / -315 / -10 |
| `packages/dsh-cpa/scripts/cli.mjs` | 0 / 0 / 0 | 526 / 526 / 15 | +526 / +526 / +15 |
| **Total** | **50,520 / 50,520 / 875** | **49,476 / 49,476 / 878** | **-1,044 / -1,044 / +3** |

The extra physical lines come from readable workbench wrappers and the shared CLI module; the source byte count falls by 1,044 and the duplicated guards/options are represented once at their call sites.

## Verification commands

- `packages/autoresearch-web`: `node --check src/workbench.js` and `node --test test/workbench.test.mjs test/api.test.mjs` — 28/28 passed.
- `packages/dsh-cpa`: `node --check src/config.mjs; node --check scripts/cli.mjs; node --check scripts/install.mjs; node --check scripts/doctor.mjs` and `node --test test/cpa.test.mjs` — 13/13 passed.
- `packages/autoresearch-web`: `npm test` — 60/60 passed; `npm run build` — passed.
- `packages/dsh-cpa`: `npm test` — 13/13 passed; `npm run typecheck` — passed; `npm run build` — passed.
- CLI smoke used a controlled temporary DSH home: `node scripts/doctor.mjs` returned three static `PASS` lines; `node scripts/install.mjs --uninstall --dsh-home <temp> --settings <temp>/settings.yaml --config <temp>/missing.yaml` returned `DRY-RUN uninstall` with `no changes`; default `node scripts/install.mjs --dsh-home <temp> --settings <temp>/settings.yaml` returned `DRY-RUN install` with `add cpa-gpt` and `add cpa-gpt-deep`. No network or real credentials were used.
- `git diff --check` on all modified production files — passed.

No tests or guardrails were removed, and no dependencies or public exports were added.
