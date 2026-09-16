import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openCatalog } from '../../dist/literature/catalog.js'
import { registerWork } from '../../dist/literature/import.js'
import { ingestDocument } from '../../dist/literature/ingest.js'
import { buildGeneration, publishGeneration } from '../../dist/literature/index-generation.js'
import { canonicalLiteratureProjectId, resolveLiteratureRoot } from '../../dist/literature/access.js'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export async function literatureFixture(fn: (f: any) => Promise<void>) {
  const project = await mkdtemp(join(tmpdir(), 'literature-context-'))
  const projectId = canonicalLiteratureProjectId(project)
  const root = resolveLiteratureRoot(project)
  const runDir = join(project, 'run')
  await mkdir(runDir)
  const catalog = await openCatalog(root)
  try {
    await registerWork(catalog, { id: 'paper', title: 'paper', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    const document = await ingestDocument(catalog, root, { workId: 'paper', source: { kind: 'text', text: 'alpha mechanism improves the result.\n\nContradictory unrelated experiment refutes the mechanism.' }, sourceKind: 'full_text', visibility: { projectId, partitionId: 'public', roles: ['idea-generator', 'hypothesis-reviser', 'planner', 'paper-survey', 'survey', 'supervisor', 'research-worker'], policyHash: hash('access-policy') } })
    const generation = await buildGeneration(catalog, root, document.spans, { expectedActiveId: null, maxSpans: 100 })
    await publishGeneration(catalog, root, generation.id, null)
    const input = { projectDir: project, runDir, runId: 'run', role: 'idea-generator', query: 'alpha', stage: 'survey', settings: { mode: 'lexical', maxResults: 8, maxContextChars: 12000 } }
    await fn({ project, projectId, root, runDir, catalog, document, generation, input })
  } finally { await catalog.close(); await rm(project, { recursive: true, force: true }) }
}
