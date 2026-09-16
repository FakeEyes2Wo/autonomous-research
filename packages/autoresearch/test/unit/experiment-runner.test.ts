import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

test('legacy experiment resume keeps literature off despite lexical current project settings', async (t) => {
  for (const missingSnapshot of [false, true]) {
    const runDir = await mkdtemp(join(tmpdir(), 'ar-literature-policy-'))
    t.after(() => rm(runDir, { recursive: true, force: true }))
    await mkdir(join(runDir, '.autoresearch'), { recursive: true })
    await writeFile(join(runDir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\nliterature:\n  mode: lexical\n')
    const observed: string[] = []
    const provider = { async run(_role, _input, ctx) { observed.push(ctx.policySnapshot.literature.mode); throw new Error('fixture stop before transport') } }
    const request = { runDir, task: 'policy resume', maxRounds: 1, agentContext: { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal } }
    await assert.rejects(runExperimentTask({ provider }, request), /fixture stop/)
    const policyPath = join(runDir, '.autoresearch', 'policy-snapshot.json')
    if (missingSnapshot) await unlink(policyPath)
    else { const policy = JSON.parse(await readFile(policyPath, 'utf8')); delete policy.literature; await writeFile(policyPath, JSON.stringify(policy)) }
    await assert.rejects(runExperimentTask({ provider }, request), /fixture stop/)
    assert.deepEqual(observed, ['lexical', 'off'])
  }
})

test('standalone experiment runs a task and writes a report', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const result = await runExperimentTask(
    { provider },
    {
      runDir,
      task: 'Compare two optimizers on a small public ML benchmark',
      profile: '# PROFILE\n\n- Allowed: local code, public data.',
      maxRounds: 1,
      agentContext: {
        parent: { id: 'agent-1', session: { id: 'agent-1' } },
        signal: new AbortController().signal,
      },
    },
  )

  assert.equal(result.status, 'completed')
  assert.equal(result.cycles, 1)
  assert.ok(result.evidencePath)
  assert.ok(provider.calls.includes('planner'))
  assert.ok(provider.calls.includes('experiment-designer'))
  assert.ok(provider.calls.includes('research-worker'))
  assert.ok(provider.calls.includes('supervisor'))
  const report = await readFile(result.reportPath, 'utf8')
  assert.match(report, /EXPERIMENT_REPORT/)
  assert.match(report, /Compare two optimizers/)
})

test('standalone minimal mode freezes policy, records a ledger, and does not dispatch optional roles', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-minimal-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'project-settings.yaml'), [
    'version: 2',
    'workflow:',
    '  mode: minimal',
    '  paper: never',
    '  experimentReview: never',
  ].join('\n') + '\n', 'utf8')
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const result = await runExperimentTask(
    { provider },
    {
      runDir,
      task: 'Minimal standalone task',
      maxRounds: 1,
      agentContext: {
        parent: { id: 'agent-1', session: { id: 'agent-1' } },
        signal: new AbortController().signal,
      },
    },
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(provider.calls, ['planner', 'research-worker', 'supervisor'])
  assert.match(await readFile(join(runDir, '.autoresearch', 'policy-snapshot.json'), 'utf8'), /"version": 2/)
  assert.match(await readFile(join(runDir, 'request-ledger.json'), 'utf8'), /autoresearch\/request-ledger\/v1/)
  assert.match(await readFile(join(runDir, 'MINIMAL_EVIDENCE-1.md'), 'utf8'), /local record/)
})

test('standalone resume rejects a different task in the same run directory', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-identity-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const first = new FakeAgentProvider({ decisions: ['finish'] })
  await runExperimentTask({ provider: first }, {
    runDir,
    task: 'Original task',
    maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  await assert.rejects(
    () => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
      runDir,
      task: 'Different task',
      maxRounds: 1,
      agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
    }),
    /different experiment task\/profile/,
  )
})

test('standalone pauses before work when automatic design review remains revise at the cap', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-review-pause-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = new FakeAgentProvider({ decisions: ['finish'], experimentVerdicts: ['revise', 'revise', 'revise'] })
  const result = await runExperimentTask({ provider }, {
    runDir, task: 'Require an accepted frozen protocol', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.equal(provider.calls.filter((role) => role === 'experiment-reflexion').length, 3)
  assert.equal(provider.calls.includes('research-worker'), false)
  assert.equal(provider.calls.includes('supervisor'), false)
  assert.match(await readFile(result.reportPath, 'utf8'), /PAUSED|review/i)
})

for (const invalid of [
  { name: 'missing artifact', artifacts: ['work/cycle-1/missing.txt'] },
  { name: 'directory artifact', artifacts: ['work/cycle-1'] },
  { name: 'traversal artifact', artifacts: ['../outside.txt'] },
] as const) {
  test(`standalone pauses before evidence for a completed worker with ${invalid.name}`, async (t) => {
    const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-artifact-'))
    t.after(() => rm(runDir, { recursive: true, force: true }))
    const provider = new FakeAgentProvider({ decisions: ['finish'], workerArtifacts: [...invalid.artifacts] })
    const result = await runExperimentTask({ provider }, {
      runDir, task: 'Validate local worker evidence', maxRounds: 1,
      agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
    })
    assert.equal(result.status, 'paused')
    assert.equal(provider.calls.includes('evidence-agent'), false)
    assert.equal(provider.calls.includes('supervisor'), false)
    assert.match(result.reason ?? '', /artifact/i)
  })
}

test('standalone pauses when worker output is unstructured instead of assuming completion', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-unstructured-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = new FakeAgentProvider({ decisions: ['finish'], unstructuredWorker: true })
  const result = await runExperimentTask({ provider }, {
    runDir, task: 'Reject malformed worker output', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.equal(provider.calls.includes('supervisor'), false)
  assert.match(result.reason ?? '', /worker result|structured/i)
})

test('standalone preserves a failed worker summary when no artifacts were produced', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-worker-failed-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = new FakeAgentProvider({ decisions: ['finish'], workerStatus: 'failed', workerArtifacts: [] })
  const result = await runExperimentTask({ provider }, {
    runDir, task: 'Preserve worker failure diagnostics', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.match(result.reason ?? '', /worker reported failed: worker summary/i)
  assert.equal(provider.calls.includes('supervisor'), false)
})

test('standalone rejects an absolute artifact outside the real run root', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-outside-run-'))
  const outsideDir = await mkdtemp(join(tmpdir(), 'ar-experiment-outside-file-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  const outsideFile = join(outsideDir, 'outside.txt')
  await writeFile(outsideFile, 'outside\n', 'utf8')
  const provider = new FakeAgentProvider({ decisions: ['finish'], workerArtifacts: [outsideFile] })
  const result = await runExperimentTask({ provider }, {
    runDir, task: 'Reject outside evidence', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.match(result.reason ?? '', /escapes the run directory/i)
  assert.equal(provider.calls.includes('supervisor'), false)
})

test('standalone rejects an artifact symlink that escapes the real run root', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-symlink-run-'))
  const outsideDir = await mkdtemp(join(tmpdir(), 'ar-experiment-symlink-file-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  const outsideFile = join(outsideDir, 'outside.txt')
  await writeFile(outsideFile, 'outside\n', 'utf8')
  try {
    await symlink(outsideFile, join(runDir, 'outside-link.txt'), 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink creation is not permitted on this Windows host')
      return
    }
    throw error
  }
  const provider = new FakeAgentProvider({ decisions: ['finish'], workerArtifacts: ['outside-link.txt'] })
  const result = await runExperimentTask({ provider }, {
    runDir, task: 'Reject symlink evidence escape', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.match(result.reason ?? '', /resolves outside the run directory/i)
  assert.equal(provider.calls.includes('supervisor'), false)
})

test('standalone minimal resume validates cached artifacts before a decision', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-cached-artifact-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')
  const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
  await assert.rejects(() => runExperimentTask({ provider: first }, {
    runDir, task: 'Validate cached evidence', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  }))
  await rm(join(runDir, 'work', 'cycle-1', 'out.txt'))
  const second = new FakeAgentProvider({ decisions: ['finish'] })
  const result = await runExperimentTask({ provider: second }, {
    runDir, task: 'Validate cached evidence', maxRounds: 1,
    agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
  })
  assert.equal(result.status, 'paused')
  assert.equal(second.calls.includes('research-worker'), false)
  assert.equal(second.calls.includes('supervisor'), false)
})

for (const mode of ['legacy', 'minimal'] as const) {
  for (const cachedData of [
    { name: 'missing actionResult', value: {} },
    { name: 'null actionResult', value: { actionResult: null } },
    { name: 'null stage data', value: null },
  ] as const) {
    test(`standalone ${mode} pauses without rerunning a worker for cached work with ${cachedData.name}`, async (t) => {
      const runDir = await mkdtemp(join(tmpdir(), `ar-experiment-cached-${mode}-`))
      t.after(() => rm(runDir, { recursive: true, force: true }))
      if (mode === 'minimal') {
        await mkdir(join(runDir, '.autoresearch'), { recursive: true })
        await writeFile(join(runDir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n  paper: never\n', 'utf8')
      }
      const request = {
        runDir, task: `Validate ${mode} cached work shape`, maxRounds: 1,
        agentContext: { parent: { id: 'agent-1', session: { id: 'agent-1' } }, signal: new AbortController().signal },
      }
      await assert.rejects(() => runExperimentTask(
        { provider: new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' }) }, request,
      ))
      await writeFile(join(runDir, '.autoresearch', 'experiment-1-work.json'), JSON.stringify({
        schema: 'autoresearch/experiment-stage/v1', cycle: 1, stage: 'work', data: cachedData.value,
      }, null, 2), 'utf8')

      const provider = new FakeAgentProvider({ decisions: ['finish'] })
      const result = await runExperimentTask({ provider }, request)

      assert.equal(result.status, 'paused')
      assert.equal(provider.calls.includes('research-worker'), false)
      assert.equal(provider.calls.includes('supervisor'), false)
      assert.match(await readFile(join(runDir, 'state.json'), 'utf8'), /"status": "PAUSED"/)
    })
  }
}
