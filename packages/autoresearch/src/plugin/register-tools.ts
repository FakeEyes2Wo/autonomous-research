import type { AutoResearchService } from '../service/autoresearch-service.js'
import { researchHypothesisAdd } from '../tools/research-hypothesis-add.js'
import { researchActionStart } from '../tools/research-action-start.js'
import { researchActionFinish } from '../tools/research-action-finish.js'
import { researchEvidenceAdd } from '../tools/research-evidence-add.js'
import { researchTreeQuery } from '../tools/research-tree-query.js'
import { createResearchRunTool } from '../tools/research-run.js'

export interface ToolRegistryLike {
  register(def: unknown): unknown
}

export function registerResearchTools(ctx: { tools: ToolRegistryLike }, service: AutoResearchService): void {
  const tools = [
    researchHypothesisAdd,
    researchActionStart,
    researchActionFinish,
    researchEvidenceAdd,
    researchTreeQuery,
    createResearchRunTool(service),
  ]
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
}
