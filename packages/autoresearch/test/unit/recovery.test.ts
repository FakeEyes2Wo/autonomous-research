import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from '../../dist/service/utils.js'

test('withRetry retries once and succeeds', async () => {
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary')
    return 'ok'
  }, 'op')
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('withRetry gives up after attempts', async () => {
  let calls = 0
  await assert.rejects(() => withRetry(async () => {
    calls += 1
    throw new Error('always')
  }, 'op'), /always/)
  assert.equal(calls, 2)
})
