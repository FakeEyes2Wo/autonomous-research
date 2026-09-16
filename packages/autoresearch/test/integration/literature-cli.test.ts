import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const exec = promisify(execFile)
const cli = resolve('scripts/literature.mjs')
async function run(...args: string[]) {
  const result = await exec(process.execPath, [cli, ...args])
  return JSON.parse(result.stdout)
}
test('CLI imports explicit local sources, indexes, searches and replays real temporary project without network', async () => {
  const project = await mkdtemp(join(tmpdir(), 'literature-cli-'))
  try {
    const records = join(project, 'records.json'), file = join(project, 'paper.txt'), manifest = join(project, 'manifest.json')
    await writeFile(records, JSON.stringify([{ id: 'original', title: 'CLI paper' }]))
    await writeFile(file, '反证 improves a reproducible experiment.\n\nAnother result.')
    const imported = await run('import', '--project', project, '--records', records)
    const workId = imported.mappings[0].workId
    const policyHash = createHash('sha256').update('local-policy').digest('hex')
    await writeFile(manifest, JSON.stringify({ documents: [{ workId, source: { kind: 'file', path: file, mediaType: 'text/plain' },
      sourceKind: 'full_text', visibility: { projectId: project, partitionId: 'main', roles: ['researcher'], policyHash } }] }))
    const ingested = await run('ingest', '--project', project, '--manifest', manifest)
    const again = await run('ingest', '--project', project, '--manifest', manifest)
    assert.equal(ingested.documents[0].document.id, again.documents[0].document.id)
    const indexed = await run('index', '--project', project)
    const found = await run('search', '--project', project, '--query', '反证', '--generation', indexed.id)
    assert.equal(found.hits.length, 1)
    const replayed = await run('replay', '--project', project, '--receipt', found.receipt.id)
    assert.equal(replayed.spans[0].evidenceText, '反证 improves a reproducible experiment.')
    assert.equal((await run('search', '--project', project, '--query', 'nomatchword', '--generation', indexed.id)).receipt.outcome, 'no_match')
    await assert.rejects(run('search', '--project', project, '--query', 'x', '--generation', 'missing'))
    await assert.rejects(run('search', '--project', project, '--query', '反证', '--generation', indexed.id, '--unknown', 'x'))
  } finally { await rm(project, { recursive: true, force: true }) }
})
