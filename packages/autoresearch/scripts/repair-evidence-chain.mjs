// Repair script: regenerate evidence_chain.json from the on-disk research tree
// using the package's own export code, then report node counts.
import { ResearchTree } from '../dist/core/research-tree.js'
import { exportEvidenceChain } from '../dist/export/evidence-chain.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const runDir = resolve(process.argv[2])
const state = JSON.parse(await readFile(resolve(runDir, 'state.json'), 'utf8'))
const tree = await ResearchTree.load(runDir)
const path = await exportEvidenceChain(runDir, state.runId, tree)
const chain = JSON.parse(await readFile(resolve(runDir, 'evidence_chain.json'), 'utf8'))
console.log(JSON.stringify({
  exportedTo: path,
  hypotheses: chain.hypotheses.length,
  actions: chain.actions.length,
  evidence: chain.evidence.length,
}, null, 2))
