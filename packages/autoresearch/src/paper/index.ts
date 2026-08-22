import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ResearchTree } from '../core/research-tree.js'
import { atomicWriteJson, writeText } from '../core/utils.js'
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
7. Limitations
8. Conclusion

## Figures

- To be generated from evidence/results.

## References

- To be filled by writer from sources.
`
  const planFile = join(paperDir, 'PAPER_PLAN.md')
  await writeText(planFile, plan)
  return { planFile, matrixFile }
}

// ---------- Audit ----------

export interface AuditResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

async function readTextSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function readPaperSources(paperDir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(paperDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.tex') || entry.name.endsWith('.bib'))) {
      files.push(join(paperDir, entry.name))
    } else if (entry.isDirectory()) {
      const sub = await readdir(join(paperDir, entry.name), { withFileTypes: true }).catch(() => [])
      for (const subEntry of sub) {
        if (subEntry.isFile() && (subEntry.name.endsWith('.tex') || subEntry.name.endsWith('.bib'))) {
          files.push(join(paperDir, entry.name, subEntry.name))
        }
      }
    }
  }
  return files
}

function numericClaimAudit(text: string, knownEvidenceIds: Set<string>): AuditResult {
  const errors: string[] = []
  const lines = text.split('\n')
  const evidenceTagRe = /% evidence:\s*(E-[A-Za-z0-9_]+|B-[A-Za-z0-9_]+)/g
  const numberRe = /\d+\.\d+|\b\d+\b/g

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().startsWith('%')) continue
    const numbers = line.match(numberRe)
    if (!numbers) continue
    const nearby = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join('\n')
    const tags = [...nearby.matchAll(evidenceTagRe)].map((m) => m[1] ?? '').filter(Boolean)
    if (tags.length === 0) {
      errors.push(`line ${i + 1}: numeric value without evidence tag: ${line.trim()}`)
      continue
    }
    for (const tag of tags) {
      if (!knownEvidenceIds.has(tag)) errors.push(`line ${i + 1}: unknown evidence tag ${tag}`)
    }
  }

  for (const match of text.matchAll(evidenceTagRe)) {
    const tag = match[1] ?? ''
    if (tag && !knownEvidenceIds.has(tag)) errors.push(`unknown evidence tag ${tag}`)
  }

  return { ok: errors.length === 0, errors, warnings: [] }
}

function citationAudit(tex: string, bib: string): AuditResult {
  const errors: string[] = []
  const bibKeys = new Set([...bib.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]?.trim() ?? ''))
  const cited = new Set([...tex.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)))
  for (const key of cited) {
    if (!bibKeys.has(key)) errors.push(`citation ${key} is not present in references.bib`)
  }
  return { ok: errors.length === 0, errors, warnings: [] }
}

export async function auditPaper(runDir: string, knownEvidenceIds: string[]): Promise<{ numeric: AuditResult; citation: AuditResult }> {
  const paperDir = join(runDir, 'paper')
  const sources = await readPaperSources(paperDir)
  const texTexts = await Promise.all(sources.filter((f) => f.endsWith('.tex')).map((f) => readTextSafe(f)))
  const bibTexts = await Promise.all(sources.filter((f) => f.endsWith('.bib')).map((f) => readTextSafe(f)))
  const allTex = texTexts.join('\n')
  const allBib = bibTexts.join('\n')
  const known = new Set(knownEvidenceIds)
  const numeric = numericClaimAudit(allTex, known)
  const citation = citationAudit(allTex, allBib)
  const result = { numeric, citation }
  await atomicWriteJson(join(paperDir, 'paper_audit.json'), result)
  return result
}

// ---------- Compile ----------

export interface CompileResult {
  ok: boolean
  engine: string | undefined
  output: string
}

function findLatexEngine(): string | undefined {
  const candidates = ['xelatex', 'tectonic', 'latexmk', 'pdflatex']
  for (const name of candidates) {
    const probe = spawnSync(name, ['--version'], { stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return name
    if (name === 'latexmk') {
      const probe2 = spawnSync(name, ['-version'], { stdio: 'ignore' })
      if (!probe2.error && probe2.status === 0) return name
    }
  }
  for (const candidate of ['D:\\Tectonic\\bin\\tectonic.exe', 'C:\\Tectonic\\bin\\tectonic.exe']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function compilePaper(paperDir: string): Promise<CompileResult> {
  const engine = findLatexEngine()
  if (!engine) return { ok: false, engine: undefined, output: 'no LaTeX engine found' }
  const engineName = basename(engine).replace(/\.exe$/i, '')
  let result
  if (engineName === 'latexmk') {
    result = spawnSync(engine, ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: paperDir, stdio: 'pipe', encoding: 'utf8' })
  } else if (engineName === 'tectonic') {
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    if (!process.env.ALL_PROXY) process.env.ALL_PROXY = 'http://127.0.0.1:7890'
    result = spawnSync(engine, ['main.tex'], { cwd: paperDir, stdio: 'pipe', encoding: 'utf8' })
  } else {
    result = spawnSync(engine, ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: paperDir, stdio: 'pipe', encoding: 'utf8' })
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const ok = result.status === 0 && existsSync(join(paperDir, 'main.pdf'))
  return { ok, engine, output }
}

export async function runCompileLoop(
  paperDir: string,
  fix: (feedback: string) => Promise<void>,
  maxRounds = 2,
): Promise<{ ok: boolean; rounds: number }> {
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

