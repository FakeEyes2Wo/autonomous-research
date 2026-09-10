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

test('minimal mode uses plan, worker, local evidence, and supervisor without optional roles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nTest a minimal research loop.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), [
      'version: 2',
      'workflow:',
      '  mode: minimal',
      '  experimentReview: never',
      '  modelScout: never',
      '  postResultSynthesis: never',
      '  paper: never',
      '  reflexionRounds: 0',
      'budget:',
      '  maxRunTokens: 100000',
      '  maxOutputTokens: 1000',
      '  maxInputTokens: 1000',
      '  maxRoleCalls: 10',
    ].join('\n') + '\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'] })
    const service = new AutoResearchService(provider)
    const state = await service.run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(provider.calls, ['planner', 'research-worker', 'supervisor'])
    assert.equal(await readFile(join(dir, 'MINIMAL_EVIDENCE-1.md'), 'utf8').then((value) => value.includes('local evidence')), true)
    assert.equal(await import('node:fs/promises').then(({ access }) => access(join(dir, 'paper')).then(() => true, () => false)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal mode honors explicitly enabled deep-dive prelude instead of silently ignoring it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-deep-dive-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nUse an explicit deep-dive prelude.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  brainstorm: never\n  deepDive: enabled\n  experimentReview: never\n  paper: never\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'] })
    const state = await new AutoResearchService(provider).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.equal(provider.calls.includes('paper-survey'), true)
    assert.equal(provider.calls.includes('paper-frontier-miner'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal mode pauses on high risk when independent review is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-risk-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nRisky minimal experiment.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), [
      'version: 2',
      'workflow:',
      '  mode: minimal',
      '  experimentReview: never',
      '  paper: never',
      'budget:',
      '  maxRunTokens: 100000',
      '  maxOutputTokens: 1000',
      '  maxInputTokens: 1000',
      '  maxRoleCalls: 10',
    ].join('\n') + '\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'high' })
    const service = new AutoResearchService(provider)
    const state = await service.run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'PAUSED')
    assert.equal(provider.calls.includes('supervisor'), false)
    assert.match(await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8'), /PAUSED|review/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal mode pauses when worker evidence is insufficient', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-evidence-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nEvidence must be checked.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'], workerStatus: 'failed' })
    const state = await new AutoResearchService(provider).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'PAUSED')
    assert.equal(provider.calls.includes('supervisor'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal mode gates a non-low-risk plan before starting the worker when review is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-risk-gate-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nRisk must be reviewed first.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'high' })
    const state = await new AutoResearchService(provider).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'PAUSED')
    assert.deepEqual(provider.calls, ['planner'])
    assert.match(await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8'), /worker was not started/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal resume reuses completed plan and worker checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-resume-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nResume the minimal loop.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')
    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
    await assert.rejects(() => new AutoResearchService(first).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }))
    const second = new FakeAgentProvider({ decisions: ['finish'] })
    const state = await new AutoResearchService(second).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(second.calls, ['supervisor'])
    const evidenceResults = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; stepId?: string })
      .filter((event) => event.type === 'result' && event.stepId === 'minimal-evidence-1')
    assert.equal(evidenceResults.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal resume repairs missing checkpoint result events without rerunning work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-checkpoint-results-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nRepair checkpoint result records.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')

    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
    await assert.rejects(() => new AutoResearchService(first).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }))
    const eventLines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    const keptEvents = eventLines.filter((line) => {
      const event = JSON.parse(line) as { type?: string; stepId?: string }
      return !(event.type === 'result' && (event.stepId === 'minimal-plan-1' || event.stepId === 'minimal-work-1'))
    })
    await writeFile(join(dir, 'events.jsonl'), `${keptEvents.join('\n')}\n`, 'utf8')

    const second = new FakeAgentProvider({ decisions: ['finish'] })
    const state = await new AutoResearchService(second).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(second.calls, ['supervisor'])
    const results = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; stepId?: string })
      .filter((event) => event.type === 'result')
    assert.equal(results.filter((event) => event.stepId === 'minimal-plan-1').length, 1)
    assert.equal(results.filter((event) => event.stepId === 'minimal-work-1').length, 1)
    assert.equal(results.filter((event) => event.stepId === 'minimal-evidence-1').length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
