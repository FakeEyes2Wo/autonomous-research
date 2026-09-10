import test from 'node:test'
import assert from 'node:assert/strict'
import { findLatexEngine, latexEngines, proxyEnvironment } from '../../src/paper/engine.ts'

test('latex engine registry has no machine-specific compiler candidates', () => {
  const tectonic = latexEngines.find((engine) => engine.name === 'tectonic')
  assert.ok(tectonic)
  assert.deepEqual(tectonic.candidates, ['tectonic'])
})

test('explicit TECTONIC_PATH wins over PATH and an unavailable path does not fall back', () => {
  const calls: string[] = []
  const explicit = 'C:\\portable\\tectonic.exe'
  const resolved = findLatexEngine({
    env: { TECTONIC_PATH: explicit },
    exists: () => true,
    probe: (command) => { calls.push(command); return true },
  })
  assert.equal(resolved?.name, 'tectonic')
  assert.equal(resolved?.command, explicit)
  assert.deepEqual(calls, [explicit])

  calls.length = 0
  const missing = findLatexEngine({
    env: { TECTONIC_PATH: explicit },
    exists: () => false,
    probe: (command) => { calls.push(command); return command === 'tectonic' },
  })
  assert.equal(missing, undefined)
  assert.deepEqual(calls, [])
})

test('normal engine discovery uses PATH probes when no explicit path is configured', () => {
  const calls: string[] = []
  const resolved = findLatexEngine({
    env: {},
    probe: (command) => { calls.push(command); return command === 'tectonic' },
  })
  assert.equal(resolved?.name, 'tectonic')
  assert.equal(resolved?.command, 'tectonic')
  assert.deepEqual(calls.slice(0, 2), ['xelatex', 'tectonic'])
})

test('proxy environment is inherited without a localhost fallback', () => {
  assert.deepEqual(proxyEnvironment({}), {})
  assert.deepEqual(proxyEnvironment({ HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: '', ALL_PROXY: 'socks5://proxy.example:1080' }), {
    HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: '', ALL_PROXY: 'socks5://proxy.example:1080',
  })
  assert.doesNotMatch(JSON.stringify(proxyEnvironment({})), /127\.0\.0\.1:7890/)
})
