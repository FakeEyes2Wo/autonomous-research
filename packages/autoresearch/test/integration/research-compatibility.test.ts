import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { HypothesisPool } from '../../dist/core/hypothesis-pool.js'
import { readJson } from '../../dist/core/utils.js'
import { paperKey, isSurveyPaper } from '../../dist/brainstorm/paper-record.js'
import { ResearchStore } from '../../dist/research/index.js'
import { exportEvidenceChain, loadEvidenceChain } from '../../dist/export/evidence-chain.js'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

const fixture = fileURLToPath(new URL('../fixtures/research-compatibility/main-run-early-exit/', import.meta.url))
const context = () => ({ parent: { id: 'compatibility', session: { id: 'compatibility' } }, signal: new AbortController().signal })
async function copyFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-main-compatibility-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(fixture, dir, { recursive: true })
  return dir
}
async function assertOriginalBytes(dir: string) {
  const manifest = JSON.parse(await readFile(join(fixture, 'fixture-manifest.json'), 'utf8'))
  for (const file of manifest.files) {
    const bytes = await readFile(join(dir, file.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
    assert.deepEqual(bytes, await readFile(join(fixture, file.path)), file.path)
  }
}

test('historical main state, tree, paper records and evidence remain readable without inventing a canonical judgment', async (t) => {
  const dir = await copyFixture(t)
  const state = await loadState(dir)
  assert.equal(state!.runId, 'ar_c99ee26e')
  assert.equal(state!.status, 'FAILED')
  assert.equal(state!.cycle, 1)
  const tree = await ResearchTree.load(dir)
  assert.equal(tree.nodes.length, 9)
  assert.equal(tree.get('evi_40a5df08').status, 'supports')
  const papers = await readJson<any[]>(join(dir, 'brainstorm/paper_records.json'))
  assert.equal(papers.length, 94)
  assert.equal(papers[0].title, 'BERT Loses Patience: Fast and Robust Inference with Early Exit (PABEE)')
  assert.equal(isSurveyPaper(papers[0]), true)
  assert.ok(paperKey(papers[0]).length > 0)
  const pool = await HypothesisPool.load(dir)
  pool.syncFromTree(tree, state!.runId)
  assert.ok(pool.entries.every(entry => entry.provenance === 'unknown'))
  assert.equal(await new ResearchStore(dir).loadCurrent(), undefined)
  const { chain } = await exportEvidenceChain({ runDir: dir, runId: state!.runId, tree })
  assert.equal(chain.snapshot_id, undefined)
  assert.equal(chain.scientific_evidence, undefined)
  assert.deepEqual((await loadEvidenceChain(dir)).evidence, tree.query({ kind: 'evidence' }))
  const store = new ResearchStore(dir)
  const ref = await store.captureSource('experiments/early_exit_fairness/artifacts/EVIDENCE.md')
  assert.deepEqual(await readFile(join(dir, ref.path!)), await readFile(join(fixture, 'experiments/early_exit_fairness/artifacts/EVIDENCE.md')))
  assert.equal(await store.loadCurrent(), undefined)
  await assertOriginalBytes(dir)
})

for (const entry of ['research', 'experiment']) test(`${entry} preserves a terminal historical main run without dispatch or fabricated validation`, async (t) => {
  const dir = await copyFixture(t)
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const result = entry === 'research'
    ? await new AutoResearchService(provider).run({ runDir: dir }, context())
    : await runExperimentTask({ provider }, { runDir: dir, task: 'Historical compatibility read.', agentContext: context() })
  assert.equal(result.status.toLowerCase(), 'failed')
  assert.deepEqual(provider.calls, [])
  assert.equal(await new ResearchStore(dir).loadCurrent(), undefined)
  await assertOriginalBytes(dir)
})
