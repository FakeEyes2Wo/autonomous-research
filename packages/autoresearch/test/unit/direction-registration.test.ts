import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashBytes, hashContent } from '../../dist/research/records.js'
import { taskContentHashes } from '../../dist/experiment/task-graph.js'
import { directionId } from '../../dist/cleanup/direction-id.js'
import { loadDirectionManifest, openDirectionManifest } from '../../dist/cleanup/manifest.js'
import { registerDirectionCycleArtifacts, registerDirectionGeneration, reserveDirectionCycleBoundary } from '../../dist/cleanup/registration.js'

const directionFor = (runDir: string) => ({ projectId: runDir, branchId: 'branch', claim: { id: 'claim', version: 1 }, hypothesis: { id: 'hypothesis', version: 1 }, protocolHash: 'protocol-v1' })

async function fixture(fn: (runDir: string) => Promise<void>): Promise<void> {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-direction-registration-'))
  try { await fn(runDir) } finally { await rm(runDir, { recursive: true, force: true }) }
}

test('registration freezes user baseline, records both work layouts, and protects mixed roots', async () => fixture(async runDir => {
  const direction = directionFor(runDir)
  const manifest = await openDirectionManifest(runDir, direction)
  await mkdir(join(runDir, 'work'), { recursive: true })
  await mkdir(join(runDir, 'paper'), { recursive: true })
  await writeFile(join(runDir, 'work', 'user-code.py'), 'user code')
  await writeFile(join(runDir, 'paper', 'user-draft.md'), 'user draft')
  await mkdir(join(runDir, 'work', 'cycle-01'), { recursive: true })
  await mkdir(join(runDir, 'logs'), { recursive: true })
  await mkdir(join(runDir, 'cache'), { recursive: true })
  await writeFile(join(runDir, 'work', 'cycle-01', 'user.txt'), 'user')
  await writeFile(join(runDir, 'logs', 'run.log'), 'existing log')
  await writeFile(join(runDir, 'cache', 'existing.bin'), 'existing cache')
  await reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: manifest.id })
  await reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: manifest.id })

  await mkdir(join(runDir, 'cycles', 'cycle-1'), { recursive: true })
  await mkdir(join(runDir, 'work', 'experiment-cycle-01'), { recursive: true })
  await mkdir(join(runDir, 'runtime', 'graphs', 'cycle-1'), { recursive: true })
  const task = { id: 'task-1', dependsOn: [], protocolHash: direction.protocolHash, inputHash: 'input', stage: 'prepare', job: { id: 'job-1', taskId: 'task-1', attemptId: 'attempt-1', protocolHash: direction.protocolHash, inputHash: 'input', executable: process.execPath, args: [], cwd: runDir, env: {}, budget: { wallMs: 1, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 100, maxArtifactBytes: 100 }, checkpoint: null }, validatorId: 'validator', inputs: [], outputs: [{ relativePath: 'out.txt', kind: 'result', maxBytes: 100 }], split: 'development', exposure: 'development' }
  const graphBody = { schema: 'autoresearch/task-graph/v1' as const, id: 'cycle-1', goal: 'test', snapshotId: 'snapshot', snapshotHash: 'snapshot-hash', protocolHash: direction.protocolHash, tasks: [task], contentHashes: taskContentHashes([task]), sourceRefs: [], budget: { maxConcurrentJobs: 1, maxReservedWallMs: 1, totalWallMs: 1 } }
  await writeFile(join(runDir, 'runtime', 'graphs', 'cycle-1', 'graph.json'), JSON.stringify({ ...graphBody, hash: hashContent(graphBody) }))
  await mkdir(join(runDir, 'runtime', 'jobs', 'jobs', hashBytes('job-1')), { recursive: true })
  await writeFile(join(runDir, 'runtime', 'jobs', 'jobs', hashBytes('job-1'), 'artifact.bin'), 'job artifact')
  await writeFile(join(runDir, 'cycles', 'cycle-1', 'result.json'), 'result')
  await writeFile(join(runDir, 'work', 'experiment-cycle-01', 'generated.py'), 'print(1)')
  await writeFile(join(runDir, 'runtime', 'graphs', 'cycle-1', 'output.json'), 'graph')
  await writeFile(join(runDir, 'logs', 'new.log'), 'new log')
  await writeFile(join(runDir, 'cache', 'new.bin'), 'new cache')
  await writeFile(join(runDir, 'work', 'worker-output.json'), 'worker output')
  await writeFile(join(runDir, 'work', 'receipt-output.json'), 'receipt output')
  await writeFile(join(runDir, 'paper', 'worker-output.md'), 'worker output')
  await writeFile(join(runDir, 'paper', 'receipt-output.md'), 'receipt output')
  await writeFile(join(runDir, 'events.jsonl'), JSON.stringify({ type: 'result', stepId: 'work-1', data: { artifacts: ['work/worker-output.json', 'work/user-code.py', 'paper/worker-output.md', 'paper/user-draft.md'] } }) + '\n')

  const receipt = { schema: 'autoresearch/direction-generation/v1' as const, protocolHash: direction.protocolHash, claim: direction.claim, hypothesis: direction.hypothesis, artifacts: [
    { relativePath: 'work/user-code.py', hash: hashBytes('user code'), kind: 'worker-output', producer: 'worker', ownership: 'direction' as const },
    { relativePath: 'paper/user-draft.md', hash: hashBytes('user draft'), kind: 'worker-output', producer: 'worker', ownership: 'direction' as const },
    { relativePath: 'paper/receipt-output.md', hash: hashBytes('receipt output'), kind: 'worker-output', producer: 'worker', ownership: 'direction' as const },
    { relativePath: 'work/receipt-output.json', hash: hashBytes('receipt output'), kind: 'worker-output', producer: 'worker', ownership: 'direction' as const },
  ] }
  await registerDirectionCycleArtifacts({ runDir, cycle: 1, manifestId: manifest.id, direction, generationReceipt: receipt })
  const saved = await loadDirectionManifest(runDir, manifest.id)
  const byPath = new Map(saved.artifacts.map(artifact => [artifact.relativePath, artifact]))
  assert.equal(saved.artifacts.some(artifact => artifact.relativePath.startsWith('.autoresearch/')), false)
  assert.equal(byPath.get('work/cycle-01/user.txt')?.ownership, 'unknown')
  assert.equal(byPath.get('work/user-code.py')?.ownership, 'unknown')
  assert.equal(byPath.get('paper/user-draft.md')?.ownership, 'unknown')
  assert.equal(byPath.get('work/worker-output.json')?.ownership, 'direction')
  assert.equal(byPath.get('work/receipt-output.json')?.ownership, 'direction')
  assert.equal(byPath.get('paper/worker-output.md')?.ownership, 'unknown')
  assert.equal(byPath.get('paper/receipt-output.md')?.ownership, 'unknown')
  assert.equal(byPath.get('cycles/cycle-1/result.json')?.ownership, 'direction')
  assert.equal(byPath.get('work/experiment-cycle-01/generated.py')?.ownership, 'direction')
  assert.equal(byPath.get('runtime/graphs/cycle-1/output.json')?.ownership, 'direction')
  assert.equal(byPath.get(`runtime/jobs/jobs/${hashBytes('job-1')}/artifact.bin`)?.ownership, 'direction')
  assert.equal(byPath.get('logs/new.log')?.ownership, 'unknown')
  assert.equal(byPath.get('cache/new.bin')?.ownership, 'unknown')
  await reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: manifest.id })
  assert.equal((await loadDirectionManifest(runDir, manifest.id)).artifacts.find(artifact => artifact.relativePath === 'cycles/cycle-1/result.json')?.ownership, 'direction')
}))

test('generation receipt binds frozen lineage and registers mixed-root copies exactly', async () => fixture(async runDir => {
  const direction = directionFor(runDir)
  const manifest = await openDirectionManifest(runDir, direction)
  const copy = join(runDir, 'logs', 'direction-copy.log')
  await mkdir(join(runDir, 'logs'), { recursive: true })
  await writeFile(copy, 'direction copy')
  const bytes = await readFile(copy)
  const receipt = { schema: 'autoresearch/direction-generation/v1' as const, protocolHash: direction.protocolHash, claim: direction.claim, hypothesis: direction.hypothesis, artifacts: [{ relativePath: 'logs/direction-copy.log', hash: hashBytes(bytes), bytes: bytes.byteLength, kind: 'copy', producer: 'controller', ownership: 'direction' as const }] }
  await registerDirectionGeneration({ runDir, manifestId: manifest.id, direction, receipt })
  const saved = await loadDirectionManifest(runDir, manifest.id)
  assert.equal(saved.artifacts.find(artifact => artifact.relativePath === 'logs/direction-copy.log')?.ownership, 'direction')
  await assert.rejects(registerDirectionGeneration({ runDir, manifestId: manifest.id, direction, receipt: { ...receipt, protocolHash: 'wrong' } }), /binding mismatch/)
  assert.equal((await loadDirectionManifest(runDir, manifest.id)).artifacts.length, 1)
}))

test('captured source refs are shared and reused safely by a second direction', async () => fixture(async runDir => {
  const direction = directionFor(runDir)
  const first = await openDirectionManifest(runDir, direction)
  const source = Buffer.from('captured source')
  const exclusive = Buffer.from('exclusive generated capture')
  const sourcePath = 'research/sources/captured'
  const exclusivePath = 'research/sources/exclusive'
  await mkdir(join(runDir, 'research', 'sources'), { recursive: true })
  await writeFile(join(runDir, sourcePath), source)
  await writeFile(join(runDir, exclusivePath), exclusive)
  const snapshot = { source_refs: [{ id: 'source-id', path: sourcePath, hash: hashBytes(source) }], active_claim: direction.claim, active_hypothesis: direction.hypothesis, protocol: { content_hash: direction.protocolHash, source_refs: [] }, claims: [], hypotheses: [], assessment: { claim_status: 'refuted', admissible_evidence_ids: ['failed-evidence'] }, evidence: [{ id: 'failed-evidence', version: 1, protocol_hash: direction.protocolHash, target_claim: direction.claim, source_refs: [], artifacts: [{ id: 'exclusive-id', path: exclusivePath, hash: hashBytes(exclusive) }], validity: 'valid', execution: 'completed', polarity: 'opposes' }] } as never
  await reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: first.id })
  await registerDirectionCycleArtifacts({ runDir, cycle: 1, manifestId: first.id, direction, snapshot })
  const firstSaved = await loadDirectionManifest(runDir, first.id)
  assert.equal(firstSaved.artifacts.find(artifact => artifact.relativePath === sourcePath)?.ownership, 'direction')
  assert.equal(firstSaved.artifacts.find(artifact => artifact.relativePath === sourcePath)?.sourceId, 'source-id')
  assert.equal(firstSaved.artifacts.find(artifact => artifact.relativePath === exclusivePath)?.ownership, 'direction')

  const secondDirection = { ...direction, hypothesis: { id: 'other-hypothesis', version: 1 } }
  const second = await openDirectionManifest(runDir, secondDirection)
  const secondSnapshot = { ...snapshot, active_hypothesis: secondDirection.hypothesis } as never
  await registerDirectionCycleArtifacts({ runDir, cycle: 1, manifestId: second.id, direction: secondDirection, snapshot: secondSnapshot })
  assert.equal((await loadDirectionManifest(runDir, second.id)).artifacts.find(artifact => artifact.relativePath === sourcePath)?.ownership, 'shared')

  const supportedDirection = { ...direction, hypothesis: { id: 'supported-hypothesis', version: 1 } }
  const supported = await openDirectionManifest(runDir, supportedDirection)
  const supportedPath = 'research/sources/supported'
  const supportedBytes = Buffer.from('supported evidence capture')
  await writeFile(join(runDir, supportedPath), supportedBytes)
  const supportedSnapshot = { ...snapshot, active_hypothesis: supportedDirection.hypothesis, assessment: { claim_status: 'supported', admissible_evidence_ids: ['supported-evidence'] }, evidence: [{ id: 'supported-evidence', version: 1, protocol_hash: direction.protocolHash, target_claim: direction.claim, source_refs: [], artifacts: [{ id: 'supported-id', path: supportedPath, hash: hashBytes(supportedBytes) }], validity: 'valid', execution: 'completed', polarity: 'supports' }] } as never
  await registerDirectionCycleArtifacts({ runDir, cycle: 1, manifestId: supported.id, direction: supportedDirection, snapshot: supportedSnapshot })
  assert.equal((await loadDirectionManifest(runDir, supported.id)).artifacts.find(artifact => artifact.relativePath === supportedPath)?.ownership, 'shared')
}))

test('later cycle baseline is captured and symlinked roots fail closed', async () => fixture(async runDir => {
  const direction = directionFor(runDir)
  const manifest = await openDirectionManifest(runDir, direction)
  await reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: manifest.id })
  await mkdir(join(runDir, 'work', 'cycle-02'), { recursive: true })
  await writeFile(join(runDir, 'work', 'cycle-02', 'user.txt'), 'user')
  await reserveDirectionCycleBoundary({ runDir, cycle: 2, manifestId: manifest.id })
  await writeFile(join(runDir, 'work', 'cycle-02', 'new.txt'), 'new')
  await registerDirectionCycleArtifacts({ runDir, cycle: 2, manifestId: manifest.id, direction })
  const saved = await loadDirectionManifest(runDir, manifest.id)
  assert.equal(saved.artifacts.find(artifact => artifact.relativePath === 'work/cycle-02/user.txt')?.ownership, 'unknown')
  assert.equal(saved.artifacts.find(artifact => artifact.relativePath === 'work/cycle-02/new.txt')?.ownership, 'direction')

  const outside = await mkdtemp(join(tmpdir(), 'ar-direction-registration-outside-'))
  try {
    await symlink(outside, join(runDir, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')
    const other = await openDirectionManifest(runDir, { ...direction, hypothesis: { id: 'symlink-hypothesis', version: 1 } })
    await assert.rejects(reserveDirectionCycleBoundary({ runDir, cycle: 1, manifestId: other.id }), /symlink/)
  } finally { await rm(outside, { recursive: true, force: true }) }
}))
