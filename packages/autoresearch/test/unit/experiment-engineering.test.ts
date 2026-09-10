import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildPrompt, outputSchemaFor } from '../../dist/agents/factory.js'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName, RoleOutput } from '../../dist/agents/types.js'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

const context = (): RoleExecutionContext => ({
  parent: { id: 'experiment-engineering-test', session: { id: 'experiment-engineering-test' } },
  signal: new AbortController().signal,
})

test('prompt factory delivers shared engineering guidance only to experiment roles from an arbitrary run directory', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-experiment-prompt-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const relevant: RoleName[] = [
    'planner',
    'research-worker',
    'experiment-designer',
    'experiment-reflexion',
    'minimal-verifier',
    'evidence-agent',
    'supervisor',
  ]

  for (const role of relevant) {
    const prompt = await buildPrompt(role, { runDir })
    assert.match(prompt, /Lightweight experiment engineering/i, `${role} missed shared guidance`)
    assert.match(prompt, /experiment\/README\.md/)
  }
  assert.doesNotMatch(await buildPrompt('writer', { runDir }), /Lightweight experiment engineering/i)
})

test('worker prompt receives its cycle work directory and plugin-owned Python guidance', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-worker-prompt-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const workDir = join(runDir, 'work', 'cycle-03')

  const prompt = await buildPrompt('research-worker', { runDir, workDir })

  assert.match(prompt, /## Work directory/)
  assert.match(prompt, new RegExp(workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, /Python experiment code/i)
  assert.doesNotMatch(prompt, /prompts\/python_/)
})

test('designer accepts an optional engineering plan and sees the previous design during redesign', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-designer-prompt-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const schema = outputSchemaFor('experiment-designer') as {
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: boolean
  }

  assert.ok(schema.properties.engineeringPlan)
  assert.equal(schema.required.includes('engineeringPlan'), false)
  assert.equal(schema.additionalProperties, false)
  const prompt = await buildPrompt('experiment-designer', {
    runDir,
    experimentDesign: 'previous-design-marker',
    reflexion: 'redesign feedback',
  })
  assert.match(prompt, /### Experiment Design\s+previous-design-marker/)
})

test('minimal workflow forwards workDir to the worker and evidence to the supervisor', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-minimal-engineering-'))
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

  await runExperimentTask({ provider }, {
    runDir,
    task: 'Exercise runtime context forwarding',
    maxRounds: 1,
    agentContext: context(),
  })

  const worker = provider.inputs.find((call) => call.role === 'research-worker')?.input
  const supervisor = provider.inputs.find((call) => call.role === 'supervisor')?.input
  assert.equal(worker?.workDir, resolve(runDir, 'work', 'experiment-cycle-01'))
  assert.match(supervisor?.reflexion ?? '', /Minimal Evidence 1/)
  assert.match(supervisor?.reflexion ?? '', /worker summary/i)
  const renderedSupervisor = await buildPrompt('supervisor', supervisor!)
  assert.match(renderedSupervisor, /### Reflexion\s+# Minimal Evidence 1/)
  assert.match(renderedSupervisor, /worker summary/i)
})

class RedesignProvider extends FakeAgentProvider implements RoleAgentProvider {
  private designCalls = 0
  private reflexionCalls = 0

  constructor() {
    super({ decisions: ['finish'] })
  }

  override async run(role: RoleName, input: RoleInput, executionContext: RoleExecutionContext): Promise<RoleOutput> {
    if (role === 'experiment-designer') {
      this.calls.push(role)
      this.inputs.push({ role, input })
      this.designCalls += 1
      const revised = this.designCalls > 1
      return {
        text: '',
        structured: {
          datasets: ['real-dataset'],
          conflictConstruction: revised ? 'revised-design-marker' : 'initial-design-marker',
          splitProtocol: 'source split',
          backbones: ['model-a', 'model-b'],
          metrics: ['accuracy'],
          rootCauseValidation: 'cross-model comparison',
          limitations: [],
          engineeringPlan: revised ? 'revised engineering layout' : 'initial engineering layout',
        },
        stopReason: 'completed',
      }
    }
    if (role === 'experiment-reflexion') {
      this.calls.push(role)
      this.inputs.push({ role, input })
      this.reflexionCalls += 1
      return {
        text: '',
        structured: {
          feasibility: 'high',
          generalizability: 'high',
          risks: [],
          failureDirections: [],
          verdict: this.reflexionCalls === 1 ? 'revise' : 'proceed',
        },
        stopReason: 'completed',
      }
    }
    return super.run(role, input, executionContext)
  }
}

test('standalone full workflow saves and executes the design returned by reflexion', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-redesign-forwarding-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const provider = new RedesignProvider()

  await runExperimentTask({ provider }, {
    runDir,
    task: 'Exercise redesigned experiment propagation',
    maxRounds: 1,
    agentContext: context(),
  })

  const workerDesign = provider.inputs.find((call) => call.role === 'research-worker')?.input.experimentDesign ?? ''
  assert.match(workerDesign, /revised-design-marker/)
  assert.doesNotMatch(workerDesign, /initial-design-marker/)
  const stage = await readFile(join(runDir, '.autoresearch', 'experiment-1-design.json'), 'utf8')
  assert.match(stage, /revised-design-marker/)
})

test('both standalone planner paths receive bounded outer orchestration constraints', async (t) => {
  for (const mode of ['legacy', 'minimal'] as const) {
    const runDir = await mkdtemp(join(tmpdir(), `ar-runtime-constraints-${mode}-`))
    t.after(() => rm(runDir, { recursive: true, force: true }))
    await mkdir(join(runDir, '.autoresearch'), { recursive: true })
    await writeFile(join(runDir, '.autoresearch', 'project-settings.yaml'), [
      'version: 2',
      'model:',
      '  useGlobal: true',
      'modelRouting:',
      '  enabled: false',
      'workflow:',
      `  mode: ${mode}`,
      '  experimentReview: never',
      '  paper: never',
    ].join('\n') + '\n', 'utf8')
    const provider = new FakeAgentProvider({ decisions: ['finish'] })
    await runExperimentTask({ provider }, {
      runDir, task: 'Plan several experiment-internal seeds', maxRounds: 2, agentContext: context(),
    })
    const input = provider.inputs.find((call) => call.role === 'planner')?.input as RoleInput & { runtimeConstraints?: string }
    assert.match(input.runtimeConstraints ?? '', new RegExp(`workflow mode: ${mode}`))
    assert.match(input.runtimeConstraints ?? '', /maximum outer cycles\/rounds: 2/)
    assert.match(input.runtimeConstraints ?? '', /outer role model routing: disabled/)
    assert.match(input.runtimeConstraints ?? '', /inherited; provider and model are unknown/i)
  }
})
