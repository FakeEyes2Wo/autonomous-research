# Lightweight Experiment Engineering Implementation Plan

**Goal:** Make experiment-producing roles consistently create a small, reproducible scientific codebase and verifiable per-attempt artifacts in both full and minimal workflows.

**Architecture:** Keep engineering policy in one plugin-owned shared prompt that the prompt factory appends only to experiment planning, execution, and review roles. Pass current runtime context explicitly (`workDir`, revised experiment design, and supervisor evidence) without adding workflow stages, required schema fields, or resume-breaking fingerprint inputs.

**Constraints:** Preserve existing layouts and PROFILE constraints; do not migrate old runs, mass-move files, create empty scaffolding, or turn prompt guidance into a deterministic runtime quality gate.

## Implementation sequence

1. Add focused tests that exercise the built prompt from an unrelated temporary run directory, relevant-role routing, optional designer schema context, worker `workDir` propagation, supervisor evidence propagation, and revised-design propagation through full/minimal orchestration boundaries.
2. Run the focused tests before production changes and record the expected failures (RED).
3. Add the shared experiment-engineering prompt and concise Python guidance, then compose them in the prompt factory for only the relevant roles. Render worker `workDir` as a dedicated common heading outside fingerprinted role sections.
4. Extend backwards-compatible input/schema wiring: optional `workDir`, optional `engineeringPlan`, designer access to previous `experimentDesign`, and supervisor access to `reflexion` evidence.
5. Forward runtime values in experiment steps and retain returned redesigns in both full workflow runners so the worker receives the current design.
6. Tighten role-specific instructions for planning, current-input precedence, scientific implementation, evidence review, and theory-only exemptions.
7. Update package/runtime documentation with the lightweight directory contract, minimal/full responsibilities, new-run versus resume behavior, and the prompt-guidance caveat.
8. Run focused tests to GREEN, then build/typecheck and perform a requirement-by-requirement self-review. Record commands, results, and remaining caveats in the verification draft.
