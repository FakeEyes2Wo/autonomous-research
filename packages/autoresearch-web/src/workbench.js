import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, lstat, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { API_PREFIX } from './contract.js'

const PREFIX = `${API_PREFIX}/workbench`
const PROJECT_ID = /^[a-z][a-z0-9_-]{0,63}$/
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_BUILD_FILES = 256
const MAX_BUILD_INPUT_BYTES = 16 * 1024 * 1024
const MAX_BUILD_DIRECTORIES = 64
const MAX_BUILD_DEPTH = 8
const MAX_DISCOVERY_DOCUMENTS = 256
const MAX_DISCOVERY_RUNS = 128
const MAX_DISCOVERY_DIRECTORIES = 256
const BUILD_INPUT_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbl', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.pdf', '.eps', '.svg'])
const SKIP_BUILD_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git', '.autoresearch-preview'])

function json(res, status, value, headers = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(JSON.stringify(value))
}

function fail(res, status, code, message, details) {
  json(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } })
  return true
}

function problem(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.details = details
  return error
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function binaryHash(value) { return createHash('sha256').update(value).digest('hex') }
function opaque() { return randomBytes(18).toString('base64url') }
function inside(root, target) { const value = relative(root, target); return value === '' || (value !== '..' && !value.startsWith(`..${requireSeparator()}`) && !isAbsolute(value)) }
function requireSeparator() { return process.platform === 'win32' ? '\\' : '/' }
function sourceBytes(source) { return Buffer.byteLength(source, 'utf8') }
function sourceRevision(source) { return hash(source) }
function jsonRequest(req) { return String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() === 'application/json' }

async function body(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_SOURCE_BYTES + 128 * 1024) throw problem(413, 'body_too_large', 'request body is too large')
    chunks.push(chunk)
  }
  if (!size) throw problem(400, 'invalid_request', 'request body is required')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw problem(400, 'invalid_json', 'request body must be valid JSON') }
}

function configuredProjects(config) {
  const values = Array.isArray(config?.projects) ? config.projects : []
  const seen = new Set()
  return values.filter((item) => {
    if (!object(item) || !PROJECT_ID.test(item.id) || typeof item.root !== 'string' || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).map((item) => ({ id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id, root: resolve(item.root), workspaceId: typeof item.workspaceId === 'string' && item.workspaceId ? item.workspaceId : item.id }))
}

function compilerSetting(config) {
  const value = config?.workbench?.compiler
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof process.env.TECTONIC_PATH === 'string' && process.env.TECTONIC_PATH.trim()) return process.env.TECTONIC_PATH.trim()
  return 'tectonic'
}

async function executable(candidate) {
  try { await access(candidate, constants.F_OK); return candidate } catch { return undefined }
}

async function findCompiler(config) {
  const setting = compilerSetting(config)
  if (isAbsolute(setting) || setting.includes('/') || setting.includes('\\')) return executable(resolve(setting))
  const path = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? ['', ...String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const directory of path) for (const suffix of suffixes) {
    const candidate = await executable(join(directory, setting.endsWith(suffix) ? setting : setting + suffix))
    if (candidate) return candidate
  }
  return undefined
}

function engineInfo(config, compiler) {
  const setting = compilerSetting(config)
  return { available: Boolean(compiler), name: basename(compiler ?? setting) || setting }
}

async function safeProject(project) {
  try {
    const canonical = await realpath(project.root)
    return canonical === project.root ? { ...project, root: canonical } : undefined
  } catch { return undefined }
}

async function safeDocument(directory) {
  try {
    const dirStat = await lstat(directory)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return undefined
    const canonicalDir = await realpath(directory)
    if (canonicalDir !== directory) return undefined
    const main = join(directory, 'main.tex')
    const fileStat = await lstat(main)
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || await realpath(main) !== main) return undefined
    return { directory, main }
  } catch { return undefined }
}

async function safeDirectory(directory) {
  try {
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink()) return false
    return await realpath(directory) === directory
  } catch { return false }
}

function relativeDocumentPath(root, directory) {
  const value = relative(root, directory)
  return value ? `${value.split(requireSeparator()).join('/')}/main.tex` : 'main.tex'
}

function documentKey(projectId, directory) { return `${projectId}\u0000${directory}` }

export function createWorkbench(config = {}, hooks = {}) {
  const projects = configuredProjects(config)
  const documents = new Map()
  const builds = new Map()
  const latest = new Map()
  const queue = []
  const running = new Set()
  const activeDocuments = new Map()
  const children = new Set()
  const maxConcurrent = Math.max(1, Math.min(4, Number.isSafeInteger(config?.workbench?.maxConcurrentBuilds) ? config.workbench.maxConcurrentBuilds : 1))
  const maxQueued = Math.max(1, Math.min(16, Number.isSafeInteger(config?.workbench?.maxQueuedBuilds) ? config.workbench.maxQueuedBuilds : 4))
  const timeoutMs = Math.max(1, Math.min(10 * 60_000, Number.isSafeInteger(config?.workbench?.timeoutMs) ? config.workbench.timeoutMs : DEFAULT_TIMEOUT_MS))
  const outputLimit = Math.max(1, Math.min(MAX_OUTPUT_BYTES, Number.isSafeInteger(config?.workbench?.maxOutputBytes) ? config.workbench.maxOutputBytes : MAX_OUTPUT_BYTES))
  let artifactRoot
  let artifactPromise
  let disposal
  let disposed = false
  const runningTasks = new Set()
  const saveLocks = new Map()
  const buildHistoryLimit = Math.max(8, Math.min(256, Number.isSafeInteger(config?.workbench?.maxBuildHistory) ? config.workbench.maxBuildHistory : 64))

  async function validProject(id) {
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) return undefined
    const configured = typeof hooks.getProject === 'function' ? await hooks.getProject(id) : projects.find((item) => item.id === id)
    return configured ? safeProject(configured) : undefined
  }

  async function discovered(project) {
    const result = []
    const seen = new Set()
    const add = (directory, name) => {
      if (result.length >= MAX_DISCOVERY_DOCUMENTS || seen.has(directory)) return
      seen.add(directory)
      result.push({ directory, name, relativePath: relativeDocumentPath(project.root, directory) })
    }
    const rootMain = await safeDocument(project.root)
    if (rootMain) add(project.root, 'main')
    let entries
    try { entries = await readdir(project.root, { withFileTypes: true }) } catch { return result }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    let directDirectories = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name === 'runs' || entry.name === '.runs') {
        const container = join(project.root, entry.name)
        if (entry.name === 'runs' && await safeDocument(container)) add(container, entry.name)
        if (!(await safeDirectory(container))) continue
        let runEntries
        try { runEntries = await readdir(container, { withFileTypes: true }) } catch { continue }
        runEntries.sort((a, b) => a.name.localeCompare(b.name))
        let runDirectories = 0
        for (const runEntry of runEntries) {
          if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || runEntry.name.startsWith('.')) continue
          runDirectories += 1
          if (runDirectories > MAX_DISCOVERY_RUNS) break
          const runDirectory = join(container, runEntry.name)
          if (!(await safeDirectory(runDirectory))) continue
          const paperDirectory = join(runDirectory, 'paper')
          if (await safeDocument(paperDirectory)) add(paperDirectory, 'paper')
        }
        continue
      }
      if (entry.name.startsWith('.')) continue
      directDirectories += 1
      if (directDirectories > MAX_DISCOVERY_DIRECTORIES) continue
      const directory = join(project.root, entry.name)
      if (await safeDocument(directory)) add(directory, entry.name)
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  function idFor(project, directory, name, relativePath) {
    const key = documentKey(project.id, directory)
    const existing = documents.get(key)
    if (existing) return existing.id
    const id = opaque()
    documents.set(key, { id, projectId: project.id, root: project.root, directory, name, relativePath })
    return id
  }

  async function documentFor(project, id) {
    if (!OPAQUE_ID.test(String(id ?? ''))) return undefined
    const entry = [...documents.values()].find((item) => item.projectId === project.id && item.id === id)
    if (!entry) return undefined
    // A native workspace can be moved while the workbench is alive. Opaque
    // document IDs are scoped to the canonical root that created them so an
    // old ID cannot reach files from the workspace's former location.
    if (entry.root !== project.root) return undefined
    const safe = await safeDocument(entry.directory)
    return safe ? { ...entry, ...safe } : undefined
  }

  async function withSaveLock(key, operation) {
    const previous = saveLocks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    saveLocks.set(key, current)
    try { return await current } finally { if (saveLocks.get(key) === current) saveLocks.delete(key) }
  }

  async function documentDto(project, document) {
    const source = await readFile(document.main, 'utf8')
    if (sourceBytes(source) > MAX_SOURCE_BYTES) throw problem(413, 'source_too_large', 'source file is too large')
    const result = { id: document.id, name: document.name, relativePath: document.relativePath ?? relativeDocumentPath(project.root, document.directory), source, revision: sourceRevision(source) }
    const build = await loadPreview(project, document)
    if (build?.pdfPath) result.pdf = pdfDto(project, document, build.version, build.sourceRevision)
    return result
  }

  function pdfDto(project, document, version, sourceRevision) {
    return { version, sourceRevision, url: `${PREFIX}/pdf?projectId=${encodeURIComponent(project.id)}&documentId=${encodeURIComponent(document.id)}&version=${encodeURIComponent(version)}` }
  }

  async function list(project) {
    const entries = await discovered(project)
    const items = []
    for (const entry of entries) {
      const id = idFor(project, entry.directory, entry.name, entry.relativePath)
      items.push({ id, name: entry.name, relativePath: entry.relativePath })
    }
    return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  async function create(project) {
    for (let number = 1; number < 10_000; number += 1) {
      const name = number === 1 ? 'paper' : `paper-${number}`
      const directory = join(project.root, name)
      try { await mkdir(directory) } catch (error) { if (error.code === 'EEXIST') continue; throw error }
      const main = join(directory, 'main.tex')
      const source = '\\documentclass{article}\n\\title{New Research Paper}\n\\author{}\n\\begin{document}\n\\maketitle\n\\begin{abstract}\nWrite an abstract here.\n\\end{abstract}\n\\section{Introduction}\nStart writing here.\n\\end{document}\n'
      await writeFile(main, source, { encoding: 'utf8', flag: 'wx' })
      const id = idFor(project, directory, name, relativeDocumentPath(project.root, directory))
      return { id, name, relativePath: relativeDocumentPath(project.root, directory), source, revision: sourceRevision(source) }
    }
    throw problem(409, 'document_name_exhausted', 'could not allocate a new paper name')
  }

  async function save(project, document, expectedRevision, source) {
    if ((typeof expectedRevision !== 'string' && typeof expectedRevision !== 'number') || typeof source !== 'string') throw problem(400, 'invalid_request', 'expectedRevision and source are required')
    if (sourceBytes(source) > MAX_SOURCE_BYTES) throw problem(413, 'source_too_large', 'source is too large')
    return withSaveLock(documentKey(project.id, document.directory), async () => {
      const current = await readFile(document.main, 'utf8')
      if (String(sourceRevision(current)) !== String(expectedRevision)) throw problem(409, 'revision_conflict', 'the document changed elsewhere', { revision: sourceRevision(current) })
      const safe = await safeDocument(document.directory)
      if (!safe) throw problem(409, 'document_unavailable', 'the document is no longer a regular project file')
      const temporary = join(document.directory, `.main.tex.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
      try { await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, safe.main) } finally { await unlink(temporary).catch(() => undefined) }
      return documentDto(project, { ...document, ...safe })
    })
  }

  async function ensureArtifacts() {
    if (disposed) throw problem(499, 'workbench_disposed', 'workbench has been disposed')
    artifactPromise ??= mkdtemp(join(tmpdir(), 'autoresearch-workbench-')).then((directory) => { artifactRoot = directory; return directory })
    await artifactPromise
    if (disposed) throw problem(499, 'workbench_disposed', 'workbench has been disposed')
    return artifactRoot
  }

  async function copyBuildInputs(sourceDirectory, targetDirectory) {
    let files = 0
    let totalBytes = 0
    let directories = 0
    async function copyDirectory(source, target, depth) {
      if (depth > MAX_BUILD_DEPTH) throw problem(413, 'build_input_too_large', 'build input directory depth exceeds the limit')
      const entries = await readdir(source, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory() && SKIP_BUILD_DIRECTORIES.has(entry.name)) continue
        const from = join(source, entry.name)
        const to = join(target, entry.name)
        const details = await lstat(from)
        if (details.isSymbolicLink()) throw problem(422, 'unsafe_source', 'symbolic links are not allowed in a build input')
        if (details.isDirectory()) {
          directories += 1
          if (directories > MAX_BUILD_DIRECTORIES) throw problem(413, 'build_input_too_large', 'build input contains too many directories')
          await mkdir(to, { recursive: false })
          await copyDirectory(from, to, depth + 1)
        } else if (details.isFile() && BUILD_INPUT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files += 1
          if (files > MAX_BUILD_FILES || details.size > MAX_BUILD_INPUT_BYTES || totalBytes + details.size > MAX_BUILD_INPUT_BYTES) throw problem(413, 'build_input_too_large', 'build inputs exceed the configured limit')
          totalBytes += details.size
          await writeFile(to, await readFile(from))
        }
      }
    }
    await mkdir(targetDirectory, { recursive: true })
    await copyDirectory(sourceDirectory, targetDirectory, 0)
    if (files === 0 || !(await safeDocument(targetDirectory))) throw problem(422, 'unsafe_source', 'main.tex is required in the build input')
  }

  async function persistPreview(document, pdfPath, build) {
    const previewDirectory = join(document.directory, '.autoresearch-preview')
    try {
      const details = await lstat(previewDirectory)
      if (!details.isDirectory() || details.isSymbolicLink() || await realpath(previewDirectory) !== previewDirectory) throw problem(409, 'preview_unavailable', 'the preview directory is not a regular project directory')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(previewDirectory)
    }
    const previewPdf = join(previewDirectory, 'main.pdf')
    const previewMetadata = join(previewDirectory, 'metadata.json')
    const temporaryPdf = `${previewPdf}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const temporaryMetadata = `${previewMetadata}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temporaryPdf, await readFile(pdfPath), { flag: 'wx' })
      await rename(temporaryPdf, previewPdf)
      await writeFile(temporaryMetadata, JSON.stringify({ version: build.id, sourceRevision: build.sourceRevision }) + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(temporaryMetadata, previewMetadata)
    } finally {
      await unlink(temporaryPdf).catch(() => undefined)
      await unlink(temporaryMetadata).catch(() => undefined)
    }
    return { pdfPath: previewPdf, version: build.id, sourceRevision: build.sourceRevision }
  }

  async function readValidPdf(pdfPath) {
    const pdfDetails = await lstat(pdfPath)
    if (!pdfDetails.isFile() || pdfDetails.isSymbolicLink() || await realpath(pdfPath) !== pdfPath) throw new Error('invalid PDF file')
    const info = await stat(pdfPath)
    if (info.size <= 5 || info.size > MAX_PDF_BYTES) throw new Error('invalid PDF size')
    const bytes = await readFile(pdfPath, { encoding: null, flag: 'r' })
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('invalid PDF magic')
    return { bytes, mtimeMs: info.mtimeMs }
  }

  async function loadNativePdf(project, document) {
    const key = documentKey(project.id, document.directory)
    const pdfPath = join(document.directory, 'main.pdf')
    try {
      const { bytes, mtimeMs } = await readValidPdf(pdfPath)
      const version = binaryHash(bytes)
      const restored = { id: version, project, document, version, pdfPath, mtimeMs, sourceRevision: null, native: true, status: 'succeeded', diagnostics: [] }
      latest.set(key, restored)
      return restored
    } catch { return undefined }
  }

  async function loadPreview(project, document) {
    const key = documentKey(project.id, document.directory)
    const known = latest.get(key)
    if (known?.native) latest.delete(key)
    const previewDirectory = join(document.directory, '.autoresearch-preview')
    const pdfPath = join(previewDirectory, 'main.pdf')
    const metadataPath = join(previewDirectory, 'metadata.json')
    let preview
    try {
      const previewDetails = await lstat(previewDirectory)
      if (!previewDetails.isDirectory() || previewDetails.isSymbolicLink() || await realpath(previewDirectory) !== previewDirectory) throw new Error('invalid preview directory')
      const parsed = JSON.parse(await readFile(metadataPath, 'utf8'))
      if (!OPAQUE_ID.test(parsed.version) || !/^[a-f0-9]{64}$/.test(parsed.sourceRevision) || !inside(document.directory, previewDirectory)) throw new Error('invalid preview metadata')
      const details = await readValidPdf(pdfPath)
      preview = { id: parsed.version, project, document, version: parsed.version, sourceRevision: parsed.sourceRevision, pdfPath, mtimeMs: details.mtimeMs, status: 'succeeded', diagnostics: [] }
    } catch {}
    const native = await loadNativePdf(project, document)
    if (native && (!preview || native.mtimeMs > preview.mtimeMs)) return native
    if (preview) {
      latest.set(key, preview)
      return preview
    }
    return undefined
  }

  function diagnostics(output, projectRoot) {
    const escapedRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const scrubbed = output.replace(new RegExp(escapedRoot, 'gi'), '<project>')
      .replace(/\b[A-Za-z]:[\\/][^\s\r\n]*/g, '<path>')
      .replace(/(?<![A-Za-z0-9])\/(?:[^\s\/]+\/)+[^\s]*/g, '<path>')
    const text = scrubbed.length > outputLimit ? `${scrubbed.slice(0, outputLimit)}\n[compiler output truncated]` : scrubbed
    return text ? text.split(/\r?\n/).filter(Boolean).slice(-200) : []
  }

  async function runBuild(project, document, build) {
    build.status = 'running'
    const compiler = await (hooks.findCompiler ?? (() => findCompiler(config)))()
    if (!compiler) { build.status = 'failed'; build.error = { code: 'compiler_unavailable', message: 'Tectonic is not available on PATH or in workbench.compiler.' }; return }
    if (disposed) { build.status = 'failed'; build.error = { code: 'workbench_disposed', message: 'workbench has been disposed' }; return }
    const currentSource = await readFile(document.main, 'utf8')
    if (sourceBytes(currentSource) > MAX_SOURCE_BYTES) {
      build.status = 'failed'
      build.error = { code: 'source_too_large', message: 'source is too large' }
      return
    }
    if (sourceRevision(currentSource) !== build.sourceRevision) {
      build.status = 'failed'
      build.error = { code: 'source_changed', message: 'the document changed before compilation started' }
      return
    }
    const artifacts = await ensureArtifacts()
    const outdir = join(artifacts, build.id)
    build.scratch = outdir
    const input = join(outdir, 'input')
    await copyBuildInputs(document.directory, input)
    if (disposed) { build.status = 'failed'; build.error = { code: 'workbench_disposed', message: 'workbench has been disposed' }; return }
    const source = join(input, 'main.tex')
    const snapshot = await readFile(source, 'utf8')
    if (disposed) { build.status = 'failed'; build.error = { code: 'workbench_disposed', message: 'workbench has been disposed' }; return }
    if (sourceRevision(snapshot) !== build.sourceRevision) {
      build.status = 'failed'
      build.error = { code: 'source_changed', message: 'the document changed before compilation started' }
      return
    }
    const args = ['-X', 'compile', '--untrusted', '--outdir', outdir, source]
    const child = (hooks.spawn ?? spawn)(compiler, args, { cwd: input, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = ''
    let exceeded = false
    const append = (chunk) => { output += String(chunk); if (Buffer.byteLength(output, 'utf8') > outputLimit) { exceeded = true; child.kill() } }
    child.stdout.on('data', append); child.stderr.on('data', append)
    const timeout = setTimeout(() => { build.timedOut = true; child.kill() }, timeoutMs)
    await new Promise((resolvePromise) => {
      child.once('error', (error) => { build.spawnError = error; resolvePromise() })
      child.once('close', (code, signal) => { build.exitCode = code; build.signal = signal; resolvePromise() })
    })
    clearTimeout(timeout); children.delete(child)
    build.diagnostics = diagnostics(output, project.root)
    if (exceeded) { build.status = 'failed'; build.error = { code: 'compiler_output_limit', message: 'compiler output exceeded the configured limit' }; return }
    if (build.timedOut) { build.status = 'failed'; build.error = { code: 'compiler_timeout', message: 'compiler exceeded the configured timeout' }; return }
    if (build.spawnError || build.exitCode !== 0) { build.status = 'failed'; build.error = { code: 'compiler_failed', message: 'Tectonic failed to compile the document' }; return }
    const pdfPath = join(outdir, `${basename(document.main, extname(document.main))}.pdf`)
    try {
      await readValidPdf(pdfPath)
      if (disposed) { build.status = 'failed'; build.error = { code: 'workbench_disposed', message: 'workbench has been disposed' }; return }
      const preview = await persistPreview(document, pdfPath, build)
      build.pdfPath = preview.pdfPath; build.version = preview.version; build.status = 'succeeded'
      latest.set(documentKey(project.id, document.directory), build)
    } catch {
      build.status = 'failed'; build.error = { code: 'invalid_pdf', message: 'compiler did not produce a valid PDF' }
    }
  }

  function pump() {
    while (!disposed && running.size < maxConcurrent && queue.length) {
      const build = queue.shift()
      running.add(build.id)
      const task = runBuild(build.project, build.document, build).catch((error) => {
        build.status = 'failed'; build.error = { code: error?.code ?? 'build_failed', message: 'workbench build failed' }; build.diagnostics = diagnostics(String(error?.message ?? error), build.project.root)
      }).finally(async () => {
        // PDF has already been copied into the project. Only bounded internal
        // IDs under our mkdtemp root ever become deletion targets.
        if (build.scratch && artifactRoot && inside(artifactRoot, build.scratch)) await rm(build.scratch, { recursive: true, force: true }).catch(() => undefined)
        running.delete(build.id)
        runningTasks.delete(task)
        const key = documentKey(build.project.id, build.document.directory)
        if (activeDocuments.get(key) === build) activeDocuments.delete(key)
        pruneBuilds(); pump()
      })
      runningTasks.add(task)
    }
  }

  function buildDto(project, document, build) {
    return { id: build.id, status: build.status, sourceRevision: build.sourceRevision, diagnostics: build.diagnostics ?? [], ...(build.error ? { error: build.error } : {}), ...(build.pdfPath ? { pdf: pdfDto(project, document, build.version, build.sourceRevision) } : {}) }
  }

  function pruneBuilds() {
    if (builds.size <= buildHistoryLimit) return
    for (const [id, build] of builds) {
      if (builds.size <= buildHistoryLimit) break
      if (running.has(id) || build.status === 'queued') continue
      builds.delete(id)
    }
  }

  async function startBuild(project, document, requestedRevision) {
    const current = await documentDto(project, document)
    if (disposed) throw problem(503, 'workbench_disposed', 'workbench has been disposed')
    if (typeof requestedRevision !== 'string' || requestedRevision !== current.revision) throw problem(409, 'revision_conflict', 'build source revision is stale', { revision: current.revision })
    const documentKeyValue = documentKey(project.id, document.directory)
    const active = activeDocuments.get(documentKeyValue)
    if (active && (active.status === 'queued' || active.status === 'running')) throw problem(409, 'build_in_progress', 'a build for this document is already in progress')
    if (running.size + queue.length >= maxConcurrent + maxQueued) throw problem(429, 'build_queue_full', 'too many builds are queued')
    const build = { id: opaque(), project, document, sourceRevision: current.revision, status: 'queued', diagnostics: [] }
    activeDocuments.set(documentKeyValue, build)
    builds.set(build.id, build); pruneBuilds(); queue.push(build); pump()
    return build
  }

  async function readPdf(project, document, version, req, res) {
    const build = latest.get(documentKey(project.id, document.directory))
    if (!build || build.version !== version || !build.pdfPath) throw problem(404, 'pdf_not_found', 'the requested PDF version is unavailable')
    let header
    try { ({ bytes: header } = await readValidPdf(build.pdfPath)) } catch { throw problem(404, 'pdf_not_found', 'the requested PDF version is unavailable') }
    if (build.native && binaryHash(header) !== build.version) throw problem(404, 'pdf_not_found', 'the requested PDF version is unavailable')
    const range = req.headers?.range
    let start = 0; let end = header.length - 1; let status = 200
    if (range !== undefined) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(String(range))
      if (!match) { res.setHeader('content-range', `bytes */${header.length}`); return fail(res, 416, 'invalid_range', 'only one byte range is supported') }
      start = Number(match[1]); end = match[2] ? Number(match[2]) : header.length - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= header.length) { res.setHeader('content-range', `bytes */${header.length}`); return fail(res, 416, 'invalid_range', 'requested byte range is unsatisfiable') }
      end = Math.min(end, header.length - 1); status = 206
    }
    const bytes = header.subarray(start, end + 1)
    res.statusCode = status; res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', 'inline; filename="main.pdf"'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('accept-ranges', 'bytes'); res.setHeader('content-length', bytes.length)
    if (status === 206) res.setHeader('content-range', `bytes ${start}-${end}/${header.length}`)
    res.end(bytes)
  }

  async function handle(req, res) {
    let url
    try { url = new URL(req.url ?? PREFIX, `http://${req.headers?.host ?? '127.0.0.1'}`) } catch { fail(res, 400, 'invalid_url', 'request URL is invalid'); return true }
    if (!url.pathname.startsWith(PREFIX)) return false
    try {
      if (url.pathname === `${PREFIX}/session-target` && req.method === 'GET') {
        const project = await validProject(url.searchParams.get('projectId'))
        if (!project) return fail(res, 404, 'project_not_allowed', 'project is not in the server allowlist')
        return json(res, 200, { projectId: project.id, workspaceId: project.workspaceId, cwd: project.root }) || true
      }
      if (url.pathname === `${PREFIX}/documents` && req.method === 'GET') {
        const project = await validProject(url.searchParams.get('projectId'))
        if (!project) return fail(res, 404, 'project_not_allowed', 'project is not in the server allowlist')
        const compiler = await findCompiler(config)
        return json(res, 200, { documents: await list(project), engine: engineInfo(config, compiler) }) || true
      }
      if (url.pathname === `${PREFIX}/documents` && req.method === 'POST') {
        if (!jsonRequest(req)) return fail(res, 415, 'json_required', 'this endpoint accepts application/json only')
        const value = await body(req); if (!object(value)) throw problem(400, 'invalid_request', 'request must be an object')
        const project = await validProject(value.projectId); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        return json(res, 201, await create(project)) || true
      }
      if (url.pathname === `${PREFIX}/document` && req.method === 'GET') {
        const project = await validProject(url.searchParams.get('projectId')); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        const document = await documentFor(project, url.searchParams.get('documentId')); if (!document) throw problem(404, 'document_not_found', 'document is not available')
        return json(res, 200, await documentDto(project, document)) || true
      }
      if (url.pathname === `${PREFIX}/document` && req.method === 'PUT') {
        if (!jsonRequest(req)) return fail(res, 415, 'json_required', 'this endpoint accepts application/json only')
        const value = await body(req); if (!object(value)) throw problem(400, 'invalid_request', 'request must be an object')
        const project = await validProject(value.projectId); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        const document = await documentFor(project, value.documentId); if (!document) throw problem(404, 'document_not_found', 'document is not available')
        return json(res, 200, await save(project, document, value.expectedRevision, value.source)) || true
      }
      if (url.pathname === `${PREFIX}/build` && req.method === 'POST') {
        if (!jsonRequest(req)) return fail(res, 415, 'json_required', 'this endpoint accepts application/json only')
        const value = await body(req); if (!object(value)) throw problem(400, 'invalid_request', 'request must be an object')
        const project = await validProject(value.projectId); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        const document = await documentFor(project, value.documentId); if (!document) throw problem(404, 'document_not_found', 'document is not available')
        return json(res, 202, buildDto(project, document, await startBuild(project, document, value.expectedRevision))) || true
      }
      if (url.pathname === `${PREFIX}/build` && req.method === 'GET') {
        const project = await validProject(url.searchParams.get('projectId')); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        const build = builds.get(url.searchParams.get('buildId')); if (!build || build.project.id !== project.id || build.project.root !== project.root) throw problem(404, 'build_not_found', 'build is not available')
        return json(res, 200, buildDto(project, build.document, build)) || true
      }
      if (url.pathname === `${PREFIX}/pdf` && req.method === 'GET') {
        const project = await validProject(url.searchParams.get('projectId')); if (!project) throw problem(404, 'project_not_allowed', 'project is not in the server allowlist')
        const document = await documentFor(project, url.searchParams.get('documentId')); if (!document) throw problem(404, 'document_not_found', 'document is not available')
        await readPdf(project, document, url.searchParams.get('version'), req, res); return true
      }
      return fail(res, 404, 'not_found', 'unknown workbench route')
    } catch (error) {
      if (error?.status) return fail(res, error.status, error.code, error.message, error.details)
      return fail(res, 500, 'workbench_error', 'the workbench request failed')
    }
  }

  function dispose() {
    if (disposal) return disposal
    disposed = true
    for (const child of children) child.kill()
    queue.length = 0
    // Await all work that can still create or write a scratch directory. This
    // also covers a dispose that arrives while mkdtemp or snapshot copying waits.
    disposal = Promise.allSettled([...runningTasks]).then(async () => {
      if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true }).catch(() => undefined)
      artifactRoot = undefined
    })
    return disposal
  }

  return { handle, dispose }
}

export { MAX_PDF_BYTES }
