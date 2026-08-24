import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

test('brainstorm pre-phase mines papers, writes wiki, reforms a winner, and hands off to the research loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-brainstorm-'))
  try {
    const provider = new FakeAgentProvider({
      decisions: ['finish'],
      writerText: '\\documentclass{article}\n\\begin{document}\nBrainstorm Paper.\n\\end{document}',
    })
    const service = new AutoResearchService(provider)
    const context = { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }

    const state = await service.run({ runDir: dir }, context)

    assert.equal(state.status, 'COMPLETED')
    assert.equal(provider.calls.includes('paper-miner'), true)
    assert.equal(provider.calls.includes('paper-wiki-writer'), true)
    assert.equal(provider.calls.filter((role) => role === 'brainstorm').length >= 5, true)

    const idea = await readFile(join(dir, 'input', 'idea.md'), 'utf8')
    assert.match(idea, /## Direction/)
    assert.match(idea, /Refined gap direction/)
    const pool = JSON.parse(await readFile(join(dir, 'brainstorm', 'paper_pool.json'), 'utf8'))
    assert.equal(pool.length >= 30, true)
    assert.equal(pool.filter((paper: { relevance: string }) => paper.relevance === 'A').length >= 15, true)
    const wiki = await readFile(join(dir, 'paper_wiki', '_index.md'), 'utf8')
    assert.match(wiki, /Paper Wiki Index/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
