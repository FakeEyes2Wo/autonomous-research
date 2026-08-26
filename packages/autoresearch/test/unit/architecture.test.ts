import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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

test('research orchestration has no forwarding classes', async () => {
  for (const file of ['agent-runner.ts', 'research-steps.ts', 'run-session.ts']) {
    assert.equal(existsSync(join(process.cwd(), 'src/service', file)), false)
  }
  const paper = await readFile(join(process.cwd(), 'src/service/steps/paper.ts'), 'utf8')
  assert.doesNotMatch(paper, /export class PaperSteps/)
})

test('paper phases are stateless functions', async () => {
  const source = await readFile(join(process.cwd(), 'src/paper/phases.ts'), 'utf8')
  assert.doesNotMatch(source, /export class PaperPhases/)
  assert.match(source, /export const PAPER_AUDITS/)
  assert.match(source, /export async function writePaper/)
})
