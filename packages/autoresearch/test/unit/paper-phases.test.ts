import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { runPaperPipeline } from '../../dist/paper/pipeline.js'
import { PAPER_AUDITS, paperAuditStatus, writePaper, writePaperReport } from '../../dist/paper/phases.js'

test('paper audit registry is the single source of proof/claim/citation/kill audits', () => {
  assert.deepEqual(PAPER_AUDITS, [
    { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
    { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
    { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
    { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
  ])
})

test('paper audit gate fails closed and accepts only explicit passing verdicts', () => {
  const passing = {
    proof: { verdict: 'NOT_APPLICABLE' },
    claim: { verdict: 'PASS' },
    citation: { verdict: 'PASS' },
    kill: { verdict: 'NOT_APPLICABLE' },
    basic: { numeric: { ok: true }, citation: { ok: true } },
  }
  assert.equal(paperAuditStatus(passing), 'passed')
  assert.equal(paperAuditStatus({ ...passing, claim: { verdict: 'ERROR' } }), 'failed')
  assert.equal(paperAuditStatus({}), 'failed')
})

test('writer persists bibliography before a section write can fail', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-paper-write-order-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const paperDir = join(runDir, 'paper')
  await mkdir(paperDir, { recursive: true })
  await writeFile(join(paperDir, 'sections'), 'blocking file', 'utf8')
  const ctx = {
    deps: {
      options: {},
      provider: {
        async run() {
          return {
            text: '',
            stopReason: 'completed',
            structured: {
              mainTex: 'main',
              bib: 'refs',
              sections: { 'sections/part.tex': 'section' },
            },
          }
        },
      },
    },
    paths: { runDir, paperDir },
    content: { planText: '', matrixText: '', contractText: '', figuresLatex: '', evidencePath: '' },
    agentContext: {
      parent: { id: 'paper-test', session: { id: 'paper-test' } },
      signal: new AbortController().signal,
    },
  }

  await assert.rejects(() => writePaper(ctx as never))
  assert.equal(await readFile(join(paperDir, 'main.tex'), 'utf8'), 'main')
  assert.equal(await readFile(join(paperDir, 'references.bib'), 'utf8'), 'refs')
})

test('paper pipeline does not create .aris when the first provider phase stops', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-paper-no-aris-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = {
    async run() {
      throw new Error('planner stopped')
    },
  }
  const agentContext = {
    parent: { id: 'paper-no-aris', session: { id: 'paper-no-aris' } },
    signal: new AbortController().signal,
  }

  await assert.rejects(() => runPaperPipeline(
    { provider, options: { assurance: 'draft' } },
    {
      runDir,
      tree: new ResearchTree(join(runDir, 'research_tree.json')),
      evidencePath: join(runDir, 'evidence_chain.json'),
      agentContext,
    },
  ), /planner stopped/)

  assert.equal(existsSync(join(runDir, 'paper', '.aris')), false)
  const checkpoint = JSON.parse(await readFile(join(runDir, 'paper', 'pipeline_checkpoint.json'), 'utf8')) as { assurance?: string }
  assert.equal(checkpoint.assurance, 'draft')
})

test('paper pipeline recovery keeps assurance in checkpoint without recreating .aris', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-paper-recovery-no-aris-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const paperDir = join(runDir, 'paper')
  await mkdir(paperDir, { recursive: true })
  const planFile = join(paperDir, 'PAPER_PLAN.md')
  const matrixFile = join(paperDir, 'claims_evidence_matrix.json')
  await writeFile(planFile, '# plan', 'utf8')
  await writeFile(matrixFile, '{}', 'utf8')
  await writeFile(join(paperDir, 'pipeline_checkpoint.json'), JSON.stringify({
    schema: 'autoresearch/paper-pipeline-checkpoint/v1',
    updated_at: new Date().toISOString(),
    assurance: 'draft',
    phases: { plan: 'done' },
    data: { planFile, matrixFile },
  }), 'utf8')
  const agentContext = {
    parent: { id: 'paper-recovery-no-aris', session: { id: 'paper-recovery-no-aris' } },
    signal: new AbortController().signal,
  }

  await assert.rejects(() => runPaperPipeline(
    {
      provider: {
        async run(role: string) {
          if (role === 'contract-negotiator') throw new Error('recovery stopped')
          return { text: '', stopReason: 'completed', structured: { scripts: {}, latexIncludes: '' } }
        },
      },
      options: { assurance: 'submission' },
    },
    {
      runDir,
      tree: new ResearchTree(join(runDir, 'research_tree.json')),
      evidencePath: join(runDir, 'evidence_chain.json'),
      agentContext,
    },
  ), /recovery stopped/)

  assert.equal(existsSync(join(paperDir, '.aris')), false)
  const checkpoint = JSON.parse(await readFile(join(paperDir, 'pipeline_checkpoint.json'), 'utf8')) as { assurance?: string }
  assert.equal(checkpoint.assurance, 'submission')
})

test('paper final report points to the checkpoint for assurance state', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-paper-report-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const report = await writePaperReport({
    deps: { options: {}, provider: {} },
    paths: { runDir, paperDir: join(runDir, 'paper') },
    content: { planText: '', matrixText: '', contractText: '', figuresLatex: '', evidencePath: '' },
    agentContext: {
      parent: { id: 'paper-report', session: { id: 'paper-report' } },
      signal: new AbortController().signal,
    },
  } as never, 'draft', true, {})

  assert.match(report, /paper\/pipeline_checkpoint\.json/)
  assert.doesNotMatch(report, /\.aris/)
})
