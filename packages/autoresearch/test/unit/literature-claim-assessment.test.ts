import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { checkCitationLocators, createClaimAssessment, saveClaimAssessment, loadClaimAssessments } from '../../dist/literature/claim-assessment.js'
import type { SourceSpan } from '../../dist/literature/contracts.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const span: SourceSpan = { id: 's1', workId: 'w', documentId: 'd', parserFingerprint: hash('parser'), kind: 'paragraph', sectionPath: ['Result'],
  evidenceText: 'negative result', retrievalText: 'negative result', locator: { kind: 'text', start: 0, end: 15, unit: 'utf16', sourceHash: hash('negative result') },
  contentHash: hash('negative result'), visibility: { projectId: 'p', partitionId: 'public', roles: ['reader'], policyHash: hash('policy') }, quality: 'accepted', sourceKind: 'full_text' }
const input = { claimId: 'claim', spanIds: ['s1'], relation: 'supports' as const, conditions: ['dev split only'], assessor: 'unreviewed' as const, assessorVersion: 'model-v1' }

test('located citation IDs require valid hashes and locators, not just matching ID strings', () => {
  assert.deepEqual(checkCitationLocators([{ id: 'c1', spanIds: ['s1'] }, { id: 'c2', spanIds: ['forged'] }], [span]), { located: ['c1'], missing: ['c2'] })
  for (const invalid of [{ ...span, evidenceText: 'tampered' }, { ...span, locator: { ...span.locator, end: -1 } }]) {
    assert.deepEqual(checkCitationLocators([{ id: 'c', spanIds: ['s1'] }], [invalid as SourceSpan]), { located: [], missing: ['c'] })
  }
  assert.deepEqual(checkCitationLocators([{ id: 'c', spanIds: [] }], [span]), { located: [], missing: ['c'] })
})

test('unreviewed model claims remain unknown even when all source locators exist', () => {
  const result = createClaimAssessment(input, [span])
  assert.equal(result.locatorValid, true)
  assert.equal(result.relation, 'unknown')
  assert.equal(createClaimAssessment({ ...input, assessor: 'human', relation: 'refutes' }, [span]).relation, 'refutes')
  assert.equal(createClaimAssessment({ ...input, assessor: 'human', spanIds: ['invented'] }, [span]).relation, 'unknown')
})

test('registered assessments bind exact evidence, retain history and reject altered stored records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claim-assessment-'))
  try {
    const assessment = createClaimAssessment({ ...input, assessor: 'human', relation: 'refutes' }, [span])
    await saveClaimAssessment(root, assessment, [span])
    await saveClaimAssessment(root, assessment, [span])
    assert.deepEqual(await loadClaimAssessments(root), [assessment])
    await assert.rejects(saveClaimAssessment(root, { ...assessment, evidenceHash: hash('forged') }, [span]), /ASSESSMENT_EVIDENCE_MISMATCH/)
    const directory = join(root, 'literature', 'claim-assessments')
    const [file] = await readdir(directory)
    await writeFile(join(directory, file!), JSON.stringify({ ...assessment, relation: 'supports' }))
    await assert.rejects(loadClaimAssessments(root), /ASSESSMENT_CORRUPT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
