import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

test('installer adds the core plugin beside autoresearch-web and stays idempotent', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {} }))
  const patchPath = join(profile, 'cordis.patch.yml')
  await writeFile(patchPath, "- insert:\n    - id: autoresearch-web\n      name: '@athena/autoresearch-web'\n")
  const install = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web'], {
      env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  }
  install()
  const first = await readFile(patchPath, 'utf8')
  const rows = parse(first).flatMap((patch: { insert?: Array<{ name: string }> }) => patch.insert ?? [])
  assert.equal(rows.filter((row: { name: string }) => row.name === '@athena/autoresearch').length, 1)
  assert.equal(rows.filter((row: { name: string }) => row.name === '@athena/autoresearch-web').length, 1)
  const installedAgent = join(dshTestHome, '.agent-presets', 'auto-research', 'agent.cordis.yml')
  const installedPreset = parse(await readFile(installedAgent, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
  const persona = installedPreset.find((row) => row.id === 'persona')
  assert.equal(typeof persona?.config?.prefix, 'string')
  assert.match(persona?.config?.prefix as string, /research_run.*experiment_run.*paper_pipeline_/s)
  const delegation = installedPreset.find((row) => row.id === 'delegation')
  const subagents = (delegation?.config ?? []) as Array<{ id: string; config?: Record<string, unknown> }>
  const spawn = subagents.find((row) => row.id === 'tool-subagent')
  assert.deepEqual(spawn?.config, { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' })
  const fork = subagents.find((row) => row.id === 'tool-subagent-fork')
  assert.deepEqual(fork?.config, { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' })
  await stat(installedAgent)
  await assert.rejects(stat(join(dshTestHome, '.agent-presets', 'auto_research')))
  install()
  assert.equal(await readFile(patchPath, 'utf8'), first)
})
