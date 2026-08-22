import { join } from 'node:path'
import { ResearchTree } from '../core/research-tree.js'
import { isEvidenceVerdict } from '../domain/guards.js'
import { loadCheckpoint } from '../paper/checkpoint.js'
import { readLastRun } from '../session/last-run.js'
import type { AutoResearchService } from '../service/autoresearch-service.js'

export interface ToolExecutionContextLike {
  signal: AbortSignal
  agent?: unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec: ToolExecutionContextLike): Promise<unknown>
}

function requireRunDir(args: Record<string, unknown>): string {
  const value = args.runDir
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('runDir is required')
  return value
}

async function loadTree(runDir: string): Promise<ResearchTree> {
  return ResearchTree.load(runDir)
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function defineTool(def: ToolDefinitionLike): ToolDefinitionLike {
  return def
}

function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined
}

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
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute(args) {
    const tree = await loadTree(requireRunDir(args))
    const node = tree.add('hypothesis', String(args.content), {
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
    await tree.save()
    return node
  },
})

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
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute(args) {
    const tree = await loadTree(requireRunDir(args))
    const node = tree.add('action', String(args.content), {
      parent: String(args.hypothesisId),
      status: 'running',
      ...(strArray(args.artifacts) ? { artifacts: strArray(args.artifacts) } : {}),
    })
    await tree.save()
    return node
  },
})

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
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute(args) {
    const tree = await loadTree(requireRunDir(args))
    const node = tree.update(String(args.actionId), {
      status: String(args.status),
      content: String(args.summary),
      ...(strArray(args.artifacts) ? { artifacts: strArray(args.artifacts) } : {}),
    })
    await tree.save()
    return node
  },
})

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
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute(args) {
    const verdict = String(args.verdict)
    if (!isEvidenceVerdict(verdict)) throw new TypeError(`invalid verdict: ${verdict}`)
    const parent = typeof args.actionId === 'string' ? args.actionId : typeof args.hypothesisId === 'string' ? args.hypothesisId : undefined
    if (!parent) throw new TypeError('evidence requires actionId or hypothesisId')
    const tree = await loadTree(requireRunDir(args))
    const node = tree.add('evidence', String(args.content), {
      parent,
      status: verdict,
      ...(strArray(args.artifacts) ? { artifacts: strArray(args.artifacts) } : {}),
    })
    await tree.save()
    return node
  },
})

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
  output: { schema: { type: 'array', items: { type: 'object', additionalProperties: true } }, render: renderJson },
  async execute(args) {
    const tree = await loadTree(requireRunDir(args))
    return tree.query({
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.kind === 'string' ? { kind: args.kind as 'hypothesis' | 'action' | 'evidence' } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
  },
})

export const paperPipelineStatus: ToolDefinitionLike = defineTool({
  name: 'paper_pipeline_status',
  description: 'Show the paper pipeline checkpoint status for a run directory.',
  parameters: {
    type: 'object',
    properties: {
      runDir: { type: 'string', description: 'Research run directory' },
    },
    required: ['runDir'],
    additionalProperties: false,
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute(args) {
    const runDir = requireRunDir(args)
    const cp = await loadCheckpoint(join(runDir, 'paper'))
    return cp ?? { status: 'no_checkpoint' }
  },
})

export const paperPipelineLastRun: ToolDefinitionLike = defineTool({
  name: 'paper_pipeline_last_run',
  description: 'Show the most recent autoresearch run directory recorded for DSH sessions.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
  async execute() {
    return (await readLastRun()) ?? { status: 'no_last_run' }
  },
})

export function createPaperPipelineResumeTool(service: AutoResearchService): ToolDefinitionLike {
  return defineTool({
    name: 'paper_pipeline_resume',
    description: 'Resume a paper pipeline from its checkpoint in a run directory.',
    parameters: {
      type: 'object',
      properties: {
        runDir: { type: 'string', description: 'Research run directory' },
      },
      required: ['runDir'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args, exec) {
      const parent = exec.agent as { id?: string } | undefined
      if (!parent || typeof parent.id !== 'string') throw new TypeError('paper_pipeline_resume requires a calling DSH agent')
      return service.resume({
        runDir: String(args.runDir),
      }, {
        parent: parent as never,
        signal: exec.signal,
      })
    },
  })
}

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
        paper: {
          type: 'object',
          description: 'Paper writing pipeline options',
          properties: {
            venue: { type: 'string', description: 'Target venue, e.g. ICLR, NeurIPS, ICML' },
            assurance: { type: 'string', enum: ['draft', 'submission'] },
            effort: { type: 'string', enum: ['lite', 'balanced', 'max', 'beast'] },
            illustration: { type: 'string', enum: ['figurespec', 'gemini', 'codex-image2', 'mermaid', 'false'] },
            styleRef: { type: 'string' },
            autoProceed: { type: 'boolean' },
            maxImprovementRounds: { type: 'number' },
            humanCheckpoint: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['runDir'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args, exec) {
      const parent = exec.agent as { id?: string } | undefined
      if (!parent || typeof parent.id !== 'string') throw new TypeError('research_run requires a calling DSH agent')
      return service.run({
        runDir: String(args.runDir),
        candidatePath: typeof args.candidatePath === 'string' ? args.candidatePath : undefined,
        profilePath: typeof args.profilePath === 'string' ? args.profilePath : undefined,
        maxCycles: typeof args.maxCycles === 'number' ? args.maxCycles : undefined,
        paper: typeof args.paper === 'object' && args.paper !== null ? args.paper as Record<string, unknown> : undefined,
      }, {
        parent: parent as never,
        signal: exec.signal,
      })
    },
  })
}
