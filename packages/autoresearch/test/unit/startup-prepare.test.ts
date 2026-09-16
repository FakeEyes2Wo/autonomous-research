import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareStartup } from '../../dist/startup/prepare.js'

function projectId(projectDir: string): string {
  return createHash('sha256').update(JSON.stringify({ projectDir })).digest('hex')
}

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, status = 'RUNNING', workflow: 'research' | 'project-paper' | 'experiment' = 'research') {
  const root = await mkdtemp(join(tmpdir(), 'ar-startup-'))
  const projectDir = join(root, 'project')
  const runDir = join(projectDir, '.autoresearch', 'runs', 'run-1')
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  const identity = { version: 1, projectDir: resolve(projectDir), projectId: projectId(resolve(projectDir)), workflow }
  await writeFile(join(runDir, '.autoresearch', 'project-identity.json'), JSON.stringify(identity), 'utf8')
  await writeFile(join(runDir, 'state.json'), JSON.stringify({
    schema: 'autoresearch/run-state/v1', runId: 'run-1', runDir, status,
    phase: 'work', cycle: 1, stepId: 'work', planVersion: 1, updatedAt: new Date().toISOString(),
  }), 'utf8')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, projectDir, runDir }
}

test('routes a unique verified local run to its workflow engine', async t => {
  const f = await fixture(t, 'RUNNING', 'project-paper')
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir })
  assert.equal(result.status, 'resumable')
  assert.equal(result.workflow, 'project-paper')
  assert.equal(result.runDir, f.runDir)
  assert.equal(result.nextAction?.tool, 'project_paper_run')
  assert.equal(result.nextAction?.args.runDir, f.runDir)
})

test('prefers a revalidated trusted session run over another local active run', async t => {
  const f = await fixture(t)
  const other = join(f.projectDir, '.autoresearch', 'runs', 'run-2')
  await mkdir(join(other, '.autoresearch'), { recursive: true })
  const identity = { version: 1, projectDir: resolve(f.projectDir), projectId: projectId(resolve(f.projectDir)), workflow: 'research' }
  await writeFile(join(other, '.autoresearch', 'project-identity.json'), JSON.stringify(identity), 'utf8')
  await writeFile(join(other, 'state.json'), JSON.stringify({ schema: 'autoresearch/run-state/v1', runId: 'run-2', runDir: other, status: 'RUNNING', phase: 'work', cycle: 1, stepId: 'work', planVersion: 1, updatedAt: new Date().toISOString() }), 'utf8')
  const corrupt = join(f.projectDir, '.autoresearch', 'runs', 'corrupt')
  await mkdir(join(corrupt, '.autoresearch'), { recursive: true })
  await writeFile(join(corrupt, '.autoresearch', 'project-identity.json'), '{}', 'utf8')
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir }, { sessionRunDir: other })
  assert.equal(result.runDir, other)
})

test('requires explicit choice when local active runs are ambiguous', async t => {
  const f = await fixture(t)
  const other = join(f.projectDir, '.autoresearch', 'runs', 'run-2')
  await mkdir(join(other, '.autoresearch'), { recursive: true })
  const identity = { version: 1, projectDir: resolve(f.projectDir), projectId: projectId(resolve(f.projectDir)), workflow: 'research' }
  await writeFile(join(other, '.autoresearch', 'project-identity.json'), JSON.stringify(identity), 'utf8')
  await writeFile(join(other, 'state.json'), JSON.stringify({ schema: 'autoresearch/run-state/v1', runId: 'run-2', runDir: other, status: 'WAITING', phase: 'work', cycle: 1, stepId: 'work', planVersion: 1, updatedAt: new Date().toISOString() }), 'utf8')
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir })
  assert.equal(result.status, 'needs-input')
  assert.equal(result.nextAction, undefined)
  assert.equal(result.candidates?.length, 2)
})

test('new experiments require an explicit safe run and preserve the exact task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-startup-new-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project')
  await mkdir(projectDir)
  const runDir = join(projectDir, '.autoresearch', 'runs', 'new-run')
  const result = await prepareStartup({ intent: 'experiment', projectDir, runDir, task: 'Measure exact behavior' })
  assert.equal(result.status, 'ready')
  assert.equal(result.nextAction?.tool, 'experiment_run')
  assert.deepEqual(result.nextAction?.args, { runDir, projectDir: resolve(projectDir), task: 'Measure exact behavior' })
})

test('paused runs are blocked without an automatic action', async t => {
  const f = await fixture(t, 'PAUSED')
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(result.status, 'blocked')
  assert.equal(result.runStatus, 'PAUSED')
  assert.equal(result.nextAction, undefined)
})

test('preparation does not write to the project or run', async t => {
  const f = await fixture(t)
  const before = await readFile(join(f.runDir, 'state.json'), 'utf8')
  await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(await readFile(join(f.runDir, 'state.json'), 'utf8'), before)
})

test('routes each explicit new workflow and reports missing experiment input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-startup-routes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project')
  await mkdir(projectDir)
  for (const [intent, tool] of [['research', 'research_run'], ['project-paper', 'project_paper_run']] as const) {
    const runDir = join(root, `${intent}-run`)
    const result = await prepareStartup({ intent, projectDir, runDir })
    assert.equal(result.status, 'ready')
    assert.equal(result.nextAction?.tool, tool)
  }
  const missingTask = await prepareStartup({ intent: 'experiment', projectDir, runDir: join(root, 'experiment-run') })
  assert.equal(missingTask.status, 'needs-input')
  assert.equal(missingTask.nextAction, undefined)
})

test('rejects foreign and occupied explicit new run directories', async t => {
  const f = await fixture(t)
  const foreign = await fixture(t)
  const foreignResult = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: foreign.runDir })
  assert.equal(foreignResult.status, 'blocked')
  assert.match(foreignResult.reason, /identity mismatch/i)
  const occupied = await prepareStartup({ intent: 'research', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(occupied.status, 'blocked')
  assert.match(occupied.reason, /occupied/i)
  const ancestor = await prepareStartup({ intent: 'research', projectDir: f.projectDir, runDir: f.root })
  assert.equal(ancestor.status, 'blocked')
  assert.match(ancestor.reason, /ancestor|distinct/i)
})

test('explicit terminal and identityless or corrupt runs produce no action', async t => {
  const terminal = await fixture(t, 'COMPLETED')
  const terminalResult = await prepareStartup({ intent: 'resume', projectDir: terminal.projectDir, runDir: terminal.runDir })
  assert.equal(terminalResult.status, 'terminal')
  assert.equal(terminalResult.nextAction, undefined)
  const terminalAuto = await prepareStartup({ intent: 'resume', projectDir: terminal.projectDir })
  assert.equal(terminalAuto.status, 'terminal')
  assert.equal(terminalAuto.runDir, terminal.runDir)
  const legacy = await fixture(t)
  await rm(join(legacy.runDir, '.autoresearch', 'project-identity.json'))
  const legacyResult = await prepareStartup({ intent: 'resume', projectDir: legacy.projectDir, runDir: legacy.runDir })
  assert.equal(legacyResult.status, 'blocked')
  const corrupt = await fixture(t)
  await writeFile(join(corrupt.runDir, 'state.json'), '{', 'utf8')
  const corruptResult = await prepareStartup({ intent: 'resume', projectDir: corrupt.projectDir, runDir: corrupt.runDir })
  assert.equal(corruptResult.status, 'blocked')
  assert.equal(corruptResult.nextAction, undefined)
})

test('experiment resume forwards the frozen request only when manifest hashes match', async t => {
  const f = await fixture(t, 'WAITING', 'experiment')
  const profile = '# PROFILE\nlocal only\n'
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
  await writeFile(join(f.runDir, '.autoresearch', 'experiment-request.json'), JSON.stringify({ version: 1, task: 'frozen task', profile, maxRounds: 3 }), 'utf8')
  await writeFile(join(f.runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({ schema: 'autoresearch/experiment-manifest/v1', taskHash: hash('frozen task'), profileHash: hash(profile) }), 'utf8')
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(result.status, 'resumable')
  assert.deepEqual(result.nextAction?.args, { runDir: f.runDir, projectDir: resolve(f.projectDir), task: 'frozen task', profile, maxRounds: 3 })
  const wrong = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir, task: 'changed task' })
  assert.equal(wrong.status, 'blocked')
  await writeFile(join(f.runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({ schema: 'autoresearch/experiment-manifest/v1', taskHash: hash('changed task'), profileHash: hash(profile) }), 'utf8')
  const badManifest = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(badManifest.status, 'blocked')
  await writeFile(join(f.runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({ version: 1, taskHash: hash('frozen task'), profileHash: hash(profile) }), 'utf8')
  const badSchema = await prepareStartup({ intent: 'resume', projectDir: f.projectDir, runDir: f.runDir })
  assert.equal(badSchema.status, 'blocked')
})

test('bounded local discovery refuses to guess after its scan limit', async t => {
  const f = await fixture(t)
  for (let i = 2; i <= 66; i += 1) {
    const runDir = join(f.projectDir, '.autoresearch', 'runs', `run-${i}`)
    await mkdir(join(runDir, '.autoresearch'), { recursive: true })
    const identity = { version: 1, projectDir: resolve(f.projectDir), projectId: projectId(resolve(f.projectDir)), workflow: 'research' }
    await writeFile(join(runDir, '.autoresearch', 'project-identity.json'), JSON.stringify(identity), 'utf8')
    await writeFile(join(runDir, 'state.json'), JSON.stringify({ schema: 'autoresearch/run-state/v1', runId: `run-${i}`, runDir, status: 'COMPLETED', phase: 'work', cycle: 1, stepId: 'work', planVersion: 1, updatedAt: new Date().toISOString() }), 'utf8')
  }
  const result = await prepareStartup({ intent: 'resume', projectDir: f.projectDir })
  assert.equal(result.status, 'needs-input')
  assert.equal(result.nextAction, undefined)
  assert.match(result.reason, /bound/i)
})
