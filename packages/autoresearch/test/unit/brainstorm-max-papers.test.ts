import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrainstorm } from '../../dist/brainstorm/pipeline.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

test('brainstorm maxPapers is an upper bound on the persisted survey pool', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-brainstorm-cap-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await runBrainstorm({
    provider: new FakeAgentProvider({ decisions: ['finish'] }),
    options: { maxPapers: 4 },
  }, {
    runDir,
    agentContext: {
      parent: { id: 'agent-1', session: { id: 'agent-1' } },
      signal: new AbortController().signal,
    },
  })
  const pool = JSON.parse(await readFile(join(runDir, 'brainstorm', 'survey_pool.json'), 'utf8')) as { papers?: unknown[] }
  assert.equal(pool.papers?.length, 4)
  const records = JSON.parse(await readFile(join(runDir, 'brainstorm', 'paper_records.json'), 'utf8')) as unknown[]
  assert.ok(records.length <= 4)
})
