import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runBudgetedStream } from '../policy/llm-budget.js'
import { LedgerBudgetExceededError, type RequestLedger } from '../policy/request-ledger.js'
import { estimateTokens } from '../policy/context.js'

export interface OwnedSessionBinding {
  readonly ledger: RequestLedger
  readonly runId: string
  readonly taskId: string
  readonly role: string
  readonly kind?: 'role' | 'repair'
  readonly tier: 'cheap' | 'standard' | 'deep'
  readonly childId: string
  readonly provider?: string
  readonly model?: string
  readonly routingReason?: string
  readonly maxOutputTokens?: number
  readonly maxInputTokens?: number
  readonly capabilityStatus: 'hard' | 'estimated' | 'limited'
  readonly budgetFailure?: { value?: unknown }
}

const ownedSessions = new Map<string, OwnedSessionBinding>()
const requestBinding = new AsyncLocalStorage<OwnedSessionBinding>()

export function withRequestBinding<T>(binding: OwnedSessionBinding, operation: () => Promise<T>): Promise<T> {
  return requestBinding.run(binding, operation)
}
export function registerOwnedSession(sessionId: string, binding: OwnedSessionBinding): () => void {
  const existing = ownedSessions.get(sessionId)
  if (existing && existing.ledger !== binding.ledger) throw new Error('owned subagent session collision')
  ownedSessions.set(sessionId, binding)
  return () => {
    if (ownedSessions.get(sessionId) === binding) ownedSessions.delete(sessionId)
  }
}

function requestKind(options: GenerateOptions, binding: OwnedSessionBinding): 'role' | 'repair' | 'compaction' | 'title' {
  if (options.purpose === 'compaction') return 'compaction'
  if (options.purpose === 'session-title') return 'title'
  if (binding.kind === 'repair') return 'repair'
  return 'role'
}

function usageFromChunk(chunk: StreamChunk) {
  if (chunk.type === 'usage') return chunk.usage
  if (chunk.type === 'finish') return { stopReason: typeof chunk.reason === 'string' ? chunk.reason : chunk.reason.kind }
  return undefined
}

function estimatedInput(options: GenerateOptions): number {
  const tools = 'tools' in options ? JSON.stringify((options as GenerateOptions & { tools?: unknown }).tools ?? '') : ''
  const text = options.messages.map((message) => JSON.stringify(message.content)).join('\n')
  return estimateTokens((options.system ?? '') + '\n' + text + '\n' + tools)
}

/**
 * Mounts an ownership-filtered ledger around DSH's native llm/stream waterfall.
 * Unregistered sessions pass through untouched, so this cannot charge unrelated
 * DSH conversations. The disposer is safe to call during plugin teardown.
 */
export function installRequestAccounting(ctx: Context): () => void {
  return ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId
    const binding = (sessionId ? ownedSessions.get(sessionId) : undefined) ?? requestBinding.getStore()
    if (!binding) return next()
    if (binding.maxOutputTokens !== undefined && options.maxTokens !== undefined && options.maxTokens > binding.maxOutputTokens) {
      const requestedOutput = options.maxTokens
      const error = new LedgerBudgetExceededError(0, requestedOutput)
      if (binding.budgetFailure) binding.budgetFailure.value = error
      return (async function* () { throw error })()
    }
    const childId = sessionId ?? binding.childId
    const requestId = `${binding.runId}:${childId}:${randomUUID()}`
    const estimated = estimatedInput(options)
    const stream = runBudgetedStream({
      ledger: binding.ledger,
      descriptor: {
        requestId,
        taskId: binding.taskId,
        role: binding.role,
        tier: binding.tier,
        kind: requestKind(options, binding),
        childId,
        provider: options.provider,
        model: options.model,
        estimatedInputTokens: estimated,
        ...(binding.maxInputTokens !== undefined ? { maxInputTokens: binding.maxInputTokens } : {}),
        ...(binding.maxOutputTokens !== undefined ? { maxOutputTokens: binding.maxOutputTokens } : options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        capabilityStatus: binding.capabilityStatus,
      },
      options,
      next,
      usageFromChunk,
      usageSource: 'provider',
    })
    return (async function* () {
      try {
        for await (const chunk of stream) yield chunk
      } catch (error) {
        if (binding.budgetFailure && error && typeof error === 'object' && (error as { code?: unknown }).code === 'BUDGET_EXHAUSTED') binding.budgetFailure.value = error
        throw error
      }
    })()
  })
}

export function ownedSessionCount(): number {
  return ownedSessions.size
}
