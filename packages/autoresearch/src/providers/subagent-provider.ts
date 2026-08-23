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

interface SubagentRuntimeLike {
  start(provider: string, request: SubagentStartRequestLike): Promise<SubagentRunLike>
}

export interface SubagentProviderOptions {
  providerName?: string
}

export class SubagentRoleAgentProvider implements RoleAgentProvider {
  private readonly runtime: SubagentRuntimeLike
  private readonly providerName: string

  constructor(runtime: SubagentRuntimeLike, options: SubagentProviderOptions = {}) {
    this.runtime = runtime
    this.providerName = options.providerName ?? 'spawn'
  }

  async run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput> {
    const logger = createLogger(input.runDir)
    const prompt = await buildPrompt(role, input)
    logger.info(`[subagent:${role}] calling ctx.subagents.start provider=${this.providerName}`)
    const started = Date.now()
    const run = await this.runtime.start(this.providerName, {
      label: role,
      prompt: [{ type: 'text', text: prompt }],
      parent: context.parent,
      signal: context.signal,
      ...(outputSchemaFor(role) !== undefined ? { outputSchema: outputSchemaFor(role) } : {}),
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
}
