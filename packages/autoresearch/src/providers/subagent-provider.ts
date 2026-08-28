import { buildPrompt, outputSchemaFor } from '../agents/factory.js'
import { createLogger } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../agents/types.js'

interface ContentBlockLike {
  type: string
  text?: string
}

interface SubagentResultLike {
  output: ContentBlockLike[]
  structured?: unknown
  stopReason: string
}

interface SubagentRunLike {
  id: string
  result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

interface SubagentStartRequestLike {
  label?: string
  prompt: ContentBlockLike[]
  parent: unknown
  signal: AbortSignal
  outputSchema?: Record<string, unknown>
}

interface SubagentContinuableStartLike {
  childId: string
  messageId?: string
}

interface SubagentContinuableSpecLike {
  provider: string
  label: string
  request: {
    prompt: ContentBlockLike[]
    parent: unknown
  }
  signal: AbortSignal
}

interface SubagentEndInfoLike {
  id: string
  stopReason: string
  lastAssistantMessage?: ContentBlockLike[]
}

interface SubagentRuntimeLike {
  start(provider: string, request: SubagentStartRequestLike): Promise<SubagentRunLike>
  startContinuable?(spec: SubagentContinuableSpecLike): Promise<SubagentContinuableStartLike>
}

interface SubagentEventContextLike {
  on(event: 'subagent/end', listener: (info: SubagentEndInfoLike) => void): () => void
}

export interface SubagentProviderOptions {
  providerName?: string
  context?: SubagentEventContextLike
}

const LONG_TASK_ROLES = new Set<RoleName>(['research-worker'])

export class SubagentRoleAgentProvider implements RoleAgentProvider {
  private readonly runtime: SubagentRuntimeLike
  private readonly providerName: string
  private readonly eventContext?: SubagentEventContextLike
  private readonly events: SubagentEndInfoLike[] = []
  private readonly waiters: Array<{
    id: string
    resolve: (value: SubagentEndInfoLike) => void
    reject: (reason: unknown) => void
  }> = []
  private listenerInstalled = false

  constructor(runtime: SubagentRuntimeLike, options: SubagentProviderOptions = {}) {
    this.runtime = runtime
    this.providerName = options.providerName ?? 'spawn'
    this.eventContext = options.context
  }

  private ensureListener(): void {
    if (this.listenerInstalled || !this.eventContext) return
    this.eventContext.on('subagent/end', (info) => {
      const index = this.waiters.findIndex((waiter) => waiter.id === info.id)
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1)
        waiter?.resolve(info)
      } else {
        this.events.push(info)
      }
    })
    this.listenerInstalled = true
  }

  private waitForEnd(childId: string): Promise<SubagentEndInfoLike> {
    this.ensureListener()
    const existing = this.events.find((event) => event.id === childId)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      this.waiters.push({ id: childId, resolve, reject })
    })
  }

  private async runContinuable(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    if (!this.runtime.startContinuable || !this.eventContext) {
      return this.runOneShot(role, input, context)
    }
    const logger = createLogger(input.runDir)
    const prompt = await buildPrompt(role, input)
    logger.info(`[subagent:${role}] calling ctx.subagents.startContinuable provider=${this.providerName}`)
    const started = await this.runtime.startContinuable({
      provider: this.providerName,
      label: role,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: context.parent,
      },
      signal: context.signal,
    })
    logger.info(`[subagent:${role}] continuable started id=${started.childId}`)
    const end = await this.waitForEnd(started.childId)
    logger.info(`[subagent:${role}] continuable ended stopReason=${end.stopReason}`)
    const text = (end.lastAssistantMessage ?? [])
      .filter((block): block is ContentBlockLike & { text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (end.stopReason !== 'completed') {
      throw new Error(`role agent ${role} ended with stopReason=${end.stopReason}`)
    }
    return { text, structured: undefined, stopReason: end.stopReason }
  }

  private async runOneShot(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    const prompt = await buildPrompt(role, input)
    const schema = outputSchemaFor(role)
    logger.info(`[subagent:${role}] calling ctx.subagents.start provider=${this.providerName}`)
    const started = Date.now()
    const run = await this.runtime.start(this.providerName, {
      label: role,
      prompt: [{ type: 'text', text: prompt }],
      parent: context.parent,
      signal: context.signal,
      ...(schema !== undefined ? { outputSchema: schema } : {}),
    })
    logger.info(`[subagent:${role}] started id=${String(run.id ?? '')}`)
    const result = await run.result
    logger.info(`[subagent:${role}] result stopReason=${result.stopReason} in ${Date.now() - started}ms`)
    await run.dispose()
    if (result.stopReason !== 'completed') {
      throw new Error(`role agent ${role} ended with stopReason=${result.stopReason}`)
    }
    return {
      text: result.output.filter((block): block is ContentBlockLike & { text: string } => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(''),
      structured: result.structured,
      stopReason: result.stopReason,
    }
  }

  async run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    if (LONG_TASK_ROLES.has(role)) {
      return this.runContinuable(role, input, context)
    }
    return this.runOneShot(role, input, context)
  }
}
