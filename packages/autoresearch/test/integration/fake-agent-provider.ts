import { researchActionStart } from '../../dist/tools/research-action-start.js'
import { researchActionFinish } from '../../dist/tools/research-action-finish.js'
import { researchEvidenceAdd } from '../../dist/tools/research-evidence-add.js'
import { researchTreeQuery } from '../../dist/tools/research-tree-query.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../../dist/providers/types.js'

const toolExec = { signal: new AbortController().signal }

export interface FakeAgentScript {
  rubric?: string
  reviewOk?: boolean
  plan?: string
  workerStatus?: 'completed' | 'failed'
  decisions: Array<'continue' | 'revise' | 'finish' | 'fail'>
  writerText?: string
}

export class FakeAgentProvider implements RoleAgentProvider {
  calls: RoleName[] = []
  private readonly script: FakeAgentScript
  private lastActionId: string | undefined
  constructor(script: FakeAgentScript) {
    this.script = script
  }

  async run(role: RoleName, _input: RoleInput, _context: RoleExecutionContext): Promise<RoleOutput> {
    this.calls.push(role)
    switch (role) {
      case 'rubric-generator':
        return { text: '', structured: { rubric: this.script.rubric ?? '# Rubric\n\n- metric: accuracy' }, stopReason: 'completed' }
      case 'rubric-reviewer':
        return { text: '', structured: { ok: this.script.reviewOk ?? true, issues: [] }, stopReason: 'completed' }
      case 'planner':
        return { text: '', structured: { plan: this.script.plan ?? '# Plan\n\n1. run analysis' }, stopReason: 'completed' }
      case 'research-worker': {
        const runDir = _input.runDir
        const nodes = await researchTreeQuery.execute({ runDir }, toolExec) as Array<{ id: string; kind: string }>
        const hypothesis = nodes.find((node) => node.kind === 'hypothesis')
        if (hypothesis) {
          const action = await researchActionStart.execute({ runDir, hypothesisId: hypothesis.id, content: 'fake action' }, toolExec) as { id: string }
          this.lastActionId = action.id
          await researchActionFinish.execute({ runDir, actionId: action.id, status: this.script.workerStatus ?? 'completed', summary: 'worker summary', artifacts: [] }, toolExec)
        }
        return {
          text: 'worker done',
          structured: {
            status: this.script.workerStatus ?? 'completed',
            summary: 'worker summary',
            artifacts: ['work/cycle-1/out.txt'],
          },
          stopReason: 'completed',
        }
      }
      case 'evidence-agent': {
        if (this.lastActionId) {
          await researchEvidenceAdd.execute({ runDir: _input.runDir, actionId: this.lastActionId, content: 'fake evidence', verdict: 'supports' }, toolExec)
        }
        return { text: 'evidence checked', structured: { summary: 'evidence checked' }, stopReason: 'completed' }
      }
      case 'supervisor': {
        const action = this.script.decisions.shift() ?? 'finish'
        return { text: '', structured: { action, reason: `fake ${action}` }, stopReason: 'completed' }
      }
      case 'writer':
        return { text: this.script.writerText ?? '# Paper Draft\n\nDone.', structured: { summary: 'paper written' }, stopReason: 'completed' }
      default:
        throw new Error(`unexpected role ${role}`)
    }
  }
}
