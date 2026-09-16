import { join } from 'node:path'
import { open, readFile, unlink } from 'node:fs/promises'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { atomicWriteJson, readOptionalText, writeText } from '../core/utils.js'
import { hashBytes } from '../research/records.js'
import { ResearchStore } from '../research/store.js'
import { artifactHash, captureProjectInventory, validateProjectInventory } from './inventory.js'
import type { ProjectDiscovery, ProjectDiscoveryCheckpoint, ProjectInventory } from './contracts.js'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown, required = true): value is string[] => Array.isArray(value) && (!required || value.length > 0) && value.every(nonempty)

export function validateDiscovery(value: unknown, inventory: ProjectInventory): ProjectDiscovery {
  const raw = record(value), allowed = new Set(inventory.files.map(f => f.source.id))
  const refs = (value: unknown) => {
    if (!strings(value) || value.some(id => !allowed.has(id))) throw new Error('project discovery contains unknown source reference')
  }
  if (!Array.isArray(raw.contributions) || raw.contributions.length < 1 || raw.contributions.length > 5 || !nonempty(raw.selectedId) || !nonempty(raw.selectionReason) || !Array.isArray(raw.historicalResults)) throw new Error('invalid project discovery structure')
  const ids = new Set<string>()
  for (const item of raw.contributions) {
    const c = record(item)
    if (!nonempty(c.id) || ids.has(c.id) || !nonempty(c.claim) || !nonempty(c.researchQuestion) || !['observed-implementation', 'proposed'].includes(String(c.status)) || !strings(c.limitations) || !strings(c.validation)) throw new Error('invalid project contribution: limitations and falsifiable validation are required')
    ids.add(c.id); refs(c.sourceIds)
  }
  if (!ids.has(raw.selectedId)) throw new Error('selected project contribution is missing')
  for (const item of raw.historicalResults) {
    const h = record(item)
    if (!nonempty(h.statement) || h.status !== 'unverified') throw new Error('historical project results must remain unverified')
    refs(h.sourceIds)
  }
  return raw as unknown as ProjectDiscovery
}

function candidateText(discovery: ProjectDiscovery, inventory: ProjectInventory): string {
  const chosen = discovery.contributions.find(c => c.id === discovery.selectedId)!
  return ['# Existing project research candidate', '', `Research question: ${chosen.researchQuestion}`, '',
    'User intent: write a paper after bounded supplementary validation through the normal research and paper evidence gates.',
    `Proposed contribution (not scientific support): ${chosen.claim}`, `Selection reason: ${discovery.selectionReason}`,
    '', '## Required validation', ...chosen.validation.map(v => `- ${v}`), '', '## Limitations', ...chosen.limitations.map(v => `- ${v}`),
    'Project implementation and historical results are unverified scientific premises. Fresh controlled evidence is required; do not import historical metrics as supported evidence.',
    '', '## Immutable source provenance', ...inventory.files.filter(f => chosen.sourceIds.includes(f.source.id)).map(f => `- ${f.source.id}: ${f.relativePath}:1-${f.lines}; sha256=${f.source.hash}; captured=${f.source.path}`),
    '', '## Unverified historical results', ...discovery.historicalResults.map(h => `- unverified: ${h.statement} [${h.sourceIds.join(', ')}]`),
    '', '## Inventory coverage omissions', ...inventory.omissions.map(o => `- ${o.path}: ${o.reason}`), '',
  ].join('\n')
}

export async function validateCompletedDiscovery(runDir: string, projectDir: string): Promise<ProjectDiscoveryCheckpoint> {
  const inventory = JSON.parse(await readFile(join(runDir, 'input', 'project-inventory.json'), 'utf8')) as ProjectInventory
  await validateProjectInventory(inventory, projectDir, runDir)
  const checkpoint = JSON.parse(await readFile(join(runDir, 'input', 'project-discovery.json'), 'utf8')) as ProjectDiscoveryCheckpoint
  const { hash, ...record } = checkpoint
  if (checkpoint.version !== 1 || checkpoint.inventoryHash !== inventory.hash || artifactHash(record) !== hash) throw new Error('project discovery checkpoint hash mismatch')
  validateDiscovery(checkpoint.discovery, inventory)
  for (const name of ['idea.md', 'candidate.md']) if (hashBytes(await readFile(join(runDir, 'input', name))) !== checkpoint.candidateHash) throw new Error('project candidate hash mismatch')
  return checkpoint
}

export async function discoverProject(provider: RoleAgentProvider, runDir: string, projectDir: string, context: RoleExecutionContext): Promise<ProjectDiscoveryCheckpoint> {
  const inventoryPath = join(runDir, 'input', 'project-inventory.json')
  const checkpointPath = join(runDir, 'input', 'project-discovery.json')
  const responsePath = join(runDir, 'input', 'project-discovery-response.json')
  const pendingPath = join(runDir, 'input', 'project-discovery-pending.json')
  const saved = await readOptionalText(inventoryPath)
  const inventory: ProjectInventory = saved ? JSON.parse(saved) : await captureProjectInventory(projectDir, runDir)
  if (!saved) await atomicWriteJson(inventoryPath, inventory)
  await validateProjectInventory(inventory, projectDir, runDir)
  if (inventory.files.length === 0) throw new Error('no eligible project sources in bounded inventory')
  const prior = await readOptionalText(checkpointPath)
  if (prior) return validateCompletedDiscovery(runDir, projectDir)
  let discovery: ProjectDiscovery
  const response = await readOptionalText(responsePath)
  if (response) {
    const receipt = JSON.parse(response)
    if (receipt.inventoryHash !== inventory.hash || receipt.hash !== artifactHash({ inventoryHash: receipt.inventoryHash, discovery: receipt.discovery })) throw new Error('project discovery response hash mismatch')
    discovery = validateDiscovery(receipt.discovery, inventory)
  } else {
    if (await readOptionalText(pendingPath)) throw new Error('project discovery dispatch outcome unknown; explicit recovery required before another model call')
    const files = await Promise.all(inventory.files.map(async f => ({ ...f, text: await readFile(join(runDir, f.source.path!), 'utf8') })))
    if (context.signal.aborted) throw new Error('project discovery cancelled before dispatch')
    let pending
    try { pending = await open(pendingPath, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('project discovery dispatch outcome unknown; explicit recovery required before another model call')
      throw error
    }
    try { await pending.writeFile(JSON.stringify({ inventoryHash: inventory.hash, taskId: 'project-discovery-v1' })) }
    finally { await pending.close() }
    const output = await provider.run('project-explorer', { runDir, projectDir, taskId: 'project-discovery-v1', projectInventory: JSON.stringify({ ...inventory, files }) }, context)
    try {
      if (output.stopReason !== 'completed') throw new Error('project discovery did not complete')
      discovery = validateDiscovery(output.structured ?? JSON.parse(output.text), inventory)
    } catch (error) { await unlink(pendingPath); throw error }
    const receipt = { inventoryHash: inventory.hash, discovery }
    await atomicWriteJson(responsePath, { ...receipt, hash: artifactHash(receipt) })
    await unlink(pendingPath)
  }
  // Recheck source identity after the model await before making its candidate durable.
  await validateProjectInventory(inventory, projectDir, runDir)
  const candidate = candidateText(discovery, inventory)
  await writeText(join(runDir, 'input', 'idea.md'), candidate)
  await writeText(join(runDir, 'input', 'candidate.md'), candidate)
  await writeText(join(runDir, 'input', 'PROJECT_DISCOVERY.md'), `${candidate}\n## All proposed contributions\n\n${JSON.stringify(discovery, null, 2)}\n`)
  const recordValue = { version: 1 as const, inventoryHash: inventory.hash, discovery, candidateHash: hashBytes(candidate) }
  const checkpoint = { ...recordValue, hash: artifactHash(recordValue) }
  await new ResearchStore(runDir).captureBytes(JSON.stringify(checkpoint), 'project-discovery-v1')
  await atomicWriteJson(checkpointPath, checkpoint)
  return checkpoint
}
