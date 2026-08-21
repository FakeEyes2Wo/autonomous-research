import { appendEvent, saveState } from '../core/state.js'
import type { RunPhase, RunState } from '../core/types.js'
import { nowIso } from '../core/utils.js'

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

export async function recordError(state: RunState, stepId: string, error: unknown): Promise<void> {
  await appendEvent(state.runDir, { type: 'error', stepId, data: { error: String(error) } })
}
