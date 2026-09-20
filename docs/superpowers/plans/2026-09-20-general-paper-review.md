# General Paper Review and Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paper generation venue-aware and reproducibly reviewable by preparing ICLR/USENIX/custom templates, measuring the compiled PDF, and running independent contract, figure, and layout review gates tied to the exact artifacts reviewed.

**Architecture:** Task 1 owns the layout boundary: template assets become a `PaperLayoutProfile`, compilation returns structured diagnostics, and a read-only PDF inspection sidecar renders and measures every page. Task 2 owns orchestration: it extends paper context/checkpoints, role schemas/prompts/provider transport, options forwarding, and the final gate so independent reviewers consume Task 1 artifacts and stale results are invalidated. The existing academic evidence audits remain a separate required input to the final gate.

**Tech Stack:** TypeScript ESM, Node 22 test runner and TypeScript compiler, Tectonic/XeLaTeX-compatible paper compilation, Python 3.11 with PyMuPDF (`fitz`) for page rendering and geometry extraction (PIL was used only for local fixture generation), SHA-256 artifact fingerprints, existing `RoleAgentProvider` and request ledger.

## Global Constraints

- Default template is ICLR; generic USENIX support uses official `usenix2019_v3.sty`/`usenix2019_v3.2.tex` assets and must not claim to be SEC26-specific.
- Custom callers may provide a template directory and/or entry template; arbitrary LaTeX is not treated as fully parseable by regular expressions.
- Layout measurements use PDF points (72 points/inch); TeX dimensions use 72.27 points/inch and must be converted explicitly.
- Template, page, and local container dimensions are represented by one `PaperLayoutProfile` consumed by preparation, figure generation, compilation diagnostics, and inspection.
- Figure generation is bounded by measured column width, usable height, body/caption font sizes, and allowed formats; unknown source geometry is reported as unknown.
- Compile errors and deterministic layout warnings take priority over probabilistic review observations.
- PDF inspection is read-only, renders all pages into a PDF-hash-isolated directory, and reports machine-only coverage without claiming visual PASS when actual visual capability is unavailable.
- Existing proof, claim, citation, kill-argument, numeric, and citation evidence audits remain required.
- Reviewers are read-only; writer/polisher/repair phases perform modifications.
- Every review/checkpoint binds source, template, assets, evidence, PDF, and inspection hashes. Any mutation invalidates prior results; resume recomputes the invalidated gate.
- Each review loop has a finite request/round budget and stops with `BLOCKED` after exhaustion or no progress. A resume can continue with remaining budget and cannot silently reuse an old final gate.
- Draft assurance may produce a PDF for iteration but never sets `submissionReady`; submission assurance with incomplete inspection or a required `BLOCKED` review remains `BLOCKED`.
- The worktree already contains the user's six dirty files byte-for-byte. Do not overwrite, stage, commit, push, or revert them; preserve their baseline manifest for the final merge conflict check.
- Implementation workers must not edit files owned by the other task. Do not create commits in this worktree; the parent agent will review and integrate the changes.

---

### Task 1: Venue-aware layout adapter, compile diagnostics, and PDF inspection

**Files:**
- Create: `packages/autoresearch/src/paper/layout.ts` or the focused `packages/autoresearch/src/paper/layout/` module set for profiles, template assets, fingerprints, and inspection result types.
- Create: `packages/autoresearch/scripts/inspect-paper-pdf.py` for deterministic PyMuPDF/PIL rendering, text/image boxes, page dimensions, and conservative issue extraction.
- Create: `packages/autoresearch/templates/usenix2019_v3.2.tex` and `packages/autoresearch/templates/usenix2019_v3.sty` from the official generic USENIX source; add any required license/readme metadata beside the assets.
- Modify: `packages/autoresearch/src/paper/index.ts` to export `preparePaperLayout`, `inspectPaperPdf`, the layout contracts, and additive compile diagnostics while preserving the existing one-argument `compilePaper` behavior.
- Modify: `packages/autoresearch/src/paper/engine.ts` only when engine discovery needs deterministic version/path metadata or structured compiler output.
- Test: `packages/autoresearch/test/unit/paper-layout.test.ts` for profile selection, custom asset copying, hashes, unit conversion, figure constraints, and PDF inspection result parsing.
- Test: `packages/autoresearch/test/unit/paper-engine.test.ts` or the existing engine test location for explicit Tectonic path behavior and diagnostic parsing.

**Interfaces:**
- Produces `PaperLayoutProfile`, `PreparedPaperLayout`, `PreparePaperLayoutOptions`, `CompileDiagnostic`, `CompileResult`, `InspectPaperPdfOptions`, and `PaperPdfInspection` exactly as specified in `docs/superpowers/specs/2026-09-20-general-paper-review-design.md`.
- Produces `preparePaperLayout(paperDir, options?)`, which copies selected built-in/custom template assets into `paperDir`, records template/asset/source SHA-256 hashes, and returns measured or explicitly configured profile geometry.
- Produces a disposable TeX probe during compilation for actual per-page `textwidth`, `textheight`, `columnwidth`, `columnsep`, page size, and column count in PDF points; probe failure leaves geometry `unknown` and never promotes preset values to measurements.
- Computes the fresh source binding from paper TeX/Bib, template support files, and figure inputs only; generated PDFs, compiler intermediates, checkpoints, audits, reports, review outputs, and inspection sidecars are excluded.
- Produces `inspectPaperPdf(paperDir, options?)`, which writes all page images and a structured inspection sidecar under a directory containing the PDF hash; it must never modify `.tex` or evidence audit inputs.
- Keeps `compilePaper(paperDir)` valid for existing callers and adds an optional layout/options parameter whose returned diagnostics and geometry are additive.

- [x] **Step 1: Capture existing compile and template behavior in failing tests.**

  Add tests that assert the default profile is ICLR, the generic USENIX profile has a distinct template name, a custom directory is copied without changing source bytes, and compile results retain `ok`, `engine`, and `output` while exposing an empty or populated diagnostics array. Use temporary directories and injected engine/path probes; do not require a network call.

- [x] **Step 2: Run the focused tests and confirm the new contracts fail.**

  Run `node --experimental-strip-types --test test/unit/paper-layout.test.ts test/unit/paper-engine.test.ts` from `packages/autoresearch`. Expected result: the new imports/functions or assertions fail before implementation.

- [x] **Step 3: Implement profile selection and asset preparation.**

  Add built-in ICLR and generic USENIX metadata, custom directory/entry-file resolution, SHA-256 hashing, explicit PDF/TeX unit conversion, and bounded figure constraints. Copy only resolved assets into the run directory and persist a layout profile sidecar. Fail with stable `UNKNOWN_TEMPLATE` when a venue is unsupported and with `CUSTOM_TEMPLATE_PROFILE_REQUIRED` when a custom template lacks safe geometry metadata and no explicit profile was supplied; also fail deterministically when a custom entry file or required built-in asset is missing.

- [x] **Step 4: Add structured compiler diagnostics without changing compile semantics.**

  Preserve engine lookup order and explicit `TECTONIC_PATH`. Parse compiler output into severity/code/message records, attach source/template/asset hashes and PDF page geometry when available, and keep `compilePaper(paperDir)` callers working. Treat a missing engine, nonzero exit, missing PDF, and deterministic overflow warning as distinct diagnostics.

- [x] **Step 5: Implement the read-only PDF renderer and conservative geometry checks.**

  Have the Python script render every page with PyMuPDF at a deterministic resolution, enumerate text/image rectangles, and emit JSON. The TypeScript wrapper must hash the PDF first, isolate outputs by that hash, verify every expected page rendered, and classify only clear page overflow, missing page coverage, or high-confidence suspicious overlap as issues. Do not flag normal equation glyphs, legal full-width content, or scientific numeric text as evidence failures.

- [x] **Step 6: Run focused tests and a real local fixture.**

  Run `node --experimental-strip-types --test test/unit/paper-layout.test.ts test/unit/paper-engine.test.ts` from `packages/autoresearch`. Then use the repository's Tectonic executable (or `TECTONIC_PATH`) on a minimal fixture containing one figure and one numeric evidence tag; verify a PDF is produced, all pages are rendered, and the inspection sidecar contains the PDF hash and page count.

- [x] **Step 7: Run Task 1 typecheck and package build.**

  Run `npm run typecheck` and `npm run build` in `packages/autoresearch`. Fix only Task 1-owned files if either command reports a regression. Leave the worktree uncommitted for parent-agent review.

#### Task 1 execution ledger

- [x] Focused layout/engine tests: 18/18 passed after the FLOAT_LAYOUT and Tectonic probe log-retention fixes.
- [x] `npm run typecheck`, `npm run build`, and `python -m py_compile scripts/inspect-paper-pdf.py` passed.
- [x] Real Tectonic fixtures: ICLR 1 page, generic USENIX 2 pages, and custom double-column 2 pages compiled and rendered with complete page coverage.
- [x] Pipeline boundary regression: registry Tectonic args without `--keep-logs` now produce measured geometry; evidence checkpoint `C:/Users/80163/AppData/Local/Temp/ar-debug-pipeline-9ms4cE/paper/pipeline_checkpoint.json` records one measured ICLR page. The remaining targeted pipeline failure occurs after compile in Task 2 audit/review code.
- [x] Evidence bundle: `C:/Users/80163/AppData/Local/Temp/paper-task1-diff-20260920-130500/task1-manifest.json` and `three-template-results.json`.
- [x] Independent review gate recorded by parent: focused tests/typecheck and five rendered pages inspected; no visual PASS is claimed by the machine inspector (`visuallyReviewed: false`).
- [x] Task 2 protocol and pipeline work completed in its separately owned files; independent review and final gate checks passed.

### Task 2: Independent review protocol, pipeline wiring, and final version gate

**Files:**
- Modify: `packages/autoresearch/src/paper/context.ts` to carry prepared layout, artifact bindings, inspection, review budget, and capability state.
- Modify: `packages/autoresearch/src/paper/checkpoint.ts` to persist version-bound gate records and explicit invalidation/resume state.
- Modify: `packages/autoresearch/src/paper/phases.ts` and `packages/autoresearch/src/paper/pipeline.ts` to prepare/reuse only matching artifacts, invoke read-only reviewers, route repairs to writer/polisher, stop on no progress/budget exhaustion, and recompile/review after polish.
- Modify: `packages/autoresearch/src/agents/types.ts`, `packages/autoresearch/src/agents/roles/types.ts`, `packages/autoresearch/src/agents/roles/paper.ts`, and `packages/autoresearch/src/agents/roles/index.ts` for the review envelope, role names, sections, and schemas.
- Modify: `packages/autoresearch/src/providers/subagent-provider.ts` for native transport of the three independent review roles, bounded repair calls, and capability metadata without allowing reviewers to mutate files.
- Modify: `packages/autoresearch/src/tools/options.ts` and `packages/autoresearch/src/tools/index.ts` for venue/template/layout/review-budget options and tool schema validation.
- Modify: `packages/autoresearch/src/service/project-paper.ts`, `packages/autoresearch/src/service/steps/paper.ts`, and the owning service option types for project-paper forwarding and identity persistence of the selected paper options.
- Modify: `packages/autoresearch/src/index.ts` only for public type/function exports needed by callers.
- Create or modify: `packages/autoresearch/prompts/` files only if the repository's prompt loader requires role-specific prompt text; keep prompt content aligned with the role specs.
- Test: `packages/autoresearch/test/unit/paper-review-protocol.test.ts` for schemas, capability wording, binding, budget, and no-progress behavior.
- Test: `packages/autoresearch/test/unit/paper-pipeline.test.ts` or the existing paper workflow/resume tests for invalidation, polish rerun, final gate, and evidence-audit preservation.
- Test: `packages/autoresearch/test/unit/tools.test.ts`, `project-paper.test.ts`, and `subagent-provider.test.ts` for option forwarding and native role transport.

**Interfaces:**
- Consumes Task 1's `PreparedPaperLayout`, `CompileResult`, and `PaperPdfInspection`; it must not reimplement template parsing, PDF rendering, or geometry checks.
- Produces `PaperReviewVerdict`, `PaperArtifactBinding`, and `PaperReviewResult` exactly as specified in the design spec.
- Adds role names `figure-reviewer`, `paper-contract-reviewer`, and `layout-reviewer`; all return the common structured review envelope. Existing academic roles and evidence audit files remain intact.
- The final gate evaluates compile diagnostics, complete inspection coverage, academic audit status, and applicable review verdicts. A machine-only capability can produce `PASS` for deterministic checks only when the role schema says visual judgment was not required; it cannot claim visual PASS without `capability.visual === 'actual'`.

- [x] **Step 1: Write failing protocol and checkpoint tests.**

  Add fixtures with fixed source/template/asset/evidence/PDF hashes. Assert that a matching review is reusable, a source/template/asset/PDF mutation invalidates it, a resumed run enters the invalidated phase, a no-progress loop returns `BLOCKED`, and a budget limit prevents extra provider calls. Assert that numeric/citation evidence audits remain required in the final gate.

- [x] **Step 2: Run the focused protocol tests and confirm failure.**

  Run `node --experimental-strip-types --test test/unit/paper-review-protocol.test.ts test/unit/paper-pipeline.test.ts` from `packages/autoresearch`. Expected result: the new protocol types, role names, or invalidation behavior are missing or fail assertions.

- [x] **Step 3: Add version-bound context and checkpoint records.**

  Extend `PaperContext` with the prepared layout, compile/inspection outputs, artifact binding, and review budget. Extend checkpoint data with binding, per-role results, invalidation reason, remaining budget, and progress marker. On load, compare hashes and mark stale gates invalid before any phase can return cached success.

- [x] **Step 4: Register independent roles and structured prompts.**

  Add schemas and prompt sections for figure source constraints/readability/evidence linkage, acceptance-contract compliance, and deterministic/PDF layout checks. Migrate `paper-reviewer` to the common envelope while retaining score/critical/major/minor fields needed by the improvement loop. State read-only behavior, artifact paths/hashes, finite budget, and machine-only visual limitations in every prompt.

- [x] **Step 5: Wire provider transport and option forwarding.**

  Ensure the native provider accepts the new roles, applies the same request ledger and JSON repair policy, and exposes capability metadata. The host must generate and validate binding hashes, stable issue IDs/locations, visual capability, and budget counters; never trust those fields from model JSON. Extend tool options for venue, custom template directory/file, layout inspection, review budget, and visual capability. Forward the validated options through `service/steps/paper.ts`, project-paper identity storage/validation, and public exports without leaking arbitrary unvalidated fields.

- [x] **Step 6: Wire read-only review and repair phases.**

  Invoke the independent reviewers after compilation and after every source mutation. Feed their structured issues to the writer/polisher repair path, persist each result with its binding, and invalidate dependent results immediately after a repair. Preserve the existing evidence audits and their fail-closed semantics; deterministic compile/layout failures are surfaced before reviewer suggestions.

- [x] **Step 7: Add the final polish and rerun gate.**

  After `paper-polisher`, compile again, run complete PDF inspection, rerun all applicable independent reviewers, and write the final report only from matching artifacts. Set `submissionReady` only when compile, inspection coverage, academic evidence audits, and required review verdicts pass; draft assurance still forces it false. For submission assurance, incomplete inspection or any required `BLOCKED` review saves a `BLOCKED` resumable state with remaining budget and never emits a submission-ready result.

#### Task 2 execution ledger

- [x] Independent roles are wired as `figure-reviewer`, `paper-contract-reviewer`, `layout-reviewer`, and the version-bound `paper-reviewer`; academic proof/claim/citation/kill audits remain separate required checks.
- [x] The two paper-specific self-reflexion loops were replaced: contract negotiation now has a direct writer contract call followed by the independent contract reviewer, and figure generation no longer self-reviews generated scripts; the independent figure reviewer handles source/image/caption review. Research reflexion remains available to the writer through `REFLEXION.md`, and failure reflexion recording remains unchanged.
- [x] Host-side artifact bindings, stable issue locations, capability, image receipts, read-only tool restrictions, and request/round budgets are persisted and invalidated on source/template/asset/evidence/PDF changes.
- [x] Final polish invalidates the previous gate and reruns compilation, inspection, audits, and applicable independent reviewers.
- [x] Final independent review: three Important findings and the architecture finding were marked addressed; the reviewer reported 9/9 targeted tests and SHA verification for 8 repair files.
- [x] Root full package test passed (`631/631`, 0 failures, 0 skips); original-workspace build/typecheck both exited 0; 43-file SHA verification had zero mismatches and immutable protected baseline hashes remained unchanged.

- [x] **Step 8: Run focused tests, full tests, typecheck, and real paper regression.**

  Run `node --experimental-strip-types --test test/unit/paper-review-protocol.test.ts test/unit/paper-pipeline.test.ts test/unit/tools.test.ts test/unit/project-paper.test.ts test/unit/subagent-provider.test.ts` from `packages/autoresearch`. Then run `npm test` and `npm run typecheck` in `packages/autoresearch`. Finally run a real Tectonic paper fixture through the pipeline, inspect every PDF page, verify the final report includes matching hashes, and verify a post-polish source change invalidates the pre-polish gate before the rerun.

  Root full package test result: `631/631` passed, `0` failed, `0` skipped in `409180.8047ms`; log: `C:/Users/80163/AppData/Local/Temp/paper-review-full-test-final-root.log`. The original workspace `npm run build` and `npm run typecheck` both exited 0; post-copy verification found zero SHA mismatches across 43 implementation files and preserved the immutable protected baseline hashes.

## Completion checklist

- [x] Task 1 tests, build, and typecheck pass with ICLR, generic USENIX, and custom-template fixtures.
- [x] Task 2 protocol, invalidation, budget, provider, service, and option tests pass in the targeted review set.
- [x] The real PDF regression compiles with Tectonic, renders every page, and records page geometry and artifact hashes.
- [x] Academic evidence audits still fail closed for missing/invalid evidence and are not bypassed by layout inspection.
- [x] Full package test suite and typecheck pass in the reviewed worktree; the original workspace build/typecheck also pass after integration.
- [x] Parent agent review and final merge/baseline conflict check completed; this worktree has no commit or push.
