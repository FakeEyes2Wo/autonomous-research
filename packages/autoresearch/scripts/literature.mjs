#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
  resolveLiteratureRoot, canonicalLiteratureProjectId, openCatalog, importLegacy, ingestManifest,
  buildGeneration, publishGeneration, getActiveGeneration, retrieve, replay, assertSourceSpan,
  assertDocumentVersion,
} from '../dist/literature/index.js'

const commands = {
  import: ['records', 'run'], ingest: ['manifest'], index: [],
  search: ['query', 'generation', 'project-id', 'run', 'role', 'purpose', 'split', 'partitions', 'policy-hash', 'max-results', 'max-chars'],
  replay: ['receipt'],
}

async function main() {
  const command = process.argv[2]
  if (!Object.hasOwn(commands, command)) throw new Error('Expected import, ingest, index, search, or replay')
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), strict: true, allowPositionals: false,
    options: Object.fromEntries(['project', ...commands[command]].map(name => [name, { type: 'string' }])) })
  if (positionals.length) throw new Error('Unexpected positional argument')
  const required = name => {
    if (!values[name]?.trim()) throw new Error(`--${name} is required`)
    return values[name]
  }
  const project = canonicalLiteratureProjectId(required('project'))
  const root = resolveLiteratureRoot(project)
  const catalog = await openCatalog(root)
  try {
    if (command === 'import') return await importLegacy(catalog, root, {
      bytes: await readFile(resolve(required('records'))), runId: values.run ?? 'local-cli',
    })
    if (command === 'ingest') {
      const manifestPath = resolve(required('manifest'))
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (!manifest || !Array.isArray(manifest.documents)) throw new Error('manifest.documents must be an array')
      for (const input of manifest.documents) {
        if (input.source?.kind === 'file') input.source.path = resolve(dirname(manifestPath), input.source.path)
      }
      return await ingestManifest(catalog, root, manifest, { allowLocalFiles: true })
    }
    if (command === 'index') {
      const [records = []] = await catalog.transact([{ sql: 'SELECT body FROM spans ORDER BY id', params: [] }])
      const active = await getActiveGeneration(catalog)
      const generation = await buildGeneration(catalog, root, records.map(row => assertSourceSpan(JSON.parse(String(row.body)))),
        { expectedActiveId: active?.id ?? null, maxSpans: 100000 })
      if (generation.status !== 'active') await publishGeneration(catalog, root, generation.id, active?.id ?? null)
      return { ...generation, status: 'active' }
    }
    if (command === 'replay') return await replay(catalog, root, required('receipt'))
    const projectId = values['project-id'] ?? project
    const [records = []] = await catalog.transact([{ sql: 'SELECT body FROM documents ORDER BY id', params: [] }])
    const documents = records.map(row => assertDocumentVersion(JSON.parse(String(row.body)))).filter(d => d.visibility.projectId === projectId)
    const policies = [...new Set(documents.map(d => d.visibility.policyHash))]
    const policyHash = values['policy-hash'] ?? (policies.length === 1 ? policies[0] : undefined)
    if (!policyHash) throw new Error('--policy-hash is required when project has zero or multiple policies')
    return await retrieve(catalog, root, {
      query: required('query'), generationId: required('generation'), projectId,
      runId: values.run ?? 'local-cli', role: values.role ?? 'researcher', purpose: values.purpose ?? 'survey',
      ...(values.split === undefined ? {} : { split: values.split }), policyHash,
      partitionIds: values.partitions?.split(',') ?? [...new Set(documents.map(d => d.visibility.partitionId))],
      maxResults: Number(values['max-results'] ?? 10), maxChars: Number(values['max-chars'] ?? 16000),
    })
  } finally { await catalog.close() }
}

try { process.stdout.write(JSON.stringify(await main()) + '\n') }
catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code ?? 'LITERATURE_CLI_ERROR' }) + '\n')
  process.exitCode = 1
}
