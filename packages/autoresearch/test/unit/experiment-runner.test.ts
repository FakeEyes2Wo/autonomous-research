import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

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
