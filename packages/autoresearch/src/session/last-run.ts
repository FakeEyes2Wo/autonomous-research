import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../core/utils.js'

export interface LastRunInfo {
  lastRunDir: string
  updatedAt: string
}

export function lastRunPath(profileDir = join(homedir(), '.dsh')): string {
  return join(profileDir, 'autoresearch-last-run.json')
}

export async function readLastRun(profileDir?: string): Promise<LastRunInfo | undefined> {
  try {
    return await readJson<LastRunInfo>(lastRunPath(profileDir))
  } catch {
    return undefined
  }
}

export async function writeLastRun(runDir: string, profileDir?: string): Promise<LastRunInfo> {
  const info: LastRunInfo = { lastRunDir: runDir, updatedAt: new Date().toISOString() }
  await atomicWriteJson(lastRunPath(profileDir), info)
  return info
}
