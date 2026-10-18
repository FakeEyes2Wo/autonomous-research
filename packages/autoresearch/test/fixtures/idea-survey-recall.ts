import { readFile, mkdir, writeFile, stat, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { ResearchStore } from '../../dist/research/store.js'
import {
  createDiscoveryProviders, createCandidateExcerpts, mergeDiscoveryCandidates,
  rankDiscoveryCandidates, reviewSimilarity, runSimilaritySurvey,
} from '../../dist/literature/discovery/index.js'
import { readDiscoveryRecord } from '../../dist/literature/discovery/checkpoint.js'
import type { CurrentIdeaIdentity, DiscoveryCandidate, DiscoveryQuery, SimilarityReviewerInput, SimilaritySurveyReport } from '../../dist/literature/discovery/contracts.js'

type Anchor = 'Macaroons' | 'CaMeL' | 'RAG' | 'REST'
type Paper = { key: string; title: string; abstract: string; year: number; doi?: string; arxiv?: string; anchor?: Anchor }
type Scenario = 'authority' | 'retrieval'
// Short original paraphrases, deliberately not full published abstracts. The four anchor IDs are public.
const papers: Record<string, Paper> = {
  macaroon: { key: 'macaroon', anchor: 'Macaroons', doi: '10.14722/ndss.2014.23212', title: 'Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud', year: 2014, abstract: 'A holder delegates credentials with additional restrictions. A verifier checks these caveats before allowing an operation.' },
  camel: { key: 'camel', anchor: 'CaMeL', arxiv: '2503.18813', title: 'Defeating Prompt Injections by Design', year: 2025, abstract: 'A separate policy constrains sensitive actions when a language-model workflow processes untrusted text.' },
  rag: { key: 'rag', anchor: 'RAG', arxiv: '2005.11401', title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', year: 2020, abstract: 'Generation combines a learned model with passages retrieved from an external document collection.' },
  rest: { key: 'rest', anchor: 'REST', arxiv: '2311.08252', title: 'REST: Retrieval-Based Speculative Decoding', year: 2023, abstract: 'Previously observed text continuations supply candidate tokens for speculative generation.' },
  authorityDecoy: { key: 'authority-decoy', doi: '10.9999/fixture-authority-index', arxiv: '9901.00001', title: 'Fixture: Tool Instruction Security Keyword Index', year: 2024, abstract: 'This synthetic bibliographic index counts matching words in titles. It supplies no policy enforcement mechanism.' },
  retrievalDecoy: { key: 'retrieval-decoy', doi: '10.9999/fixture-retrieval-index', arxiv: '9901.00002', title: 'Fixture: Retrieval Generation Word Frequency Index', year: 2024, abstract: 'This synthetic catalog counts retrieval and generation terminology. It neither retrieves passages for answers nor proposes decoding tokens.' },
}
export const RECALL_ANCHORS: Record<Anchor, string> = { Macaroons: papers.macaroon!.doi!, CaMeL: papers.camel!.arxiv!, RAG: papers.rag!.arxiv!, REST: papers.rest!.arxiv! }
const literal: Record<Scenario, string> = { authority: 'tool instruction security', retrieval: 'retrieval generation' }
const mechanisms: Record<Scenario, string> = { authority: 'restrict delegated authority before sensitive operations', retrieval: 'reuse external text both for knowledge and candidate token continuation' }
function ideaFor(scenario: Scenario): CurrentIdeaIdentity {
  return { statement: literal[scenario], profile: 'Controlled fixture benchmark; not a live semantic evaluation', scope: scenario, mechanism: mechanisms[scenario], prediction: 'Varied query fixtures expose additional known anchors', falsification: 'A linked anchor is absent after its response fixture is consumed', measurement: 'Anchor identities at each collection/review stage', decisionRule: 'Both scenario anchors are retained and reviewed', alternatives: ['single literal-query reference'], assumptions: ['provider fixtures map explicit query facets to fixed papers'], terminology: [], crossDomainAnalogs: [], source: 'given-idea' }
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function envelope(provider: string, rows: Paper[]): Response {
  if (provider === 'arxiv') {
    rows = rows.filter(row => row.arxiv)
    return new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${rows.length}</opensearch:totalResults>${rows.map(row => `<entry><id>https://arxiv.org/abs/${row.arxiv}v1</id><title>${xml(row.title)}</title><summary>${xml(row.abstract)}</summary><author><name>Fixture Metadata Author</name></author><published>${row.year}-01-01T00:00:00Z</published></entry>`).join('')}</feed>`, { status: 200 })
  }
  if (provider === 'crossref') return Response.json({ message: { 'total-results': rows.filter(row => row.doi).length, items: rows.filter(row => row.doi).map(row => ({ DOI: row.doi, title: [row.title], abstract: `<jats:p>${xml(row.abstract)}</jats:p>`, author: [{ given: 'Fixture Metadata', family: 'Author' }], published: { 'date-parts': [[row.year]] } })) } })
  return Response.json({ data: rows.map(row => ({ paperId: row.key, title: row.title, abstract: row.abstract, authors: [{ name: 'Fixture Metadata Author' }], year: row.year, externalIds: { ...(row.doi ? { DOI: row.doi } : {}), ...(row.arxiv ? { ArXiv: row.arxiv } : {}) } })) })
}
function anchorNames(candidates: readonly DiscoveryCandidate[]): Anchor[] {
  return (Object.keys(RECALL_ANCHORS) as Anchor[]).filter(name => candidates.some(candidate => candidate.aliases.some(alias => alias.value === RECALL_ANCHORS[name])))
}
function metrics(pool: DiscoveryCandidate[], report: Pick<SimilaritySurveyReport, 'candidates' | 'nearest' | 'assessments'>) {
  const reviewed = new Set(report.assessments.map(assessment => assessment.candidateId))
  return { collected: anchorNames(pool), retained: anchorNames(report.candidates), shortlisted: anchorNames(report.nearest), reviewed: anchorNames(pool.filter(candidate => reviewed.has(candidate.id))), totalCollected: pool.length, totalRetained: report.candidates.length, totalShortlisted: report.nearest.length, literalDecoysCollected: pool.filter(candidate => candidate.title.startsWith('Fixture:')).length }
}
export async function runControlledRecallBenchmark(outputDir: string) {
  await mkdir(outputDir, { recursive: true })
  if ((await readdir(outputDir)).length) throw new Error('Controlled benchmark requires an empty output directory so cached prior runs cannot skew effort counts')
  const engineBuild = await Promise.all(['contracts', 'coordinator', 'providers', 'ranking', 'reviewer'].map(async module => {
    const url = new URL(`../../dist/literature/discovery/${module}.js`, import.meta.url)
    return { module, sha256: sha(await readFile(url)), modifiedAt: (await stat(url)).mtime.toISOString() }
  }))
  const results = []
  for (const scenario of ['authority', 'retrieval'] as const) for (const variant of ['single-literal-query-reference', 'multiround-multifacet-controller'] as const) {
    const runDir = join(outputDir, `${scenario}-${variant}`); await mkdir(runDir, { recursive: true })
    const store = new ResearchStore(runDir)
    const verified = new Set<string>()
    const sourceStore = { captureBytes: (bytes: Uint8Array | string, id: string) => store.captureBytes(bytes, id), async readSource(ref: { path?: string; hash?: string }) { if (!ref.path || !ref.hash) throw new Error('Uncaptured benchmark source'); const file = resolve(runDir, ref.path); if (!file.startsWith(resolve(runDir) + sep)) throw new Error('Benchmark source path escaped'); const bytes = await readFile(file); if (sha(bytes) !== ref.hash) throw new Error('Benchmark source bytes changed'); verified.add(ref.hash); return bytes } }
    let now = 1_700_000_000_000
    const clock = { now: () => now, sleep: async (ms: number) => { now += ms } }
    const requests: { provider: string; query: string; round: number }[] = []
    const firstSeenRound: Partial<Record<Anchor, number>> = {}
    const providers = createDiscoveryProviders({ sourceStore, fetch: async input => {
      const url = new URL(String(input)), provider = url.hostname.includes('arxiv') ? 'arxiv' : url.hostname.includes('crossref') ? 'crossref' : 'semantic-scholar'
      const query = url.searchParams.get('search_query') ?? url.searchParams.get('query.bibliographic') ?? url.searchParams.get('query') ?? ''
      const round = Number(/round (\d+)$/.exec(query)?.[1] ?? 1)
      requests.push({ provider, query, round })
      // Longer search has a controlled purpose: the missing anchor first appears on the second-round
      // mechanism query, then on the third-round cross-domain query. Other paraphrases return decoys/base work.
      const expands = query === `${mechanisms[scenario]} round 2` || query === `${scenario} cross domain analogy round 3`
      const exposed = scenario === 'authority' ? [papers.camel!, ...(expands ? [papers.macaroon!] : [])] : [papers.rag!, ...(expands ? [papers.rest!] : [])]
      for (const paper of exposed) if (paper.anchor && (provider === 'semantic-scholar' || (provider === 'arxiv' ? paper.arxiv : paper.doi))) firstSeenRound[paper.anchor] ??= round
      return envelope(provider, [...exposed, papers.authorityDecoy!, papers.retrievalDecoy!])
    } })
    let plannerCalls = 0, reviewerCalls = 0
    const reviewerCandidates: string[][] = []
    const reviewer = async ({ candidates, excerpts }: SimilarityReviewerInput) => {
      reviewerCalls++; reviewerCandidates.push(candidates.map(candidate => candidate.id))
      return candidates.map(candidate => { const excerpt = excerpts.find(row => row.candidateId === candidate.id)!; const isAnchor = anchorNames([candidate]).length > 0; return { candidateId: candidate.id, overlap: isAnchor ? ['The supplied mechanism paraphrase connects this anchor to the fixture target.'] : ['Only literal query terminology overlaps.'], differences: isAnchor ? ['Scope and implementation would require a real semantic comparison.'] : ['A keyword index supplies none of the target mechanisms.'], uncertainty: ['Deterministic fixture judgment, not a measured model-quality result.'], relevance: isAnchor ? 'nearest' : 'weak', excerptProofs: [{ candidateId: candidate.id, sourceRef: excerpt.sourceRef, start: excerpt.start, end: excerpt.end, contentHash: excerpt.contentHash }], citationSeeds: [candidate.aliases[0]!.value], followupQueries: [] } })
    }
    const idea = ideaFor(scenario)
    let stages: ReturnType<typeof metrics>, actualHttpAttempts: number, rounds: number, queries: number, resumeDelta = { http: 0, planner: 0, reviewer: 0 }
    if (variant === 'single-literal-query-reference') {
      const query: DiscoveryQuery = { id: `literal-${scenario}`, text: literal[scenario], dimensions: ['problem'], origin: 'model', round: 1 }
      const results = []
      for (const provider of providers) results.push(await provider.search({ query, page: 0, pageSize: 10, signal: new AbortController().signal, now: clock.now }))
      const pool = mergeDiscoveryCandidates(results.flatMap(result => result.candidates)), candidates = rankDiscoveryCandidates(pool, 4), nearest = rankDiscoveryCandidates(candidates, 4)
      const excerpts = await createCandidateExcerpts(nearest, sourceStore.readSource)
      const assessments = await reviewSimilarity({ idea, candidates: nearest, excerpts, callback: reviewer, readSource: sourceStore.readSource })
      stages = metrics(pool, { candidates, nearest, assessments }); actualHttpAttempts = requests.length; rounds = 1; queries = 1
      await writeFile(join(runDir, 'literal-reference.json'), JSON.stringify({ query, results, candidates, nearest, assessments }, null, 2))
    } else {
      const input = { runDir, idea, config: { minRounds: 3, maxRounds: 3, queriesPerRound: 4, maxRequests: 80, maxCandidates: 4, nearestLimit: 4, maxPagesPerQuery: 1 }, providers, sourceStore, clock,
        queryPlanner: async ({ round }: { round: number }) => { plannerCalls++; return [
          { text: `${scenario} problem reformulation round ${round}`, dimensions: ['problem'] },
          { text: `${mechanisms[scenario]} round ${round}`, dimensions: ['mechanism'] },
          { text: `${scenario} alternative terminology round ${round}`, dimensions: ['terminology', 'assumption'] },
          { text: `${scenario} cross domain analogy round ${round}`, dimensions: ['cross-domain'] },
        ] }, reviewer,
      }
      const report = await runSimilaritySurvey(input)
      const poolPath = join(runDir, 'brainstorm/current-idea-survey', report.ideaFingerprint, report.configFingerprint, 'pool.json')
      const pool = (await readDiscoveryRecord<DiscoveryCandidate[]>(poolPath))!
      stages = metrics(pool, report); actualHttpAttempts = report.counts.actualHttpAttempts; rounds = report.roundsCompleted; queries = report.queries.length
      const before = { http: requests.length, planner: plannerCalls, reviewer: reviewerCalls }
      const resumed = await runSimilaritySurvey(input)
      resumeDelta = { http: requests.length - before.http, planner: plannerCalls - before.planner, reviewer: reviewerCalls - before.reviewer }
      if (resumed.surveyId !== report.surveyId) throw new Error('Resume changed survey identity')
    }
    results.push({ scenario, variant, ...stages, firstSeenRound, rounds, queries, actualHttpAttempts, plannerCallbackCalls: plannerCalls, reviewerCallbackCalls: reviewerCalls, modelCallbackCalls: plannerCalls + reviewerCalls, paidModelCalls: 0, liveHttpCalls: 0, resumeDelta, verifiedSourceHashes: verified.size, requests, reviewerCandidates })
  }
  const summary = { kind: 'controlled fixture benchmark', comparison: 'single literal-query reference versus multiround multifacet controller', engineBuild, limits: ['The reference is explicitly constructed; it is not the old model-driven papersurvey implementation.', 'Query-to-result mappings and semantic judgments are deterministic fixtures. This measures controller behavior, not live recall or model semantic quality.', 'All requests use real provider adapter parsing with injected offline transport; captured raw/parsed source bytes are rehashed from disk.', 'Fixture-only decoy identifiers and metadata are synthetic. The four named paper anchor identifiers are public.'], results }
  await writeFile(join(outputDir, 'benchmark-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}
