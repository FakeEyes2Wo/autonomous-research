import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fuseActionFinish } from '../../dist/harness/action-fusion.js'
import { estimateContextTokens, renderLabeledContextEntries } from '../../dist/harness/context-budget.js'
import { packObservation, readObservation, readObservationMetadata } from '../../dist/harness/observation-pack.js'
import { createVerifiedReceipt } from '../../dist/harness/verified-receipt.js'

test('action fusion validates all evidence before producing one write plan', () => {
  const plan = fuseActionFinish({
    actionId: 'act-1', status: 'completed', summary: 'done', artifacts: ['result.json'],
    evidence: [{ content: 'supports the claim', verdict: 'supports', artifacts: ['result.json'] }],
  })
  assert.equal(plan.action.id, 'act-1')
  assert.equal(plan.evidence.length, 1)
  assert.throws(() => fuseActionFinish({
    actionId: 'act-1', status: 'completed', summary: 'done',
    evidence: [{ content: '', verdict: 'supports' }],
  }), /evidence content/)
  assert.throws(() => fuseActionFinish({
    actionId: 'act-1', status: 'completed', summary: 'done', artifacts: [{} as string],
  }), /action artifacts/)
})

test('context token estimation counts non-ASCII and duplicate markers use a size gate', () => {
  assert.equal(estimateContextTokens('中文'), 2)
  const labeled = renderLabeledContextEntries([{ field: 'requiredA', text: 'same' }, { field: 'requiredB', text: 'same' }])
  assert.match(labeled, /requiredA/)
  assert.match(labeled, /requiredB/)
  assert.match(renderLabeledContextEntries([{ field: 'a', text: 'yes' }, { field: 'b', text: 'yes' }]), /yes\n\n### b\nyes/)
  const long = 'required scientific payload '.repeat(40)
  const compact = renderLabeledContextEntries([{ field: 'requiredA', text: long }, { field: 'requiredB', text: long }])
  assert.match(compact, /same content as requiredA/)
  assert.match(compact, /field requiredB remains in the contract/)
  assert.ok(estimateContextTokens(compact) < estimateContextTokens(`### requiredA\n${long}\n\n### requiredB\n${long}`))
})

test('observation pack archives large UTF-8 output and reads exact safe pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-'))
  try {
    const text = '前缀🙂'.repeat(4000)
    const packed = await packObservation(text, { runDir: dir, enabled: true, thresholdBytes: 32, excerptBytes: 17 })
    assert.equal(packed.kind, 'handle')
    if (packed.kind !== 'handle') return
    assert.equal(Buffer.byteLength(text), packed.byteLength)
    assert.ok(text.startsWith(packed.excerpt))
    assert.ok(!packed.excerpt.includes('\uFFFD'))
    const first = await readObservation(packed.handle, { runDir: dir, limitBytes: 23 })
    const second = await readObservation(packed.handle, { runDir: dir, offset: first.nextOffset, limitBytes: 23 })
    assert.equal(first.text + second.text, Buffer.from(text).subarray(0, first.bytes + second.bytes).toString('utf8'))
    await assert.rejects(readObservation('../escape.txt', { runDir: dir }), /invalid observation handle/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('small observations stay inline and archive failure falls back to original text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-inline-'))
  try {
    const inline = await packObservation('small', { runDir: dir, enabled: true, thresholdBytes: 100 })
    assert.deepEqual(inline, { kind: 'inline', text: 'small', byteLength: 5 })
    const archiveFile = join(dir, 'file')
    await writeFile(archiveFile, 'this is a file, not a directory')
    const fallback = await packObservation('large', { runDir: dir, enabled: true, thresholdBytes: 1, archiveDirectory: 'file' })
    assert.equal(fallback.kind, 'inline')
    if (fallback.kind === 'inline') assert.equal(fallback.text, 'large')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('observation pack validates numeric options and strict metadata before exact reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-validation-'))
  try {
    await assert.rejects(packObservation('large', { runDir: dir, enabled: true, thresholdBytes: -1 }), /thresholdBytes/)
    await assert.rejects(packObservation('large', { runDir: dir, enabled: true, excerptBytes: 0 }), /excerptBytes/)
    const packed = await packObservation('large ' + 'x'.repeat(200), { runDir: dir, enabled: true, thresholdBytes: 1 })
    assert.equal(packed.kind, 'handle')
    if (packed.kind !== 'handle') return
    await writeFile(join(dir, packed.handle + '.json'), JSON.stringify({ schema: 'autoresearch/observation-pack/v1', contentHash: packed.contentHash, byteLength: packed.byteLength, owners: [], extra: true }))
    await assert.rejects(readObservationMetadata(packed.handle, { runDir: dir }), /unknown observation metadata field/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verified receipts preserve exact quote, hash, bytes, and status', async () => {
  const source = 'build passed\nexact quote\n' + 'x'.repeat(500)
  const receipt = await createVerifiedReceipt({ source: 'fixture', text: source, quotes: ['exact quote'], exitStatus: 0, measure: (value) => Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') })
  assert.equal(receipt.status, 'verified')
  assert.equal(receipt.bytes, Buffer.byteLength(source))
  assert.equal(receipt.exitStatus, 0)
  assert.equal(receipt.receiptBytes, Buffer.byteLength(JSON.stringify(receipt, null, 2), 'utf8'))
  assert.equal(receipt.quotes[0], 'exact quote')
  assert.match(receipt.contentHash, /^[a-f0-9]{64}$/)
  const fallback = await createVerifiedReceipt({ source: 'tiny', text: 'tiny output', quotes: ['tiny'], exitStatus: 0 })
  assert.equal(fallback.status, 'fallback')
  assert.equal(fallback.fallbackText, 'tiny output')
  assert.deepEqual(fallback.quotes, [])
  assert.equal(fallback.receiptBytes, Buffer.byteLength(JSON.stringify(fallback), 'utf8'))
  await assert.rejects(createVerifiedReceipt({ source: 'fixture', text: source, quotes: ['missing'], exitStatus: 0 }), /quote not found/)
  await assert.rejects(createVerifiedReceipt({ source: 'fixture', text: source, quotes: [] }), /quotes must be non-empty/)
  await assert.rejects(createVerifiedReceipt({ source: 'fixture', text: source, quotes: ['exact quote'], expectedHash: '0'.repeat(64) }), /source hash mismatch/)
})

test('observation archive binds the handle to metadata hash and unions explicit owners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-integrity-'))
  try {
    const first = await packObservation('archive ' + 'x'.repeat(200), { runDir: dir, enabled: true, thresholdBytes: 1, taskId: 'task-a', direction: 'negative' })
    assert.equal(first.kind, 'handle')
    if (first.kind !== 'handle') return
    const second = await packObservation('archive ' + 'x'.repeat(200), { runDir: dir, enabled: true, thresholdBytes: 1, taskId: 'task-b', direction: 'positive' })
    assert.equal(second.kind, 'handle')
    const metadata = await readObservationMetadata(first.handle, { runDir: dir })
    assert.equal(metadata.owners.length, 2)
    const metadataPath = join(dir, first.handle + '.json')
    const corruptMetadata = JSON.stringify({ schema: 'autoresearch/observation-pack/v1', contentHash: '0'.repeat(64), byteLength: first.byteLength, owners: metadata.owners })
    await writeFile(metadataPath, corruptMetadata)
    const fallback = await packObservation('archive ' + 'x'.repeat(200), { runDir: dir, enabled: true, thresholdBytes: 1, taskId: 'task-c', direction: 'negative' })
    assert.equal(fallback.kind, 'inline')
    assert.equal(await readFile(metadataPath, 'utf8'), corruptMetadata)
    await writeFile(join(dir, first.handle), 'tampered', 'utf8')
    await assert.rejects(readObservation(first.handle, { runDir: dir }), /hash mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('observation archive unions owners across independent processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-process-lock-'))
  try {
    const text = 'cross-process archive '.repeat(1200)
    const script = `import { packObservation } from './dist/harness/observation-pack.js'; const value = await packObservation(process.env.OBS_TEXT, { runDir: process.env.OBS_DIR, enabled: true, thresholdBytes: 1, taskId: process.env.OBS_TASK, direction: process.env.OBS_DIRECTION }); process.stdout.write(JSON.stringify(value));`
    const run = (task: string, direction: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, OBS_TEXT: text, OBS_DIR: dir, OBS_TASK: task, OBS_DIRECTION: direction }, windowsHide: true })
      let output = ''; let error = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { error += chunk })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`child exited ${code}: ${error}`)))
    })
    const [first, second] = await Promise.all([run('task-a', 'negative'), run('task-b', 'positive')])
    const firstValue = JSON.parse(first) as { kind: string; handle?: string }
    const secondValue = JSON.parse(second) as { kind: string; handle?: string }
    assert.equal(firstValue.kind, 'handle')
    assert.equal(secondValue.kind, 'handle')
    assert.equal(firstValue.handle, secondValue.handle)
    const metadata = await readObservationMetadata(firstValue.handle!, { runDir: dir })
    assert.deepEqual(metadata.owners.sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? '')), [{ taskId: 'task-a', direction: 'negative' }, { taskId: 'task-b', direction: 'positive' }])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('observation archive refuses a junction before creating anything outside the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-observation-junction-'))
  const outside = await mkdtemp(join(tmpdir(), 'ar-observation-junction-outside-'))
  try {
    await symlink(outside, join(dir, '.autoresearch'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await packObservation('x'.repeat(200), { runDir: dir, enabled: true, thresholdBytes: 1 })
    assert.equal(result.kind, 'inline')
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
