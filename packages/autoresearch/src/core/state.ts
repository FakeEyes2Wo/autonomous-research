import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson, ensureDir, EVENTS_FILE, newRunId, nowIso, readJson, safeResolve, STATE_FILE, writeText } from './utils.js'
import type { RunEvent, RunPhase, RunState } from './types.js'

export async function loadState(runDir: string): Promise<RunState | undefined> {
  const file = safeResolve(runDir, STATE_FILE)
  try {
    await access(file)
  } catch {
    return undefined
  }
  return readJson<RunState>(file)
}

export async function saveState(runDir: string, state: RunState): Promise<RunState> {
  const file = safeResolve(runDir, STATE_FILE)
  state.updatedAt = nowIso()
  await atomicWriteJson(file, state)
  return state
}

export async function createInitialState(runDir: string, runId = newRunId()): Promise<RunState> {
  const state: RunState = {
    schema: 'autoresearch/run-state/v1',
    runId,
    runDir,
    status: 'RUNNING',
    phase: 'intake',
    cycle: 1,
    stepId: 'intake',
    planVersion: 1,
    updatedAt: nowIso(),
  }
  await ensureDir(runDir)
  await saveState(runDir, state)
  return state
}

export async function appendEvent(runDir: string, event: Omit<RunEvent, 'time'>): Promise<void> {
  const file = safeResolve(runDir, EVENTS_FILE)
  await ensureDir(runDir)
  const line: RunEvent = { ...event, time: nowIso() }
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
}

export async function writeDecision(runDir: string, decisionText: string): Promise<void> {
  const file = safeResolve(runDir, 'DECISION.md')
  await writeText(file, decisionText)
}

export function stateFile(runDir: string): string {
  return join(runDir, STATE_FILE)
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
