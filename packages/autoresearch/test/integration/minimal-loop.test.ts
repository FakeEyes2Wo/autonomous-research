import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

test('minimal loop runs revise then finish and produces paper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-loop-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nStudy conflictive multi-view learning.\n\n## A-priori ideas\n- Model conflicts explicitly\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n\n- Allowed: local analysis\n', 'utf8')

    const provider = new FakeAgentProvider({
      decisions: ['revise', 'finish'],
      writerText: '\\documentclass{article}\n\\begin{document}\nPaper Draft Result.\n\\end{document}',
    })
    const service = new AutoResearchService(provider)
    const context = { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }

    const state = await service.run({ runDir: dir }, context)

    assert.equal(state.status, 'COMPLETED')
    assert.equal(state.phase, 'paper')
    assert.equal(provider.calls.includes('rubric-generator'), true)
    assert.equal(provider.calls.includes('supervisor'), true)
    assert.equal(provider.calls.filter((r) => r === 'supervisor').length, 2)

    const paper = await readFile(join(dir, 'paper', 'main.tex'), 'utf8')
    assert.match(paper, /Paper Draft Result/)
    const finalReport = await readFile(join(dir, 'FINAL_REPORT.md'), 'utf8')
    assert.match(finalReport, /FINAL_REPORT/)
    const evidence = await readFile(join(dir, 'evidence_chain.json'), 'utf8')
    assert.match(evidence, /autoresearch\/evidence-chain\/v1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal loop fails when supervisor decides fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-loop-fail-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nSomething.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')

    const provider = new FakeAgentProvider({ decisions: ['fail'] })
    const service = new AutoResearchService(provider)
    const state = await service.run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })

    assert.equal(state.status, 'FAILED')
    const report = await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8')
    assert.match(report, /FAILURE_REPORT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
