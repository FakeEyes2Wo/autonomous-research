import type { AutoResearchService } from '../service/autoresearch-service.js'
import { defineTool, renderJson } from './shared.js'
import type { ToolDefinitionLike, ToolExecutionContextLike } from './types.js'

export function createResearchRunTool(service: AutoResearchService): ToolDefinitionLike {
  return defineTool({
    name: 'research_run',
    description: 'Start or resume the minimal autonomous research loop in a run directory.',
    parameters: {
      type: 'object',
      properties: {
        runDir: { type: 'string', description: 'Research run directory' },
        candidatePath: { type: 'string', description: 'Optional candidate.md path relative to runDir' },
        profilePath: { type: 'string', description: 'Optional PROFILE.md path relative to runDir' },
        maxCycles: { type: 'number', description: 'Optional max research cycles' },
      },
      required: ['runDir'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJson,
    },
    async execute(args, exec) {
      const parent = exec.agent as { id?: string } | undefined
      if (!parent || typeof parent.id !== 'string') {
        throw new TypeError('research_run requires a calling DSH agent')
      }
      return service.run({
        runDir: String(args.runDir),
        candidatePath: typeof args.candidatePath === 'string' ? args.candidatePath : undefined,
        profilePath: typeof args.profilePath === 'string' ? args.profilePath : undefined,
        maxCycles: typeof args.maxCycles === 'number' ? args.maxCycles : undefined,
      }, {
        parent: parent as never,
        signal: exec.signal,
      })
    },
  })
}

export type { ToolExecutionContextLike }
