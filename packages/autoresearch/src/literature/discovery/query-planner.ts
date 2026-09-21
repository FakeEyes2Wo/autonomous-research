import { hashContent } from '../../research/records.js'
import type { DiscoveryDimension, DiscoveryQuery, QueryPlannerCallback, QueryPlannerInput } from './contracts.js'

export const normalizeDiscoveryQuery = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const dimensions: DiscoveryDimension[] = ['problem', 'mechanism', 'assumption', 'terminology', 'cross-domain']
export function validateDiscoveryQueries(raw: unknown, input: Omit<QueryPlannerInput, 'idea'>, rejected: { round: number; text: string; reason: string }[] = [], origin: DiscoveryQuery['origin'] = 'model'): DiscoveryQuery[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('Query planner must return a bounded array')
  const seen = new Set(input.priorQueries.map(q => normalizeDiscoveryQuery(q.text)))
  const result: DiscoveryQuery[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { rejected.push({ round: input.round, text: '', reason: 'invalid query entry' }); continue }
    const text = typeof item?.text === 'string' ? item.text.trim().replace(/\s+/g, ' ') : ''
    let reason = ''
    if (!text || text.length > 500 || /[\u0000-\u001f]/.test(text)) reason = 'invalid query text'
    else if (!Array.isArray(item.dimensions) || !item.dimensions.length || item.dimensions.some((d: unknown) => !dimensions.includes(d as DiscoveryDimension))) reason = 'invalid query dimensions'
    else if (item.origin && item.origin !== origin) reason = 'untrusted query origin'
    else if (seen.has(normalizeDiscoveryQuery(text))) reason = 'duplicate normalized query'
    else if (result.length >= input.maxQueries) reason = 'round query budget'
    if (reason) { rejected.push({ round: input.round, text, reason }); continue }
    seen.add(normalizeDiscoveryQuery(text))
    result.push({ id: `query-${hashContent({ text: normalizeDiscoveryQuery(text), round: input.round }).slice(0, 24)}`, text, round: input.round, dimensions: [...new Set(item.dimensions)] as DiscoveryDimension[], origin })
  }
  if (input.round === 1 && new Set(result.flatMap(q => q.dimensions)).size < 2) throw new Error('First round requires diverse search dimensions')
  return result
}
export async function planDiscoveryQueries(input: QueryPlannerInput & { callback: QueryPlannerCallback }): Promise<DiscoveryQuery[]> {
  const { callback, ...request } = input
  return validateDiscoveryQueries(await callback(request), input)
}
