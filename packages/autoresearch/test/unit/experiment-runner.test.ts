import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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
