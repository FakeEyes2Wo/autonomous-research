import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { generalRoleSpecs } from '../../dist/agents/roles/general.js'

const load = () => import('../../dist/experiment/task-graph.js')
const budget = { wallMs: 10000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 1000, maxArtifactBytes: 1000 }
function task(id: string, dependsOn: string[] = [], stage = 'prepare') {
  return { id, dependsOn, stage, protocolHash: 'protocol', inputHash: id, validatorId: 'artifact_integrity_v1',
    job: { id, taskId: id, attemptId: id, protocolHash: 'protocol', inputHash: id, executable: process.execPath, args: ['script.mjs'], cwd: process.cwd(), env: {}, budget, checkpoint: null } }
}
test('graph readiness requires matching dependency content and rejects cycles', async () => {
  const api = await load().catch(() => undefined)
  assert.ok(api, 'task graph API is implemented')
  const tasks = [task('prepare'), task('baseline', ['prepare'], 'baseline'), task('formal', ['baseline'], 'formal')]
  const completed = { taskId: 'prepare', protocolHash: 'protocol', inputHash: 'prepare' }
  assert.deepEqual(api.readyTasks(tasks, [completed]).map(t => t.id), ['baseline'])
  assert.ok(!api.readyTasks(tasks, [{ ...completed, inputHash: 'changed' }]).some(t => t.id === 'baseline'))
  assert.throws(() => api.validateTaskGraph([{ ...tasks[0], dependsOn: ['formal'] }, ...tasks.slice(1)]), /TASK_GRAPH_CYCLE/)
})
test('dependency changes invalidate all descendants even when caller retains stale input labels', async () => {
  const api = await load().catch(() => undefined)
  assert.ok(api, 'task graph API is implemented')
  const tasks = [task('prepare'), task('baseline', ['prepare']), task('formal', ['baseline'])]
  const first = api.taskContentHashes(tasks)
  const changed = structuredClone(tasks); changed[0].job.args.push('--different')
  const next = api.taskContentHashes(changed)
  for (const id of ['prepare', 'baseline', 'formal']) assert.notEqual(first[id], next[id])
  assert.throws(() => api.validateTaskGraph([task('a', ['missing'])]), /DEPENDENCY/)
  assert.throws(() => api.validateTaskGraph([task('a'), task('a')]), /DUPLICATE/)
})
test('durable planner output schema is accepted by the native DSH schema validator', () => {
  assert.ok(generalRoleSpecs.planner.outputSchema.properties.taskGraph)
  assert.doesNotThrow(() => assertObjectJsonSchema(generalRoleSpecs.planner.outputSchema))
})
test('valid task IDs overlapping object prototype names still receive content hashes', async () => {
  const api = await load()
  assert.match(api.taskContentHashes([task('constructor')]).constructor, /^[a-f0-9]{64}$/)
})
