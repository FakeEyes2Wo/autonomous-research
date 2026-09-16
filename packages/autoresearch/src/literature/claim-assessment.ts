import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertHash, assertSourceSpan, type SourceSpan } from './contracts.js'
import { receiptHash, literatureError } from './receipts.js'

export interface ClaimAssessment {
  claimId: string; spanIds: string[]; locatorValid: boolean
  /** Trusted registration binds the exact committed claim, not merely its stable ID.
   * Any successor version (even unchanged prose) needs a new review. Missing binding
   * is retained for legacy history but cannot supply a current semantic relation. */
  claimBinding?: { version: number; contentHash: string }
  relation: 'supports' | 'refutes' | 'partial' | 'mixed' | 'unknown'
  conditions: string[]; assessor: 'human' | 'calibrated_model' | 'unreviewed'
  assessorVersion: string; evidenceHash: string
}
type AssessmentInput = Omit<ClaimAssessment, 'locatorValid' | 'evidenceHash'>
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function validSpan(span: SourceSpan): boolean {
  try {
    assertSourceSpan(span)
    if (receiptHash(span.evidenceText) !== span.contentHash) return false
    if (span.locator.kind === 'pdf') return span.locator.itemEnd > span.locator.itemStart
    return span.locator.end > span.locator.start
  } catch { return false }
}

/** Supplied spans must come from the authorized immutable catalog/generation, never model output. */
export function checkCitationLocators(claims: { id: string; spanIds: string[] }[], spans: SourceSpan[]): { missing: string[]; located: string[] } {
  const counts = new Map<string, number>()
  for (const span of spans) counts.set(span.id, (counts.get(span.id) ?? 0) + 1)
  const locatedSpans = new Set(spans.filter(s => counts.get(s.id) === 1 && validSpan(s)).map(s => s.id))
  const result = { missing: [] as string[], located: [] as string[] }
  for (const claim of claims) {
    const located = Array.isArray(claim.spanIds) && claim.spanIds.length > 0 && claim.spanIds.every(id => locatedSpans.has(id))
    result[located ? 'located' : 'missing'].push(claim.id)
  }
  return result
}

export function assessmentEvidenceHash(spans: SourceSpan[]): string {
  return receiptHash(canonical([...spans].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

/** Registration is a trusted caller API; an LLM's claimed assessor identity is not admissible here. */
export function createClaimAssessment(input: AssessmentInput, spans: SourceSpan[]): ClaimAssessment {
  if (!nonempty(input.claimId) || !nonempty(input.assessorVersion) || !Array.isArray(input.spanIds) || !input.spanIds.every(nonempty) ||
    !Array.isArray(input.conditions) || !input.conditions.every(nonempty) ||
    !['supports', 'refutes', 'partial', 'mixed', 'unknown'].includes(input.relation) ||
    !['human', 'calibrated_model', 'unreviewed'].includes(input.assessor)) throw literatureError('INVALID_CLAIM_ASSESSMENT')
  if (input.claimBinding !== undefined) {
    if (!input.claimBinding || !Number.isSafeInteger(input.claimBinding.version) || input.claimBinding.version < 1) throw literatureError('INVALID_CLAIM_ASSESSMENT')
    assertHash(input.claimBinding.contentHash)
  }
  const spanIds = [...new Set(input.spanIds)].sort()
  const locatorValid = checkCitationLocators([{ id: input.claimId, spanIds }], spans).missing.length === 0
  return { claimId: input.claimId, ...(input.claimBinding ? { claimBinding: { version: input.claimBinding.version, contentHash: input.claimBinding.contentHash } } : {}),
    spanIds, locatorValid, relation: locatorValid && input.assessor !== 'unreviewed' ? input.relation : 'unknown',
    conditions: [...input.conditions], assessor: input.assessor, assessorVersion: input.assessorVersion,
    evidenceHash: assessmentEvidenceHash(spans.filter(span => spanIds.includes(span.id))) }
}

export async function saveClaimAssessment(runDir: string, assessment: ClaimAssessment, spans: SourceSpan[]): Promise<string> {
  const validated = createClaimAssessment(assessment, spans)
  if (canonical(assessment) !== canonical(validated)) throw literatureError('ASSESSMENT_EVIDENCE_MISMATCH')
  const directory = join(runDir, 'literature', 'claim-assessments')
  const body = canonical(validated), id = receiptHash(body), path = join(directory, `${id}.json`)
  await mkdir(directory, { recursive: true })
  try { await writeFile(path, body, { flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== body) throw literatureError('ASSESSMENT_CORRUPT')
  }
  return id
}

export async function loadClaimAssessments(runDir: string): Promise<ClaimAssessment[]> {
  const directory = join(runDir, 'literature', 'claim-assessments')
  let files: string[]
  try { files = await readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const result: ClaimAssessment[] = []
  for (const file of files.sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) throw literatureError('ASSESSMENT_CORRUPT')
    const body = await readFile(join(directory, file), 'utf8')
    if (`${receiptHash(body)}.json` !== file) throw literatureError('ASSESSMENT_CORRUPT')
    const assessment = JSON.parse(body) as ClaimAssessment
    assertHash(assessment.evidenceHash)
    if (canonical(assessment) !== body || typeof assessment.locatorValid !== 'boolean' ||
      ((!assessment.locatorValid || assessment.assessor === 'unreviewed') && assessment.relation !== 'unknown')) throw literatureError('ASSESSMENT_CORRUPT')
    // Validate the declared fields without claiming to re-read the source bytes here.
    createClaimAssessment(assessment, [])
    result.push(assessment)
  }
  return result
}
