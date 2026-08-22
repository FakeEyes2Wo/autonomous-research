import { appendEvent, saveState } from '../core/state.js'
import type { RunPhase, RunState } from '../core/types.js'
import { nowIso } from '../core/utils.js'

export async function withRetry<T>(operation: () => Promise<T>, label: string, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`)
}

export async function transition(state: RunState, phase: RunPhase, stepId: string, data: Record<string, unknown> = {}): Promise<RunState> {
  state.phase = phase
  state.stepId = stepId
  state.updatedAt = nowIso()
  await saveState(state.runDir, state)
  await appendEvent(state.runDir, { type: 'state', stepId, data: { phase, ...data } })
  return state
}

export async function recordResult(state: RunState, stepId: string, data: Record<string, unknown>): Promise<void> {
  await appendEvent(state.runDir, { type: 'result', stepId, data })
}

export async function recordDecision(state: RunState, stepId: string, data: Record<string, unknown>): Promise<void> {
  await appendEvent(state.runDir, { type: 'decision', stepId, data })
}
