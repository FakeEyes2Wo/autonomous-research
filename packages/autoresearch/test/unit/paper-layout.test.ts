import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compilePaper, hashPaperSources, measurePaperLayout, parseCompileDiagnostics, preparePaperLayout, inspectPaperPdf, validatePageGeometry, type PaperLayoutGeometryInput, type PaperLayoutProfile, type PaperPdfInspection } from '../../dist/paper/index.js'

test('layout preparation defaults to ICLR and records bounded figure geometry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const prepared = await preparePaperLayout(dir)
  assert.equal(prepared.profile.venue, 'ICLR')
  assert.equal(prepared.profile.columns.count, 1)
  assert.equal(prepared.profile.units.pdfPointPerInch, 72)
  assert.ok(prepared.profile.figure.maxWidthPt > 0)
  assert.match(prepared.profile.templateHash, /^[a-f0-9]{64}$/)
  assert.ok(await readFile(prepared.templateFile, 'utf8'))
})

test('generic USENIX and custom layout assets are explicit and byte-preserving', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'paper-layout-'))
  const custom = await mkdtemp(join(tmpdir(), 'paper-template-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(custom, { recursive: true, force: true }) })
  await writeFile(join(custom, 'entry.tex'), '% custom\n\\documentclass{article}\n')
  await writeFile(join(custom, 'asset.sty'), '% asset\n')
  const customProfile: PaperLayoutGeometryInput = {
    page: { widthPt: 612, heightPt: 792, marginPt: { top: 36, right: 36, bottom: 36, left: 36 } },
    columns: { count: 1, widthPt: 540, gutterPt: 0 },
  }
  const usenix = await preparePaperLayout(join(root, 'usenix'), { venue: 'USENIX' })
  assert.equal(usenix.profile.venue, 'USENIX')
  assert.equal(usenix.profile.columns.count, 2)
  assert.equal(usenix.profile.columns.gutterPt, 0.33 * 72)
  assert.equal(usenix.profile.columns.widthPt, (7 * 72 - 0.33 * 72) / 2)
  assert.match(usenix.profile.templateName, /usenix/i)
  const prepared = await preparePaperLayout(join(root, 'custom'), { venue: 'custom', templateDir: custom, templateFile: 'entry.tex', profile: customProfile })
  assert.equal(await readFile(join(custom, 'asset.sty'), 'utf8'), await readFile(join(root, 'custom', 'asset.sty'), 'utf8'))
  assert.equal(prepared.profile.venue, 'custom')
  await assert.rejects(() => preparePaperLayout(join(root, 'missing'), { venue: 'custom', templateDir: custom, templateFile: 'missing.tex' }), /entry|template/i)
  await assert.rejects(
    () => preparePaperLayout(join(root, 'missing-profile'), { venue: 'custom', templateDir: custom, templateFile: 'entry.tex' }),
    (error: Error & { code?: string }) => error.code === 'CUSTOM_TEMPLATE_PROFILE_REQUIRED',
  )
  await assert.rejects(
    () => preparePaperLayout(join(root, 'unknown'), { venue: 'SEC26' as never }),
    (error: Error & { code?: string }) => error.code === 'UNKNOWN_TEMPLATE',
  )
})

test('invalid custom geometry is rejected before template copying', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'paper-layout-invalid-'))
  const custom = await mkdtemp(join(tmpdir(), 'paper-template-invalid-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(custom, { recursive: true, force: true }) })
  await writeFile(join(custom, 'entry.tex'), '% custom\n')
  const base = {
    page: { widthPt: 612, heightPt: 792, marginPt: { top: 36, right: 36, bottom: 36, left: 36 } },
    columns: { count: 1, widthPt: 540, gutterPt: 0 },
  }
  const invalid = [
    { ...base, page: { ...base.page, widthPt: Number.NaN } },
    { ...base, columns: { ...base.columns, count: 1.5 } },
    { ...base, columns: { ...base.columns, widthPt: 600 } },
    { ...base, typography: { bodyPt: Number.NaN, captionPt: 8 } },
    { ...base, figure: { maxWidthPt: 400, captionWidthPt: 401, allowedFormats: ['png'] } },
  ]
  for (const [index, profile] of invalid.entries()) {
    const target = join(root, `target-${index}`)
    await assert.rejects(
      () => preparePaperLayout(target, { venue: 'custom', templateDir: custom, templateFile: 'entry.tex', profile: profile as never }),
      (error: Error & { code?: string }) => error.code === 'INVALID_LAYOUT_PROFILE',
    )
    await assert.rejects(() => readdir(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  }
})

test('PDF inspection fails closed when the PDF or renderer is unavailable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = await inspectPaperPdf(dir)
  assert.equal(result.coverage.complete, false)
  assert.ok(result.issues.some(issue => issue.code === 'PDF_MISSING'))
})

test('PDF inspection does not treat a raster image block as text overlap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-raster-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const generated = spawnSync('python', ['-c', [
    'import fitz',
    'from PIL import Image',
    "Image.new('RGB',(1,1),'red').save('pixel.png')",
    'doc=fitz.open()',
    'page=doc.new_page()',
    "page.insert_text((50,50),'caption')",
    "page.insert_image(fitz.Rect(100,100,200,200), filename='pixel.png')",
    "doc.save('main.pdf')",
  ].join(';')], { cwd: dir, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const result = await inspectPaperPdf(dir)
  assert.equal(result.coverage.complete, true)
  assert.equal(result.pages[0]?.imageBoxes, 1)
  assert.equal(result.issues.some(issue => issue.code === 'SUSPECTED_TEXT_IMAGE_OVERLAP'), false)
})

test('custom profile preserves explicit dimensions and TeX conversion is visible', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const profile: PaperLayoutGeometryInput = {
    page: { widthPt: 600, heightPt: 800, marginPt: { top: 40, right: 40, bottom: 40, left: 40 } },
    columns: { count: 1, widthPt: 520, gutterPt: 0 },
  }
  const prepared = await preparePaperLayout(dir, { venue: 'custom', templateDir: join(process.cwd(), 'templates'), templateFile: 'iclr2026.tex', profile })
  assert.equal(prepared.profile.page.widthPt, 600)
  assert.equal(prepared.profile.columns.widthPt, 520)
  assert.equal(prepared.profile.units.texPointPerInch, 72.27)
})

test('compiler diagnostics retain source and line while separating layout warnings from errors', () => {
  const diagnostics = parseCompileDiagnostics([
    'main.tex:12: Warning: Overfull \\hbox (3.2pt too wide) in paragraph',
    'LaTeX Warning: Float too large for page by 2.0pt',
    '\\flushend@@floatbox=\\box57',
    '! LaTeX Error: File `missing.sty` not found.',
  ].join('\n'))
  assert.deepEqual(diagnostics, [
    { severity: 'warning', code: 'OVERFULL_HBOX', message: 'Overfull \\hbox (3.2pt too wide) in paragraph', source: 'main.tex', line: 12 },
    { severity: 'warning', code: 'FLOAT_LAYOUT', message: 'LaTeX Warning: Float too large for page by 2.0pt' },
    { severity: 'error', code: 'LATEX_ERROR', message: 'File `missing.sty` not found.' },
  ])
})

test('source hash includes main source changes and ignores generated PDFs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-hash-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), 'first\n')
  await writeFile(join(dir, 'main.pdf'), 'old generated output\n')
  const first = await hashPaperSources(dir)
  await writeFile(join(dir, 'main.pdf'), 'new generated output\n')
  assert.equal(await hashPaperSources(dir), first)
  await writeFile(join(dir, 'main.tex'), 'second\n')
  assert.notEqual(await hashPaperSources(dir), first)
})

test('source hashes bind arbitrary-extension dependencies reached through manuscript input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-input-extension-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), '\\input{body.ltx}')
  await writeFile(join(dir, 'body.ltx'), '\\input{results.txt}')
  await writeFile(join(dir, 'results.txt'), 'First finding.')
  const first = await hashPaperSources(dir)
  await writeFile(join(dir, 'results.txt'), 'Changed finding.')
  assert.notEqual(await hashPaperSources(dir), first)
})

test('custom preparation preserves all existing manuscript files across template changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-template-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paper = join(root, 'paper'), template = join(root, 'template')
  await mkdir(join(paper, 'sections'), { recursive: true }); await mkdir(join(template, 'sections'), { recursive: true })
  await writeFile(join(paper, 'main.tex'), '\\input{sections/body.tex}')
  await writeFile(join(paper, 'sections', 'body.tex'), 'Handwritten scientific result.')
  await writeFile(join(template, 'main.tex'), 'Template main placeholder.')
  await writeFile(join(template, 'sections', 'body.tex'), 'Template body placeholder.')
  const options = { venue: 'custom' as const, templateDir: template, templateFile: 'main.tex', profile: { page: { widthPt: 612, heightPt: 792, marginPt: { top: 72, right: 72, bottom: 72, left: 72 } }, columns: { count: 1, widthPt: 468, gutterPt: 0 } } }
  const prepared = await preparePaperLayout(paper, options)
  assert.equal(await readFile(join(paper, 'main.tex'), 'utf8'), '\\input{sections/body.tex}')
  assert.equal(await readFile(join(paper, 'sections', 'body.tex'), 'utf8'), 'Handwritten scientific result.')
  assert.notEqual(prepared.templateFile, join(paper, 'main.tex'))
  await writeFile(join(template, 'sections', 'body.tex'), 'New template body placeholder.')
  await preparePaperLayout(paper, options)
  assert.equal(await readFile(join(paper, 'sections', 'body.tex'), 'utf8'), 'Handwritten scientific result.')
})

test('source hash excludes control outputs but binds sections, bibliography, figures, and templates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-hash-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), 'main\n')
  const first = await hashPaperSources(dir)
  await writeFile(join(dir, 'pipeline_checkpoint.json'), '{"round":1}\n')
  await writeFile(join(dir, 'paper_audit.json'), '{"ok":true}\n')
  await writeFile(join(dir, 'PAPER_CLAIM_AUDIT.json'), '{"ok":true}\n')
  await writeFile(join(dir, 'CITATION_AUDIT.json'), '{"ok":true}\n')
  await writeFile(join(dir, 'PAPER_REVIEW_REPORT.md'), 'review\n')
  await writeFile(join(dir, 'main.log'), 'compiler log\n')
  assert.equal(await hashPaperSources(dir), first)
  await writeFile(join(dir, 'sections.tex'), 'section\n')
  assert.notEqual(await hashPaperSources(dir), first)
  const second = await hashPaperSources(dir)
  await writeFile(join(dir, 'references.bib'), '@article{x, title={X}}\n')
  assert.notEqual(await hashPaperSources(dir), second)
  const third = await hashPaperSources(dir)
  await writeFile(join(dir, 'figure.png'), Buffer.from([1, 2, 3]))
  assert.notEqual(await hashPaperSources(dir), third)
  const fourth = await hashPaperSources(dir)
  await writeFile(join(dir, 'custom.sty'), '% template\n')
  assert.notEqual(await hashPaperSources(dir), fourth)
  const fifth = await hashPaperSources(dir)
  await writeFile(join(dir, 'paper_figure.png'), Buffer.from([4, 5, 6]))
  assert.notEqual(await hashPaperSources(dir), fifth)
  const sixth = await hashPaperSources(dir)
  await writeFile(join(dir, 'review_results.tex'), 'review results\n')
  assert.notEqual(await hashPaperSources(dir), sixth)
})

test('page geometry validation reports measured mismatch without pretending columns were measured', () => {
  const profile: PaperLayoutProfile = {
    schema: 'autoresearch/paper-layout-profile/v1', venue: 'custom', templateName: 'custom', templateHash: 't', assetHashes: {},
    page: { widthPt: 612, heightPt: 792, marginPt: { top: 36, right: 36, bottom: 36, left: 36 } },
    columns: { count: 1, widthPt: 540, gutterPt: 0 }, typography: { bodyPt: 10, captionPt: 8 },
    figure: { maxWidthPt: 540, captionWidthPt: 540, allowedFormats: ['png'] }, units: { pdfPointPerInch: 72, texPointPerInch: 72.27 },
  }
  const inspection: PaperPdfInspection = {
    schema: 'autoresearch/paper-pdf-inspection/v1', pdfHash: 'p', pdfPath: 'main.pdf',
    pages: [{ page: 1, imagePath: 'page.png', widthPt: 600, heightPt: 792, textBoxes: 0, imageBoxes: 0 }],
    issues: [], coverage: { complete: true, renderedPages: 1, pageCount: 1, visuallyReviewed: false },
  }
  const checked = validatePageGeometry(inspection, profile)
  assert.equal(checked.issues[0]?.code, 'PAGE_SIZE_MISMATCH')
  assert.equal(checked.pages[0]?.widthPt, 600)
})

test('TeX layout probe reports measured text and column geometry in PDF points', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-probe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nprobe\\end{document}\n')
  const engine = {
    command: process.execPath,
    args: () => ['-e', "console.log('PAPER_LAYOUT_PROBE_SIZE physicalpage=1 w=614.295pt h=794.969pt'); console.log('PAPER_LAYOUT_PROBE_TEXT physicalpage=1 tw=397.484pt th=650pt'); console.log('PAPER_LAYOUT_PROBE_COLUMN physicalpage=1 cw=190pt cs=17.484pt n=2')"],
  }
  const measurement = await measurePaperLayout(dir, { engine })
  assert.equal(measurement.status, 'measured')
  assert.equal(measurement.measurementSource, 'tex-probe')
  assert.equal(measurement.pages[0]?.columns, 2)
  assert.ok(Math.abs((measurement.pages[0]?.textWidthPt ?? 0) - 396) < 0.1)
  assert.ok(Math.abs((measurement.pages[0]?.columnWidthPt ?? 0) - 189.29) < 0.1)
  assert.equal(measurement.diagnostics.length, 0)
})

test('Tectonic layout probe requests a log when the engine args omit keep-logs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-probe-tectonic-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nprobe\\end{document}\n')
  const engine = {
    name: 'tectonic',
    command: process.execPath,
    args: () => ['-e', "if (!process.argv.includes('--keep-logs')) process.exit(3); require('node:fs').writeFileSync('main.log', 'PAPER_LAYOUT_PROBE_SIZE physicalpage=1 w=614.295pt h=794.969pt\\nPAPER_LAYOUT_PROBE_TEXT physicalpage=1 tw=397.484pt th=650pt\\nPAPER_LAYOUT_PROBE_COLUMN physicalpage=1 cw=190pt cs=17.484pt n=2')", 'main.tex'],
  }
  const measurement = await measurePaperLayout(dir, { engine })
  assert.equal(measurement.status, 'measured')
  assert.equal(measurement.pages[0]?.columns, 2)
  assert.equal(measurement.diagnostics.length, 0)
})

test('failed TeX layout probe stays unknown even if its log has a partial record', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-probe-failed-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nprobe\\end{document}\n')
  const engine = {
    command: process.execPath,
    args: () => ['-e', "console.log('PAPER_LAYOUT_PROBE_SIZE physicalpage=1 w=614.295pt h=794.969pt'); process.exit(2)"],
  }
  const measurement = await measurePaperLayout(dir, { engine })
  assert.equal(measurement.status, 'unknown')
  assert.deepEqual(measurement.pages, [])
  assert.equal(measurement.diagnostics[0]?.code, 'LAYOUT_PROBE_FAILED')
})

test('compilePaper removes stale PDFs before compiling and reports missing output after failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-layout-compile-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const successEngine = {
    name: 'fake', command: process.execPath,
    spec: { name: 'fake', candidates: [], versionArgs: [], args: () => ['-e', "require('node:fs').writeFileSync('main.pdf', 'fresh')"] },
  }
  await writeFile(join(dir, 'main.pdf'), 'stale')
  const success = await compilePaper(dir, { engine: successEngine as never, inspect: false })
  assert.equal(success.ok, true)
  assert.equal(await readFile(join(dir, 'main.pdf'), 'utf8'), 'fresh')

  const failureEngine = {
    name: 'fake', command: process.execPath,
    spec: { name: 'fake', candidates: [], versionArgs: [], args: () => ['-e', 'process.exit(2)'] },
  }
  await writeFile(join(dir, 'main.pdf'), 'stale again')
  const failure = await compilePaper(dir, { engine: failureEngine as never, inspect: false })
  assert.equal(failure.ok, false)
  assert.equal(failure.diagnostics.some((diagnostic) => diagnostic.code === 'PDF_MISSING'), true)

  const blockedDir = join(dir, 'blocked')
  await mkdir(join(blockedDir, 'main.pdf'), { recursive: true })
  const cleanupFailure = await compilePaper(blockedDir, { engine: successEngine as never, inspect: false })
  assert.equal(cleanupFailure.ok, false)
  assert.equal(cleanupFailure.diagnostics[0]?.code, 'STALE_OUTPUT_CLEANUP_FAILED')
})
