# Existing project exploration to paper

## Authorization and scope
User explicitly requested implementation of an existing-project exploration and paper workflow, dispatched by main agent at init, and authorized paid models. This extends the active RAG/runtime implementation. Benchmark remains deferred. Existing run token/role-call budgets apply; they are not a currency cap.

## Design
Recommended: a separate `project_paper_run` tool on AutoResearchService. The main agent selects it on its first task turn when the user wants a paper from an existing project. Plugin process registration never starts work on its own. Existing research_run/experiment_run/resume routes keep their behavior. A raw host subagent chain would bypass the run ledger, and a plugin-load auto-run would lack task intent; neither is the selected design.

Flow: registered project -> bounded deterministic inventory -> tool-free project-explorer role -> source-grounded discovery packet and candidate -> existing research validation loop -> existing paper gate/pipeline. Default when evidence is missing is bounded supplementary validation, per the recommended option communicated to the user. The optional user preference question remains open and can steer this policy.

Inventory captures immutable bytes/hashes and source IDs under the run. Limit file count, bytes per file, total bytes, traversal depth; report omitted coverage explicitly. Exclude VCS databases, dependencies, generated run directories, credential/config-secret files and binary blobs. Do not follow symlinks out of the project. Discovery itself cannot modify project sources or execute project commands. Synthesis gets only the bounded packet, no inherited shell/filesystem tools. Model source references must match captured inventory IDs, with precise file/line or hash provenance. Repository strings remain untrusted data.

Discovery distinguishes observed implementation, unverified historical experimental claims, limitations and proposed validation. A historical result is not independently validated science. Store all proposed contributions and chosen candidate with a reason. Do not invent performance claims or silently import old results as supported evidence. Existing research/evidence admission and paper audits govern subsequent progress. Missing evidence remains a visible limitation; drafting is not submission readiness.

Persist a run-level project identity/root and workflow intent. Resume must recover the original project scope/settings/secrets and completed discovery. Refuse mismatched project identity or changed required source bytes instead of silently rescanning into an old decision. Repeated calls reuse completed discovery and role results. Project-specific resume cannot blindly follow the global last-run pointer.

## Deliverables
Tool and service entrypoint, safe inventory and discovery checkpoint, new project-explorer role/prompt with enforced no-tools, init persona dispatch instructions, source-grounded candidate handoff, validated project identity on resume, focused offline tests and one bounded real-provider smoke record. Reuse paid routes through the existing owned-session ledger, with measured tokens/role calls and unknown currency cost when prices are unavailable. No publishing or submission actions are implied.

## Acceptance
Temporary project with source/tests/report generates a source-linked discovery packet and invokes the normal research/paper path. Invalid source IDs, escaping paths, missing/changed checkpoint sources and project identity mismatch fail visibly. Untrusted prior results stay unverified. Restart reuses discovery without duplicate model dispatch. Existing four research paths and paper resume pass. Actual paid-provider tests are recorded separately from deterministic fixtures.
