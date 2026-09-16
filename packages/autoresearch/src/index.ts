import { AutoResearchService } from './service/autoresearch-service.js'
import { SubagentRoleAgentProvider } from './providers/subagent-provider.js'
import { createExperimentRunTool, createPaperPipelineResumeTool, createResearchRunTool, figureApiTest, paperPipelineLastRun, paperPipelineStatus, projectSettingsGet, projectSettingsSave, researchActionFinish, researchActionStart, researchEvidenceAdd, researchHypothesisAdd, researchTreeQuery } from './tools/index.js'
import { loadState } from './core/state.js'
import { loadProjectSecrets, loadProjectSettings } from './settings/project-settings.js'
import type { HumanOpenRequest, HumanReviewAnswer, HumanReviewer, HumanReviewRequest } from './core/human-review.js'
import { writeAutoMode } from './session/auto-mode.js'
import type { Context } from '@deepseek-ai/cordis'
import { installRequestAccounting } from './providers/request-accounting.js'
import { bindToolWorkspacePaths } from './tools/workspace-paths.js'
import type { SessionStore } from '@deepseek-ai/dsh-session'

export const name = 'autoresearch'
export const inject = ['tools', 'subagents', 'commands', 'userQuestions', 'llm']

interface DshCommandInvocation {
  readonly rawInput: string
}

interface DshCommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

interface DshCommandRegistry {
  register(def: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>
  }): unknown
}

interface DshUserQuestionAnswer {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

interface DshUserQuestions {
  ask(request: {
    questions: Array<{
      id: string
      question: string
      header?: string
      options?: Array<{ label: string; description?: string }>
      multiSelect?: boolean
    }>
    agent?: unknown
    signal: AbortSignal
  }): Promise<{ answers: DshUserQuestionAnswer[] }>
}

export function apply(ctx: {
  tools: { register(def: unknown): unknown }
  subagents: unknown
  commands: DshCommandRegistry
  userQuestions: DshUserQuestions
  on: Context['on']
  llm: unknown
  sessions?: Pick<SessionStore, 'get'>
  provide(name: string, service: unknown): unknown
}): void {
  installRequestAccounting(ctx as unknown as Context)
  const provider = new SubagentRoleAgentProvider(ctx.subagents as never, {
    context: ctx as unknown as Pick<Context, 'on'>,
    repairToolFilter: { allow: [] },
  })

  const reviewer: HumanReviewer = {
    async ask(request: HumanReviewRequest, signal: AbortSignal, agent?: unknown): Promise<HumanReviewAnswer> {
      const answer = await ctx.userQuestions.ask({
        questions: [
          {
            id: 'verdict',
            question: request.title,
            header: `Human Review — ${request.gate}`,
            options: [
              { label: 'approve', description: 'Continue the loop as-is.' },
              { label: 'revise', description: 'Pause and apply the feedback written below.' },
              { label: 'reject', description: 'Stop this run and write the failure report.' },
            ],
          },
          {
            id: 'feedback',
            question: 'If you chose revise, write the required changes. Leave empty otherwise.',
            header: 'Review feedback',
          },
        ],
        ...(agent ? { agent } : {}),
        signal,
      })
      const verdictAnswer = answer.answers.find((a) => a.id === 'verdict')
      const feedbackAnswer = answer.answers.find((a) => a.id === 'feedback')
      const selected = verdictAnswer?.selected[0] ?? verdictAnswer?.custom ?? ''
      const feedback = feedbackAnswer?.custom?.trim() || undefined
      if (selected === 'reject') return { verdict: 'reject', feedback }
      if (selected === 'revise' || feedback) return { verdict: 'revise', feedback }
      return { verdict: 'approve', feedback }
    },
    async askOpen(request: HumanOpenRequest, signal: AbortSignal, agent?: unknown): Promise<string | undefined> {
      const answer = await ctx.userQuestions.ask({
        questions: [{
          id: 'open',
          question: request.title,
          header: 'Human Input',
        }],
        ...(agent ? { agent } : {}),
        signal,
      })
      return answer.answers[0]?.custom?.trim() || undefined
    },
  }

  const service = new AutoResearchService(provider, { reviewer })
  ctx.provide('autoresearch', service)

  ctx.commands.register({
    name: 'auto',
    description: 'Toggle autoresearch auto mode: /auto skips all human review gates, /auto on forces auto, /auto off restores human review.',
    async handler(invocation) {
      const input = invocation.rawInput.trim().toLowerCase()
      const next = input === 'off' ? false : true
      const enabled = await writeAutoMode(next)
      return { kind: 'success', text: enabled ? 'Autoresearch auto mode ON: human review gates will be skipped.' : 'Autoresearch auto mode OFF: human review gates are active.' }
    },
  })

  ctx.commands.register({
    name: 'auto_research',
    description: 'AutoResearch mode help/status/config. Examples: /auto_research, /auto_research config <projectDir>, /auto_research status <runDir>.',
    async handler(invocation) {
      const raw = invocation.rawInput.trim()
      const lower = raw.toLowerCase()
      if (lower.startsWith('config')) {
        const projectDir = raw.slice('config'.length).trim() || process.cwd()
        const settings = await loadProjectSettings(projectDir)
        const secrets = await loadProjectSecrets(projectDir)
        return {
          kind: 'success',
          text: [
            `# AutoResearch Project Config`,
            '',
            `projectDir: ${projectDir}`,
            `paperExploration: ${JSON.stringify(settings.paperExploration, null, 2)}`,
            `figureApi: ${JSON.stringify({ ...settings.figureApi, apiKey: secrets.figureApiKey ? '****' : undefined }, null, 2)}`,
            `model: ${JSON.stringify(settings.model, null, 2)}`,
            `experiment: ${JSON.stringify(settings.experiment, null, 2)}`,
          ].join('\n'),
        }
      }
      if (lower.startsWith('status')) {
        const runDir = raw.slice('status'.length).trim()
        if (!runDir) return { kind: 'error', text: 'Usage: /auto_research status <runDir>' }
        const state = await loadState(runDir)
        return { kind: 'success', text: state ? JSON.stringify(state, null, 2) : 'no run state found' }
      }
      return {
        kind: 'success',
        text: [
          '# AutoResearch Mode',
          '',
          'Usage:',
          '  /auto_research config <projectDir>    show project settings',
          '  /auto_research status <runDir>        show run state',
          '',
          'Tools:',
          '  research_run                         full research loop',
          '  experiment_run                       standalone experiment',
          '  project_settings_get/save            project config',
          '  figure_api_test                      test external figure API',
          '  paper_pipeline_status/last_run/resume',
        ].join('\n'),
      }
    },
  })

  for (const tool of [
    researchHypothesisAdd,
    researchActionStart,
    researchActionFinish,
    researchEvidenceAdd,
    researchTreeQuery,
    createExperimentRunTool(provider),
    projectSettingsGet,
    projectSettingsSave,
    figureApiTest,
    paperPipelineStatus,
    paperPipelineLastRun,
    createPaperPipelineResumeTool(service),
    createResearchRunTool(service),
  ]) {
    ctx.tools.register(bindToolWorkspacePaths(tool, (agentId) => ctx.sessions?.get(agentId)?.header.cwd))
  }
}

export { AutoResearchService } from './service/autoresearch-service.js'
export { ResearchRunner } from './service/runner.js'
export { runExperimentTask } from './experiment/runner.js'
export type { ExperimentDependencies, ExperimentRunRequest, ExperimentRunResult } from './experiment/runner.js'
export { ResearchTree } from './core/research-tree.js'
export * from './settings/project-settings.js'
export * from './core/types.js'
export * from './core/human-review.js'
export * from './security/index.js'
export * from './export/evidence-chain.js'
export * from './research/index.js'
export * from './memory/index.js'
export * from './research-context/index.js'
export * from './capabilities/index.js'
export type { FailureReportImport } from './service/failure-import.js'
