import { AutoResearchService } from './service/autoresearch-service.js'
import { SubagentRoleAgentProvider } from './providers/subagent-provider.js'
import { registerAutoResearchService } from './plugin/register-service.js'
import { registerResearchTools } from './plugin/register-tools.js'

export const name = 'autoresearch'
export const inject = ['tools', 'subagents']

export function apply(ctx: {
  tools: { register(def: unknown): unknown }
  subagents: unknown
  provide(name: string, service: unknown): unknown
}): void {
  const provider = new SubagentRoleAgentProvider(ctx.subagents as never)
  const service = new AutoResearchService(provider)
  registerAutoResearchService(ctx, service)
  registerResearchTools(ctx, service)
}

export { AutoResearchService } from './service/autoresearch-service.js'
export { ResearchRunner } from './service/runner.js'
export { ResearchTree } from './core/research-tree.js'
export * from './core/types.js'
export * from './security/denylist.js'
export * from './security/leakage.js'
export * from './export/evidence-chain.js'
