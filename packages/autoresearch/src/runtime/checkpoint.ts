import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { JobSpec } from './contracts.js'

export interface CheckpointManifest {
  version: 1; applicationVersion: string; inputHash: string; protocolHash: string
  payloadPath: string; payloadHash: string
}
export async function validateCheckpoint(spec: JobSpec, applicationVersion: string): Promise<CheckpointManifest> {
  if (!spec.checkpoint) throw new Error('application checkpoint capability not declared')
  const stat = await lstat(spec.checkpoint.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid checkpoint manifest')
  const manifest = JSON.parse(await readFile(spec.checkpoint.path, 'utf8')) as CheckpointManifest
  if (manifest.version !== 1 || !applicationVersion || manifest.applicationVersion !== applicationVersion) throw new Error('checkpoint application version mismatch')
  if (manifest.inputHash !== spec.inputHash || manifest.protocolHash !== spec.protocolHash) throw new Error('checkpoint input/protocol hash mismatch')
  if (typeof manifest.payloadPath !== 'string' || isAbsolute(manifest.payloadPath)) throw new Error('invalid checkpoint payload path')
  const root = await realpath(dirname(spec.checkpoint.path)), payload = await realpath(resolve(root, manifest.payloadPath))
  const rel = relative(root, payload)
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('checkpoint payload escapes checkpoint directory')
  const payloadStat = await lstat(payload)
  if (!payloadStat.isFile() || payloadStat.size > spec.budget.maxArtifactBytes) throw new Error('checkpoint payload exceeds artifact limit')
  const bytes = await readFile(payload)
  if (bytes.length > spec.budget.maxArtifactBytes || createHash('sha256').update(bytes).digest('hex') !== manifest.payloadHash) throw new Error('checkpoint payload hash mismatch')
  return manifest
}
