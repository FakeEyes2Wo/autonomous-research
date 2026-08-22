import { AutoResearchService } from './service/autoresearch-service.js'
import { ResearchRunner } from './service/runner.js'
import { ResearchTree } from './core/research-tree.js'
import { SubagentRoleAgentProvider } from './providers/subagent-provider.js'
import { createPaperPipelineResumeTool, createResearchRunTool, paperPipelineLastRun, paperPipelineStatus, researchActionFinish, researchActionStart, researchEvidenceAdd, researchHypothesisAdd, researchTreeQuery } from './tools/index.js'

export const name = 'autoresearch'
export const inject = ['tools', 'subagents']

export function apply(ctx: {
  tools: { register(def: unknown): unknown }
  subagents: unknown
  provide(name: string, service: unknown): unknown
}): void {
  const provider = new SubagentRoleAgentProvider(ctx.subagents as never)
  const service = new AutoResearchService(provider)
  ctx.provide('autoresearch', service)
  for (const tool of [
    researchHypothesisAdd,
    researchActionStart,
    researchActionFinish,
    researchEvidenceAdd,
    researchTreeQuery,
    paperPipelineStatus,
    paperPipelineLastRun,
    createPaperPipelineResumeTool(service),
    createResearchRunTool(service),
  ]) {
    ctx.tools.register(tool)
  }
}

export { AutoResearchService } from './service/autoresearch-service.js'
export { ResearchRunner } from './service/runner.js'
export { ResearchTree } from './core/research-tree.js'
export * from './core/types.js'
export * from './security/index.js'
export * from './export/evidence-chain.js'
