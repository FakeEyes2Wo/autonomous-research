import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIdentity } from '../../dist/literature/identity.js'

test('arXiv work aliases exclude the version but retain its version number', () => {
  const first = normalizeIdentity({ title: 'A', arxivId: 'arXiv:2401.01234v1' })
  const second = normalizeIdentity({ title: 'A', url: 'https://arxiv.org/pdf/2401.01234v2' })
  assert.equal(first.arxivVersion, 1)
  assert.equal(second.arxivVersion, 2)
  assert.ok(first.aliases.some(a => a.kind === 'arxiv' && a.value === '2401.01234'))
  assert.ok(second.aliases.some(a => a.kind === 'arxiv' && a.value === '2401.01234'))
})

test('DOI resolver normalization preserves old arXiv identifiers and URL path case', () => {
  const result = normalizeIdentity({ title: '  Some   Title ', doi: 'https://doi.org/10.1234/ABC',
    arxivId: 'hep-th/9901001v3', url: 'https://EXAMPLE.org/CaseSensitive?key=AbC' })
  assert.ok(result.aliases.some(a => a.kind === 'doi' && a.value === '10.1234/abc'))
  assert.ok(result.aliases.some(a => a.kind === 'arxiv' && a.value === 'hep-th/9901001'))
  assert.ok(result.aliases.some(a => a.kind === 'url' && a.value === 'https://example.org/CaseSensitive?key=AbC'))
  assert.equal(result.titleKey, 'some title')
})

test('invalid and conflicting identifiers are rejected instead of merged', () => {
  assert.throws(() => normalizeIdentity({ title: 'A', arxivId: 'not-an-id' }), /INVALID_IDENTITY/)
  assert.throws(() => normalizeIdentity({ title: 'A', doi: 'hello' }), /INVALID_IDENTITY/)
  assert.throws(() => normalizeIdentity({ title: 'A', arxivId: '2401.01234', url: 'https://arxiv.org/abs/2402.12345' }), /IDENTITY_CONFLICT/)
})
