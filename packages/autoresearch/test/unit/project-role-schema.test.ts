import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { outputSchemaFor } from '../../dist/agents/factory.js'
import { validateDiscovery } from '../../dist/project/discovery.js'

test('project-explorer output schema is supported by the actual DSH transport', () => {
  const schema = outputSchemaFor('project-explorer')
  assert.doesNotThrow(() => assertObjectJsonSchema(schema))
  assert.doesNotThrow(() => validateJsonSchemaValue(schema as never, {
    contributions: [{ id: 'c', claim: 'implementation', status: 'proposed', sourceIds: ['s'], limitations: ['untested'], validation: ['paired comparison'], researchQuestion: 'does it help?' }],
    historicalResults: [], selectedId: 'c', selectionReason: 'bounded',
  }))
})

test('project contribution count remains enforced after removing unsupported schema keywords', () => {
  const inventory = { files: [{ source: { id: 's' } }] } as never
  for (const contributions of [[], Array.from({ length: 6 }, (_, i) => ({ id: `c${i}` }))]) {
    assert.throws(() => validateDiscovery({ contributions, historicalResults: [], selectedId: 'c0', selectionReason: 'bounded' }, inventory), /invalid project discovery structure/)
  }
})
