import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { researchActionStart, researchActionFinish, researchEvidenceAdd, researchTreeQuery } from '../../dist/tools/index.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../../dist/agents/types.js'

const toolExec = { signal: new AbortController().signal }

export interface FakeAgentScript {
  rubric?: string
  reviewOk?: boolean
  plan?: string
  workerStatus?: 'completed' | 'failed'
  workerArtifacts?: string[]
  decisions: Array<'continue' | 'revise' | 'finish' | 'fail'>
  writerText?: string
  minimalRisk?: 'low' | 'medium' | 'high'
  throwOnRole?: RoleName
  experimentVerdicts?: string[]
  unstructuredWorker?: boolean
}

export class FakeAgentProvider implements RoleAgentProvider {
  calls: RoleName[] = []
  inputs: Array<{ role: RoleName; input: RoleInput }> = []
  private readonly script: FakeAgentScript
  private lastActionId: string | undefined
  constructor(script: FakeAgentScript) {
    this.script = script
  }

  async run(role: RoleName, _input: RoleInput, _context: RoleExecutionContext): Promise<RoleOutput> {
    this.calls.push(role)
    this.inputs.push({ role, input: _input })
    if (this.script.throwOnRole === role) throw new Error(`fake ${role} failure`)
    switch (role) {
      case 'rubric-generator':
        return { text: '', structured: { rubric: this.script.rubric ?? '# Rubric\n\n- metric: accuracy' }, stopReason: 'completed' }
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
      case 'idea-reflexion':
        return { text: '', structured: { is_falsifiable: true, testable_implication: 'run experiment', unobservable_variables: [], critique: 'ok', unaddressed_risks: [], fatal_flaw_found: false }, stopReason: 'completed' }
      case 'planner':
        return { text: '', structured: { plan: this.script.plan ?? '# Plan\n\n1. run analysis', ...(this.script.minimalRisk ? { riskLevel: this.script.minimalRisk } : {}) }, stopReason: 'completed' }
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
        return { text: '', structured: { feasibility: 'high', generalizability: 'high', risks: [], failureDirections: [], verdict: this.script.experimentVerdicts?.shift() ?? 'proceed' }, stopReason: 'completed' }
      case 'result-reflexion':
        return { text: '', structured: { summary: 'ok', failureAnalysis: 'none', explorationDirections: ['try more backbones'] }, stopReason: 'completed' }
      case 'insight-abstractor':
        return { text: '', structured: { insights: [{ wrongAssumption: 'confidence is reliability', researchQuestion: 'Can reliability be modeled independently of predictive confidence?', methodFamilies: ['evidential uncertainty', 'Dirichlet evidence'], divergencePoint: 'reliability representation under conflict' }] }, stopReason: 'completed' }
      case 'research-worker': {
        const runDir = _input.runDir
        const nodes = await researchTreeQuery.execute({ runDir }, toolExec) as Array<{ id: string; kind: string }>
        const hypothesis = nodes.find((node) => node.kind === 'hypothesis')
        const artifact = 'work/cycle-1/out.txt'
        await mkdir(join(runDir, 'work', 'cycle-1'), { recursive: true })
        await writeFile(join(runDir, artifact), 'fake worker artifact\n', 'utf8')
        await mkdir(join(runDir, 'work', 'cycle-01'), { recursive: true })
        await writeFile(join(runDir, 'work', 'cycle-01', 'out.txt'), 'fake worker artifact\n', 'utf8')
        if (hypothesis) {
          const action = await researchActionStart.execute({ runDir, hypothesisId: hypothesis.id, content: 'fake action' }, toolExec) as { id: string }
          this.lastActionId = action.id
          await researchActionFinish.execute({ runDir, actionId: action.id, status: this.script.workerStatus ?? 'completed', summary: 'worker summary', artifacts: [artifact] }, toolExec)
        }
        if (this.script.unstructuredWorker) return { text: 'worker returned no structured result', stopReason: 'completed' }
        return {
          text: 'worker done',
          structured: {
            status: this.script.workerStatus ?? 'completed',
            summary: 'worker summary',
            artifacts: this.script.workerArtifacts ?? ['work/cycle-1/out.txt'],
          },
          stopReason: 'completed',
        }
      }
      case 'evidence-agent': {
        if (this.lastActionId) {
          await researchEvidenceAdd.execute({ runDir: _input.runDir, actionId: this.lastActionId, content: 'fake evidence', verdict: 'supports', artifacts: ['work/cycle-1/out.txt'] }, toolExec)
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
      case 'paper-polisher':
        return { text: '', structured: { mainTex: this.script.writerText ?? '\\documentclass{article}\n\\begin{document}\nDone.\n\\end{document}', changes: [] }, stopReason: 'completed' }
      case 'paper-survey': {
        const clusters = Array.from({ length: 5 }, (_, i) => ({
          id: `c${String(i + 1).padStart(2, '0')}`,
          name: `Cluster ${i + 1}`,
          summary: `cluster summary ${i + 1}`,
          sourceSurveyIds: [`s${String(i + 1).padStart(3, '0')}`],
          openQuestions: [`open ${i + 1}`],
        }))
        const surveys = Array.from({ length: 3 }, (_, i) => ({
          id: `s${String(i + 1).padStart(3, '0')}`,
          title: `Survey ${i + 1}`,
          arxivId: `2401.${String(i + 1).padStart(5, '0')}`,
          url: `https://arxiv.org/abs/2401.${String(i + 1).padStart(5, '0')}`,
          year: '2024',
          venue: 'ICLR',
          citations: 100 + i,
          scope: `scope ${i + 1}`,
          taxonomy: [`tax ${i + 1}`],
          openQuestions: [`q ${i + 1}`],
          recommendedDirections: [`dir ${i + 1}`],
        }))
        const papers = Array.from({ length: 60 }, (_, i) => {
          const n = i + 1
          const id = `s${String(n).padStart(3, '0')}`
          const isSurvey = n <= 3
          return {
            id,
            title: isSurvey ? `Survey ${n}` : `Paper ${n}`,
            arxivId: `2401.${String(n).padStart(5, '0')}`,
            url: `https://arxiv.org/abs/2401.${String(n).padStart(5, '0')}`,
            year: '2024',
            venue: 'ICLR',
            citations: 10 + n,
            abstract: `abstract ${n}`,
            clusterId: `c${String((n % 5) + 1).padStart(2, '0')}`,
            role: isSurvey ? 'survey' : 'method',
            isSurvey,
            oneLiner: `one ${n}`,
            keyFinding: `finding ${n}`,
            weakness: `weak ${n}`,
            implication: `implication ${n}`,
            contributions: [`contribution ${n}`],
            methods: [`method ${n}`],
            experiments: [`experiment ${n}`],
            results: [`result ${n}`],
            limitations: [`limitation ${n}`],
            futureDirections: [`future ${n}`],
            insights: [`insight ${n}`],
            relevance: `relevance ${n}`,
          }
        })
        return {
          text: '',
          structured: { overview: 'overview', surveys, clusters, papers },
          stopReason: 'completed',
        }
      }
      case 'direction-select': {
        return {
          text: '',
          structured: {
            directions: [
              { id: 'd1', name: 'Direction 1', statement: 'Statement 1', evidence: ['s001', 's002', 's003'], cheapTest: 'cheap 1', risk: 'risk 1' },
              { id: 'd2', name: 'Direction 2', statement: 'Statement 2', evidence: ['s004', 's005', 's006'], cheapTest: 'cheap 2', risk: 'risk 2' },
              { id: 'd3', name: 'Direction 3', statement: 'Statement 3', evidence: ['s007', 's008', 's009'], cheapTest: 'cheap 3', risk: 'risk 3' },
            ],
            selectedId: 'd1',
            backups: ['d2', 'd3'],
          },
          stopReason: 'completed',
        }
      }
      case 'paper-frontier-miner': {
        const papers = Array.from({ length: 15 }, (_, i) => {
          const n = i + 1
          return {
            id: `l${String(n).padStart(3, '0')}`,
            title: `Latest Paper ${n}`,
            arxivId: `2501.${String(n).padStart(5, '0')}`,
            url: `https://arxiv.org/abs/2501.${String(n).padStart(5, '0')}`,
            year: '2025',
            venue: 'NeurIPS',
            citations: n,
            abstract: `latest abstract ${n}`,
            directionId: `d${(i % 3) + 1}`,
            role: 'A',
            whyLatest: `latest ${n}`,
            novelty: `novelty ${n}`,
            weakness: `weak ${n}`,
            oneLiner: `one ${n}`,
            keyFinding: `finding ${n}`,
            implication: `implication ${n}`,
            contributions: [`contribution ${n}`],
            methods: [`method ${n}`],
            experiments: [`experiment ${n}`],
            results: [`result ${n}`],
            limitations: [`limitation ${n}`],
            futureDirections: [`future ${n}`],
            insights: [`insight ${n}`],
            relevance: `relevance ${n}`,
          }
        })
        return { text: '', structured: { papers }, stopReason: 'completed' }
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
                evidence: ['s001', 's002', 's003'],
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
                '- paper_wiki/s001.md',
                '- paper_wiki/s002.md',
                '- paper_wiki/s003.md',
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
