import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchTree } from '../core/research-tree.js'
import { atomicWriteJson, writeText } from '../core/utils.js'
import { findLatexEngine, type ResolvedLatexEngine } from './engine.js'
import { hashPaperSources, inspectPaperPdf, measurePaperLayout, parseCompileDiagnostics, type CompileDiagnostic, type InspectPaperPdfOptions, type PaperLayoutMeasurement, type PaperLayoutProbeEngine, type PaperLayoutProfile, type PaperPdfInspection, type PreparedPaperLayout, preparePaperLayout, validatePageGeometry } from './layout.js'
export { findLatexEngine, latexEngines, type LatexEngine, type ResolvedLatexEngine } from './engine.js'
export { hashPaperSources, inspectPaperPdf, measurePaperLayout, parseCompileDiagnostics, preparePaperLayout, validatePageGeometry }
export type { CompileDiagnostic, InspectPaperPdfOptions, PaperLayoutGeometryInput, PaperLayoutMeasurement, PaperLayoutMeasurementPage, PaperLayoutProbeEngine, PaperLayoutProfile, PaperPdfInspection, PreparedPaperLayout, PaperVenue, PreparePaperLayoutOptions } from './layout.js'
export { auditPaper, type AuditPaperInput, type AuditResult } from './audit.js'
export { downloadReferencePdfs, parseBibEntries, resolvePdfCandidates, safeFileName } from './references.js'
export type { BibEntry, CitationPdfRecord, DownloadReferencePdfsOptions } from './references.js'

// ---------- Plan ----------

export interface ClaimsEvidenceMatrix {
  schema: 'autoresearch/claims-evidence-matrix/v1'
  claims: Array<{
    claim_id: string
    hypothesis_id: string
    evidence_ids: string[]
    verdict: string
    allowed_wording: string
  }>
}

export async function generatePaperPlan(runDir: string, tree: ResearchTree): Promise<{ planFile: string; matrixFile: string }> {
  const paperDir = join(runDir, 'paper')
  await mkdir(paperDir, { recursive: true })
  const hypotheses = tree.query({ kind: 'hypothesis' })
  const actions = tree.query({ kind: 'action' })
  const evidence = tree.query({ kind: 'evidence' })
  const matrix: ClaimsEvidenceMatrix = {
    schema: 'autoresearch/claims-evidence-matrix/v1',
    claims: hypotheses.map((hyp, index) => {
      const hypActions = actions.filter((a) => a.parent === hyp.id)
      const evidenceIds = evidence
        .filter((e) => hypActions.some((a) => a.id === e.parent) || e.parent === hyp.id)
        .map((e) => e.id)
      const verdicts = evidence.filter((e) => evidenceIds.includes(e.id)).map((e) => e.status)
      const verdict = verdicts.includes('supports') ? 'supported' : verdicts.includes('refutes') ? 'refuted' : 'inconclusive'
      return {
        claim_id: `claim-${index + 1}`,
        hypothesis_id: hyp.id,
        evidence_ids: evidenceIds,
        verdict,
        allowed_wording: hyp.content,
      }
    }),
  }
  const matrixFile = join(paperDir, 'claims_evidence_matrix.json')
  await atomicWriteJson(matrixFile, matrix)
  const plan = `# PAPER PLAN

## Claims-Evidence Matrix

| Claim | Hypothesis | Evidence | Verdict |
|---|---|---|---|
${matrix.claims.map((c) => `| ${c.claim_id} | ${c.hypothesis_id} | ${c.evidence_ids.join(', ') || '-'} | ${c.verdict} |`).join('\n')}

## Structure

1. Abstract
2. Introduction
3. Related Work
4. Method
5. Experiments
6. Results
7. Conclusion

## Figures

- To be generated from evidence/results.

## References

- To be filled by writer from sources.
`
  const planFile = join(paperDir, 'PAPER_PLAN.md')
  await writeText(planFile, plan)
  return { planFile, matrixFile }
}

// ---------- Compile ----------

export interface CompileResult {
  ok: boolean
  engine: string | undefined
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
    pages?: PaperLayoutMeasurement['pages']
  }
  inspection?: PaperPdfInspection
}

export interface CompilePaperOptions {
  layout?: PaperLayoutProfile | PreparedPaperLayout
  engine?: ResolvedLatexEngine
  inspect?: boolean
}

function validateMeasuredLayout(measurement: PaperLayoutMeasurement, profile?: PaperLayoutProfile): CompileDiagnostic[] {
  if (!profile || measurement.status !== 'measured') return []
  const expectedTextWidth = profile.columns.count * profile.columns.widthPt + (profile.columns.count - 1) * profile.columns.gutterPt
  const expectedTextHeight = profile.page.heightPt - profile.page.marginPt.top - profile.page.marginPt.bottom
  const tolerance = 1.5
  const diagnostics: CompileDiagnostic[] = []
  for (const page of measurement.pages) {
    const mismatches: string[] = []
    const checks: Array<[string, number, number]> = [
      ['pageWidthPt', page.pageWidthPt, profile.page.widthPt],
      ['pageHeightPt', page.pageHeightPt, profile.page.heightPt],
      ['textWidthPt', page.textWidthPt, expectedTextWidth],
      ['textHeightPt', page.textHeightPt, expectedTextHeight],
      ['columnWidthPt', page.columnWidthPt, profile.columns.widthPt],
    ]
    if (profile.columns.count > 1) checks.push(['columnSepPt', page.columnSepPt, profile.columns.gutterPt])
    for (const [name, actual, expected] of checks) if (Math.abs(actual - expected) > tolerance) mismatches.push(`${name}=${actual.toFixed(3)} expected=${expected.toFixed(3)}`)
    if (page.columns !== profile.columns.count) mismatches.push(`columns=${page.columns} expected=${profile.columns.count}`)
    if (mismatches.length > 0) diagnostics.push({ severity: 'error', code: 'LAYOUT_PROFILE_MISMATCH', message: `page ${page.page}: ${mismatches.join(', ')}`, source: 'tex-probe' })
  }
  return diagnostics
}

export async function compilePaper(paperDir: string, options: CompilePaperOptions = {}): Promise<CompileResult> {
  const resolved = options.engine ?? findLatexEngine()
  const layout = options.layout && 'profile' in options.layout ? options.layout.profile : options.layout
  const sourceHash = await hashPaperSources(paperDir)
  if (!resolved) return { ok: false, engine: undefined, output: 'no LaTeX engine found', diagnostics: [{ severity: 'error', code: 'ENGINE_UNAVAILABLE', message: 'no LaTeX engine found' }], sourceHash, ...(layout ? { templateHash: layout.templateHash, assetHashes: layout.assetHashes } : {}) }
  try {
    for (const file of ['main.pdf', 'main_polished.pdf', 'main.log']) {
      try { await unlink(join(paperDir, file)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    return {
      ok: false,
      engine: resolved.command,
      output: `failed to remove stale compiler output: ${String(error)}`,
      diagnostics: [{ severity: 'error', code: 'STALE_OUTPUT_CLEANUP_FAILED', message: String(error) }],
      sourceHash,
      ...(layout ? { templateHash: layout.templateHash, assetHashes: layout.assetHashes } : {}),
    }
  }
  const env = resolved.spec.env?.()
  const result = spawnSync(resolved.command, [...resolved.spec.args(paperDir)], {
    cwd: paperDir,
    stdio: 'pipe',
    encoding: 'utf8',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  let output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  try { output += `\n${await readFile(join(paperDir, 'main.log'), 'utf8')}` } catch { /* compiler may not emit a log */ }
  const diagnostics = parseCompileDiagnostics(output)
  if (result.status !== 0) diagnostics.push({ severity: 'error', code: 'COMPILER_EXIT', message: `compiler exited with status ${result.status ?? 'unknown'}` })
  const pdfExists = existsSync(join(paperDir, 'main.pdf'))
  if (!pdfExists) diagnostics.push({ severity: 'error', code: 'PDF_MISSING', message: 'compiler did not produce main.pdf' })
  const compile: CompileResult = {
    ok: result.status === 0 && pdfExists,
    engine: resolved.command,
    output,
    diagnostics,
    sourceHash,
    ...(layout ? { templateHash: layout.templateHash, assetHashes: layout.assetHashes } : {}),
  }
  if (compile.ok) {
    const inspection = options.inspect === false ? undefined : await inspectPaperPdf(paperDir, { layout })
    if (inspection) {
      compile.inspection = inspection
      compile.diagnostics.push(...inspection.issues.map(issue => ({ severity: issue.severity, code: issue.code, message: issue.detail, source: issue.page === undefined ? 'pdf' : `pdf page ${issue.page}` })))
    }
    const measurement = await measurePaperLayout(paperDir, {
      engine: { name: resolved.name, command: resolved.command, args: resolved.spec.args, env: resolved.spec.env } satisfies PaperLayoutProbeEngine,
    })
    compile.diagnostics.push(...measurement.diagnostics)
    compile.diagnostics.push(...validateMeasuredLayout(measurement, layout))
    const first = measurement.pages[0]
    const hasPdfCoverage = Boolean(inspection?.coverage.complete && inspection.coverage.pageCount === measurement.pages.length)
    compile.geometry = measurement.status === 'measured' && first && hasPdfCoverage
      ? {
        status: 'measured', measurementSource: 'tex-probe', pageCount: measurement.pages.length,
        pageWidthPt: first.pageWidthPt, pageHeightPt: first.pageHeightPt, columns: first.columns,
        textWidthPt: first.textWidthPt, textHeightPt: first.textHeightPt, columnWidthPt: first.columnWidthPt,
        columnSepPt: first.columnSepPt, pages: measurement.pages,
      }
      : {
        status: 'unknown', measurementSource: 'tex-probe',
        ...(inspection ? { pageCount: inspection.coverage.pageCount, ...(inspection.pages[0] ? { pageWidthPt: inspection.pages[0].widthPt, pageHeightPt: inspection.pages[0].heightPt } : {}) } : {}),
      }
  }
  return compile
}

export interface RunCompileLoopInput {
  paperDir: string
  fix: (feedback: string) => Promise<void>
  maxRounds?: number
}

export async function runCompileLoop(input: RunCompileLoopInput): Promise<{ ok: boolean; rounds: number }>
export async function runCompileLoop(
  paperDir: string,
  fix: (feedback: string) => Promise<void>,
  maxRounds?: number,
): Promise<{ ok: boolean; rounds: number }>
export async function runCompileLoop(
  inputOrPaperDir: RunCompileLoopInput | string,
  maybeFix?: (feedback: string) => Promise<void>,
  maybeMaxRounds?: number,
): Promise<{ ok: boolean; rounds: number }> {
  let input: RunCompileLoopInput
  if (typeof inputOrPaperDir === 'string') {
    if (!maybeFix) throw new TypeError('runCompileLoop requires a fix callback')
    input = { paperDir: inputOrPaperDir, fix: maybeFix, maxRounds: maybeMaxRounds ?? 5 }
  } else {
    input = inputOrPaperDir
  }
  const { paperDir, fix, maxRounds = 5 } = input
  await mkdir(paperDir, { recursive: true })
  let last: CompileResult = { ok: false, engine: undefined, output: 'not run', diagnostics: [] }
  for (let round = 0; round <= maxRounds; round += 1) {
    last = await compilePaper(paperDir)
    if (last.ok) {
      if (round > 0) await copyFile(join(paperDir, 'main.pdf'), join(paperDir, `main_round${round}.pdf`))
      return { ok: true, rounds: round }
    }
    if (round < maxRounds) await fix(last.output)
  }
  return { ok: false, rounds: maxRounds }
}
