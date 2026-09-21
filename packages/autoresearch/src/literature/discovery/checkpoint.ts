import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from '../../core/utils.js'
import { hashContent } from '../../research/records.js'
import type { SourceRef } from '../../research/contracts.js'
import type { DiscoveryCandidate, DiscoveryProviderName, DiscoveryQuery, HttpReceipt, SimilarityAssessment, SimilaritySurveyReport } from './contracts.js'

export interface DiscoveryTask { key: string; provider: DiscoveryProviderName; query: DiscoveryQuery; page: number; retry: number; readyAt: number }
export interface DiscoveryResult { receipt: HttpReceipt; candidates: DiscoveryCandidate[]; hasMore: boolean }
export interface DiscoveryCheckpoint {
  version: 1; surveyId: string; ideaFingerprint: string; configFingerprint: string; createdAt: string; elapsedMs: number
  attempts: number; providerAttempts: Partial<Record<DiscoveryProviderName, number>>; cacheHits: number; round: number; roundsCompleted: number; roundInitialPoolSize: number; lowYieldRounds: number
  queries: DiscoveryQuery[]; rejectedQueries: { round: number; text: string; reason: string }[]; tasks: DiscoveryTask[]; completedTasks: string[]
  receipts: HttpReceipt[]; pool: DiscoveryCandidate[]; assessments: SimilarityAssessment[]; gaps: string[]; nextProviderAt: Partial<Record<DiscoveryProviderName, number>>
  modelResults: Record<string, { raw: unknown; sourceRef: SourceRef }>; assessmentHashes?: Record<string, string>; pendingModel?: { key: string; id: string; startedAt: number; accountedThrough?: number }
  pendingHttp?: { task: DiscoveryTask; id: string; startedAt: number; accountedThrough?: number }; phase: 'plan' | 'search' | 'review'; report?: SimilaritySurveyReport
}
/** Checksums detect torn or edited metadata; captured source hashes independently bind external/model bytes. */
export async function writeDiscoveryRecord(path: string, payload: unknown): Promise<void> { await atomicWriteJson(path, { payload, checksum: hashContent(payload) }) }
export async function readDiscoveryRecord<T>(path: string): Promise<T | undefined> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const record = JSON.parse(text)
  if (!record || hashContent(record.payload) !== record.checksum) throw new Error('Discovery checkpoint checksum mismatch')
  return record.payload as T
}
export async function lockDiscoveryDirectory(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true }); const path = join(directory, 'execution.lock')
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() })
  const acquire = async () => {
    const handle = await open(path, 'wx')
    try { await handle.writeFile(owner) } finally { await handle.close() }
    let released = false
    return async () => {
      if (released) return
      if (await readFile(path, 'utf8') !== owner) throw new Error('Discovery lock owner changed; refusing release')
      await unlink(path); released = true
    }
  }
  try { return await acquire() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  // Serialize stale-owner recovery. A second recoverer must never unlink a newly acquired live lock.
  // A crash inside this very short recovery section fails closed for explicit reconciliation.
  const recoveryPath = join(directory, 'execution.recovery.lock')
  let recovery
  try { recovery = await open(recoveryPath, 'wx') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Discovery lock recovery already owned; reconcile if abandoned'); throw error }
  try {
    let text: string
    try { text = await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await acquire(); throw error }
    const parsed = JSON.parse(text); const pid = typeof parsed === 'number' ? parsed : parsed?.pid
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid discovery execution lock')
    let dead = false
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead = true; else throw error }
    if (!dead) throw new Error('Discovery survey already executing')
    await unlink(path)
    return await acquire()
  } finally { await recovery.close(); await unlink(recoveryPath) }
}
