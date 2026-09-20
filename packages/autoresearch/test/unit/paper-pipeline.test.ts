import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const engine = process.env.TECTONIC_PATH ?? 'D:/Tectonic/bin/tectonic.exe'
const realEngine = existsSync(engine)
const manuscript = String.raw`\documentclass{article}
\usepackage{iclr2026_conference,times}
\title{Measured Paper}
\begin{document}
\maketitle
\begin{abstract}A reproducible scientific manuscript.\end{abstract}
\section{Method}Original finding.
\end{document}`

async function pipelineFixture(t: any, options: any = {}, behavior: any = {}) {
  const { runPaperPipeline } = await import('../../dist/paper/pipeline.js')
  const { ResearchTree } = await import('../../dist/core/research-tree.js')
  const { paperHash } = await import('../../dist/paper/review-protocol.js')
  const runDir = await mkdtemp(join(tmpdir(), 'ar-real-paper-gate-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const previous = process.env.TECTONIC_PATH; process.env.TECTONIC_PATH = engine
  t.after(() => { if (previous === undefined) delete process.env.TECTONIC_PATH; else process.env.TECTONIC_PATH = previous })
  const evidencePath = join(runDir, 'evidence_chain.json'); await writeFile(evidencePath, JSON.stringify({ schema: 'autoresearch/evidence-chain/v1', run_id: 'fixture', generated_at: '', hypotheses: [], actions: [], evidence: [] }))
  const calls: string[] = [], observations: string[] = []
  const provider = { async run(role: string, input: any) {
    calls.push(role)
    let structured: any = { verdict: 'PASS', issues: [] }
    if (role === 'paper-planner') structured = { plan: 'A scientific paper.' }
    if (role === 'contract-negotiator') structured = { contract: 'Report only supported findings.' }
    if (role === 'figure-generator') structured = { scripts: {}, latexIncludes: '' }
    if (role === 'writer') structured = { mainTex: behavior.missingDependency && calls.filter(r => r === 'writer').length === 1 ? manuscript.replace('Original finding.', '\\input{missing.txt}') : behavior.bodyExtension ? manuscript.replace('Original finding.', `\\input{results.${behavior.bodyExtension}}`) : behavior.repairOnce && calls.filter(r => r === 'writer').length > 1 ? manuscript.replace('Original finding.', 'Repaired finding.') : manuscript, ...(behavior.bodyExtension ? { sections: { [`results.${behavior.bodyExtension}`]: 'Accuracy was 99.9.\\cite{missing}' } } : {}), failureReport: 'Further experiments are needed.' }
    if (role === 'paper-polisher') structured = { mainTex: behavior.badPolish ? manuscript.replace('Original finding.', 'Accuracy was 99.9.') : manuscript.replace('Original finding.', 'Polished finding.'), changes: ['Polish prose'] }
    if (role === 'paper-reviewer') {
      observations.push(await readFile(join(runDir, 'paper', 'main.tex'), 'utf8'))
      if (behavior.revise || behavior.repairOnce && observations.length === 1) structured = { verdict: 'REVISE', issues: [{ severity: 'major', code: 'REVISE', detail: 'Original finding needs stronger support.', repair: 'Improve the supported claim.' }] }
    }
    const imageReceipt = !behavior.noVisual && input.figureImages?.length ? { role, taskId: input.taskId, provider: 'test-image-provider', model: 'image-model', images: await Promise.all(input.figureImages.map(async (path: string) => ({ path, attachmentId: 'host-test-attachment', hash: paperHash(await readFile(path)) }))) } : undefined
    return { text: '', stopReason: 'completed', structured, imageReceipt }
  } }
  const request = { runDir, tree: new ResearchTree(join(runDir, 'research_tree.json')), evidencePath, agentContext: { parent: { id: 'paper-fixture', session: { id: 'paper-fixture' } }, signal: new AbortController().signal } }
  const run = (overrides: any = {}) => runPaperPipeline({ provider, options: { assurance: 'submission', reviewBudget: { maxRequests: 32, maxRounds: 1 }, ...options, ...overrides } }, request)
  const checkpoint = async () => JSON.parse(await readFile(join(runDir, 'paper', 'pipeline_checkpoint.json'), 'utf8'))
  return { runDir, run, checkpoint, calls, observations }
}

test('real final gate rechecks polished PDF and resume preserves manual edits while invalidating reviews', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t)
  const result = await f.run()
  assert.equal(result.submissionReady, true)
  assert.equal(f.calls.filter(r => r === 'paper-reviewer').length, 2)
  assert.match(f.observations[0], /Original finding/)
  assert.match(f.observations[1], /Polished finding/)
  const cp = await f.checkpoint()
  assert.equal(cp.data.compile.inspection.coverage.complete, true)
  assert.equal(cp.data.reviews['layout-reviewer'].imageReceipt.images.length, cp.data.compile.inspection.pages.length)
  assert.deepEqual(cp.data.reviews['paper-reviewer'].binding, cp.data.binding)
  const count = f.calls.length
  await f.run(); assert.equal(f.calls.length, count)
  const manual = manuscript.replace('Original finding.', 'Manually repaired finding.')
  await writeFile(join(f.runDir, 'paper', 'main.tex'), manual)
  await f.run()
  assert.equal(await readFile(join(f.runDir, 'paper', 'main.tex'), 'utf8'), manual)
  assert.equal(f.calls.filter(r => r === 'writer').length, 1)
  assert.equal(f.calls.filter(r => r === 'paper-reviewer').length, 3)
})

test('post-polish numeric evidence failure blocks submission instead of reusing prior audits', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t, { reviewBudget: { maxRequests: 16, maxRounds: 0 } }, { badPolish: true })
  await assert.rejects(f.run, /BLOCKED/)
  const cp = await f.checkpoint()
  assert.equal(cp.data.audits.basic.numeric.ok, false)
  assert.equal(cp.data.submissionReady, false)
  assert.equal(cp.data.gate.verdict, 'BLOCKED')
})

test('review request exhaustion and missing native visual capability persist resumable BLOCKED', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t, { reviewBudget: { maxRequests: 1, maxRounds: 0 } })
  await assert.rejects(f.run, /BLOCKED/)
  assert.equal((await f.checkpoint()).data.reviewBudget.used, 1)
  assert.equal(f.calls.includes('layout-reviewer'), false)
  const resumed = await f.run({ reviewBudget: { maxRequests: 20, maxRounds: 1 } })
  assert.equal(resumed.submissionReady, true)
  assert.ok((await f.checkpoint()).data.reviewBudget.used > 1)
  const noVisual = await pipelineFixture(t, { assurance: 'draft' }, { noVisual: true })
  const result = await noVisual.run()
  assert.equal(result.submissionReady, false)
  assert.equal(result.compileOk, true)
  assert.equal((await noVisual.checkpoint()).data.gate.verdict, 'BLOCKED')
})

test('unchanged writer repair stops without spending all remaining review budget', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t, {}, { revise: true })
  await assert.rejects(f.run, /no progress/)
  const cp = await f.checkpoint()
  assert.equal(cp.data.reviewBudget.rounds, 1)
  assert.ok(cp.data.reviewBudget.used < cp.data.reviewBudget.limit)
  assert.equal(f.calls.filter(r => r === 'writer').length, 2)
})

test('the last allowed source repair is reviewed before accepting the final polished version', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t, { reviewBudget: { maxRequests: 20, maxRounds: 1 } }, { repairOnce: true })
  assert.equal((await f.run()).submissionReady, true)
  assert.equal((await f.checkpoint()).data.reviewBudget.rounds, 1)
  assert.equal(f.observations.length, 3)
  assert.match(f.observations[1], /Repaired finding/)
  assert.match(f.observations[2], /Polished finding/)
})

test('academic audit ignores unused template samples but includes nested manuscript inputs and citations', async t => {
  const { auditPaper } = await import('../../dist/paper/audit.js')
  const runDir = await mkdtemp(join(tmpdir(), 'ar-audit-source-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const paper = join(runDir, 'paper'); await mkdir(join(paper, 'sections', 'nested'), { recursive: true })
  await writeFile(join(paper, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\end{document}')
  await writeFile(join(paper, 'iclr2026.tex'), 'Template sample 12345 without evidence')
  await writeFile(join(paper, 'sections', 'body.tex'), '\\input{sections/nested/results}')
  await writeFile(join(paper, 'sections', 'nested', 'results.tex'), 'Our scientific contribution.')
  assert.equal((await auditPaper(runDir, [])).numeric.ok, true)
  await writeFile(join(paper, 'sections', 'nested', 'results.tex'), 'Accuracy was 99.9. \\cite{missing}')
  const audit = await auditPaper(runDir, [])
  assert.equal(audit.numeric.ok, false)
  assert.equal(audit.citation.ok, false)
  await writeFile(join(paper, 'main.tex'), '\\import{sections/}{body}')
  const unresolved = await auditPaper(runDir, [])
  assert.equal(unresolved.numeric.ok, false)
  assert.match(unresolved.numeric.errors.join('\n'), /UNSUPPORTED_SOURCE_DEPENDENCY/)
})

test('checkpoint invalidation preserves the written manuscript and invalidates all final gates', async () => {
  const { invalidatePaperCheckpoint } = await import('../../dist/paper/checkpoint.js')
  const cp = { schema: 'autoresearch/paper-pipeline-checkpoint/v1', assurance: 'submission', updated_at: '', phases: { writing: 'done', compile: 'done', audits: 'done', final: 'done', polish: 'done' }, data: { submissionReady: true, compileOk: true, audits: {}, reviews: {} } }
  invalidatePaperCheckpoint(cp as never, 'source changed')
  assert.equal(cp.phases.writing, 'done')
  assert.equal(cp.phases.compile, 'pending')
  assert.equal(cp.phases.final, 'pending')
  assert.equal(cp.data.submissionReady, false)
})

test('actual non-tex manuscript dependencies cannot bypass numeric or citation evidence audits', { skip: !realEngine }, async t => {
  for (const bodyExtension of ['sty', 'ltx', 'txt']) {
    const f = await pipelineFixture(t, { reviewBudget: { maxRequests: 12, maxRounds: 0 } }, { bodyExtension })
    await assert.rejects(f.run, /BLOCKED/)
    const cp = await f.checkpoint()
    assert.equal(cp.data.compile.geometry.status, 'measured')
    assert.equal(cp.data.audits.basic.numeric.ok, false)
    assert.equal(cp.data.audits.basic.citation.ok, false)
    assert.equal(cp.data.submissionReady, false)
  }
})

test('a custom main.tex template is not mistaken for an already written manuscript', async t => {
  const templateDir = await mkdtemp(join(tmpdir(), 'ar-custom-main-template-'))
  t.after(() => rm(templateDir, { recursive: true, force: true }))
  await writeFile(join(templateDir, 'main.tex'), manuscript.replace('Original finding.', 'Template placeholder.'))
  const f = await pipelineFixture(t, { venue: 'custom', templateDir, templateFile: 'main.tex', layoutProfile: { page: { widthPt: 612, heightPt: 792, marginPt: { top: 72, right: 108, bottom: 72, left: 108 } }, columns: { count: 1, widthPt: 396, gutterPt: 0 } }, assurance: 'draft', reviewBudget: { maxRequests: 1, maxRounds: 0 } })
  await f.run()
  assert.ok(f.calls.includes('writer'))
  assert.doesNotMatch(await readFile(join(f.runDir, 'paper', 'main.tex'), 'utf8'), /Template placeholder/)
})

test('missing literal input remains a bounded compiler repair instead of preventing repair dispatch', { skip: !realEngine }, async t => {
  const f = await pipelineFixture(t, { reviewBudget: { maxRequests: 20, maxRounds: 1 } }, { missingDependency: true })
  assert.equal((await f.run()).submissionReady, true)
  assert.equal(f.calls.filter(role => role === 'writer').length, 2)
})

test('figure applicability comes from actual artifact files and manuscript syntax', async t => {
  const { paperReviewRequirements } = await import('../../dist/paper/review-runner.js')
  const paper = await mkdtemp(join(tmpdir(), 'ar-figure-applicability-'))
  t.after(() => rm(paper, { recursive: true, force: true }))
  await writeFile(join(paper, 'main.tex'), 'Textual scientific manuscript.')
  assert.equal((await paperReviewRequirements(paper)).requiredRoles.includes('figure-reviewer'), false)
  await mkdir(join(paper, 'figures'))
  await writeFile(join(paper, 'figures', 'diagram.png'), 'actual figure artifact')
  assert.equal((await paperReviewRequirements(paper)).requiredRoles.includes('figure-reviewer'), true)
})

test('review budget persists admission before dispatch and blocks extra requests', async () => {
  const { admitPaperReview } = await import('../../dist/paper/review-protocol.js')
  const budget = { used: 0, limit: 1, rounds: 0, maxRounds: 1, sequence: 0 }
  let saves = 0
  await admitPaperReview(budget, async () => { saves++ })
  await assert.rejects(() => admitPaperReview(budget, async () => { saves++ }), /budget/i)
  assert.equal(budget.used, 1)
  assert.equal(saves, 1)
})
