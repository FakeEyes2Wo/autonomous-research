import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAPER_AUDITS, paperAuditStatus, writePaper } from '../../dist/paper/phases.js'

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
