#!/usr/bin/env node
/**
 * Guard: every `{{variable}}` used by an AutoResearch preset must exist in the
 * DSH prompt-variable registry.
 *
 * DSH 0.2.x registers only `provider` and `model` (see @deepseek-ai/dsh-system-prompt,
 * PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"). A preset that references an
 * unregistered variable — e.g. the `{{cwd}}` that used to sit in this package's persona
 * suffix — aborts EVERY turn with:
 *
 *   This turn failed: unknown prompt variable "{{cwd}}" in section
 *   "deployment:persona-suffix"; registered variables: provider, model
 *
 * Comment lines (`# ...`) are ignored, so explanatory prose may still mention a
 * variable by name without tripping the guard.
 *
 * Exit code 1 on violation, so it can be wired into `npm test` / CI.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REGISTERED = new Set(['provider', 'model'])
const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const presetsRoot = join(packageRoot, 'presets')

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function isComment(line) {
  return /^\s*#/.test(line)
}

const files = []
for await (const file of walk(presetsRoot)) {
  if (/\.ya?ml$/i.test(file)) files.push(file)
}

const violations = []
let references = 0

for (const file of files.sort()) {
  const text = await readFile(file, 'utf8')
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (isComment(line)) continue
    for (const match of line.matchAll(VARIABLE)) {
      references += 1
      const name = match[1]
      if (REGISTERED.has(name)) continue
      violations.push({
        file: relative(packageRoot, file),
        line: index + 1,
        name,
        text: line.trim().replace(/\s+/g, ' ').slice(0, 160),
      })
    }
  }
}

const registered = [...REGISTERED].sort().join(', ')

if (violations.length > 0) {
  console.error(`✗ preset prompt variables: ${violations.length} unregistered reference(s)`)
  console.error(`  registered in DSH: ${registered}`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  {{${violation.name}}}`)
    console.error(`    ${violation.text}`)
  }
  console.error('')
  console.error('Fix: drop the variable, hardcode the value, or resolve it with a tool call.')
  console.error('A reference that survives validation fails every turn while rendering')
  console.error('the "deployment:persona-suffix" section.')
  process.exit(1)
}

console.log(`✓ preset prompt variables: ${references} reference(s) across ${files.length} preset file(s) use only [${registered}]`)
