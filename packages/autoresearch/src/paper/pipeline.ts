import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { ensureDir, readText, writeText } from '../core/utils.js'
import { generatePaperPlan, runCompileLoop } from './index.js'
import { loadCheckpoint, saveCheckpoint, type PaperCheckpoint } from './checkpoint.js'
import { PaperPhases, type PaperOptions } from './phases.js'
import type { PaperContext } from './context.js'

export type { PaperOptions } from './phases.js'

export interface PaperPipelineResult {
  planFile: string
  matrixFile: string
  contractFile?: string
  compileOk: boolean
  audits: Record<string, unknown>
  finalReport: string
}

/**
 * PaperPipeline orchestrates the paper-writing skill inside autoresearch.
 * `pipeline_checkpoint.json` doubles as the todo list and resume state.
 * The actual phases live in PaperPhases; this class remains responsible for
 * resume/checkpoint coordination and keeps the public run() signature stable.
 */
export class PaperPipeline {
  private readonly phases: PaperPhases

  constructor(provider: RoleAgentProvider, options: PaperOptions = {}) {
    this.phases = new PaperPhases(provider, options)
  }

  resolveAssurance(): 'draft' | 'submission' {
    return this.phases.resolveAssurance()
  }

  /**
   * Run one phase unless it is already done. The commit callback may persist
   * phase-specific data and decide whether the phase is done or failed.
   */
  private async runPhase<T>(
    paperDir: string,
    cp: PaperCheckpoint,
    id: string,
    run: () => Promise<T>,
    commit: (value: T) => void,
  ): Promise<T | undefined> {
    if (cp.phases[id] === 'done') return undefined
    const value = await run()
    commit(value)
    await saveCheckpoint(paperDir, cp)
    return value
  }

  async run(runDir: string, tree: ResearchTree, evidencePath: string, context: RoleExecutionContext): Promise<PaperPipelineResult> {
    const assurance = this.resolveAssurance()
    const paperDir = join(runDir, 'paper')
    await ensureDir(paperDir)
    await ensureDir(join(paperDir, '.aris'))
    await writeText(join(paperDir, '.aris', 'assurance.txt'), `${assurance}\n`)

    const cp = (await loadCheckpoint(paperDir)) ?? {
      schema: 'autoresearch/paper-pipeline-checkpoint/v1',
      updated_at: new Date().toISOString(),
      assurance,
      phases: {},
      data: {},
    }
    cp.assurance = assurance
    const save = () => saveCheckpoint(paperDir, cp)
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
        paths: { runDir, paperDir },
        content: {
          planText: '',
          matrixText,
          contractText: '',
          figuresLatex: '',
          evidencePath,
        },
        agentContext: context,
      }
      planText = await this.phases.plan(planCtx)
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
        paths: { runDir, paperDir },
        content: {
          planText,
          matrixText,
          contractText: '',
          figuresLatex: '',
          evidencePath,
        },
        agentContext: context,
      }
      const [c, f] = await Promise.all([
        needContract ? this.phases.contract(partialCtx) : Promise.resolve(contractFile),
        needFigures ? this.phases.figures(partialCtx) : Promise.resolve(figuresLatex),
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
    if (!figuresLatex) figuresLatex = await readText(join(paperDir, 'figures', 'latex_includes.tex')).catch(() => '')

    const ctx: PaperContext = {
      paths: { runDir, paperDir },
      content: {
        planText,
        matrixText,
        contractText: contractFile ? await readText(contractFile).catch(() => '') : '',
        figuresLatex,
        styleProfile: this.phases.hasStyleRef() ? await this.phases.readStyleProfile(runDir) : undefined,
        evidencePath,
      },
      agentContext: context,
    }

    // Writing is only considered done after a successful compile. Until then,
    // resume will re-run the writer so missing sections/content can be repaired.
    await this.runPhase(paperDir, cp, 'writing', () => this.phases.write(ctx), () => {})

    // Compile. Missing sections are left for the writer to fix via the compile loop.
    const compileOk = (await this.runPhase(paperDir, cp, 'compile',
      () => runCompileLoop(ctx.paths.paperDir, (feedback) => this.phases.write(ctx, feedback)).then((r) => r.ok),
      (ok) => {
        cp.phases.compile = ok ? 'done' : 'failed'
        cp.data.compileOk = ok
      },
    )) ?? false
    if (compileOk) {
      cp.phases.writing = 'done'
      cp.data.compileOk = true
      await save()
    }

    // Human review of the compiled paper draft. Revise loops back through the
    // writer + compile loop; approve/skip records the phase as done.
    if (compileOk && cp.phases.human_review !== 'done') {
      await this.phases.reviewPaperDraft(ctx)
      cp.phases.human_review = 'done'
      await save()
    }

    // Reference enrichment is best-effort and never blocks the pipeline.
    await this.phases.enrichReferences(ctx)

    // Audits (parallel inside).
    const audits = (await this.runPhase(paperDir, cp, 'audits',
      () => this.phases.audit(ctx),
      (value) => {
        cp.phases.audits = 'done'
        cp.data.audits = value
      },
    )) ?? {}

    // Improvement.
    await this.runPhase(paperDir, cp, 'improvement', () => this.phases.improve(ctx, cp), () => {
      cp.phases.improvement = 'done'
    })

    // Beautification: layout, tables, figures. Content stays unchanged.
    await this.runPhase(paperDir, cp, 'polish', () => this.phases.polish(ctx), () => {
      cp.phases.polish = 'done'
    })

    // Final report.
    const finalReport = (await this.runPhase(paperDir, cp, 'final',
      () => this.phases.report(ctx, assurance, compileOk, audits),
      (value) => {
        cp.phases.final = 'done'
        cp.data.finalReport = value
      },
    )) ?? ''

    return {
      planFile: planFile ?? join(paperDir, 'PAPER_PLAN.md'),
      matrixFile: matrixFile ?? join(paperDir, 'claims_evidence_matrix.json'),
      contractFile,
      compileOk,
      audits,
      finalReport,
    }
  }
}
