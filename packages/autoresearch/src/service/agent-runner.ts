import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../agents/types.js'
import { transition } from '../core/state.js'
import type { RunPhase } from '../core/types.js'
import { safeResolve, withRetry, writeText, type Logger } from '../core/utils.js'
import type { RunSession } from './run-session.js'
import { ResearchTree } from '../core/research-tree.js'

export interface StageRequest {
  session: RunSession
  phase: RunPhase
  stepId: string
  role: RoleName
  label: string
  input: RoleInput
  outputFile?: string
}

/**
 * Thin wrapper around RoleAgentProvider: one place for retry, logging, and the
 * generic "run a stage, persist structured output" flow.
 */
export class RoleRunner {
  private logger: Logger

  constructor(
    private readonly provider: RoleAgentProvider,
    logger: Logger,
  ) {
    this.logger = logger
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  async run(role: RoleName, input: RoleInput, context: RoleExecutionContext, label: string): Promise<RoleOutput> {
    this.logger.info(`[agent:${role}] start ${label}`)
    const started = Date.now()
    try {
      const result = await withRetry(() => this.provider.run(role, input, context), role)
      this.logger.info(`[agent:${role}] done ${label} in ${Date.now() - started}ms`)
      return result
    } catch (error) {
      this.logger.error(`[agent:${role}] failed ${label}`, error)
      throw error
    }
  }

  async runStage(request: StageRequest): Promise<string> {
    await transition(request.session.state, request.phase, request.stepId)
    const result = await this.run(request.role, request.input, request.session.context, request.label)
    const text = JSON.stringify(result.structured ?? { text: result.text }, null, 2)
    if (request.outputFile) await writeText(safeResolve(request.session.runDir, request.outputFile), text)
    this.logger.info(`${request.label} done`)
    return text
  }

  structuredText(structured: unknown, key: string): string | undefined {
    if (typeof structured !== 'object' || structured === null) return undefined
    const value = (structured as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  }

  treeSummary(tree: ResearchTree): string {
    return JSON.stringify(tree.toJSON(), null, 2)
  }
}
