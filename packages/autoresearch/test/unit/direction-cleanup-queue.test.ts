import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDirectionMemoryStore } from '../../dist/memory/direction-memory.js'
import { enqueueRetirement, loadCleanupTask, persistRetirementMemory } from '../../dist/cleanup/queue.js'
import { directionId } from '../../dist/cleanup/direction-id.js'

const direction = { projectId: '', branchId: 'branch', claim: { id: 'claim', version: 1 }, hypothesis: { id: 'hypothesis', version: 1 }, protocolHash: 'protocol' }

test('retirement queue persists before memory and makes memory replay idempotent', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-queue-'))
  const run = await mkdtemp(join(tmpdir(), 'ar-cleanup-run-'))
  try {
    direction.projectId = project
    const pending = await enqueueRetirement({ projectDir: project, runDir: run, direction, disposition: 'refuted', idea: 'A compact idea', reason: 'formal opposing evidence', avoidRepeat: 'Do not retry this mechanism', mechanismKey: 'a'.repeat(64) })
    assert.equal(pending.state, 'pending')
    const saved = await persistRetirementMemory(project, pending)
    assert.equal(saved.state, 'memory_saved')
    assert.ok(saved.memory)
    assert.equal((await new ProjectDirectionMemoryStore(project).read()).length, 1)
    const replay = await persistRetirementMemory(project, saved)
    assert.equal(replay.contentHash, saved.contentHash)
    assert.equal((await new ProjectDirectionMemoryStore(project).read()).length, 1)
    assert.equal((await loadCleanupTask(project, pending.id))?.state, 'memory_saved')
    assert.match(await readFile(join(project, '.autoresearch', 'cleanup', 'tasks', `${pending.id}.json`), 'utf8'), /memory_saved/)
  } finally { await rm(project, { recursive: true, force: true }); await rm(run, { recursive: true, force: true }) }
})

test('queue recovers a lock owned by a dead process', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-lock-project-'))
  const run = await mkdtemp(join(tmpdir(), 'ar-cleanup-lock-run-'))
  try {
    const direction = { projectId: project, branchId: 'branch-lock', claim: { id: 'claim', version: 1 }, hypothesis: { id: 'hypothesis', version: 1 }, protocolHash: 'protocol' }
    const id = `cleanup-${directionId(direction)}`
    const tasks = join(project, '.autoresearch', 'cleanup', 'tasks')
    await mkdir(tasks, { recursive: true })
    await writeFile(join(tasks, `${id}.json.lock`), '999999 dead-owner\n')
    const task = await enqueueRetirement({ projectDir: project, runDir: run, direction, disposition: 'abandoned', idea: 'A compact idea', reason: 'User abandoned the direction', avoidRepeat: 'Do not retry it' })
    assert.equal(task.state, 'pending')
  } finally { await rm(project, { recursive: true, force: true }); await rm(run, { recursive: true, force: true }) }
})
