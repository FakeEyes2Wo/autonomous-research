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
      case 'model-scout':
        return {
          text: '',
          structured: {
            models: [{ name: 'ViT-B/16', family: 'vision transformer', paper: 'Dosovitskiy et al.', venue: 'ICLR', year: '2021', why: 'popular vision backbone' }],
            sources: ['https://arxiv.org/abs/2010.11929'],
          },
          stopReason: 'completed',
        }
      case 'minimal-verifier':
        return { text: '', structured: { feasibility: 'feasible', minimalEvidence: ['synthetic ok'], artifacts: ['minimal.txt'], reason: 'quick check passed' }, stopReason: 'completed' }
      case 'experiment-designer':
        return {
          text: '',
          structured: {
            datasets: ['real-dataset'],
            conflictConstruction: 'construct real conflicts by label/view corruption',
            splitProtocol: 'clean-train -> unseen-conflict-test',
            backbones: ['mlp', 'resnet'],
            metrics: ['accuracy', 'reliability'],
            rootCauseValidation: 'cross-backbone consistent pattern',
            limitations: ['limited domains'],
          },
          stopReason: 'completed',
        }
      case 'experiment-reflexion':
        return { text: '', structured: { feasibility: 'high', generalizability: 'high', risks: [], failureDirections: [], verdict: 'proceed' }, stopReason: 'completed' }
      case 'result-reflexion':
        return { text: '', structured: { summary: 'ok', failureAnalysis: 'none', explorationDirections: ['try more backbones'] }, stopReason: 'completed' }
      case 'insight-abstractor':
        return { text: '', structured: { insights: [{ wrongAssumption: 'confidence is reliability', researchQuestion: 'Can reliability be modeled independently of predictive confidence?', methodFamilies: ['evidential uncertainty', 'Dirichlet evidence'], divergencePoint: 'reliability representation under conflict' }] }, stopReason: 'completed' }
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
      case 'figure-reflexion':
        return { text: '', structured: { verdict: 'pass', issues: [], textOverload: false, elementOverload: false, elementOverlap: false, mainTitleEmbedded: false }, stopReason: 'completed' }
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
      case 'paper-polisher':
        return { text: '', structured: { mainTex: this.script.writerText ?? '\\documentclass{article}\n\\begin{document}\nDone.\n\\end{document}', changes: [] }, stopReason: 'completed' }
      case 'final-report-writer':
        return { text: '', structured: { report: '# Final Report' }, stopReason: 'completed' }
      case 'paper-miner': {
        const papers = Array.from({ length: 30 }, (_, i) => ({
          id: `p${String(i + 1).padStart(3, '0')}`,
          title: `Paper ${i + 1}`,
          arxivId: `2401.${String(i + 1).padStart(5, '0')}`,
          url: `https://arxiv.org/abs/2401.${String(i + 1).padStart(5, '0')}`,
          year: '2024',
          venue: 'ICLR',
          citations: 10 + i,
          abstract: 'abstract',
          relevance: i < 15 ? 'A' : 'B',
          reasons: ['relevant'],
        }))
        return { text: '', structured: { papers }, stopReason: 'completed' }
      }
      case 'paper-wiki-writer': {
        const wikis: Record<string, string> = {}
        for (let i = 1; i <= 15; i += 1) {
          wikis[`p${String(i).padStart(3, '0')}`] = `# Paper ${i}\n\n## 要点\npoint\n\n## 核心方法\nmethod\n\n## 失败点\nfailure\n\n## 可改进点\nimprove\n\n## Insight\ninsight\n\n## 与我方可能的结合点\nlink`
        }
        return { text: '', structured: { wikis }, stopReason: 'completed' }
      }
      case 'brainstorm': {
        const perspective = String(_input.perspective ?? '')
        if (perspective.startsWith('propose:')) {
          const view = perspective.split(':')[1] ?? 'gap'
          return {
            text: '',
            structured: {
              directions: [{
                id: `${view}-1`,
                source: view,
                direction: `Direction from ${view}`,
                evidence: ['p001', 'p002', 'p003'],
                cheapTest: 'small real-data test',
                risk: 'low',
              }],
            },
            stopReason: 'completed',
          }
        }
        if (perspective === 'score') {
          let candidates: Array<{ id: string }> = []
          try { candidates = JSON.parse(_input.plan ?? '[]') } catch { candidates = [] }
          return {
            text: '',
            structured: {
              scores: candidates.map((candidate, index) => ({
                candidateId: candidate.id,
                novelty: 5 - index,
                feasibility: 4,
                evidence: 5 - index,
              })),
            },
            stopReason: 'completed',
          }
        }
        if (perspective === 'chair') {
          return {
            text: '',
            structured: {
              selectedId: 'gap-1',
              ideaMd: [
                '# IDEA',
                '',
                '## original_seed',
                'seed',
                '',
                '## selected',
                '- rank: 1',
                '- votes: 12',
                '- source: gap',
                '',
                '## reformed_idea',
                '- direction: Refined gap direction',
                '- what_changed: tightened scope',
                '- why_promising: clear gap',
                '',
                '## evidence',
                '- paper_wiki/p001.md',
                '- paper_wiki/p002.md',
                '- paper_wiki/p003.md',
                '',
                '## cheap_test',
                '- run the small real-data test',
                '',
                '## risks',
                '- dataset bias',
                '',
                '## backups',
                '- rank 2: Direction from feasibility',
                '- rank 3: Direction from novelty',
              ].join('\n'),
            },
            stopReason: 'completed',
          }
        }
        return {
          text: '',
          structured: { attack: ['weak point'], support: ['strong point'], revisedDirection: 'Revised direction' },
          stopReason: 'completed',
        }
      }
      default:
        throw new Error(`unexpected role ${role}`)
    }
  }
}
