import { defineTool, loadTree, renderJson, requireRunDir } from './shared.js'
import type { ToolDefinitionLike } from './types.js'

export const researchActionFinish: ToolDefinitionLike = defineTool({
  name: 'research_action_finish',
  description: 'Finish a research action with a result and artifacts.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
      actionId: { type: 'string', description: 'Action node id' },
      status: { type: 'string', enum: ['completed', 'failed'], description: 'Action result status' },
      summary: { type: 'string', description: 'Action result summary' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifact paths' },
    },
    required: ['runDir', 'actionId', 'status', 'summary'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  async execute(args) {
    const runDir = requireRunDir(args)
    const tree = await loadTree(runDir)
    const node = tree.update(String(args.actionId), {
      status: String(args.status),
      content: String(args.summary),
      ...(Array.isArray(args.artifacts) ? { artifacts: args.artifacts.map(String) } : {}),
    })
    await tree.save()
    return node
  },
})
