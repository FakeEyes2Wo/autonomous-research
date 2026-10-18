import { hashContent } from '../../research/records.js'
import type { DiscoveryCandidate } from './contracts.js'

function nonContradictory(a: DiscoveryCandidate, b: DiscoveryCandidate): boolean {
  for (const kind of ['doi', 'arxiv'] as const) {
    const left = a.aliases.filter(x => x.kind === kind).map(x => x.value), right = b.aliases.filter(x => x.kind === kind).map(x => x.value)
    if (left.length && right.length && !left.some(x => right.includes(x))) return false
  }
  return true
}
function compatible(a: DiscoveryCandidate, b: DiscoveryCandidate): boolean {
  if (!nonContradictory(a, b)) return false
  if (a.aliases.some(x => x.kind !== 'url' && b.aliases.some(y => x.kind === y.kind && x.value === y.value))) return true
  const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  return !!(a.title.trim() && b.title.trim() && a.authors?.[0]?.trim() && b.authors?.[0]?.trim() && a.year !== null && a.year === b.year && normalize(a.title) === normalize(b.title) && normalize(a.authors[0]) === normalize(b.authors[0]))
}
export function mergeDiscoveryCandidates(input: readonly DiscoveryCandidate[]): DiscoveryCandidate[] {
  const result: DiscoveryCandidate[] = []
  for (const source of input) {
    const candidate = structuredClone(source)
    const matches = result.filter(prior => compatible(prior, candidate))
    // Ambiguous bridges must not collapse separate records with contradictory authoritative identifiers.
    const merge = matches.length === 1 || (matches.length > 1 && matches.every(a => matches.every(b => a === b || nonContradictory(a, b)))) ? matches : []
    for (const prior of merge) {
      candidate.aliases = [...new Map([...prior.aliases, ...candidate.aliases].map(a => [`${a.kind}:${a.value}`, a])).values()]
      candidate.providerHits = [...new Map([...prior.providerHits, ...candidate.providerHits].map(h => [hashContent(h), h])).values()]
      candidate.observations = [...new Map([...prior.observations, ...candidate.observations].map(o => [hashContent(o), o])).values()]
      for (const field of ['title', 'authors', 'year', 'abstract'] as const) {
        if (prior[field] !== null && candidate[field] !== null && hashContent(prior[field]) !== hashContent(candidate[field])) candidate.conflicts.push(field)
        if (prior[field] !== null) (candidate as any)[field] = prior[field]
      }
      candidate.conflicts.push(...prior.conflicts)
      result.splice(result.indexOf(prior), 1)
      candidate.id = prior.id
    }
    candidate.conflicts = [...new Set(candidate.conflicts)]
    // Separate ambiguous records must have separate host identities even if one provider's DOI collided.
    if (result.some(c => c.id === candidate.id)) candidate.id = `paper-${hashContent({ aliases: candidate.aliases, observations: candidate.observations.map(o => o.resultKey) }).slice(0, 24)}`
    result.push(candidate)
  }
  return result
}
export function discoveryRrfScore(candidate: DiscoveryCandidate): number {
  // Cormack et al., SIGIR 2009, §1: ranks avoid incompatible provider score scales.
  // https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
  const lists = new Map<string, number>()
  for (const hit of candidate.providerHits) { const key = `${hit.provider}:${hit.queryId}`; lists.set(key, Math.min(lists.get(key) ?? Infinity, hit.rank)) }
  return [...lists.values()].reduce((sum, rank) => sum + 1 / (60 + rank), 0)
}
export function rankDiscoveryCandidates(candidates: readonly DiscoveryCandidate[], limit: number): DiscoveryCandidate[] {
  const ranked = [...candidates].sort((a, b) => discoveryRrfScore(b) - discoveryRrfScore(a) || a.id.localeCompare(b.id))
  const selected: DiscoveryCandidate[] = []
  // Our exploration adaptation: reserve a representative for each provider and search facet.
  const groups = [...new Set(ranked.flatMap(c => c.providerHits.flatMap(h => [h.provider, ...h.dimensions])))].sort()
  for (const group of groups) {
    if (selected.length >= limit) break
    const found = ranked.find(c => !selected.includes(c) && c.providerHits.some(h => h.provider === group || h.dimensions.some(d => d === group)))
    if (found) selected.push(found)
  }
  for (const candidate of ranked) { if (selected.length >= limit) break; if (!selected.includes(candidate)) selected.push(candidate) }
  return selected.sort((a, b) => discoveryRrfScore(b) - discoveryRrfScore(a) || a.id.localeCompare(b.id))
}
