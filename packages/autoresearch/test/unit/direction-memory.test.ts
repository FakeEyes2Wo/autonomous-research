import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDirectionMemoryStore, renderDirectionMemory, selectionHintsForMechanisms, type DirectionMemoryInput } from '../../dist/memory/index.js'
import { hashContent } from '../../dist/research/records.js'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runIdeaGeneration } from '../../dist/service/steps/idea.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'

const mechanism = 'a'.repeat(64)
const input: DirectionMemoryInput = {
  idea: 'Use bounded memory routing for classification',
  eliminationReason: 'Confirmed invalid under current constraints',
  avoid: 'Do not retry this exact direction',
  reasonCode: 'confirmed_error',
  mechanismKey: mechanism,
  changedAssumption: 'The task has a fixed evaluation contract',
}

test('project direction memory is idempotent, shared across runs, and isolated by project', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-project-'))
  const other = await mkdtemp(join(tmpdir(), 'ar-direction-memory-other-'))
  const first = new ProjectDirectionMemoryStore(project)
  const writes = await Promise.all(Array.from({ length: 4 }, () => first.upsert(input)))
  assert.ok(writes.every((record) => record.id === writes[0]!.id))
  assert.equal((await first.read()).length, 1)
  // Both run callers resolve the same project root before opening the store.
  assert.equal((await new ProjectDirectionMemoryStore(project).match({ mechanismKey: mechanism })).length, 1)
  assert.equal((await new ProjectDirectionMemoryStore(other).read()).length, 0)
})

test('direction memory rejects malformed persisted content and unsafe input fields', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-invalid-'))
  const store = new ProjectDirectionMemoryStore(project)
  await assert.rejects(() => store.upsert({ ...input, eliminationReason: 'path/to/full-report.md' }), /compact|forbidden|unsafe/i)
  await assert.rejects(() => store.upsert({ ...input, eliminationReason: 'Rejected after n=20 trials' }), /compact|forbidden|quantitative/i)
  await store.upsert(input)
  await writeFile(store.path, JSON.stringify({ schema: 'autoresearch/direction-memory/v1', projectId: 'wrong', records: [{ ...input, id: 'bad', version: 1, createdAt: new Date().toISOString(), source_refs: ['forbidden'] }] }))
  await assert.rejects(() => store.read(), /schema|unknown|source_refs|project/i)
})

test('ordinary scientific accuracy, score, metric, and sample terms remain valid', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-science-'))
  const store = new ProjectDirectionMemoryStore(project)
  await assert.doesNotReject(() => store.upsert({
    idea: 'Improve accuracy with a score calibrated by a metric and sample protocol',
    eliminationReason: 'Confirmed invalid under the current evaluation contract',
    avoid: 'Do not retry this direction without a changed assumption',
    reasonCode: 'confirmed_error',
  }))
})

test('ordinary held-out, artifact, and source-ref wording remains valid', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-terms-'))
  const store = new ProjectDirectionMemoryStore(project)
  await assert.doesNotReject(() => store.upsert({
    idea: 'Evaluate robustness on held-out tasks with artifact reduction',
    eliminationReason: 'The source-ref comparison did not support this direction',
    avoid: 'Do not retry this direction without a changed assumption',
    reasonCode: 'confirmed_error',
  }))
})

test('memory updates append a compact version and preserve old cleanup receipts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-history-'))
  const store = new ProjectDirectionMemoryStore(project)
  const first = await store.upsert(input)
  const second = await store.upsert({ ...input, eliminationReason: 'A later review confirmed the same direction remains invalid' })
  assert.equal(second.id, first.id)
  assert.equal(second.version, first.version + 1)
  const history = await store.read()
  assert.equal(history.length, 2)
  assert.equal(hashContent(history.find((record) => record.version === first.version)), hashContent(first))
  assert.equal((await store.match({ idea: input.idea })).length, 1)
  assert.equal((await store.match({ idea: input.idea }))[0]?.version, second.version)
  assert.equal(renderDirectionMemory(history).match(/Previously eliminated directions/g)?.length, 1)
})

test('direction memory rejects symlinked project storage before creating a lock', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-symlink-'))
  const outside = await mkdtemp(join(tmpdir(), 'ar-direction-memory-outside-'))
  try {
    await symlink(outside, join(project, '.autoresearch'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => new ProjectDirectionMemoryStore(project).upsert(input), /symlink|escape|storage/i)
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('matching uses exact mechanism or idea identity and rendering omits experimental detail', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-match-'))
  const store = new ProjectDirectionMemoryStore(project)
  const record = await store.upsert(input)
  assert.equal((await store.match({ mechanismKey: mechanism })).at(0)?.id, record.id)
  assert.equal((await store.match({ idea: input.idea })).at(0)?.id, record.id)
  assert.equal((await store.match({ mechanismKey: 'b'.repeat(64) })).length, 0)
  const rendered = renderDirectionMemory([record])
  assert.match(rendered, /previously eliminated/i)
  assert.match(rendered, /Do not retry this exact direction/)
  assert.doesNotMatch(rendered, /source|path|artifact|metric|score|sample|held.?out|repair|script|report/i)
})

test('selection hints expose only mechanism keys and compact memory IDs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-hints-'))
  const store = new ProjectDirectionMemoryStore(project)
  const record = await store.upsert(input)
  assert.deepEqual(await selectionHintsForMechanisms(project, [mechanism, 'b'.repeat(64)]), {
    avoidedMechanismKeys: [mechanism],
    directionMemoryIds: [record.id],
    directionMemoryMatches: { [mechanism]: [record.id] },
  })
  assert.deepEqual((await selectionHintsForMechanisms(project)).avoidedMechanismKeys, [mechanism])
})

test('independent processes serialize concurrent project upserts without losing records', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-processes-'))
  const script = `import { ProjectDirectionMemoryStore } from './dist/memory/index.js'; const project = process.argv[1]; const index = Number(process.argv[2]); await new ProjectDirectionMemoryStore(project).upsert({ idea: 'Independent direction ' + index, eliminationReason: 'Confirmed invalid under current constraints', avoid: 'Do not retry this exact direction', reasonCode: 'confirmed_error', mechanismKey: ('0'.repeat(63) + index.toString(16)).slice(-64) });`
  await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, String(index)], { cwd: process.cwd(), stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`direction memory child exited ${code}`)))
  })))
  assert.equal((await new ProjectDirectionMemoryStore(project).read()).length, 4)
})

test('idea generation receives compact project memory and rejects an exact remembered idea', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-idea-project-'))
  const runDir = join(project, 'run-1')
  t.after(() => rm(project, { recursive: true, force: true }))
  const memory = new ProjectDirectionMemoryStore(project)
  const rememberedIdea = 'Use bounded memory routing for classification'
  await memory.upsert({ ...input, idea: rememberedIdea })
  const prompts: string[] = []
  const draft = { statement: rememberedIdea, intervention: 'Change one parameter', expected_effect: 'Generalization improves', supported_premises: [], predicted_observations: ['The result changes'], disconfirming_observations: ['The result does not change'], sources: [] }
  const provider = new SubagentRoleAgentProvider({ start: async (_name, options) => {
    prompts.push(options.prompt?.[0]?.text ?? '')
    const structured = options.label === 'idea-generator' ? { hypotheses: [draft] } : { is_falsifiable: true, testable_implication: 'Compare outcomes', unobservable_variables: [], critique: 'Reviewed', unaddressed_risks: [], fatal_flaw_found: false }
    return { id: `direction-memory-${prompts.length}`, result: Promise.resolve({ output: [{ type: 'text', text: JSON.stringify(structured) }], stopReason: 'completed' }), dispose: async () => {} }
  } })
  const state = await createInitialState(runDir)
  const ctx = createRunContext({ provider }, runDir, state, await ResearchTree.load(runDir), { parent: { id: 'p' }, signal: new AbortController().signal, projectDir: project })
  ctx.policySnapshot.workflow.reflexionRounds = 0
  await runIdeaGeneration(ctx, { idea: 'new research direction', profile: '' })
  assert.match(prompts[0] ?? '', /Previously eliminated directions/i)
  assert.equal(ctx.tree.query({ kind: 'hypothesis' }).find((node) => node.content === rememberedIdea)?.status, 'rejected')
  assert.equal((await memory.read()).length, 1)
})

test('idea generation rechecks a remembered direction after reflexion rewrites the draft', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'ar-direction-memory-reflexion-project-'))
  const runDir = join(project, 'run-1')
  t.after(() => rm(project, { recursive: true, force: true }))
  const remembered = 'Revised direction already eliminated by the project'
  await new ProjectDirectionMemoryStore(project).upsert({ ...input, idea: remembered })
  const draft = { statement: 'A fresh direction', intervention: 'Change one parameter', expected_effect: 'Generalization improves', supported_premises: [], predicted_observations: ['The result changes'], disconfirming_observations: ['The result does not change'], sources: [] }
  const provider = new SubagentRoleAgentProvider({ start: async (_name, options) => {
    const structured = options.label === 'idea-generator' ? { hypotheses: [draft] } : { is_falsifiable: true, testable_implication: 'Compare outcomes', unobservable_variables: [], critique: 'Reviewed', unaddressed_risks: [], fatal_flaw_found: false, revised: { ...draft, statement: remembered } }
    return { id: `direction-memory-reflexion-${options.label}`, result: Promise.resolve({ output: [{ type: 'text', text: JSON.stringify(structured) }], stopReason: 'completed' }), dispose: async () => {} }
  } })
  const state = await createInitialState(runDir)
  const ctx = createRunContext({ provider }, runDir, state, await ResearchTree.load(runDir), { parent: { id: 'p' }, signal: new AbortController().signal, projectDir: project })
  ctx.policySnapshot.workflow.reflexionRounds = 0
  await runIdeaGeneration(ctx, { idea: 'new research direction', profile: '' })
  const node = ctx.tree.query({ kind: 'hypothesis' }).find((item) => item.content === remembered)
  assert.equal(node?.status, 'rejected')
  assert.equal(ctx.tree.query({ kind: 'hypothesis', status: 'eligible' }).length, 0)
})
