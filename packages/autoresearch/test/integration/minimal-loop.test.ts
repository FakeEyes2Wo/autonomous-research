import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { loadState, saveState } from '../../dist/core/state.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'
const artifactAcceptance = { criteria: [{ id: 'artifact', required: true, text: 'Produce a captured engineering artifact', evidenceKind: 'artifact' as const }] }

async function disableCurrentIdeaSearch(dir: string): Promise<void> {
  await mkdir(join(dir, '.autoresearch'), { recursive: true })
  await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  currentIdeaSearch: never\n', 'utf8')
}

test('legacy loop delivers paper and completes only after explicit artifact coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-loop-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nStudy conflictive multi-view learning.\n\n## A-priori ideas\n- Model conflicts explicitly\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n\n- Allowed: local analysis\n', 'utf8')
    await disableCurrentIdeaSearch(dir)

    const provider = new FakeAgentProvider({
      decisions: ['finish'], coverage: 'explicit-artifact',
      writerText: '\\documentclass{article}\n\\begin{document}\nPaper Draft Result.\n\\end{document}',
    })
    const service = new AutoResearchService(provider)
    const context = { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }

    const state = await service.run({ runDir: dir, acceptance: artifactAcceptance }, context)

    assert.equal(state.status, 'COMPLETED')
    assert.equal(state.phase, 'paper')
    assert.equal(provider.calls.includes('rubric-generator'), true)
    assert.equal(provider.calls.includes('supervisor'), true)
    assert.equal(provider.calls.filter((r) => r === 'supervisor').length, 1)
    assert.ok(provider.calls.indexOf('coverage-reviewer') > provider.calls.indexOf('paper-writer'))

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

test('legacy loop pauses when supervisor fails without verified scientific evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-loop-fail-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nSomething.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await disableCurrentIdeaSearch(dir)

    const provider = new FakeAgentProvider({ decisions: ['fail'] })
    const service = new AutoResearchService(provider)
    const state = await service.run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })

    assert.equal(state.status, 'PAUSED')
    const report = await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8')
    assert.match(report, /PAUSED/)
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
      '  currentIdeaSearch: never',
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
    const provider = new FakeAgentProvider({ decisions: ['finish'], coverage: 'explicit-artifact' })
    const service = new AutoResearchService(provider)
    const state = await service.run({ runDir: dir, acceptance: artifactAcceptance }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(provider.calls, ['planner', 'research-worker', 'supervisor', 'coverage-reviewer'])
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
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  brainstorm: never\n  deepDive: enabled\n  experimentReview: never\n  paper: never\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'], coverage: 'explicit-artifact' })
    const state = await new AutoResearchService(provider).run({ runDir: dir, acceptance: artifactAcceptance }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
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
      '  currentIdeaSearch: never',
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
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  experimentReview: never\n  paper: never\n', 'utf8')
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
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  experimentReview: never\n  paper: never\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'high' })
    const state = await new AutoResearchService(provider).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'PAUSED')
    assert.deepEqual(provider.calls, ['planner'])
    assert.match(await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8'), /worker was not started/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal RUNNING crash replay reuses completed plan and worker checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-resume-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nResume the minimal loop.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  experimentReview: never\n  paper: never\n', 'utf8')
    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
    await assert.rejects(() => new AutoResearchService(first).run({ runDir: dir, acceptance: artifactAcceptance }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }))
    const interrupted = (await loadState(dir))!; interrupted.status = 'RUNNING'; await saveState(dir, interrupted)
    const second = new FakeAgentProvider({ decisions: ['finish'], coverage: 'explicit-artifact' })
    const state = await new AutoResearchService(second).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(second.calls, ['supervisor', 'coverage-reviewer'])
    const evidenceResults = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; stepId?: string })
      .filter((event) => event.type === 'result' && event.stepId === 'minimal-evidence-1')
    assert.equal(evidenceResults.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('minimal RUNNING crash replay repairs missing checkpoint result events without rerunning work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-checkpoint-results-'))
  try {
    await mkdir(join(dir, 'input'), { recursive: true })
    await mkdir(join(dir, '.autoresearch'), { recursive: true })
    await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nRepair checkpoint result records.\n', 'utf8')
    await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
    await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  experimentReview: never\n  paper: never\n', 'utf8')

    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
    await assert.rejects(() => new AutoResearchService(first).run({ runDir: dir, acceptance: artifactAcceptance }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal }))
    const interrupted = (await loadState(dir))!; interrupted.status = 'RUNNING'; await saveState(dir, interrupted)
    const eventLines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    const keptEvents = eventLines.filter((line) => {
      const event = JSON.parse(line) as { type?: string; stepId?: string }
      return !(event.type === 'result' && (event.stepId === 'minimal-plan-1' || event.stepId === 'minimal-work-1'))
    })
    await writeFile(join(dir, 'events.jsonl'), `${keptEvents.join('\n')}\n`, 'utf8')

    const second = new FakeAgentProvider({ decisions: ['finish'], coverage: 'explicit-artifact' })
    const state = await new AutoResearchService(second).run({ runDir: dir }, { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal })
    assert.equal(state.status, 'COMPLETED')
    assert.deepEqual(second.calls, ['supervisor', 'coverage-reviewer'])
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

test('minimal post-work review pause cannot be retried unchanged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-minimal-post-work-review-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'input'), { recursive: true })
  await mkdir(join(dir, '.autoresearch'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nReview the executed protocol.\n', 'utf8')
  await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
  await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  currentIdeaSearch: never\n  experimentReview: enabled\n  modelScout: never\n  postResultSynthesis: never\n  paper: never\n', 'utf8')

  const first = new FakeAgentProvider({ decisions: ['finish'], experimentVerdicts: ['revise'] })
  const paused = await new AutoResearchService(first).run({ runDir: dir }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })
  assert.equal(paused.status, 'PAUSED')
  assert.equal(first.calls.filter((role) => role === 'research-worker').length, 1)
  assert.equal(first.calls.includes('experiment-designer'), false)
  assert.equal(first.calls.includes('supervisor'), false)

  const second = new FakeAgentProvider({ decisions: ['finish'], experimentVerdicts: ['proceed'] })
  const completed = await new AutoResearchService(second).resume({ runDir: dir }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })
  assert.equal(completed.status, 'PAUSED')
  assert.equal(second.calls.includes('research-worker'), false)
  assert.deepEqual(second.calls, [])
})

test('legacy research pauses before work when automatic design review is unresolved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-legacy-review-pause-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'input'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nFreeze a reviewed protocol.\n', 'utf8')
  await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
  await disableCurrentIdeaSearch(dir)
  const provider = new FakeAgentProvider({ decisions: ['finish'], experimentVerdicts: ['revise', 'revise', 'revise'] })

  const state = await new AutoResearchService(provider).run({ runDir: dir, humanReview: 'off' }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })

  assert.equal(state.status, 'PAUSED')
  assert.equal(provider.calls.includes('research-worker'), false)
  assert.equal(provider.calls.includes('supervisor'), false)
  assert.match(await readFile(join(dir, 'FAILURE_REPORT.md'), 'utf8'), /not accepted|requires revision/i)
})

test('legacy research pauses before evidence when worker artifact is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-legacy-artifact-pause-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'input'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nValidate worker evidence.\n', 'utf8')
  await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
  await disableCurrentIdeaSearch(dir)
  const provider = new FakeAgentProvider({ decisions: ['finish'], workerArtifacts: ['work/cycle-1/missing.txt'] })

  const state = await new AutoResearchService(provider).run({ runDir: dir, humanReview: 'off' }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })

  assert.equal(state.status, 'PAUSED')
  assert.equal(provider.calls.includes('evidence-agent'), false)
  assert.equal(provider.calls.includes('supervisor'), false)
  assert.match(state.lastError ?? '', /artifact/i)
})

test('legacy research pauses when a second human experiment review still requests revision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-human-review-pause-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'input'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nRequire explicit human acceptance.\n', 'utf8')
  await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
  await disableCurrentIdeaSearch(dir)
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const reviewer = { ask: async () => ({ verdict: 'revise' as const, feedback: 'still incomplete' }) }

  const state = await new AutoResearchService(provider, { reviewer, reviewGates: ['experiment'] }).run({ runDir: dir, humanReview: 'on' }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })

  assert.equal(state.status, 'PAUSED')
  assert.equal(provider.calls.includes('research-worker'), false)
  assert.match(state.lastError ?? '', /still needs human revision/i)
})

test('legacy research returns paused when automatic review rejects a human-requested redesign', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-human-redesign-auto-pause-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'input'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nReview the human redesign.\n', 'utf8')
  await writeFile(join(dir, 'PROFILE.md'), '# PROFILE\n', 'utf8')
  await disableCurrentIdeaSearch(dir)
  const provider = new FakeAgentProvider({ decisions: ['finish'], experimentVerdicts: ['proceed', 'revise', 'revise', 'revise'] })
  let humanCalls = 0
  const reviewer = { ask: async () => ({ verdict: ++humanCalls === 1 ? 'revise' as const : 'approve' as const, feedback: 'redesign this' }) }

  const state = await new AutoResearchService(provider, { reviewer, reviewGates: ['experiment'] }).run({ runDir: dir, humanReview: 'on' }, {
    parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal,
  })

  assert.equal(state.status, 'PAUSED')
  assert.equal(provider.calls.includes('research-worker'), false)
  assert.match(state.lastError ?? '', /not accepted|requires revision/i)
})
