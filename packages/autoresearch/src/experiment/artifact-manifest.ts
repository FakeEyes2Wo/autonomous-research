import { readFile, lstat, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { JobReceipt } from '../runtime/contracts.js'
import { localJobDirectory } from '../runtime/executors/local.js'
import { hashContent, hashBytes } from '../research/records.js'
import { ResearchStore } from '../research/store.js'
import type { SourceRef } from '../research/contracts.js'
import type { ExperimentTask } from './task-graph.js'
import { assertRelativePath } from './task-graph.js'

export interface ArtifactManifest {
  jobId: string; attemptId: string; protocolHash: string; inputHash: string
  artifacts: { relativePath: string; bytes: number; sha256: string; kind: string }[]
  evaluatorVersion: string; environmentHash: string
}
export async function captureJobArtifacts(input: { runDir: string; runtimeRoot: string; task: ExperimentTask; receipt: JobReceipt; evaluatorVersion: string }): Promise<{ manifest: ArtifactManifest; artifacts: SourceRef[]; raw: unknown }> {
  const { task, receipt } = input
  if (receipt.jobId !== task.job.id || receipt.protocolHash !== task.protocolHash || receipt.inputHash !== task.inputHash || !receipt.artifactManifestHash) throw new Error('ARTIFACT_RECEIPT_MISMATCH')
  const directory = localJobDirectory(input.runtimeRoot, task.job.id)
  const native = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8')) as { files: { path: string; bytes: number; hash: string }[]; hash: string }
  if (!Array.isArray(native.files) || native.hash !== receipt.artifactManifestHash || createHash('sha256').update(JSON.stringify(native.files)).digest('hex') !== native.hash) throw new Error('ARTIFACT_MANIFEST_HASH_MISMATCH')
  const declared = task.outputs ?? []
  if (native.files.length !== declared.length || new Set(native.files.map(f => f.path)).size !== native.files.length) throw new Error('ARTIFACT_DECLARED_OUTPUT_MISMATCH')
  let total = 0; let raw: unknown
  const artifacts: SourceRef[] = [], entries: ArtifactManifest['artifacts'] = []
  const root = await realpath(join(directory, 'artifacts'))
  for (const file of native.files) {
    assertRelativePath(file.path)
    const output = declared.find(o => o.relativePath === file.path)
    if (!output || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > output.maxBytes || (total += file.bytes) > task.job.budget.maxArtifactBytes) throw new Error('ARTIFACT_SIZE_OR_TYPE_MISMATCH')
    const path = join(root, file.path), stat = await lstat(path), resolved = await realpath(path), rel = relative(root, resolved)
    if (stat.isSymbolicLink() || !stat.isFile() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ARTIFACT_PATH_ESCAPE')
    const bytes = await readFile(path)
    if (bytes.length !== file.bytes || hashBytes(bytes) !== file.hash) throw new Error('ARTIFACT_BYTES_HASH_MISMATCH')
    artifacts.push(await new ResearchStore(input.runDir).captureBytes(bytes, `${task.job.id}:${file.path}`))
    entries.push({ relativePath: file.path, bytes: bytes.length, sha256: file.hash, kind: output.kind })
    if (output.kind === 'paired-outcomes') { if (raw !== undefined) throw new Error('ARTIFACT_MULTIPLE_OBSERVATIONS'); try { raw = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('ARTIFACT_OBSERVATION_JSON_INVALID') } }
  }
  const manifest = { jobId: task.job.id, attemptId: task.job.attemptId, protocolHash: task.protocolHash, inputHash: task.inputHash, artifacts: entries, evaluatorVersion: input.evaluatorVersion, environmentHash: hashContent({ executable: task.job.executable, args: task.job.args, env: task.job.env, cwd: task.job.cwd, node: process.version, platform: process.platform }) }
  return { manifest, artifacts, raw }
}
