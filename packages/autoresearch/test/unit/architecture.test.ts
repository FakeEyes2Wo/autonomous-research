import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(full))
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('idea steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/service/steps/idea.ts'), 'utf8')
  assert.doesNotMatch(source, /export class IdeaSteps/)
  assert.match(source, /export async function ensureRubric/)
  assert.match(source, /export async function runIdeaGeneration/)
})

test('experiment steps are functions, not a dependency-holding class', async () => {
  const source = await readFile(join(process.cwd(), 'src/experiment/steps.ts'), 'utf8')
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

test('paper pipeline is a functional checkpoint orchestrator', async () => {
  const source = await readFile(join(process.cwd(), 'src/paper/pipeline.ts'), 'utf8')
  assert.doesNotMatch(source, /export class PaperPipeline/)
  assert.match(source, /export async function runPaperPipeline/)
  const { invalidatePaperCheckpoint } = await import('../../dist/paper/checkpoint.js')
  const checkpoint = { schema: 'autoresearch/paper-pipeline-checkpoint/v1', updated_at: '', assurance: 'submission', phases: { writing: 'done', final: 'done' }, data: { submissionReady: true } }
  invalidatePaperCheckpoint(checkpoint as never, 'current manuscript changed')
  assert.equal(checkpoint.phases.writing, 'done')
  assert.equal(checkpoint.phases.final, 'pending')
  assert.equal(checkpoint.data.submissionReady, false)
})

test('brainstorm orchestration and ranking do not hold dependency attrs', async () => {
  const pipeline = await readFile(join(process.cwd(), 'src/brainstorm/pipeline.ts'), 'utf8')
  const ranking = await readFile(join(process.cwd(), 'src/brainstorm/ranking.ts'), 'utf8')
  assert.doesNotMatch(pipeline, /export class BrainstormPipeline/)
  assert.doesNotMatch(ranking, /export class DefaultRankingStrategy/)
  assert.match(pipeline, /export async function runBrainstorm/)
})

test('removed wrappers and duplicate optional reads cannot return', async () => {
  assert.equal(existsSync(join(process.cwd(), 'src/domain/idea-file.ts')), false)
  const files = await sourceFiles(join(process.cwd(), 'src'))
  const joined = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  assert.doesNotMatch(joined, /readText\([^\n]+\)\.catch\(\(\) => ''\)/)
  assert.doesNotMatch(joined, /export type RoleName\s*=\s*\|/)
})
