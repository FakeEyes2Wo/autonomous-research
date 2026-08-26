import { AutoResearchService } from './service/autoresearch-service.js'
import { ResearchRunner } from './service/runner.js'
import { ResearchTree } from './core/research-tree.js'
import { SubagentRoleAgentProvider } from './providers/subagent-provider.js'
import { createExperimentRunTool, createPaperPipelineResumeTool, createResearchRunTool, figureApiTest, paperPipelineLastRun, paperPipelineStatus, projectSettingsGet, projectSettingsSave, researchActionFinish, researchActionStart, researchEvidenceAdd, researchHypothesisAdd, researchTreeQuery } from './tools/index.js'
import type { HumanOpenRequest, HumanReviewAnswer, HumanReviewer, HumanReviewRequest } from './core/human-review.js'
import { writeAutoMode } from './session/auto-mode.js'

export const name = 'autoresearch'
export const inject = ['tools', 'subagents', 'commands', 'userQuestions']

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
  provide(name: string, service: unknown): unknown
}): void {
  const provider = new SubagentRoleAgentProvider(ctx.subagents as never)

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
    ctx.tools.register(tool)
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
