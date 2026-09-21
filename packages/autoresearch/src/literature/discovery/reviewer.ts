import { hashBytes, hashContent } from '../../research/records.js'
import type { CandidateExcerpt, DiscoveryCandidate, DiscoverySourceStore, SimilarityAssessment, SimilarityReviewerCallback, SimilarityReviewerInput } from './contracts.js'
import { verifyDiscoverySource } from './providers.js'

/** Offsets are UTF-16 code units in the verified UTF-8 decoded observation document. */
export async function createCandidateExcerpts(candidates: readonly DiscoveryCandidate[], readSource: DiscoverySourceStore['readSource']): Promise<CandidateExcerpt[]> {
  const result: CandidateExcerpt[] = []
  for (const candidate of candidates) for (const observation of candidate.observations) {
    const bytes = await verifyDiscoverySource({ readSource }, observation.sourceRef)
    const document = Buffer.from(bytes).toString('utf8'); const decoded = JSON.parse(document)
    if (decoded.parserVersion !== observation.parserVersion || decoded.resultKey !== observation.resultKey || hashContent(decoded.rawSource) !== hashContent(observation.rawSource) || ['title', 'authors', 'year', 'abstract'].some(key => hashContent(decoded[key]) !== hashContent(observation[key as 'title']))) throw new Error('Parsed observation does not match captured bytes')
    await verifyDiscoverySource({ readSource }, observation.rawSource)
    const end = Math.min(document.length, 8000); const text = document.slice(0, end)
    result.push({ candidateId: candidate.id, text, start: 0, end, sourceReceiptId: observation.receiptId, sourceHash: observation.sourceRef.hash!, sourceRef: observation.sourceRef, contentHash: hashBytes(text) })
    // One verified observation per candidate keeps model input bounded. Conflicts remain in the candidate record.
    break
  }
  return result
}
function strings(value: unknown, label: string, limit = 20): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || v.length > 4000)) throw new Error(`Invalid reviewer ${label}`)
  return value
}
export async function validateSimilarityAssessments(raw: unknown, input: SimilarityReviewerInput, readSource: DiscoverySourceStore['readSource']): Promise<SimilarityAssessment[]> {
  const encoded = JSON.stringify(raw)
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 1_000_000) throw new Error('Reviewer output exceeds aggregate byte bound')
  if (!Array.isArray(raw) || raw.length > input.candidates.length) throw new Error('Reviewer must return bounded candidate assessments')
  const candidates = new Map(input.candidates.map(c => [c.id, c])); const seen = new Set<string>(); const result: SimilarityAssessment[] = []
  for (const item of raw) {
    const candidate = candidates.get(item?.candidateId)
    if (!candidate || seen.has(candidate.id)) throw new Error('Unknown or duplicate reviewer candidate ID')
    seen.add(candidate.id)
    const overlap = strings(item.overlap, 'overlap'), differences = strings(item.differences, 'differences'), uncertainty = strings(item.uncertainty, 'uncertainty')
    if (!['nearest', 'related', 'weak', 'uncertain'].includes(item.relevance)) throw new Error('Invalid reviewer relevance')
    const followupQueries = strings(item.followupQueries, 'follow-up queries', 4)
    if (followupQueries.some(q => !q.trim() || q.length > 500)) throw new Error('Invalid reviewer follow-up query')
    const citationSeeds = strings(item.citationSeeds, 'citation seeds')
    if (citationSeeds.some(seed => !candidate.aliases.some(a => a.value === seed))) throw new Error('Invented citation alias')
    if (!Array.isArray(item.excerptProofs) || item.excerptProofs.length > 10 || (!item.excerptProofs.length && (overlap.length || differences.length || item.relevance !== 'uncertain'))) throw new Error('Reviewer judgment requires exact excerpt proof')
    for (const proof of item.excerptProofs) {
      const excerpt = input.excerpts.find(e => e.candidateId === candidate.id && proof.candidateId === candidate.id && hashContent(e.sourceRef) === hashContent(proof.sourceRef))
      if (!excerpt || !Number.isSafeInteger(proof.start) || !Number.isSafeInteger(proof.end) || proof.start < excerpt.start || proof.end > excerpt.end || proof.end <= proof.start) throw new Error('Invalid excerpt proof source or bounds')
      if (!candidate.observations.some(o => o.receiptId === excerpt.sourceReceiptId && hashContent(o.sourceRef) === hashContent(excerpt.sourceRef))) throw new Error('Excerpt source is not an observation of this candidate')
      const bytes = await verifyDiscoverySource({ readSource }, proof.sourceRef)
      const document = Buffer.from(bytes).toString('utf8')
      if (hashBytes(document.slice(proof.start, proof.end)) !== proof.contentHash || document.slice(excerpt.start, excerpt.end) !== excerpt.text || hashBytes(excerpt.text) !== excerpt.contentHash) throw new Error('Excerpt proof bytes mismatch')
    }
    // Models do not get to attach papers, aliases, scientific verdicts, or fabricated sources.
    const allowed = new Set(['candidateId', 'overlap', 'differences', 'uncertainty', 'relevance', 'excerptProofs', 'followupQueries', 'citationSeeds'])
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('Unexpected reviewer field')
    result.push({ candidateId: candidate.id, overlap, differences, uncertainty: [...uncertainty, 'Similarity is advisory; retrieval coverage cannot establish novelty or scientific validity.'], relevance: item.relevance, excerptProofs: item.excerptProofs, followupQueries, citationSeeds })
  }
  return result
}
export async function reviewSimilarity(input: SimilarityReviewerInput & { callback: SimilarityReviewerCallback; readSource: DiscoverySourceStore['readSource'] }): Promise<SimilarityAssessment[]> {
  const { callback, readSource, ...request } = input
  return validateSimilarityAssessments(await callback(request), request, readSource)
}
