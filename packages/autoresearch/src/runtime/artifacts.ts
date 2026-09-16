import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export interface ArtifactManifest { files: { path: string; bytes: number; hash: string }[]; hash: string }
export async function collectArtifacts(root: string, limit: number): Promise<ArtifactManifest> {
  const files: ArtifactManifest['files'] = []; let bytes = 0
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), name = prefix + entry.name, stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('artifact symbolic links are forbidden')
      if (stat.isDirectory()) { await walk(path, name + '/'); continue }
      if (!stat.isFile()) throw new Error('artifact must be a regular file')
      bytes += stat.size
      if (bytes > limit) throw new Error('artifact byte limit exceeded; collection stopped')
      const content = await readFile(path)
      if (content.length !== stat.size) throw new Error('artifact changed while collecting')
      files.push({ path: name, bytes: content.length, hash: createHash('sha256').update(content).digest('hex') })
    }
  }
  await walk(root, '')
  return { files, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}
export async function writeArtifactManifest(directory: string, manifest: ArtifactManifest): Promise<void> { await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(manifest)) }
