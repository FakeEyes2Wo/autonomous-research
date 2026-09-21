import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep, join } from 'node:path'
import { readOptionalText, writeText } from '../core/utils.js'
import { ResearchStore } from './store.js'
import { hashBytes, hashContent } from './records.js'
import { DEFAULT_PROJECT_SETTINGS } from '../settings/schema.js'
import type { RunContext } from '../service/context.js'
import { effectiveCurrentIdeaSearch, selectCurrentIdea } from './current-idea.js'
import { createDiscoveryProviders } from '../literature/discovery/providers.js'
import { runSimilaritySurvey } from '../literature/discovery/coordinator.js'
import { readDiscoveryRecord } from '../literature/discovery/checkpoint.js'
import type { CurrentIdeaIdentity, DiscoveryClock, DiscoveryConfig, DiscoveryProvider, DiscoverySourceStore, QueryPlannerCallback, SimilarityReviewerCallback, SimilaritySurveyReport } from '../literature/discovery/contracts.js'

export interface DiscoveryRuntime {
  providers?: readonly DiscoveryProvider[]
  sourceStore?: DiscoverySourceStore
  clock?: DiscoveryClock
  queryPlanner?: QueryPlannerCallback
  reviewer?: SimilarityReviewerCallback
  fetch?: typeof globalThis.fetch
  semanticScholarApiKey?: string
}

const REPORT_POINTER = 'brainstorm/current-idea-survey/current-report.json'

export function createDiscoverySourceStore(runDir: string): DiscoverySourceStore {
  const store = new ResearchStore(runDir)
  return {
    captureBytes: store.captureBytes.bind(store),
    async readSource(ref) {
      if (!ref.path || !ref.path.startsWith('research/sources/')) throw new Error('discovery source path is outside the research source store')
      const root = await realpath(runDir)
      const target = resolve(runDir, ref.path)
      const actual = await realpath(target)
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error('discovery source realpath escapes run store')
      return new Uint8Array(await readFile(actual))
    },
  }
}

function compactIdea(idea: CurrentIdeaIdentity): Record<string, unknown> {
  return { statement: idea.statement, profile: idea.profile, scope: idea.scope, mechanism: idea.mechanism, prediction: idea.prediction, falsification: idea.falsification, measurement: idea.measurement, decisionRule: idea.decisionRule, alternatives: idea.alternatives.slice(0, 12), assumptions: idea.assumptions.slice(0, 12), terminology: idea.terminology.slice(0, 20), crossDomainAnalogs: idea.crossDomainAnalogs.slice(0, 12), source: idea.source }
}

function compactCandidate(candidate: any): Record<string, unknown> {
  return { id: candidate.id, title: candidate.title, authors: candidate.authors, year: candidate.year, abstract: typeof candidate.abstract === 'string' ? candidate.abstract.slice(0, 1200) : candidate.abstract, aliases: candidate.aliases, conflicts: candidate.conflicts }
}

function configured(input: DiscoveryRuntime | undefined, ctx: RunContext): DiscoveryRuntime {
  return input ?? {}
}

function nativeDiscoveryContext(ctx: RunContext) {
  return { stage: 'current-idea-discovery', scope: { projectId: ctx.projectDir, branchId: 'pre-snapshot', runId: ctx.state.runId }, records: [] as const }
}

export async function ensureCurrentIdeaSurvey(ctx: RunContext, ideaText: string, profile: string): Promise<SimilaritySurveyReport | undefined> {
  const settings = ctx.deps.projectSettings ?? DEFAULT_PROJECT_SETTINGS
  if (effectiveCurrentIdeaSearch(settings, ctx.policySnapshot) === 'never') return undefined
  const snapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  const idea = selectCurrentIdea({ intakeIdea: ideaText, profile, snapshot: snapshot as any ?? undefined })
  const runtime = configured(ctx.deps.discovery, ctx)
  const store = runtime.sourceStore ?? createDiscoverySourceStore(ctx.runDir)
  const providers = runtime.providers ? [...runtime.providers] : createDiscoveryProviders({ sourceStore: store, fetch: runtime.fetch, semanticScholarApiKey: runtime.semanticScholarApiKey })
  const queryPlanner = runtime.queryPlanner ?? (async input => {
    const result = await ctx.deps.provider.run('idea-query-planner', {
      runDir: ctx.runDir, taskId: input.taskId, cycle: ctx.state.cycle, idea: input.idea.statement, profile: input.idea.profile,
      researchContext: nativeDiscoveryContext(ctx),
      plan: JSON.stringify({ ...compactIdea(input.idea), round: input.round, maxQueries: input.maxQueries, priorQueries: input.priorQueries.slice(-12), priorCoverage: input.priorCoverage }),
    }, { ...ctx.context, signal: input.signal ?? ctx.context.signal })
    return (result.structured as { queries?: unknown } | undefined)?.queries ?? []
  })
  const reviewer = runtime.reviewer ?? (async input => {
    const result = await ctx.deps.provider.run('idea-similarity-reviewer', {
      runDir: ctx.runDir, taskId: input.taskId, cycle: ctx.state.cycle, idea: input.idea.statement, profile: input.idea.profile,
      researchContext: nativeDiscoveryContext(ctx),
      plan: JSON.stringify({ idea: compactIdea(input.idea), candidates: input.candidates.map(compactCandidate), excerpts: input.excerpts.map(excerpt => { const text = excerpt.text.slice(0, 1200); const end = excerpt.start + text.length; return { candidateId: excerpt.candidateId, text, start: excerpt.start, end, sourceRef: excerpt.sourceRef, contentHash: hashBytes(text) } }) }),
    }, { ...ctx.context, signal: input.signal ?? ctx.context.signal })
    return (result.structured as { assessments?: unknown } | undefined)?.assessments ?? []
  })
  const budget = (ctx.policySnapshot.budget as typeof ctx.policySnapshot.budget & { currentIdeaSearch?: Partial<DiscoveryConfig> }).currentIdeaSearch
  const report = await runSimilaritySurvey({ runDir: ctx.runDir, idea, config: budget, providers, queryPlanner, reviewer, sourceStore: store, clock: runtime.clock, signal: ctx.context.signal, executionBinding: { runId: ctx.state.runId, cycle: ctx.state.cycle } })
  await writeText(resolve(ctx.runDir, REPORT_POINTER), JSON.stringify(report, null, 2) + '\n')
  return report
}

export async function readCurrentIdeaSurvey(runDir: string): Promise<SimilaritySurveyReport | undefined> {
  const raw = await readOptionalText(resolve(runDir, REPORT_POINTER))
  if (!raw) return undefined
  try {
    const pointer = JSON.parse(raw) as unknown
    const identity = reportIdentity(pointer)
    if (!identity) return undefined
    const durablePath = resolve(runDir, 'brainstorm', 'current-idea-survey', identity.ideaFingerprint, identity.configFingerprint, 'report.json')
    const durable = await readDiscoveryRecord<SimilaritySurveyReport>(durablePath)
    if (!durable) return undefined
    const durableIdentity = reportIdentity(durable)
    if (!durableIdentity || durableIdentity.surveyId !== identity.surveyId || durableIdentity.ideaFingerprint !== identity.ideaFingerprint || durableIdentity.configFingerprint !== identity.configFingerprint) return undefined
    if (hashContent(pointer) !== hashContent(durable)) return undefined
    return durable
  } catch { return undefined }
}

function reportIdentity(value: unknown): { surveyId: string; ideaFingerprint: string; configFingerprint: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const report = value as { schema?: unknown; authority?: unknown; status?: unknown; surveyId?: unknown; ideaFingerprint?: unknown; configFingerprint?: unknown }
  const isHash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  if (report.schema !== 'autoresearch/current-idea-similarity/v1' || report.authority !== 'advisory-discovery-only' || !['complete', 'partial', 'paused', 'no_results'].includes(String(report.status)) || !isHash(report.ideaFingerprint) || !isHash(report.configFingerprint) || !isHash(report.surveyId)) return undefined
  if (report.surveyId !== hashContent({ ideaFingerprint: report.ideaFingerprint, configFingerprint: report.configFingerprint })) return undefined
  return { surveyId: report.surveyId, ideaFingerprint: report.ideaFingerprint, configFingerprint: report.configFingerprint }
}

export { REPORT_POINTER }
