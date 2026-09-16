import { lstat, open, opendir, readFile, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ResearchStore } from '../research/store.js'
import { hashBytes } from '../research/records.js'
import type { InventoryLimits, ProjectInventory } from './contracts.js'

const DEFAULT_LIMITS: InventoryLimits = { maxFiles: 40, maxFileBytes: 8_192, maxTotalBytes: 40_960, maxDepth: 5, maxEntries: 1000 }
const EXCLUDED = /^(?:\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|dist|build|coverage|\.next|\.cache|__pycache__|\.autoresearch|\.codex|\.agents|\.worktrees|runs?|research|paper)$/i
const SECRET = /(?:^\.|secret|credential|password|token|(?:^|[._-])(?:env|config|settings|key|keys|auth)(?:[._-]|$)|\.pem$|\.p12$|\.pfx$|\.keystore$)/i
const TEXT = /\.(?:md|txt|rst|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|r|jl|sh|ps1|json|jsonl|csv|tsv|toml|ya?ml|tex)$/i
const SECRET_CONTENT = /-----BEGIN [^-]*PRIVATE KEY-----|(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["']?[^\s"']{8,}|\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})/i
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export const contained = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
export const artifactHash = (record: object): string => hashBytes(JSON.stringify(record))

/** Exact bytes only: oversized files are omitted rather than silently truncated. */
export async function captureProjectInventory(projectDir: string, runDir: string, overrides: Partial<InventoryLimits> = {}): Promise<ProjectInventory> {
  const root = await realpath(projectDir)
  const runRoot = await realpath(runDir)
  if (samePath(root, runRoot) || contained(runRoot, root)) throw new Error('project discovery requires a distinct run directory outside the project sources')
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof InventoryLimits]) throw new Error(`invalid inventory limit: ${key}`)
  const files: ProjectInventory['files'] = [], omissions: ProjectInventory['omissions'] = []
  let totalBytes = 0, entriesSeen = 0
  const store = new ResearchStore(runDir)
  const omit = (path: string, reason: string) => { if (omissions.length < limits.maxEntries) omissions.push({ path, reason }) }
  async function walk(dir: string, depth: number): Promise<void> {
    if (!samePath(await realpath(dir), dir)) { omit(relative(root, dir), 'symlink'); return }
    const entries: Dirent[] = []
    for await (const entry of await opendir(dir)) {
      if (++entriesSeen > limits.maxEntries) {
        // Omit the whole directory: filesystem enumeration order must not select a partial sample.
        omit(relative(root, dir) || '.', 'entry-limit: directory and remaining traversal omitted')
        return
      }
      entries.push(entry)
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(dir, entry.name), rel = relative(root, path).split(sep).join('/')
      if (entry.isSymbolicLink()) { omit(rel, 'symlink'); continue }
      if (contained(runRoot, path) || EXCLUDED.test(entry.name)) { omit(rel, 'generated-or-dependency'); continue }
      if (SECRET.test(entry.name)) { omit(rel, 'secret-or-config'); continue }
      if (entry.isDirectory()) {
        if (depth >= limits.maxDepth) omit(rel, 'depth-limit')
        else await walk(path, depth + 1)
        if (entriesSeen > limits.maxEntries) return
        continue
      }
      if (!entry.isFile() || !TEXT.test(entry.name)) { omit(rel, 'binary-or-unsupported'); continue }
      if (files.length >= limits.maxFiles) { omit(rel, 'file-count-limit'); continue }
      if (!samePath(await realpath(path), path)) { omit(rel, 'symlink'); continue }
      const handle = await open(path, 'r')
      let bytes: Buffer
      try {
        const stat = await handle.stat()
        if (stat.size > limits.maxFileBytes) { omit(rel, 'file-byte-limit'); continue }
        if (totalBytes + stat.size > limits.maxTotalBytes) { omit(rel, 'total-byte-limit'); continue }
        const buffer = Buffer.alloc(limits.maxFileBytes + 1)
        const read = await handle.read(buffer, 0, buffer.length, 0)
        if (read.bytesRead > limits.maxFileBytes) { omit(rel, 'file-byte-limit'); continue }
        bytes = buffer.subarray(0, read.bytesRead)
        if (bytes.length !== stat.size || !samePath(await realpath(path), path)) throw new Error(`project source changed during inventory: ${rel}`)
      } finally { await handle.close() }
      const text = bytes.toString('utf8')
      if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) { omit(rel, 'binary-or-unsupported'); continue }
      if (SECRET_CONTENT.test(text)) { omit(rel, 'secret-content'); continue }
      const source = await store.captureBytes(bytes, `project:${rel}`)
      files.push({ relativePath: rel, bytes: bytes.length, lines: text.split('\n').length, source })
      totalBytes += bytes.length
    }
  }
  await walk(root, 0)
  const packet = { version: 1 as const, projectDir: root, limits, files, omissions, totalBytes }
  return { ...packet, hash: artifactHash(packet) }
}

/** Resume verifies both frozen copies and current required project bytes, never rescans into old decisions. */
export async function validateProjectInventory(packet: ProjectInventory, projectDir: string, runDir: string): Promise<void> {
  const { hash, ...record } = packet
  if (packet.version !== 1 || hash !== artifactHash(record)) throw new Error('project inventory hash mismatch')
  const root = await realpath(projectDir), runRoot = await realpath(runDir)
  if (!samePath(root, packet.projectDir)) throw new Error('project identity mismatch in inventory')
  for (const file of packet.files) {
    const live = resolve(root, file.relativePath)
    const frozen = resolve(runRoot, file.source.path ?? '')
    if (!contained(root, live) || !contained(runRoot, frozen) || !file.source.path?.startsWith('research/sources/') || !file.source.hash) throw new Error('project source path escape or missing provenance')
    const stat = await lstat(live), capturedStat = await lstat(frozen)
    if (!samePath(await realpath(live), live) || !contained(runRoot, await realpath(frozen)) || stat.isSymbolicLink() || capturedStat.isSymbolicLink()) throw new Error('project source symlink changed')
    if (!stat.isFile() || !capturedStat.isFile() || stat.size !== file.bytes || capturedStat.size !== file.bytes || file.bytes > DEFAULT_LIMITS.maxFileBytes) throw new Error(`project source changed size: ${file.relativePath}`)
    if (hashBytes(await readFile(live)) !== file.source.hash || hashBytes(await readFile(frozen)) !== file.source.hash) throw new Error(`project source changed or hash mismatch: ${file.relativePath}`)
  }
}
