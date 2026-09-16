import { FileCapabilityRegistry } from '../capabilities/index.js'
import { hashContent } from '../research/index.js'
import type { RunContext } from './context.js'

/** Local bookkeeping uses real call receipts, never discovery as proof of reachability. */
export async function runtimeCapabilities(ctx: RunContext, outcome?: 'passed' | 'failed' | 'unknown'): Promise<string> {
  const registry = new FileCapabilityRegistry(ctx.runDir)
  const previous = await registry.readAll()
  const existing = previous.find(r => r.capabilityId === 'research-worker')
  const now = new Date().toISOString()
  if (!existing || outcome) await registry.put({
    capabilityId: 'research-worker', purpose: 'Outer research worker dispatch and local artifact receipt; scientific and remote-job validity are separate.',
    version: 'role-provider/v1', configFingerprint: hashContent(ctx.policySnapshot.model),
    inputContract: 'frozen protocol and bounded work directory', outputContract: 'structured result and raw artifact paths',
    resourceScope: { data: ctx.runDir, network: 'unknown', device: 'provider-defined' }, concurrency: 1,
    quota: { unit: 'role-call', limit: ctx.policySnapshot.budget.maxRoleCalls }, reproducibility: {},
    cancellation: 'AbortSignal; backend cancellation verification is adapter-dependent', recovery: 'completed receipt reuse; unknown receipt pauses redispatch',
    discoveredAt: existing?.discoveredAt ?? now,
    ...(outcome ? { probe: { outcome, checkedAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString(), details: 'Observed actual worker dispatch/receipt in this run.' } } : {}),
  })
  if (!previous.some(r => r.capabilityId === 'execution-isolation')) await registry.put({
    capabilityId: 'execution-isolation', purpose: 'Filesystem/tool/data-split isolation of studied actors', version: 'unverified',
    inputContract: 'executor-enforced allowlist required', outputContract: 'verified isolation receipt required',
    resourceScope: { data: 'unknown', network: 'unknown', device: 'unknown' }, concurrency: 1, quota: { unit: 'job', limit: 'unknown' },
    reproducibility: {}, cancellation: 'unknown', recovery: 'verify actual executor capabilities', discoveredAt: now,
  })
  return JSON.stringify((await registry.readAll()).map(r => ({ id: r.capabilityId, status: r.status, version: r.version, recovery: r.recovery })))
}
