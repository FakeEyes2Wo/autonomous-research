import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { EVENTS_FILE, STATE_FILE } from './constants.js'
import { atomicWriteJson, ensureDir, newRunId, nowIso, readJson, safeResolve, writeText } from './utils.js'
import type { RunEvent, RunState } from './types.js'

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
