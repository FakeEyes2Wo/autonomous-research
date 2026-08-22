import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { atomicWriteJson, ensureDir, readText, writeText } from '../core/utils.js'
import { auditPaper, compilePaper, downloadReferencePdfs, generatePaperPlan, runCompileLoop } from './index.js'
import { loadCheckpoint, saveCheckpoint, type PaperCheckpoint } from './checkpoint.js'

export interface PaperOptions {
  venue?: string
  assurance?: 'draft' | 'submission'
  effort?: 'lite' | 'balanced' | 'max' | 'beast'
  styleRef?: string
  maxImprovementRounds?: number
}

export interface PaperPipelineResult {
  planFile: string
  matrixFile: string
  contractFile?: string
  compileOk: boolean
  audits: Record<string, unknown>
  finalReport: string
}

type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked'
interface Task {
  id: string
  label: string
  parallelGroup?: string
  dependsOn?: string[]
  status: TaskStatus
}

interface PaperContext {
  runDir: string
  paperDir: string
  planText: string
  matrixText: string
  contractText: string
  figuresLatex: string
  styleProfile?: string
  evidencePath: string
  context: RoleExecutionContext
}

const DEFAULT_VENUE = 'ICLR'
const MAX_CONTRACT_ROUNDS = 3
const MAX_FIGURE_RETRIES = 2

/**
 * PaperPipeline orchestrates the paper-writing skill inside autoresearch.
 *
 * Flow:
 *   assurance -> plan -> (contract || figures) -> write -> compile
 *   -> audits (parallel) -> improvement -> final report
 *
 * Only deterministic work (matrix, compile, file I/O, todo tracking) is done
 * in code; all judgment is delegated to prompt-driven subagents.
 */
export class PaperPipeline {
  private readonly provider: RoleAgentProvider
  private readonly options: PaperOptions
  private tasks: Task[] = []

  constructor(provider: RoleAgentProvider, options: PaperOptions = {}) {
    this.provider = provider
    this.options = options
  }

  resolveAssurance(): 'draft' | 'submission' {
    const { assurance, effort } = this.options
    if (assurance === 'draft' || assurance === 'submission') return assurance
    return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
  }

  private async todo(runDir: string, id: string, status: TaskStatus): Promise<void> {
    const task = this.tasks.find((t) => t.id === id)
    if (task) task.status = status
    await atomicWriteJson(join(runDir, 'paper', 'pipeline_tasks.json'), {
      schema: 'autoresearch/paper-pipeline-tasks/v1',
      updated_at: new Date().toISOString(),
      tasks: this.tasks,
    })
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
    await saveCheckpoint(paperDir, cp)

    this.tasks = [
      { id: 'assurance', label: 'Phase 0: Assurance Setup', status: 'pending' },
      { id: 'plan', label: 'Phase 1: Paper Plan', status: 'pending' },
      { id: 'contract', label: 'Phase 1.5: Acceptance Contract', parallelGroup: 'prewrite', status: 'pending' },
      { id: 'figures', label: 'Phase 2: Figure Generation', parallelGroup: 'prewrite', status: 'pending' },
      { id: 'writing', label: 'Phase 3: LaTeX Writing', dependsOn: ['contract', 'figures'], status: 'pending' },
      { id: 'compile', label: 'Phase 4: Compilation', dependsOn: ['writing'], status: 'pending' },
      { id: 'audits', label: 'Phase 4.5/4.7/5.5/5.6/5.8: Audits', parallelGroup: 'audit', dependsOn: ['compile'], status: 'pending' },
      { id: 'improvement', label: 'Phase 5: Improvement Loop', dependsOn: ['audits'], status: 'pending' },
      { id: 'final', label: 'Phase 6: Final Report', dependsOn: ['improvement'], status: 'pending' },
    ]
    await this.todo(runDir, 'assurance', 'done')

    // Phase 1: plan (resume skips if already done).
    let planFile = cp.data.planFile
    let matrixFile = cp.data.matrixFile
    let planText: string
    let matrixText: string
    if (cp.phases.plan === 'done' && planFile && matrixFile && existsSync(planFile) && existsSync(matrixFile)) {
      planText = await readText(planFile)
      matrixText = await readText(matrixFile)
    } else {
      await this.todo(runDir, 'plan', 'running')
      ;({ planFile, matrixFile } = await generatePaperPlan(runDir, tree))
      matrixText = await readText(matrixFile)
      planText = await this.plan(runDir, evidencePath, matrixText, context)
      await writeText(planFile, planText)
      cp.phases.plan = 'done'
      cp.data.planFile = planFile
      cp.data.matrixFile = matrixFile
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'plan', 'done')
    }

    // Phase 1.5 + 2 are independent -> parallel; resume runs only missing side.
    let contractFile = cp.data.contractFile
    let figuresLatex = ''
    const needContract = cp.phases.contract !== 'done'
    const needFigures = cp.phases.figures !== 'done'
    if (needContract || needFigures) {
      if (needContract) await this.todo(runDir, 'contract', 'running')
      if (needFigures) await this.todo(runDir, 'figures', 'running')
      const [c, f] = await Promise.all([
        needContract ? this.contract(runDir, planText, matrixText, evidencePath, context) : Promise.resolve(contractFile),
        needFigures ? this.figures(runDir, planText, matrixText, evidencePath, context) : Promise.resolve(figuresLatex),
      ])
      contractFile = c ?? contractFile
      figuresLatex = f ?? ''
      if (needContract) {
        cp.phases.contract = 'done'
        cp.data.contractFile = contractFile
      }
      if (needFigures) cp.phases.figures = 'done'
      await saveCheckpoint(paperDir, cp)
      if (needContract) await this.todo(runDir, 'contract', 'done')
      if (needFigures) await this.todo(runDir, 'figures', 'done')
    }
    if (!figuresLatex) figuresLatex = await readText(join(paperDir, 'figures', 'latex_includes.tex')).catch(() => '')

    const ctx: PaperContext = {
      runDir,
      paperDir,
      planText,
      matrixText,
      contractText: contractFile ? await readText(contractFile).catch(() => '') : '',
      figuresLatex,
      styleProfile: this.options.styleRef ? await this.readStyleProfile(runDir) : undefined,
      evidencePath,
      context,
    }

    // Phase 3: writing.
    if (cp.phases.writing !== 'done') {
      await this.todo(runDir, 'writing', 'running')
      await this.write(ctx)
      cp.phases.writing = 'done'
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'writing', 'done')
    }

    // Phase 4: compile.
    let compileOk = cp.data.compileOk ?? false
    if (cp.phases.compile !== 'done') {
      await this.todo(runDir, 'compile', 'running')
      compileOk = await runCompileLoop(ctx.paperDir, (feedback) => this.write(ctx, feedback)).then((r) => r.ok)
      cp.phases.compile = compileOk ? 'done' : 'failed'
      cp.data.compileOk = compileOk
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'compile', compileOk ? 'done' : 'failed')
    }

    // Phase 4.5/4.7/5.5/5.6/5.8: audits (parallel inside).
    let audits = cp.data.audits ?? {}
    if (cp.phases.audits !== 'done') {
      await this.todo(runDir, 'audits', 'running')
      audits = await this.audit(ctx)
      cp.phases.audits = 'done'
      cp.data.audits = audits
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'audits', 'done')
    }

    // Phase 5: improvement.
    if (cp.phases.improvement !== 'done') {
      await this.todo(runDir, 'improvement', 'running')
      await this.improve(ctx, cp)
      cp.phases.improvement = 'done'
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'improvement', 'done')
    }

    // Phase 6: final report.
    let finalReport = cp.data.finalReport ?? ''
    if (cp.phases.final !== 'done' || !finalReport) {
      await this.todo(runDir, 'final', 'running')
      finalReport = await this.report(ctx, assurance, compileOk, audits)
      cp.phases.final = 'done'
      cp.data.finalReport = finalReport
      await saveCheckpoint(paperDir, cp)
      await this.todo(runDir, 'final', 'done')
    }

    return {
      planFile: planFile ?? join(paperDir, 'PAPER_PLAN.md'),
      matrixFile: matrixFile ?? join(paperDir, 'claims_evidence_matrix.json'),
      contractFile,
      compileOk,
      audits,
      finalReport,
    }
  }

  private async plan(runDir: string, evidencePath: string, matrixText: string, context: RoleExecutionContext): Promise<string> {
    const result = await this.provider.run('paper-planner', {
      runDir,
      evidenceChainPath: evidencePath,
      paperMatrix: matrixText,
      venue: this.options.venue ?? DEFAULT_VENUE,
      styleProfile: this.options.styleRef ? await this.readStyleProfile(runDir).catch(() => undefined) : undefined,
      assurance: this.resolveAssurance(),
    }, context)
    const plan = (result.structured as { plan?: string } | undefined)?.plan
    if (!plan) throw new Error('paper-planner did not return plan')
    return plan
  }

  private async contract(runDir: string, planText: string, matrixText: string, evidencePath: string, context: RoleExecutionContext): Promise<string> {
    const file = join(runDir, 'paper', 'PAPER_ACCEPTANCE_CONTRACT.md')
    let contract = ''
    for (let round = 0; round < MAX_CONTRACT_ROUNDS; round += 1) {
      const draft = await this.provider.run('contract-negotiator', {
        runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText,
        paperContract: contract || undefined, plan: round ? `Revise per demands:\n${contract}` : undefined,
      }, context)
      contract = (draft.structured as { contract?: string } | undefined)?.contract ?? draft.text
      await writeText(file, contract)

      const review = await this.provider.run('contract-reviewer', {
        runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText, paperContract: contract,
      }, context)
      const verdict = review.structured as { accepted?: boolean; demands?: string[] } | undefined
      if (verdict?.accepted) return file
      contract = `## Reviewer Demands\n\n${(verdict?.demands ?? []).join('\n')}\n\n## Current Contract\n\n${contract}`
    }
    await writeText(file, `${contract}\n\n## Disputed\n\nNot accepted after ${MAX_CONTRACT_ROUNDS} rounds.\n`)
    return file
  }

  private async figures(runDir: string, planText: string, matrixText: string, evidencePath: string, context: RoleExecutionContext): Promise<string> {
    const figuresDir = join(runDir, 'paper', 'figures')
    await ensureDir(figuresDir)
    let latexIncludes = ''
    let feedback: string | undefined
    for (let attempt = 0; attempt <= MAX_FIGURE_RETRIES; attempt += 1) {
      const result = await this.provider.run('figure-generator', {
        runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText, plan: feedback,
      }, context)
      const structured = result.structured as { scripts?: Record<string, string>; latexIncludes?: string } | undefined
      latexIncludes = structured?.latexIncludes ?? ''
      const errors: string[] = []
      for (const [name, content] of Object.entries(structured?.scripts ?? {})) {
        const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, '_')
        const scriptPath = join(figuresDir, safe)
        await writeText(scriptPath, content)
        if (safe.endsWith('.py')) {
          const run = spawnSync('python', [scriptPath], { cwd: figuresDir, encoding: 'utf8' })
          if (run.status !== 0) errors.push(`${safe}: ${(run.stderr ?? run.stdout ?? '').slice(0, 500)}`)
        }
      }
      if (errors.length === 0) break
      feedback = `Fix figure errors:\n${errors.join('\n')}`
    }
    await writeText(join(figuresDir, 'latex_includes.tex'), latexIncludes || '% No generated figures.\n')
    return latexIncludes
  }

  private async write(ctx: PaperContext, feedback?: string): Promise<void> {
    const result = await this.provider.run('writer', {
      runDir: ctx.runDir,
      evidenceChainPath: ctx.evidencePath,
      paperPlan: ctx.planText,
      paperMatrix: ctx.matrixText,
      paperContract: ctx.contractText || undefined,
      paperFigures: ctx.figuresLatex || undefined,
      styleProfile: ctx.styleProfile,
      paperTemplate: await this.readTemplate(ctx.runDir, 'iclr2026.tex'),
      plan: feedback,
    }, ctx.context)
    const value = result.structured as { mainTex?: string; bib?: string; sections?: Record<string, string> } | undefined
    if (!value?.mainTex) throw new Error('writer did not return mainTex')
    await writeFile(join(ctx.paperDir, 'main.tex'), value.mainTex, 'utf8')
    if (value.bib) await writeFile(join(ctx.paperDir, 'references.bib'), value.bib, 'utf8')
    for (const [name, content] of Object.entries(value.sections ?? {})) {
      const file = join(ctx.paperDir, name)
      await ensureDir(dirname(file))
      await writeFile(file, content, 'utf8')
    }
    await Promise.all([
      writeFile(join(ctx.paperDir, 'math_commands.tex'), await this.readTemplate(ctx.runDir, 'math_commands.tex'), 'utf8'),
      writeFile(join(ctx.paperDir, 'iclr2026_conference.sty'), await this.readTemplate(ctx.runDir, 'iclr2026_conference.sty'), 'utf8'),
      writeFile(join(ctx.paperDir, 'iclr2026_conference.bst'), await this.readTemplate(ctx.runDir, 'iclr2026_conference.bst'), 'utf8'),
    ])
    const bib = await readText(join(ctx.paperDir, 'references.bib')).catch(() => '')
    if (bib) await downloadReferencePdfs(ctx.runDir, bib)
  }

  private async audit(ctx: PaperContext): Promise<Record<string, unknown>> {
    const base: RoleInput = {
      runDir: ctx.runDir, paperPath: ctx.paperDir, evidenceChainPath: ctx.evidencePath, assurance: this.resolveAssurance(),
    }
    const specs = [
      ['proof', 'proof-checker', 'PROOF_AUDIT.json'],
      ['claim', 'claim-auditor', 'PAPER_CLAIM_AUDIT.json'],
      ['citation', 'citation-auditor', 'CITATION_AUDIT.json'],
      ['kill', 'kill-argument-reviewer', 'KILL_ARGUMENT.json'],
    ] as const

    const audits: Record<string, unknown> = {}
    const missing: Array<typeof specs[number]> = []
    for (const spec of specs) {
      const [name, , file] = spec
      const path = join(ctx.paperDir, file)
      try {
        audits[name] = JSON.parse(await readText(path))
      } catch {
        missing.push(spec)
      }
    }

    const settled = await Promise.allSettled(missing.map(([, role]) => this.provider.run(role, { ...base }, ctx.context)))
    await Promise.all(settled.map(async (result, i) => {
      const spec = missing[i]
      if (!spec) return
      const [name, , file] = spec
      if (result.status === 'fulfilled') {
        const structured = result.value.structured as { json?: string; verdict?: string } | undefined
        try {
          audits[name] = structured?.json ? JSON.parse(structured.json) : { verdict: structured?.verdict ?? 'ERROR', raw: result.value.text }
        } catch {
          audits[name] = { verdict: structured?.verdict ?? 'ERROR', raw: result.value.text }
        }
      } else {
        audits[name] = { verdict: 'ERROR', error: String(result.reason) }
      }
      await writeText(join(ctx.paperDir, file), JSON.stringify(audits[name], null, 2))
    }))

    const tree = await ResearchTree.load(ctx.runDir)
    audits.basic = await auditPaper(ctx.runDir, tree.query({ kind: 'evidence' }).map((e) => `E-${e.id}`))
    return audits
  }

  private async improve(ctx: PaperContext, cp: PaperCheckpoint): Promise<void> {
    const total = this.options.maxImprovementRounds ?? 2
    const log: string[] = []
    for (let round = (cp.data.improvementRounds ?? 0) + 1; round <= total; round += 1) {
      const review = await this.provider.run('paper-reviewer', {
        runDir: ctx.runDir, paperPath: ctx.paperDir, evidenceChainPath: ctx.evidencePath,
      }, ctx.context)
      const r = review.structured as { score?: number; critical?: string[]; major?: string[]; minor?: string[] } | undefined
      const feedback = [
        ...(r?.critical ?? []).map((x) => `CRITICAL: ${x}`),
        ...(r?.major ?? []).map((x) => `MAJOR: ${x}`),
        ...(r?.minor ?? []).map((x) => `MINOR: ${x}`),
      ].join('\n')
      await this.write(ctx, feedback)
      const compile = await compilePaper(ctx.paperDir)
      if (compile.ok && existsSync(join(ctx.paperDir, 'main.pdf'))) {
        await copyFile(join(ctx.paperDir, 'main.pdf'), join(ctx.paperDir, `main_round${round}.pdf`))
      }
      log.push(`## Round ${round}\n\nScore: ${r?.score ?? 'N/A'}\n\n${feedback}\n`)
      cp.data.improvementRounds = round
      await saveCheckpoint(ctx.paperDir, cp)
    }
    const existing = await readText(join(ctx.paperDir, 'PAPER_IMPROVEMENT_LOG.md')).catch(() => '')
    await writeText(join(ctx.paperDir, 'PAPER_IMPROVEMENT_LOG.md'), `${existing}${log.join('\n')}`)
  }

  private async report(ctx: PaperContext, assurance: string, compileOk: boolean, audits: Record<string, unknown>): Promise<string> {
    const report = `# FINAL_REPORT — Paper Writing Pipeline Report

**Input**: ${ctx.runDir}
**Venue**: ${this.options.venue ?? DEFAULT_VENUE}
**Assurance**: ${assurance}
**Submission-ready**: ${compileOk ? 'yes' : 'no'}
**Forensics**: ${assurance === 'submission' ? 'WARN' : 'skipped (draft)'}
**Date**: ${new Date().toISOString()}

## Pipeline Summary

| Phase | Status | Output |
|-------|--------|--------|
| 0. Assurance Setup | ✅ | paper/.aris/assurance.txt |
| 1. Paper Plan | ✅ | PAPER_PLAN.md |
| 1.5 Acceptance Contract | ✅ | PAPER_ACCEPTANCE_CONTRACT.md |
| 2. Figures | ✅ | paper/figures/ |
| 3. LaTeX Writing | ✅ | paper/main.tex |
| 4. Compilation | ${compileOk ? '✅' : '❌'} | paper/main.pdf |
| 5. Improvement | ✅ | PAPER_IMPROVEMENT_LOG.md |

## Audit Summary

\`\`\`json
${JSON.stringify(audits, null, 2)}
\`\`\`

## Deliverables

- paper/main.pdf
- paper/PAPER_PLAN.md
- paper/claims_evidence_matrix.json
- paper/PAPER_ACCEPTANCE_CONTRACT.md
- paper/PAPER_IMPROVEMENT_LOG.md
`
    await writeText(join(ctx.runDir, 'FINAL_REPORT.md'), report)
    return report
  }

  private async readStyleProfile(runDir: string): Promise<string | undefined> {
    for (const file of [join(runDir, 'style_profile.md'), join(runDir, 'paper', 'style_profile.md')]) {
      if (existsSync(file)) return readText(file)
    }
    return undefined
  }

  private async readTemplate(runDir: string, name: string): Promise<string> {
    const local = join(runDir, 'paper', name)
    if (existsSync(local)) return readText(local)
    return readFile(new URL(`../../templates/${name}`, import.meta.url), 'utf8')
  }
}
