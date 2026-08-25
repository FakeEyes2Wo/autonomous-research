import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchTree } from '../core/research-tree.js'
import { atomicWriteJson, writeText } from '../core/utils.js'
import { findLatexEngine } from './engine.js'
export { findLatexEngine, latexEngines, type LatexEngine, type ResolvedLatexEngine } from './engine.js'
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
}

export async function compilePaper(paperDir: string): Promise<CompileResult> {
  const resolved = findLatexEngine()
  if (!resolved) return { ok: false, engine: undefined, output: 'no LaTeX engine found' }
  const env = resolved.spec.env?.()
  const result = spawnSync(resolved.command, [...resolved.spec.args(paperDir)], {
    cwd: paperDir,
    stdio: 'pipe',
    encoding: 'utf8',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const ok = result.status === 0 && existsSync(join(paperDir, 'main.pdf'))
  return { ok, engine: resolved.command, output }
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
  let last: CompileResult = { ok: false, engine: undefined, output: 'not run' }
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
