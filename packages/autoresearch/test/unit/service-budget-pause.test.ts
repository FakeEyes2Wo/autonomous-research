import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { LedgerBudgetExceededError } from '../../dist/policy/request-ledger.js'

test('budget exhaustion returns the saved paused state to the calling main agent', async t => {
  const root = await mkdtemp(join(os.tmpdir(), 'budget-pause-'))
  t.mock.method(os, 'homedir', () => root); syncBuiltinESMExports()
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, 'input')); await mkdir(join(root, '.autoresearch'))
  await writeFile(join(root, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nA bounded hypothesis.\n')
  await writeFile(join(root, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  brainstorm: never\n  deepDive: never\n')
  const service = new AutoResearchService({ run: async () => { throw new LedgerBudgetExceededError(0, 1) } })
  const state = await service.run({ runDir: root, humanReview: 'off' }, { parent: { id: 'main', session: { id: 'main' } }, signal: new AbortController().signal })
  assert.equal(state.status, 'PAUSED')
  assert.equal(state.phase, 'plan')
  assert.match(state.lastError!, /budget/)
  assert.equal((await service.status(root))?.status, 'PAUSED')
})
