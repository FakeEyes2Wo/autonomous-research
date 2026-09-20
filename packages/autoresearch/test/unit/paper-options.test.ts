import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toResearchRunOptions } from '../../dist/tools/options.js'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('project identity persists layout options and allows explicit budget growth while freezing venue', async t => {
  const { bindRunProject } = await import('../../dist/service/project-paper.js')
  const root = await mkdtemp(join(tmpdir(), 'ar-paper-identity-options-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project'); await mkdir(projectDir)
  const runDir = join(root, 'run')
  const paper = { venue: 'USENIX', layoutInspection: true, supportsImageInput: false, reviewBudget: { maxRequests: 2, maxRounds: 0 } }
  await bindRunProject({ runDir, projectDir, paper }, 'project-paper')
  const saved = JSON.parse(await readFile(join(runDir, '.autoresearch', 'project-identity.json'), 'utf8'))
  assert.deepEqual(saved.options.paper, paper)
  await bindRunProject({ runDir, projectDir, paper: { reviewBudget: { maxRequests: 20 } } }, 'project-paper')
  await assert.rejects(() => bindRunProject({ runDir, projectDir, paper: { venue: 'ICLR' } }, 'project-paper'), /paper options identity/)
})

test('relative custom template directory resolves against calling session cwd', async () => {
  const { bindToolWorkspacePaths } = await import('../../dist/tools/workspace-paths.js')
  const root = join(tmpdir(), 'ar-workspace')
  let options: any
  const tool = bindToolWorkspacePaths({ name: 'test', description: '', parameters: {}, async execute(args: any) { options = args } } as never, () => root)
  await tool.execute({ runDir: join(root, 'run'), paper: { templateDir: 'venue', templateFile: 'sample.tex' } }, { agent: { id: 'parent' } as never, signal: new AbortController().signal })
  assert.equal(options.paper.templateDir, join(root, 'venue'))
  assert.equal(options.paper.templateFile, 'sample.tex')
})

test('paper tool forwards validated layout and review options without arbitrary fields', () => {
  const paper = { venue: 'custom', templateDir: '/template', templateFile: 'sample.tex', layoutInspection: true, supportsImageInput: false, reviewBudget: { maxRequests: 12, maxRounds: 2 }, unknown: 'drop' }
  const { unknown, ...expected } = paper
  assert.deepEqual(toResearchRunOptions({ runDir: '/run', paper }).paper, expected)
})

test('paper tool rejects malformed budget and visual options', () => {
  for (const paper of [{ reviewBudget: { maxRequests: -1 } }, { reviewBudget: { maxRounds: 1.5 } }, { supportsImageInput: 'yes' }, { layoutInspection: 'yes' }]) assert.throws(() => toResearchRunOptions({ runDir: '/run', paper }), /paper|review|image|layout/i)
})
