import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashBytes, hashContent } from '../../research/records.js'
import { DISCOVERY_VERSION, fingerprintIdea, resolveDiscoveryConfig } from './contracts.js'
import type { CurrentIdeaIdentity, DiscoveryClock, DiscoveryConfig, DiscoveryExecutionBinding, DiscoveryProvider, DiscoveryProviderName, DiscoverySourceStore, QueryPlannerCallback, SimilarityReviewerCallback, SimilaritySurveyReport } from './contracts.js'
import { DISCOVERY_PARSER_VERSION, discoveryRequestUrl, verifyDiscoverySource } from './providers.js'
import { normalizeDiscoveryQuery, validateDiscoveryQueries } from './query-planner.js'
import { createCandidateExcerpts, validateSimilarityAssessments } from './reviewer.js'
import { discoveryRrfScore, mergeDiscoveryCandidates, rankDiscoveryCandidates } from './ranking.js'
import { lockDiscoveryDirectory, readDiscoveryRecord, writeDiscoveryRecord } from './checkpoint.js'
import type { DiscoveryCheckpoint, DiscoveryResult, DiscoveryTask } from './checkpoint.js'

const spacing: Record<DiscoveryProviderName, number> = { arxiv: 3000, crossref: 1000, 'semantic-scholar': 1000 }
const defaultClock: DiscoveryClock = { now: Date.now, sleep: (ms, signal) => new Promise((resolve, reject) => { if (signal?.aborted) return reject(signal.reason); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve() } function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) } signal?.addEventListener('abort', abort, { once: true }) }) }
const judgmentHash = (candidate: import('./contracts.js').DiscoveryCandidate, assessment?: import('./contracts.js').SimilarityAssessment) => hashContent({ id: candidate.id, title: candidate.title, authors: candidate.authors, year: candidate.year, abstract: candidate.abstract, aliases: candidate.aliases, conflicts: candidate.conflicts, proofRefs: (assessment?.excerptProofs ?? []).map(proof => ({ sourceRef: proof.sourceRef, start: proof.start, end: proof.end, contentHash: proof.contentHash })) })
const semanticPriority = (relevance: string | undefined) => relevance === 'nearest' ? 0 : relevance === 'related' ? 1 : relevance === 'uncertain' ? 2 : 3
function rankRetainedCandidates(pool: readonly import('./contracts.js').DiscoveryCandidate[], limit: number, assessments: readonly import('./contracts.js').SimilarityAssessment[], hashes: Record<string, string> | undefined): import('./contracts.js').DiscoveryCandidate[] {
  const judgment = new Map(assessments.map(assessment => [assessment.candidateId, assessment]))
  return [...pool].sort((a, b) => {
    const aAssessment = judgment.get(a.id); const validA = aAssessment && hashes?.[a.id] === judgmentHash(a, aAssessment) ? aAssessment : undefined
    const bAssessment = judgment.get(b.id); const validB = bAssessment && hashes?.[b.id] === judgmentHash(b, bAssessment) ? bAssessment : undefined
    return semanticPriority(validA?.relevance) - semanticPriority(validB?.relevance) || discoveryRrfScore(b) - discoveryRrfScore(a) || a.id.localeCompare(b.id)
  }).slice(0, limit)
}
export interface RunSimilaritySurveyInput {
  runDir: string; idea: CurrentIdeaIdentity; config?: Partial<DiscoveryConfig>; providers: readonly DiscoveryProvider[]
  queryPlanner: QueryPlannerCallback; reviewer: SimilarityReviewerCallback; sourceStore: DiscoverySourceStore; clock?: DiscoveryClock; signal?: AbortSignal; executionBinding?: DiscoveryExecutionBinding
}
export async function runSimilaritySurvey(input: RunSimilaritySurveyInput): Promise<SimilaritySurveyReport> {
  const config = resolveDiscoveryConfig(input.config), clock = input.clock ?? defaultClock
  const ideaFingerprint = fingerprintIdea(input.idea), configFingerprint = hashContent({ config, providers: input.providers.map(p => p.name).sort(), parserVersion: DISCOVERY_PARSER_VERSION, version: DISCOVERY_VERSION })
  if (!input.providers.length || new Set(input.providers.map(p => p.name)).size !== input.providers.length || input.providers.some(p => !(p.name in spacing))) throw new Error('Discovery requires distinct supported provider adapters')
  const surveyId = hashContent({ ideaFingerprint, configFingerprint })
  const base = join(input.runDir, 'brainstorm', 'current-idea-survey'), directory = join(base, ideaFingerprint, configFingerprint)
  const release = await lockDiscoveryDirectory(directory)
  const checkpointPath = join(directory, 'checkpoint.json')
  let state: DiscoveryCheckpoint
  const start = clock.now(); let accounted = start
  const abort = new AbortController(); const onAbort = () => abort.abort(input.signal?.reason)
  if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    state = await readDiscoveryRecord<DiscoveryCheckpoint>(checkpointPath) ?? { version: 1, surveyId, ideaFingerprint, configFingerprint, createdAt: new Date(start).toISOString(), elapsedMs: 0, attempts: 0, providerAttempts: {}, cacheHits: 0, round: 1, roundsCompleted: 0, roundInitialPoolSize: 0, lowYieldRounds: 0, queries: [], rejectedQueries: [], tasks: [], completedTasks: [], receipts: [], pool: [], assessments: [], gaps: [], nextProviderAt: {}, modelResults: {}, assessmentHashes: {}, phase: 'plan' }
    if (state.version !== 1 || state.surveyId !== surveyId || state.ideaFingerprint !== ideaFingerprint || state.configFingerprint !== configFingerprint) throw new Error('Discovery checkpoint identity mismatch')
    const unresolved = state.pendingHttp ?? state.pendingModel
    if (unresolved) {
      // Charge the whole unconfirmed interval, including downtime: crashes cannot reset a spent wall budget.
      state.elapsedMs += Math.max(0, start - (unresolved.accountedThrough ?? unresolved.startedAt))
      unresolved.accountedThrough = start
    }
    const account = () => { const now = clock.now(); state.elapsedMs += Math.max(0, now - accounted); accounted = now }
    const save = async () => { account(); if (state.pendingHttp) state.pendingHttp.accountedThrough = accounted; if (state.pendingModel) state.pendingModel.accountedThrough = accounted; await writeDiscoveryRecord(checkpointPath, state) }
    const remaining = () => Math.max(0, config.maxDurationMs - state.elapsedMs - Math.max(0, clock.now() - accounted))
    timer = setTimeout(() => abort.abort(new Error('Discovery wall-time budget exhausted')), Math.max(1, remaining()))
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      if (abort.signal.aborted) { void operation.catch(() => {}); throw abort.signal.reason }
      let listener: () => void = () => {}
      const interrupted = new Promise<never>((_, reject) => { listener = () => reject(abort.signal.reason); abort.signal.addEventListener('abort', listener, { once: true }) })
      try { return await Promise.race([operation, interrupted]) } finally { abort.signal.removeEventListener('abort', listener) }
    }
    const verifyResult = async (result: DiscoveryResult) => {
      if (result.receipt.responseSource) await verifyDiscoverySource(input.sourceStore, result.receipt.responseSource)
      for (const c of result.candidates) for (const o of c.observations) { await verifyDiscoverySource(input.sourceStore, o.sourceRef); await verifyDiscoverySource(input.sourceStore, o.rawSource) }
      await createCandidateExcerpts(result.candidates, input.sourceStore.readSource.bind(input.sourceStore))
    }
    for (const receipt of state.receipts) if (receipt.responseSource) await verifyDiscoverySource(input.sourceStore, receipt.responseSource)
    await createCandidateExcerpts(state.pool, input.sourceStore.readSource.bind(input.sourceStore))
    for (const result of Object.values(state.modelResults)) {
      const bytes = await verifyDiscoverySource(input.sourceStore, result.sourceRef)
      if (hashBytes(JSON.stringify(result.raw)) !== hashBytes(bytes)) throw new Error('Cached model result bytes mismatch')
    }
    if (state.report) return state.report
    const applyResult = async (task: DiscoveryTask, result: DiscoveryResult, cached: boolean) => {
      if (!state.receipts.some(r => r.id === result.receipt.id)) state.receipts.push(result.receipt)
      const candidates = structuredClone(result.candidates)
      if (cached) for (const c of candidates) for (const hit of c.providerHits) { hit.queryId = task.query.id; hit.dimensions = task.query.dimensions }
      state.pool = mergeDiscoveryCandidates([...state.pool, ...candidates])
      state.completedTasks.push(task.key); state.tasks = state.tasks.filter(t => t.key !== task.key)
      if (cached) state.cacheHits++
      if (result.receipt.outcome === 'ok' && result.hasMore && task.page + 1 < config.maxPagesPerQuery) state.tasks.push({ ...task, key: `${task.provider}:${task.query.id}:${task.page + 1}:0`, page: task.page + 1, retry: 0, readyAt: 0 })
      const retryable = result.receipt.outcome === 'rate_limited' || (result.receipt.status !== null && result.receipt.status >= 500 && result.receipt.status <= 599)
      if (retryable && task.retry < config.maxRetries) state.tasks.push({ ...task, key: `${task.provider}:${task.query.id}:${task.page}:${task.retry + 1}`, retry: task.retry + 1, readyAt: clock.now() + Math.max(result.receipt.retryAfterMs ?? 0, 1000 * 2 ** task.retry) })
      if (result.receipt.outcome !== 'ok') state.gaps.push(`${task.provider}: ${result.receipt.outcome} (${result.receipt.id})`)
      if (retryable) state.nextProviderAt[task.provider] = Math.max(state.nextProviderAt[task.provider] ?? 0, clock.now() + (result.receipt.retryAfterMs ?? 1000))
      state.pendingHttp = undefined
      await save()
    }
    if (state.pendingHttp) {
      const { task, id } = state.pendingHttp
      const recovered = await readDiscoveryRecord<DiscoveryResult>(join(directory, 'receipts', `${id}.json`))
      if (recovered) { await verifyResult(recovered); await applyResult(task, recovered, false) }
      else {
        state.gaps.push(`Unknown HTTP outcome ${id}; this exact request is not automatically repeated.`)
        state.receipts.push({ id, provider: task.provider, queryId: task.query.id, page: task.page, requestUrl: discoveryRequestUrl(task.provider, task.query.text, task.page, config.pageSize), startedAt: new Date(state.pendingHttp.startedAt).toISOString(), finishedAt: new Date(clock.now()).toISOString(), status: null, responseSource: null, responseBytes: 0, retryAfterMs: null, parserVersion: DISCOVERY_PARSER_VERSION, outcome: 'unknown' })
        state.tasks = state.tasks.filter(t => t.key !== task.key); state.completedTasks.push(task.key); state.pendingHttp = undefined; await save()
      }
    }
    const model = async (key: string, callback: () => Promise<unknown>): Promise<unknown> => {
      if (state.modelResults[key]) return state.modelResults[key]!.raw
      if (state.pendingModel) {
        if (state.pendingModel.key !== key) throw new Error('Unresolved model dispatch belongs to a different input')
        const recovered = await readDiscoveryRecord<{ raw: unknown; sourceRef: import('../../research/contracts.js').SourceRef }>(join(directory, 'models', `${state.pendingModel.id}.json`))
        if (!recovered) throw new Error('Unknown model outcome; automatic redispatch is disabled')
        const bytes = await verifyDiscoverySource(input.sourceStore, recovered.sourceRef)
        if (hashBytes(JSON.stringify(recovered.raw)) !== hashBytes(bytes)) throw new Error('Model receipt bytes mismatch')
        state.modelResults[key] = recovered; state.pendingModel = undefined; await save(); return recovered.raw
      }
      if (!remaining() || abort.signal.aborted) throw new Error('Discovery model budget exhausted')
      const id = `model-${randomUUID()}`; state.pendingModel = { key, id, startedAt: clock.now() }; await save()
      const raw = await bounded(callback())
      const text = JSON.stringify(raw)
      if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid or oversized discovery model output')
      const sourceRef = await input.sourceStore.captureBytes(text, id)
      const bytes = await verifyDiscoverySource(input.sourceStore, sourceRef)
      if (hashBytes(text) !== hashBytes(bytes)) throw new Error('Model source capture mismatch')
      const result = { raw, sourceRef }; await writeDiscoveryRecord(join(directory, 'models', `${id}.json`), result)
      state.modelResults[key] = result; state.pendingModel = undefined; await save(); return raw
    }
    let stopReason = 'max_rounds'; let paused = false
    try {
      while (state.round <= config.maxRounds) {
        if (abort.signal.aborted || !remaining()) { stopReason = input.signal?.aborted ? 'aborted' : 'time_budget'; break }
        if (state.phase === 'plan') {
          const plannerInput = { idea: input.idea, round: state.round, priorQueries: state.queries, priorCoverage: [...new Set(state.queries.flatMap(q => q.dimensions))], maxQueries: config.queriesPerRound, taskId: `idea-survey:${surveyId}:query:${state.round}` }
          const raw = await model(`plan:${hashContent(plannerInput)}`, () => input.queryPlanner({ ...plannerInput, signal: abort.signal }))
          const followups = state.assessments.flatMap(a => a.followupQueries).map(text => ({ text, dimensions: ['mechanism', 'terminology'] }))
          const followupQueries = state.round > 1 ? validateDiscoveryQueries(followups, { ...plannerInput, maxQueries: Math.floor(config.queriesPerRound / 2) }, state.rejectedQueries, 'review-followup') : []
          const queries = validateDiscoveryQueries(raw, { ...plannerInput, priorQueries: [...state.queries, ...followupQueries], maxQueries: config.queriesPerRound - followupQueries.length }, state.rejectedQueries)
          const roundQueries = [...followupQueries, ...queries]
          if (roundQueries.length < config.queriesPerRound) state.gaps.push(`Round ${state.round} query shortfall: ${roundQueries.length}/${config.queriesPerRound} distinct valid queries; coverage is incomplete.`)
          if (!roundQueries.length) { stopReason = 'query_queue_exhausted'; break }
          state.queries.push(...roundQueries); state.roundInitialPoolSize = state.pool.length
          state.tasks = roundQueries.flatMap(query => input.providers.map(p => ({ key: `${p.name}:${query.id}:0:0`, provider: p.name, query, page: 0, retry: 0, readyAt: 0 })))
          state.phase = 'search'; await save()
        }
        if (state.phase === 'search') {
          while (state.tasks.length) {
            if (abort.signal.aborted || !remaining() || state.attempts >= config.maxRequests) break
            const now = clock.now()
            const eligible = state.tasks.filter(t => Math.max(t.readyAt, state.nextProviderAt[t.provider] ?? 0) <= now)
            if (!eligible.length) {
              const wait = Math.min(...state.tasks.map(t => Math.max(t.readyAt, state.nextProviderAt[t.provider] ?? 0) - now))
              if (wait >= remaining()) { stopReason = 'time_budget'; break }
              await bounded(clock.sleep(Math.min(wait, 60_000), abort.signal)); account(); continue
            }
            // Oldest page first, then round-robin provider order in insertion order.
            const task = eligible.sort((a, b) => a.page - b.page || a.retry - b.retry)[0]!
            const url = discoveryRequestUrl(task.provider, task.query.text, task.page, config.pageSize)
            const cacheKey = hashContent({ provider: task.provider, url, parserVersion: DISCOVERY_PARSER_VERSION })
            const cachePath = join(base, 'provider-cache', `${cacheKey}.json`)
            const cached = await readDiscoveryRecord<{ createdAt: number; result: DiscoveryResult }>(cachePath).catch(() => undefined)
            if (cached && clock.now() >= cached.createdAt && clock.now() - cached.createdAt <= config.cacheMaxAgeMs) {
              try { await verifyResult(cached.result); await applyResult(task, cached.result, true); continue } catch { state.gaps.push(`Invalid cached provider bytes for ${task.provider}; fresh retrieval required`) }
            }
            const id = `http-${randomUUID()}`; state.pendingHttp = { task, id, startedAt: clock.now() }; state.attempts++; state.providerAttempts[task.provider] = (state.providerAttempts[task.provider] ?? 0) + 1; state.nextProviderAt[task.provider] = clock.now() + spacing[task.provider]; await save()
            const provider = input.providers.find(p => p.name === task.provider)!
            const result = await bounded(provider.search({ query: task.query, page: task.page, pageSize: config.pageSize, signal: abort.signal, now: clock.now.bind(clock), attemptId: id, timeoutMs: Math.min(config.requestTimeoutMs, remaining()), maxResponseBytes: config.maxResponseBytes }))
            if (result.receipt.id !== id || result.receipt.provider !== task.provider || result.receipt.requestUrl !== url) throw new Error('Provider receipt does not match durable dispatch')
            await verifyResult(result)
            await writeDiscoveryRecord(join(directory, 'receipts', `${id}.json`), result)
            if (result.receipt.outcome === 'ok') await writeDiscoveryRecord(cachePath, { createdAt: clock.now(), result })
            await applyResult(task, result, false)
          }
          if (state.tasks.length) { stopReason = state.attempts >= config.maxRequests ? 'request_budget' : 'time_budget'; break }
          state.phase = 'review'; await save()
        }
        if (state.phase === 'review') {
          const rankedPool = rankRetainedCandidates(state.pool, config.maxCandidates, state.assessments, state.assessmentHashes)
          const byId = new Map(state.pool.map(candidate => [candidate.id, candidate]))
          const validIds = new Set(state.assessments.filter(assessment => { const candidate = byId.get(assessment.candidateId); return candidate && state.assessmentHashes?.[assessment.candidateId] === judgmentHash(candidate, assessment) }).map(assessment => assessment.candidateId))
          const reviewCandidates = rankDiscoveryCandidates(state.pool, state.pool.length).filter(candidate => !validIds.has(candidate.id)).slice(0, config.nearestLimit)
          if (reviewCandidates.length) {
            const excerpts = await createCandidateExcerpts(reviewCandidates, input.sourceStore.readSource.bind(input.sourceStore))
            const reviewInput = { idea: input.idea, candidates: reviewCandidates, excerpts, taskId: `idea-survey:${surveyId}:review:${hashContent(reviewCandidates.map(candidate => judgmentHash(candidate)))}` }
            const raw = await model(`review:${hashContent(reviewInput)}`, () => input.reviewer({ ...reviewInput, signal: abort.signal }))
            const fresh = await validateSimilarityAssessments(raw, reviewInput, input.sourceStore.readSource.bind(input.sourceStore))
            state.assessments = [...state.assessments.filter(assessment => !fresh.some(item => item.candidateId === assessment.candidateId)), ...fresh]
            state.assessmentHashes ??= {}
            for (const assessment of fresh) state.assessmentHashes[assessment.candidateId] = judgmentHash(byId.get(assessment.candidateId)!, assessment)
          }
          state.roundsCompleted = state.round
          state.lowYieldRounds = state.pool.length === state.roundInitialPoolSize ? state.lowYieldRounds + 1 : 0
          const providerDiversity = new Set(state.receipts.filter(r => r.outcome === 'ok').map(r => r.provider)).size
          const facetDiversity = new Set(state.queries.flatMap(q => q.dimensions)).size
          if (state.round >= config.minRounds && state.lowYieldRounds >= 2 && providerDiversity >= Math.min(2, input.providers.length) && facetDiversity >= 4) { stopReason = 'low_yield_with_diverse_coverage'; break }
          state.round++; state.phase = 'plan'; await save()
        }
      }
    } catch (error) {
      paused = true; stopReason = state.pendingModel ? 'unknown_model_outcome' : state.pendingHttp ? 'unknown_http_outcome' : abort.signal.aborted ? 'aborted_or_time_budget' : 'invalid_model_or_source'
      state.gaps.push(error instanceof Error ? error.message : 'Discovery interrupted')
    }
    account()
    const candidates = rankRetainedCandidates(state.pool, config.maxCandidates, state.assessments, state.assessmentHashes)
    const validAssessments = state.assessments.filter(assessment => { const candidate = state.pool.find(item => item.id === assessment.candidateId); return candidate && state.assessmentHashes?.[assessment.candidateId] === judgmentHash(candidate, assessment) })
    const judgments = new Map(validAssessments.map(a => [a.candidateId, a]))
    const nearest = [...candidates].sort((a, b) => semanticPriority(judgments.get(a.id)?.relevance) - semanticPriority(judgments.get(b.id)?.relevance) || discoveryRrfScore(b) - discoveryRrfScore(a) || a.id.localeCompare(b.id)).slice(0, config.nearestLimit)
    const coverage: SimilaritySurveyReport['providerCoverage'] = { arxiv: { attempts: 0, successful: 0, degraded: 0 }, crossref: { attempts: 0, successful: 0, degraded: 0 }, 'semantic-scholar': { attempts: 0, successful: 0, degraded: 0 } }
    for (const name of Object.keys(coverage) as DiscoveryProviderName[]) coverage[name].attempts = state.providerAttempts[name] ?? 0
    for (const receipt of state.receipts) { const c = coverage[receipt.provider]; if (receipt.outcome === 'ok') c.successful++; else c.degraded++ }
    for (const name of Object.keys(coverage) as DiscoveryProviderName[]) if (!input.providers.some(p => p.name === name)) coverage[name].note = 'Provider not configured'
    const expectedReview = new Set(nearest.map(c => c.id)); const assessments = validAssessments.filter(a => expectedReview.has(a.candidateId))
    const refs = [...state.receipts.flatMap(r => r.responseSource ? [r.responseSource] : []), ...candidates.flatMap(c => c.observations.map(o => o.sourceRef)), ...Object.values(state.modelResults).map(r => r.sourceRef)]
    const partial = state.roundsCompleted < config.minRounds || state.gaps.length > 0 || !['max_rounds', 'low_yield_with_diverse_coverage'].includes(stopReason) || assessments.length < nearest.length
    const report: SimilaritySurveyReport = { schema: 'autoresearch/current-idea-similarity/v1', surveyId, ideaFingerprint, configFingerprint, authority: 'advisory-discovery-only', status: paused ? 'paused' : candidates.length === 0 ? 'no_results' : partial ? 'partial' : 'complete', ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}), roundsCompleted: state.roundsCompleted, queries: state.queries, rejectedQueries: state.rejectedQueries, receipts: state.receipts, candidates, nearest, assessments, counts: { collected: state.pool.length, retained: candidates.length, omitted: state.pool.length - candidates.length, shortlisted: nearest.length, reviewed: assessments.length, actualHttpAttempts: state.attempts, cacheHits: state.cacheHits }, providerCoverage: coverage, gaps: [...new Set(state.gaps)], uncertainty: ['Discovery and model comparison are advisory, not scientific evidence.', 'Search ranking, missing abstracts and provider coverage limit recall; no results never establish novelty.'], stopReason, createdAt: state.createdAt, elapsedMs: state.elapsedMs, sourceRefs: [...new Map(refs.map(ref => [hashContent(ref), ref])).values()] }
    // A paused dispatch remains recoverable from its durable receipt on a later invocation.
    if (!paused) state.report = report
    await writeDiscoveryRecord(join(directory, 'pool.json'), state.pool)
    await writeDiscoveryRecord(join(directory, 'report.json'), report)
    await save()
    return report
  } finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); await release() }
}
