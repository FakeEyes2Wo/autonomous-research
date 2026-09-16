import { createHash, randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { ensureDir, safeResolve } from '../core/utils.js'
import { lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { normalizeUsage, type UsageRecord } from './usage.js'

export type LedgerTier = 'cheap' | 'standard' | 'deep'
export type LedgerRequestKind = 'role' | 'worker' | 'supervisor' | 'repair' | 'compaction' | 'title' | 'other'
export type CapabilityStatus = 'hard' | 'estimated' | 'limited'

export interface LedgerBudgetConfig {
  maxInputTokens: number
  maxOutputTokens: number
  maxRunTokens: number
  maxRoleCalls: number
  maxRetriesPerCall?: number
  maxUpgradesPerTask: number
}

export interface RequestDescriptor {
  requestId: string
  taskId: string
  role: string
  tier: LedgerTier
  kind: LedgerRequestKind
  childId?: string
  provider?: string
  model?: string
  reasoningRoute?: string
  attempt?: number
  estimatedInputTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  cacheHit?: boolean
  routingReason?: string
  contextTruncated?: string[]
  capabilityStatus?: CapabilityStatus
}

export interface RoleStartDescriptor {
  roleStartId: string
  taskId: string
  role: string
  tier: LedgerTier
  childId?: string
  capabilityStatus?: CapabilityStatus
}

export interface UsageSettlement {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  /** Provider-authoritative total; never add reasoningTokens separately. */
  totalTokens?: number
  reasoningTokens?: number
  usageSource: 'provider' | 'estimated' | 'unknown'
  stopReason: string
}

interface PersistedRequest {
  descriptor: RequestDescriptor
  reservation: { inputTokens: number; outputTokens: number; totalTokens: number }
  status: 'reserved' | 'settled'
  chargedTokens: number
  usage?: UsageRecord
}
interface PersistedRoleStart extends RoleStartDescriptor { status: 'started' | 'completed' | 'failed' | 'paused'; startedAt: string; finishedAt?: string }
interface PersistedTask { upgradesUsed: number; roleStarts: string[]; upgradeReasons: string[] }
interface PersistedLedger {
  schema: 'autoresearch/request-ledger/v1'
  runId: string
  config: LedgerBudgetConfig
  roleStarts: Record<string, PersistedRoleStart>
  tasks: Record<string, PersistedTask>
  requests: Record<string, PersistedRequest>
  totals: { committedTokens: number; reservedTokens: number; roleStarts: number }
}

export interface LedgerSnapshot extends PersistedLedger {
  path: string
  revision: string
  pendingRequests: number
  remainingTokens: number
  remainingRoleCalls: number
  capabilityStatus: CapabilityStatus
}

export class LedgerError extends Error { readonly code: 'LEDGER_CORRUPT' | 'LEDGER_CONFLICT' | 'BUDGET_EXHAUSTED' | 'UPGRADE_LIMIT' | 'RETRY_LIMIT' | 'REQUEST_CONFLICT' | 'ROLE_NOT_FOUND'; constructor(code: LedgerError['code'], message: string) { super(message); this.name = 'LedgerError'; this.code = code } }
export class LedgerBudgetExceededError extends LedgerError { readonly recoverable = true; readonly status = 'budget_exhausted'; readonly remainingTokens: number; readonly requestedTokens: number; constructor(remainingTokens: number, requestedTokens: number) { super('BUDGET_EXHAUSTED', `request reservation ${requestedTokens} exceeds remaining run budget ${remainingTokens}`); this.remainingTokens = remainingTokens; this.requestedTokens = requestedTokens } }
export class LedgerRetryLimitError extends LedgerError { readonly recoverable = false; constructor(attempt: number, maxRetries: number) { super('RETRY_LIMIT', `attempt ${attempt} exceeds max retries ${maxRetries}`) } }
export function isBudgetExhaustedError(error: unknown): error is LedgerBudgetExceededError { return error instanceof LedgerBudgetExceededError || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'BUDGET_EXHAUSTED' && (error as { recoverable?: unknown }).recoverable === true) }

export interface RequestReservation { requestId: string; created: boolean; status: PersistedRequest['status']; reservedInputTokens: number; reservedOutputTokens: number; totalReservedTokens: number; remainingTokens: number; capabilityStatus: CapabilityStatus }
export interface RoleStartResult { roleStartId: string; created: boolean; roleStarts: number; remainingRoleCalls: number; capabilityStatus: CapabilityStatus }

const DEFAULT_RETRY = 1
function positive(value: number | undefined, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback }
function normalizeConfig(config: LedgerBudgetConfig): LedgerBudgetConfig {
  return { maxInputTokens: positive(config.maxInputTokens, 0), maxOutputTokens: positive(config.maxOutputTokens, 0), maxRunTokens: positive(config.maxRunTokens, 0), maxRoleCalls: positive(config.maxRoleCalls, 0), maxRetriesPerCall: positive(config.maxRetriesPerCall, DEFAULT_RETRY), maxUpgradesPerTask: positive(config.maxUpgradesPerTask, 0) }
}
function now(): string { return new Date().toISOString() }
function dict<T>(): Record<string, T> { return Object.create(null) as Record<string, T> }
function initialLedger(runId: string, config: LedgerBudgetConfig): PersistedLedger { return { schema: 'autoresearch/request-ledger/v1', runId, config: normalizeConfig(config), roleStarts: dict(), tasks: dict(), requests: dict(), totals: { committedTokens: 0, reservedTokens: 0, roleStarts: 0 } } }
function revision(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
function finite(value: number | undefined): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function statusFor(descriptor: { capabilityStatus?: CapabilityStatus }): CapabilityStatus { return descriptor.capabilityStatus ?? 'limited' }
function safeKey(value: string, field: string): void { if (!value || value === '__proto__' || value === 'prototype' || value === 'constructor' || value.includes('\u0000')) throw new LedgerError('REQUEST_CONFLICT', `${field} is not a safe ledger key`) }
function persistedKey(value: string, field: string): void { if (!value || value === '__proto__' || value === 'prototype' || value === 'constructor' || value.includes('\u0000')) throw new LedgerError('LEDGER_CORRUPT', `unsafe persisted ${field}`) }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function roleStartDescriptorsMatch(a: RoleStartDescriptor, b: RoleStartDescriptor): boolean {
  return a.taskId === b.taskId && a.role === b.role && a.tier === b.tier && a.childId === b.childId && statusFor(a) === statusFor(b)
}
function requestDescriptorsMatch(a: RequestDescriptor, b: RequestDescriptor): boolean {
  if (a.taskId !== b.taskId || a.role !== b.role || a.tier !== b.tier || a.kind !== b.kind || a.childId !== b.childId ||
    a.provider !== b.provider || a.model !== b.model || a.reasoningRoute !== b.reasoningRoute || (a.attempt ?? 1) !== (b.attempt ?? 1) ||
    (a.cacheHit ?? false) !== (b.cacheHit ?? false) || a.routingReason !== b.routingReason || statusFor(a) !== statusFor(b)) return false
  return JSON.stringify(a.contextTruncated ?? []) === JSON.stringify(b.contextTruncated ?? [])
}
function requestReservation(descriptor: RequestDescriptor, config: LedgerBudgetConfig): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const maxInput = requestInputCap(descriptor, config)
  const inputTokens = positive(descriptor.estimatedInputTokens, maxInput)
  const outputTokens = positive(descriptor.maxOutputTokens, config.maxOutputTokens)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}
function requestInputCap(descriptor: RequestDescriptor, config: LedgerBudgetConfig): number {
  return Math.min(config.maxInputTokens, positive(descriptor.maxInputTokens, config.maxInputTokens))
}
function reservationsMatch(a: { inputTokens: number; outputTokens: number; totalTokens: number }, b: { inputTokens: number; outputTokens: number; totalTokens: number }): boolean {
  return a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.totalTokens === b.totalTokens
}
function validateState(state: PersistedLedger): void {
  if (!state.config || !count(state.config.maxInputTokens) || !count(state.config.maxOutputTokens) || !count(state.config.maxRunTokens) || !count(state.config.maxRoleCalls) || !count(state.config.maxUpgradesPerTask) || !count(state.config.maxRetriesPerCall)) throw new LedgerError('LEDGER_CORRUPT', 'request ledger config is invalid')
  if (!state.totals || !count(state.totals.committedTokens) || !count(state.totals.reservedTokens) || !count(state.totals.roleStarts)) throw new LedgerError('LEDGER_CORRUPT', 'request ledger totals are invalid')
  if (!state.requests || typeof state.requests !== 'object' || !state.roleStarts || typeof state.roleStarts !== 'object' || !state.tasks || typeof state.tasks !== 'object') throw new LedgerError('LEDGER_CORRUPT', 'request ledger dictionaries are invalid')
  let reserved = 0; let committed = 0
  for (const [key, entry] of Object.entries(state.requests)) {
    persistedKey(key, 'request key'); if (!entry || !entry.descriptor || typeof entry.descriptor !== 'object' || entry.descriptor.requestId !== key || typeof entry.descriptor.taskId !== 'string' || typeof entry.descriptor.role !== 'string' || !['cheap', 'standard', 'deep'].includes(entry.descriptor.tier) || !entry.reservation || !count(entry.reservation.inputTokens) || !count(entry.reservation.outputTokens) || !count(entry.reservation.totalTokens) || entry.reservation.totalTokens !== entry.reservation.inputTokens + entry.reservation.outputTokens || !count(entry.chargedTokens) || !['reserved', 'settled'].includes(entry.status)) throw new LedgerError('LEDGER_CORRUPT', `request ${key} is invalid`)
    if (entry.status === 'reserved') { if (entry.chargedTokens !== 0) throw new LedgerError('LEDGER_CORRUPT', `reserved request ${key} has a charge`); reserved += entry.reservation.totalTokens } else committed += entry.chargedTokens
  }
  for (const [key, role] of Object.entries(state.roleStarts)) { persistedKey(key, 'role start key'); if (!role || role.roleStartId !== key || typeof role.taskId !== 'string' || typeof role.role !== 'string' || !['cheap', 'standard', 'deep'].includes(role.tier) || !['started', 'completed', 'failed', 'paused'].includes(role.status)) throw new LedgerError('LEDGER_CORRUPT', `role start ${key} is invalid`) }
  for (const [key, task] of Object.entries(state.tasks)) { persistedKey(key, 'task key'); if (!task || !count(task.upgradesUsed) || task.upgradesUsed > state.config.maxUpgradesPerTask || !Array.isArray(task.roleStarts) || !Array.isArray(task.upgradeReasons)) throw new LedgerError('LEDGER_CORRUPT', `task ${key} is invalid`) }
  if (reserved !== state.totals.reservedTokens || committed !== state.totals.committedTokens || Object.keys(state.roleStarts).length !== state.totals.roleStarts) throw new LedgerError('LEDGER_CORRUPT', 'request ledger totals do not match records')
}

export class RequestLedger {
  readonly path: string
  private readonly lockPath: string
  private readonly runId: string
  private readonly initialConfig: LedgerBudgetConfig
  constructor(runDir: string, runId: string, config: LedgerBudgetConfig) { this.path = safeResolve(runDir, 'request-ledger.json'); this.lockPath = `${this.path}.lock`; this.runId = runId; this.initialConfig = normalizeConfig(config) }

  async snapshot(): Promise<LedgerSnapshot> {
    return this.withLock(async (state, text) => this.toSnapshot(state, text), false)
  }

  async beginRole(descriptor: RoleStartDescriptor): Promise<RoleStartResult> {
    return this.mutate((state) => {
      safeKey(descriptor.roleStartId, 'roleStartId'); safeKey(descriptor.taskId, 'taskId')
      const existing = state.roleStarts[descriptor.roleStartId]
      if (existing) {
        if (!roleStartDescriptorsMatch(existing, descriptor)) throw new LedgerError('REQUEST_CONFLICT', `role start id ${descriptor.roleStartId} has conflicting attribution`)
        return { roleStartId: descriptor.roleStartId, created: false, roleStarts: state.totals.roleStarts, remainingRoleCalls: Math.max(0, state.config.maxRoleCalls - state.totals.roleStarts), capabilityStatus: statusFor(existing) }
      }
      if (state.totals.roleStarts >= state.config.maxRoleCalls) throw new LedgerBudgetExceededError(0, 1)
      const task = state.tasks[descriptor.taskId] ?? (state.tasks[descriptor.taskId] = { upgradesUsed: 0, roleStarts: [], upgradeReasons: [] })
      const entry: PersistedRoleStart = { ...descriptor, status: 'started', startedAt: now() }
      state.roleStarts[descriptor.roleStartId] = entry; task.roleStarts.push(descriptor.roleStartId); state.totals.roleStarts += 1
      return { roleStartId: descriptor.roleStartId, created: true, roleStarts: state.totals.roleStarts, remainingRoleCalls: Math.max(0, state.config.maxRoleCalls - state.totals.roleStarts), capabilityStatus: statusFor(descriptor) }
    })
  }

  async finishRole(roleStartId: string, status: Exclude<PersistedRoleStart['status'], 'started'>): Promise<void> {
    safeKey(roleStartId, 'roleStartId')
    await this.mutate((state) => { const role = state.roleStarts[roleStartId]; if (!role) throw new LedgerError('ROLE_NOT_FOUND', `unknown role start ${roleStartId}`); role.status = status; role.finishedAt = now() })
  }

  async recordTaskUpgrade(taskId: string, reason: string): Promise<{ allowed: boolean; upgradesUsed: number; maxUpgrades: number }> {
    safeKey(taskId, 'taskId'); return this.mutate((state) => { const task = state.tasks[taskId] ?? (state.tasks[taskId] = { upgradesUsed: 0, roleStarts: [], upgradeReasons: [] }); if (task.upgradesUsed >= state.config.maxUpgradesPerTask) return { allowed: false, upgradesUsed: task.upgradesUsed, maxUpgrades: state.config.maxUpgradesPerTask }; task.upgradesUsed += 1; task.upgradeReasons.push(reason); return { allowed: true, upgradesUsed: task.upgradesUsed, maxUpgrades: state.config.maxUpgradesPerTask } })
  }

  async beginRequest(descriptor: RequestDescriptor): Promise<RequestReservation> {
    safeKey(descriptor.requestId, 'requestId'); safeKey(descriptor.taskId, 'taskId')
    return this.mutate((state) => {
      const existing = state.requests[descriptor.requestId]
      if (existing) {
        if (!requestDescriptorsMatch(existing.descriptor, descriptor) || requestInputCap(existing.descriptor, state.config) !== requestInputCap(descriptor, state.config) || !reservationsMatch(existing.reservation, requestReservation(descriptor, state.config))) throw new LedgerError('REQUEST_CONFLICT', `request id ${descriptor.requestId} has conflicting attribution or reservation`)
        return this.reservationResult(state, existing, false)
      }
      const attempt = descriptor.attempt ?? 1
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > (state.config.maxRetriesPerCall ?? DEFAULT_RETRY) + 1) throw new LedgerRetryLimitError(attempt, state.config.maxRetriesPerCall ?? DEFAULT_RETRY)
      const maxInput = requestInputCap(descriptor, state.config)
      const reservation = requestReservation(descriptor, state.config)
      const requestedInput = reservation.inputTokens
      const requestedOutput = reservation.outputTokens
      if (descriptor.estimatedInputTokens !== undefined && requestedInput > maxInput) throw new LedgerBudgetExceededError(Math.max(0, state.config.maxRunTokens - state.totals.committedTokens - state.totals.reservedTokens), requestedInput + requestedOutput)
      if (descriptor.maxOutputTokens !== undefined && requestedOutput > state.config.maxOutputTokens) throw new LedgerBudgetExceededError(Math.max(0, state.config.maxRunTokens - state.totals.committedTokens - state.totals.reservedTokens), requestedInput + requestedOutput)
      const input = requestedInput
      const output = requestedOutput
      const total = input + output
      const remaining = Math.max(0, state.config.maxRunTokens - state.totals.committedTokens - state.totals.reservedTokens)
      if (total > remaining) throw new LedgerBudgetExceededError(remaining, total)
      const entry: PersistedRequest = { descriptor: structuredClone(descriptor), reservation: { inputTokens: input, outputTokens: output, totalTokens: total }, status: 'reserved', chargedTokens: 0 }
      state.requests[descriptor.requestId] = entry; state.totals.reservedTokens += total
      return this.reservationResult(state, entry, true)
    })
  }

  async settleRequest(requestId: string, settlement: UsageSettlement): Promise<UsageRecord> {
    safeKey(requestId, 'requestId')
    return this.mutate((state) => {
      const entry = state.requests[requestId]
      if (!entry) throw new LedgerError('REQUEST_CONFLICT', `unknown request ${requestId}`)
      if (entry.status === 'settled' && entry.usage) return entry.usage
      return this.settleEntry(state, entry, settlement)
    })
  }

  async cancelRequest(requestId: string, stopReason = 'cancelled'): Promise<UsageRecord> { return this.settleRequest(requestId, { usageSource: 'unknown', stopReason }) }

  async recoverPending(stopReason = 'interrupted'): Promise<number> {
    return this.mutate((state) => { const pending = Object.values(state.requests).filter((entry) => entry.status === 'reserved'); for (const entry of pending) this.settleEntry(state, entry, { usageSource: 'unknown', stopReason }); return pending.length })
  }

  private settleEntry(state: PersistedLedger, entry: PersistedRequest, settlement: UsageSettlement): UsageRecord {
    const usage = this.makeUsage(state, entry, settlement)
    const charged = settlement.usageSource === 'unknown' || usage.totalTokens === undefined ? entry.reservation.totalTokens : usage.totalTokens
    state.totals.reservedTokens -= entry.reservation.totalTokens; state.totals.committedTokens += charged; entry.chargedTokens = charged; entry.status = 'settled'; entry.usage = usage; return usage
  }

  private reservationResult(state: PersistedLedger, entry: PersistedRequest, created: boolean): RequestReservation { return { requestId: entry.descriptor.requestId, created, status: entry.status, reservedInputTokens: entry.reservation.inputTokens, reservedOutputTokens: entry.reservation.outputTokens, totalReservedTokens: entry.reservation.totalTokens, remainingTokens: Math.max(0, state.config.maxRunTokens - state.totals.committedTokens - state.totals.reservedTokens), capabilityStatus: statusFor(entry.descriptor) } }
  private makeUsage(state: PersistedLedger, entry: PersistedRequest, settlement: UsageSettlement): UsageRecord { const value = (token: number | undefined): number | undefined => finite(token) ? Math.floor(token) : undefined; return normalizeUsage({ callId: entry.descriptor.requestId, requestId: entry.descriptor.requestId, childId: entry.descriptor.childId, runId: state.runId, role: entry.descriptor.role, task: entry.descriptor.taskId, tier: entry.descriptor.tier, provider: entry.descriptor.provider, model: entry.descriptor.model, reasoningRoute: entry.descriptor.reasoningRoute, inputTokens: value(settlement.inputTokens), cacheReadTokens: value(settlement.cacheReadTokens), cacheWriteTokens: value(settlement.cacheWriteTokens), outputTokens: value(settlement.outputTokens), totalTokens: value(settlement.totalTokens), reasoningTokens: value(settlement.reasoningTokens), attempt: entry.descriptor.attempt ?? 1, cacheHit: entry.descriptor.cacheHit ?? false, routingReason: entry.descriptor.routingReason, contextTruncated: entry.descriptor.contextTruncated, stopReason: typeof settlement.stopReason === 'string' ? settlement.stopReason : 'unknown', usageSource: settlement.usageSource === 'provider' || settlement.usageSource === 'estimated' ? settlement.usageSource : 'unknown' }) }
  private async mutate<T>(fn: (state: PersistedLedger) => T): Promise<T> { return this.withLock(async (state) => fn(state), true) }
  private async withLock<T>(fn: (state: PersistedLedger, text: string) => T | Promise<T>, persist: boolean): Promise<T> {
    await ensureDir(dirname(this.path)); await assertLedgerPathSafe(this.path); const release = await acquireLock(this.lockPath)
    try { const loaded = await load(this.path, this.runId, this.initialConfig); const result = await fn(loaded.state, loaded.text); if (persist) { validateState(loaded.state); await save(this.path, loaded.state) } return result }
    finally { await release() }
  }
  private toSnapshot(state: PersistedLedger, text: string): LedgerSnapshot { const pendingRequests = Object.values(state.requests).filter((entry) => entry.status === 'reserved').length; const capabilityStatus: CapabilityStatus = Object.keys(state.requests).length === 0 ? 'limited' : Object.values(state.requests).some((entry) => statusFor(entry.descriptor) === 'limited' || (entry.status === 'settled' && entry.usage?.usageSource === 'unknown')) ? 'limited' : Object.values(state.requests).some((entry) => statusFor(entry.descriptor) === 'estimated' || entry.usage?.usageSource === 'estimated') ? 'estimated' : 'hard'; return { ...structuredClone(state), path: this.path, revision: revision(text), pendingRequests, remainingTokens: Math.max(0, state.config.maxRunTokens - state.totals.committedTokens - state.totals.reservedTokens), remainingRoleCalls: Math.max(0, state.config.maxRoleCalls - state.totals.roleStarts), capabilityStatus } }
}

export async function openRequestLedger(options: { runDir: string; runId: string; config: LedgerBudgetConfig }): Promise<RequestLedger> { return new RequestLedger(resolve(options.runDir), options.runId, options.config) }

async function load(path: string, runId: string, config: LedgerBudgetConfig): Promise<{ state: PersistedLedger; text: string; changed: boolean }> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: initialLedger(runId, config), text: '', changed: true }
    throw new LedgerError('LEDGER_CORRUPT', `cannot read request ledger: ${String(error)}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (error) { throw new LedgerError('LEDGER_CORRUPT', `request ledger is not valid JSON: ${String(error)}`) }
  if (!parsed || typeof parsed !== 'object' || (parsed as { schema?: unknown }).schema !== 'autoresearch/request-ledger/v1') throw new LedgerError('LEDGER_CORRUPT', 'unsupported request ledger schema')
  const state = parsed as PersistedLedger
  if (state.runId !== runId) throw new LedgerError('LEDGER_CONFLICT', 'request ledger belongs to another run')
  validateState(state)
  return { state, text, changed: false }
}

async function save(path: string, state: PersistedLedger): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; const text = `${JSON.stringify(state, null, 2)}\n`
  try { if ((await lstat(path)).isSymbolicLink()) throw new LedgerError('LEDGER_CONFLICT', 'request ledger must not be a symlink') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' }); await rename(temp, path) } catch (error) { await unlink(temp).catch(() => undefined); throw error }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const handle = await open(path, 'wx'); return async () => { try { await handle.close() } finally { await unlink(path).catch(() => undefined) } } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise((resolve) => setTimeout(resolve, 25)) }
  }
  throw new LedgerError('LEDGER_CONFLICT', 'request ledger lock timeout')
}

async function assertLedgerPathSafe(path: string): Promise<void> {
  try { const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new LedgerError('LEDGER_CONFLICT', 'request ledger directory must be a real directory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { if ((await lstat(path)).isSymbolicLink()) throw new LedgerError('LEDGER_CONFLICT', 'request ledger must not be a symlink') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
