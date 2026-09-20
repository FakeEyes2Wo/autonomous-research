import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { PaperImageReceipt } from '../agents/types.js'
import type { PaperContext } from './context.js'
import type { PaperCheckpoint } from './checkpoint.js'
import { invalidatePaperCheckpoint, saveCheckpoint } from './checkpoint.js'
import { compilePaper } from './index.js'
import { readPaperSources } from './audit.js'
import { resolvePaperSources } from './sources.js'
import { paperAuditStatus, resolveAssurance, runPaperAudits, writePaper } from './phases.js'
import { admitPaperReview, bindPaperArtifacts, deterministicPaperIssues, evaluatePaperGate, normalizePaperReview, paperHash, samePaperBinding, type PaperFinalGate, type PaperReviewResult, type PaperReviewRole } from './review-protocol.js'

export async function paperReviewRequirements(paperDir: string): Promise<{ sources: string[]; requiredRoles: PaperReviewRole[] }> {
  const sources = (await readPaperSources(paperDir)).map(p => relative(paperDir, p).replaceAll('\\', '/'))
  const figureFiles = await readdir(join(paperDir, 'figures')).catch(() => [])
  const dependencies = await resolvePaperSources(paperDir)
  const text = (await Promise.all(dependencies.filter(file => file.kind === 'manuscript').map(file => readFile(file.path, 'utf8')))).join('\n')
  const requiredRoles: PaperReviewRole[] = ['paper-contract-reviewer', 'layout-reviewer', 'paper-reviewer']
  if (figureFiles.some(name => /\.(png|jpe?g|webp|gif|pdf|svg|eps)$/i.test(name)) || /\\includegraphics|\\begin\{figure\*?\}/.test(text)) requiredRoles.unshift('figure-reviewer')
  return { sources, requiredRoles }
}

export async function reviewCompiledPaper(ctx: PaperContext, cp: PaperCheckpoint): Promise<PaperFinalGate> {
  if (!ctx.layout || !cp.data.reviewBudget) throw new Error('paper review requires prepared layout and host budget')
  const layout = ctx.layout, budget = cp.data.reviewBudget
  const save = () => saveCheckpoint(ctx.paths.paperDir, cp)
  while (true) {
    cp.data.submissionReady = false
    cp.data.audits = {}
    cp.data.auditStatus = 'failed'
    delete cp.data.auditBinding
    await save()
    // No cached compile is accepted after a mutation, including a polisher or human edit.
    const compile = await compilePaper(ctx.paths.paperDir, { layout, inspect: ctx.deps.options.layoutInspection !== false })
    cp.data.compile = compile
    cp.data.compileOk = compile.ok
    cp.phases.compile = compile.ok ? 'done' : 'failed'
    const inspection = compile.inspection
    const binding = await bindPaperArtifacts(ctx.paths.paperDir, ctx.content.evidencePath, layout, inspection)
    cp.data.binding = binding
    cp.data.reviews = {}
    const deterministic = deterministicPaperIssues(compile, inspection)
    if (compile.sourceHash !== binding.sourceHash || inspection && inspection.pdfHash !== binding.pdfHash) deterministic.push({ verdict: 'BLOCKED', detail: 'Artifacts changed during compilation/inspection.' })
    await save()

    let audits: Record<string, unknown> = {}
    const reviews: PaperReviewResult[] = []
    let requiredRoles: PaperReviewRole[] = ['paper-contract-reviewer', 'layout-reviewer', 'paper-reviewer']
    let sources: string[] = []
    if (compile.ok) {
      try { ({ sources, requiredRoles } = await paperReviewRequirements(ctx.paths.paperDir)) } catch (error) { deterministic.push({ verdict: 'BLOCKED', detail: String(error) }) }
    }

    // Resolve deterministic defects before paying for probabilistic reviews.
    if (deterministic.length === 0) {
      const revision = `${paperHash(binding).slice(0, 20)}:${budget.sequence++}`
      await save()
      audits = await runPaperAudits(ctx, revision)
      cp.data.audits = audits
      cp.data.auditStatus = paperAuditStatus(audits)
      cp.data.auditBinding = binding
      cp.phases.audits = cp.data.auditStatus === 'passed' ? 'done' : 'failed'
      await save()
      for (const role of requiredRoles) {
        const images = role === 'layout-reviewer' || role === 'figure-reviewer' ? inspection!.pages.map(p => p.imagePath) : []
        let candidate: unknown
        let verifiedReceipt: PaperImageReceipt | undefined
        let capability: PaperReviewResult['capability'] = { visual: 'machine-only', notes: 'No verified native image receipt.' }
        try {
          await admitPaperReview(budget, save)
          const taskId = `paper-review:${role}:${paperHash(binding).slice(0, 20)}:${budget.sequence}`
          const result = await ctx.deps.provider.run(role, {
            runDir: ctx.paths.runDir, paperPath: ctx.paths.paperDir, taskId,
            evidenceChainPath: ctx.content.evidencePath,
            paperPlan: await readFile(join(ctx.paths.paperDir, 'PAPER_PLAN.md'), 'utf8'),
            paperMatrix: await readFile(join(ctx.paths.paperDir, 'claims_evidence_matrix.json'), 'utf8'),
            paperContract: await readFile(join(ctx.paths.paperDir, 'PAPER_ACCEPTANCE_CONTRACT.md'), 'utf8'),
            paperLayout: JSON.stringify(layout.profile),
            paperReviewContext: JSON.stringify({ binding, budget, sources, compile: { diagnostics: compile.diagnostics, geometry: compile.geometry }, inspection, visualRequired: images.length > 0 }),
            ...(images.length ? { figureImages: images } : {}), supportsImageInput: ctx.deps.options.supportsImageInput,
            assurance: resolveAssurance(ctx.deps.options),
          }, { ...ctx.agentContext, admitPaperReviewRepair: () => admitPaperReview(budget, save) })
          candidate = result.structured
          const receipt = result.imageReceipt
          if (ctx.deps.options.supportsImageInput !== false && images.length && receipt?.role === role && receipt.taskId === taskId && receipt.provider && receipt.model && receipt.images.length === images.length) {
            let complete = true
            for (const path of images) {
              const entry = receipt.images.find(i => i.path === path)
              if (!entry?.attachmentId || entry.hash !== paperHash(await readFile(path))) complete = false
            }
            if (complete) {
              capability = { visual: 'actual', notes: `Host native attachment receipts cover ${images.length} images for ${taskId}.` }
              verifiedReceipt = receipt
            }
          }
          // Model tool policy is enforced by native transport; independently detect any provider-side mutation.
          if (!samePaperBinding(binding, await bindPaperArtifacts(ctx.paths.paperDir, ctx.content.evidencePath, layout, inspection))) throw new Error('read-only review mutated its bound artifacts')
        } catch (error) {
          candidate = { verdict: 'BLOCKED', issues: [{ severity: 'major', code: 'REVIEW_UNAVAILABLE', detail: String(error), repair: 'Resolve the failure and resume with remaining budget.' }] }
          capability = { visual: 'unavailable', notes: String(error) }
        }
        const review = normalizePaperReview(candidate, { role, binding, capability, budget: { used: budget.used, limit: budget.limit, progress: true }, sources, pages: inspection?.pages.map(p => p.page) ?? [], visualRequired: role === 'layout-reviewer' || role === 'figure-reviewer' })
        if (verifiedReceipt) review.imageReceipt = verifiedReceipt
        reviews.push(review); cp.data.reviews[role] = review
        await save()
        if (review.verdict === 'BLOCKED') break
      }
    }
    const gate = evaluatePaperGate({ assurance: resolveAssurance(ctx.deps.options), deterministic, audits, reviews, requiredRoles, binding })
    cp.data.gate = gate
    cp.data.submissionReady = gate.submissionReady
    await save()
    if (gate.verdict === 'PASS' || gate.verdict === 'BLOCKED') return gate
    const progress = paperHash({ source: binding.sourceHash, evidence: binding.evidenceHash, issues: reviews.flatMap(r => r.issues.map(i => i.id)), deterministic })
    if (budget.rounds >= budget.maxRounds || budget.used >= budget.limit || cp.data.progressMarker === progress) {
      gate.verdict = 'BLOCKED'; gate.reasons.push('Repair budget exhausted or no progress; edit the artifacts and resume.')
      await save(); return gate
    }
    cp.data.progressMarker = progress
    budget.rounds++
    await admitPaperReview(budget, save)
    invalidatePaperCheckpoint(cp, 'Review requested source repair')
    await save()
    await writePaper({ ...ctx, agentContext: { ...ctx.agentContext, admitPaperReviewRepair: () => admitPaperReview(budget, save) } }, JSON.stringify({ deterministic, academicAudits: audits, reviews }, null, 2))
    const after = await bindPaperArtifacts(ctx.paths.paperDir, ctx.content.evidencePath, layout, inspection)
    if (after.sourceHash === binding.sourceHash && after.evidenceHash === binding.evidenceHash) {
      cp.data.gate = { verdict: 'BLOCKED', submissionReady: false, reasons: ['Writer repair made no progress.'] }
      for (const review of reviews) review.budget.progress = false
      cp.data.reviews = Object.fromEntries(reviews.map(review => [review.role, review]))
      await save(); return cp.data.gate
    }
    // The next iteration always reviews the final repair, even at the last allowed round.
  }
}
