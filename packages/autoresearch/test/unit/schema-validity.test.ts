import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outputSchemaFor } from '../../dist/agents/factory.js'

const roles = [
  'rubric-generator',
  'rubric-reviewer',
  'idea-generator',
  'idea-falsifiability',
  'idea-reviewer',
  'hypothesis-reviser',
  'planner',
  'research-worker',
  'evidence-agent',
  'supervisor',
  'writer',
] as const

function findInvalidRequired(node: unknown, path: string): string[] {
  const errors: string[] = []
  if (Array.isArray(node)) {
    node.forEach((value, index) => errors.push(...findInvalidRequired(value, `${path}[${index}]`)))
    return errors
  }
  if (typeof node !== 'object' || node === null) return errors
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'required' && typeof value === 'boolean') {
      errors.push(`${path}.required is boolean`)
    }
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      errors.push(`${path}.additionalProperties must be boolean`)
    }
    errors.push(...findInvalidRequired(value, `${path}.${key}`))
  }
  return errors
}

test('all role output schemas are valid JSON Schema (no boolean required)', () => {
  for (const role of roles) {
    const schema = outputSchemaFor(role)
    if (!schema) continue
    const errors = findInvalidRequired(schema, role)
    assert.deepEqual(errors, [], `${role} has invalid schema: ${errors.join('; ')}`)
  }
})
