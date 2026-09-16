import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildSessionPrompt,
  parseArgs,
  prepareSessionResume,
  resolveSessionPaths,
  shouldLaunchSession,
} from '../../scripts/session-startup.mjs'
import { startSession } from '../../scripts/start-session.mjs'

test('startup CLI parses explicit project and run directories without a global resume target', () => {
  const args = parseArgs(['--resume', '--project-dir', 'project', '--run-dir', 'runs/current'])
  assert.equal(args.resume, true)
  assert.equal(args.projectDir, 'project')
  assert.equal(args.runDir, 'runs/current')

  const paths = resolveSessionPaths(args, 'C:\\workspace')
  assert.deepEqual(paths, {
    projectDir: resolve('C:\\workspace', 'project'),
    runDir: resolve('C:\\workspace', 'project/runs/current'),
  })
  assert.throws(() => parseArgs(['--project-dir', '--resume']), /--project-dir requires a value/)
})

test('resume preparation passes only the selected project and run to the shared read-only preparer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-session-startup-'))
  try {
    const projectDir = join(root, 'project')
    const runDir = join(root, 'run')
    const foreignRun = join(root, 'foreign-run')
    await Promise.all([mkdir(projectDir), mkdir(runDir), mkdir(foreignRun)])
    await writeFile(join(root, 'autoresearch-last-run.json'), JSON.stringify({ lastRunDir: foreignRun }))
    const calls: unknown[] = []
    const result = await prepareSessionResume({ projectDir, runDir }, async (input) => {
      calls.push(input)
      return {
        status: 'resumable',
        reason: 'verified run identity',
        workflow: 'research',
        runDir,
        nextAction: { tool: 'research_run', args: { runDir } },
        runStatus: 'WAITING',
        phase: 'experiment',
      }
    })
    assert.equal(result.status, 'resumable')
    assert.deepEqual(calls, [{ intent: 'resume', projectDir, runDir }])
    assert.equal(result.nextAction?.args.runDir, runDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resume preparation uses the real startup preparer for a verified run and reports ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-session-startup-real-'))
  try {
    const projectDir = join(root, 'project')
    const runsRoot = join(projectDir, '.autoresearch', 'runs')
    const projectId = (value: string) => createHash('sha256').update(JSON.stringify({ projectDir: resolve(value) })).digest('hex')
    const writeRun = async (name: string) => {
      const runDir = join(runsRoot, name)
      await mkdir(join(runDir, '.autoresearch'), { recursive: true })
      await writeFile(join(runDir, '.autoresearch', 'project-identity.json'), JSON.stringify({ version: 1, projectDir: resolve(projectDir), projectId: projectId(projectDir), workflow: 'project-paper' }))
      await writeFile(join(runDir, 'state.json'), JSON.stringify({ schema: 'autoresearch/run-state/v1', runId: name, runDir, status: 'RUNNING', phase: 'work', cycle: 1, stepId: 'work', planVersion: 1, updatedAt: new Date().toISOString() }))
    }
    await writeRun('run-1')
    const resumed = await prepareSessionResume({ projectDir })
    assert.equal(resumed.status, 'resumable')
    assert.equal(resumed.workflow, 'project-paper')
    assert.equal(resumed.nextAction?.tool, 'project_paper_run')

    await writeRun('run-2')
    const ambiguous = await prepareSessionResume({ projectDir })
    assert.equal(ambiguous.status, 'needs-input')
    assert.match(ambiguous.reason, /multiple verified active runs/)
    assert.equal(ambiguous.nextAction, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup prompt executes a prepared action and preserves WAITING versus PAUSED and terminal recovery rules', () => {
  const resumable = buildSessionPrompt({
    projectDir: 'C:\\workspace',
    runDir: 'C:\\workspace\\.autoresearch\\runs\\r1',
    preparation: {
      status: 'resumable',
      reason: 'verified run identity',
      runStatus: 'WAITING',
      phase: 'experiment',
      nextAction: { tool: 'research_run', args: { runDir: 'C:\\workspace\\.autoresearch\\runs\\r1' } },
    },
  })
  assert.match(resumable, /research_run/)
  assert.match(resumable, /WAITING/)
  assert.match(resumable, /same run/i)

  const paused = buildSessionPrompt({
    projectDir: 'C:\\workspace',
    preparation: { status: 'blocked', reason: 'PAUSED: budget requires resolution', runStatus: 'PAUSED' },
  })
  assert.match(paused, /do not retry/i)
  assert.match(paused, /budget requires resolution/)

  const terminal = buildSessionPrompt({
    projectDir: 'C:\\workspace',
    preparation: { status: 'terminal', reason: 'run already completed', runStatus: 'COMPLETED' },
  })
  assert.match(terminal, /terminal/i)
  assert.doesNotMatch(terminal, /Call `research_run`/)
})

test('only resumable preparation may launch DSH', () => {
  assert.equal(shouldLaunchSession({ status: 'resumable' }), true)
  for (const status of ['needs-input', 'blocked', 'terminal', 'ready']) assert.equal(shouldLaunchSession({ status }), false)
})

test('start-session performs resume preflight before profile installation and refuses an ambiguous choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-session-cli-'))
  try {
    const projectDir = join(root, 'project')
    await mkdir(projectDir)
    let installed = false
    let spawned = false
    const result = await startSession(['--resume', '--project-dir', projectDir], root, {
      prepare: async (input) => {
        assert.deepEqual(input, { intent: 'resume', projectDir })
        return { status: 'needs-input', reason: 'multiple verified runs', candidates: ['r1', 'r2'] }
      },
      ensureProfile: async () => { installed = true },
      spawn: () => { spawned = true; return { status: 0 } },
    })
    assert.equal(result.status, 'blocked')
    assert.equal(result.exitCode, 2)
    assert.equal(installed, false)
    assert.equal(spawned, false)
    assert.match(result.message, /multiple verified runs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('start-session launches with the selected project as DSH cwd after verified resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-session-cli-launch-'))
  try {
    const projectDir = join(root, 'project')
    const runDir = join(root, 'run')
    await Promise.all([mkdir(projectDir), mkdir(runDir)])
    let launch
    const result = await startSession(['--resume', '--project-dir', projectDir, '--run-dir', runDir], root, {
      prepare: async (input) => ({ status: 'resumable', reason: 'verified', nextAction: { tool: 'research_run', args: { runDir: input.runDir } } }),
      ensureProfile: async () => join(root, 'profile'),
      spawn: (...args) => { launch = args; return { status: 0 } },
    })
    assert.equal(result.status, 'launched')
    assert.equal(launch?.[2].cwd, projectDir)
    const launchedArgs = launch?.[1] as string[] | undefined
    assert.equal(launchedArgs?.includes('--profile'), true)
    assert.match(launchedArgs?.at(-1) ?? '', /research_run/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('custom prompt is extended with verified resume action guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-session-cli-prompt-'))
  try {
    const projectDir = join(root, 'project'), runDir = join(root, 'run')
    await Promise.all([mkdir(projectDir), mkdir(runDir)])
    let launch
    await startSession(['--resume', '--project-dir', projectDir, '--run-dir', runDir, '--prompt', 'User context'], root, {
      prepare: async () => ({ status: 'resumable', reason: 'verified', nextAction: { tool: 'paper_pipeline_resume', args: { runDir } } }),
      ensureProfile: async () => join(root, 'profile'),
      spawn: (...args) => { launch = args; return { status: 0 } },
    })
    const launchedArgs = launch?.[1] as string[] | undefined
    assert.equal(launchedArgs?.includes('--profile'), true)
    assert.match(launchedArgs?.at(-1) ?? '', /^User context\n\n/)
    assert.match(launchedArgs?.at(-1) ?? '', /paper_pipeline_resume/)
    assert.match(launchedArgs?.at(-1) ?? '', /selected project workspace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
