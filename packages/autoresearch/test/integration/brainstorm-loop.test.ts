import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

test('brainstorm prompts are topic-isolated and do not receive a seed or prior direction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-brainstorm-isolated-'))
  try {
    const provider = new FakeAgentProvider({
      decisions: ['finish'],
      writerText: '\\documentclass{article}\n\\begin{document}\nIsolated Brainstorm.\n\\end{document}',
    })
    const service = new AutoResearchService(provider)
    const context = { parent: { id: 'agent-isolated', session: { id: 'agent-isolated' } }, signal: new AbortController().signal }

    await service.run({ runDir: dir, idea: 'conflictive multi-view learning' }, context)

    const brainstormRoles = new Set(['paper-survey', 'direction-select', 'paper-frontier-miner', 'brainstorm'])
    const plans = provider.inputs
      .filter((entry) => brainstormRoles.has(entry.role))
      .map((entry) => String(entry.input.plan ?? ''))
    assert.equal(plans.length > 0, true)
    for (const plan of plans) {
      assert.equal(plan.includes('conflictive multi-view learning'), false)
      assert.equal(plan.includes('multi-view'), false)
      assert.equal(plan.includes('Seed:'), false)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('brainstorm pre-phase surveys field, selects directions, mines latest, writes unified wiki, and reforms a winner', async () => {
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
    assert.equal(provider.calls.includes('paper-survey'), true)
    assert.equal(provider.calls.includes('direction-select'), true)
    assert.equal(provider.calls.includes('paper-frontier-miner'), true)
    // Default wiki generation is programmatic, so the slow LLM writer should not be called.
    assert.equal(provider.calls.includes('paper-wiki-writer'), false)
    assert.equal(provider.calls.filter((role) => role === 'brainstorm').length >= 5, true)

    const idea = await readFile(join(dir, 'input', 'idea.md'), 'utf8')
    assert.match(idea, /## Direction/)
    assert.match(idea, /Refined gap direction/)
    const records = JSON.parse(await readFile(join(dir, 'brainstorm', 'paper_records.json'), 'utf8')) as Array<{ stage: string; id: string }>
    assert.equal(records.length >= 60 + 15, true)
    assert.equal(records.filter((paper) => paper.stage === 'survey').length >= 60, true)
    assert.equal(records.filter((paper) => paper.stage === 'latest').length >= 15, true)
    const surveyOverview = await readFile(join(dir, 'paper_wiki', '_survey.md'), 'utf8')
    assert.match(surveyOverview, /Found Surveys/)
    const directions = await readFile(join(dir, 'paper_wiki', '_directions.md'), 'utf8')
    assert.match(directions, /Selected Directions/)
    const kg = JSON.parse(await readFile(join(dir, 'paper_wiki', 'kg', 'kg.json'), 'utf8')) as { nodes: unknown[]; edges: unknown[] }
    assert.equal(kg.nodes.length > 0, true)
    assert.equal(kg.edges.length > 0, true)
    const wiki = await readFile(join(dir, 'paper_wiki', '_index.md'), 'utf8')
    assert.match(wiki, /Paper Wiki Index/)
    const sampleWiki = await readFile(join(dir, 'paper_wiki', 's001.md'), 'utf8')
    assert.match(sampleWiki, /# /)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
