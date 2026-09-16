import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResearchRunner } from '../../dist/service/runner.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createInitialState } from '../../dist/core/state.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'

for (const mode of ['minimal', 'legacy'] as const) test(`${mode} paper resume reaches evidence gate without repeating paid prelude`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-resume-'))
  try {
    await mkdir(join(root, 'input'))
    await writeFile(join(root, 'input', 'idea.md'), '# Candidate\n\n## Direction\n\nResume paper only.\n')
    const state = await createInitialState(root)
    state.phase = 'paper'
    const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
    settings.workflow.mode = mode
    settings.workflow.brainstorm = 'enabled'
    settings.workflow.deepDive = 'enabled'
    const calls: string[] = []
    const provider = { run: async (role: string) => { calls.push(role); throw new Error('unexpected paid prelude') } }
    const runner = new ResearchRunner({ provider: provider as never, brainstorm: 'on', policySnapshot: settings })
    await assert.rejects(runner.run(root, state, await ResearchTree.load(root), {
      parent: { id: 'parent', session: { id: 'parent' } } as never, signal: new AbortController().signal,
    }), /no evidence recorded before paper generation/)
    assert.deepEqual(calls, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
