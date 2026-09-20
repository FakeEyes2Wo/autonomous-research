import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindToolWorkspacePaths, projectSettingsGet, researchHypothesisAdd, researchActionStart, researchActionFinish, researchEvidenceAdd, researchTreeQuery, researchObservationRead, researchVerifiedReceipt } from '../../dist/tools/index.js'

const exec = { signal: new AbortController().signal }

test('research tools maintain parent/artifact rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tools-'))
  try {
    const hyp = await researchHypothesisAdd.execute({ runDir: dir, content: 'hyp' }, exec) as { id: string }
    const action = await researchActionStart.execute({ runDir: dir, hypothesisId: hyp.id, content: 'act' }, exec) as { id: string }
    await researchActionFinish.execute({ runDir: dir, actionId: action.id, status: 'completed', summary: 'done', artifacts: ['out.txt'] }, exec)
    await researchEvidenceAdd.execute({ runDir: dir, actionId: action.id, content: 'evidence', verdict: 'supports' }, exec)

    const nodes = await researchTreeQuery.execute({ runDir: dir }, exec) as Array<{ kind: string; status: string }>
    assert.equal(nodes.filter((n) => n.kind === 'hypothesis').length, 1)
    assert.equal(nodes.filter((n) => n.kind === 'action').length, 1)
    assert.equal(nodes.filter((n) => n.kind === 'evidence').length, 1)
    const actionNode = nodes.find((n) => n.kind === 'action')
    assert.equal(actionNode?.status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('research_action_finish fuses evidence into one tree save and preserves legacy output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tools-fusion-'))
  try {
    const hyp = await researchHypothesisAdd.execute({ runDir: dir, content: 'hyp' }, exec) as { id: string }
    const action = await researchActionStart.execute({ runDir: dir, hypothesisId: hyp.id, content: 'act' }, exec) as { id: string }
    const fused = await researchActionFinish.execute({ runDir: dir, actionId: action.id, status: 'completed', summary: 'done', evidence: [{ content: 'observed', verdict: 'supports' }] }, exec) as { action: { id: string }; evidence: Array<{ content: string }> }
    assert.equal(fused.action.id, action.id)
    assert.equal(fused.evidence[0]?.content, 'observed')
    const before = await researchTreeQuery.execute({ runDir: dir }, exec) as Array<{ kind: string }>
    await assert.rejects(researchActionFinish.execute({ runDir: dir, actionId: action.id, status: 'completed', summary: 'should fail', evidence: [{ content: '', verdict: 'supports' }] }, exec), /evidence content/)
    const after = await researchTreeQuery.execute({ runDir: dir }, exec) as Array<{ kind: string }>
    assert.deepEqual(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('research_tree_query opt-in packing and observation tools provide exact retrieval and receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tools-pack-'))
  try {
    const hyp = await researchHypothesisAdd.execute({ runDir: dir, content: 'large hypothesis ' + 'x'.repeat(4000) }, exec) as { id: string }
    const result = await researchTreeQuery.execute({ runDir: dir, packObservation: true, observationThresholdBytes: 1, observationExcerptBytes: 11, observationTaskId: 'task-1', observationDirection: 'direction-a' }, exec) as { observation: { handle: string; owner: { taskId?: string } } }
    assert.equal(result.observation.owner.taskId, 'task-1')
    const page = await researchObservationRead.execute({ runDir: dir, handle: result.observation.handle, limitBytes: 13 }, exec) as { text: string; nextOffset: number }
    assert.ok(page.text.length > 0)
    const receipt = await researchVerifiedReceipt.execute({ runDir: dir, handle: result.observation.handle, source: 'tree-query', quotes: [page.text] }, exec) as { scientificStatus: string; status: string }
    assert.equal(receipt.status, 'verified')
    assert.equal(receipt.scientificStatus, 'unverified')
    await assert.rejects(researchObservationRead.execute({ runDir: dir, handle: '../research_tree.json' }, exec), /invalid observation handle/)
    assert.ok(hyp.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('relative research paths resolve independently against each calling session cwd', async () => {
  const first = await mkdtemp(join(tmpdir(), 'ar-tools-cwd-a-'))
  const second = await mkdtemp(join(tmpdir(), 'ar-tools-cwd-b-'))
  try {
    const observed: Array<Record<string, unknown>> = []
    const tool = bindToolWorkspacePaths({
      name: 'capture_paths',
      description: 'test fixture',
      parameters: {},
      output: { schema: {}, render: () => [] },
      async execute(args) { observed.push(args); return args },
    }, (agentId) => agentId === 'session-a' ? first : agentId === 'session-b' ? second : undefined)

    await tool.execute({ runDir: join('.runs', 'same'), projectDir: '.' }, { ...exec, agent: { id: 'session-a' } })
    await tool.execute({ runDir: join('.runs', 'same'), projectDir: '.' }, { ...exec, agent: { id: 'session-b' } })

    assert.equal(observed[0]?.runDir, join(first, '.runs', 'same'))
    assert.equal(observed[0]?.projectDir, first)
    assert.equal(observed[1]?.runDir, join(second, '.runs', 'same'))
    assert.equal(observed[1]?.projectDir, second)
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('workspace path binding preserves absolute and context-free paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ar-tools-cwd-'))
  try {
    const absolute = join(cwd, '.runs', 'absolute')
    const tool = bindToolWorkspacePaths({
      name: 'capture_paths',
      description: 'test fixture',
      parameters: {},
      output: { schema: {}, render: () => [] },
      async execute(args) { return args },
    }, () => cwd)

    const anchored = await tool.execute({ runDir: absolute }, { ...exec, agent: { id: 'session-a' } }) as Record<string, unknown>
    const contextFree = await tool.execute({ runDir: join('.runs', 'cli') }, exec) as Record<string, unknown>
    assert.equal(anchored.runDir, absolute)
    assert.equal(contextFree.runDir, join('.runs', 'cli'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('workspace path binding rejects a relative path when the calling session cwd is unavailable', async () => {
  const tool = bindToolWorkspacePaths({
    name: 'capture_paths',
    description: 'test fixture',
    parameters: {},
    output: { schema: {}, render: () => [] },
    async execute(args) { return args },
  }, () => undefined)

  await assert.rejects(
    tool.execute({ runDir: join('.runs', 'unsafe') }, { ...exec, agent: { id: 'missing-session' } }),
    /working directory is unavailable/,
  )
})

test('project settings tools consume their declared projectDir argument', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'ar-tools-project-'))
  try {
    const settings = await projectSettingsGet.execute({ projectDir }, exec) as Record<string, unknown>
    assert.equal(typeof settings, 'object')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('workspace path binding leaves empty paths for the tool validator to reject', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ar-tools-empty-'))
  try {
    const boundResearch = bindToolWorkspacePaths(researchHypothesisAdd, () => cwd)
    const boundSettings = bindToolWorkspacePaths(projectSettingsGet, () => cwd)
    await assert.rejects(
      boundResearch.execute({ runDir: '', content: 'must not write into cwd' }, { ...exec, agent: { id: 'session-a' } }),
      /runDir is required/,
    )
    await assert.rejects(
      boundSettings.execute({ projectDir: '' }, { ...exec, agent: { id: 'session-a' } }),
      /projectDir is required/,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
