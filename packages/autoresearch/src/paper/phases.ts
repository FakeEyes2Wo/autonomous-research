import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RoleInput, RoleName } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { ensureDir, FAILURE_REPORT_FILE, readOptionalText, readText, writeText } from '../core/utils.js'
import { appendHumanReview, type HumanReviewAnswer } from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import { auditPaper, downloadReferencePdfs, runCompileLoop } from './index.js'
import { writeFailureReflexion } from '../core/failure-reflexion.js'
import { collectEvidenceIds, loadEvidenceChain, type EvidenceChain } from '../export/evidence-chain.js'
import type { PaperContext, PaperOptions } from './context.js'
import { readPaperSources } from './audit.js'

export type { PaperOptions } from './context.js'

export const DEFAULT_VENUE = 'ICLR'
const MAX_FIGURE_RETRIES = 2

export const PAPER_AUDITS = [
  { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
  { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
  { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
  { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
] as const satisfies readonly { name: string; role: RoleName; file: string }[]

export function resolveAssurance(options: Readonly<PaperOptions>): 'draft' | 'submission' {
  const { assurance, effort } = options
  if (assurance === 'draft' || assurance === 'submission') return assurance
  return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
}

export function hasStyleRef(options: Readonly<PaperOptions>): boolean {
  return Boolean(options.styleRef)
}

async function writePaperSections(paperDir: string, sections?: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(sections ?? {})) {
    const file = join(paperDir, name)
    await ensureDir(dirname(file))
    await writeFile(file, content, 'utf8')
  }
}

export async function readStyleProfile(runDir: string): Promise<string | undefined> {
  for (const file of [join(runDir, 'style_profile.md'), join(runDir, 'paper', 'style_profile.md')]) {
    if (existsSync(file)) return readText(file)
  }
  return undefined
}

async function readTemplate(runDir: string, name: string): Promise<string> {
  const local = join(runDir, 'paper', name)
  if (existsSync(local)) return readText(local)
  return readFile(new URL(`../../templates/${name}`, import.meta.url), 'utf8')
}

export async function planPaper(ctx: PaperContext): Promise<string> {
  const { runDir } = ctx.paths
  const { evidencePath, matrixText } = ctx.content
  const options = ctx.deps.options
  const result = await ctx.deps.provider.run('paper-planner', {
    runDir,
    evidenceChainPath: evidencePath,
    paperMatrix: matrixText,
    venue: options.venue ?? DEFAULT_VENUE,
    paperLayout: ctx.layout ? JSON.stringify(ctx.layout.profile) : undefined,
    styleProfile: options.styleRef ? await readStyleProfile(runDir).catch(() => undefined) : undefined,
    assurance: resolveAssurance(options),
  }, ctx.agentContext)
  const plan = (result.structured as { plan?: string } | undefined)?.plan
  if (!plan) throw new Error('paper-planner did not return plan')
  return plan
}

export async function negotiateContract(ctx: PaperContext): Promise<string> {
  const file = join(ctx.paths.paperDir, 'PAPER_ACCEPTANCE_CONTRACT.md')
  const result = await ctx.deps.provider.run('contract-negotiator', {
    runDir: ctx.paths.runDir, evidenceChainPath: ctx.content.evidencePath,
    paperPlan: ctx.content.planText, paperMatrix: ctx.content.matrixText,
    paperLayout: ctx.layout ? JSON.stringify(ctx.layout.profile) : undefined,
    venue: ctx.deps.options.venue ?? DEFAULT_VENUE,
  }, ctx.agentContext)
  const contract = (result.structured as { contract?: string })?.contract
  if (!contract) throw new Error('contract-negotiator did not return contract')
  await writeText(file, contract)
  return file
}

export async function generateFigures(ctx: PaperContext): Promise<string> {
  const { runDir, paperDir } = ctx.paths
  const { planText, matrixText, evidencePath } = ctx.content
  const figuresDir = join(paperDir, 'figures')
  await ensureDir(figuresDir)
  let latexIncludes = ''
  let feedback: string | undefined

  const writeAndRun = async (scripts: Record<string, string>): Promise<string[]> => {
    const errors: string[] = []
    for (const [name, content] of Object.entries(scripts)) {
      const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, '_')
      const scriptPath = join(figuresDir, safe)
      await writeText(scriptPath, content)
      if (safe.endsWith('.py')) {
        const run = spawnSync('python', [scriptPath], { cwd: figuresDir, encoding: 'utf8' })
        if (run.status !== 0) errors.push(`${safe}: ${(run.stderr ?? run.stdout ?? '').slice(0, 500)}`)
      }
    }
    return errors
  }

  const runFigure = async (input: RoleInput) => {
    try {
      return await ctx.deps.provider.run('figure-generator', input, ctx.agentContext)
    } catch (error) {
      await writeFailureReflexion(runDir, {
        role: 'figure-generator',
        stage: 'paper-figure',
        round: 0,
        stopReason: 'agent_error',
        error: error instanceof Error ? error.message : String(error),
        context: input,
      })
      throw error
    }
  }

  for (let attempt = 0; attempt <= MAX_FIGURE_RETRIES; attempt += 1) {
    const result = await runFigure({
      runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText, plan: feedback, paperLayout: ctx.layout ? JSON.stringify(ctx.layout.profile) : undefined,
    })
    const structured = result.structured as { scripts?: Record<string, string>; latexIncludes?: string } | undefined
    latexIncludes = structured?.latexIncludes ?? ''
    const errors = await writeAndRun(structured?.scripts ?? {})
    if (errors.length > 0) {
      feedback = `Fix figure errors:\n${errors.join('\n')}`
      if (attempt === MAX_FIGURE_RETRIES) throw new Error(feedback)
      continue
    }

    break
  }

  await writeText(join(figuresDir, 'latex_includes.tex'), latexIncludes || '% No generated figures.\n')
  return latexIncludes
}

export async function writePaper(ctx: PaperContext, feedback?: string): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const { planText, matrixText, contractText, figuresLatex, styleProfile, evidencePath } = ctx.content
  const [experimentDesign, reflexion, insight, minimalVerification, modelScout] = await Promise.all([
    readOptionalText(join(runDir, 'EXPERIMENT_DESIGN.md')),
    readOptionalText(join(runDir, 'REFLEXION.md')),
    readOptionalText(join(runDir, 'INSIGHT.md')),
    readOptionalText(join(runDir, 'MINIMAL_VERIFICATION.md')),
    readOptionalText(join(runDir, 'MODEL_SCOUT.md')),
  ])
  const result = await ctx.deps.provider.run('writer', {
    runDir,
    evidenceChainPath: evidencePath,
    paperPlan: planText,
    paperMatrix: matrixText,
    paperContract: contractText || undefined,
    paperFigures: figuresLatex || undefined,
    styleProfile,
    paperTemplate: ctx.layout ? await readText(ctx.layout.templateFile) : await readTemplate(runDir, 'iclr2026.tex'),
    paperLayout: ctx.layout ? JSON.stringify(ctx.layout.profile) : undefined,
    plan: feedback,
    ...(experimentDesign ? { experimentDesign } : {}),
    ...(reflexion ? { reflexion } : {}),
    ...(insight ? { insight } : {}),
    ...(minimalVerification ? { minimalVerification } : {}),
    ...(modelScout ? { modelScout } : {}),
  }, ctx.agentContext)
  const value = result.structured as { mainTex?: string; bib?: string; sections?: Record<string, string>; failureReport?: string } | undefined
  if (!value?.mainTex) throw new Error('writer did not return mainTex')
  await writeFile(join(paperDir, 'main.tex'), value.mainTex, 'utf8')
  if (value.bib) await writeFile(join(paperDir, 'references.bib'), value.bib, 'utf8')
  await writePaperSections(paperDir, value.sections)
  if (value.failureReport?.trim()) {
    await writeText(join(runDir, FAILURE_REPORT_FILE), `# FAILURE_REPORT — 人类完善笔记\n\n${value.failureReport.trim()}\n`)
  }
  if (!ctx.layout) await Promise.all([
    writeFile(join(paperDir, 'math_commands.tex'), await readTemplate(runDir, 'math_commands.tex'), 'utf8'),
    writeFile(join(paperDir, 'iclr2026_conference.sty'), await readTemplate(runDir, 'iclr2026_conference.sty'), 'utf8'),
    writeFile(join(paperDir, 'iclr2026_conference.bst'), await readTemplate(runDir, 'iclr2026_conference.bst'), 'utf8'),
  ])
}

export async function reviewPaperDraft(ctx: PaperContext): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const options = ctx.deps.options
  const reviewer = options.humanReviewer
  if (!reviewer || !(await humanReviewEnabled(options.humanReviewOverride))) {
    await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'paper_draft', verdict: 'skipped', feedback: 'auto mode or no reviewer' })
    return
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const detail = [
      `# Paper draft review`,
      '',
      `Compiled draft: ${join(paperDir, 'main.pdf')}`,
      `LaTeX source: ${join(paperDir, 'main.tex')}`,
      `Human fix notes: ${join(runDir, FAILURE_REPORT_FILE)}`,
    ].join('\n')
    let answer: HumanReviewAnswer
    try {
      answer = await reviewer.ask({ gate: 'paper_draft', title: 'Paper draft is ready to proceed?', detail }, ctx.agentContext.signal, ctx.agentContext.parent)
    } catch (error) {
      await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'paper_draft', verdict: 'skipped', feedback: `ask failed: ${String(error)}` })
      return
    }
    await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'paper_draft', verdict: answer.verdict, feedback: answer.feedback })
    if (answer.verdict === 'approve') return
    if (answer.verdict === 'reject') {
      throw new Error(`paper draft rejected by human review: ${answer.feedback ?? 'no feedback'}`)
    }
    // revise: apply feedback through the writer and compile loop.
    await writePaper(ctx, `Human review feedback:\n${answer.feedback ?? 'revise the draft'}`)
    const compile = await runCompileLoop(ctx.paths.paperDir, (feedback) => writePaper(ctx, feedback))
    if (!compile.ok) throw new Error(`paper draft compile failed after human revision: ${compile.rounds} rounds`)
  }
  throw new Error('paper draft human review did not converge after 5 attempts')
}

export async function enrichReferences(ctx: PaperContext): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  // PDFs are only supplementary reference material. Download failures are
  // recorded but never treated as citation failures.
  const bib = (await readOptionalText(join(paperDir, 'references.bib'))) ?? ''
  if (!bib) return
  try {
    await downloadReferencePdfs(runDir, bib, { strict: false })
  } catch (error) {
    await writeText(join(paperDir, 'REFERENCE_DOWNLOAD_WARNINGS.txt'), String(error))
  }
}

export async function runPaperAudits(ctx: PaperContext, revision?: string): Promise<Record<string, unknown>> {
  const { runDir, paperDir } = ctx.paths
  const { evidencePath } = ctx.content
  const base: RoleInput = {
    runDir, paperPath: paperDir, evidenceChainPath: evidencePath, assurance: resolveAssurance(ctx.deps.options),
    paperReviewContext: JSON.stringify({ manuscriptSources: await readPaperSources(paperDir), instruction: 'Audit these actual manuscript dependencies; unused venue example documents are not manuscript content.' }),
  }

  const audits: Record<string, unknown> = {}
  const missing: Array<typeof PAPER_AUDITS[number]> = []
  for (const spec of PAPER_AUDITS) {
    const { name, file } = spec
    try {
      if (revision) throw new Error('version-bound audit refresh')
      audits[name] = JSON.parse(await readText(join(paperDir, file)))
    } catch {
      missing.push(spec)
    }
  }

  const settled = await Promise.allSettled(missing.map(({ role }) => ctx.deps.provider.run(role, { ...base, ...(revision ? { taskId: `paper-audit:${role}:${revision}` } : {}) }, ctx.agentContext)))
  await Promise.all(settled.map(async (result, i) => {
    const spec = missing[i]
    if (!spec) return
    const { name, file } = spec
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
    await writeText(join(paperDir, file), JSON.stringify(audits[name], null, 2))
  }))

  let chain: EvidenceChain | undefined
  try {
    chain = await loadEvidenceChain(runDir)
  } catch {
    chain = undefined
  }
  if (chain) {
    audits.basic = await auditPaper({ runDir, chain })
  } else {
    const tree = await ResearchTree.load(runDir)
    audits.basic = await auditPaper(runDir, collectEvidenceIds(tree))
  }
  return audits
}

/** A single gate used by the pipeline and report; missing/invalid audits fail closed. */
export function paperAuditStatus(audits: Record<string, unknown>): 'passed' | 'failed' {
  for (const { name } of PAPER_AUDITS) {
    const value = audits[name]
    if (!value || typeof value !== 'object') return 'failed'
    const verdict = (value as { verdict?: unknown }).verdict
    if (verdict !== 'PASS' && verdict !== 'NOT_APPLICABLE') return 'failed'
  }
  const basic = audits.basic
  if (!basic || typeof basic !== 'object') return 'failed'
  const result = basic as { numeric?: { ok?: unknown }; citation?: { ok?: unknown } }
  return result.numeric?.ok === true && result.citation?.ok === true ? 'passed' : 'failed'
}


export async function polishPaper(ctx: PaperContext, feedback?: string): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const { evidencePath } = ctx.content
  const result = await ctx.deps.provider.run('paper-polisher', {
    runDir,
    plan: feedback,
    paperLayout: ctx.layout ? JSON.stringify(ctx.layout.profile) : undefined,
    paperPath: paperDir,
    evidenceChainPath: evidencePath,
  }, ctx.agentContext)
  const value = result.structured as { mainTex?: string; sections?: Record<string, string>; changes?: string[] } | undefined
  if (!value?.mainTex) throw new Error('paper-polisher did not return mainTex')
  await writeFile(join(paperDir, 'main.tex'), value.mainTex, 'utf8')
  await writePaperSections(paperDir, value.sections)
  await writeText(join(paperDir, 'PAPER_POLISH_LOG.md'), `# Paper Polish Log\n\n${(value.changes ?? []).map((x) => `- ${x}`).join('\n')}\n`)

}

export async function writePaperReport(
  ctx: PaperContext,
  assurance: string,
  compileOk: boolean,
  audits: Record<string, unknown>,
  auditStatus = paperAuditStatus(audits),
  gate?: import('./review-protocol.js').PaperFinalGate,
  reviewDetails?: unknown,
): Promise<string> {
  const { runDir } = ctx.paths
  const report = `# FINAL_REPORT — Paper Writing Pipeline Report

**Input**: ${runDir}
**Venue**: ${ctx.deps.options.venue ?? DEFAULT_VENUE}
**Assurance**: ${assurance}
**Submission-ready**: ${gate?.submissionReady === true ? 'yes' : 'no'}
**Audit gate**: ${auditStatus}
**Forensics**: ${assurance === 'submission' ? 'WARN' : 'skipped (draft)'}
**Date**: ${new Date().toISOString()}

## Pipeline Summary

| Phase | Status | Output |
|-------|--------|--------|
| 0. Assurance State | ✅ | paper/pipeline_checkpoint.json |
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

## Current Version Review Gate

\`\`\`json
${JSON.stringify({ gate, reviewDetails }, null, 2)}
\`\`\`

Deterministic overfull threshold: greater than 5 PDF points (TeX points converted by 72/72.27) requests repair. Smaller warnings remain review evidence. Bounding boxes cannot establish all visual overlaps; complete native page image delivery and an independent visual verdict remain required.

The persisted paper request budget covers independent reviews, writer repairs and their JSON repairs. Academic proof/claim/citation/kill audits retain the global request ledger limits. Academic source resolution follows literal input/include/subfile and bibliography dependencies; unsupported dynamic/import dependencies block the audit instead of silently omitting content.

## Deliverables

- paper/main.pdf
- paper/PAPER_PLAN.md
- paper/claims_evidence_matrix.json
- paper/PAPER_ACCEPTANCE_CONTRACT.md
- paper/PAPER_IMPROVEMENT_LOG.md
- FAILURE_REPORT.md (human fix notes: experimental/theoretical insufficiencies)
`
  await writeText(join(runDir, 'FINAL_REPORT.md'), report)
  return report
}
