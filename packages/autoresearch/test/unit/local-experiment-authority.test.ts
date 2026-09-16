import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalExperimentRuntime } from '../../dist/runtime/local-authority.js'

test('trusted host execution grant binds canonical project, executable, environment and finite resource caps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-authority-'))
  const project = join(root, 'project'), other = join(root, 'other')
  await mkdir(project); await mkdir(other)
  try {
    const config = { projectRoots: [project], executables: [process.execPath], maxWallMs: 1000, maxRunWallMs: 3000, maxLogBytes: 100, maxArtifactBytes: 200, envNames: ['EXPERIMENT_SEED'] }
    const runtime = await createLocalExperimentRuntime(config, project)
    const spec = { id: 'j', attemptId: 'a', taskId: 't', protocolHash: 'p', inputHash: 'i', executable: process.execPath, args: ['test.mjs'], cwd: project, env: { EXPERIMENT_SEED: '1' }, checkpoint: null,
      budget: { wallMs: 1000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 100, maxArtifactBytes: 200 } }
    await runtime.authorize(spec, {} as never)
    assert.deepEqual(runtime.limits, { maxConcurrentJobs: 1, maxReservedWallMs: 3000 })
    await assert.rejects(createLocalExperimentRuntime(config, other), /PROJECT_NOT_AUTHORIZED/)
    await assert.rejects(runtime.authorize({ ...spec, cwd: other }, {} as never), /CWD_NOT_AUTHORIZED/)
    await symlink(other, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(runtime.authorize({ ...spec, cwd: join(project, 'escape') }, {} as never), /CWD_NOT_AUTHORIZED/)
    await assert.rejects(runtime.authorize({ ...spec, env: { NODE_OPTIONS: '--import=outside' } }, {} as never), /ENV_NOT_AUTHORIZED/)
    await assert.rejects(runtime.authorize({ ...spec, budget: { ...spec.budget, wallMs: 1001 } }, {} as never), /BUDGET_NOT_AUTHORIZED/)
    await assert.rejects(runtime.authorize({ ...spec, executable: 'powershell.exe' }, {} as never), /EXECUTABLE_NOT_AUTHORIZED/)
    await assert.rejects(createLocalExperimentRuntime({ ...config, maxRunWallMs: Infinity }, project), /INVALID_LOCAL_EXECUTION_CONFIG/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
