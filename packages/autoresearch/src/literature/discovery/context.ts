import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashContent } from '../../research/records.js'
import { canonicalContextJson, sealContextRecord, verifyContextRecord, type ContextRecord, type ResearchContextPackage, type ResearchContextScope } from '../../research-context/index.js'
import { verifyDiscoverySource } from './providers.js'
import type { DiscoverySourceStore, SimilaritySurveyReport } from './contracts.js'

export const DISCOVERY_CONTEXT_ROLES = ['planner', 'idea-generator', 'idea-reflexion', 'hypothesis-reviser'] as const
export interface DiscoveryContextBinding {
  surveyId: string
  ideaFingerprint: string
  reportHash: string
  selectedRecordIds: string[]
  sourceRefs: import('../../research/contracts.js').SourceRef[]
  exposurePath: string
}

export interface DiscoveryContextBuildInput {
  runDir: string
  report: SimilaritySurveyReport
  scope: ResearchContextScope
  role: string
  maxContextChars: number
  currentTargetFingerprint: string
  sourceStore: DiscoverySourceStore
}

const allowed = new Set<string>(DISCOVERY_CONTEXT_ROLES)
export async function buildDiscoveryContext(input: DiscoveryContextBuildInput): Promise<{ records: ContextRecord[]; binding: DiscoveryContextBinding }> {
  if (!allowed.has(input.role)) return { records: [], binding: { surveyId: input.report.surveyId, ideaFingerprint: input.report.ideaFingerprint, reportHash: hashContent(input.report), selectedRecordIds: [], sourceRefs: [], exposurePath: '' } }
  if (input.report.ideaFingerprint !== input.currentTargetFingerprint) throw new Error('discovery report target fingerprint is stale')
  const sourceRefs = [...new Map(input.report.sourceRefs.map(ref => [hashContent(ref), ref])).values()]
  for (const ref of sourceRefs) await verifyDiscoverySource(input.sourceStore, ref)
  const visibility = { ...input.scope, visibility: 'run' as const, runId: input.scope.runId ?? 'discovery' }
  const assessments = new Map(input.report.assessments.map(item => [item.candidateId, item]))
  const candidateRecords = input.report.nearest.map(candidate => {
    const assessment = assessments.get(candidate.id)
    const refs = [...new Map(candidate.observations.flatMap(observation => [observation.sourceRef, observation.rawSource]).map(ref => [hashContent(ref), ref])).values()]
    return { candidate, assessment, refs }
  })
  const summary = `Current-idea similarity survey ${input.report.surveyId}: collected=${input.report.counts.collected}, retained=${input.report.counts.retained}, omitted=${input.report.counts.omitted}, shortlisted=${input.report.counts.shortlisted}, reviewed=${input.report.counts.reviewed}; stop=${input.report.stopReason}. Coverage gaps: ${input.report.gaps.join(' | ') || 'none reported'}. Similarity is advisory and does not establish novelty or scientific support.`
  const summaryRecord = sealContextRecord({ id: `discovery-summary-${input.report.surveyId}`, version: 1, layer: 3, kind: 'artifact', scope: visibility, required: true, accessRoles: [...DISCOVERY_CONTEXT_ROLES], polarity: 'neutral', lifecycle: 'candidate', payload: { surveyId: input.report.surveyId, ideaFingerprint: input.report.ideaFingerprint, summary, counts: input.report.counts, gaps: input.report.gaps, uncertainty: input.report.uncertainty }, source: { recordType: 'discovery-report', path: 'brainstorm/current-idea-survey/current-report.json' } })
  const records: ContextRecord[] = [summaryRecord]
  const omitted: string[] = []
  let used = summary.length
  for (const item of candidateRecords) {
    const assessment = item.assessment
    const payload = { surveyId: input.report.surveyId, candidateId: item.candidate.id, title: item.candidate.title, authors: item.candidate.authors, year: item.candidate.year, aliases: item.candidate.aliases, conflicts: item.candidate.conflicts, overlap: assessment?.overlap ?? [], differences: assessment?.differences ?? [], uncertainty: assessment?.uncertainty ?? [], relevance: assessment?.relevance ?? 'uncertain', excerptProofs: assessment?.excerptProofs ?? [], sourceRefs: item.refs }
    const estimate = JSON.stringify(payload).length
    if (used + estimate > input.maxContextChars) { omitted.push(item.candidate.id); continue }
    for (const ref of item.refs) { await verifyDiscoverySource(input.sourceStore, ref); sourceRefs.push(ref) }
    records.push(sealContextRecord({ id: `discovery-candidate-${item.candidate.id}`, version: 1, layer: 3, kind: 'artifact', scope: visibility, accessRoles: [...DISCOVERY_CONTEXT_ROLES], polarity: 'neutral', lifecycle: 'candidate', payload, source: { recordType: 'discovery-candidate', path: `brainstorm/current-idea-survey/${input.report.ideaFingerprint}/pool.json` } }))
    used += estimate
  }
  if (omitted.length) records.push(sealContextRecord({ id: `discovery-overflow-${input.report.surveyId}`, version: 1, layer: 3, kind: 'summary', scope: visibility, required: true, accessRoles: [...DISCOVERY_CONTEXT_ROLES], polarity: 'neutral', lifecycle: 'candidate', payload: { surveyId: input.report.surveyId, omittedCandidateIds: omitted, note: 'Context character budget excluded these candidates; the persisted report remains available for a later bounded selection.' }, source: { recordType: 'discovery-overflow', path: 'brainstorm/current-idea-survey/current-report.json' } }))
  const binding: DiscoveryContextBinding = { surveyId: input.report.surveyId, ideaFingerprint: input.report.ideaFingerprint, reportHash: hashContent(input.report), selectedRecordIds: records.map(record => record.id), sourceRefs: [...new Map(sourceRefs.map(ref => [hashContent(ref), ref])).values()], exposurePath: join(input.runDir, 'brainstorm', 'current-idea-survey', 'discovery-exposure.jsonl') }
  return { records, binding }
}

export interface DiscoveryExposureReceipt {
  surveyId: string
  reportHash: string
  selectedRecordIds: string[]
  promptHash: string
  status: 'prepared' | 'sent' | 'unknown'
  createdAt: string
}

export async function prepareDiscoveryExposure(input: { runDir: string; binding: DiscoveryContextBinding; context: ResearchContextPackage; prompt: string; role: string }): Promise<DiscoveryExposureReceipt> {
  const selected = input.context.selection.selected
    .filter(({ record }) => input.binding.selectedRecordIds.includes(record.id))
    .filter(({ record }) => {
      verifyContextRecord(record)
      return input.prompt.includes(canonicalContextJson(record))
    })
    .map(({ record }) => record.id)
  const receipt: DiscoveryExposureReceipt = { surveyId: input.binding.surveyId, reportHash: input.binding.reportHash, selectedRecordIds: selected, promptHash: hashContent(input.prompt), status: 'prepared', createdAt: new Date().toISOString() }
  await appendFile(input.binding.exposurePath, JSON.stringify({ ...receipt, role: input.role }) + '\n')
  return receipt
}

export async function finishDiscoveryExposure(binding: DiscoveryContextBinding, receipt: DiscoveryExposureReceipt, status: 'sent' | 'unknown'): Promise<void> {
  await appendFile(binding.exposurePath, JSON.stringify({ ...receipt, status, finishedAt: new Date().toISOString() }) + '\n')
}
