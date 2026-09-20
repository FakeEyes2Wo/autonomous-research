import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * Paper-writing input section headings.
 */
export const paperSectionTitles = {
  evidenceChainPath: 'evidence_chain.json',
  paperPlan: 'PAPER_PLAN',
  paperMatrix: 'Claims-Evidence Matrix',
  paperTemplate: 'Selected Venue Template',
  paperLayout: 'Host Layout Profile and Figure Constraints',
  paperReviewContext: 'Host Review Artifacts, Binding, Budget and Coverage',
  paperContract: 'PAPER_ACCEPTANCE_CONTRACT',
  paperFigures: 'FIGURES / latex_includes.tex',
  styleProfile: 'Style Profile',
  venue: 'Venue',
  assurance: 'Assurance',
  paperPath: 'Paper Directory',
  figureImages: 'Figure Images',
} as const

const reviewSchema = objectSchema({
  verdict: { type: 'string', enum: ['PASS', 'REVISE', 'BLOCKED'], required: true },
  issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    severity: { type: 'string', enum: ['critical', 'major', 'minor'], required: true },
    code: { type: 'string', required: true }, detail: { type: 'string', required: true }, repair: { type: 'string', required: true },
    location: { type: 'object', properties: { source: { type: 'string' }, page: { type: 'integer' }, objectId: { type: 'string' } }, additionalProperties: false },
  } } },
  score: { type: 'number' }, critical: { type: 'array', items: { type: 'string' } }, major: { type: 'array', items: { type: 'string' } }, minor: { type: 'array', items: { type: 'string' } },
})
const reviewSections = ['evidenceChainPath', 'paperPath', 'paperPlan', 'paperMatrix', 'paperContract', 'paperFigures', 'paperLayout', 'paperReviewContext', 'figureImages', 'assurance'] as const

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
      'paperLayout',
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
    sections: ['evidenceChainPath', 'paperMatrix', 'styleProfile', 'venue', 'assurance', 'paperLayout'],
    outputSchema: objectSchema({
      plan: { type: 'string', required: true },
      figures: { type: 'array', items: { type: 'string' } },
      citations: { type: 'array', items: { type: 'string' } },
    }),
  },
  'contract-negotiator': {
    sections: ['plan', 'evidenceChainPath', 'paperPlan', 'paperMatrix', 'paperContract', 'paperLayout', 'venue'],
    outputSchema: objectSchema({
      contract: { type: 'string', required: true },
    }),
  },
  'figure-generator': {
    sections: ['plan', 'evidenceChainPath', 'paperPlan', 'paperMatrix', 'paperFigures', 'figureImages', 'paperLayout'],
    outputSchema: objectSchema({
      scripts: { type: 'object', additionalProperties: true, required: true },
      latexIncludes: { type: 'string' },
      notes: { type: 'string' },
    }),
  },
  'proof-checker': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath', 'paperReviewContext'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'claim-auditor': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath', 'paperReviewContext'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'citation-auditor': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath', 'paperReviewContext'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      issues: { type: 'array', items: { type: 'string' }, required: true },
      json: { type: 'string' },
    }),
  },
  'kill-argument-reviewer': {
    sections: ['evidenceChainPath', 'assurance', 'paperPath', 'paperReviewContext'],
    outputSchema: objectSchema({
      verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
      reason_code: { type: 'string' },
      memo: { type: 'string', required: true },
      json: { type: 'string' },
    }),
  },
  'paper-reviewer': {
    sections: reviewSections,
    outputSchema: reviewSchema,
  },
  'figure-reviewer': { sections: reviewSections, outputSchema: reviewSchema },
  'paper-contract-reviewer': { sections: reviewSections, outputSchema: reviewSchema },
  'layout-reviewer': { sections: reviewSections, outputSchema: reviewSchema },
  'paper-polisher': {
    sections: ['plan', 'evidenceChainPath', 'paperPath', 'paperLayout'],
    outputSchema: objectSchema({
      mainTex: { type: 'string', required: true },
      sections: { type: 'object', additionalProperties: true },
      changes: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
} satisfies Record<string, RoleSpec>
