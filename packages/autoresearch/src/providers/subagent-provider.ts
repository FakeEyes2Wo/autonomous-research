import { buildPrompt, outputSchemaFor } from '../agents/factory.js'
import { roleSpecs } from '../agents/roles/index.js'
import { parseJsonDetailed } from '../agents/json-repair.js'
import { createLogger } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../agents/types.js'
import { resolveModelRoute, type ResolvedModelRoute } from '../policy/model-routing.js'
import { resolveBudget } from '../policy/budget.js'
import { clipContext } from '../policy/context.js'
import { isBudgetExhaustedError } from '../policy/request-ledger.js'
import { registerOwnedSession, withRequestBinding, type OwnedSessionBinding } from './request-accounting.js'
import type { RequestLedger } from '../policy/request-ledger.js'
import type { ProjectSettings } from '../settings/schema.js'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

// TODO: 需要调查 DSH 原生 Agent 编排 vs 固定研究循环编排（RoleAgentProvider + ResearchRunner）的效果，
// 确定是否应彻底删除本 provider 并改为 DSH Agent 直接编排 subagent。

const LONG_TASK_ROLES = new Set<RoleName>(['research-worker'])
const REGISTRY_FILE = join('.autoresearch', 'subagent-tasks.json')

export interface SubagentProviderOptions {
  providerName?: string
  context?: Pick<Context, 'on'>
  /** A host-supplied, validated DSH ToolRestriction for JSON repair. */
  repairToolFilter?: ToolRestriction
}

interface PersistedTask {
  childId: SessionId
  fingerprint: string
  status: 'provisioning' | 'pending' | 'completed'
  stopReason?: string
  text?: string
  structured?: unknown
}

interface PersistedRegistry {
  version: 1
  tasks: Record<string, PersistedTask>
}

const registryLocks = new Map<string, Promise<void>>()
const taskLocks = new Map<string, Promise<void>>()

function withFeedback(prompt: string, feedback: string | undefined): string {
  return feedback ? `${prompt}\n\n## JSON Fix Required\n\n${feedback}` : prompt
}

function objectOutputSchema(role: RoleName): ObjectJsonSchema | undefined {
  const schema = outputSchemaFor(role)
  return schema && typeof schema === 'object' && !Array.isArray(schema) && (schema as { type?: unknown }).type === 'object'
    ? schema as unknown as ObjectJsonSchema
    : undefined
}

function stopError(stopReason: string): Error {
  const error = new Error('subagent stopped with ' + stopReason)
  ;(error as Error & { code?: string }).code = 'SUBAGENT_STOP'
  return error
}

function routeFor(input: RoleInput, role: RoleName, context: RoleExecutionContext): ResolvedModelRoute | undefined {
  const policy = context.policySnapshot as (Pick<ProjectSettings, 'version'|'model'|'modelRouting'|'workflow'|'budget'> | undefined)
  if (!policy) return undefined
  const route = resolveModelRoute(policy as ProjectSettings, { role, task: input.taskId ?? role })
  const budget = resolveBudget(policy as ProjectSettings, route)
  return {
    ...route,
    maxInputTokens: Math.min(route.maxInputTokens ?? Number.POSITIVE_INFINITY, budget.maxInputTokens),
    maxOutputTokens: Math.min(route.maxOutputTokens ?? Number.POSITIVE_INFINITY, budget.maxOutputTokens),
  }
}

function agentOptions(route: ReturnType<typeof routeFor>): AgentOptions | undefined {
  if (!route) return undefined
  const options: AgentOptions = {}
  if (route.provider) options.provider = route.provider
  if (route.model) options.model = route.model
  if (route.maxOutputTokens !== undefined && Number.isFinite(route.maxOutputTokens)) options.maxTokens = route.maxOutputTokens
  return Object.keys(options).length > 0 ? options : undefined
}

function maxJsonRepairs(context: RoleExecutionContext): number {
  const value = context.policySnapshot?.budget.jsonRepairAttempts
  return Math.max(0, Math.min(3, typeof value === 'number' && Number.isSafeInteger(value) ? value : 1))
}

const CLIPPABLE_FIELDS: Readonly<Record<string, 'treeSummary' | 'evidence' | 'paper' | 'failure'>> = {
  treeSummary: 'treeSummary',
  relatedPapers: 'paper',
  baselines: 'evidence',
  modelScout: 'evidence',
  experimentDesign: 'evidence',
  minimalVerification: 'evidence',
  failureDirections: 'failure',
  reflexion: 'failure',
  paperPlan: 'paper',
  paperMatrix: 'paper',
  paperContract: 'paper',
  paperFigures: 'paper',
}

function contextBudget(route: ReturnType<typeof routeFor>, context: RoleExecutionContext) {
  const budget = context.policySnapshot?.budget
  return {
    maxInputTokens: route?.maxInputTokens ?? budget?.maxInputTokens ?? 24_000,
    ...(budget?.context ?? {}),
  }
}

function contextInsufficientError(sections: readonly string[]): Error {
  const error = new Error('required context sections exceed the configured input budget: ' + sections.join(', '))
  ;(error as Error & { code?: string }).code = 'CONTEXT_INSUFFICIENT'
  return error
}

async function buildBoundPrompt(role: RoleName, input: RoleInput, route: ReturnType<typeof routeFor>, context: RoleExecutionContext, feedback?: string): Promise<string> {
  const spec = roleSpecs[role]
  const grouped = new Map<string, Array<{ field: keyof RoleInput; text: string }>>()
  for (const field of spec.sections) {
    const value = input[field]
    const name = CLIPPABLE_FIELDS[String(field)]
    if (name && typeof value === 'string' && value.length > 0) grouped.set(name, [...(grouped.get(name) ?? []), { field, text: value }])
  }
  const sections = [...grouped.entries()].map(([name, entries]) => ({
    name,
    text: entries.map((entry) => `### ${String(entry.field)}\n${entry.text}`).join('\n\n'),
    required: true,
    priority: name === 'treeSummary' ? 10 : 0,
  }))
  const clipped = sections.length > 0 ? clipContext(sections, contextBudget(route, context)) : undefined
  if (clipped?.insufficientSections.length) throw contextInsufficientError(clipped.insufficientSections)
  const clippedInput: RoleInput = { ...input }
  if (clipped) for (const [name, entries] of grouped) {
    const content = clipped.sections[name] ?? ''
    entries.forEach((entry, index) => { (clippedInput as unknown as Record<string, unknown>)[String(entry.field)] = index === 0 ? content : undefined })
  }
  const prompt = await buildPrompt(role, clippedInput)
  const withFeedbackPrompt = withFeedback(prompt, feedback)
  const maxInputTokens = route?.maxInputTokens ?? context.policySnapshot?.budget.maxInputTokens ?? 24_000
  if (estimatePromptTokens(withFeedbackPrompt) > maxInputTokens) throw contextInsufficientError(['prompt'])
  return withFeedbackPrompt
}

function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4)
}

function taskFingerprint(role: RoleName, input: RoleInput, context: RoleExecutionContext): string {
  const fields = roleSpecs[role].sections.reduce<Record<string, unknown>>((result, field) => {
    const value = input[field]
    if (value !== undefined) result[String(field)] = value
    return result
  }, {})
  return createHash('sha256').update(JSON.stringify({ role, taskId: input.taskId ?? role, cycle: input.cycle, fields, policyVersion: context.policySnapshot?.version, routing: context.policySnapshot?.modelRouting })).digest('hex').slice(0, 24)
}

function sessionBinding(role: RoleName, taskId: string, childId: string, context: RoleExecutionContext, route: ReturnType<typeof routeFor>, budgetFailure?: { value?: unknown }, kind: 'role' | 'repair' = 'role'): OwnedSessionBinding | undefined {
  if (!context.requestLedger) return undefined
  return {
    ledger: context.requestLedger,
    runId: context.runId ?? 'legacy',
    taskId,
    role,
    ...(kind === 'repair' ? { kind } : {}),
    tier: route?.tier ?? 'standard',
    childId,
    ...(route?.provider ? { provider: route.provider } : {}),
    ...(route?.model ? { model: route.model } : {}),
    ...(route?.maxOutputTokens !== undefined ? { maxOutputTokens: route.maxOutputTokens } : {}),
    ...(route?.maxInputTokens !== undefined ? { maxInputTokens: route.maxInputTokens } : {}),
    capabilityStatus: 'limited',
    ...(budgetFailure ? { budgetFailure } : {}),
  }
}

async function withRegistryLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  const key = join(runDir, REGISTRY_FILE)
  const previous = registryLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  registryLocks.set(key, queued)
  await previous
  try { return await fn() } finally { release(); if (registryLocks.get(key) === queued) registryLocks.delete(key) }
}

async function withTaskLock<T>(runDir: string, taskId: string, fn: () => Promise<T>): Promise<T> {
  const key = join(runDir, taskId)
  const previous = taskLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  taskLocks.set(key, queued)
  await previous
  try { return await fn() } finally { release(); if (taskLocks.get(key) === queued) taskLocks.delete(key) }
}

async function readRegistry(runDir: string): Promise<PersistedRegistry> {
  const path = join(runDir, REGISTRY_FILE)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PersistedRegistry
    if (parsed.version === 1 && parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks)) {
      for (const [key, task] of Object.entries(parsed.tasks)) {
        if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype' || key.includes('\u0000') || !task || typeof task !== 'object' || typeof task.childId !== 'string' || !task.childId || task.childId.includes('\u0000') || typeof task.fingerprint !== 'string' || !/^[a-f0-9]{24}$/.test(task.fingerprint) || !['provisioning', 'pending', 'completed'].includes(task.status as string) || (task.stopReason !== undefined && typeof task.stopReason !== 'string') || (task.text !== undefined && typeof task.text !== 'string')) throw new Error('invalid subagent task registry')
      }
      return parsed
    }
    throw new Error('invalid subagent task registry')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: {} }
    if (error instanceof SyntaxError) throw new Error('invalid subagent task registry at ' + path)
    throw error
  }
}

async function updateRegistry(runDir: string, taskId: string, update: (current?: PersistedTask) => PersistedTask | undefined): Promise<PersistedTask | undefined> {
  return withRegistryLock(runDir, async () => {
    const registry = await readRegistry(runDir)
    const next = update(registry.tasks[taskId])
    if (next) registry.tasks[taskId] = next
    else delete registry.tasks[taskId]
    await mkdir(join(runDir, '.autoresearch'), { recursive: true })
    const target = join(runDir, REGISTRY_FILE)
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return next
  })
}

export class SubagentRoleAgentProvider implements RoleAgentProvider {
  private readonly runtime: SubagentRuntime
  private readonly providerName: string
  private readonly eventContext?: Pick<Context, 'on'>
  private readonly repairToolFilter: ToolRestriction
  private readonly events: SubagentRunEndInfo[] = []
  private readonly waiters: Array<{
    id: SessionId
    resolve: (value: SubagentRunEndInfo) => void
    reject: (reason: unknown) => void
    onAbort?: () => void
  }> = []
  private listenerInstalled = false
  private removeListener?: () => void

  constructor(runtime: SubagentRuntime, options: SubagentProviderOptions = {}) {
    this.runtime = runtime
    this.providerName = options.providerName ?? 'spawn'
    this.eventContext = options.context
    this.repairToolFilter = options.repairToolFilter ?? { allow: [] }
  }

  private ensureListener(): void {
    if (this.listenerInstalled || !this.eventContext) return
    this.removeListener = this.eventContext.on('subagent/end', (info) => {
      const index = this.waiters.findIndex((waiter) => waiter.id === info.id)
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1)
        waiter?.onAbort?.()
        waiter?.resolve(info)
      } else {
        this.events.push(info)
      }
    })
    this.listenerInstalled = true
  }

  private waitForEnd(childId: SessionId, context: RoleExecutionContext): Promise<SubagentRunEndInfo> {
    this.ensureListener()
    const existingIndex = this.events.findIndex((event) => event.id === childId)
    if (existingIndex >= 0) {
      const [existing] = this.events.splice(existingIndex, 1)
      return Promise.resolve(existing!)
    }
    return new Promise((resolve, reject) => {
      const waiter: { id: SessionId; resolve: (value: SubagentRunEndInfo) => void; reject: (reason: unknown) => void; onAbort?: () => void } = { id: childId, resolve, reject }
      const abort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        try { this.runtime.interrupt?.(childId, { kind: 'ancestor', agent: context.parent as Agent }) } catch { /* abort remains authoritative */ }
        const error = new Error('subagent aborted')
        ;(error as Error & { name: string }).name = 'AbortError'
        reject(error)
      }
      if (context.signal.aborted) {
        abort()
        return
      }
      waiter.onAbort = () => context.signal.removeEventListener('abort', abort)
      context.signal.addEventListener('abort', abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private async runContinuableAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    feedback?: string,
  ): Promise<RoleOutput> {
    if (!this.runtime.startContinuable || !this.eventContext) {
      return this.runOneShotAttempt(role, input, context, feedback)
    }
    const taskId = input.taskId ?? role
    const fingerprint = taskFingerprint(role, input, context)
    return withTaskLock(input.runDir, taskId, async () => {
      const logger = createLogger(input.runDir)
      const persisted = (await readRegistry(input.runDir)).tasks[taskId]
      if (persisted && persisted.fingerprint !== fingerprint) throw new Error(`task registry conflict for ${taskId}: input revision changed`)
      if (persisted?.status === 'provisioning') throw new Error(`continuable task ${taskId} has an unresolved provisioning record; refusing replay`)
      if (persisted?.status === 'completed') {
        return { text: persisted.text ?? '', structured: persisted.structured, stopReason: persisted.stopReason ?? 'completed', childId: persisted.childId }
      }
      this.ensureListener()
      let childId = persisted?.childId
      const route = routeFor(input, role, context)
      const budgetFailure = { value: undefined as unknown }
      const registerChild = (id: SessionId) => context.requestLedger
        ? registerOwnedSession(String(id), sessionBinding(role, taskId, String(id), context, route, budgetFailure)!)
        : undefined
      let releaseOwnership: (() => void) | undefined
      try {
        if (childId && this.runtime.sendMessage) {
        releaseOwnership = registerChild(childId)
        logger.info('[subagent:' + role + '] resuming continuable id=' + childId)
        await this.runtime.sendMessage(context.parent as Agent, childId, [{ type: 'text', text: 'Continue the existing task from its current state. Do not restart completed work. Return the final structured result when done.' }], { signal: context.signal })
        } else {
        if (childId) throw new Error('continuable child exists but sendMessage is unavailable')
        const promptWithFeedback = await buildBoundPrompt(role, input, routeFor(input, role, context), context, feedback)
        logger.info('[subagent:' + role + '] calling ctx.subagents.startContinuable provider=' + this.providerName)
        const reservedChildId = makeSessionId('ar-' + createHash('sha256').update(`${context.runId ?? 'legacy'}:${taskId}:${fingerprint}`).digest('hex').slice(0, 32))
        await updateRegistry(input.runDir, taskId, () => ({ childId: reservedChildId, fingerprint, status: 'provisioning' }))
        releaseOwnership = registerChild(reservedChildId)
        let started
        try {
          started = await this.runtime.startContinuable({
          provider: this.providerName,
          label: role,
          childId: reservedChildId,
          request: {
            prompt: [{ type: 'text', text: promptWithFeedback }],
            parent: context.parent as Agent,
            ...(agentOptions(route) ? { agentOptions: agentOptions(route) } : {}),
          },
          signal: context.signal,
          })
        } catch (error) {
          releaseOwnership?.()
          releaseOwnership = undefined
          await updateRegistry(input.runDir, taskId, () => undefined).catch(() => undefined)
          throw error
        }
        const startedChildId = started.childId
        if (!startedChildId) {
          releaseOwnership?.()
          releaseOwnership = undefined
          await updateRegistry(input.runDir, taskId, () => undefined).catch(() => undefined)
          throw new Error('continuable start returned no child id')
        }
        if (startedChildId !== reservedChildId) {
          try { this.runtime.interrupt?.(startedChildId, { kind: 'ancestor', agent: context.parent as Agent }) } catch { /* preserve the provisioning record for investigation */ }
          releaseOwnership?.()
          releaseOwnership = undefined
          throw new Error('continuable start returned a different child id than the reserved identity')
        }
        childId = startedChildId
        try {
          await updateRegistry(input.runDir, taskId, () => ({ childId: startedChildId, fingerprint, status: 'pending' }))
        } catch (error) {
          try { this.runtime.interrupt?.(startedChildId, { kind: 'ancestor', agent: context.parent as Agent }) } catch { /* provisioning record remains fail-closed */ }
          throw error
        }
        logger.info('[subagent:' + role + '] continuable started id=' + startedChildId)
        }
        if (!childId) throw new Error('continuable start returned no child id')
        const activeChildId = childId
        const end = await this.waitForEnd(activeChildId, context)
        logger.info(`[subagent:${role}] continuable ended stopReason=${end.stopReason}`)
        if (budgetFailure.value) throw budgetFailure.value
        if (end.stopReason !== 'completed') throw stopError(end.stopReason)
        const text = (end.lastAssistantMessage ?? [])
          .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        const parsed = parseJsonDetailed(text)
        const structured = parsed.ok ? parsed.value : undefined
        const output = { text, structured, stopReason: end.stopReason, childId: String(activeChildId) }
        if (parsed.ok) {
          await updateRegistry(input.runDir, taskId, () => ({ childId: activeChildId, fingerprint, status: 'completed', stopReason: end.stopReason, text, structured }))
        }
        return output
      } finally {
        releaseOwnership?.()
      }
    })
  }

  private async runOneShotAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    feedback?: string,
  ): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    const route = routeFor(input, role, context)
    const promptWithFeedback = await buildBoundPrompt(role, input, route, context, feedback)
    const schema = objectOutputSchema(role)
    if (input.figureImages?.length) {
      logger.warn(`[subagent:${role}] figureImages provided; using textual path fallback until native image blocks are wired`)
    }
    logger.info(`[subagent:${role}] calling ctx.subagents.start provider=${this.providerName}`)
    const started = Date.now()
    const budgetFailure = { value: undefined as unknown }
    const provisional = sessionBinding(role, input.taskId ?? role, 'pending-' + randomUUID(), context, route, budgetFailure)
    const start = () => this.runtime.start(this.providerName, {
        label: role,
        prompt: [{ type: 'text', text: promptWithFeedback }],
        parent: context.parent as Agent,
        signal: context.signal,
        ...(schema !== undefined ? { outputSchema: schema } : {}),
        ...(agentOptions(route) ? { agentOptions: agentOptions(route) } : {}),
      })
    const run = provisional ? await withRequestBinding(provisional, start) : await start()
    logger.info(`[subagent:${role}] started id=${String(run.id ?? '')}`)
    const releaseOwnership = context.requestLedger
      ? registerOwnedSession(String(run.id), sessionBinding(role, input.taskId ?? role, String(run.id), context, route, budgetFailure)!)
      : undefined
    try {
      const result = await run.result
      if (budgetFailure.value) throw budgetFailure.value
      logger.info(`[subagent:${role}] result stopReason=${result.stopReason} in ${Date.now() - started}ms`)
      if (result.stopReason !== 'completed') throw stopError(result.stopReason)
      const text = result.output
        .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      return { text, structured: result.structured, stopReason: result.stopReason, childId: run.id }
    } finally {
      releaseOwnership?.()
      await run.dispose()
    }
  }

  private async runJsonRepairAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    failedText: string,
    parseError: string,
  ): Promise<RoleOutput> {
    const schema = objectOutputSchema(role)
    const route = routeFor(input, role, context)
    const prompt = [
      'Return ONLY valid JSON matching the requested schema. Do not explain, use markdown, or call tools.',
      '',
      'Previous output:',
      failedText.slice(0, 4000),
      '',
      'Parse error:',
      parseError,
    ].join('\n')
    const boundedPrompt = prompt.length > 0 ? (estimatePromptTokens(prompt) > (route?.maxInputTokens ?? context.policySnapshot?.budget.maxInputTokens ?? 24_000) ? (() => { throw contextInsufficientError(['repair']) })() : prompt) : prompt
    const budgetFailure = { value: undefined as unknown }
    const provisional = sessionBinding(role, input.taskId ?? role, 'pending-repair-' + randomUUID(), context, route, budgetFailure, 'repair')
    const start = () => this.runtime.start(this.providerName, {
        label: role + ' json-repair',
        prompt: [{ type: 'text', text: boundedPrompt }],
        parent: context.parent as Agent,
        signal: context.signal,
        ...(schema !== undefined ? { outputSchema: schema } : {}),
        ...(agentOptions(route) ? { agentOptions: agentOptions(route) } : {}),
        ...(this.repairToolFilter ? { toolFilter: this.repairToolFilter } : {}),
      })
    const run = provisional ? await withRequestBinding(provisional, start) : await start()
    const releaseOwnership = context.requestLedger
      ? registerOwnedSession(String(run.id), sessionBinding(role, input.taskId ?? role, String(run.id), context, route, budgetFailure, 'repair')!)
      : undefined
    try {
      const result = await run.result
      if (budgetFailure.value) throw budgetFailure.value
      if (result.stopReason !== 'completed') throw stopError(result.stopReason)
      const text = result.output
        .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      return { text, structured: result.structured, stopReason: result.stopReason, childId: run.id }
    } finally {
      releaseOwnership?.()
      await run.dispose()
    }
  }

  private async retryJson(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    attemptFn: () => Promise<RoleOutput>,
  ): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    let output = await attemptFn()
    const originalChildId = output.childId
    let parsed = output.structured !== undefined
      ? { ok: true as const, value: output.structured }
      : parseJsonDetailed(output.text)
    if (parsed.ok) return { ...output, structured: parsed.value }

    const repairs = maxJsonRepairs(context)
    for (let attempt = 1; attempt <= repairs; attempt += 1) {
      logger.warn('[subagent:' + role + '] JSON parse failed, using isolated repair ' + attempt + '/' + repairs + ': ' + parsed.error)
      const ledger = context.requestLedger
      const taskId = input.taskId ?? role
      const repairRoleStartId = `${context.runId ?? 'legacy'}:${taskId}:${taskFingerprint(role, input, context)}:${role}:repair:${attempt}`
      if (ledger) await ledger.beginRole({ roleStartId: repairRoleStartId, taskId, role: `${role}:repair`, tier: routeFor(input, role, context)?.tier ?? 'standard', capabilityStatus: 'limited' })
      try {
        output = await this.runJsonRepairAttempt(role, input, context, output.text, parsed.error)
        if (ledger) await ledger.finishRole(repairRoleStartId, 'completed')
      } catch (error) {
        if (ledger) {
          try { await ledger.finishRole(repairRoleStartId, isBudgetExhaustedError(error) || (error as { code?: unknown })?.code === 'CONTEXT_INSUFFICIENT' || (error as { name?: unknown })?.name === 'AbortError' ? 'paused' : 'failed') } catch { /* preserve repair error */ }
        }
        throw error
      }
      parsed = output.structured !== undefined
        ? { ok: true as const, value: output.structured }
        : parseJsonDetailed(output.text)
      if (!parsed.ok) continue
      const repairedValue = parsed.value
      {
        if (LONG_TASK_ROLES.has(role) && originalChildId) {
          await updateRegistry(input.runDir, input.taskId ?? role, (current) => ({ childId: originalChildId as SessionId, fingerprint: current?.fingerprint ?? taskFingerprint(role, input, context), status: 'completed', stopReason: output.stopReason, text: output.text, structured: repairedValue }))
          return { ...output, childId: originalChildId, structured: repairedValue }
        }
        return { ...output, structured: repairedValue }
      }
    }
    throw new Error('role agent ' + role + ' produced no parseable JSON after ' + (repairs + 1) + ' attempts: ' + parsed.error + '\nLast output:\n' + output.text)
  }

  private runOneShotWithRetry(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    return this.retryJson(role, input, context, () => this.runOneShotAttempt(role, input, context))
  }

  private runContinuableWithRetry(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    return this.retryJson(role, input, context, () => this.runContinuableAttempt(role, input, context))
  }

  async run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    const ledger: RequestLedger | undefined = context.requestLedger
    const route = routeFor(input, role, context)
    const taskId = input.taskId ?? role
    const fingerprint = taskFingerprint(role, input, context)
    const roleStartId = `${context.runId ?? 'legacy'}:${taskId}:${fingerprint}:${role}`
    const admission = ledger ? await ledger.beginRole({ roleStartId, taskId, role, tier: route?.tier ?? 'standard', capabilityStatus: 'limited' }) : undefined
    if (ledger && admission && !admission.created && !LONG_TASK_ROLES.has(role)) {
      const error = new Error(`one-shot role start already exists for ${taskId}`)
      ;(error as Error & { code?: string }).code = 'REQUEST_CONFLICT'
      throw error
    }
    try {
      const output = LONG_TASK_ROLES.has(role)
        ? await this.runContinuableWithRetry(role, input, context)
        : await this.runOneShotWithRetry(role, input, context)
      if (ledger) await ledger.finishRole(roleStartId, 'completed')
      return output
    } catch (error) {
      if (ledger) {
        try { await ledger.finishRole(roleStartId, isBudgetExhaustedError(error) || (error as { code?: unknown })?.code === 'CONTEXT_INSUFFICIENT' || (error as { name?: unknown })?.name === 'AbortError' ? 'paused' : 'failed') } catch { /* preserve the operation error */ }
      }
      throw error
    }
  }
}
