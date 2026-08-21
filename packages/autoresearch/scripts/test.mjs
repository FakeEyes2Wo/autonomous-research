import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = ['test/unit', 'test/integration']

for (const suite of suites) {
  const dir = join(root, suite)
  const files = (await readdir(dir)).filter((name) => name.endsWith('.test.ts')).sort()
  for (const file of files) {
    const url = new URL(`./${suite}/${file}`, `file://${root.replace(/\\/g, '/')}/`).href
    await import(url)
  }
}
