# Lightweight Experiment Engineering Verification

Date: 2026-09-10

## Outcome

The experiment workflow now delivers one plugin-owned engineering policy to the seven relevant planning/execution/review roles in both full and minimal modes. Runtime context forwarding is fixed without adding roles, stages, required output fields, or a deterministic quality gate.

## TDD record

RED was captured after a clean build and before production edits:

```text
node --experimental-strip-types --test test/unit/experiment-engineering.test.ts
tests 5; pass 0; fail 5
```

The failures corresponded to missing shared prompt routing, worker `workDir`/Python guidance, optional designer engineering context, minimal runtime forwarding, and revised-design propagation. A later supervisor rendering assertion also failed at the role-spec boundary. The resume fingerprint characterization passed before implementation, demonstrating that `workDir` must remain outside `roleSpecs[role].sections`.

GREEN after implementation:

```text
npm run build
exit 0

node --experimental-strip-types --test \
  test/unit/experiment-engineering.test.ts \
  test/unit/subagent-provider.test.ts \
  test/unit/schema-validity.test.ts \
  test/unit/experiment-runner.test.ts
tests 28; pass 28; fail 0

npm run typecheck
exit 0

git diff --check
exit 0 (PowerShell checkout emitted only the repository's LF-to-CRLF notices)
```

A final build plus the two directly affected prompt/provider files also passed 23/23 tests. The coordinating agent then ran the package-wide validation:

```text
npm test
exit 0; tests 132; pass 132; fail 0; cancelled 0; skipped 0; todo 0
```

Expected fake-provider failure logs came from intentional recovery tests and did not produce suite failures.

## Coverage and self-review

- Prompt factory: loads shared guidance from the installed plugin path, works with an unrelated temporary `runDir`, routes only to planner, research-worker, experiment-designer, experiment-reflexion, minimal-verifier, evidence-agent, and supervisor, and adds Python guidance only as conditional language-specific advice.
- Lightweight layout: documents `experiment/README.md`, dependency/version records, `configs/`, responsibility-based `src/`, focused `tests/`, optional thin scripts/notebooks, immutable `data/`, and code-free cycle work directories without empty scaffolding or forced migration.
- Reproducibility: covers config/seeds/datasets/splits, shared preprocessing/metrics, exact README commands, unique attempt directories, command/cwd/exit code, logs/metrics, versions/source identity, smoke checks, negative results, and real file artifact paths.
- Schema/context: `engineeringPlan` is optional under `additionalProperties: false`; the designer receives previous design context during reflexion and human-feedback redesigns.
- Runtime: worker receives its actual `workDir`; supervisor renders evidence through `reflexion`; full runners retain the design returned by reflexion and standalone checkpoints persist it. Minimal mode's supplied current design remains authoritative over stale disk content.
- Resume compatibility: `workDir` is a worker-only prompt heading, not a role section, so a completed continuable worker is reused when only this contextual field is added. A provider regression exercises this persisted registry path.
- Review behavior: worker/minimal verifier, evidence agent, experiment reflexion, and supervisor all receive responsibility-appropriate checks; supervisor is instructed not to finish executable work without reproduction and verification evidence, with an explicit theory/no-code exemption.
- Documentation: package README and runtime draft distinguish minimal/full responsibilities, new-run defaults, old-run resume behavior, lightweight scope, prompt-size caveat, and the absence of a hard runtime quality gate.

## Prompt budget note

The shared prompt is 371 words, below the requested 800-word ceiling. With minimal inputs, the repository's conservative `chars / 4` estimator reports approximately 846 tokens for planner, 1,247 for research-worker, and 1,147 for minimal-verifier. Production limits were not changed. The general provider test fixture was raised from 1,000 to 2,000 input tokens so continuable-runtime tests exercise their intended behavior; the explicit 12-token insufficient-context test remains unchanged and passing.

## Remaining caveats

- Engineering quality is model/prompt-guided and evidence-reviewed, not deterministically enforced by a new runtime gate.
- Completed stages in old runs are not retroactively regenerated or migrated; the policy affects future role calls while preserving prior evidence links.
- The shared prompt adds real input cost, so unusually small configured role budgets can correctly stop with `CONTEXT_INSUFFICIENT`.
