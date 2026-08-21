import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterDenylist, containsDenylistedToken } from '../../dist/security/denylist.js'
import { detectLeakage, assertNoLeakage } from '../../dist/security/leakage.js'

const meta = {
  arxiv_id: '2402.16897',
  title: 'Reliable Conflictive Multi-View Learning',
  authors: ['Cai Xu', 'Jiajun Si'],
  source_urls: { abs: 'https://arxiv.org/abs/2402.16897' },
}

test('denylist filters target paper identifiers', () => {
  const text = 'See 2402.16897 by Cai Xu titled Reliable Conflictive Multi-View Learning'
  const filtered = filterDenylist(text, meta)
  assert.equal(filtered.includes('2402.16897'), false)
  assert.equal(filtered.includes('Cai Xu'), false)
  assert.equal(filtered.includes('[REDACTED]'), true)
})

test('leakage detection catches target metadata', () => {
  assert.equal(containsDenylistedToken('arxiv 2402.16897', meta), true)
  assert.deepEqual(detectLeakage('clean text', meta), [])
  assert.throws(() => assertNoLeakage('title Reliable Conflictive Multi-View Learning', meta), /LEAKAGE_FAIL/)
})
