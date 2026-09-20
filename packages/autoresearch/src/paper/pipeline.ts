import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { ensureDir, readOptionalText, readText, writeText } from '../core/utils.js'
import { generatePaperPlan, preparePaperLayout, type PreparedPaperLayout, type PaperVenue } from './index.js'
import { bindPaperArtifacts, deterministicPaperIssues, evaluatePaperGate, paperHash, samePaperBinding } from './review-protocol.js'
import { paperReviewRequirements, reviewCompiledPaper } from './review-runner.js'
import { invalidatePaperCheckpoint, loadCheckpoint, saveCheckpoint, type PaperCheckpoint } from './checkpoint.js'
import {
  enrichReferences,
  generateFigures,
  hasStyleRef,
  negotiateContract,
  planPaper,
  polishPaper,
  readStyleProfile,
  resolveAssurance,
  reviewPaperDraft,
  writePaper,
  writePaperReport,
} from './phases.js'
import type { PaperContext, PaperDependencies } from './context.js'
import { toPaperOptions } from '../tools/options.js'

export type { PaperOptions } from './context.js'

export interface PaperPipelineResult {
  planFile: string
  matrixFile: string
  contractFile?: string
  compileOk: boolean
  audits: Record<string, unknown>
  auditStatus: 'passed' | 'failed'
  submissionReady: boolean
  completed: boolean
  finalReport: string
}

export interface PaperPipelineRequest {
  runDir: string
  tree: ResearchTree
  evidencePath: string
  agentContext: RoleExecutionContext
}

/**
 * Functional paper-writing pipeline. `pipeline_checkpoint.json` doubles as the
 * todo list and resume state. Phases are stateless functions in phases.ts.
 */
export async function runPaperPipeline(
  deps: PaperDependencies,
  request: PaperPipelineRequest,
): Promise<PaperPipelineResult> {
  const { runDir, tree, evidencePath, agentContext } = request
  toPaperOptions(deps.options)
  const assurance = resolveAssurance(deps.options)
  const paperDir = join(runDir, 'paper')
  await ensureDir(paperDir)
  // A template entry named main.tex is an example, not a completed writer phase.
  const hadManuscript = existsSync(join(paperDir, 'main.tex'))

  const cp = (await loadCheckpoint(paperDir)) ?? {
    schema: 'autoresearch/paper-pipeline-checkpoint/v1',
    updated_at: new Date().toISOString(),
    assurance,
    phases: {},
    data: {},
  }
  const previousAssurance = cp.assurance
  cp.assurance = assurance
  const save = () => saveCheckpoint(paperDir, cp)
  await save()
  const limits = deps.options.reviewBudget
  cp.data.reviewBudget ??= { used: 0, limit: limits?.maxRequests ?? 32, rounds: 0, maxRounds: limits?.maxRounds ?? deps.options.maxImprovementRounds ?? 3, sequence: 0 }
  if (limits?.maxRequests !== undefined) cp.data.reviewBudget.limit = limits.maxRequests
  if (limits?.maxRounds !== undefined) cp.data.reviewBudget.maxRounds = limits.maxRounds
  const reviewOptionsHash = paperHash({ protocol: 'dependency-kind-v2', assurance, supportsImageInput: deps.options.supportsImageInput, layoutInspection: deps.options.layoutInspection })
  if (cp.data.reviewOptionsHash !== reviewOptionsHash) invalidatePaperCheckpoint(cp, 'Review requirements changed')
  cp.data.reviewOptionsHash = reviewOptionsHash
  const layoutOptions = { venue: (deps.options.venue ?? (deps.options.templateDir ? 'custom' : 'ICLR')) as PaperVenue, templateDir: deps.options.templateDir, templateFile: deps.options.templateFile, profile: deps.options.layoutProfile }
  const layoutOptionsHash = paperHash({ preparation: 'isolated-template-v2', ...layoutOptions })
  let layout: PreparedPaperLayout
  if (cp.data.layout && cp.data.layoutOptionsHash === layoutOptionsHash) layout = cp.data.layout
  else {
    layout = await preparePaperLayout(paperDir, layoutOptions)
    cp.data.layout = layout
    cp.data.layoutOptionsHash = layoutOptionsHash
    invalidatePaperCheckpoint(cp, 'Layout options changed or first preparation')
  }
  await save()

  // Plan.
  let planFile = cp.data.planFile
  let matrixFile = cp.data.matrixFile
  let planText: string
  let matrixText: string
  if (cp.phases.plan === 'done' && planFile && matrixFile && existsSync(planFile) && existsSync(matrixFile)) {
    planText = await readText(planFile)
    matrixText = await readText(matrixFile)
  } else {
    ;({ planFile, matrixFile } = await generatePaperPlan(runDir, tree))
    matrixText = await readText(matrixFile)
    const planCtx: PaperContext = {
      deps,
      paths: { runDir, paperDir },
      content: {
        planText: '',
        matrixText,
        contractText: '',
        figuresLatex: '',
        evidencePath,
      },
      agentContext,
      layout,
    }
    planText = await planPaper(planCtx)
    await writeText(planFile, planText)
    cp.phases.plan = 'done'
    cp.data.planFile = planFile
    cp.data.matrixFile = matrixFile
    await save()
  }

  // Contract + figures are independent; resume only missing side.
  let contractFile = cp.data.contractFile
  let figuresLatex = ''
  const needContract = cp.phases.contract !== 'done'
  const needFigures = cp.phases.figures !== 'done'
  if (needContract || needFigures) {
    const partialCtx: PaperContext = {
      deps,
      paths: { runDir, paperDir },
      content: {
        planText,
        matrixText,
        contractText: '',
        figuresLatex: '',
        evidencePath,
      },
      agentContext,
      layout,
    }
    const [c, f] = await Promise.all([
      needContract ? negotiateContract(partialCtx) : Promise.resolve(contractFile),
      needFigures ? generateFigures(partialCtx) : Promise.resolve(figuresLatex),
    ])
    contractFile = c ?? contractFile
    figuresLatex = f ?? ''
    if (needContract) {
      cp.phases.contract = 'done'
      cp.data.contractFile = contractFile
    }
    if (needFigures) cp.phases.figures = 'done'
    await save()
  }
  if (!figuresLatex) figuresLatex = (await readOptionalText(join(paperDir, 'figures', 'latex_includes.tex'))) ?? ''

  const ctx: PaperContext = {
    deps,
    paths: { runDir, paperDir },
    content: {
      planText,
      matrixText,
      contractText: contractFile ? (await readOptionalText(contractFile)) ?? '' : '',
      figuresLatex,
      styleProfile: hasStyleRef(deps.options) ? await readStyleProfile(runDir) : undefined,
      evidencePath,
    },
    agentContext,
    layout,
  }

  // Existing manuscript bytes are authoritative on resume, including manual repairs.
  if (hadManuscript && cp.data.binding) {
    try {
      const current = await bindPaperArtifacts(paperDir, evidencePath, layout, cp.data.compile?.inspection)
      if (!samePaperBinding(current, cp.data.binding)) invalidatePaperCheckpoint(cp, 'Source, template, assets, evidence, PDF or page images changed')
      else if (cp.phases.final === 'done' && cp.data.gate?.verdict === 'PASS' && previousAssurance === assurance) {
        const { requiredRoles } = await paperReviewRequirements(paperDir)
        const savedGate = cp.data.compile && samePaperBinding(cp.data.auditBinding, current) ? evaluatePaperGate({ assurance, binding: current, deterministic: deterministicPaperIssues(cp.data.compile, cp.data.compile.inspection), audits: cp.data.audits ?? {}, reviews: Object.values(cp.data.reviews ?? {}), requiredRoles }) : undefined
        if (savedGate?.verdict === 'PASS') return { planFile: planFile!, matrixFile: matrixFile!, contractFile, compileOk: true, audits: cp.data.audits ?? {}, auditStatus: cp.data.auditStatus ?? 'failed', submissionReady: savedGate.submissionReady, completed: true, finalReport: cp.data.finalReport ?? '' }
        invalidatePaperCheckpoint(cp, 'Saved gate has incomplete or stale audit/review records')
      }
    } catch (error) { invalidatePaperCheckpoint(cp, String(error)) }
  }
  if (!hadManuscript) await writePaper(ctx)
  cp.phases.writing = 'done'
  await save()

  const runGate = async () => {
    try { return await reviewCompiledPaper(ctx, cp) }
    catch (error) {
      cp.data.submissionReady = false
      cp.data.gate = { verdict: 'BLOCKED' as const, submissionReady: false, reasons: [String(error)] }
      await save()
      return cp.data.gate
    }
  }
  let gate = await runGate()
  if (gate.verdict === 'PASS' && cp.phases.human_review !== 'done') {
    invalidatePaperCheckpoint(cp, 'Human draft review may revise the manuscript')
    await save()
    await reviewPaperDraft(ctx)
    cp.phases.human_review = 'done'
    await save()
  }
  await enrichReferences(ctx)
  if (gate.verdict === 'PASS' && cp.phases.polish !== 'done') {
    invalidatePaperCheckpoint(cp, 'Polisher requires a fresh final compile, inspection and review')
    await save()
    await polishPaper(ctx)
    cp.phases.polish = 'done'
    await save()
    gate = await runGate()
  } else if (gate.verdict === 'PASS') {
    const afterHuman = await bindPaperArtifacts(paperDir, evidencePath, layout, cp.data.compile?.inspection)
    if (!samePaperBinding(afterHuman, cp.data.binding) || !cp.data.gate) gate = await runGate()
  }
  const audits = cp.data.audits ?? {}
  const auditStatus = cp.data.auditStatus ?? 'failed'
  const compileOk = cp.data.compileOk === true
  const finalReport = await writePaperReport(ctx, assurance, compileOk, audits, auditStatus, gate, { binding: cp.data.binding, reviews: cp.data.reviews, budget: cp.data.reviewBudget, compile: cp.data.compile })
  cp.data.finalReport = finalReport
  cp.data.submissionReady = gate.submissionReady
  cp.phases.final = gate.verdict === 'PASS' ? 'done' : 'failed'
  if (gate.verdict !== 'PASS') {
    cp.data.gate = { ...gate, verdict: 'BLOCKED', submissionReady: false }
    cp.data.submissionReady = false
  }
  await save()
  if (assurance === 'submission' && !gate.submissionReady) throw new Error('paper final gate BLOCKED; resume required: ' + gate.reasons.join('; '))
  return { planFile: planFile!, matrixFile: matrixFile!, contractFile, compileOk, audits, auditStatus, submissionReady: gate.submissionReady, completed: gate.verdict === 'PASS', finalReport }
}
