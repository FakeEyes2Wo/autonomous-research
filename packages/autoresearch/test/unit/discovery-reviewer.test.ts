import test from 'node:test'
import assert from 'node:assert/strict'
import { memorySources, providerFixture, fixtureIdea, groundedReview } from './discovery-test-utils.ts'
const api = await import('../../dist/literature/discovery/index.js').catch(() => ({})) as any
test('reviewer rejects invented candidate IDs and ungrounded excerpts', async () => {
  assert.equal(typeof api.reviewSimilarity, 'function')
  const input = { idea: { statement: 'authority restriction', profile: '', scope: '', mechanism: '', prediction: '', falsification: '', measurement: '', decisionRule: '', alternatives: [], assumptions: [], terminology: [], crossDomainAnalogs: [] }, candidates: [], excerpts: [], readSource: async () => Buffer.from('actual') }
  await assert.rejects(api.reviewSimilarity({ ...input, callback: async () => [{ candidateId: 'invented', overlap: ['same mechanism'], differences: [], uncertainty: [], relevance: 'nearest', excerptProofs: [], followupQueries: [], citationSeeds: [] }] }), /candidate/i)
})
test('semantic comparison admits old and synonym-mechanism matches without word-overlap filtering', async () => {
  const sourceStore = memorySources(); const providers = api.createDiscoveryProviders({ sourceStore, fetch: providerFixture })
  const results = await Promise.all(providers.map((p: any) => p.search({ query: { id: 'q', text: 'idea synonym', dimensions: ['cross-domain'], round: 1, origin: 'model' }, page: 0, pageSize: 20, signal: new AbortController().signal, now: () => 0 })))
  const candidates = api.mergeDiscoveryCandidates(results.flatMap((r: any) => r.candidates))
  assert.equal(candidates.length, 4)
  const excerpts = await api.createCandidateExcerpts(candidates, sourceStore.readSource)
  const assessments = await api.reviewSimilarity({ idea: fixtureIdea, candidates, excerpts, readSource: sourceStore.readSource, callback: groundedReview })
  assert.equal(assessments.length, 4); assert.ok(candidates.some((c: any) => c.year === 2014))
  for (const mutation of [ (a: any) => { a.citationSeeds = ['10.1000/invented'] }, (a: any) => { a.excerptProofs[0].contentHash = 'forged' }, (a: any) => { a.excerptProofs[0].sourceRef = { ...a.excerptProofs[0].sourceRef, id: 'forged-alias' } }, (a: any) => { a.novelty = 'proven' } ]) {
    const raw = await groundedReview({ candidates, excerpts }); mutation(raw[0])
    await assert.rejects(api.reviewSimilarity({ idea: fixtureIdea, candidates, excerpts, readSource: sourceStore.readSource, callback: async () => raw }))
  }
  const unrelated = { ...excerpts[1], candidateId: candidates[0].id }
  await assert.rejects(api.reviewSimilarity({ idea: fixtureIdea, candidates: [candidates[0]], excerpts: [unrelated], readSource: sourceStore.readSource, callback: groundedReview }), /source|candidate|observation/i)
  const first = excerpts[0]; sourceStore.values.set(first.sourceRef.hash, Buffer.from('replaced bytes'))
  await assert.rejects(api.reviewSimilarity({ idea: fixtureIdea, candidates, excerpts, readSource: sourceStore.readSource, callback: groundedReview }), /bytes|hash/i)
})
test('public reviewer validator bounds aggregate output before accepting it', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, aliases: [], observations: [] }))
  const raw = candidates.map(c => ({ candidateId: c.id, overlap: [], differences: [], uncertainty: Array(20).fill('u'.repeat(4000)), relevance: 'uncertain', excerptProofs: [], followupQueries: [], citationSeeds: [] }))
  await assert.rejects(api.validateSimilarityAssessments(raw, { idea: fixtureIdea, candidates, excerpts: [] }, async () => Buffer.from('')), /oversiz|bound|large/i)
})
