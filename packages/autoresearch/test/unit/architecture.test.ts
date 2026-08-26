import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

test('idea steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/service/steps/idea.ts'), 'utf8')
  assert.doesNotMatch(source, /export class IdeaSteps/)
  assert.match(source, /export async function ensureRubric/)
  assert.match(source, /export async function runIdeaGeneration/)
})

test('experiment steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/service/steps/experiment.ts'), 'utf8')
  assert.doesNotMatch(source, /export class ExperimentSteps/)
  for (const name of ['runPlanner', 'runExperimentDesign', 'runWorker', 'runSupervisor']) {
    assert.match(source, new RegExp(`export async function ${name}`))
  }
})
