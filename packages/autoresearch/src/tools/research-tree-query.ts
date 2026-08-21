import { defineTool, loadTree, renderJson, requireRunDir } from './shared.js'
import type { ToolDefinitionLike } from './types.js'

export const researchTreeQuery: ToolDefinitionLike = defineTool({
  name: 'research_tree_query',
  description: 'Query the ResearchTree by id, kind, status, or parent.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
      id: { type: 'string', description: 'Node id' },
      kind: { type: 'string', enum: ['hypothesis', 'action', 'evidence'], description: 'Node kind' },
      status: { type: 'string', description: 'Node status' },
      parent: { type: 'string', description: 'Parent node id' },
    },
    required: ['runDir'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
    render: renderJson,
  },
  async execute(args) {
    const runDir = requireRunDir(args)
    const tree = await loadTree(runDir)
    return tree.query({
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.kind === 'string' ? { kind: args.kind as 'hypothesis' | 'action' | 'evidence' } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
  },
})
