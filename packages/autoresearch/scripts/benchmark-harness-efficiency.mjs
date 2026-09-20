import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { researchHypothesisAdd, researchActionStart, researchActionFinish, researchEvidenceAdd, researchTreeQuery, researchObservationRead, researchVerifiedReceipt } = await import('../dist/tools/index.js')
const { estimateContextTokens, renderLabeledContextEntries } = await import('../dist/harness/context-budget.js')

const exec = { signal: new AbortController().signal }
const dir = await mkdtemp(join(tmpdir(), 'ar-harness-benchmark-'))
const renderBytes = (tool, args, value) => Buffer.byteLength(tool.output.render(args, value)[0]?.text ?? '', 'utf8')
try {
  const hypothesis = await researchHypothesisAdd.execute({ runDir: dir, content: 'benchmark hypothesis ' + 'x'.repeat(12000) }, exec)
  const action = await researchActionStart.execute({ runDir: dir, hypothesisId: hypothesis.id, content: 'baseline action' }, exec)
  const baselineAction = await researchActionFinish.execute({ runDir: dir, actionId: action.id, status: 'completed', summary: 'done' }, exec)
  const baselineEvidence = await researchEvidenceAdd.execute({ runDir: dir, actionId: action.id, content: 'observed fixture evidence', verdict: 'supports' }, exec)

  const fusedAction = await researchActionStart.execute({ runDir: dir, hypothesisId: hypothesis.id, content: 'fused action' }, exec)
  const fused = await researchActionFinish.execute({ runDir: dir, actionId: fusedAction.id, status: 'completed', summary: 'done', evidence: [{ content: 'observed fixture evidence', verdict: 'supports' }] }, exec)
  const queryBaseline = await researchTreeQuery.execute({ runDir: dir }, exec)
  const packed = await researchTreeQuery.execute({ runDir: dir, packObservation: true, observationTaskId: 'benchmark-task', observationDirection: 'benchmark-direction' }, exec)
  const pageArgs = packed.observation ? { runDir: dir, handle: packed.observation.handle, limitBytes: 512 } : undefined
  const page = pageArgs ? await researchObservationRead.execute(pageArgs, exec) : undefined
  const receipt = packed.observation && page ? await researchVerifiedReceipt.execute({ runDir: dir, handle: packed.observation.handle, source: 'benchmark-tree-query', quotes: [page.text] }, exec) : undefined

  const repeated = 'same repeated scientific context '.repeat(30)
  const before = `### treeSummary\n${repeated}\n\n### evidence\n${repeated}`
  const after = renderLabeledContextEntries([{ field: 'treeSummary', text: repeated }, { field: 'evidence', text: repeated }])
  console.log(JSON.stringify({
    fixtureOnly: true,
    observation: { baselineRenderedBytes: renderBytes(researchTreeQuery, { runDir: dir }, queryBaseline), packedResponseRenderedBytes: renderBytes(researchTreeQuery, { runDir: dir, packObservation: true }, packed), exactPageSourceBytes: page?.bytes ?? 0, exactPageRenderedBytes: page ? renderBytes(researchObservationRead, pageArgs, page) : 0, packedPlusPageRenderedBytes: renderBytes(researchTreeQuery, { runDir: dir, packObservation: true }, packed) + (page ? renderBytes(researchObservationRead, pageArgs, page) : 0), archiveHandleReturned: Boolean(packed.observation) },
    actionFusion: { toolCallsBaseline: 2, toolCallsFused: 1, baselineOutputBytes: renderBytes(researchActionFinish, {}, baselineAction) + renderBytes(researchEvidenceAdd, {}, baselineEvidence), fusedOutputBytes: renderBytes(researchActionFinish, {}, fused) },
    receipt: { renderedBytes: receipt ? renderBytes(researchVerifiedReceipt, {}, receipt) : 0, status: receipt?.status ?? 'unavailable', scientificStatus: receipt?.scientificStatus ?? 'unavailable' },
    context: { beforeTokens: estimateContextTokens(before), afterTokens: estimateContextTokens(after), labelsPreserved: after.includes('treeSummary') && after.includes('evidence'), labeledBytesBefore: Buffer.byteLength(before), labeledBytesAfter: Buffer.byteLength(after) },
  }, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
