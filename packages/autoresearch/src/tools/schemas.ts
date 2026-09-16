import { EVIDENCE_VERDICTS, RESEARCH_NODE_KINDS } from '../core/types.js'
import { HUMAN_REVIEW_MODES } from '../session/auto-mode.js'

export const runDirSchema = {
  type: 'string',
  description: 'Research run directory',
}

export const failureReportSchema = {
  type: 'object', description: 'Explicitly import a historical failure report into this new run; source history is preserved and text remains unverified.',
  properties: { sourceRunId: { type: 'string' }, sourcePath: { type: 'string', description: 'Absolute path to the source report' } },
  required: ['sourceRunId', 'sourcePath'], additionalProperties: false,
}

export function stringSchema(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra }
}

export function stringArraySchema(description: string): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string' },
    description,
  }
}

export const humanReviewModeSchema = {
  type: 'string',
  enum: [...HUMAN_REVIEW_MODES],
}

export const researchNodeKindSchema = {
  type: 'string',
  enum: [...RESEARCH_NODE_KINDS],
  description: 'Node kind',
}

export const evidenceVerdictSchema = {
  type: 'string',
  enum: [...EVIDENCE_VERDICTS],
  description: 'Evidence verdict',
}

export function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
}
