# Direction retirement and cleanup

Ordinary execution failures, pauses, budget exhaustion, and inconclusive measurements remain in the evidence chain and reports. Automatic cleanup starts only from a canonical assessment with `category: hypothesis_refuted` and `claim_status: refuted`, or from the explicit abandonment API.

At the frozen direction boundary, the controller records a manifest under `.autoresearch/directions/<direction-id>.json`. It registers only controller-owned files created inside managed cycle, work, runtime-job, output, log, cache, and source-copy roots. User input, project-root files, unknown legacy files, shared hashes, active tasks, successful directions, symlinks/junctions, and externally changed files are protected or leave the task blocked.

The task is persisted as `pending` before the project-global `.autoresearch/direction-memory.json` receives a short idea, elimination reason, and avoid-repeat hint. A valid memory receipt is required before deletion. Startup, resume, and decision boundaries retry incomplete tasks; memory failure remains retryable and does not become a scientific failure.

Each deletion target is checked against the immutable direction manifest, task authorization, current hash, and realpath immediately before removal. Deleted research sources receive a task-bound tombstone: historical snapshots can report that the source was retired, while a new formal commit cannot admit it as evidence. A crash resumes the task and never recreates deleted source text.

## SoL-Pi inspiration and project-specific extension

The design is informed by [SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness](https://arxiv.org/html/2609.20519v1), especially sections 2.1–2.2 on isolated experiments and research lineage. SoL-Pi motivates independent lineages and controlled experimentation; its paper is not a deletion protocol. Compact global memory for retired directions and resumable cleanup of direction-exclusive artifacts are additions required by this project and its user requirements.

## Paper, title, and section ownership

Retirement applies to a research direction and its registered generated artifacts. A direction's private draft, title candidate, or section input may be deleted only when its manifest records exclusive ownership and no live, successful, shared, or user-owned reference remains. A final paper, report, title, or section containing successful-direction material is retained as shared provenance. User-authored paper files are never inferred to be disposable from a refutation. Cleanup stores only the compact memory fields; it does not copy paper text, worker responses, or deleted results into memory.

Historical runs without a direction manifest remain `blocked` with unknown ownership. They are never reported as completed cleanup, and a hand-written tombstone cannot bypass ResearchStore validation. See the [cleanup API](../src/cleanup/index.ts) and [global direction memory](../src/memory/direction-memory.ts).
