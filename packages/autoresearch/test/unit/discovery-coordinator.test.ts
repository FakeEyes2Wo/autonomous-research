import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeClock, memorySources, providerFixture, fixtureIdea, queryPlan, groundedReview } from './discovery-test-utils.ts'
const api = await import('../../dist/literature/discovery/index.js').catch(() => ({})) as any
const persistence = await import('../../dist/literature/discovery/checkpoint.js').catch(() => ({})) as any
test('bounded defaults reserve at least three rounds and retain two hundred without treating retention as a stop', () => {
  assert.equal(typeof api.resolveDiscoveryConfig, 'function')
  const config = api.resolveDiscoveryConfig({})
  assert.equal(config.minRounds, 3); assert.equal(config.maxRounds, 5); assert.equal(config.maxRequests, 80)
  assert.equal(config.maxCandidates, 200); assert.equal(config.nearestLimit, 20); assert.equal(config.maxDurationMs, 600000)
  assert.equal('mode' in config, false)
})
async function harness(t: any, config: any = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-unit-')); t.after(() => rm(runDir, { recursive: true, force: true }))
  const sourceStore = memorySources(), clock = fakeClock(); const calls: { url: string; time: number }[] = []
  const providers = api.createDiscoveryProviders({ sourceStore, fetch: async (url: any) => { calls.push({ url: String(url), time: clock.now() }); return providerFixture(url) } })
  return { input: { runDir, idea: fixtureIdea, sourceStore, clock, providers, queryPlanner: queryPlan, reviewer: groundedReview, config: { minRounds: 3, maxRounds: 3, maxPagesPerQuery: 1, ...config } }, calls }
}
test('retention cap never stops minimum rounds; same semantic target resumes without HTTP or model repetition', async t => {
  const { input, calls } = await harness(t, { maxCandidates: 1, nearestLimit: 1 }); let modelCalls = 0
  input.queryPlanner = async (args: any) => { modelCalls++; return queryPlan(args) }
  const first = await api.runSimilaritySurvey(input)
  assert.equal(first.roundsCompleted, 3); assert.equal(calls.length, 18); assert.equal(first.counts.collected, 4); assert.equal(first.counts.retained, 1); assert.equal(first.counts.omitted, 3)
  assert.equal(first.authority, 'advisory-discovery-only')
  const second = await api.runSimilaritySurvey({ ...input, idea: { ...fixtureIdea, source: 'revision', runId: 'different' } })
  assert.deepEqual(second, first); assert.equal(calls.length, 18); assert.equal(modelCalls, 3)
  for (const host of ['arxiv', 'crossref', 'semanticscholar']) { const stamps = calls.filter(c => c.url.includes(host)).map(c => c.time); assert.ok(stamps.slice(1).every((time, i) => time - stamps[i]! >= (host === 'arxiv' ? 3000 : 1000))) }
})
test('changed idea reuses only verified provider cache and performs fresh semantic review', async t => {
  const { input, calls } = await harness(t); let reviews = 0
  input.reviewer = async args => { reviews++; return groundedReview(args) }
  const first = await api.runSimilaritySurvey(input); const count = calls.length, previousReviews = reviews
  const second = await api.runSimilaritySurvey({ ...input, idea: { ...fixtureIdea, mechanism: 'different mechanism' } })
  assert.notEqual(first.surveyId, second.surveyId); assert.equal(calls.length, count); assert.equal(second.counts.actualHttpAttempts, 0); assert.equal(second.counts.cacheHits, 18); assert.ok(reviews > previousReviews)
  assert.equal(Object.values(second.providerCoverage).reduce((sum: number, item: any) => sum + item.attempts, 0), 0)
  input.sourceStore.values.set(first.sourceRefs[0].hash, Buffer.from('corrupt'))
  await assert.rejects(api.runSimilaritySurvey(input), /bytes|hash/i)
})
test('Retry-After defers one provider while other sources advance, each retry counts', async t => {
  const { input } = await harness(t, { maxRetries: 1 }); const calls: { host: string; at: number }[] = []; let arxivCalls = 0
  input.providers = api.createDiscoveryProviders({ sourceStore: input.sourceStore, fetch: async (url: any) => { const host = new URL(String(url)).hostname; calls.push({ host, at: input.clock.now() }); if (host.includes('arxiv') && arxivCalls++ === 0) return new Response('wait', { status: 429, headers: { 'Retry-After': '8' } }); return providerFixture(url) } })
  const report = await api.runSimilaritySurvey(input)
  assert.equal(report.counts.actualHttpAttempts, 19); assert.equal(report.receipts.filter((r: any) => r.outcome === 'rate_limited').length, 1)
  assert.ok(calls.some(c => c.host.includes('crossref') && c.at < calls[0]!.at + 8000))
  assert.ok(calls.filter(c => c.host.includes('arxiv'))[1]!.at >= calls[0]!.at + 8000)
})
test('unknown model outcome is durably debited and cannot be redispatched on resume', async t => {
  const { input, calls } = await harness(t); let plans = 0
  input.queryPlanner = async () => { plans++; throw new Error('lost model receipt') }
  const first = await api.runSimilaritySurvey(input); const second = await api.runSimilaritySurvey(input)
  assert.equal(first.status, 'paused'); assert.equal(second.stopReason, 'unknown_model_outcome'); assert.equal(plans, 1); assert.equal(calls.length, 0)
})
test('queue exhaustion and no results do not establish novelty', async t => {
  const { input } = await harness(t)
  input.queryPlanner = async ({ round }: any) => round === 1 ? queryPlan({ round }) : []
  const report = await api.runSimilaritySurvey(input)
  assert.equal(report.status, 'partial'); assert.equal(report.stopReason, 'query_queue_exhausted'); assert.equal(report.roundsCompleted, 1)
  assert.ok(report.uncertainty.some((s: string) => s.includes('never establish novelty')))
})
test('final nearest ordering uses validated semantic judgment rather than literal/provider rank', async t => {
  const { input } = await harness(t)
  input.reviewer = async (args: any) => (await groundedReview(args)).map((a: any) => ({ ...a, relevance: args.candidates.find((c: any) => c.id === a.candidateId).title === 'REST' ? 'nearest' : 'weak' }))
  const report = await api.runSimilaritySurvey(input)
  assert.equal(report.nearest[0].title, 'REST')
})
test('retains an earlier semantically nearest candidate when later weak decoys gain more hits', async t => {
  const { input } = await harness(t, { minRounds: 3, maxRounds: 3, maxPagesPerQuery: 1, maxCandidates: 1, nearestLimit: 1 })
  const sourceStore = input.sourceStore
  const provider = {
    name: 'semantic-scholar',
    async search(args: any) {
      const later = args.query.round > 1
      const id = later ? 'decoy' : 'anchor'
      const title = later ? 'Literal decoy' : 'Different wording anchor'
      const body = JSON.stringify({ data: [{ paperId: id, title, abstract: later ? 'literal terms only' : 'attenuated delegated authority', year: 2024, authors: [] }] })
      const raw = await sourceStore.captureBytes(body, `${args.attemptId}:raw-http`)
      const parsed = await sourceStore.captureBytes(JSON.stringify({ parserVersion: 'provider-metadata/v1', provider: 'semantic-scholar', resultKey: id, rawSource: raw, title, authors: [], year: 2024, abstract: JSON.parse(body).data[0].abstract }), `${args.attemptId}:parsed:0`)
      const receipt = { id: args.attemptId, provider: 'semantic-scholar', requestUrl: api.discoveryRequestUrl('semantic-scholar', args.query.text, args.page, args.pageSize), queryId: args.query.id, page: args.page, startedAt: new Date(args.now()).toISOString(), finishedAt: new Date(args.now()).toISOString(), status: 200, responseSource: raw, responseBytes: body.length, retryAfterMs: null, parserVersion: 'provider-metadata/v1', outcome: 'ok' }
      return { receipt, hasMore: false, candidates: [{ id, title, authors: [], year: 2024, abstract: JSON.parse(body).data[0].abstract, aliases: [{ kind: 'provider', value: `semantic-scholar:${id}` }], providerHits: [{ provider: 'semantic-scholar', receiptId: args.attemptId, resultKey: id, queryId: args.query.id, rank: 1, dimensions: args.query.dimensions }], observations: [{ receiptId: args.attemptId, title, authors: [], year: 2024, abstract: JSON.parse(body).data[0].abstract, sourceRef: parsed, parserVersion: 'provider-metadata/v1', resultKey: id, rawSource: raw }], conflicts: [] }] }
    },
  }
  input.providers = [provider]
  const report = await api.runSimilaritySurvey({ ...input, reviewer: async (args: any) => args.candidates.map((candidate: any) => ({ candidateId: candidate.id, overlap: [], differences: [], uncertainty: [], relevance: candidate.title === 'Different wording anchor' ? 'nearest' : 'weak', excerptProofs: [{ candidateId: candidate.id, sourceRef: args.excerpts.find((excerpt: any) => excerpt.candidateId === candidate.id).sourceRef, start: 0, end: args.excerpts.find((excerpt: any) => excerpt.candidateId === candidate.id).end, contentHash: args.excerpts.find((excerpt: any) => excerpt.candidateId === candidate.id).contentHash }], followupQueries: [], citationSeeds: [] })) })
  assert.equal(report.nearest[0]?.title, 'Different wording anchor')
})
test('crash HTTP reservation charges elapsed interval and does not redispatch unknown request', async t => {
  const { input, calls } = await harness(t)
  const first = await api.runSimilaritySurvey(input); const previousCalls = calls.length
  const path = join(input.runDir, 'brainstorm', 'current-idea-survey', first.ideaFingerprint, first.configFingerprint, 'checkpoint.json')
  const state = await persistence.readDiscoveryRecord(path)
  const query = state.queries[0]; const task = { key: 'arxiv:crash:0:0', provider: 'arxiv', query, page: 0, retry: 0, readyAt: 0 }
  delete state.report; state.phase = 'search'; state.round = 1; state.roundsCompleted = 0; state.tasks = [task]; state.elapsedMs = 0
  state.pendingHttp = { task, id: 'crashed-http', startedAt: input.clock.now() - 600001 }; state.attempts++
  await persistence.writeDiscoveryRecord(path, state)
  const resumed = await api.runSimilaritySurvey(input)
  assert.ok(resumed.elapsedMs >= 600000); assert.equal(calls.length, previousCalls); assert.equal(resumed.stopReason, 'time_budget')
  assert.ok(resumed.receipts.some((r: any) => r.id === 'crashed-http' && r.outcome === 'unknown'))
  assert.equal(resumed.receipts.find((r: any) => r.id === 'crashed-http').startedAt, new Date(input.clock.now() - 600001).toISOString())
})
test('identity union admits verified bridges and exact bibliographic fallback but preserves conflicting identifiers', () => {
  const paper = (id: string, aliases: any[], title = id) => ({ id, aliases, title, authors: ['First Author'], year: 2020, abstract: null, providerHits: [], observations: [], conflicts: [] })
  const a = paper('a', [{ kind: 'doi', value: '10.1234/a' }])
  const b = paper('b', [{ kind: 'arxiv', value: '2005.11401' }])
  const bridge = paper('bridge', [...a.aliases, ...b.aliases])
  assert.equal(api.mergeDiscoveryCandidates([a, b, bridge]).length, 1)
  assert.equal(api.mergeDiscoveryCandidates([a, paper('c', [{ kind: 'doi', value: '10.1234/c' }, ...b.aliases]), bridge]).length, 2)
  assert.equal(api.mergeDiscoveryCandidates([paper('x', [], 'Same title'), paper('y', [], 'Same title')]).length, 1)
  assert.equal(api.mergeDiscoveryCandidates([paper('x', a.aliases, 'Same title'), paper('y', [{ kind: 'doi', value: '10.1234/other' }], 'Same title')]).length, 2)
})
test('stale lock recovery has one owner and old release cannot delete a replacement lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'discovery-lock-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'execution.lock'); await writeFile(path, '2147483647')
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => persistence.lockDiscoveryDirectory(directory)))
  const winners = results.filter((r: any) => r.status === 'fulfilled') as PromiseFulfilledResult<() => Promise<void>>[]
  assert.equal(winners.length, 1)
  const replacement = JSON.stringify({ pid: process.pid, token: 'different-owner' }); await writeFile(path, replacement)
  await assert.rejects(winners[0]!.value(), /owner|changed/i)
  assert.equal(await readFile(path, 'utf8'), replacement)
})
test('durable completed HTTP receipt recovers before any new dispatch', async t => {
  const { input, calls } = await harness(t)
  const first = await api.runSimilaritySurvey(input); const previous = calls.length
  const directory = join(input.runDir, 'brainstorm', 'current-idea-survey', first.ideaFingerprint, first.configFingerprint)
  const path = join(directory, 'checkpoint.json'); const state = await persistence.readDiscoveryRecord(path)
  const receipt = state.receipts[0]; const query = state.queries.find((q: any) => q.id === receipt.queryId)
  const task = { key: `${receipt.provider}:${query.id}:0:0`, provider: receipt.provider, query, page: 0, retry: 0, readyAt: 0 }
  delete state.report; state.round = 1; state.phase = 'search'; state.roundsCompleted = 0; state.tasks = [task]
  state.pendingHttp = { task, id: receipt.id, startedAt: input.clock.now() }
  await persistence.writeDiscoveryRecord(path, state)
  const resumed = await api.runSimilaritySurvey(input)
  assert.equal(calls.length, previous); assert.ok(resumed.receipts.some((r: any) => r.id === receipt.id)); assert.ok(!resumed.gaps.some((g: string) => g.includes('Unknown HTTP')))
})
test('durable completed model receipt recovers without paying the planner again', async t => {
  const { input } = await harness(t); const first = await api.runSimilaritySurvey(input)
  const path = join(input.runDir, 'brainstorm', 'current-idea-survey', first.ideaFingerprint, first.configFingerprint, 'checkpoint.json')
  const state = await persistence.readDiscoveryRecord(path); const entry = Object.entries(state.modelResults).find(([key]) => key.startsWith('plan:')) as any
  delete state.report; state.round = 1; state.phase = 'plan'; state.roundsCompleted = 0; state.queries = []; state.tasks = []; state.assessments = []
  state.pendingModel = { key: entry[0], id: entry[1].sourceRef.id, startedAt: input.clock.now() }; delete state.modelResults[entry[0]]
  await persistence.writeDiscoveryRecord(path, state)
  let plans = 0; input.queryPlanner = async () => { plans++; throw new Error('must not dispatch') }
  const resumed = await api.runSimilaritySurvey(input)
  assert.equal(plans, 0); assert.notEqual(resumed.stopReason, 'unknown_model_outcome')
})
test('model call is bounded by wall budget even if the callback ignores cancellation', async t => {
  const { input, calls } = await harness(t, { maxDurationMs: 20 }); input.queryPlanner = async () => new Promise(() => {})
  const result = await api.runSimilaritySurvey(input)
  assert.equal(result.status, 'paused'); assert.equal(result.stopReason, 'unknown_model_outcome'); assert.equal(calls.length, 0)
})
test('dispatch intent and request debit are durable before the first real adapter HTTP call', async t => {
  const { input } = await harness(t, { maxRequests: 1 }); let checked = false
  input.providers = api.createDiscoveryProviders({ sourceStore: input.sourceStore, fetch: async (url: any) => {
    const root = join(input.runDir, 'brainstorm', 'current-idea-survey', api.fingerprintIdea(input.idea))
    const dirs = await (await import('node:fs/promises')).readdir(root)
    const state = await persistence.readDiscoveryRecord(join(root, dirs[0]!, 'checkpoint.json'))
    assert.equal(state.attempts, 1); assert.ok(state.pendingHttp.id); checked = true; return providerFixture(url)
  } })
  const report = await api.runSimilaritySurvey(input)
  assert.equal(checked, true); assert.equal(report.counts.actualHttpAttempts, 1); assert.equal(report.stopReason, 'request_budget')
})
test('unknown model recovery charges each interval once while preserving original dispatch time', async t => {
  const { input } = await harness(t); input.queryPlanner = async () => { input.clock.advance(100); throw new Error('lost') }
  const first = await api.runSimilaritySurvey(input); assert.equal(first.elapsedMs, 100)
  input.clock.advance(200); const second = await api.runSimilaritySurvey(input); assert.equal(second.elapsedMs, 300)
  input.clock.advance(50); const third = await api.runSimilaritySurvey(input); assert.equal(third.elapsedMs, 350)
})
test('query shortfall records incomplete coverage without a paid planner retry', async t => {
  const { input } = await harness(t); let plans = 0
  input.queryPlanner = async ({ round }: any) => { plans++; return [{ text: `one query ${round}`, dimensions: ['mechanism', 'problem'] }] }
  const report = await api.runSimilaritySurvey(input)
  assert.equal(plans, 3); assert.equal(report.status, 'partial'); assert.ok(report.gaps.some((g: string) => /query shortfall/i.test(g)))
})
