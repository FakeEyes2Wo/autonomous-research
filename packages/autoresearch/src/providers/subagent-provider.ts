import { buildPrompt, outputSchemaFor } from '../agents/factory.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from './types.js'

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
    const prompt = await buildPrompt(role, input)
    const run = await this.runtime.start(this.providerName, {
      label: role,
      prompt: [{ type: 'text', text: prompt }],
      parent: context.parent,
      signal: context.signal,
      ...(outputSchemaFor(role) !== undefined ? { outputSchema: outputSchemaFor(role) } : {}),
    })
    const result = await run.result
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
