import { after } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = ['test/unit', 'test/integration']

// Keep tests that use DSH's global last-run pointer inside a disposable home.
// Set this before importing any test modules, since they may read it at import time.
const testHome = await mkdtemp(join(tmpdir(), 'autoresearch-test-'))
process.env.DSH_HOME = testHome

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  await rm(testHome, { recursive: true, force: true })
}

// Test callbacks run after imports finish, so cleanup belongs in the test hook.
// The exit fallback covers an import/setup failure before the hook can run.
after(cleanup)
process.once('exit', () => {
  if (cleaned) return
  cleaned = true
  try {
    rmSync(testHome, { recursive: true, force: true })
  } catch {
    // Preserve the test runner's original exit status if cleanup itself fails.
  }
})

for (const suite of suites) {
  const dir = join(root, suite)
  const files = (await readdir(dir)).filter((name) => name.endsWith('.test.ts')).sort()
  for (const file of files) {
    const url = new URL(`./${suite}/${file}`, `file://${root.replace(/\\/g, '/')}/`).href
    await import(url)
  }
}
