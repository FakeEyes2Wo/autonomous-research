[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# Autonomous Research System Design Docs

Autonomous Research System: an automated research control plane that goes from a candidate / experiment records all the way to a traceable paper package. It reuses DSH's Agent, Subagent, Goal, Workflow, Tools, Skills, persistence, sandbox, approval and model-routing layers; only the research control semantics are new.

## Current Implementation Baseline

| Document | Contents |
|---|---|
| [2026-08-20-autoresearch-ml-control-plane-design.md](2026-08-20-autoresearch-ml-control-plane-design.md) | **The single implementation baseline**: AutoResearchService + minimal state + dynamic rubric + autonomous iteration + Domain Profile (ML v1) |
| [2026-08-16-candidate-to-paper-design.md](2026-08-16-candidate-to-paper-design.md) | candidate → paper end-to-end flow (default entry point) |
| [2026-08-16-records-to-paper-design.md](2026-08-16-records-to-paper-design.md) | Existing experiment records → paper (second entry point) |
| [2026-08-16-idea-generation-design.md](2026-08-16-idea-generation-design.md) | Brainstorming + candidate generation + gating |
| [2026-08-15-hypothesis-local-pool-design.md](2026-08-15-hypothesis-local-pool-design.md) | HypothesisPool lifecycle index |
| [2026-08-15-autoresearch-figures-and-experiment-design.md](2026-08-15-autoresearch-figures-and-experiment-design.md) | Paper figures, trustworthy experiments, ablation rules |

## Code Implementation

- [packages/autoresearch/](packages/autoresearch/): the minimal closed-loop DSH plugin (TypeScript), implementing `idea → plan → work → evidence → decide → paper | failure report` and reusing the DSH Agent/Subagent system.
  - Headless run: `cd packages/autoresearch && npm run run:headless`

## Handoff (Domain Workflow Execution Manuals)

| Group | Files |
|---|---|
| candidate→paper | [candidate-to-paper-handoff/](candidate-to-paper-handoff/): 00 master control + stages 01–10 |
| records→paper | [records-paper-handoff/](records-paper-handoff/): 00 master control + 01, 02, 04, 05 (includes the data contract; writing reuses candidate 08) |
| Minimal validation | [verify_exp/](verify_exp/): figure pipeline, drawio MCP, pure LLM / drawio results |

## Historical / Deferred References (Not the Implementation Baseline)

- `2026-08-15-autoresearch-ts-plugin-design.md`: the deliverable decisions and the three paper paths are still valid; the old framework has been consolidated.
- `2026-08-15-autoresearch-detailed-design.md`: historical implementation-level design, retained for its recovery and quality-gate principles.
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`: the Paper Engine rules are still valid; the stage protocols have been superseded by the 2026-08-20 document.
- `2026-08-15-autoresearch-generalization-and-minimalism.md`: M4 generalization reference.

## Key Decisions

1. Do not build a second Agent Runtime / EventBus / DAG / task queue.
2. ML v1 implements only one primary `AutoResearchService` plus minimal state/events.
3. The experiment executor is unified behind an **Experiment Provider** (currently implemented by Athena); Core does not depend on its private types.
4. The evidence contract is unified as `evidence_chain.json`; paper citations are unified under the `E:`/`B:` labels; the four-segment ID is `candidate_id → hypothesis_id → experiment_id → paper tag`.
5. The rubric is dynamically generated and frozen before experiments run; failures, DRAWs and negative results must never be deleted.
6. Three paper paths: Overleaf → local TeX → Markdown-only; compilation fixes are bounded only by the time budget.
7. Timing of generalization: distill a minimal Domain Profile only after a second real domain is onboarded — do not pre-build empty interfaces.
