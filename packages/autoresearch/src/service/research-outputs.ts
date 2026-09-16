import { join } from 'node:path'
import { ResearchStore } from '../research/index.js'
import { ResearchTree } from '../core/research-tree.js'
import { HypothesisPool } from '../core/hypothesis-pool.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { readOptionalText, writeText } from '../core/utils.js'
import type { ClaimStatus, ResearchSnapshot } from '../research/contracts.js'

export async function synchronizeResearchViews(runDir: string, snapshot: ResearchSnapshot): Promise<ResearchTree> {
  const store = new ResearchStore(runDir)
  const history = [snapshot]
  while (history[0]!.parent_snapshot_id) history.unshift(await store.loadSnapshot(history[0]!.parent_snapshot_id!))
  const protocols = new Map(history.map(item => [item.protocol.content_hash, item.protocol]))
  const judgments = new Map<string, ClaimStatus>()
  for (const item of history) {
    if (!item.assessment) continue
    const protocol = protocols.get(item.assessment.protocol_hash)
    if (!protocol) throw new Error(`Missing historical assessment protocol: ${item.assessment.protocol_hash}`)
    judgments.set(`research:${protocol.hypothesis.id}@${protocol.hypothesis.version}`, item.assessment.claim_status)
  }
  const tree = await ResearchTree.load(runDir)
  for (const hypothesis of snapshot.hypotheses) {
    const id = `research:${hypothesis.id}@${hypothesis.version}`
    const status = judgments.get(id) ?? hypothesis.status
    if (!tree.query({ id }).length) tree.add('hypothesis', hypothesis.statement, { id, status })
    else tree.update(id, { status, content: hypothesis.statement })
  }
  for (const evidence of snapshot.evidence) {
    const id = `research:${evidence.id}@${evidence.version}`
    const protocol = protocols.get(evidence.protocol_hash)
    if (!protocol) throw new Error(`Missing historical evidence protocol: ${evidence.protocol_hash}`)
    const attributes = { status: evidence.validity === 'valid' ? evidence.polarity : evidence.validity,
      parent: `research:${protocol.hypothesis.id}@${protocol.hypothesis.version}`, artifacts: evidence.artifacts.flatMap(a => a.path ? [a.path] : []) }
    if (!tree.query({ id }).length) tree.add('evidence', evidence.observation, { id, ...attributes })
    else tree.update(id, { content: evidence.observation, ...attributes })
  }
  await tree.save()
  const pool = await HypothesisPool.load(runDir)
  pool.syncFromSnapshot(snapshot)
  await pool.save()
  return tree
}

export async function bindResearchOutputs(runDir: string, runId: string): Promise<void> {
  const snapshot = await new ResearchStore(runDir).loadCurrent()
  if (!snapshot) return
  const tree = await synchronizeResearchViews(runDir, snapshot)
  await exportEvidenceChain(runDir, runId, tree)
  let report = await readOptionalText(join(runDir, 'RESEARCH_REPORT.md'))
  if (!report) return
  if (!report.includes(`snapshot_id: ${snapshot.id}\n`) || !report.includes(`snapshot_hash: ${snapshot.content_hash}\n`)) {
    report = `# Research report\n\nsnapshot_id: ${snapshot.id}\nsnapshot_hash: ${snapshot.content_hash}\nprotocol_hash: ${snapshot.protocol.content_hash}\n\nPrior rendered report belongs to another snapshot and is excluded. Reassessment is required before a scientific decision.\n`
    await writeText(join(runDir, 'RESEARCH_REPORT.md'), report)
  }
  await writeText(join(runDir, 'HANDOFF.md'), `# Research handoff\n\n${report}`)
  const marker = '\n<!-- committed research snapshot -->\n'
  for (const name of ['EXPERIMENT_REPORT.md', 'FINAL_REPORT.md']) {
    const existing = await readOptionalText(join(runDir, name))
    if (existing) await writeText(join(runDir, name), `${existing.split(marker)[0]}${marker}${report}`)
  }
}
