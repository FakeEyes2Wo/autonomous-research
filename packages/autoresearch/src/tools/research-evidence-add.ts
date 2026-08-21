import { isEvidenceVerdict } from '../domain/evidence.js'
import { defineTool, loadTree, renderJson, requireRunDir } from './shared.js'
import type { ToolDefinitionLike } from './types.js'

export const researchEvidenceAdd: ToolDefinitionLike = defineTool({
  name: 'research_evidence_add',
  description: 'Add evidence bound to an action or hypothesis.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
      actionId: { type: 'string', description: 'Parent action id' },
      hypothesisId: { type: 'string', description: 'Parent hypothesis id (used when no action)' },
      content: { type: 'string', description: 'Evidence description' },
      verdict: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'], description: 'Evidence verdict' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Evidence artifact paths' },
    },
    required: ['runDir', 'content', 'verdict'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: renderJson,
  },
  async execute(args) {
    const runDir = requireRunDir(args)
    const verdict = String(args.verdict)
    if (!isEvidenceVerdict(verdict)) throw new TypeError(`invalid verdict: ${verdict}`)
    const parent = typeof args.actionId === 'string' ? args.actionId : typeof args.hypothesisId === 'string' ? args.hypothesisId : undefined
    if (!parent) throw new TypeError('evidence requires actionId or hypothesisId')
    const tree = await loadTree(runDir)
    const node = tree.add('evidence', String(args.content), {
      parent,
      status: verdict,
      ...(Array.isArray(args.artifacts) ? { artifacts: args.artifacts.map(String) } : {}),
    })
    await tree.save()
    return node
  },
})
