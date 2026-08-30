import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * Paper-writing input section headings.
 */
export const paperSectionTitles = {
  evidenceChainPath: 'evidence_chain.json',
  paperPlan: 'PAPER_PLAN',
  paperMatrix: 'Claims-Evidence Matrix',
  paperTemplate: 'ICLR Template',
  paperContract: 'PAPER_ACCEPTANCE_CONTRACT',
  paperFigures: 'FIGURES / latex_includes.tex',
  styleProfile: 'Style Profile',
  venue: 'Venue',
  assurance: 'Assurance',
  paperPath: 'Paper Directory',
  figureImages: 'Figure Images',
} as const

/**
 * Paper-writing roles: plan/contract/figures/writer/audits/review/polish/report.
 */
export const paperRoleSpecs = {
  writer: {
    sections: [
      'plan',
      'evidenceChainPath',
      'paperPlan',
      'paperMatrix',
      'paperTemplate',
      'paperContract',
      'paperFigures',
      'styleProfile',
      'minimalVerification',
      'experimentDesign',
      'reflexion',
      'insight',
      'modelScout',
    ],
    outputSchema: objectSchema({
      mainTex: { type: 'string', required: true },
      bib: { type: 'string' },
      sections: { type: 'object', additionalProperties: true },
      failureReport: { type: 'string', required: true },
    }),
  },
  'paper-planner': {
    sections: ['evidenceChainPath', 'paperMatrix', 'styleProfile', 'venue', 'assurance'],
    outputSchema: objectSchema({
      plan: { type: 'string', required: true },
      figures: { type: 'array', items: { type: 'string' } },
      citations: { type: 'array', items: { type: 'string' } },
    }),
  },
  'contract-negotiator': {
    sections: ['plan', 'evidenceChainPath', 'paperPlan', 'paperMatrix', 'paperContract'],
    outputSchema: objectSchema({
      contract: { type: 'string', required: true },
    }),
  },
  'figure-generator': {
    sections: ['plan', 'evidenceChainPath', 'paperPlan', 'paperMatrix', 'paperFigures', 'figureImages'],
    outputSchema: objectSchema({
      scripts: { type: 'object', additionalProperties: true, required: true },
      latexIncludes: { type: 'string' },
      notes: { type: 'string' },
    }),
  },
  'proof-checker': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'claim-auditor': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'citation-auditor': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'kill-argument-reviewer': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      reason_code: { type: 'string' },
      memo: { type: 'string', required: true },
      json: { type: 'string' },
    }),
  },
  'paper-reviewer': {
    sections: ['evidenceChainPath', 'paperPath'],
    outputSchema: objectSchema({
      score: { type: 'number', required: true },
      critical: { type: 'array', items: { type: 'string' }, required: true },
      major: { type: 'array', items: { type: 'string' }, required: true },
      minor: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
  'paper-polisher': {
    sections: ['evidenceChainPath', 'paperPath'],
    outputSchema: objectSchema({
      mainTex: { type: 'string', required: true },
      sections: { type: 'object', additionalProperties: true },
      changes: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
} satisfies Record<string, RoleSpec>
