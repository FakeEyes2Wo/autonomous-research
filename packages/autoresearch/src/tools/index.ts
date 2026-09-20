import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RoleAgentProvider } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { isEvidenceVerdict, type EvidenceVerdict } from '../core/types.js'
import { loadCheckpoint } from '../paper/checkpoint.js'
import { readLastRun } from '../session/last-run.js'
import { runExperimentTask } from '../experiment/runner.js'
import { testFigureApi } from '../figure/api-client.js'
import {
  loadProjectSecrets,
  loadProjectSettings,
  maskProjectSettings,
  normalizeProjectSettings,
  saveProjectSecrets,
  saveProjectSettings,
  type ProjectSettings,
} from '../settings/project-settings.js'
import { patchProjectSettingsDocument, readProjectSettingsDocument, type SettingsPatchOperation } from '../settings/service.js'
import { validateProjectSettingsCandidate } from '../settings/migration.js'
import type { AutoResearchService } from '../service/autoresearch-service.js'
import {
  evidenceVerdictSchema,
  failureReportSchema,
  humanReviewModeSchema,
  jsonOutput,
  renderJson,
  researchNodeKindSchema,
  runDirSchema,
  stringArraySchema,
  stringSchema,
} from './schemas.js'
import { toResearchRunOptions, toFailureReportImport } from './options.js'
import { fuseActionFinish, type ActionFinishEvidence } from '../harness/action-fusion.js'
import { packObservation } from '../harness/observation-pack.js'

export interface ToolExecutionContextLike {
  signal: AbortSignal
  agent?: Agent
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

function requirePath(args: Record<string, unknown>, key: 'runDir' | 'projectDir'): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} is required`)
  return value
}

const requireRunDir = (args: Record<string, unknown>): string => requirePath(args, 'runDir')
const requireProjectDir = (args: Record<string, unknown>): string => requirePath(args, 'projectDir')

function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) result[key] = mergeSettings(result[key] as Record<string, unknown>, value as Record<string, unknown>)
    else result[key] = value
  }
  return result
}

export const researchHypothesisAdd: ToolDefinitionLike = {
  name: 'research_hypothesis_add',
  description: 'Add or revise a hypothesis in the ResearchTree.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
      content: stringSchema('Hypothesis statement'),
      id: stringSchema('Optional hypothesis id'),
      status: stringSchema('Optional hypothesis status', { default: 'proposed' }),
      parent: stringSchema('Optional parent node id'),
    },
    required: ['runDir', 'content'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const tree = await ResearchTree.load(requireRunDir(args))
    const node = tree.add('hypothesis', String(args.content), {
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
    await tree.save()
    return node
  },
}

export const researchActionStart: ToolDefinitionLike = {
  name: 'research_action_start',
  description: 'Start a research action for a hypothesis.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
      hypothesisId: stringSchema('Parent hypothesis id'),
      content: stringSchema('Action description'),
      artifacts: stringArraySchema('Initial artifact paths'),
    },
    required: ['runDir', 'hypothesisId', 'content'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const tree = await ResearchTree.load(requireRunDir(args))
    const node = tree.add('action', String(args.content), {
      parent: String(args.hypothesisId),
      status: 'running',
      ...(strArray(args.artifacts) ? { artifacts: strArray(args.artifacts) } : {}),
    })
    await tree.save()
    return node
  },
}

export const researchActionFinish: ToolDefinitionLike = {
  name: 'research_action_finish',
  description: 'Finish a research action with a result and artifacts.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
      actionId: stringSchema('Action node id'),
      status: { type: 'string', enum: ['completed', 'failed'], description: 'Action result status' },
      summary: stringSchema('Action result summary'),
      artifacts: stringArraySchema('Artifact paths'),
      evidence: {
        type: 'array',
        description: 'Optional evidence to record atomically with action completion.',
        items: { type: 'object', properties: { content: stringSchema('Evidence description'), verdict: evidenceVerdictSchema, artifacts: stringArraySchema('Evidence artifact paths') }, required: ['content', 'verdict'], additionalProperties: false },
      },
    },
    required: ['runDir', 'actionId', 'status', 'summary'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const tree = await ResearchTree.load(requireRunDir(args))
    const evidence = args.evidence === undefined ? undefined : (() => {
      if (!Array.isArray(args.evidence)) throw new TypeError('evidence must be an array')
      return args.evidence.map((entry): ActionFinishEvidence => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('evidence entries must be objects')
        const item = entry as Record<string, unknown>
        if (typeof item.content !== 'string' || typeof item.verdict !== 'string' || !isEvidenceVerdict(item.verdict)) throw new TypeError('evidence content and verdict are required')
        if (item.artifacts !== undefined && (!Array.isArray(item.artifacts) || item.artifacts.some((artifact) => typeof artifact !== 'string'))) throw new TypeError('evidence artifacts must be strings')
        return { content: item.content, verdict: item.verdict as EvidenceVerdict, ...(item.artifacts ? { artifacts: [...item.artifacts] as string[] } : {}) }
      })
    })()
    const artifacts = args.artifacts === undefined ? undefined : (() => {
      if (!Array.isArray(args.artifacts) || args.artifacts.some((artifact) => typeof artifact !== 'string' || artifact.length === 0)) throw new TypeError('action artifacts must be non-empty strings')
      return [...args.artifacts] as string[]
    })()
    const plan = fuseActionFinish({ actionId: String(args.actionId), status: String(args.status) as 'completed' | 'failed', summary: String(args.summary), ...(artifacts ? { artifacts } : {}), ...(evidence ? { evidence } : {}) })
    tree.get(plan.action.id)
    const node = tree.update(plan.action.id, plan.action)
    const evidenceNodes = plan.evidence.map((item) => tree.add('evidence', item.content, { parent: plan.action.id, status: item.verdict, ...(item.artifacts ? { artifacts: item.artifacts } : {}) }))
    await tree.save()
    return evidenceNodes.length > 0 ? { action: node, evidence: evidenceNodes } : node
  },
}

export const researchEvidenceAdd: ToolDefinitionLike = {
  name: 'research_evidence_add',
  description: 'Add evidence bound to an action or hypothesis.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
      actionId: stringSchema('Parent action id'),
      hypothesisId: stringSchema('Parent hypothesis id (used when no action)'),
      content: stringSchema('Evidence description'),
      verdict: evidenceVerdictSchema,
      artifacts: stringArraySchema('Evidence artifact paths'),
    },
    required: ['runDir', 'content', 'verdict'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const verdict = String(args.verdict)
    if (!isEvidenceVerdict(verdict)) throw new TypeError(`invalid verdict: ${verdict}`)
    const parent = typeof args.actionId === 'string' ? args.actionId : typeof args.hypothesisId === 'string' ? args.hypothesisId : undefined
    if (!parent) throw new TypeError('evidence requires actionId or hypothesisId')
    const tree = await ResearchTree.load(requireRunDir(args))
    const node = tree.add('evidence', String(args.content), {
      parent,
      status: verdict,
      ...(strArray(args.artifacts) ? { artifacts: strArray(args.artifacts) } : {}),
    })
    await tree.save()
    return node
  },
}

export const researchTreeQuery: ToolDefinitionLike = {
  name: 'research_tree_query',
  description: 'Query the ResearchTree by id, kind, status, or parent.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
      id: stringSchema('Node id'),
      kind: researchNodeKindSchema,
      status: stringSchema('Node status'),
      parent: stringSchema('Parent node id'),
      packObservation: { type: 'boolean', description: 'Opt in to archive large read-only results and return a precise handle.' },
      observationThresholdBytes: { type: 'number', description: 'Archive threshold in UTF-8 bytes when packObservation is true.' },
      observationExcerptBytes: { type: 'number', description: 'UTF-8 excerpt bytes returned with an archived handle.' },
      observationTaskId: stringSchema('Explicit source task owner for an archived observation'),
      observationDirection: stringSchema('Explicit source direction owner for an archived observation'),
    },
    required: ['runDir'],
    additionalProperties: false,
  },
  output: { schema: { anyOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'object', properties: { observation: { type: 'object', additionalProperties: true }, count: { type: 'number' } }, required: ['observation', 'count'], additionalProperties: false }] }, render: renderJson },
  async execute(args) {
    const tree = await ResearchTree.load(requireRunDir(args))
    const result = tree.query({
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.kind === 'string' ? { kind: args.kind as 'hypothesis' | 'action' | 'evidence' } : {}),
      ...(typeof args.status === 'string' ? { status: args.status } : {}),
      ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
    })
    if (args.packObservation !== true) return result
    const packed = await packObservation(JSON.stringify(result), {
      runDir: requireRunDir(args), enabled: true,
      ...(typeof args.observationThresholdBytes === 'number' ? { thresholdBytes: args.observationThresholdBytes } : {}),
      ...(typeof args.observationExcerptBytes === 'number' ? { excerptBytes: args.observationExcerptBytes } : {}),
      ...(typeof args.observationTaskId === 'string' ? { taskId: args.observationTaskId } : {}),
      ...(typeof args.observationDirection === 'string' ? { direction: args.observationDirection } : {}),
    })
    return packed.kind === 'inline' ? result : { observation: packed, count: result.length }
  },
}

export function createExperimentRunTool(provider: RoleAgentProvider, experimentRuntimeForProject?: (projectDir: string) => Promise<NonNullable<import('../agents/types.js').RoleExecutionContext['experimentRuntime']>>): ToolDefinitionLike {
  return {
    name: 'experiment_run',
    description: 'Run a standalone automatic experiment from a user task requirement.',
    parameters: {
      type: 'object',
      properties: {
        runDir: runDirSchema,
        projectDir: stringSchema('Optional project root containing .autoresearch/project-settings.yaml'),
        task: stringSchema('The user experiment task requirement'),
        profile: stringSchema('Optional PROFILE.md content'),
        maxRounds: { type: 'number', description: 'Optional maximum experiment rounds' },
        failureReport: failureReportSchema,
      },
      required: ['runDir', 'task'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args, exec) {
      const parent = exec.agent as { id?: string } | undefined
      if (!parent || typeof parent.id !== 'string') throw new TypeError('experiment_run requires a calling DSH agent')
      return runExperimentTask({ provider }, {
        runDir: String(args.runDir),
        projectDir: typeof args.projectDir === 'string' ? args.projectDir : undefined,
        task: String(args.task),
        profile: typeof args.profile === 'string' ? args.profile : undefined,
        maxRounds: typeof args.maxRounds === 'number' ? args.maxRounds : undefined,
        failureReport: toFailureReportImport(args.failureReport),
        agentContext: {
          parent: parent as never,
          signal: exec.signal,
          ...(experimentRuntimeForProject ? { experimentRuntime: await experimentRuntimeForProject(typeof args.projectDir === 'string' ? args.projectDir : String(args.runDir)) } : {}),
        },
      })
    },
  }
}

export const projectSettingsGet: ToolDefinitionLike = {
  name: 'project_settings_get',
  description: 'Read the current project AutoResearch settings (secrets masked).',
  parameters: {
    type: 'object',
    properties: {
      projectDir: runDirSchema,
    },
    required: ['projectDir'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const projectDir = requireProjectDir(args)
    const settings = await loadProjectSettings(projectDir)
    const secrets = await loadProjectSecrets(projectDir)
    return maskProjectSettings(settings, secrets)
  },
}

export const projectSettingsReadDocument: ToolDefinitionLike = {
  name: 'project_settings_read_document',
  description: 'Read project settings with source and content revision metadata.',
  parameters: { type: 'object', properties: { projectDir: runDirSchema }, required: ['projectDir'], additionalProperties: false },
  output: jsonOutput,
  async execute(args) {
    const document = await readProjectSettingsDocument(requireProjectDir(args))
    const secrets = await loadProjectSecrets(requireProjectDir(args))
    return { ...document, settings: maskProjectSettings(document.settings, secrets) }
  },
}

export const projectSettingsValidate: ToolDefinitionLike = {
  name: 'project_settings_validate',
  description: 'Validate a project settings candidate without writing it.',
  parameters: { type: 'object', properties: { projectSettings: { type: 'object', additionalProperties: true } }, required: ['projectSettings'], additionalProperties: false },
  output: jsonOutput,
  async execute(args) { return validateProjectSettingsCandidate(args.projectSettings) },
}

export const projectSettingsPatch: ToolDefinitionLike = {
  name: 'project_settings_patch',
  description: 'Atomically patch project settings using an expected content revision.',
  parameters: { type: 'object', properties: { projectDir: runDirSchema, expectedRevision: stringSchema('SHA-256 revision of the document'), ops: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['projectDir', 'expectedRevision', 'ops'], additionalProperties: false },
  output: jsonOutput,
  async execute(args) {
    const document = await patchProjectSettingsDocument(requireProjectDir(args), { expectedRevision: String(args.expectedRevision), ops: args.ops as SettingsPatchOperation[] })
    const secrets = await loadProjectSecrets(requireProjectDir(args))
    return { ...document, settings: maskProjectSettings(document.settings, secrets) }
  },
}

export const projectSettingsSave: ToolDefinitionLike = {
  name: 'project_settings_save',
  description: 'Save project AutoResearch settings, optionally updating the figure API secret.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: runDirSchema,
      projectSettings: {
        type: 'object',
        description: 'Partial ProjectSettings object to merge and save.',
        additionalProperties: true,
      },
      figureApiKey: stringSchema('Optional new API key for the external figure API'),
    },
    required: ['projectDir', 'projectSettings'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const projectDir = requireProjectDir(args)
    const current = await loadProjectSettings(projectDir)
    const patch = (args.projectSettings ?? {}) as Partial<ProjectSettings>
    const next = normalizeProjectSettings(mergeSettings(current as unknown as Record<string, unknown>, patch as unknown as Record<string, unknown>))
    const saved = await saveProjectSettings(projectDir, next)
    if (typeof args.figureApiKey === 'string' && args.figureApiKey) {
      const secrets = await loadProjectSecrets(projectDir)
      await saveProjectSecrets(projectDir, { ...secrets, figureApiKey: args.figureApiKey })
    }
    const secrets = await loadProjectSecrets(projectDir)
    return maskProjectSettings(saved, secrets)
  },
}

export const figureApiTest: ToolDefinitionLike = {
  name: 'figure_api_test',
  description: 'Test the configured external figure generation API.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: runDirSchema,
    },
    required: ['projectDir'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const projectDir = requireProjectDir(args)
    const settings = await loadProjectSettings(projectDir)
    const secrets = await loadProjectSecrets(projectDir)
    const result = await testFigureApi({
      ...settings.figureApi,
      apiKey: secrets.figureApiKey,
    })
    return result
  },
}

export { bindToolWorkspacePaths } from './workspace-paths.js'
export { researchObservationRead, researchVerifiedReceipt } from './observation-tools.js'
export { createCleanupTools } from '../cleanup/tools.js'

export const paperPipelineStatus: ToolDefinitionLike = {
  name: 'paper_pipeline_status',
  description: 'Show the paper pipeline checkpoint status for a run directory.',
  parameters: {
    type: 'object',
    properties: {
      runDir: runDirSchema,
    },
    required: ['runDir'],
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const runDir = requireRunDir(args)
    const cp = await loadCheckpoint(join(runDir, 'paper'))
    const warnings: string[] = []
    if (existsSync(join(runDir, 'RUBRIC_REVIEW_WARNING.md'))) warnings.push('RUBRIC_REVIEW_WARNING.md')
    return cp ? { ...cp, warnings } : { status: 'no_checkpoint', warnings }
  },
}

export const paperPipelineLastRun: ToolDefinitionLike = {
  name: 'paper_pipeline_last_run',
  description: 'Show the most recent autoresearch run directory recorded for DSH sessions.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  output: jsonOutput,
  async execute() {
    return (await readLastRun()) ?? { status: 'no_last_run' }
  },
}

export function createPaperPipelineResumeTool(service: AutoResearchService): ToolDefinitionLike {
  return {
    name: 'paper_pipeline_resume',
    description: 'Resume a paper pipeline from its checkpoint in a run directory.',
    parameters: {
      type: 'object',
      properties: {
        runDir: runDirSchema,
      },
      required: ['runDir'],
      additionalProperties: false,
    },
    output: jsonOutput,
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
  }
}

export function createResearchRunTool(service: AutoResearchService): ToolDefinitionLike {
  return {
    name: 'research_run',
    description: 'Start or resume the minimal autonomous research loop in a run directory.',
    parameters: {
      type: 'object',
      properties: {
        runDir: runDirSchema,
        projectDir: stringSchema('Optional project root containing .autoresearch/project-settings.yaml'),
        candidatePath: stringSchema('Optional external idea file; copied into input/idea.md'),
        profilePath: stringSchema('Optional PROFILE.md path relative to runDir'),
        maxCycles: { type: 'number', description: 'Optional max research cycles' },
        failureReport: failureReportSchema,
        humanReview: { ...humanReviewModeSchema, description: 'auto follows /auto command, on forces human gates, off skips them' },
        brainstorm: { ...humanReviewModeSchema, description: 'auto runs brainstorm when no candidate.md exists' },
        paper: {
          type: 'object',
          description: 'Paper writing pipeline options',
          properties: {
            venue: stringSchema('Target venue, e.g. ICLR, NeurIPS, ICML'),
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
    output: jsonOutput,
    async execute(args, exec) {
      const parent = exec.agent as { id?: string } | undefined
      if (!parent || typeof parent.id !== 'string') throw new TypeError('research_run requires a calling DSH agent')
      return service.run(toResearchRunOptions(args), {
        parent: parent as never,
        signal: exec.signal,
      })
    },
  }
}

export function createProjectPaperRunTool(service: AutoResearchService): ToolDefinitionLike {
  const research = createResearchRunTool(service)
  const { candidatePath: _candidate, failureReport: _failure, brainstorm: _brainstorm, ...properties } = research.parameters.properties as Record<string, unknown>
  return {
    ...research,
    name: 'project_paper_run',
    description: 'Explore an existing project using a bounded read-only source snapshot, select a source-grounded research candidate, validate it within the run budget, and enter the normal paper pipeline after its evidence gate. Historical results remain unverified.',
    parameters: { ...research.parameters, properties, required: ['runDir', 'projectDir'] },
    async execute(args, exec) {
      if (!exec.agent || typeof exec.agent.id !== 'string') throw new TypeError('project_paper_run requires a calling DSH agent')
      const runDir = requireRunDir(args), projectDir = requireProjectDir(args)
      return service.runProjectPaper({ ...toResearchRunOptions(args), runDir, projectDir }, { parent: exec.agent as never, signal: exec.signal })
    },
  }
}
