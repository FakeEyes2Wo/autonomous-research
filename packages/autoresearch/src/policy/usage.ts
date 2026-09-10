export interface UsageRecord { callId: string; requestId?: string; childId?: string; runId: string; role: string; task: string; tier: 'cheap'|'standard'|'deep'; provider?: string; model?: string; reasoningRoute?: string; inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number; attempt: number; cacheHit: boolean; routingReason?: string; contextTruncated?: string[]; stopReason: string; usageSource: 'provider'|'estimated'|'unknown' }
export interface UsageSummary { calls: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; totalTokens: number; retries: number; cacheHits: number; unknownUsage: number }

export function totalTokens(usage: Pick<UsageRecord, 'inputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'outputTokens'|'totalTokens'>): number | undefined {
  // Provider-reported totals are authoritative. Do not add reasoning to this
  // value: DSH output usage already includes reasoning tokens.
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) return Math.floor(usage.totalTokens)
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]
  return values.every((value) => typeof value === 'number' && Number.isFinite(value)) ? values.reduce<number>((sum, value) => sum + (value as number), 0) : undefined
}
export function normalizeUsage(record: UsageRecord): UsageRecord {
  const total = totalTokens(record)
  return total === undefined ? { ...record, totalTokens: undefined } : { ...record, totalTokens: total }
}
function dedupKey(record: UsageRecord): string { return `${record.childId ?? ''}\u0000${record.requestId ?? record.callId}` }
function moreComplete(a: UsageRecord, b: UsageRecord): UsageRecord { return (b.attempt > a.attempt || (b.attempt === a.attempt && totalTokens(b) !== undefined && totalTokens(a) === undefined)) ? b : a }
export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const unique = new Map<string, UsageRecord>()
  for (const raw of records) { const record = normalizeUsage(raw); const key = dedupKey(record); unique.set(key, unique.has(key) ? moreComplete(unique.get(key)!, record) : record) }
  return [...unique.values()].reduce((summary, record) => ({ calls: summary.calls + 1, inputTokens: summary.inputTokens + (record.inputTokens ?? 0), cacheReadTokens: summary.cacheReadTokens + (record.cacheReadTokens ?? 0), cacheWriteTokens: summary.cacheWriteTokens + (record.cacheWriteTokens ?? 0), outputTokens: summary.outputTokens + (record.outputTokens ?? 0), totalTokens: summary.totalTokens + (record.totalTokens ?? 0), retries: summary.retries + Math.max(0, record.attempt - 1), cacheHits: summary.cacheHits + (record.cacheHit ? 1 : 0), unknownUsage: summary.unknownUsage + (record.usageSource === 'unknown' || record.totalTokens === undefined ? 1 : 0) }), { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, retries: 0, cacheHits: 0, unknownUsage: 0 })
}
