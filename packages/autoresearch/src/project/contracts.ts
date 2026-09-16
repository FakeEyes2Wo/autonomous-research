import type { SourceRef } from '../research/contracts.js'

export interface InventoryLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
  maxEntries: number
}
export interface ProjectInventory {
  version: 1
  projectDir: string
  limits: InventoryLimits
  files: Array<{ relativePath: string; bytes: number; lines: number; source: SourceRef }>
  omissions: Array<{ path: string; reason: string }>
  totalBytes: number
  hash: string
}
export interface ProjectDiscovery {
  contributions: Array<{
    id: string
    claim: string
    status: 'observed-implementation' | 'proposed'
    sourceIds: string[]
    limitations: string[]
    validation: string[]
    researchQuestion: string
  }>
  historicalResults: Array<{ statement: string; sourceIds: string[]; status: 'unverified' }>
  selectedId: string
  selectionReason: string
}
export interface ProjectDiscoveryCheckpoint {
  version: 1
  inventoryHash: string
  discovery: ProjectDiscovery
  candidateHash: string
  hash: string
}
