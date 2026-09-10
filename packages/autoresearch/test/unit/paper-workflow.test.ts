import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { generatePaperPlan, auditPaper } from '../../dist/paper/index.js'

test('generatePaperPlan writes matrix and plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-plan-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'H1')
    const action = tree.add('action', 'A1', { parent: hyp.id })
    tree.add('evidence', 'E1', { parent: action.id, status: 'supports' })
    await tree.save()

    const { planFile, matrixFile } = await generatePaperPlan(dir, tree)
    const plan = await readFile(planFile, 'utf8')
    const matrix = JSON.parse(await readFile(matrixFile, 'utf8'))
    assert.match(plan, /Claims-Evidence Matrix/)
    assert.equal(matrix.claims[0]?.verdict, 'supported')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auditPaper catches numbers without evidence tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-audit-'))
  try {
    await mkdir(join(dir, 'paper'), { recursive: true })
    await writeFile(join(dir, 'paper', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nAccuracy is 0.95.\n\\end{document}\n')
    const result = await auditPaper(dir, ['E1'])
    assert.equal(result.numeric.ok, false)
    assert.match(result.numeric.errors[0] ?? '', /without evidence tag/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auditPaper accepts numbers with known evidence tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-audit-ok-'))
  try {
    await mkdir(join(dir, 'paper'), { recursive: true })
    await writeFile(join(dir, 'paper', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nAccuracy is 0.95.\n% evidence: E-evi_1\n\\end{document}\n')
    const result = await auditPaper(dir, ['E-evi_1'])
    assert.equal(result.numeric.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auditPaper ignores LaTeX macro arity syntax but still audits正文 numeric claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-audit-macros-'))
  try {
    await mkdir(join(dir, 'paper'), { recursive: true })
    await writeFile(join(dir, 'paper', 'math_commands.tex'), '\\newcommand{\\norm}[1]{\\left\\|#1\\right\\|}\n\\newcommand{\\inner}[2]{\\langle #1,#2\\rangle}\n')
    await writeFile(join(dir, 'paper', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nAccuracy is 0.95.\n\\end{document}\n')
    const result = await auditPaper(dir, ['E1'])
    assert.equal(result.numeric.ok, false)
    assert.equal(result.numeric.errors.length, 1)
    assert.match(result.numeric.errors[0] ?? '', /Accuracy is 0\.95/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auditPaper accepts a macro-definition file without treating arity as a claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-audit-macro-only-'))
  try {
    await mkdir(join(dir, 'paper'), { recursive: true })
    await writeFile(join(dir, 'paper', 'math_commands.tex'), '\\newcommand{\\norm}[1]{\\left\\|#1\\right\\|}\n\\newcommand{\\inner}[2]{\\langle #1,#2\\rangle}\n')
    const result = await auditPaper(dir, ['E1'])
    assert.equal(result.numeric.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
