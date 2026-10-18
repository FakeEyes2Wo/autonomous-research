import type { SourceRef } from '../../research/contracts.js'
import { hashContent } from '../../research/records.js'
import { CURRENT_IDEA_SEARCH_LIMITS } from '../../settings/schema.js'

export type DiscoveryProviderName = 'arxiv' | 'crossref' | 'semantic-scholar'
export type DiscoveryDimension = 'problem' | 'mechanism' | 'assumption' | 'terminology' | 'cross-domain'
export interface CurrentIdeaIdentity {
  statement: string; profile: string; scope: string; mechanism: string; prediction: string; falsification: string; measurement: string; decisionRule: string
  alternatives: string[]; assumptions: string[]; terminology: string[]; crossDomainAnalogs: string[]
  source?: 'given-idea' | 'brainstorm-candidate' | 'current-hypothesis' | 'revision'
}
/** Execution provenance is deliberately separate from semantic target identity. */
export interface DiscoveryExecutionBinding { runId: string; cycle?: number; sourceRefs?: SourceRef[] }
export interface DiscoveryConfig {
  minRounds: number; maxRounds: number; queriesPerRound: number; maxRequests: number; maxCandidates: number; nearestLimit: number
  maxDurationMs: number; pageSize: number; maxPagesPerQuery: number; maxRetries: number; requestTimeoutMs: number; maxResponseBytes: number; cacheMaxAgeMs: number
}
export interface DiscoveryQuery { id: string; round: number; text: string; dimensions: DiscoveryDimension[]; origin: 'model' | 'review-followup' }
export interface DiscoverySourceStore { captureBytes(bytes: Uint8Array | string, sourceId: string): Promise<SourceRef>; readSource(ref: SourceRef): Promise<Uint8Array> }
export interface DiscoveryClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface HttpReceipt {
  id: string; provider: DiscoveryProviderName; requestUrl: string; queryId: string; page: number; startedAt: string; finishedAt: string; status: number | null
  responseSource: SourceRef | null; responseBytes: number; retryAfterMs: number | null; parserVersion: string
  outcome: 'ok' | 'rate_limited' | 'http_error' | 'invalid_response' | 'too_large' | 'timeout' | 'aborted' | 'unavailable' | 'unknown'
  note?: string
}
export interface DiscoveryObservation {
  receiptId: string; title: string; authors: string[] | null; year: number | null; abstract: string | null
  sourceRef: SourceRef; parserVersion: string; resultKey: string; rawSource: SourceRef
}
export interface DiscoveryCandidate {
  id: string; title: string; authors: string[] | null; year: number | null; abstract: string | null
  aliases: { kind: 'doi' | 'arxiv' | 'url' | 'provider'; value: string }[]
  providerHits: { provider: DiscoveryProviderName; receiptId: string; resultKey: string; queryId: string; rank: number; dimensions: DiscoveryDimension[] }[]
  observations: DiscoveryObservation[]; conflicts: ('title' | 'authors' | 'year' | 'abstract')[]
}
export interface CandidateExcerpt { candidateId: string; text: string; start: number; end: number; sourceReceiptId: string; sourceHash: string; sourceRef: SourceRef; contentHash: string }
export interface SimilarityAssessment {
  candidateId: string; overlap: string[]; differences: string[]; uncertainty: string[]; relevance: 'nearest' | 'related' | 'weak' | 'uncertain'
  excerptProofs: { candidateId: string; sourceRef: SourceRef; start: number; end: number; contentHash: string }[]
  followupQueries: string[]; citationSeeds: string[]
}
export interface QueryPlannerInput { idea: CurrentIdeaIdentity; round: number; priorQueries: readonly DiscoveryQuery[]; priorCoverage: readonly string[]; maxQueries: number; taskId?: string; signal?: AbortSignal }
export type QueryPlannerCallback = (input: QueryPlannerInput) => Promise<unknown>
export interface SimilarityReviewerInput { idea: CurrentIdeaIdentity; candidates: readonly DiscoveryCandidate[]; excerpts: readonly CandidateExcerpt[]; taskId?: string; signal?: AbortSignal }
export type SimilarityReviewerCallback = (input: SimilarityReviewerInput) => Promise<unknown>
export interface DiscoveryProvider {
  readonly name: DiscoveryProviderName
  search(input: { query: DiscoveryQuery; page: number; pageSize: number; signal: AbortSignal; now: () => number; attemptId?: string; timeoutMs?: number; maxResponseBytes?: number }): Promise<{ receipt: HttpReceipt; candidates: DiscoveryCandidate[]; hasMore: boolean }>
}
export interface SimilaritySurveyReport {
  schema: 'autoresearch/current-idea-similarity/v1'; surveyId: string; ideaFingerprint: string; configFingerprint: string
  authority: 'advisory-discovery-only'; status: 'complete' | 'partial' | 'paused' | 'no_results'; executionBinding?: DiscoveryExecutionBinding
  roundsCompleted: number; queries: DiscoveryQuery[]; rejectedQueries: { round: number; text: string; reason: string }[]
  receipts: HttpReceipt[]; candidates: DiscoveryCandidate[]; nearest: DiscoveryCandidate[]; assessments: SimilarityAssessment[]
  counts: { collected: number; retained: number; omitted: number; shortlisted: number; reviewed: number; actualHttpAttempts: number; cacheHits: number }
  providerCoverage: Record<DiscoveryProviderName, { attempts: number; successful: number; degraded: number; note?: string }>
  gaps: string[]; uncertainty: string[]; stopReason: string; createdAt: string; elapsedMs: number; sourceRefs: SourceRef[]
}
export const DISCOVERY_VERSION = 'idea-discovery/v1'
const defaults: DiscoveryConfig = { minRounds: 3, maxRounds: 5, queriesPerRound: 4, maxRequests: 80, maxCandidates: 200, nearestLimit: 20, maxDurationMs: 600_000, pageSize: 20, maxPagesPerQuery: 2, maxRetries: 2, requestTimeoutMs: 20_000, maxResponseBytes: 2_000_000, cacheMaxAgeMs: 24 * 60 * 60_000 }
export function resolveDiscoveryConfig(input: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  const result = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof DiscoveryConfig)[]) {
    const value = input[key] ?? defaults[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1)) throw new Error(`Invalid discovery budget: ${key}`)
    result[key] = value
  }
  if (result.minRounds > result.maxRounds || result.nearestLimit > result.maxCandidates || result.pageSize > 100) throw new Error('Inconsistent discovery budgets')
  if (result.maxRounds > CURRENT_IDEA_SEARCH_LIMITS.maxRounds || result.queriesPerRound > CURRENT_IDEA_SEARCH_LIMITS.queriesPerRound || result.maxRequests > CURRENT_IDEA_SEARCH_LIMITS.maxRequests || result.maxCandidates > CURRENT_IDEA_SEARCH_LIMITS.maxCandidates || result.nearestLimit > CURRENT_IDEA_SEARCH_LIMITS.nearestLimit || result.maxRetries > 5 || result.maxPagesPerQuery > 20 || result.maxDurationMs > CURRENT_IDEA_SEARCH_LIMITS.maxDurationMs || result.requestTimeoutMs > 120_000 || result.maxResponseBytes > 10_000_000 || result.cacheMaxAgeMs > 7 * 24 * 3_600_000) throw new Error('Discovery budget exceeds safe bounded limits')
  return result
}
const canonicalText = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ')
export function fingerprintIdea(idea: CurrentIdeaIdentity): string {
  if (!idea.statement?.trim()) throw new Error('Current idea statement is required')
  return hashContent({ version: DISCOVERY_VERSION, statement: canonicalText(idea.statement), profile: canonicalText(idea.profile), scope: canonicalText(idea.scope), mechanism: canonicalText(idea.mechanism), prediction: canonicalText(idea.prediction), falsification: canonicalText(idea.falsification), measurement: canonicalText(idea.measurement), decisionRule: canonicalText(idea.decisionRule), alternatives: [...new Set(idea.alternatives.map(canonicalText))].sort(), assumptions: [...new Set(idea.assumptions.map(canonicalText))].sort(), terminology: [...new Set(idea.terminology.map(canonicalText))].sort(), crossDomainAnalogs: [...new Set(idea.crossDomainAnalogs.map(canonicalText))].sort() })
}
