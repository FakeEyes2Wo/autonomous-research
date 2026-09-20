import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hashPaperSources, type CompileResult, type PaperPdfInspection, type PreparedPaperLayout } from './index.js'
import type { PaperImageReceipt } from '../agents/types.js'

export type PaperReviewVerdict = 'PASS' | 'REVISE' | 'BLOCKED'
export type PaperReviewRole = 'figure-reviewer' | 'paper-contract-reviewer' | 'layout-reviewer' | 'paper-reviewer'
export interface PaperArtifactBinding {
  sourceHash: string; templateHash: string; assetHashes: Record<string, string>; evidenceHash: string; pdfHash?: string; inspectionHash?: string
}
export interface PaperReviewResult {
  schema: 'autoresearch/paper-review/v1'
  role: PaperReviewRole
  verdict: PaperReviewVerdict
  issues: Array<{ id: string; severity: 'critical' | 'major' | 'minor'; code: string; detail: string; location?: { source?: string; page?: number; objectId?: string }; repair?: string }>
  binding: PaperArtifactBinding
  capability: { visual: 'actual' | 'machine-only' | 'unavailable'; notes?: string }
  budget: { used: number; limit: number; progress: boolean }
  score?: number
  imageReceipt?: PaperImageReceipt
  critical?: string[]; major?: string[]; minor?: string[]
}
export interface PaperReviewBudget { used: number; limit: number; rounds: number; maxRounds: number; sequence: number }
export interface PaperFinalGate { verdict: PaperReviewVerdict; submissionReady: boolean; reasons: string[] }
export function paperHash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function samePaperBinding(a?: PaperArtifactBinding, b?: PaperArtifactBinding): boolean { return !!a && !!b && canonical(a) === canonical(b) }
export async function admitPaperReview(budget: PaperReviewBudget, save: () => Promise<void>): Promise<void> {
  if (budget.used >= budget.limit) throw new Error('paper review request budget exhausted')
  budget.used++; budget.sequence++
  await save()
}

/** Fingerprint current bytes, including page images; neither checkpoints nor model JSON are authorities. */
export async function bindPaperArtifacts(paperDir: string, evidencePath: string, layout: PreparedPaperLayout, inspection?: PaperPdfInspection): Promise<PaperArtifactBinding> {
  const assetHashes: Record<string, string> = {}
  for (const path of layout.assetFiles) assetHashes[relative(paperDir, path).replaceAll('\\', '/')] = paperHash(await readFile(path))
  const figureAssets = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Figure dependency symlinks require explicit materialized assets')
      if (entry.isDirectory()) await figureAssets(path)
      else if (entry.isFile()) assetHashes[relative(paperDir, path).replaceAll('\\', '/')] = paperHash(await readFile(path))
    }
  }
  await figureAssets(join(paperDir, 'figures'))
  for (const name of ['paper-layout-profile.json', 'layout_profile.json']) assetHashes[name] = paperHash(await readFile(join(paperDir, name)))
  const evidence: Record<string, string> = { evidence: paperHash(await readFile(evidencePath)) }
  for (const name of ['PAPER_PLAN.md', 'claims_evidence_matrix.json', 'PAPER_ACCEPTANCE_CONTRACT.md']) {
    evidence[name] = paperHash(await readFile(join(paperDir, name)).catch(() => Buffer.from('MISSING')))
  }
  evidence.failureReport = paperHash(await readFile(join(paperDir, '..', 'FAILURE_REPORT.md')).catch(() => Buffer.from('MISSING')))
  const pdf = await readFile(join(paperDir, 'main.pdf')).catch(() => undefined)
  const pageHashes = inspection ? await Promise.all(inspection.pages.map(async p => [p.page, paperHash(await readFile(p.imagePath))])) : undefined
  return { sourceHash: await hashPaperSources(paperDir), templateHash: paperHash({ entry: paperHash(await readFile(layout.templateFile)), profile: layout.profile }), assetHashes, evidenceHash: paperHash(evidence), ...(pdf ? { pdfHash: paperHash(pdf) } : {}), ...(inspection ? { inspectionHash: paperHash({ inspection, pageHashes }) } : {}) }
}

export function normalizePaperReview(candidate: unknown, host: {
  role: PaperReviewRole; binding: PaperArtifactBinding; capability: PaperReviewResult['capability']; budget: PaperReviewResult['budget']; sources: string[]; pages: number[]; visualRequired?: boolean
}): PaperReviewResult {
  const value = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}
  let verdict: PaperReviewVerdict = ['PASS', 'REVISE', 'BLOCKED'].includes(String(value.verdict)) && Array.isArray(value.issues) ? value.verdict as PaperReviewVerdict : 'BLOCKED'
  const issues: PaperReviewResult['issues'] = []
  for (const raw of Array.isArray(value.issues) ? value.issues : []) {
    if (!raw || typeof raw !== 'object' || !['critical', 'major', 'minor'].includes(raw.severity) || typeof raw.detail !== 'string' || !raw.detail.trim() || typeof raw.code !== 'string') { verdict = 'BLOCKED'; continue }
    const source = host.sources.includes(raw.location?.source) ? raw.location.source : host.sources[0]
    const page = host.pages.includes(raw.location?.page) ? raw.location.page : undefined
    // Object identifiers cannot be invented by the candidate. Source/page are validated against actual inputs.
    const location = { ...(source ? { source } : {}), ...(page !== undefined ? { page } : {}) }
    const issue = { severity: raw.severity as 'critical' | 'major' | 'minor', code: raw.code, detail: raw.detail, location, repair: typeof raw.repair === 'string' ? raw.repair : 'Inspect the cited source and correct this issue.' }
    issues.push({ ...issue, id: `${host.role}:${paperHash(issue).slice(0, 16)}` })
  }
  for (const severity of ['critical', 'major', 'minor'] as const) for (const detail of Array.isArray(value[severity]) ? value[severity] as unknown[] : []) {
    if (typeof detail === 'string' && !issues.some(i => i.detail === detail)) issues.push({ id: `${host.role}:${paperHash({ severity, detail }).slice(0, 16)}`, severity, code: 'ACADEMIC_REVIEW', detail, location: { source: host.sources[0] }, repair: 'Revise the manuscript using the evidence and this observation.' })
  }
  if (verdict === 'PASS' && issues.some(i => i.severity !== 'minor')) verdict = 'REVISE'
  if (host.visualRequired && host.capability.visual !== 'actual') {
    verdict = 'BLOCKED'
    issues.push({ id: `${host.role}:VISUAL_COVERAGE_REQUIRED`, severity: 'major', code: 'VISUAL_COVERAGE_REQUIRED', detail: 'No host-verified native image delivery covering every required image.', repair: 'Use an image-capable model and enable native image delivery.' })
  }
  return { schema: 'autoresearch/paper-review/v1', role: host.role, verdict, issues, binding: host.binding, capability: host.capability, budget: { ...host.budget }, ...(typeof value.score === 'number' ? { score: value.score } : {}), ...Object.fromEntries(['critical', 'major', 'minor'].map(severity => [severity, issues.filter(i => i.severity === severity).map(i => i.detail)])) }
}

/** More than 5 PDF points of overfull is a deterministic repair request; smaller warnings remain reviewer evidence. */
export function deterministicPaperIssues(compile: CompileResult, inspection?: PaperPdfInspection): Array<{ verdict: 'REVISE' | 'BLOCKED'; detail: string }> {
  const issues: Array<{ verdict: 'REVISE' | 'BLOCKED'; detail: string }> = []
  if (!compile.ok) return [{ verdict: compile.engine ? 'REVISE' : 'BLOCKED', detail: `Compilation failed: ${compile.diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}` }]
  if (compile.geometry?.status !== 'measured') issues.push({ verdict: 'BLOCKED', detail: 'Actual TeX geometry measurement is unavailable.' })
  for (const d of compile.diagnostics) {
    if (d.severity === 'error') issues.push({ verdict: /LAYOUT_PROFILE_MISMATCH|OVERFLOW/.test(d.code) ? 'REVISE' : 'BLOCKED', detail: `${d.code}: ${d.message}` })
    else if (/OVERFULL/.test(d.code)) {
      const amount = /([\d.]+)pt too (?:wide|high)/.exec(d.message)
      if (amount && Number(amount[1]) * 72 / 72.27 > 5) issues.push({ verdict: 'REVISE', detail: `${d.code}: ${d.message}` })
    }
  }
  if (!inspection?.coverage.complete || inspection.coverage.pageCount < 1 || inspection.pages.length !== inspection.coverage.pageCount || new Set(inspection.pages.map(p => p.page)).size !== inspection.coverage.pageCount || inspection.coverage.renderedPages !== inspection.coverage.pageCount) issues.push({ verdict: 'BLOCKED', detail: 'PDF inspection does not cover every page.' })
  if (inspection && compile.geometry?.pageCount !== inspection.coverage.pageCount) issues.push({ verdict: 'BLOCKED', detail: 'TeX probe and PDF physical page coverage differ.' })
  return issues
}

export function evaluatePaperGate(input: { assurance: string; deterministic: Array<{ verdict: 'REVISE' | 'BLOCKED'; detail: string }>; audits: Record<string, unknown>; reviews: PaperReviewResult[]; requiredRoles: PaperReviewRole[]; binding: PaperArtifactBinding }): PaperFinalGate {
  const reasons = input.deterministic.map(i => i.detail)
  for (const name of ['proof', 'claim', 'citation', 'kill']) if (!['PASS', 'NOT_APPLICABLE'].includes(String((input.audits[name] as { verdict?: unknown })?.verdict))) reasons.push(`Required ${name} evidence audit did not pass.`)
  const basic = input.audits.basic as { numeric?: { ok?: boolean }; citation?: { ok?: boolean } } | undefined
  if (basic?.numeric?.ok !== true || basic?.citation?.ok !== true) reasons.push('Numeric and citation evidence audits must both pass.')
  for (const role of input.requiredRoles) {
    const review = input.reviews.find(r => r.role === role)
    if (!review || !samePaperBinding(review.binding, input.binding) || review.verdict !== 'PASS' || review.issues.some(i => i.severity !== 'minor')) reasons.push(`${role} has no current passing review.`)
    else if ((role === 'layout-reviewer' || role === 'figure-reviewer') && (review.capability.visual !== 'actual' || !review.imageReceipt?.images.length)) reasons.push(`${role} has no host-recorded visual image receipt.`)
  }
  const blocked = input.deterministic.some(i => i.verdict === 'BLOCKED') || input.reviews.some(r => r.verdict === 'BLOCKED')
  return { verdict: reasons.length ? blocked ? 'BLOCKED' : 'REVISE' : 'PASS', submissionReady: input.assurance === 'submission' && reasons.length === 0, reasons }
}
