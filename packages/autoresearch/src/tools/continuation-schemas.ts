export const acceptanceSchema = {
  type: 'object', additionalProperties: false, required: ['criteria'], properties: {
    criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'required', 'text', 'evidenceKind'], properties: {
      id: { type: 'string' }, required: { type: 'boolean' }, text: { type: 'string' }, evidenceKind: { type: 'string', enum: ['artifact', 'review', 'scientific'] },
    } } },
  },
}
export const recoverySchema = {
  type: 'object', additionalProperties: false, required: ['changedCondition'], properties: {
    changedCondition: { type: 'string' }, newEvidencePaths: { type: 'array', items: { type: 'string' } },
    criterionIds: { type: 'array', items: { type: 'string' } },
  },
}
