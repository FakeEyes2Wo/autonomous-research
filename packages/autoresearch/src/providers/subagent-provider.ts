import { buildPrompt, outputSchemaFor } from '../agents/factory.js'
import { parseJsonDetailed } from '../agents/json-repair.js'
import { createLogger } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../agents/types.js'

// TODO: 需要调查 DSH 原生 Agent 编排 vs 固定研究循环编排（RoleAgentProvider + ResearchRunner）的效果，
// 确定是否应彻底删除本 provider 并改为 DSH Agent 直接编排 subagent。

const MAX_JSON_ATTEMPTS = 3
const LONG_TASK_ROLES = new Set<RoleName>(['research-worker'])

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

function withFeedback(prompt: string, feedback: string | undefined): string {
  return feedback ? `${prompt}\n\n## JSON Fix Required\n\n${feedback}` : prompt
}

function buildJsonFixFeedback(attempt: number, text: string, error: string): string {
  return [
    `Your previous response could not be parsed as structured JSON (attempt ${attempt}).`,
    '',
    'Previous output:',
    text.slice(0, 4000),
    '',
    'Parse error:',
    error,
    '',
    'Return ONLY a valid JSON object or array. Do not include prose, markdown fences, or explanations.',
  ].join('\n')
}

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

  private async runContinuableAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    feedback?: string,
  ): Promise<RoleOutput> {
    if (!this.runtime.startContinuable || !this.eventContext) {
      return this.runOneShotAttempt(role, input, context, feedback)
    }
    const logger = createLogger(input.runDir)
    const prompt = await buildPrompt(role, input)
    const promptWithFeedback = withFeedback(prompt, feedback)
    logger.info(`[subagent:${role}] calling ctx.subagents.startContinuable provider=${this.providerName}`)
    const started = await this.runtime.startContinuable({
      provider: this.providerName,
      label: role,
      request: {
        prompt: [{ type: 'text', text: promptWithFeedback }],
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
    const parsed = parseJsonDetailed(text)
    const structured = parsed.ok ? parsed.value : undefined
    return { text, structured, stopReason: end.stopReason }
  }

  private async runOneShotAttempt(
    role: RoleName,
    input: RoleInput,
    context: RoleExecutionContext,
    feedback?: string,
  ): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    const prompt = await buildPrompt(role, input)
    const promptWithFeedback = withFeedback(prompt, feedback)
    const schema = outputSchemaFor(role)
    logger.info(`[subagent:${role}] calling ctx.subagents.start provider=${this.providerName}`)
    const started = Date.now()
    const run = await this.runtime.start(this.providerName, {
      label: role,
      prompt: [{ type: 'text', text: promptWithFeedback }],
      parent: context.parent,
      signal: context.signal,
      ...(schema !== undefined ? { outputSchema: schema } : {}),
    })
    logger.info(`[subagent:${role}] started id=${String(run.id ?? '')}`)
    const result = await run.result
    logger.info(`[subagent:${role}] result stopReason=${result.stopReason} in ${Date.now() - started}ms`)
    const text = result.output
      .filter((block): block is ContentBlockLike & { text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    await run.dispose()
    return { text, structured: result.structured, stopReason: result.stopReason }
  }

  private async retryJson<T extends RoleOutput>(
    role: RoleName,
    runDir: string,
    attemptFn: (feedback?: string) => Promise<T>,
  ): Promise<T> {
    const logger = createLogger(runDir)
    let feedback: string | undefined
    for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt += 1) {
      const output = await attemptFn(feedback)
      const parsed = output.structured !== undefined
        ? { ok: true as const, value: output.structured }
        : parseJsonDetailed(output.text)
      if (parsed.ok) {
        return { ...output, structured: parsed.value }
      }
      if (attempt < MAX_JSON_ATTEMPTS) {
        feedback = buildJsonFixFeedback(attempt, output.text, parsed.error)
        logger.warn(`[subagent:${role}] JSON parse failed, retrying ${attempt + 1}/${MAX_JSON_ATTEMPTS}: ${parsed.error}`)
      } else {
        throw new Error(
          `role agent ${role} produced no parseable JSON after ${MAX_JSON_ATTEMPTS} attempts: ${parsed.error}\nLast output:\n${output.text}`,
        )
      }
    }
    throw new Error(`role agent ${role} JSON retry exhausted`)
  }

  private runOneShotWithRetry(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    return this.retryJson(role, input.runDir, (feedback) => this.runOneShotAttempt(role, input, context, feedback))
  }

  private runContinuableWithRetry(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    return this.retryJson(role, input.runDir, (feedback) => this.runContinuableAttempt(role, input, context, feedback))
  }

  async run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    if (LONG_TASK_ROLES.has(role)) {
      return this.runContinuableWithRetry(role, input, context)
    }
    return this.runOneShotWithRetry(role, input, context)
  }
}
