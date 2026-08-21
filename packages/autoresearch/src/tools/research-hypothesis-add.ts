import { defineTool, loadTree, renderJson, requireRunDir } from './shared.js'
import type { ToolDefinitionLike } from './types.js'

export const researchHypothesisAdd: ToolDefinitionLike = defineTool({
  name: 'research_hypothesis_add',
  description: 'Add or revise a hypothesis in the ResearchTree.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
      content: { type: 'string', description: 'Hypothesis statement' },
      id: { type: 'string', description: 'Optional hypothesis id' },
      status: { type: 'string', description: 'Optional hypothesis status', default: 'proposed' },
      parent: { type: 'string', description: 'Optional parent node id' },
    },
    required: ['runDir', 'content'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  async execute(args) {
    const runDir = requireRunDir(args)
    const tree = await loadTree(runDir)
    const node = tree.add('hypothesis', String(args.content), {
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
    await tree.save()
    return node
  },
})
