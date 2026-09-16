export type CapabilityStatus = 'discovered' | 'configured' | 'probed' | 'available' | 'degraded' | 'unavailable'

export interface CapabilityProbe {
  readonly outcome: 'passed' | 'failed' | 'unknown'
  readonly checkedAt: string
  readonly expiresAt: string
  readonly details: string
  readonly failureStatus?: 'degraded' | 'unavailable'
}

export interface CapabilityRecordInput {
  readonly capabilityId: string
  readonly purpose: string
  readonly version: string
  readonly configFingerprint?: string
  readonly credentialRef?: string
  readonly inputContract: unknown
  readonly outputContract: unknown
  readonly resourceScope: { readonly data: string; readonly network: boolean | 'unknown'; readonly device: string }
  readonly concurrency: number
  readonly quota: { readonly unit: string; readonly limit: number | 'unknown' }
  readonly reproducibility: { readonly command?: string; readonly environmentHash?: string }
  readonly probe?: CapabilityProbe
  readonly cancellation: string
  readonly recovery: string
  readonly discoveredAt: string
}

export interface CapabilityRecord extends CapabilityRecordInput {
  readonly status: CapabilityStatus
  readonly contentHash: string
}

