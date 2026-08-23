import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../core/utils.js'

interface AutoModeState {
  auto: boolean
  updatedAt: string
}

export function autoModeFile(profileDir = join(homedir(), '.dsh')): string {
  return join(profileDir, 'autoresearch-auto-mode.json')
}

export async function readAutoMode(profileDir?: string): Promise<boolean> {
  if (process.env.DSH_AUTORESEARCH_AUTO === '1') return true
  try {
    const state = await readJson<AutoModeState>(autoModeFile(profileDir))
    return state.auto === true
  } catch {
    return false
  }
}

export async function writeAutoMode(enabled: boolean, profileDir?: string): Promise<boolean> {
  await atomicWriteJson(autoModeFile(profileDir), { auto: enabled, updatedAt: new Date().toISOString() })
  return enabled
}

export async function humanReviewEnabled(override?: 'auto' | 'on' | 'off'): Promise<boolean> {
  if (override === 'on') return true
  if (override === 'off') return false
  return !(await readAutoMode())
}
