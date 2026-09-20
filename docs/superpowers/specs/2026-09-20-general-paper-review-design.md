# General Paper Layout and Review Design

## Purpose

The paper workflow must produce a reproducible, venue-aware PDF and must be
able to explain whether that PDF satisfies the requested contract. The current
workflow assumes ICLR assets, lets each role infer layout constraints, and
reuses checkpoint/audit state after a source or PDF change. This design adds a
template adapter, deterministic compile and PDF inspection artifacts, and
independent review roles with explicit version binding.

The default template remains ICLR. USENIX support is a real USENIX template
profile and must not be presented as a particular conference profile such as
SEC26. A caller may provide a custom template directory and/or entry template.
The adapter copies and records the selected assets; it does not claim that a
regular expression can completely understand arbitrary LaTeX.

## Scope and invariants

- Layout decisions are made from one `PaperLayoutProfile` used by template
  preparation, figure generation, compile diagnostics, and PDF inspection.
- The profile records page and column geometry in PDF points (72 points/inch).
  Any TeX dimensions are converted with the explicit 72.27 points/inch factor
  and are never compared as if they used the PDF unit.
- Figure generation receives measured column width, usable height, body/caption
  font sizes, and a bounded figure policy. A figure may be flagged as
  `unknown` when the source format does not expose enough information.
- Compile warnings and deterministic source/template errors are higher
  priority than probabilistic review observations. Diagnostics are persisted
  separately from scientific evidence audits so layout probes cannot weaken
  numeric or citation checking.
- PDF inspection is read-only. It renders every page into a PDF-hash-isolated
  directory and records text/image bounding boxes, page geometry, coverage, and
  conservative overlap/overflow suspicions. A machine inspection is not a
  visual PASS when no actual visual reviewer or image-capable model was used.
- `supportsImageInput: false` explicitly disables native image delivery;
  `undefined` lets the host query the selected provider/model metadata and use
  native image delivery when `inputModalities` includes `image`.
- Native figure/page image delivery records a host-generated attachment receipt
  containing each attachment ID, source path hash, and role/request identity;
  reviewer JSON cannot claim that an image was attached or viewed.
- Existing proof, claim, citation, kill-argument, numeric, and citation audits
  remain required academic evidence checks.
- Reviewers are independent and read-only. The writer/polisher or a dedicated
  repair role may modify sources. A review result records the exact source,
  template, assets, evidence, and PDF hashes it observed.
- Any source, template, asset, or PDF mutation invalidates old review results
  and the relevant checkpoint. Resume must recompute the invalidated gate; it
  may not treat a prior PASS as current.
- Each review loop has an explicit request/round budget. If a round produces no
  progress, or the budget is exhausted, it stops with `BLOCKED` and a resumable
  record. Resume starts from the invalidated gate with remaining budget; it
  never silently reuses an old final gate.

## Data contracts

The first implementation worker must keep these names and semantics stable,
while choosing the smallest internal decomposition that matches existing
repository conventions.

```ts
export type PaperVenue = 'ICLR' | 'USENIX' | 'custom'

export interface PaperLayoutProfile {
  schema: 'autoresearch/paper-layout-profile/v1'
  venue: PaperVenue
  templateName: string
  templateHash: string
  assetHashes: Record<string, string>
  page: { widthPt: number; heightPt: number; marginPt: { top: number; right: number; bottom: number; left: number } }
  columns: { count: number; widthPt: number; gutterPt: number }
  typography: { bodyPt: number; captionPt: number; lineHeightPt?: number }
  figure: { maxWidthPt: number; maxHeightPt?: number; captionWidthPt: number; allowedFormats: string[] }
  units: { pdfPointPerInch: 72; texPointPerInch: 72.27 }
}

export interface PreparedPaperLayout {
  profile: PaperLayoutProfile
  templateFile: string
  assetFiles: string[]
  sourceHash: string
  assetHashes: Record<string, string>
}

/** Host-supplied geometry for a custom template; identity hashes are generated during preparation. */
export interface PaperLayoutGeometryInput {
  page: { widthPt: number; heightPt: number; marginPt: { top: number; right: number; bottom: number; left: number } }
  columns: { count: number; widthPt: number; gutterPt: number }
  typography?: { bodyPt: number; captionPt: number; lineHeightPt?: number }
  figure?: { maxWidthPt: number; maxHeightPt?: number; captionWidthPt: number; allowedFormats: string[] }
}

export interface PreparePaperLayoutOptions {
  venue?: PaperVenue
  templateDir?: string
  templateFile?: string
  /** Required for a custom template when safe metadata measurement is unavailable. */
  profile?: PaperLayoutGeometryInput
}

export async function preparePaperLayout(
  paperDir: string,
  options?: PreparePaperLayoutOptions,
): Promise<PreparedPaperLayout>
```

`templateDir` is the source of truth for custom assets; `templateFile` selects
the entry file when one is not discoverable. Built-in ICLR and USENIX assets
must be versioned under the package template area and copied into the run's
paper directory. A custom profile must state its dimensions explicitly when
they cannot be safely derived from metadata.

Preparation must fail closed with a stable `UNKNOWN_TEMPLATE` error when a
venue name is unsupported and no custom template is supplied. A custom
template that has no safe geometry metadata and no explicit geometry `profile` must
fail with `CUSTOM_TEMPLATE_PROFILE_REQUIRED`; silently falling back to ICLR
dimensions is invalid.

The preparation `sourceHash` binds the selected template, assets, and resolved
profile. Compilation computes a separate fresh source hash over the current
entry source, sections, bibliography, and figure dependencies; that hash is
the one used to bind a PDF and later review checkpoints. It includes paper
TeX/Bib, LaTeX template support files, and figure inputs, while excluding
compiler intermediates, generated PDFs, checkpoints, audits, review reports,
inspection sidecars, and other control artifacts.

```ts
export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  source?: string
  line?: number
}

export interface CompileResult {
  ok: boolean
  engine?: string
  output: string
  diagnostics: CompileDiagnostic[]
  sourceHash?: string
  templateHash?: string
  assetHashes?: Record<string, string>
  geometry?: {
    status: 'measured' | 'unknown'
    measurementSource?: string
    pageCount?: number
    pageWidthPt?: number
    pageHeightPt?: number
    columns?: number
    textWidthPt?: number
    textHeightPt?: number
    columnWidthPt?: number
    columnSepPt?: number
    pages?: Array<{ page: number; pageWidthPt: number; pageHeightPt: number; textWidthPt: number; textHeightPt: number; columnWidthPt: number; columnSepPt: number; columns: number }>
  }
  inspection?: PaperPdfInspection
}

export interface InspectPaperPdfOptions {
  pdfPath?: string
  layout?: PaperLayoutProfile
  renderDir?: string
  renderer?: 'fitz'
}

export interface PaperPdfInspection {
  schema: 'autoresearch/paper-pdf-inspection/v1'
  pdfHash: string
  pdfPath: string
  pages: Array<{ page: number; imagePath: string; widthPt: number; heightPt: number; textBoxes: number; imageBoxes: number }>
  issues: Array<{ code: string; severity: 'warning' | 'error'; page?: number; detail: string }>
  coverage: { complete: boolean; renderedPages: number; pageCount: number; visuallyReviewed: boolean }
}

export async function inspectPaperPdf(
  paperDir: string,
  options?: InspectPaperPdfOptions,
): Promise<PaperPdfInspection>
```

`compilePaper` keeps its existing one-argument behavior and adds an optional
layout/options argument. The returned diagnostics and measured geometry are
additive, so existing callers remain source-compatible. `inspectPaperPdf`
must leave the scientific claim audit's `.tex` parsing unchanged; layout
measurement is a sidecar artifact and is never substituted for evidence
tags. The compiler also runs a disposable copy of the current source through
a TeX probe. The probe records actual physical page, text, column, and
column-separation dimensions per observed page, converts TeX points (72.27/in)
to PDF points (72/in), and is deleted after measurement. The host requires
successful probe compilation and equal probe/PDF page coverage before marking
geometry measured; if either check fails, geometry remains `unknown`. A preset
profile is never reported as a measurement. The compile result carries the
already-produced `PaperPdfInspection` so later gates do not re-render it.

## Review protocol

Every independent review uses this envelope:

```ts
export type PaperReviewVerdict = 'PASS' | 'REVISE' | 'BLOCKED'

export interface PaperArtifactBinding {
  sourceHash: string
  templateHash: string
  assetHashes: Record<string, string>
  evidenceHash: string
  pdfHash?: string
  inspectionHash?: string
}

export interface PaperReviewResult {
  schema: 'autoresearch/paper-review/v1'
  role: 'figure-reviewer' | 'paper-contract-reviewer' | 'layout-reviewer' | 'paper-reviewer'
  verdict: PaperReviewVerdict
  issues: Array<{
    id: string
    severity: 'critical' | 'major' | 'minor'
    code: string
    detail: string
    location?: { source?: string; page?: number; objectId?: string }
    repair?: string
  }>
  binding: PaperArtifactBinding
  capability: { visual: 'actual' | 'machine-only' | 'unavailable'; notes?: string }
  budget: { used: number; limit: number; progress: boolean }
}
```

The model/provider returns only an untrusted candidate verdict and issue
descriptions. The host creates the binding, stable issue IDs, source/page/object
locations, capability value, and budget counters from observed inputs and
provider configuration. A model cannot self-report visual capability, grant
itself file-write permission, or increase its request budget. The host maps an
untrusted visual assertion to `machine-only` or `unavailable` unless an actual
image-capable reviewer was recorded for that run.

The existing `paper-reviewer` is migrated to this envelope while retaining its
content score fields where useful. `figure-reviewer` checks source figure
dimensions, captions, labels, readability, and evidence linkage. It cannot
edit. `paper-contract-reviewer` checks the acceptance contract, section and
deliverable requirements, and evidence wording. `layout-reviewer` checks
compile diagnostics, profile geometry, page inspection, and figure placement.
Their prompts must say that machine-only inspection cannot claim visual PASS.

The final gate is the conjunction of deterministic compile success, complete
PDF inspection, academic evidence audit success, and all applicable review
verdicts. Draft assurance may retain a compiled PDF for iteration but always
sets `submissionReady` to false. Submission assurance with incomplete
inspection or a required review that is `BLOCKED` is itself `BLOCKED`, never a
submission-ready result. After `paper-polisher` changes a source, the pipeline
must compile, inspect, and rerun all applicable independent reviewers before
writing the final report. An old review/checkpoint whose binding differs is
marked invalidated and cannot satisfy the gate.

## Execution boundaries

Implementation is split into two independently testable tasks:

1. Layout adapter, deterministic compile diagnostics, PDF inspection/rendering,
   template assets, and their tests.
2. Review envelope, independent role prompts and native transport, pipeline
   binding/invalidation/budget behavior, option/service forwarding, final gate,
   and their tests.

The tasks coordinate only through the contracts above and the exported layout
functions. Task 1 does not edit the workflow or role files. Task 2 consumes the
layout outputs and does not duplicate PDF geometry logic.

## Verification requirements

The final implementation must run real Tectonic compilation when available,
render every resulting page with the available PyMuPDF/PIL inspection path,
exercise the default ICLR, generic USENIX, and custom-template paths, and run
the package's full tests and typecheck. Evidence audits must be tested with
scientific numeric claims so layout probes cannot make them pass by omission.
