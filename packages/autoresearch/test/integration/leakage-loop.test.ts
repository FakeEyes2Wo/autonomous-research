import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { detectLeakage } from '../../dist/security/index.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

test('leakage detection catches leaked target title in generated paper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-leak-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await writeFile(join(dir, 'input', 'candidate.md'), '# Candidate\n\n## Direction\n\nSomething.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')

    const provider = new FakeAgentProvider({
      decisions: ['finish'],
      writerText: '\\documentclass{article}\n\\begin{document}\nReliable Conflictive Multi-View Learning is the hidden paper.\n\\end{document}',
    })
    const service = new AutoResearchService(provider)
    await service.run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })

    const paper = await readFile(join(dir, 'paper', 'main.tex'), 'utf8')
    const leaks = detectLeakage(paper, { title: 'Reliable Conflictive Multi-View Learning' })
    assert.equal(leaks.length, 1)
    assert.match(leaks[0] ?? '', /LEAKAGE/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
