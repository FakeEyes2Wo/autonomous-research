import { buildPrompt, outputSchemaFor } from '../agents/factory.js'
import { roleSpecs } from '../agents/roles/index.js'
import { parseJsonDetailed } from '../agents/json-repair.js'
import { createLogger } from '../core/utils.js'
import type { PaperImageReceipt, RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../agents/types.js'
import { resolveModelRoute, type ResolvedModelRoute } from '../policy/model-routing.js'
import { resolveBudget } from '../policy/budget.js'
import { clipContext } from '../policy/context.js'
import { estimateTokens } from '../policy/context.js'
import { renderLabeledContextEntries } from '../harness/context-budget.js'
import { assembleResearchContext, canonicalContextJson, type ResearchContextPackage } from '../research-context/index.js'
import { researchContextForInput } from '../service/research-context.js'
import { prepareLiteratureExposure, finishLiteratureExposure, promptContainsSpan, type RegisteredLiteratureSource } from '../literature/context-adapter.js'
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
import { basename, extname, join } from 'node:path'

// TODO: 需要调查 DSH 原生 Agent 编排 vs 固定研究循环编排（RoleAgentProvider + ResearchRunner）的效果，
// 确定是否应彻底删除本 provider 并改为 DSH Agent 直接编排 subagent。

const LONG_TASK_ROLES = new Set<RoleName>(['research-worker'])
const REGISTRY_FILE = join('.autoresearch', 'subagent-tasks.json')
const READ_ONLY_PAPER_ROLES = new Set<RoleName>(['coverage-reviewer', 'figure-reviewer', 'paper-contract-reviewer', 'layout-reviewer', 'paper-reviewer', 'proof-checker', 'claim-auditor', 'citation-auditor', 'kill-argument-reviewer'])

export interface SubagentProviderOptions {
  attachments?: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<Extract<ContentBlock, { type: 'image' }>['attachment']> }
  llm?: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> }
  providerName?: string
  context?: Pick<Context, 'on'>
  /** A host-supplied, validated DSH ToolRestriction for JSON repair. */
  repairToolFilter?: ToolRestriction
}

interface PersistedTask {
  literatureSources?: RegisteredLiteratureSource[]
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
const preparedResearchContexts = new WeakMap<RoleInput, ResearchContextPackage>()
const exposedLiteratureSources = new WeakMap<RoleInput, RegisteredLiteratureSource[]>()

async function transportWithExposure<T>(role: RoleName, input: RoleInput, prompt: string, transport: () => Promise<T>, repair = false): Promise<T> {
  const binding = input.researchContext?.literature
  const context = preparedResearchContexts.get(input)
  if (!binding || !context) return transport()
  // Repair receives previous output only; account for source text repeated by that output.
  const actualContext = repair ? { ...context, selection: { ...context.selection, selected: context.selection.selected.filter(({ record }) => {
    const evidenceText = (record.payload as { evidenceText?: string }).evidenceText
    return record.source.recordType === 'literature-span' && typeof evidenceText === 'string' && promptContainsSpan(prompt, evidenceText)
  }) } } : context
  const exposure = await prepareLiteratureExposure({ runDir: input.runDir, binding, context: actualContext, prompt, role, repair })
  if (!repair) exposedLiteratureSources.set(input, exposure.sources)
  let result: T
  try { result = await transport() }
  catch (error) {
    await finishLiteratureExposure(binding.root, exposure.prepared, 'unknown')
    throw error
  }
  await finishLiteratureExposure(binding.root, exposure.prepared, 'sent')
  return result
}

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

// These are accepted inputs for the current role call, not historical projections.
// buildBoundPrompt keeps each group complete or rejects the call before dispatch.
const CURRENT_WORKFLOW_FIELDS = new Set<keyof RoleInput>([
  'experimentDesign',
  'minimalVerification',
  'reflexion',
  'paperPlan',
  'paperMatrix',
  'paperContract',
  'paperFigures',
])

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
    text: renderLabeledContextEntries(entries.map((entry) => ({ field: String(entry.field), text: entry.text }))),
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
  const researchContext = preparedResearchContexts.get(input)
  const promptWithContext = researchContext ? `${prompt}\n\n${researchContext.rendered}` : prompt
  const withFeedbackPrompt = withFeedback(promptWithContext, feedback)
  const maxInputTokens = route?.maxInputTokens ?? context.policySnapshot?.budget.maxInputTokens ?? 24_000
  if (estimatePromptTokens(withFeedbackPrompt) > maxInputTokens) throw contextInsufficientError(['prompt'])
  return withFeedbackPrompt
}

async function prepareResearchContext(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleInput> {
  const request = input.researchContext
  if (!request) return input
  const projectId = context.projectDir ?? input.projectDir ?? input.runDir
  if (request.scope.projectId !== projectId || (request.scope.runId !== undefined && context.runId !== undefined && request.scope.runId !== context.runId)) {
    const error = new Error('research context scope does not match the active provider scope')
    ;(error as Error & { code?: string }).code = 'CONTEXT_SCOPE_MISMATCH'
    throw error
  }
  const stripped = { ...input }
  for (const field of Object.keys(CLIPPABLE_FIELDS) as Array<keyof RoleInput>) {
    if (!CURRENT_WORKFLOW_FIELDS.has(field)) (stripped as unknown as Record<string, unknown>)[field] = undefined
  }
  const route = routeFor(stripped, role, context)
  const basePrompt = await buildPrompt(role, stripped)
  const maxInputTokens = route?.maxInputTokens ?? context.policySnapshot?.budget.maxInputTokens ?? 24_000
  const remaining = Math.max(0, maxInputTokens - estimatePromptTokens(basePrompt))
  const assembled = await assembleResearchContext({
    runDir: stripped.runDir,
    role,
    taskId: stripped.taskId ?? role,
    request,
    budget: { maxInputTokens: remaining },
  })
  preparedResearchContexts.set(stripped, assembled)
  return stripped
}

function estimatePromptTokens(prompt: string): number {
  return estimateTokens(prompt)
}

function taskFingerprint(role: RoleName, input: RoleInput, context: RoleExecutionContext): string {
  const fields = roleSpecs[role].sections.reduce<Record<string, unknown>>((result, field) => {
    const value = input[field]
    if (value !== undefined) result[String(field)] = value
    return result
  }, {})
  const assembled = preparedResearchContexts.get(input)
  // Retrieval receipts describe attempts, not new scientific inputs. Keep their IDs in the
  // saved prompt/exposure while fingerprinting immutable source bytes and all other context.
  const researchContextHash = input.researchContext?.literature && assembled ? createHash('sha256').update(canonicalContextJson({
    scope: assembled.manifest.scope, snapshot: assembled.manifest.snapshot, protocolHash: assembled.manifest.protocolHash,
    records: assembled.selection.selected.map(({ record }) => {
      if (record.source.recordType !== 'literature-span') return record
      const { contentHash: _hash, payload, ...body } = record
      const { retrievalReceiptId: _receipt, ...source } = payload as Record<string, unknown>
      return { ...body, payload: source }
    }),
  })).digest('hex') : assembled?.manifest.renderedHash
  return createHash('sha256').update(JSON.stringify({ role, taskId: input.taskId ?? role, cycle: input.cycle, fields, researchContextHash, policyVersion: context.policySnapshot?.version, routing: context.policySnapshot?.modelRouting })).digest('hex').slice(0, 24)
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

function textFromBlocks(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
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
  private readonly attachments?: SubagentProviderOptions['attachments']
  private readonly llm?: SubagentProviderOptions['llm']
  private readonly imageReceipts = new WeakMap<RoleInput, PaperImageReceipt>()
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

  constructor(runtime: SubagentRuntime, options: SubagentProviderOptions = {}) {
    this.runtime = runtime
    this.attachments = options.attachments
    this.llm = options.llm
    this.providerName = options.providerName ?? 'spawn'
    this.eventContext = options.context
    this.repairToolFilter = options.repairToolFilter ?? { allow: [] }
  }

  private async nativePrompt(role: RoleName, input: RoleInput, context: RoleExecutionContext, text: string): Promise<ContentBlock[]> {
    this.imageReceipts.delete(input)
    const prompt: ContentBlock[] = [{ type: 'text', text }]
    if (input.supportsImageInput === false || !input.figureImages?.length || !this.attachments || !this.llm) return prompt
    const route = routeFor(input, role, context)
    const provider = route?.provider ?? context.parent.options?.provider
    const model = route?.model ?? context.parent.options?.model
    if (!provider || !model) return prompt
    const info = await this.llm.resolveModelInfo(provider, model, context.signal)
    if (!info.inputModalities?.includes('image')) return prompt
    const images: PaperImageReceipt['images'] = []
    for (const path of input.figureImages) {
      const bytes = await readFile(path)
      const extension = extname(path).toLowerCase()
      const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extension]
      if (!mediaType) throw new Error(`Unsupported native review image: ${path}`)
      const attachment = await this.attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: basename(path) })
      prompt.push({ type: 'image', attachment })
      images.push({ attachmentId: String(attachment.attachmentId), path, hash: createHash('sha256').update(bytes).digest('hex') })
    }
    this.imageReceipts.set(input, { role, taskId: input.taskId ?? role, provider, model, images })
    return prompt
  }

  private ensureListener(): void {
    if (this.listenerInstalled || !this.eventContext) return
    this.eventContext.on('subagent/end', (info) => {
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
      if (persisted?.literatureSources) exposedLiteratureSources.set(input, persisted.literatureSources)
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
          const nativePrompt = await this.nativePrompt(role, input, context, promptWithFeedback)
          started = await transportWithExposure(role, input, promptWithFeedback, () => this.runtime.startContinuable!({
          provider: this.providerName,
          label: role,
          childId: reservedChildId,
          request: {
            prompt: nativePrompt,
            parent: context.parent as Agent,
            ...(agentOptions(route) ? { agentOptions: agentOptions(route) } : {}),
          },
          signal: context.signal,
          }))
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
          await updateRegistry(input.runDir, taskId, () => ({ childId: startedChildId, fingerprint, status: 'pending', literatureSources: exposedLiteratureSources.get(input) }))
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
        const text = textFromBlocks(end.lastAssistantMessage)
        const parsed = parseJsonDetailed(text)
        const structured = parsed.ok ? parsed.value : undefined
        const output = { text, structured, stopReason: end.stopReason, childId: String(activeChildId) }
        if (parsed.ok) {
          await updateRegistry(input.runDir, taskId, () => ({ childId: activeChildId, fingerprint, status: 'completed', stopReason: end.stopReason, text, structured, literatureSources: exposedLiteratureSources.get(input) }))
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
    const route = routeFor(input, role, context)
    const promptWithFeedback = await buildBoundPrompt(role, input, route, context, feedback)
    const schema = objectOutputSchema(role)
    return this.runNativeAttempt(role, input, context, {
      prompt: promptWithFeedback,
      schema,
      kind: 'role',
      label: role,
      log: 'one-shot',
    })
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
    return this.runNativeAttempt(role, input, context, {
      prompt: boundedPrompt,
      schema,
      kind: 'repair',
      label: role + ' json-repair',
      toolFilter: this.repairToolFilter,
      log: 'repair',
    })
  }

  private async runNativeAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    options: {
      prompt: string
      schema?: ObjectJsonSchema
      kind: 'role' | 'repair'
      label: string
      toolFilter?: ToolRestriction
      log: 'one-shot' | 'repair'
    },
  ): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    if (options.kind === 'repair') await context.admitPaperReviewRepair?.()
    if (options.log === 'one-shot') logger.info(`[subagent:${role}] calling ctx.subagents.start provider=${this.providerName}`)
    const started = Date.now()
    const route = routeFor(input, role, context)
    const budgetFailure = { value: undefined as unknown }
    const provisional = sessionBinding(role, input.taskId ?? role, (options.kind === 'repair' ? 'pending-repair-' : 'pending-') + randomUUID(), context, route, budgetFailure, options.kind)
    const startOptions = {
      label: options.label,
      prompt: options.kind === 'repair' ? [{ type: 'text' as const, text: options.prompt }] : await this.nativePrompt(role, input, context, options.prompt),
      parent: context.parent as Agent,
      signal: context.signal,
      ...(options.schema !== undefined ? { outputSchema: options.schema } : {}),
      ...(agentOptions(route) ? { agentOptions: agentOptions(route) } : {}),
      ...(READ_ONLY_PAPER_ROLES.has(role) ? { toolFilter: { allow: options.kind === 'repair' ? [] : ['read', 'read_image', 'glob', 'grep'] } as ToolRestriction } : role === 'project-explorer' ? { toolFilter: { allow: [] } as ToolRestriction } : options.toolFilter ? { toolFilter: options.toolFilter } : {}),
    }
    const start = () => transportWithExposure(role, input, options.prompt, () => this.runtime.start(this.providerName, startOptions), options.kind === 'repair')
    const run = provisional ? await withRequestBinding(provisional, start) : await start()
    if (options.log === 'one-shot') logger.info(`[subagent:${role}] started id=${String(run.id ?? '')}`)
    const releaseOwnership = context.requestLedger
      ? registerOwnedSession(String(run.id), sessionBinding(role, input.taskId ?? role, String(run.id), context, route, budgetFailure, options.kind)!)
      : undefined
    try {
      const result = await run.result
      if (budgetFailure.value) throw budgetFailure.value
      if (options.log === 'one-shot') logger.info(`[subagent:${role}] result stopReason=${result.stopReason} in ${Date.now() - started}ms`)
      if (result.stopReason !== 'completed') throw stopError(result.stopReason)
      return { text: textFromBlocks(result.output), structured: result.structured, stopReason: result.stopReason, childId: run.id }
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
          await updateRegistry(input.runDir, input.taskId ?? role, (current) => ({ childId: originalChildId as SessionId, fingerprint: current?.fingerprint ?? taskFingerprint(role, input, context), status: 'completed', stopReason: output.stopReason, text: output.text, structured: repairedValue, literatureSources: exposedLiteratureSources.get(input) ?? current?.literatureSources }))
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
    if (!input.researchContext && context.policySnapshot?.literature?.mode === 'lexical') {
      input = { ...input, researchContext: await researchContextForInput(role, input, context) }
    }
    input = await prepareResearchContext(role, input, context)
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
      const literatureSources = exposedLiteratureSources.get(input)
      const imageReceipt = this.imageReceipts.get(input)
      return { ...output, ...(literatureSources ? { literatureSources } : {}), ...(imageReceipt ? { imageReceipt } : {}) }
    } catch (error) {
      if (ledger) {
        try { await ledger.finishRole(roleStartId, isBudgetExhaustedError(error) || (error as { code?: unknown })?.code === 'CONTEXT_INSUFFICIENT' || (error as { name?: unknown })?.name === 'AbortError' ? 'paused' : 'failed') } catch { /* preserve the operation error */ }
      }
      throw error
    }
  }
}
