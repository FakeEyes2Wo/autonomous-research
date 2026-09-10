import { LedgerError, type RequestDescriptor, type RequestLedger, type UsageSettlement } from './request-ledger.js'
import type { UsageRecord } from './usage.js'

export interface StreamUsageChunk {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  stopReason?: string
}

export interface BudgetedStreamOptions<TOptions, TChunk> {
  ledger: RequestLedger
  descriptor: RequestDescriptor
  /** Passed to next without mutation; DSH freezes this object. */
  options: Readonly<TOptions>
  next: (options: Readonly<TOptions>) => AsyncIterable<TChunk>
  usageFromChunk?: (chunk: TChunk) => StreamUsageChunk | undefined
  usageSource?: 'provider' | 'estimated' | 'unknown'
  /** Explicit recovery only; prevents a repeated request ID from dispatching twice by default. */
  allowExisting?: boolean
}

/**
 * Wraps one owned llm/stream request. It never changes options or maxTokens;
 * the provider must receive its cap through agentOptions before this hook.
 */
export async function* runBudgetedStream<TOptions, TChunk>(input: BudgetedStreamOptions<TOptions, TChunk>): AsyncGenerator<TChunk> {
  const reservation = await input.ledger.beginRequest(input.descriptor)
  if (!reservation.created && (!input.allowExisting || reservation.status === 'settled')) throw new LedgerError('REQUEST_CONFLICT', `request ${input.descriptor.requestId} already has a dispatch or settlement`)
  let observed: StreamUsageChunk | undefined
  let stopReason = 'completed'
  let settled = false
  try {
    for await (const chunk of input.next(input.options)) {
      const usage = input.usageFromChunk?.(chunk)
      if (usage) observed = mergeUsage(observed, usage)
      if (usage?.stopReason) stopReason = usage.stopReason
      yield chunk
    }
    await input.ledger.settleRequest(input.descriptor.requestId, settlement(observed, input.usageSource, stopReason))
    settled = true
  } catch (error) {
    await input.ledger.settleRequest(input.descriptor.requestId, settlement(observed, input.usageSource, error instanceof Error ? `error:${error.name}` : 'interrupted'))
    settled = true
    throw error
  } finally {
    // Consumer cancellation (return/break) skips the normal loop completion.
    if (!settled) await input.ledger.settleRequest(input.descriptor.requestId, settlement(observed, input.usageSource, 'cancelled'))
  }
}

export interface BoundTaskScope { beginRole(): ReturnType<RequestLedger['beginRole']>; beginRequest(descriptor: Omit<RequestDescriptor, 'taskId' | 'role' | 'tier' | 'childId'> & Partial<Pick<RequestDescriptor, 'role' | 'tier' | 'childId'>>): ReturnType<RequestLedger['beginRequest']>; settleRequest(requestId: string, settlement: UsageSettlement): Promise<UsageRecord>; }

/** Restricts a caller to one research task/child; it does not cover other DSH sessions. */
export function bindTask(ledger: RequestLedger, scope: { taskId: string; role: string; tier: RequestDescriptor['tier']; childId?: string; roleStartId?: string }): BoundTaskScope {
  return {
    beginRole: () => ledger.beginRole({ roleStartId: scope.roleStartId ?? `${scope.taskId}:${scope.childId ?? 'root'}:${scope.role}`, taskId: scope.taskId, role: scope.role, tier: scope.tier, ...(scope.childId ? { childId: scope.childId } : {}) }),
    beginRequest: (descriptor) => ledger.beginRequest({ ...descriptor, taskId: scope.taskId, role: descriptor.role ?? scope.role, tier: descriptor.tier ?? scope.tier, ...(descriptor.childId ?? scope.childId ? { childId: descriptor.childId ?? scope.childId } : {}) }),
    settleRequest: (requestId, settlement) => ledger.settleRequest(requestId, settlement),
  }
}

function mergeUsage(previous: StreamUsageChunk | undefined, next: StreamUsageChunk): StreamUsageChunk { return { ...previous, ...Object.fromEntries(Object.entries(next).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))), ...(next.stopReason ? { stopReason: next.stopReason } : {}) } }
function settlement(usage: StreamUsageChunk | undefined, source: BudgetedStreamOptions<unknown, unknown>['usageSource'], stopReason: string): UsageSettlement { return { ...(usage ?? {}), usageSource: source ?? (usage ? 'provider' : 'unknown'), stopReason } }
