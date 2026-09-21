import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

// Explicit opt-in. This script is never imported by normal tests and cannot send a project idea.
const args = process.argv.slice(2)
if (args[0] !== '--allow-network' || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--output')) {
  throw new Error('Usage: node scripts/verify-idea-survey-network.mjs --allow-network [--output DIRECTORY]')
}
const { ResearchStore } = await import('../dist/research/store.js')
const { createDiscoveryProviders, verifyDiscoverySource, createCandidateExcerpts } = await import('../dist/literature/discovery/index.js')
const output = args[2] ? resolve(args[2]) : await mkdtemp(join(tmpdir(), 'idea-survey-network-smoke-'))
await mkdir(output, { recursive: true })
const store = new ResearchStore(output), verified = new Set()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceStore = {
  captureBytes: (bytes, id) => store.captureBytes(bytes, id),
  async readSource(ref) {
    if (!ref.path || !ref.hash) throw new Error('Missing captured source path/hash')
    const path = resolve(output, ref.path)
    if (!path.startsWith(resolve(output) + sep)) throw new Error('Source path escaped smoke directory')
    const bytes = await readFile(path)
    if (sha(bytes) !== ref.hash) throw new Error('Source bytes failed SHA-256 verification')
    verified.add(ref.hash); return bytes
  },
}
const query = { id: 'public-rest-smoke', round: 1, text: 'retrieval based speculative decoding', dimensions: ['mechanism', 'terminology'], origin: 'model' }
const summary = { kind: 'live public-provider smoke', output, query: query.text, queryProvenance: 'fixed public host query; no model called', startedAt: new Date().toISOString(), actualAttempts: 0, modelCalls: 0, retries: 0, pageSize: 5, timeoutMs: 20000, maxResponseBytes: 2000000, results: [] }
await mkdir(join(output, 'receipts'), { recursive: true })
for (const provider of createDiscoveryProviders({ sourceStore })) {
  summary.actualAttempts++
  // One attempt per provider: no same-provider spacing or retry is needed.
  const result = await provider.search({ query, page: 0, pageSize: 5, signal: new AbortController().signal, now: Date.now, attemptId: `smoke-${provider.name}`, timeoutMs: 20000, maxResponseBytes: 2000000 })
  if (result.receipt.responseSource) await verifyDiscoverySource(sourceStore, result.receipt.responseSource)
  const excerpts = await createCandidateExcerpts(result.candidates, sourceStore.readSource)
  await writeFile(join(output, 'receipts', `${provider.name}.json`), JSON.stringify(result, null, 2) + '\n')
  summary.results.push({ provider: provider.name, receipt: result.receipt, candidates: result.candidates.length, verifiedExcerpts: excerpts.length, hasMore: result.hasMore, knownRestMatches: result.candidates.filter(candidate => candidate.aliases.some(alias => alias.kind === 'arxiv' && alias.value === '2311.08252')).map(candidate => ({ id: candidate.id, title: candidate.title })), titles: result.candidates.map(candidate => candidate.title) })
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
}
summary.finishedAt = new Date().toISOString()
summary.verifiedSourceHashes = verified.size
summary.limits = ['One small relevance page per provider; provider errors/rate limits are reported as observed.', 'No unpublished idea, model semantic review, novelty judgment, or comprehensive recall measurement.']
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
