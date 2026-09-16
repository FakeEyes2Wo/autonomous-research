import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { bindRunProject } from '../../dist/service/project-paper.js'

async function race(t: TestContext, input: { differentProject?: boolean; firstWorkflow?: 'project-paper'; secondWorkflow?: 'project-paper' }) {
  const root = await mkdtemp(join(tmpdir(), 'ar-project-identity-'))
  const projectA = join(root, 'project-a'), projectB = join(root, 'project-b'), runDir = join(root, 'run')
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(runDir)])
  t.after(() => rm(root, { recursive: true, force: true }))
  let observed!: () => void, release!: () => void, intercept = true
  const observation = new Promise<void>(resolve => { observed = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const originalReadFile = fs.readFile
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (intercept && String(args[0]).endsWith('project-identity.json')) {
      intercept = false
      try { return await originalReadFile(...args) }
      catch (error) { observed(); await gate; throw error }
    }
    return originalReadFile(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports() })
  // Attach rejection handling immediately, then force both callers to observe the initial absence.
  const first = bindRunProject({ runDir, projectDir: projectA, maxCycles: 3 }, input.firstWorkflow)
    .then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }))
  await observation
  let winner
  try { winner = await bindRunProject({ runDir, projectDir: input.differentProject ? projectB : projectA, maxCycles: 1 }, input.secondWorkflow) }
  finally { release() }
  const loser = await first
  const persisted = JSON.parse(await readFile(join(runDir, '.autoresearch', 'project-identity.json'), 'utf8'))
  return { loser, winner, persisted, runDir }
}

test('first identity publication cannot overwrite a concurrently accepted different project', async t => {
  const { loser, winner, persisted, runDir } = await race(t, { differentProject: true, firstWorkflow: 'project-paper', secondWorkflow: 'project-paper' })
  assert.equal(loser.status, 'rejected')
  if (loser.status === 'rejected') assert.match(String(loser.reason), /project identity mismatch/)
  assert.deepEqual(persisted, winner)
  assert.deepEqual(await bindRunProject({ runDir, projectDir: winner.projectDir }, 'project-paper'), winner)
})

for (const firstWorkflow of [undefined, 'project-paper'] as const) {
  test(`competing ${firstWorkflow ?? 'research'} admission cannot replace another workflow`, async t => {
    const { loser, winner, persisted, runDir } = await race(t, { firstWorkflow, secondWorkflow: firstWorkflow === undefined ? 'project-paper' : undefined })
    assert.equal(loser.status, 'rejected')
    if (loser.status === 'rejected') assert.match(String(loser.reason), /workflow identity mismatch/)
    assert.deepEqual(persisted, winner)
    assert.deepEqual(await bindRunProject({ runDir }), winner)
  })
}

test('duplicate concurrent identities reuse the complete winner and its original options', async t => {
  const { loser, winner, persisted } = await race(t, { firstWorkflow: 'project-paper', secondWorkflow: 'project-paper' })
  assert.equal(loser.status, 'fulfilled')
  if (loser.status === 'fulfilled') assert.deepEqual(loser.value, winner)
  assert.deepEqual(persisted, winner)
  assert.equal(persisted.options.maxCycles, 1)
})
