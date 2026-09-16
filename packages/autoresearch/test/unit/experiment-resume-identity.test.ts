import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { bindRunProject } from '../../dist/service/project-paper.js'
import { createInitialState, saveState } from '../../dist/core/state.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

const context = () => ({
  parent: { id: 'agent-1', session: { id: 'agent-1' } },
  signal: new AbortController().signal,
})

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('standalone experiment persists its exact project identity and effective request', async t => {
  const projectDir = await mkdtemp(join(tmpdir(), 'ar-experiment-project-'))
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-run-'))
  t.after(() => Promise.all([rm(projectDir, { recursive: true, force: true }), rm(runDir, { recursive: true, force: true })]))

  await runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    projectDir,
    runDir,
    task: 'Exact experiment task',
    profile: 'Exact experiment profile',
    maxRounds: 3,
    agentContext: context(),
  })

  assert.deepEqual(JSON.parse(await readFile(join(runDir, '.autoresearch', 'project-identity.json'), 'utf8')), {
    version: 1,
    projectDir,
    projectId: hash(JSON.stringify({ projectDir })),
    workflow: 'experiment',
    validation: 'bounded-supplementary',
    options: {},
  })
  assert.deepEqual(JSON.parse(await readFile(join(runDir, '.autoresearch', 'experiment-request.json'), 'utf8')), {
    version: 1,
    task: 'Exact experiment task',
    profile: 'Exact experiment profile',
    maxRounds: 3,
  })
})

test('runDir-only experiment keeps the legacy direct-engine entry point', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-experiment-direct-'))
  const runDir = join(root, 'new-run')
  t.after(() => rm(root, { recursive: true, force: true }))

  const identity = await bindRunProject({ runDir }, 'experiment')
  assert.equal(identity.workflow, 'experiment')
  assert.equal(identity.projectDir, runDir)
})

test('experiment resume recovers omitted inputs and freezes maxRounds', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-request-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const first = new FakeAgentProvider({ decisions: ['finish'] })
  await runExperimentTask({ provider: first }, {
    runDir,
    task: 'Frozen task',
    profile: 'Frozen profile',
    maxRounds: 1,
    agentContext: context(),
  })

  const recovered = await runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir,
    // Startup resume supplies only the run directory.
    agentContext: context(),
  } as never)
  assert.equal(recovered.status, 'completed')
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir,
    task: 'Frozen task',
    profile: 'Frozen profile',
    maxRounds: 2,
    agentContext: context(),
  }), /maxRounds|frozen|different experiment request/i)
})

test('generic research rejects an experiment identity and experiment rejects a research identity', async t => {
  const experimentRun = await mkdtemp(join(tmpdir(), 'ar-experiment-engine-'))
  const researchRun = await mkdtemp(join(tmpdir(), 'ar-research-engine-'))
  t.after(() => Promise.all([rm(experimentRun, { recursive: true, force: true }), rm(researchRun, { recursive: true, force: true })]))

  await bindRunProject({ runDir: experimentRun }, 'experiment')
  await assert.rejects(() => new AutoResearchService(new FakeAgentProvider()).run({ runDir: experimentRun }, context()), /workflow identity mismatch|experiment/i)

  await bindRunProject({ runDir: researchRun })
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir: researchRun,
    task: 'Wrong engine',
    agentContext: context(),
  }), /workflow identity mismatch/i)
})

test('experiment resume rejects a changed project even when task and profile match', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-experiment-project-mismatch-'))
  const projectA = join(root, 'a'), projectB = join(root, 'b'), runDir = join(root, 'run')
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(runDir)])
  t.after(() => rm(root, { recursive: true, force: true }))
  await runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    projectDir: projectA,
    runDir,
    task: 'Same task',
    profile: 'Same profile',
    agentContext: context(),
  })
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    projectDir: projectB,
    runDir,
    task: 'Same task',
    profile: 'Same profile',
    agentContext: context(),
  }), /project identity mismatch/i)
})

test('explicit legacy experiment run remains compatible when manifest task and profile match', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-legacy-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  const state = await createInitialState(runDir)
  state.status = 'COMPLETED'
  await saveState(runDir, state)
  await writeFile(join(runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({
    schema: 'autoresearch/experiment-manifest/v1',
    taskHash: hash('Legacy task'),
    profileHash: hash('Legacy profile'),
  }))

  const result = await runExperimentTask({ provider: new FakeAgentProvider() }, {
    runDir,
    task: 'Legacy task',
    profile: 'Legacy profile',
    maxRounds: 2,
    agentContext: context(),
  })
  assert.equal(result.status, 'completed')
  await assert.rejects(readFile(join(runDir, '.autoresearch', 'project-identity.json')), { code: 'ENOENT' })
})

test('legacy wrong task is rejected before publishing a new project identity', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-legacy-mismatch-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  const state = await createInitialState(runDir)
  state.status = 'PAUSED'
  await saveState(runDir, state)
  await writeFile(join(runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({
    schema: 'autoresearch/experiment-manifest/v1',
    taskHash: hash('Legacy task'),
    profileHash: hash('Legacy profile'),
  }))

  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider() }, {
    runDir,
    task: 'Wrong task',
    profile: 'Legacy profile',
    agentContext: context(),
  }), /different experiment task\/profile/i)
  await assert.rejects(readFile(join(runDir, '.autoresearch', 'project-identity.json')), { code: 'ENOENT' })
})

test('manifest-only legacy experiment cannot be adopted by another explicit engine', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-legacy-engine-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'experiment-manifest.json'), '{}')
  await assert.rejects(() => bindRunProject({ runDir }, 'project-paper'), /workflow identity mismatch/i)
})

test('request-only legacy experiment cannot be adopted by another explicit engine', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-request-only-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'experiment-request.json'), '')
  await assert.rejects(() => bindRunProject({ runDir }, 'project-paper'), /workflow identity mismatch/i)
})

test('request-only experiment metadata cannot recreate its missing manifest', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-request-corrupt-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'experiment-request.json'), JSON.stringify({
    version: 1, task: 'Task', profile: 'Profile', maxRounds: 1,
  }))
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir, agentContext: context(),
  } as never), /missing.*manifest/i)
  await assert.rejects(readFile(join(runDir, '.autoresearch', 'experiment-manifest.json')), { code: 'ENOENT' })
})

test('stateful experiment with a request but no manifest is corrupt', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-missing-manifest-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await bindRunProject({ runDir }, 'experiment')
  const state = await createInitialState(runDir)
  state.status = 'COMPLETED'
  await saveState(runDir, state)
  await writeFile(join(runDir, '.autoresearch', 'experiment-request.json'), JSON.stringify({
    version: 1, task: 'Task', profile: 'Profile', maxRounds: 1,
  }))
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir, task: 'Task', profile: 'Profile', maxRounds: 1, agentContext: context(),
  }), /missing.*manifest/i)
})

test('wrong project rejection does not synchronize existing research outputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-experiment-output-guard-'))
  const projectA = join(root, 'a'), projectB = join(root, 'b'), runDir = join(root, 'run')
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(runDir)])
  t.after(() => rm(root, { recursive: true, force: true }))
  await bindRunProject({ projectDir: projectA, runDir }, 'research')
  const state = await createInitialState(runDir)
  state.status = 'PAUSED'
  await saveState(runDir, state)
  await writeFile(join(runDir, '.autoresearch', 'experiment-request.json'), JSON.stringify({
    version: 1, task: 'Wrong engine project', profile: 'Profile', maxRounds: 1,
  }))
  await writeFile(join(runDir, '.autoresearch', 'experiment-manifest.json'), JSON.stringify({
    schema: 'autoresearch/experiment-manifest/v1',
    taskHash: hash('Wrong engine project'), profileHash: hash('Profile'),
  }))
  const output = join(runDir, 'output')
  await mkdir(output, { recursive: true })
  const marker = join(output, 'marker.txt')
  await writeFile(marker, 'preserve-me')
  // If the rejection path entered the final output synchronizer, this
  // malformed pointer would mask the original identity error.
  await writeFile(join(runDir, 'CURRENT.json'), '{')

  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    projectDir: projectB,
    runDir,
    task: 'Wrong engine project',
    profile: 'Profile',
    agentContext: context(),
  }), /project identity mismatch|workflow identity mismatch/i)
  assert.equal(await readFile(marker, 'utf8'), 'preserve-me')
})

test('empty experiment task cannot become a frozen request', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-empty-task-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir, task: '  ', agentContext: context(),
  }), /non-empty string/i)
  await assert.rejects(readFile(join(runDir, '.autoresearch', 'experiment-request.json')), { code: 'ENOENT' })
})
