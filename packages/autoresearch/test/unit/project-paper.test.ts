import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'ar-project-paper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project'), runDir = join(root, 'run')
  await mkdir(projectDir); await mkdir(runDir)
  await writeFile(join(projectDir, 'README.md'), '# Existing project\nA deterministic implementation.\n')
  await writeFile(join(projectDir, 'report.md'), 'Historical result: accuracy 99%. Not independently verified.\n')
  return { root, projectDir, runDir }
}

test('inventory bounds source bytes, excludes secrets and captures immutable sources', async t => {
  const { captureProjectInventory, validateProjectInventory } = await import('../../dist/project/inventory.js')
  const { projectDir, runDir } = await fixture(t)
  await writeFile(join(projectDir, '.env'), 'PRIVATE_SECRET=never-send')
  await writeFile(join(projectDir, 'credentials.json'), '{"password":"never-send"}')
  await writeFile(join(projectDir, 'large.ts'), 'x'.repeat(500))
  await writeFile(join(projectDir, 'raw.bin'), Buffer.from([0, 1, 2]))
  const packet = await captureProjectInventory(projectDir, runDir, { maxFiles: 3, maxFileBytes: 200, maxTotalBytes: 300, maxDepth: 3, maxEntries: 50 })
  assert.deepEqual(packet.files.map(f => f.relativePath), ['README.md', 'report.md'])
  assert.ok(packet.omissions.some(o => o.reason === 'secret-or-config'))
  assert.ok(packet.omissions.some(o => o.reason === 'file-byte-limit'))
  for (const file of packet.files) assert.equal(await readFile(join(runDir, file.source.path!), 'utf8'), await readFile(join(projectDir, file.relativePath), 'utf8'))
  await validateProjectInventory(packet, projectDir, runDir)
  await writeFile(join(projectDir, 'README.md'), 'changed')
  await assert.rejects(() => validateProjectInventory(packet, projectDir, runDir), /changed|hash/)
})

test('inventory refuses escaping source refs and never follows directory symlinks', async t => {
  const { captureProjectInventory, validateProjectInventory } = await import('../../dist/project/inventory.js')
  const { root, projectDir, runDir } = await fixture(t)
  await symlink(runDir, join(projectDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const packet = await captureProjectInventory(projectDir, runDir)
  assert.ok(packet.omissions.some(o => o.reason === 'symlink'))
  const forged = structuredClone(packet)
  forged.files[0].relativePath = '../outside.md'
  await writeFile(join(root, 'outside.md'), 'untrusted')
  await assert.rejects(() => validateProjectInventory(forged, projectDir, runDir), /inventory|escape|hash/)
})

const proposal = (sourceId: string) => ({ contributions: [{ id: 'c1', claim: 'Implementation may improve repeatability', status: 'proposed', sourceIds: [sourceId], limitations: ['Historical accuracy is unverified'], validation: ['Compare against a baseline on fresh held-out data'], researchQuestion: 'Does the implementation improve repeatability?' }], historicalResults: [{ statement: 'The report claims 99% accuracy', sourceIds: [sourceId], status: 'unverified' }], selectedId: 'c1', selectionReason: 'Bounded falsifiable comparison' })

test('discovery rejects invented references and keeps historical results unverified', async t => {
  const { discoverProject } = await import('../../dist/project/discovery.js')
  const { projectDir, runDir } = await fixture(t)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal, projectDir, runId: 'run-test' }
  await assert.rejects(() => discoverProject({ run: async () => ({ structured: proposal('invented'), text: '', stopReason: 'completed' }) }, runDir, projectDir, context), /unknown source/)
  let calls = 0
  const provider = { run: async (_role: string, input: { projectInventory?: string }) => {
    calls++
    const packet = JSON.parse(input.projectInventory!)
    return { structured: proposal(packet.files[0].source.id), text: '', stopReason: 'completed' }
  } }
  const first = await discoverProject(provider, runDir, projectDir, context)
  assert.equal(first.discovery.historicalResults[0].status, 'unverified')
  assert.match(await readFile(join(runDir, 'input', 'idea.md'), 'utf8'), /unverified/)
  await discoverProject(provider, runDir, projectDir, context)
  assert.equal(calls, 1)
  await writeFile(join(runDir, 'input', 'idea.md'), 'tampered candidate')
  await assert.rejects(() => discoverProject(provider, runDir, projectDir, context), /candidate/)
})

test('project-paper service freezes intent, restores scope on resume and rejects identity mismatch', async t => {
  const { AutoResearchService } = await import('../../dist/service/autoresearch-service.js')
  const { projectDir, runDir, root } = await fixture(t)
  t.mock.method(os, 'homedir', () => root)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const calls: string[] = []
  const provider = { run: async (role: string, input: { projectInventory?: string }, context: any) => {
    calls.push(role)
    assert.equal(context.projectDir, projectDir)
    assert.ok(context.requestLedger)
    assert.equal(context.policySnapshot.workflow.paper, 'enabled')
    assert.equal(context.policySnapshot.workflow.brainstorm, 'never')
    if (role === 'project-explorer') return { structured: proposal(JSON.parse(input.projectInventory!).files[0].source.id), text: '', stopReason: 'completed' }
    throw new Error('validation-stop')
  } }
  const service = new AutoResearchService(provider)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  await assert.rejects(() => service.runProjectPaper({ projectDir, runDir, maxCycles: 1 }, context), /validation-stop/)
  await assert.rejects(() => service.resume({ runDir }, context), /validation-stop/)
  assert.equal(calls.filter(r => r === 'project-explorer').length, 1)
  await assert.rejects(() => service.resume({ runDir, projectDir: root }, context), /project identity/)
  assert.match(await readFile(join(runDir, 'input', 'candidate.md'), 'utf8'), /fresh held-out/)
})

test('project-paper tool binds relative workspace paths and requires a caller and project', async t => {
  const { createProjectPaperRunTool, bindToolWorkspacePaths } = await import('../../dist/tools/index.js')
  const { root } = await fixture(t)
  let received: any
  const service = { runProjectPaper: async (options: any) => { received = options; return { status: 'PAUSED' } } }
  const tool = bindToolWorkspacePaths(createProjectPaperRunTool(service as never), () => root)
  const exec = { agent: { id: 'parent' } as never, signal: new AbortController().signal }
  await tool.execute({ projectDir: 'project', runDir: 'run', maxCycles: 2, paper: { assurance: 'draft' } }, exec)
  assert.equal(received.projectDir, join(root, 'project'))
  assert.equal(received.runDir, join(root, 'run'))
  await assert.rejects(() => tool.execute({ projectDir: 'project', runDir: 'run' }, { signal: exec.signal }), /calling DSH agent/)
  await assert.rejects(() => tool.execute({ runDir: 'run' }, exec), /projectDir/)
})

test('project-explorer host dispatch explicitly denies all tools', async t => {
  const { SubagentRoleAgentProvider } = await import('../../dist/providers/subagent-provider.js')
  const { openRequestLedger } = await import('../../dist/policy/request-ledger.js')
  const { runDir } = await fixture(t)
  const ledger = await openRequestLedger({ runDir, runId: 'explorer-test', config: { maxInputTokens: 24000, maxOutputTokens: 8000, maxRunTokens: 50000, maxRoleCalls: 2, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  let request: any
  const runtime = { start: async (_name: string, options: any) => {
    request = options
    return { id: 'child', result: Promise.resolve({ output: [{ type: 'text', text: JSON.stringify(proposal('project:README.md')) }], stopReason: 'completed' }), dispose: async () => {} }
  } }
  await new SubagentRoleAgentProvider(runtime as never).run('project-explorer', { runDir, projectInventory: '{}' }, { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal, requestLedger: ledger, runId: 'explorer-test' })
  assert.deepEqual(request.toolFilter, { allow: [] })
  assert.equal((await ledger.snapshot()).totals.roleStarts, 1)
})

test('inventory checkpoints reject missing immutable sources and bound count/depth/total coverage', async t => {
  const { captureProjectInventory, validateProjectInventory } = await import('../../dist/project/inventory.js')
  const { projectDir, runDir } = await fixture(t)
  await mkdir(join(projectDir, 'src', 'nested'), { recursive: true })
  await writeFile(join(projectDir, 'src', 'nested', 'deep.ts'), 'export const value = 1')
  const limited = await captureProjectInventory(projectDir, runDir, { maxFiles: 1, maxDepth: 1 })
  assert.equal(limited.files.length, 1)
  assert.ok(limited.omissions.some(o => o.reason === 'file-count-limit'))
  assert.ok(limited.omissions.some(o => o.reason === 'depth-limit'))
  const byteLimited = await captureProjectInventory(projectDir, runDir, { maxTotalBytes: 50 })
  assert.ok(byteLimited.totalBytes <= 50)
  assert.ok(byteLimited.omissions.some(o => o.reason === 'total-byte-limit'))
  const entryLimited = await captureProjectInventory(projectDir, runDir, { maxEntries: 1 })
  assert.equal(entryLimited.files.length, 0)
  assert.ok(entryLimited.omissions.some(o => o.reason.startsWith('entry-limit')))
  await rm(join(runDir, limited.files[0].source.path!))
  await assert.rejects(() => validateProjectInventory(limited, projectDir, runDir), /ENOENT/)
})

test('known response survives output interruption and unknown dispatch never silently repeats', async t => {
  const { discoverProject } = await import('../../dist/project/discovery.js')
  const { projectDir, runDir } = await fixture(t)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  let calls = 0
  const provider = { run: async (_role: string, input: any) => { calls++; return { structured: proposal(JSON.parse(input.projectInventory).files[0].source.id), text: '', stopReason: 'completed' } } }
  await discoverProject(provider, runDir, projectDir, context)
  await rm(join(runDir, 'input', 'project-discovery.json'))
  await rm(join(runDir, 'input', 'idea.md'))
  await discoverProject(provider, runDir, projectDir, context)
  assert.equal(calls, 1)
  const nextRun = join(runDir, 'another'); await mkdir(nextRun)
  await assert.rejects(() => discoverProject({ run: async () => { throw new Error('transport-interrupted') } }, nextRun, projectDir, context), /transport-interrupted/)
  await assert.rejects(() => discoverProject(provider, nextRun, projectDir, context), /outcome unknown/)
  assert.equal(calls, 1)
})

test('project workflow reaches the ordinary paper pipeline and resumes with source scope', async t => {
  const { AutoResearchService } = await import('../../dist/service/autoresearch-service.js')
  const { DEFAULT_PROJECT_SETTINGS, saveProjectSettings } = await import('../../dist/settings/project-settings.js')
  const { FakeAgentProvider } = await import('../integration/fake-agent-provider.ts')
  const { ResearchTree } = await import('../../dist/core/research-tree.js')
  const { projectDir, runDir, root } = await fixture(t)
  t.mock.method(os, 'homedir', () => root); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.workflow.mode = 'minimal'; settings.workflow.paper = 'never'; settings.workflow.brainstorm = 'enabled'
  await saveProjectSettings(projectDir, settings)
  const fake = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'low', throwOnRole: 'paper-planner' })
  let discoveries = 0
  const provider = { run: async (role: any, input: any, context: any) => {
    assert.equal(context.projectDir, projectDir)
    if (role === 'project-explorer') { discoveries++; return { structured: proposal(JSON.parse(input.projectInventory).files[0].source.id), text: '', stopReason: 'completed' } }
    const output = await fake.run(role, input, context)
    if (role === 'research-worker') {
      const tree = await ResearchTree.load(runDir)
      tree.add('evidence', 'Fixture engineering observation, scientifically unverified', { status: 'inconclusive', parent: tree.query({ kind: 'hypothesis' })[0]!.id })
      await tree.save()
    }
    return output
  } }
  const service = new AutoResearchService(provider)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  await assert.rejects(() => service.runProjectPaper({ runDir, projectDir, maxCycles: 1, humanReview: 'off' }, context), /fake paper-planner failure/)
  assert.ok(fake.calls.includes('research-worker'))
  assert.ok(fake.calls.includes('supervisor'))
  assert.ok(fake.calls.includes('paper-planner'))
  assert.equal((await service.status(runDir))?.phase, 'paper')
  const checkpoint = JSON.parse(await readFile(join(runDir, 'paper', 'pipeline_checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.schema, 'autoresearch/paper-pipeline-checkpoint/v1')
  await assert.rejects(() => service.resume({ runDir, humanReview: 'off' }, context), /fake paper-planner failure/)
  assert.equal(discoveries, 1)
  assert.equal(fake.calls.filter(role => role === 'research-worker').length, 1)
  assert.equal(fake.calls.filter(role => role === 'supervisor').length, 1)
})

test('terminal project resume still rejects changed required source bytes', async t => {
  const { AutoResearchService } = await import('../../dist/service/autoresearch-service.js')
  const { saveState } = await import('../../dist/core/state.js')
  const { projectDir, runDir, root } = await fixture(t)
  t.mock.method(os, 'homedir', () => root); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const provider = { run: async (role: string, input: any) => {
    if (role === 'project-explorer') return { structured: proposal(JSON.parse(input.projectInventory).files[0].source.id), text: '', stopReason: 'completed' }
    throw new Error('validation-stop')
  } }
  const service = new AutoResearchService(provider)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  await assert.rejects(() => service.runProjectPaper({ runDir, projectDir }, context), /validation-stop/)
  const state = (await service.status(runDir))!
  state.status = 'COMPLETED'; await saveState(runDir, state)
  await writeFile(join(projectDir, 'README.md'), 'changed required source')
  await assert.rejects(() => service.resume({ runDir }, context), /changed|hash/)
})

test('simultaneous discovery requests cannot dispatch a duplicate explorer', async t => {
  const { discoverProject } = await import('../../dist/project/discovery.js')
  const { projectDir, runDir } = await fixture(t)
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal }
  let calls = 0, release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const provider = { run: async (_role: string, input: any) => { calls++; await ready; return { structured: proposal(JSON.parse(input.projectInventory).files[0].source.id), text: '', stopReason: 'completed' } } }
  const first = discoverProject(provider, runDir, projectDir, context)
  const second = discoverProject(provider, runDir, projectDir, context)
  setTimeout(release, 50)
  const results = await Promise.allSettled([first, second])
  assert.equal(calls, 1)
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
})
