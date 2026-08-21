import { defineTool, loadTree, renderJson, requireRunDir } from './shared.js'
import type { ToolDefinitionLike } from './types.js'

export const researchActionStart: ToolDefinitionLike = defineTool({
  name: 'research_action_start',
  description: 'Start a research action for a hypothesis.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
      hypothesisId: { type: 'string', description: 'Parent hypothesis id' },
      content: { type: 'string', description: 'Action description' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Initial artifact paths' },
    },
    required: ['runDir', 'hypothesisId', 'content'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  async execute(args) {
    const runDir = requireRunDir(args)
    const tree = await loadTree(runDir)
    const node = tree.add('action', String(args.content), {
      parent: String(args.hypothesisId),
      status: 'running',
      ...(Array.isArray(args.artifacts) ? { artifacts: args.artifacts.map(String) } : {}),
    })
    await tree.save()
    return node
  },
})
