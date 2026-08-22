import { researchActionStart, researchActionFinish, researchEvidenceAdd, researchTreeQuery } from '../../dist/tools/index.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../../dist/agents/types.js'

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
      case 'idea-generator':
        return {
          text: '',
          structured: {
            hypotheses: [{
              statement: 'Generated hypothesis',
              intervention: 'run experiment',
              expected_effect: 'metric changes',
              supported_premises: [],
              inference_chain: [],
              predicted_observations: ['observation'],
              disconfirming_observations: ['counter observation'],
              sources: ['source-key'],
            }],
          },
          stopReason: 'completed',
        }
      case 'idea-falsifiability':
        return { text: '', structured: { testable_implication: 'run experiment', unobservable_variables: [], is_falsifiable: true }, stopReason: 'completed' }
      case 'idea-reviewer': {
        const pkg = JSON.parse(_input.ideaPackage ?? '{}')
        const perspective = pkg.review_perspective ?? 'methodology'
        return { text: '', structured: { perspective, critique: 'ok', unaddressed_risks: [], fatal_flaw_found: false }, stopReason: 'completed' }
      }
      case 'hypothesis-reviser':
        return { text: 'revised', structured: { summary: 'revised', hypotheses: [] }, stopReason: 'completed' }
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
        return {
          text: this.script.writerText ?? '\\documentclass{article}\n\\begin{document}\nDone.\n\\end{document}',
          structured: { mainTex: this.script.writerText ?? '\\documentclass{article}\n\\begin{document}\nDone.\n\\end{document}' },
          stopReason: 'completed',
        }
      case 'paper-planner':
        return { text: '', structured: { plan: '# PAPER PLAN\n\n1. Abstract\n2. Introduction\n3. Method\n4. Experiments\n5. Conclusion' }, stopReason: 'completed' }
      case 'contract-negotiator':
        return { text: '', structured: { contract: '# PAPER_ACCEPTANCE_CONTRACT\n\n- [ ] Every claim has evidence.' }, stopReason: 'completed' }
      case 'contract-reviewer':
        return { text: '', structured: { accepted: true, demands: [] }, stopReason: 'completed' }
      case 'figure-generator':
        return { text: '', structured: { scripts: {}, latexIncludes: '' }, stopReason: 'completed' }
      case 'proof-checker':
        return { text: '', structured: { verdict: 'NOT_APPLICABLE', issues: [], json: '{"verdict":"NOT_APPLICABLE"}' }, stopReason: 'completed' }
      case 'claim-auditor':
        return { text: '', structured: { verdict: 'PASS', issues: [], json: '{"verdict":"PASS"}' }, stopReason: 'completed' }
      case 'citation-auditor':
        return { text: '', structured: { verdict: 'PASS', entries: [], issues: [], json: '{"verdict":"PASS"}' }, stopReason: 'completed' }
      case 'kill-argument-reviewer':
        return { text: '', structured: { verdict: 'NOT_APPLICABLE', reason_code: 'not_theory_or_scope_paper', memo: '', json: '{"verdict":"NOT_APPLICABLE"}' }, stopReason: 'completed' }
      case 'paper-reviewer':
        return { text: '', structured: { score: 8, critical: [], major: [], minor: [] }, stopReason: 'completed' }
      case 'final-report-writer':
        return { text: '', structured: { report: '# Final Report' }, stopReason: 'completed' }
      default:
        throw new Error(`unexpected role ${role}`)
    }
  }
}
