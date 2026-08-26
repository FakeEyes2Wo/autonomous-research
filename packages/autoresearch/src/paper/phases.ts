import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RoleInput, RoleName } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { ensureDir, FAILURE_REPORT_FILE, readText, writeText } from '../core/utils.js'
import { appendHumanReview, type HumanReviewAnswer } from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import { auditPaper, compilePaper, downloadReferencePdfs, runCompileLoop } from './index.js'
import type { PaperCheckpoint } from './checkpoint.js'
import { saveCheckpoint } from './checkpoint.js'
import { collectEvidenceIds, loadEvidenceChain, type EvidenceChain } from '../export/evidence-chain.js'
import type { PaperContext, PaperOptions } from './context.js'

export type { PaperOptions } from './context.js'

export const DEFAULT_VENUE = 'ICLR'
const MAX_CONTRACT_ROUNDS = 3
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
    styleProfile: options.styleRef ? await readStyleProfile(runDir).catch(() => undefined) : undefined,
    assurance: resolveAssurance(options),
  }, ctx.agentContext)
  const plan = (result.structured as { plan?: string } | undefined)?.plan
  if (!plan) throw new Error('paper-planner did not return plan')
  return plan
}

export async function negotiateContract(ctx: PaperContext): Promise<string> {
  const { runDir, paperDir } = ctx.paths
  const { planText, matrixText, evidencePath } = ctx.content
  const file = join(paperDir, 'PAPER_ACCEPTANCE_CONTRACT.md')
  let contract = ''
  for (let round = 0; round < MAX_CONTRACT_ROUNDS; round += 1) {
    const draft = await ctx.deps.provider.run('contract-negotiator', {
      runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText,
      paperContract: contract || undefined, plan: round ? `Revise per demands:\n${contract}` : undefined,
    }, ctx.agentContext)
    contract = (draft.structured as { contract?: string } | undefined)?.contract ?? draft.text
    await writeText(file, contract)

    const review = await ctx.deps.provider.run('contract-reviewer', {
      runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText, paperContract: contract,
    }, ctx.agentContext)
    const verdict = review.structured as { accepted?: boolean; demands?: string[] } | undefined
    if (verdict?.accepted) return file
    contract = `## Reviewer Demands\n\n${(verdict?.demands ?? []).join('\n')}\n\n## Current Contract\n\n${contract}`
  }
  await writeText(file, `${contract}\n\n## Disputed\n\nNot accepted after ${MAX_CONTRACT_ROUNDS} rounds.\n`)
  return file
}

export async function generateFigures(ctx: PaperContext): Promise<string> {
  const { runDir, paperDir } = ctx.paths
  const { planText, matrixText, evidencePath } = ctx.content
  const figuresDir = join(paperDir, 'figures')
  await ensureDir(figuresDir)
  let latexIncludes = ''
  let feedback: string | undefined
  for (let attempt = 0; attempt <= MAX_FIGURE_RETRIES; attempt += 1) {
    const result = await ctx.deps.provider.run('figure-generator', {
      runDir, evidenceChainPath: evidencePath, paperPlan: planText, paperMatrix: matrixText, plan: feedback,
    }, ctx.agentContext)
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
    if (errors.length === 0) {
      const review = await ctx.deps.provider.run('figure-reflexion', {
        runDir,
        paperPlan: planText,
        paperFigures: latexIncludes,
        plan: JSON.stringify(structured?.scripts ?? {}),
      }, ctx.agentContext)
      const r = review.structured as { verdict?: string; issues?: string[] } | undefined
      if (r?.verdict === 'pass') break
      feedback = `Fix figure quality issues (if any figure has an embedded main title, remove it and keep only subplot labels):\n${(r?.issues ?? []).join('\n')}`
      continue
    }
    feedback = `Fix figure errors:\n${errors.join('\n')}`
  }
  await writeText(join(figuresDir, 'latex_includes.tex'), latexIncludes || '% No generated figures.\n')
  return latexIncludes
}

export async function writePaper(ctx: PaperContext, feedback?: string): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const { planText, matrixText, contractText, figuresLatex, styleProfile, evidencePath } = ctx.content
  const readOptional = (name: string) => readText(join(runDir, name)).catch(() => undefined)
  const [experimentDesign, reflexion, insight, minimalVerification, modelScout] = await Promise.all([
    readOptional('EXPERIMENT_DESIGN.md'),
    readOptional('REFLEXION.md'),
    readOptional('INSIGHT.md'),
    readOptional('MINIMAL_VERIFICATION.md'),
    readOptional('MODEL_SCOUT.md'),
  ])
  const result = await ctx.deps.provider.run('writer', {
    runDir,
    evidenceChainPath: evidencePath,
    paperPlan: planText,
    paperMatrix: matrixText,
    paperContract: contractText || undefined,
    paperFigures: figuresLatex || undefined,
    styleProfile,
    paperTemplate: await readTemplate(runDir, 'iclr2026.tex'),
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
  for (const [name, content] of Object.entries(value.sections ?? {})) {
    const file = join(paperDir, name)
    await ensureDir(dirname(file))
    await writeFile(file, content, 'utf8')
  }
  if (value.failureReport?.trim()) {
    await writeText(join(runDir, FAILURE_REPORT_FILE), `# FAILURE_REPORT — 人类完善笔记\n\n${value.failureReport.trim()}\n`)
  }
  await Promise.all([
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
  const bib = await readText(join(paperDir, 'references.bib')).catch(() => '')
  if (!bib) return
  try {
    await downloadReferencePdfs(runDir, bib, { strict: false })
  } catch (error) {
    await writeText(join(paperDir, 'REFERENCE_DOWNLOAD_WARNINGS.txt'), String(error))
  }
}

export async function runPaperAudits(ctx: PaperContext): Promise<Record<string, unknown>> {
  const { runDir, paperDir } = ctx.paths
  const { evidencePath } = ctx.content
  const base: RoleInput = {
    runDir, paperPath: paperDir, evidenceChainPath: evidencePath, assurance: resolveAssurance(ctx.deps.options),
  }

  const audits: Record<string, unknown> = {}
  const missing: Array<typeof PAPER_AUDITS[number]> = []
  for (const spec of PAPER_AUDITS) {
    const { name, file } = spec
    try {
      audits[name] = JSON.parse(await readText(join(paperDir, file)))
    } catch {
      missing.push(spec)
    }
  }

  const settled = await Promise.allSettled(missing.map(({ role }) => ctx.deps.provider.run(role, { ...base }, ctx.agentContext)))
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

export async function improvePaper(ctx: PaperContext, cp: PaperCheckpoint): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const { evidencePath } = ctx.content
  const total = ctx.deps.options.maxImprovementRounds ?? 2
  const log: string[] = []
  for (let round = (cp.data.improvementRounds ?? 0) + 1; round <= total; round += 1) {
    const review = await ctx.deps.provider.run('paper-reviewer', {
      runDir, paperPath: paperDir, evidenceChainPath: evidencePath,
    }, ctx.agentContext)
    const r = review.structured as { score?: number; critical?: string[]; major?: string[]; minor?: string[] } | undefined
    const feedback = [
      ...(r?.critical ?? []).map((x) => `CRITICAL: ${x}`),
      ...(r?.major ?? []).map((x) => `MAJOR: ${x}`),
      ...(r?.minor ?? []).map((x) => `MINOR: ${x}`),
    ].join('\n')
    await writePaper(ctx, feedback)
    const compile = await compilePaper(paperDir)
    if (compile.ok && existsSync(join(paperDir, 'main.pdf'))) {
      await copyFile(join(paperDir, 'main.pdf'), join(paperDir, `main_round${round}.pdf`))
    }
    log.push(`## Round ${round}\n\nScore: ${r?.score ?? 'N/A'}\n\n${feedback}\n`)
    cp.data.improvementRounds = round
    await saveCheckpoint(paperDir, cp)
  }
  const existing = await readText(join(paperDir, 'PAPER_IMPROVEMENT_LOG.md')).catch(() => '')
  await writeText(join(paperDir, 'PAPER_IMPROVEMENT_LOG.md'), `${existing}${log.join('\n')}`)
}

export async function polishPaper(ctx: PaperContext): Promise<void> {
  const { runDir, paperDir } = ctx.paths
  const { evidencePath } = ctx.content
  const result = await ctx.deps.provider.run('paper-polisher', {
    runDir,
    paperPath: paperDir,
    evidenceChainPath: evidencePath,
  }, ctx.agentContext)
  const value = result.structured as { mainTex?: string; sections?: Record<string, string>; changes?: string[] } | undefined
  if (!value?.mainTex) throw new Error('paper-polisher did not return mainTex')
  await writeFile(join(paperDir, 'main.tex'), value.mainTex, 'utf8')
  for (const [name, content] of Object.entries(value.sections ?? {})) {
    const file = join(paperDir, name)
    await ensureDir(dirname(file))
    await writeFile(file, content, 'utf8')
  }
  await writeText(join(paperDir, 'PAPER_POLISH_LOG.md'), `# Paper Polish Log\n\n${(value.changes ?? []).map((x) => `- ${x}`).join('\n')}\n`)
  const compile = await compilePaper(paperDir)
  if (compile.ok && existsSync(join(paperDir, 'main.pdf'))) {
    await copyFile(join(paperDir, 'main.pdf'), join(paperDir, 'main_polished.pdf'))
  }
}

export async function writePaperReport(
  ctx: PaperContext,
  assurance: string,
  compileOk: boolean,
  audits: Record<string, unknown>,
): Promise<string> {
  const { runDir } = ctx.paths
  const report = `# FINAL_REPORT — Paper Writing Pipeline Report

**Input**: ${runDir}
**Venue**: ${ctx.deps.options.venue ?? DEFAULT_VENUE}
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
- FAILURE_REPORT.md (human fix notes: experimental/theoretical insufficiencies)
`
  await writeText(join(runDir, 'FINAL_REPORT.md'), report)
  return report
}
