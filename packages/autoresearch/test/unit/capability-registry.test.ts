import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCapabilityRegistry } from '../../dist/capabilities/index.js'

const discovered = {
  capabilityId: 'local-python',
  purpose: 'run local analysis',
  version: '3.12',
  inputContract: { type: 'argv' },
  outputContract: { type: 'process-result' },
  resourceScope: { data: 'project', network: false, device: 'cpu' },
  concurrency: 1,
  quota: { unit: 'process', limit: 1 },
  reproducibility: { command: 'python --version' },
  cancellation: 'terminate process',
  recovery: 'rerun only after process status is known',
  discoveredAt: '2026-09-12T00:00:00.000Z',
} as const

test('capability registry never promotes discovery or configuration to availability', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-capability-state-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const registry = new FileCapabilityRegistry(runDir, { now: () => new Date('2026-09-12T12:00:00.000Z') })
  assert.equal((await registry.put(discovered)).status, 'discovered')
  assert.equal((await registry.put({ ...discovered, configFingerprint: 'config-v1' })).status, 'configured')
  const expired = await registry.put({
    ...discovered,
    configFingerprint: 'config-v1',
    probe: { outcome: 'passed', checkedAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-09-11T01:00:00.000Z', details: 'historical success' },
  })
  assert.equal(expired.status, 'probed')
})

test('capability registry requires an unexpired successful probe for available', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-capability-probe-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const registry = new FileCapabilityRegistry(runDir, { now: () => new Date('2026-09-12T12:00:00.000Z') })
  const available = await registry.put({
    ...discovered,
    configFingerprint: 'config-v1',
    probe: { outcome: 'passed', checkedAt: '2026-09-12T11:00:00.000Z', expiresAt: '2026-09-12T13:00:00.000Z', details: 'local smoke test' },
  })
  const unavailable = await registry.put({
    ...discovered,
    capabilityId: 'remote-model',
    configFingerprint: 'route-v1',
    probe: { outcome: 'failed', checkedAt: '2026-09-12T11:00:00.000Z', expiresAt: '2026-09-12T13:00:00.000Z', details: 'endpoint rejected', failureStatus: 'unavailable' },
  })
  assert.equal(available.status, 'available')
  assert.equal(unavailable.status, 'unavailable')
})

test('capability registry expires health on read and serializes bounded concurrent updates', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-capability-bounded-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let now = new Date('2026-09-12T12:00:00.000Z')
  const registry = new FileCapabilityRegistry(runDir, { maxRecords: 2, now: () => now })
  const healthy = { ...discovered, configFingerprint: 'config-v1', probe: { outcome: 'passed' as const, checkedAt: '2026-09-12T11:00:00.000Z', expiresAt: '2026-09-12T13:00:00.000Z', details: 'local smoke' } }
  await Promise.all([
    registry.put(healthy),
    registry.put({ ...healthy, capabilityId: 'local-node' }),
  ])
  assert.deepEqual((await registry.readAll()).map((entry) => entry.capabilityId), ['local-node', 'local-python'])
  now = new Date('2026-09-12T14:00:00.000Z')
  assert.deepEqual((await registry.readAll()).map((entry) => entry.status), ['probed', 'probed'])
})
