import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directionId, validateManagedRelativePath, type CleanupTask, type DirectionRef } from '../../dist/cleanup/direction-id.js'

const base: DirectionRef = {
  projectId: 'C:/project',
  branchId: 'branch-1',
  claim: { id: 'claim-1', version: 1 },
  hypothesis: { id: 'hypothesis-1', version: 1 },
  protocolHash: 'protocol-a',
}

test('direction identity is stable but separates hypothesis versions and protocols', () => {
  const first = directionId(base)
  assert.equal(first, directionId({ ...base }))
  assert.notEqual(first, directionId({ ...base, hypothesis: { ...base.hypothesis, version: 2 } }))
  assert.notEqual(first, directionId({ ...base, protocolHash: 'protocol-b' }))
})

test('managed relative paths reject traversal and absolute or user-owned roots', () => {
  assert.doesNotThrow(() => validateManagedRelativePath('work/cycle-01/result.json'))
  for (const path of ['../input.md', '/outside', 'C:/outside', 'work\\result.json', '']) {
    assert.throws(() => validateManagedRelativePath(path), /managed|relative|escape|invalid/i)
  }
})

test('cleanup task disposition is explicit and cannot use a generic failed run status', () => {
  const task: CleanupTask = {
    schema: 'autoresearch/cleanup-task/v1',
    id: 'cleanup-1',
    direction: base,
    directionId: directionId(base),
    disposition: 'refuted',
    state: 'pending',
    idea: 'A bounded idea',
    reason: 'formal opposing evidence under the frozen protocol',
    avoidRepeat: 'Do not retry the same mechanism under the same constraints.',
    runDir: 'C:/runs/run-1',
    targets: [],
    memory: { id: 'direction-memory-1', version: 1, contentHash: 'memory-hash' },
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
  assert.equal(task.disposition, 'refuted')
  assert.notEqual(task.disposition, 'failed')
})
