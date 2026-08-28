import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson } from '../../dist/agents/json-repair.js'

test('extractJson parses direct JSON', () => {
  assert.deepEqual(extractJson('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] })
})

test('extractJson parses fenced JSON', () => {
  const text = 'Result:\n```json\n{"ok":true,"items":["x"]}\n```\nDone.'
  assert.deepEqual(extractJson(text), { ok: true, items: ['x'] })
})

test('extractJson repairs trailing commas', () => {
  const text = 'Here is the data: {"a":1,"b":2,}'
  assert.deepEqual(extractJson(text), { a: 1, b: 2 })
})

test('extractJson returns undefined for plain text', () => {
  assert.equal(extractJson('no json here'), undefined)
})
