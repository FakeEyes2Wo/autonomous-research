import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInitialState, saveState } from '../../dist/core/state.js'
import { bindRunProject } from '../../dist/service/project-paper.js'
import { apply } from '../../dist/index.js'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'

const signal = new AbortController().signal
const exec = (id: string) => ({ signal, agent: { id } as never })

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-startup-tools-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'a'), b = join(root, 'b')
  await mkdir(a); await mkdir(b)
  return { root, a, b }
}

async function waiting(projectDir: string, name: string) {
  const runDir = join(projectDir, '.autoresearch', 'runs', name)
  await mkdir(runDir, { recursive: true })
  await bindRunProject({ projectDir, runDir })
  const state = await createInitialState(runDir)
  state.status = 'WAITING'
  await saveState(runDir, state)
  return state
}

test('plugin exposes read-only preparation using the calling session workspace', async t => {
  const { a, b } = await fixture(t)
  const registered = new Map<string, any>()
  let modelCalls = 0
  apply({
    tools: { register: (tool: any) => registered.set(tool.name, tool) },
    subagents: { start: () => { modelCalls++; throw new Error('preparation must not dispatch') } },
    commands: { register: () => {} }, userQuestions: { ask: async () => ({ answers: [] }) },
    on: (() => () => {}) as never, llm: {}, provide: () => {},
    sessions: { get: ((id: string) => ({ header: { cwd: id === 'a' ? a : b } })) as never },
  })
  const prepare = registered.get('research_prepare')
  assert.ok(prepare, 'research_prepare must be registered')
  assert.doesNotThrow(() => assertObjectJsonSchema(prepare.parameters))
  assert.doesNotThrow(() => assertObjectJsonSchema(prepare.output.schema))
  assert.equal(prepare.parameters.additionalProperties, false)
  assert.equal('sessionRunDir' in prepare.parameters.properties, false)
  const first = await prepare.execute({ intent: 'research', runDir: '.autoresearch/runs/new' }, exec('a'))
  const second = await prepare.execute({ intent: 'experiment', task: 'Measure latency', runDir: '.autoresearch/runs/new' }, exec('b'))
  assert.equal(first.nextAction.tool, 'research_run')
  assert.equal(first.nextAction.args.projectDir, a)
  assert.equal(first.nextAction.args.runDir, join(a, '.autoresearch', 'runs', 'new'))
  assert.equal(second.nextAction.tool, 'experiment_run')
  assert.equal(second.nextAction.args.projectDir, b)
  assert.equal(second.nextAction.args.task, 'Measure latency')
  assert.equal(modelCalls, 0)
})

test('preparation requires caller context and never substitutes plugin cwd for missing session cwd', async () => {
  const module = await import('../../dist/tools/startup.js').catch(() => undefined)
  assert.ok(module?.createStartupTools, 'startup tool factory must exist')
  const { prepare } = module.createStartupTools(() => undefined)
  await assert.rejects(prepare.execute({ intent: 'resume' }, { signal }), /calling DSH agent/)
  await assert.rejects(prepare.execute({ intent: 'resume' }, exec('a')), /working directory/)
  await assert.rejects(prepare.execute({ intent: 'research', projectDir: '' }, exec('a')), /projectDir/)
})

test('successful run binding resolves ambiguity only in its own session and rechecks project on disk', async t => {
  const { a, b } = await fixture(t)
  const one = await waiting(a, 'one'), two = await waiting(a, 'two')
  const other = await waiting(b, 'other')
  const module = await import('../../dist/tools/startup.js').catch(() => undefined)
  assert.ok(module?.createStartupTools, 'startup tool factory must exist')
  const { prepare, track } = module.createStartupTools(id => id === 'b' ? b : a)
  const completedEngine = { name: 'research_run', description: '', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => two }
  await track(completedEngine).execute({ runDir: two.runDir, projectDir: a }, exec('a'))
  const selected = await prepare.execute({ intent: 'resume' }, exec('a')) as any
  assert.equal(selected.nextAction.args.runDir, two.runDir)
  const unbound = await prepare.execute({ intent: 'resume' }, exec('unbound')) as any
  assert.equal(unbound.status, 'needs-input')
  assert.equal(unbound.nextAction, undefined)
  const foreign = await prepare.execute({ intent: 'resume', projectDir: b }, exec('a')) as any
  assert.equal(foreign.nextAction.args.runDir, other.runDir)
  const explicit = await prepare.execute({ intent: 'resume', runDir: one.runDir }, exec('a')) as any
  assert.equal(explicit.nextAction.args.runDir, one.runDir)
  await writeFile(join(two.runDir, '.autoresearch', 'project-identity.json'), '{}')
  const corrupt = await prepare.execute({ intent: 'resume' }, exec('a')) as any
  assert.equal(corrupt.nextAction, undefined)
})

test('failed execution and unrelated status tools do not change the session resume selection', async t => {
  const { a } = await fixture(t)
  const one = await waiting(a, 'one'), two = await waiting(a, 'two')
  const module = await import('../../dist/tools/startup.js').catch(() => undefined)
  assert.ok(module?.createStartupTools, 'startup tool factory must exist')
  const { prepare, track } = module.createStartupTools(() => a)
  const base = { name: 'research_run', description: '', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => one }
  await track(base).execute({}, exec('a'))
  await assert.rejects(track({ ...base, execute: async () => { throw new Error('failed') } }).execute({ runDir: two.runDir }, exec('a')), /failed/)
  await track({ ...base, name: 'paper_pipeline_status', execute: async () => two }).execute({}, exec('a'))
  const result = await prepare.execute({ intent: 'resume' }, exec('a')) as any
  assert.equal(result.nextAction.args.runDir, one.runDir)
})
