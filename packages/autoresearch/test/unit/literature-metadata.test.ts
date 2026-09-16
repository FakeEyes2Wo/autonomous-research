import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMetadata } from '../../dist/literature/metadata.js'

test('Crossref provenance verifies its DOI without silently endorsing an unrelated arXiv alias', async () => {
  const result = await resolveMetadata({ title: 'A study', doi: '10.1234/study', arxivId: '2401.01234' }, {
    signal: new AbortController().signal,
    fetch: async url => {
      assert.match(String(url), /api\.crossref\.org\/works\//)
      return Response.json({ message: { DOI: '10.1234/study', title: ['A study'], author: [{ given: 'Ada', family: 'Lovelace' }] } })
    },
  })
  assert.equal(result.work.status, 'verified_metadata')
  assert.deepEqual(result.work.authors, ['Ada Lovelace'])
  assert.ok(result.work.aliases.every(a => a.kind !== 'arxiv'))
  assert.equal(result.rawResponses.length, 1)
  assert.equal(result.work.metadataSources[0]?.length, 64)
})

test('metadata identity mismatch remains a candidate rather than a verified citation', async () => {
  const result = await resolveMetadata({ title: 'Wanted work', doi: '10.1234/a' }, {
    signal: new AbortController().signal,
    fetch: async () => Response.json({ message: { DOI: '10.1234/b', title: ['Other work'], author: [] } }),
  })
  assert.equal(result.work.status, 'candidate')
  assert.ok(result.conflicts.length > 0)
  assert.equal(result.work.authors, null)
})

test('arXiv response retains authors and validates the requested version identity', async () => {
  const result = await resolveMetadata({ title: 'Study & result', arxivId: '2401.01234v2' }, {
    signal: new AbortController().signal,
    fetch: async () => new Response('<feed><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>Study &amp; result</title><author><name>Author A</name></author></entry></feed>'),
  })
  assert.equal(result.work.status, 'verified_metadata')
  assert.deepEqual(result.work.authors, ['Author A'])
})

test('metadata unavailability returns an explicit gap without inventing authors', async () => {
  const result = await resolveMetadata({ title: 'A', doi: '10.1234/a' }, {
    signal: new AbortController().signal, fetch: async () => new Response('', { status: 404 }),
  })
  assert.equal(result.work.authors, null)
  assert.equal(result.work.status, 'candidate')
  assert.ok(result.conflicts.some(c => c.includes('404')))
})
