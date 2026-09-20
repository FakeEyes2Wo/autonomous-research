import { createVerifiedReceipt } from '../harness/verified-receipt.js'
import { readObservation, readObservationMetadata } from '../harness/observation-pack.js'
import type { ToolDefinitionLike } from './index.js'
import { jsonOutput, runDirSchema, stringSchema } from './schemas.js'

export const researchObservationRead: ToolDefinitionLike = {
  name: 'research_observation_read',
  description: 'Read an archived observation by exact UTF-8-safe byte page.',
  parameters: {
    type: 'object', properties: { runDir: runDirSchema, handle: stringSchema('Observation handle returned by research_tree_query'), offset: { type: 'number' }, limitBytes: { type: 'number' } },
    required: ['runDir', 'handle'], additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    return readObservation(String(args.handle), { runDir: String(args.runDir), ...(typeof args.offset === 'number' ? { offset: args.offset } : {}), ...(typeof args.limitBytes === 'number' ? { limitBytes: args.limitBytes } : {}) })
  },
}

export const researchVerifiedReceipt: ToolDefinitionLike = {
  name: 'research_verified_receipt',
  description: 'Create a deterministic receipt for exact archived bytes and quotes; scientific status remains unverified.',
  parameters: {
    type: 'object', properties: { runDir: runDirSchema, handle: stringSchema('Observation handle'), source: stringSchema('Source label'), quotes: { type: 'array', items: { type: 'string' } } },
    required: ['runDir', 'handle', 'source', 'quotes'], additionalProperties: false,
  },
  output: jsonOutput,
  async execute(args) {
    const handle = String(args.handle)
    const page = await readObservation(handle, { runDir: String(args.runDir), offset: 0, limitBytes: Number.MAX_SAFE_INTEGER })
    const metadata = await readObservationMetadata(handle, { runDir: String(args.runDir) })
    return createVerifiedReceipt({ source: String(args.source), text: page.text, expectedHash: metadata.contentHash, quotes: Array.isArray(args.quotes) ? args.quotes.map(String) : [], exitStatus: metadata.exitStatus, measure: (receipt) => Buffer.byteLength(JSON.stringify(receipt, null, 2), 'utf8') })
  },
}
