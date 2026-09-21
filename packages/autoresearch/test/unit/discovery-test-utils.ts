import { createHash } from 'node:crypto'
export const fixtureIdea = { statement: 'Scoped capabilities for retrieved instructions', profile: 'Security research', scope: 'retrieved instructions in delegated execution', mechanism: 'attenuate authority before execution', prediction: 'contextual restrictions reduce unauthorized effects', falsification: 'unrestricted execution performs equally safely', measurement: 'unauthorized action rate', decisionRule: 'paired_sign_test_v1', alternatives: ['static allowlist'], assumptions: ['untrusted retrieval'], terminology: ['capability'], crossDomainAnalogs: ['information flow'], source: 'given-idea' as const }
export function memorySources() {
  const values = new Map<string, Uint8Array>()
  return { values, async captureBytes(input: string | Uint8Array, id: string) { const bytes = typeof input === 'string' ? Buffer.from(input) : input; const hash = createHash('sha256').update(bytes).digest('hex'); values.set(hash, bytes); return { id, hash, path: hash } }, async readSource(ref: any) { return values.get(ref.hash)! } }
}
export function fakeClock() { let time = 1_700_000_000_000; return { now: () => time, sleep: async (ms: number) => { time += ms }, advance: (ms: number) => { time += ms } } }
// Short paraphrases, not full copyrighted abstracts. Identifiers and envelope shapes are provider fixtures.
export const abstracts = {
  macaroon: 'Delegated credentials narrow authority by appending restrictions that a verifier checks.',
  camel: 'A separate execution policy prevents untrusted text from authorizing sensitive tool actions.',
  rag: 'A generator combines its parameters with retrieved passages to answer knowledge-intensive questions.',
  rest: 'Previously observed text continuations are retrieved to propose several speculative decoding tokens.'
}
export function providerFixture(urlValue: string | URL | Request): Response {
  const url = new URL(String(urlValue))
  if (url.hostname.includes('arxiv')) return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>2</opensearch:totalResults><entry><id>http://arxiv.org/abs/2503.18813v1</id><title>CaMeL</title><summary>${abstracts.camel}</summary><author><name>Research Team</name></author><published>2025-03-24T00:00:00Z</published></entry><entry><id>http://arxiv.org/abs/2005.11401v1</id><title>Retrieval-Augmented Generation</title><summary>${abstracts.rag}</summary><author><name>Research Team</name></author><published>2020-05-22T00:00:00Z</published></entry></feed>`, { status: 200 })
  if (url.hostname.includes('crossref')) return new Response(JSON.stringify({ message: { 'total-results': 1, items: [{ DOI: '10.14722/ndss.2014.23212', title: ['Macaroons'], abstract: `<jats:p>${abstracts.macaroon}</jats:p>`, published: { 'date-parts': [[2014]] } }] } }), { status: 200 })
  return new Response(JSON.stringify({ data: [{ paperId: 's2-rest', title: 'REST', abstract: abstracts.rest, year: 2023, externalIds: { ArXiv: '2311.08252' }, authors: [] }, { paperId: 's2-camel', title: 'CaMeL', abstract: abstracts.camel, year: 2025, externalIds: { ArXiv: '2503.18813' }, authors: [] }] }), { status: 200 })
}
export const queryPlan = async ({ round }: any) => [{ text: `bounded delegation ${round}`, dimensions: ['mechanism', 'terminology'] }, { text: `untrusted instruction information flow ${round}`, dimensions: ['problem', 'assumption', 'cross-domain'] }]
export const groundedReview = async ({ candidates, excerpts }: any) => candidates.map((c: any) => {
  const e = excerpts.find((x: any) => x.candidateId === c.id)
  return { candidateId: c.id, overlap: ['Possible related mechanism'], differences: ['Scope needs human comparison'], uncertainty: ['Only provider metadata was searched'], relevance: 'related', excerptProofs: [{ candidateId: c.id, sourceRef: e.sourceRef, start: e.start, end: e.end, contentHash: e.contentHash }], followupQueries: [], citationSeeds: [c.aliases[0].value] }
})
