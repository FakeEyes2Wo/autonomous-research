import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorkbench } from '../src/workbench.js'

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(value) { this.body = value }, statusCode: 200 }
}

function request(method, url, body, headers = { 'content-type': 'application/json' }) {
  return { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
}

async function call(workbench, method, url, body, headers = { 'content-type': 'application/json' }) {
  const result = response()
  const handled = await workbench.handle(request(method, url, body, headers), result)
  assert.equal(handled, true)
  return { result, data: result.body && result.headers['content-type']?.startsWith('application/json') ? JSON.parse(result.body) : result.body }
}

async function fakeCompiler(root, { fail = false } = {}) {
  const script = join(root, 'fake-tectonic.mjs')
  await writeFile(script, `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
const args = process.argv.slice(2)
const outdir = args[args.indexOf('--outdir') + 1]
if (${fail ? 'true' : 'false'}) { console.error('synthetic compiler failure'); process.exit(7) }
await mkdir(outdir, { recursive: true })
await writeFile(join(outdir, basename(args.at(-1), '.tex') + '.pdf'), Buffer.from('%PDF-1.7\\nsynthetic\\n%%EOF\\n'))
`, 'utf8')
  if (process.platform !== 'win32') await chmod(script, 0o755)
  return script
}

test('discovers, creates, reads, saves, and rejects stale document writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'paper'))
  await writeFile(join(root, 'paper', 'main.tex'), '% initial\n', 'utf8')
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())

  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.deepEqual(listed.data.documents.map((item) => item.name), ['paper'])
  assert.equal(listed.data.documents[0].relativePath, 'paper/main.tex')
  assert.equal(listed.data.engine.available, false)
  const documentId = listed.data.documents[0].id
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(document.data.source, '% initial\n')
  assert.equal(document.data.relativePath, 'paper/main.tex')
  const saved = await call(workbench, 'PUT', '/api/autoresearch/workbench/document', { projectId: 'demo', documentId, expectedRevision: document.data.revision, source: '% changed\n' })
  assert.equal(saved.result.statusCode, 200)
  assert.equal(saved.data.source, '% changed\n')
  const conflict = await call(workbench, 'PUT', '/api/autoresearch/workbench/document', { projectId: 'demo', documentId, expectedRevision: document.data.revision, source: '% lost\n' })
  assert.equal(conflict.result.statusCode, 409)
  assert.equal(conflict.data.error.code, 'revision_conflict')
  const concurrentRevision = saved.data.revision
  const concurrent = await Promise.all([
    call(workbench, 'PUT', '/api/autoresearch/workbench/document', { projectId: 'demo', documentId, expectedRevision: concurrentRevision, source: '% concurrent-a\n' }),
    call(workbench, 'PUT', '/api/autoresearch/workbench/document', { projectId: 'demo', documentId, expectedRevision: concurrentRevision, source: '% concurrent-b\n' }),
  ])
  assert.deepEqual(concurrent.map((item) => item.result.statusCode).sort(), [200, 409])

  const created = await call(workbench, 'POST', '/api/autoresearch/workbench/documents', { projectId: 'demo' })
  assert.equal(created.result.statusCode, 201)
  assert.equal(created.data.name, 'paper-2')
  assert.equal(created.data.relativePath, 'paper-2/main.tex')
  assert.match(await readFile(join(root, 'paper-2', 'main.tex'), 'utf8'), /documentclass/)
})

test('returns the canonical session cwd only for an allowlisted project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-session-target-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())

  const target = await call(workbench, 'GET', '/api/autoresearch/workbench/session-target?projectId=demo')
  assert.equal(target.result.statusCode, 200)
  assert.deepEqual(target.data, { projectId: 'demo', workspaceId: 'demo', cwd: root })

  const unknown = await call(workbench, 'GET', '/api/autoresearch/workbench/session-target?projectId=unknown')
  assert.equal(unknown.result.statusCode, 404)
  assert.equal(unknown.data.error.code, 'project_not_allowed')
})

test('invalidates document identities when a native workspace changes its root', async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-root-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-root-b-'))
  t.after(() => Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]))
  await mkdir(join(rootA, 'paper'))
  await writeFile(join(rootA, 'paper', 'main.tex'), '% old workspace root\n', 'utf8')
  await mkdir(join(rootB, 'paper'))
  await writeFile(join(rootB, 'paper', 'main.tex'), '% new workspace root\n', 'utf8')
  let root = rootA
  const workbench = createWorkbench({ projects: [], workbench: { compiler: join(rootA, 'missing-tectonic') } }, {
    getProject: async (id) => id === 'demo' ? { id, name: 'Demo', workspaceId: 'native-workspace', root } : undefined,
  })
  t.after(() => workbench.dispose())

  const before = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const oldDocumentId = before.data.documents[0].id
  root = rootB
  const stale = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${oldDocumentId}`)
  assert.equal(stale.result.statusCode, 404)
  const after = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.equal(after.data.documents[0].relativePath, 'paper/main.tex')
  assert.notEqual(after.data.documents[0].id, oldDocumentId)
})

test('discovers AutoResearch paper outputs under runs while retaining shallow papers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-runs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.tex'), '% root\n', 'utf8')
  await mkdir(join(root, 'paper'))
  await writeFile(join(root, 'paper', 'main.tex'), '% shallow\n', 'utf8')
  for (const [container, run] of [['runs', 'run-1'], ['.runs', 'run-2']]) {
    await mkdir(join(root, container, run, 'paper'), { recursive: true })
    await writeFile(join(root, container, run, 'paper', 'main.tex'), `% ${container}/${run}\n`, 'utf8')
  }
  await mkdir(join(root, 'runs', 'run-1', 'paper', 'nested'), { recursive: true })
  await writeFile(join(root, 'runs', 'run-1', 'paper', 'nested', 'main.tex'), '% too deep\n', 'utf8')
  await mkdir(join(root, 'runs', 'run-1', 'other'), { recursive: true })
  await writeFile(join(root, 'runs', 'run-1', 'other', 'main.tex'), '% wrong leaf\n', 'utf8')

  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.deepEqual(listed.data.documents.map((item) => item.relativePath), [
    '.runs/run-2/paper/main.tex',
    'main.tex',
    'paper/main.tex',
    'runs/run-1/paper/main.tex',
  ])
  const nested = listed.data.documents.find((item) => item.relativePath === 'runs/run-1/paper/main.tex')
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${nested.id}`)
  assert.equal(document.data.relativePath, 'runs/run-1/paper/main.tex')
  assert.equal(document.data.source, '% runs/run-1\n')
})

test('rejects symlinked run, paper, and main.tex discovery candidates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const valid = join(root, 'valid')
  await mkdir(join(valid, 'paper'), { recursive: true })
  await writeFile(join(valid, 'paper', 'main.tex'), '% valid\n', 'utf8')
  await mkdir(join(root, 'runs', 'run-ok', 'paper'), { recursive: true })
  await writeFile(join(root, 'runs', 'run-ok', 'paper', 'main.tex'), '% ok\n', 'utf8')

  let linksAvailable = true
  try {
    await symlink(valid, join(root, 'runs', 'run-link'), 'junction')
    await symlink(join(root, 'runs', 'run-ok', 'paper'), join(root, 'runs', 'paper-link'), 'junction')
    await symlink(join(root, 'runs', 'run-ok', 'paper', 'main.tex'), join(root, 'runs', 'main-link.tex'), 'file')
  } catch (error) {
    linksAvailable = false
    t.diagnostic(`symlink setup unavailable: ${error}`)
  }

  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.deepEqual(listed.data.documents.map((item) => item.relativePath), ['runs/run-ok/paper/main.tex'])
  if (!linksAvailable) assert.ok(true, 'normal discovery boundary was still checked')
})

test('bounds the number of run directories it inspects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-run-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 129; index += 1) {
    const run = `run-${String(index).padStart(3, '0')}`
    await mkdir(join(root, 'runs', run, 'paper'), { recursive: true })
    await writeFile(join(root, 'runs', run, 'paper', 'main.tex'), `% ${run}\n`, 'utf8')
  }
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.equal(listed.data.documents.length, 128)
  assert.equal(listed.data.documents.some((item) => item.relativePath.endsWith('run-128/paper/main.tex')), false)
})

test('serves a native pipeline PDF, prefers a valid preview, and preserves stale provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-native-pdf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'runs', 'run-1', 'paper'), { recursive: true })
  const paper = join(root, 'runs', 'run-1', 'paper')
  await writeFile(join(paper, 'main.tex'), '% generated source\n', 'utf8')
  await writeFile(join(paper, 'main.pdf'), Buffer.from('%PDF-1.7\nnative\n%%EOF\n'))
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const native = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(native.data.relativePath, 'runs/run-1/paper/main.tex')
  assert.equal(native.data.pdf.sourceRevision, null)
  const nativePdf = await call(workbench, 'GET', new URL(native.data.pdf.url, 'http://127.0.0.1').pathname + new URL(native.data.pdf.url, 'http://127.0.0.1').search)
  assert.equal(nativePdf.result.statusCode, 200)
  assert.match(nativePdf.result.body.toString(), /native/)

  await mkdir(join(paper, '.autoresearch-preview'))
  await writeFile(join(paper, '.autoresearch-preview', 'metadata.json'), '{}\n')
  const fallback = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(fallback.data.pdf.sourceRevision, null)
  await writeFile(join(paper, '.autoresearch-preview', 'main.pdf'), Buffer.from('%PDF-1.7\npreview\n%%EOF\n'))
  await writeFile(join(paper, '.autoresearch-preview', 'metadata.json'), JSON.stringify({ version: 'preview-version-001', sourceRevision: native.data.revision }) + '\n')
  await writeFile(join(paper, 'main.tex'), '% revised source\n', 'utf8')
  const preferred = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(preferred.data.pdf.version, 'preview-version-001')
  assert.equal(preferred.data.pdf.sourceRevision, native.data.revision)
  assert.notEqual(preferred.data.pdf.sourceRevision, preferred.data.revision)
  const previewPdf = await call(workbench, 'GET', new URL(preferred.data.pdf.url, 'http://127.0.0.1').pathname + new URL(preferred.data.pdf.url, 'http://127.0.0.1').search)
  assert.match(previewPdf.result.body.toString(), /preview/)

  await workbench.dispose()
  const restored = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => restored.dispose())
  const restoredList = await call(restored, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const restoredDocument = await call(restored, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${restoredList.data.documents[0].id}`)
  assert.equal(restoredDocument.data.pdf.version, 'preview-version-001')
  assert.equal(restoredDocument.data.pdf.sourceRevision, native.data.revision)
})

test('selects a newer native PDF, then returns to preview after a workbench build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-pdf-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paper = join(root, 'runs', 'run-1', 'paper')
  await mkdir(paper, { recursive: true })
  await writeFile(join(paper, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}\n', 'utf8')
  const compiler = await fakeCompiler(root)
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler } }, {
    findCompiler: async () => compiler,
    spawn: (_command, args, options) => spawn(process.execPath, [compiler, ...args], options),
  })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const source = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  const previewDirectory = join(paper, '.autoresearch-preview')
  const previewPath = join(previewDirectory, 'main.pdf')
  const nativePath = join(paper, 'main.pdf')
  await mkdir(previewDirectory)
  await writeFile(previewPath, Buffer.from('%PDF-1.7\nold-preview\n%%EOF\n'))
  await writeFile(join(previewDirectory, 'metadata.json'), JSON.stringify({ version: 'preview-version-001', sourceRevision: source.data.revision }) + '\n')
  await writeFile(nativePath, Buffer.from('%PDF-1.7\nnew-native\n%%EOF\n'))
  const previewTime = new Date('2020-01-01T00:00:00.000Z')
  const nativeTime = new Date('2020-01-01T00:00:02.000Z')
  await utimes(previewPath, previewTime, previewTime)
  await utimes(nativePath, nativeTime, nativeTime)

  const native = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(native.data.pdf.sourceRevision, null)
  assert.notEqual(native.data.pdf.version, 'preview-version-001')
  const nativePdf = await call(workbench, 'GET', new URL(native.data.pdf.url, 'http://127.0.0.1').pathname + new URL(native.data.pdf.url, 'http://127.0.0.1').search)
  assert.match(nativePdf.result.body.toString(), /new-native/)

  const started = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: source.data.revision })
  let build
  for (let i = 0; i < 40; i += 1) {
    build = await call(workbench, 'GET', `/api/autoresearch/workbench/build?projectId=demo&buildId=${started.data.id}`)
    if (['succeeded', 'failed'].includes(build.data.status)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(build.data.status, 'succeeded')
  const preview = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  assert.equal(preview.data.pdf.version, build.data.pdf.version)
  assert.equal(preview.data.pdf.sourceRevision, source.data.revision)
  const previewPdf = await call(workbench, 'GET', new URL(preview.data.pdf.url, 'http://127.0.0.1').pathname + new URL(preview.data.pdf.url, 'http://127.0.0.1').search)
  assert.match(previewPdf.result.body.toString(), /synthetic/)
})

test('builds asynchronously with fixed compiler mode and serves bounded PDF ranges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'paper'))
  await writeFile(join(root, 'paper', 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}\n', 'utf8')
  const compiler = await fakeCompiler(root)
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler } }, {
    findCompiler: async () => compiler,
    spawn: (_command, args, options) => spawn(process.execPath, [compiler, ...args], options),
  })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  const started = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: document.data.revision })
  assert.equal(started.result.statusCode, 202)
  const duplicate = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: document.data.revision })
  assert.equal(duplicate.result.statusCode, 409)
  assert.equal(duplicate.data.error.code, 'build_in_progress')
  let build
  for (let i = 0; i < 40; i += 1) {
    build = await call(workbench, 'GET', `/api/autoresearch/workbench/build?projectId=demo&buildId=${started.data.id}`)
    if (['succeeded', 'failed'].includes(build.data.status)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(build.data.status, 'succeeded')
  assert.equal(build.data.sourceRevision, document.data.revision)
  assert.equal(build.data.pdf.sourceRevision, document.data.revision)
  assert.equal(await (await import('node:fs/promises')).access(join(root, 'paper', '.autoresearch-preview', 'main.pdf')), undefined)
  assert.match(build.data.pdf.url, /workbench\/pdf\?/)
  const pdf = await call(workbench, 'GET', new URL(build.data.pdf.url, 'http://127.0.0.1').pathname + new URL(build.data.pdf.url, 'http://127.0.0.1').search, undefined, { range: 'bytes=0-4' })
  assert.equal(pdf.result.statusCode, 206)
  assert.equal(pdf.result.headers['content-range'], 'bytes 0-4/25')
  assert.equal(pdf.result.headers['content-type'], 'application/pdf')
  assert.equal(pdf.result.headers['content-disposition'], 'inline; filename="main.pdf"')
  assert.equal(pdf.result.body.toString(), '%PDF-')
  const badRange = await call(workbench, 'GET', new URL(build.data.pdf.url, 'http://127.0.0.1').pathname + new URL(build.data.pdf.url, 'http://127.0.0.1').search, undefined, { range: 'bytes=999999999999999999999-999999999999999999999' })
  assert.equal(badRange.result.statusCode, 416)
  assert.equal(badRange.result.headers['content-range'], 'bytes */25')
  workbench.dispose()
  const restored = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: compiler } })
  t.after(() => restored.dispose())
  const restoredList = await call(restored, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const restoredDocument = await call(restored, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${restoredList.data.documents[0].id}`)
  assert.equal(restoredDocument.data.pdf.sourceRevision, document.data.revision)
})

test('missing compiler remains editable and traversal IDs cannot access files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler: join(root, 'missing-tectonic') } })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  assert.equal(listed.data.engine.available, false)
  const created = await call(workbench, 'POST', '/api/autoresearch/workbench/documents', { projectId: 'demo' })
  assert.equal(created.result.statusCode, 201)
  const escaped = await call(workbench, 'GET', '/api/autoresearch/workbench/document?projectId=demo&documentId=..%2F..%2Fsecret')
  assert.equal(escaped.result.statusCode, 404)
  const badMime = await call(workbench, 'POST', '/api/autoresearch/workbench/documents', { projectId: 'demo' }, { 'content-type': 'application/json-evil' })
  assert.equal(badMime.result.statusCode, 415)
})

test('does not compile a source revision that changed while queued', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-stale-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'paper'))
  await writeFile(join(root, 'paper', 'main.tex'), '% before\n', 'utf8')
  const compiler = await fakeCompiler(root)
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler } }, {
    findCompiler: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return compiler },
    spawn: (_command, args, options) => spawn(process.execPath, [compiler, ...args], options),
  })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  const started = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: document.data.revision })
  await call(workbench, 'PUT', '/api/autoresearch/workbench/document', { projectId: 'demo', documentId, expectedRevision: document.data.revision, source: '% after\n' })
  let build
  for (let i = 0; i < 40; i += 1) {
    build = await call(workbench, 'GET', `/api/autoresearch/workbench/build?projectId=demo&buildId=${started.data.id}`)
    if (['succeeded', 'failed'].includes(build.data.status)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(build.data.status, 'failed')
  assert.equal(build.data.error.code, 'source_changed')
})

test('build snapshots skip dependency trees while retaining paper assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'paper', 'node_modules'), { recursive: true })
  await mkdir(join(root, 'paper', 'assets'), { recursive: true })
  await writeFile(join(root, 'paper', 'main.tex'), '% source\n', 'utf8')
  await writeFile(join(root, 'paper', 'node_modules', 'secret.tex'), '% should not copy\n', 'utf8')
  await writeFile(join(root, 'paper', 'assets', 'figure.png'), 'image', 'utf8')
  const compiler = await fakeCompiler(root)
  let copiedDependency
  let copiedAsset
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler } }, {
    findCompiler: async () => compiler,
    spawn: (_command, args, options) => { copiedDependency = existsSync(join(options.cwd, 'node_modules')); copiedAsset = existsSync(join(options.cwd, 'assets', 'figure.png')); return spawn(process.execPath, [compiler, ...args], options) },
  })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  const started = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: document.data.revision })
  for (let i = 0; i < 40; i += 1) {
    const build = await call(workbench, 'GET', `/api/autoresearch/workbench/build?projectId=demo&buildId=${started.data.id}`)
    if (['succeeded', 'failed'].includes(build.data.status)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(copiedDependency, false)
  assert.equal(copiedAsset, true)
})

test('disposing a workbench during compiler discovery does not spawn a build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-dispose-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'paper'))
  await writeFile(join(root, 'paper', 'main.tex'), '% source\n', 'utf8')
  const compiler = await fakeCompiler(root)
  let spawnCount = 0
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler } }, {
    findCompiler: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return compiler },
    spawn: (_command, args, options) => { spawnCount += 1; return spawn(process.execPath, [compiler, ...args], options) },
  })
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  const documentId = listed.data.documents[0].id
  const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${documentId}`)
  await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId, expectedRevision: document.data.revision })
  workbench.dispose()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(spawnCount, 0)
})

test('concurrent documents share one scratch root and disposal waits for its deletion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['paper', 'paper-2']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'main.tex'), '% source\n')
  }
  const compiler = await fakeCompiler(root)
  const scratchRoots = []
  const workbench = createWorkbench({ projects: [{ id: 'demo', root }], workbench: { compiler, maxConcurrentBuilds: 2 } }, {
    findCompiler: async () => compiler,
    spawn: (_command, args, options) => {
      scratchRoots.push(dirname(dirname(options.cwd)))
      return spawn(process.execPath, [compiler, ...args], options)
    },
  })
  t.after(() => workbench.dispose())
  const listed = await call(workbench, 'GET', '/api/autoresearch/workbench/documents?projectId=demo')
  await Promise.all(listed.data.documents.map(async ({ id }) => {
    const document = await call(workbench, 'GET', `/api/autoresearch/workbench/document?projectId=demo&documentId=${id}`)
    const started = await call(workbench, 'POST', '/api/autoresearch/workbench/build', { projectId: 'demo', documentId: id, expectedRevision: document.data.revision })
    assert.equal(started.result.statusCode, 202)
  }))
  for (let i = 0; i < 100 && scratchRoots.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(scratchRoots.length, 2)
  assert.equal(new Set(scratchRoots).size, 1)
  await workbench.dispose()
  assert.equal(existsSync(scratchRoots[0]), false)
})
