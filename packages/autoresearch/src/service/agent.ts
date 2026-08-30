import type { RoleInput, RoleName, RoleOutput } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { transition } from '../core/state.js'
import type { RunPhase } from '../core/types.js'
import { safeResolve, withRetry, writeText } from '../core/utils.js'
import type { RunContext } from './context.js'

export interface AgentRequest {
  role: RoleName
  label: string
  input: RoleInput
}

export interface StageRequest extends AgentRequest {
  phase: RunPhase
  stepId: string
  outputFile?: string
}

let transitionQueue: Promise<void> = Promise.resolve()

function serializeTransition<T>(fn: () => Promise<T>): Promise<T> {
  const run = transitionQueue.then(fn, fn)
  transitionQueue = run.then(() => undefined, () => undefined)
  return run
}

export async function runAgent(ctx: RunContext, request: AgentRequest): Promise<RoleOutput> {
  ctx.logger.info(`[agent:${request.role}] start ${request.label}`)
  const started = Date.now()
  try {
    const result = await withRetry(() => ctx.deps.provider.run(request.role, request.input, ctx.context), request.role)
    ctx.logger.info(`[agent:${request.role}] done ${request.label} in ${Date.now() - started}ms`)
    return result
  } catch (error) {
    ctx.logger.error(`[agent:${request.role}] failed ${request.label}`, error)
    throw error
  }
}

export async function runStage(ctx: RunContext, request: StageRequest): Promise<string> {
  // Parallel stages must not write state.json concurrently. Transition is
  // serialized; the actual AI calls still run concurrently after transition.
  await serializeTransition(() => transition(ctx.state, request.phase, request.stepId))
  const result = await runAgent(ctx, request)
  const text = JSON.stringify(result.structured ?? { text: result.text }, null, 2)
  if (request.outputFile) await writeText(safeResolve(ctx.runDir, request.outputFile), text)
  ctx.logger.info(`${request.label} done`)
  return text
}

export function structuredText(structured: unknown, key: string): string | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined
  const value = (structured as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

export function treeSummary(tree: ResearchTree): string {
  return JSON.stringify(tree.toJSON(), null, 2)
}
