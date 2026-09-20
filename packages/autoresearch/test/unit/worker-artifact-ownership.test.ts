import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runWorker } from '../../dist/experiment/steps.js'
import { assessResearchCycle, freezeResearchCycle } from '../../dist/service/research-cycle.js'
import { ResearchStore } from '../../dist/research/store.js'
import { ProjectDirectionMemoryStore } from '../../dist/memory/direction-memory.js'
import { hashBytes, hashContent } from '../../dist/research/records.js'

async function fixture(t: any) {
  const runDir = await mkdtemp(join(tmpdir(), 'worker-ownership-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const workDir = join(runDir, 'work', 'cycle-01')
  await mkdir(workDir, { recursive: true })
  let calls = 0
  let output = 'work/cycle-01/result.txt'
  const provider = { run: async () => {
    calls++
    await mkdir(join(runDir, output, '..'), { recursive: true })
    await writeFile(join(runDir, output), 'worker bytes')
    return { text: '', stopReason: 'completed', structured: { status: 'completed', summary: 'done', artifacts: [output] } }
  } }
  const ctx = createRunContext({ provider }, runDir, await createInitialState(runDir), await ResearchTree.load(runDir), { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal })
  const args = { workDir, planText: 'test', experimentDesign: 'test', minimalVerification: '' }
  return { ctx, runDir, workDir, args, calls: () => calls, output: (path: string) => { output = path } }
}

for (const path of ['input/user.txt', 'logs/restored.log', 'raw/restored.json', 'work/other/result.txt']) test(`plain fresh worker cannot attribute outside issued root: ${path}`, async t => {
  const f = await fixture(t)
  f.output(path)
  await assert.rejects(runWorker(f.ctx, f.args), /work.*root|workDir|ownership/i)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent())?.evidence.some(e => e.artifacts.length), false)
})

test('plain preexisting worker-root file remains unknown even when worker overwrites it', async t => {
  const f = await fixture(t)
  f.output('work/cycle-01/user.json')
  await writeFile(join(f.workDir, 'user.json'), 'user bytes')
  await assert.rejects(runWorker(f.ctx, f.args), /preexisting|ownership|unknown/i)
})

test('cached plain attempt and cached stage reject changed bytes without worker redispatch', async t => {
  const f = await fixture(t)
  const action = await runWorker(f.ctx, f.args)
  await writeFile(join(f.workDir, 'result.txt'), 'changed after admission')
  await assert.rejects(runWorker(f.ctx, f.args), /hash|changed/i)
  await assert.rejects(runWorker(f.ctx, { ...f.args, cachedStage: { result: action } } as any), /hash|changed/i)
  assert.equal(f.calls(), 1)
})

test('cached plain stage cannot substitute a new file outside the issued root', async t => {
  const f = await fixture(t)
  await runWorker(f.ctx, f.args)
  await mkdir(join(f.runDir, 'logs'), { recursive: true })
  await writeFile(join(f.runDir, 'logs/late.txt'), 'restored user file')
  await assert.rejects(runWorker(f.ctx, { ...f.args, cachedStage: { result: { status: 'completed', summary: 'forged', artifacts: ['logs/late.txt'] } } } as any), /work.*root|workDir|ownership/i)
  assert.equal(f.calls(), 1)
})

test('assessment cannot capture arbitrary files without issued worker proof', async t => {
  const f = await fixture(t)
  await freezeResearchCycle(f.ctx, 'test', 'test')
  await writeFile(join(f.workDir, 'result.txt'), 'not dispatched')
  await assert.rejects(assessResearchCycle(f.ctx, { status: 'completed', summary: 'forged', artifacts: [relative(f.runDir, join(f.workDir, 'result.txt'))] }), /root|proof|boundary/i)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent())?.evidence.length, 0)
})

test('plain old raw unknown bytes never become new direction evidence', async t => {
  const f = await fixture(t)
  await mkdir(join(f.runDir, 'raw'))
  await writeFile(join(f.runDir, 'raw/user.json'), 'old raw user bytes')
  f.output('raw/user.json')
  await assert.rejects(runWorker(f.ctx, f.args), /workDir/)
})

test('cached plain stage cannot synthesize a missing boundary or override unknown execution', async t => {
  const f = await fixture(t)
  const action = await runWorker(f.ctx, f.args)
  await rm(join(f.runDir, '.autoresearch/directions/boundaries'), { recursive: true })
  await assert.rejects(runWorker(f.ctx, { ...f.args, cachedStage: { result: action } } as any), /boundary/)
  assert.equal(f.calls(), 1)
})

test('cached plain stage cannot override an unknown attempt', async t => {
  const f = await fixture(t)
  const action = await runWorker(f.ctx, f.args)
  await writeFile(join(f.runDir, 'cycles/cycle-1/attempt.json'), JSON.stringify({ status: 'unknown' }))
  await assert.rejects(runWorker(f.ctx, { ...f.args, cachedStage: { result: action } } as any), /unknown/)
  assert.equal(f.calls(), 1)
})

test('corrupt frozen boundary is an explicit ownership pause', async t => {
  const f = await fixture(t)
  await runWorker(f.ctx, f.args)
  const root = join(f.runDir, '.autoresearch/directions/boundaries')
  const [id] = await readdir(root)
  await writeFile(join(root, id, 'cycle-1.json'), '{corrupt')
  await assert.rejects(runWorker(f.ctx, f.args), (error: any) => error.code === 'EXPERIMENT_PAUSED' && /boundary|ownership/.test(error.message))
  assert.equal(f.calls(), 1)
})

test('cached plain attempt cannot claim a new unregistered issued-root file', async t => {
  const f = await fixture(t)
  const action = await runWorker(f.ctx, f.args)
  await writeFile(join(f.workDir, 'late.txt'), 'post-execution restored user file')
  const forged = { ...action, artifacts: ['work/cycle-01/late.txt'], producer: 'trusted-worker', kind: 'host-proof' }
  await writeFile(join(f.runDir, 'cycles/cycle-1/attempt.json'), JSON.stringify({ status: 'completed', result: forged }))
  await assert.rejects(runWorker(f.ctx, { ...f.args, cachedStage: { result: forged } } as any), /ownership|registered|proof/)
  assert.equal(f.calls(), 1)
})

for (const outcome of ['failed', 'unknown', 'old-metadata', 'corrupt-metadata']) test(`execution/metadata ${outcome} never creates confirmed-error direction memory`, async t => {
  const f = await fixture(t)
  if (outcome.endsWith('metadata')) {
    await freezeResearchCycle(f.ctx, 'test', 'test')
    await writeFile(join(f.runDir, 'cycles/cycle-1/attempt.json'), outcome === 'corrupt-metadata' ? '{broken' : JSON.stringify({ status: 'completed', result: { status: 'completed', summary: 'old', artifacts: ['raw/user.json'] } }))
  } else {
    f.ctx.deps.provider.run = async () => {
      if (outcome === 'unknown') throw new Error('lost transport')
      return { text: '', stopReason: 'completed', structured: { status: 'failed', summary: 'execution failed', artifacts: [] } }
    }
  }
  await assert.rejects(runWorker(f.ctx, f.args))
  assert.equal((await new ProjectDirectionMemoryStore(f.ctx.projectDir).read()).some(record => record.reasonCode === 'confirmed_error'), false)
})

for (const alias of ['artifact', 'manifest']) test(`round1 case alias in ${alias} cannot promote preexisting worker file`, async t => {
  const f = await fixture(t), file = join(f.workDir, 'user.json')
  await writeFile(file, 'preserved user bytes')
  try { if (await realpath(join(f.workDir, 'USER.json')) !== await realpath(file)) return t.skip('filesystem has distinct case identities') }
  catch { return t.skip('filesystem is case-sensitive') }
  await freezeResearchCycle(f.ctx, 'test', 'test')
  const manifests = (await readdir(join(f.runDir, '.autoresearch/directions'))).filter(name => name.endsWith('.json'))
  const manifestFile = join(f.runDir, '.autoresearch/directions', manifests[0])
  if (alias === 'manifest') {
    const { contentHash: _hash, ...body } = JSON.parse(await readFile(manifestFile, 'utf8'))
    body.artifacts.find(entry => entry.relativePath === 'work/cycle-01/user.json').relativePath = 'work/cycle-01/USER.json'
    await writeFile(manifestFile, JSON.stringify({ ...body, contentHash: hashContent(body) }))
  }
  let calls = 0
  f.ctx.deps.provider.run = async () => { calls++; return { text: '', stopReason: 'completed', structured: { status: 'completed', summary: 'claim user file', artifacts: [`work/cycle-01/${alias === 'artifact' ? 'USER' : 'user'}.json`] } } }
  const before = JSON.parse(await readFile(manifestFile, 'utf8')).artifacts
  await assert.rejects(runWorker(f.ctx, f.args), /preexisting|ownership|unknown/)
  assert.equal(calls, 1)
  assert.equal(await readFile(file, 'utf8'), 'preserved user bytes')
  await assert.rejects(readFile(join(f.runDir, 'research/sources', hashBytes('preserved user bytes'))), { code: 'ENOENT' })
  const after = JSON.parse(await readFile(manifestFile, 'utf8')).artifacts.filter(entry => /user\.json$/i.test(entry.relativePath))
  assert.deepEqual(after, before.filter(entry => /user\.json$/i.test(entry.relativePath)))
  assert.equal((await new ResearchStore(f.runDir).loadCurrent())?.evidence.some(e => e.artifacts.length), false)
})

for (const file of ['attempt.json', 'frozen.json', 'worker-root.json']) test(`round1 corrupt cached ${file} is an explicit pause without redispatch`, async t => {
  const f = await fixture(t)
  const action = await runWorker(f.ctx, f.args)
  await writeFile(join(f.runDir, 'cycles/cycle-1', file), '{broken')
  for (const args of [f.args, { ...f.args, cachedStage: { result: action } }]) {
    await assert.rejects(runWorker(f.ctx, args), (error: any) => error.code === 'EXPERIMENT_PAUSED')
  }
  assert.equal(f.calls(), 1)
})
