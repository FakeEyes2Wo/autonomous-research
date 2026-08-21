import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInitialState, loadState, saveState, appendEvent } from '../../dist/core/state.js'

test('state create/load/save and events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-state-'))
  try {
    const state = await createInitialState(dir, 'ar_test')
    assert.equal(state.runId, 'ar_test')
    assert.equal(state.status, 'RUNNING')
    const loaded = await loadState(dir)
    assert.equal(loaded?.runId, 'ar_test')

    state.phase = 'work'
    await saveState(dir, state)
    const after = await loadState(dir)
    assert.equal(after?.phase, 'work')

    await appendEvent(dir, { type: 'decision', stepId: 'decide-1', data: { action: 'continue' } })
    const events = await readFile(join(dir, 'events.jsonl'), 'utf8')
    assert.match(events, /decide-1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
