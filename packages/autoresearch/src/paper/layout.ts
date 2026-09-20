import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolvePaperSources } from './sources.js'

export type PaperVenue = 'ICLR' | 'USENIX' | 'custom'

export interface PaperLayoutProfile {
  schema: 'autoresearch/paper-layout-profile/v1'
  venue: PaperVenue
  templateName: string
  templateHash: string
  assetHashes: Record<string, string>
  page: { widthPt: number; heightPt: number; marginPt: { top: number; right: number; bottom: number; left: number } }
  columns: { count: number; widthPt: number; gutterPt: number }
  typography: { bodyPt: number; captionPt: number; lineHeightPt?: number }
  figure: { maxWidthPt: number; maxHeightPt?: number; captionWidthPt: number; allowedFormats: string[] }
  units: { pdfPointPerInch: 72; texPointPerInch: 72.27 }
}

export interface PreparedPaperLayout {
  profile: PaperLayoutProfile
  templateFile: string
  assetFiles: string[]
  sourceHash: string
  assetHashes: Record<string, string>
}

export interface PreparePaperLayoutOptions {
  venue?: PaperVenue
  templateDir?: string
  templateFile?: string
  profile?: PaperLayoutGeometryInput
}

export interface PaperLayoutGeometryInput {
  page: PaperLayoutProfile['page']
  columns: PaperLayoutProfile['columns']
  typography?: PaperLayoutProfile['typography']
  figure?: PaperLayoutProfile['figure']
}

export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  source?: string
  line?: number
}

export interface PaperLayoutProbeEngine {
  name?: string
  command: string
  args: (paperDir: string) => readonly string[]
  env?: () => Record<string, string>
}

export interface PaperLayoutMeasurementPage {
  page: number
  pageWidthPt: number
  pageHeightPt: number
  textWidthPt: number
  textHeightPt: number
  columnWidthPt: number
  columnSepPt: number
  columns: number
}

export interface PaperLayoutMeasurement {
  status: 'measured' | 'unknown'
  measurementSource?: 'tex-probe'
  pages: PaperLayoutMeasurementPage[]
  diagnostics: CompileDiagnostic[]
}

export interface InspectPaperPdfOptions {
  pdfPath?: string
  layout?: PaperLayoutProfile
  renderDir?: string
  renderer?: 'fitz'
}

export interface PaperPdfInspection {
  schema: 'autoresearch/paper-pdf-inspection/v1'
  pdfHash: string
  pdfPath: string
  pages: Array<{
    page: number
    imagePath: string
    widthPt: number
    heightPt: number
    textBoxes: number
    imageBoxes: number
    textRects?: Array<[number, number, number, number]>
    imageRects?: Array<[number, number, number, number]>
  }>
  issues: Array<{ code: string; severity: 'warning' | 'error'; page?: number; detail: string }>
  coverage: { complete: boolean; renderedPages: number; pageCount: number; visuallyReviewed: boolean }
}

const PACKAGE_TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url))
const PDF_POINTS_PER_INCH = 72 as const
const TEX_POINTS_PER_INCH = 72.27 as const

const iclrGeometry = {
  page: { widthPt: 8.5 * PDF_POINTS_PER_INCH, heightPt: 11 * PDF_POINTS_PER_INCH, marginPt: { top: 72, right: 108, bottom: 72, left: 108 } },
  columns: { count: 1, widthPt: 5.5 * PDF_POINTS_PER_INCH, gutterPt: 0 },
}
const usenixGeometry = {
  // Derived from usenix2019_v3.sty: 7.00in text width, 9.00in text
  // height, and 0.33in column separation on US letter paper.
  page: { widthPt: 8.5 * PDF_POINTS_PER_INCH, heightPt: 11 * PDF_POINTS_PER_INCH, marginPt: { top: 72, right: 54, bottom: 72, left: 54 } },
  columns: { count: 2, widthPt: (7 * PDF_POINTS_PER_INCH - 0.33 * PDF_POINTS_PER_INCH) / 2, gutterPt: 0.33 * PDF_POINTS_PER_INCH },
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function mergeProfile(base: PaperLayoutProfile, override?: PaperLayoutGeometryInput): PaperLayoutProfile {
  if (!override) return base
  return {
    ...base,
    page: { ...base.page, ...(override.page ?? {}), marginPt: { ...base.page.marginPt, ...(override.page?.marginPt ?? {}) } },
    columns: { ...base.columns, ...(override.columns ?? {}) },
    typography: { ...base.typography, ...(override.typography ?? {}) },
    figure: { ...base.figure, ...(override.figure ?? {}) },
    units: { pdfPointPerInch: 72, texPointPerInch: 72.27 },
  }
}

function profileFor(venue: PaperVenue, templateName: string, templateHash: string, assetHashes: Record<string, string>, override?: PaperLayoutGeometryInput): PaperLayoutProfile {
  if (venue === 'custom') {
    validateGeometryInput(override, true)
    if (!override) throw codedError('CUSTOM_TEMPLATE_PROFILE_REQUIRED', 'custom templates require explicit page and column geometry')
    const page = override.page
    const columns = override.columns
    const typography = override.typography ?? { bodyPt: 10, captionPt: 8, lineHeightPt: 12 }
    const figure = override.figure ?? { maxWidthPt: columns.widthPt, maxHeightPt: page.heightPt - page.marginPt.top - page.marginPt.bottom, captionWidthPt: columns.widthPt, allowedFormats: ['pdf', 'png', 'jpg', 'jpeg'] }
    return validateProfile({
      schema: 'autoresearch/paper-layout-profile/v1', venue, templateName, templateHash, assetHashes,
      page, columns, typography, figure, units: { pdfPointPerInch: 72, texPointPerInch: 72.27 },
    })
  }
  const geometry = venue === 'USENIX' ? usenixGeometry : iclrGeometry
  const profile: PaperLayoutProfile = {
    schema: 'autoresearch/paper-layout-profile/v1', venue, templateName, templateHash, assetHashes,
    page: geometry.page,
    columns: geometry.columns,
    typography: { bodyPt: venue === 'USENIX' ? 10 : 10, captionPt: 8, lineHeightPt: 12 },
    figure: { maxWidthPt: geometry.columns.widthPt, maxHeightPt: geometry.page.heightPt - geometry.page.marginPt.top - geometry.page.marginPt.bottom, captionWidthPt: geometry.columns.widthPt, allowedFormats: ['pdf', 'png', 'jpg', 'jpeg', 'eps'] },
    units: { pdfPointPerInch: 72, texPointPerInch: 72.27 },
  }
  validateGeometryInput(override, false)
  return validateProfile(mergeProfile(profile, override))
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function invalidProfile(message: string): never {
  throw codedError('INVALID_LAYOUT_PROFILE', message)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidProfile(`${label} must be a finite number`)
  return value
}

function validatePageAndColumns(page: PaperLayoutProfile['page'] | undefined, columns: PaperLayoutProfile['columns'] | undefined): void {
  if (!page || !columns) invalidProfile('page and columns geometry are required')
  const width = finiteNumber(page.widthPt, 'page.widthPt')
  const height = finiteNumber(page.heightPt, 'page.heightPt')
  if (width <= 0 || height <= 0) invalidProfile('page dimensions must be positive')
  if (!page.marginPt) invalidProfile('page margins are required')
  const top = finiteNumber(page.marginPt.top, 'page.marginPt.top')
  const right = finiteNumber(page.marginPt.right, 'page.marginPt.right')
  const bottom = finiteNumber(page.marginPt.bottom, 'page.marginPt.bottom')
  const left = finiteNumber(page.marginPt.left, 'page.marginPt.left')
  if ([top, right, bottom, left].some(value => value < 0) || left + right >= width || top + bottom >= height) invalidProfile('page margins must leave positive usable space')
  const count = finiteNumber(columns.count, 'columns.count')
  const columnWidth = finiteNumber(columns.widthPt, 'columns.widthPt')
  const gutter = finiteNumber(columns.gutterPt, 'columns.gutterPt')
  if (!Number.isInteger(count) || count < 1) invalidProfile('columns.count must be a positive integer')
  if (columnWidth <= 0 || gutter < 0) invalidProfile('column width must be positive and gutter must be nonnegative')
  const usableWidth = width - left - right
  const occupiedWidth = count * columnWidth + (count - 1) * gutter
  if (occupiedWidth > usableWidth + 0.5) invalidProfile('columns exceed usable page width')
}

function validateTypography(typography: PaperLayoutProfile['typography'] | undefined): void {
  if (!typography) invalidProfile('typography geometry is required')
  if (finiteNumber(typography.bodyPt, 'typography.bodyPt') <= 0 || finiteNumber(typography.captionPt, 'typography.captionPt') <= 0) invalidProfile('typography sizes must be positive')
  if (typography.lineHeightPt !== undefined && finiteNumber(typography.lineHeightPt, 'typography.lineHeightPt') <= 0) invalidProfile('typography.lineHeightPt must be positive')
}

function validateFigure(figure: PaperLayoutProfile['figure'] | undefined, page: PaperLayoutProfile['page']): void {
  if (!figure) invalidProfile('figure geometry is required')
  const maxWidth = finiteNumber(figure.maxWidthPt, 'figure.maxWidthPt')
  const captionWidth = finiteNumber(figure.captionWidthPt, 'figure.captionWidthPt')
  if (maxWidth <= 0 || captionWidth <= 0 || captionWidth > maxWidth) invalidProfile('figure widths must be positive and caption width cannot exceed figure width')
  const maxHeight = figure.maxHeightPt === undefined ? undefined : finiteNumber(figure.maxHeightPt, 'figure.maxHeightPt')
  if (maxHeight !== undefined && maxHeight <= 0) invalidProfile('figure.maxHeightPt must be positive')
  const usableWidth = page.widthPt - page.marginPt.left - page.marginPt.right
  const usableHeight = page.heightPt - page.marginPt.top - page.marginPt.bottom
  if (maxWidth > usableWidth + 0.5 || (maxHeight !== undefined && maxHeight > usableHeight + 0.5)) invalidProfile('figure geometry exceeds usable page bounds')
  if (!Array.isArray(figure.allowedFormats) || figure.allowedFormats.length === 0 || figure.allowedFormats.some(format => typeof format !== 'string' || format.trim() === '')) invalidProfile('figure.allowedFormats must contain format names')
}

function validateGeometryInput(input: PaperLayoutGeometryInput | undefined, required: boolean): void {
  if (!input) {
    if (required) throw codedError('CUSTOM_TEMPLATE_PROFILE_REQUIRED', 'custom templates require explicit page and column geometry')
    return
  }
  validatePageAndColumns(input.page, input.columns)
  if (input.typography) validateTypography(input.typography)
  if (input.figure) validateFigure(input.figure, input.page)
}

function validateProfile(profile: PaperLayoutProfile): PaperLayoutProfile {
  validatePageAndColumns(profile.page, profile.columns)
  validateTypography(profile.typography)
  validateFigure(profile.figure, profile.page)
  return profile
}

async function copyAssets(sourceDir: string, destinationDir: string, entryName: string, selectedNames?: readonly string[]): Promise<{ templateFile: string; assetFiles: string[]; hashes: Record<string, string> }> {
  const sourceRoot = resolve(sourceDir), targetRoot = resolve(destinationDir)
  const sourceFiles = await filesUnder(sourceRoot)
  const entrySource = resolve(sourceRoot, entryName)
  if (!sourceFiles.some(path => resolve(path) === entrySource)) throw codedError('TEMPLATE_ENTRY_NOT_FOUND', `template entry not found: ${entryName}`)
  const selected = selectedNames ? new Set(selectedNames.map(name => resolve(sourceRoot, name))) : undefined
  if (selected) selected.add(entrySource)
  const hashes: Record<string, string> = {}, copied: string[] = []
  const sources = sourceFiles.filter(file => !selected || selected.has(resolve(file)))
  const sourceIdentity = await Promise.all(sources.map(async source => [relative(sourceRoot, source).replaceAll('\\', '/'), digest(await readFile(source))]))
  const snapshotRoot = join(targetRoot, '.paper-template', digest(JSON.stringify(sourceIdentity)).slice(0, 32))
  for (const source of sources) {
    const rel = relative(sourceRoot, source)
    const bytes = await readFile(source)
    // Keep complete selected template bytes separate from authored manuscript bytes.
    const snapshot = join(snapshotRoot, rel)
    await mkdir(dirname(snapshot), { recursive: true })
    try { await writeFile(snapshot, bytes, { flag: 'wx' }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!bytes.equals(await readFile(snapshot))) throw codedError('TEMPLATE_SNAPSHOT_CHANGED', `selected template snapshot changed: ${snapshot}`)
    }
    copied.push(snapshot)
    hashes[relative(targetRoot, snapshot).replaceAll('\\', '/')] = digest(bytes)
    // Entry examples are never installed as main.tex. Existing runtime files, including
    // manually repaired sections/styles, are authoritative and must never be replaced.
    if (resolve(source) !== entrySource) {
      const target = join(targetRoot, rel)
      await mkdir(dirname(target), { recursive: true })
      try { await writeFile(target, bytes, { flag: 'wx' }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      hashes[rel.replaceAll('\\', '/')] = digest(await readFile(target))
      copied.push(target)
    }
  }
  return { templateFile: join(snapshotRoot, entryName), assetFiles: copied, hashes }
}

export async function preparePaperLayout(paperDir: string, options: PreparePaperLayoutOptions = {}): Promise<PreparedPaperLayout> {
  const venue = options.venue ?? 'ICLR'
  if (venue !== 'ICLR' && venue !== 'USENIX' && venue !== 'custom') throw codedError('UNKNOWN_TEMPLATE', `unsupported paper template venue: ${String(venue)}`)
  const sourceDir = options.templateDir ? resolve(options.templateDir) : PACKAGE_TEMPLATES
  const entryName = options.templateFile ?? (venue === 'USENIX' ? 'usenix2019_v3.2.tex' : 'iclr2026.tex')
  if (venue === 'custom' && !options.templateDir) throw codedError('CUSTOM_TEMPLATE_REQUIRED', 'custom layout requires templateDir')
  if (venue !== 'custom' && options.templateDir && !options.templateFile) throw codedError('TEMPLATE_ENTRY_REQUIRED', 'templateFile is required when templateDir is supplied')
  validateGeometryInput(options.profile, venue === 'custom')
  const selectedNames = venue === 'ICLR'
    ? ['iclr2026.tex', 'iclr2026_conference.sty', 'iclr2026_conference.bst', 'math_commands.tex']
    : venue === 'USENIX'
      ? ['usenix2019_v3.2.tex', 'usenix2019_v3.sty']
      : undefined
  const copied = await copyAssets(sourceDir, paperDir, entryName, selectedNames)
  const entryBytes = await readFile(join(resolve(sourceDir), entryName))
  const templateHash = digest(entryBytes)
  const profile = profileFor(venue, basename(entryName, extname(entryName)), templateHash, copied.hashes, options.profile)
  const sourceHash = digest(JSON.stringify({ templateHash, assets: copied.hashes, profile }))
  await mkdir(paperDir, { recursive: true })
  await writeFile(join(paperDir, 'paper-layout-profile.json'), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  await writeFile(join(paperDir, 'layout_profile.json'), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return { profile, templateFile: copied.templateFile, assetFiles: copied.assetFiles, sourceHash, assetHashes: copied.hashes }
}

const PAPER_SOURCE_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.def', '.cfg', '.clo', '.fd', '.ldf', '.ins', '.dtx', '.lua',
  '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.pdf', '.eps', '.svg', '.csv', '.dat',
])
const GENERATED_PAPER_FILES = new Set([
  'pipeline_checkpoint.json', 'paper_audit.json', 'paper-layout-profile.json', 'layout_profile.json', 'inspection.json',
  'paper_claim_audit.json', 'citation_audit.json', 'paper_review.json', 'paper_review_report.json', 'review_report.json',
  'figure_review.json', 'layout_review.json', 'contract_review.json', 'final_gate.json', 'compile_evidence.json',
])

function isGeneratedPaperArtifact(name: string, relativeName: string): boolean {
  if (relativeName.startsWith('.paper-review/') || relativeName.startsWith('.paper-template/')) return true
  if (name === 'main.pdf' || /^main_round\d+\.pdf$/u.test(name) || name === 'main_polished.pdf') return true
  if (GENERATED_PAPER_FILES.has(name)) return true
  if (/\.(aux|bbl|blg|fdb_latexmk|fls|log|out|synctex\.gz)$/u.test(name)) return true
  return false
}

function isPaperSourceFile(file: string, paperDir: string): boolean {
  const name = basename(file).toLowerCase()
  const relativeName = relative(resolve(paperDir), file).replaceAll('\\', '/')
  return !isGeneratedPaperArtifact(name, relativeName) && PAPER_SOURCE_EXTENSIONS.has(extname(name))
}

export async function hashPaperSources(paperDir: string): Promise<string> {
  const files = await paperCompilationFiles(paperDir)
  const entries: string[] = []
  for (const file of files.sort()) entries.push(`${relative(resolve(paperDir), file).replaceAll('\\', '/')}\0${digest(await readFile(file))}`)
  return digest(entries.join('\n'))
}

async function paperCompilationFiles(paperDir: string): Promise<string[]> {
  const files = (await filesUnder(resolve(paperDir))).filter(file => isPaperSourceFile(file, paperDir))
  const dependencies = await resolvePaperSources(paperDir, { allowMissingMain: true, allowMissingDependencies: true })
  return [...new Set([...files, ...dependencies.filter(file => !file.missing).map(file => file.path)])]
}

function probeSource(source: string): string | undefined {
  const marker = /\\begin\{document\}/u.exec(source)
  if (!marker || marker.index === undefined) return undefined
  const block = String.raw`
\makeatletter
\newcount\PaperLayoutProbePhysicalPage
\PaperLayoutProbePhysicalPage=0
\newcommand{\PaperLayoutProbeEmit}{%
  \global\advance\PaperLayoutProbePhysicalPage by 1
  \if@twocolumn\def\PaperLayoutProbeColumns{2}\else\def\PaperLayoutProbeColumns{1}\fi
  \typeout{PAPER_LAYOUT_PROBE_SIZE physicalpage=\the\PaperLayoutProbePhysicalPage w=\the\paperwidth h=\the\paperheight}%
  \typeout{PAPER_LAYOUT_PROBE_TEXT physicalpage=\the\PaperLayoutProbePhysicalPage tw=\the\textwidth th=\the\textheight}%
  \typeout{PAPER_LAYOUT_PROBE_COLUMN physicalpage=\the\PaperLayoutProbePhysicalPage cw=\the\columnwidth cs=\the\columnsep n=\PaperLayoutProbeColumns}%
}
\ifdefined\AddToHook
  \AddToHook{shipout/before}{\PaperLayoutProbeEmit}
\else
  \AtBeginDocument{\PaperLayoutProbeEmit}
\fi
\makeatother
`
  return `${source.slice(0, marker.index)}${block}\n${source.slice(marker.index)}`
}

function parseLayoutProbe(output: string): PaperLayoutMeasurementPage[] {
  const pages = new Map<number, Partial<PaperLayoutMeasurementPage>>()
  const ensure = (page: number) => pages.get(page) ?? (() => { const value: Partial<PaperLayoutMeasurementPage> = { page }; pages.set(page, value); return value })()
  const sizePattern = /PAPER_LAYOUT_PROBE_SIZE\s*physicalpage=\s*(\d+)\s*w=\s*([0-9.]+)\s*pt\s*h=\s*([0-9.]+)\s*pt/gu
  for (const match of output.matchAll(sizePattern)) { const page = ensure(Number(match[1])); page.pageWidthPt = Number(match[2]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH; page.pageHeightPt = Number(match[3]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH }
  const textPattern = /PAPER_LAYOUT_PROBE_TEXT\s*physicalpage=\s*(\d+)\s*tw=\s*([0-9.]+)\s*pt\s*th=\s*([0-9.]+)\s*pt/gu
  for (const match of output.matchAll(textPattern)) { const page = ensure(Number(match[1])); page.textWidthPt = Number(match[2]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH; page.textHeightPt = Number(match[3]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH }
  const columnPattern = /PAPER_LAYOUT_PROBE_COLUMN\s*physicalpage=\s*(\d+)\s*cw=\s*([0-9.]+)\s*pt\s*cs=\s*([0-9.]+)\s*pt\s*n=\s*(\d+)/gu
  for (const match of output.matchAll(columnPattern)) { const page = ensure(Number(match[1])); page.columnWidthPt = Number(match[2]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH; page.columnSepPt = Number(match[3]) * PDF_POINTS_PER_INCH / TEX_POINTS_PER_INCH; page.columns = Number(match[4]) }
  return [...pages.values()].filter((page): page is PaperLayoutMeasurementPage => page.page !== undefined && page.pageWidthPt !== undefined && page.pageHeightPt !== undefined && page.textWidthPt !== undefined && page.textHeightPt !== undefined && page.columnWidthPt !== undefined && page.columnSepPt !== undefined && page.columns !== undefined).sort((a, b) => a.page - b.page)
}

function probeArgs(engine: PaperLayoutProbeEngine, probeDir: string): string[] {
  const args = [...engine.args(probeDir)]
  const engineName = `${engine.name ?? ''} ${basename(engine.command)}`
  if (!/tectonic/iu.test(engineName) || args.some(arg => arg === '--keep-logs')) return args
  args.push('--keep-logs')
  return args
}

export async function measurePaperLayout(paperDir: string, options: { engine?: PaperLayoutProbeEngine } = {}): Promise<PaperLayoutMeasurement> {
  const engine = options.engine
  if (!engine) return { status: 'unknown', pages: [], diagnostics: [{ severity: 'error', code: 'ENGINE_UNAVAILABLE', message: 'no LaTeX engine available for layout probe' }] }
  const probeDir = await mkdtemp(join(tmpdir(), 'autoresearch-paper-layout-probe-'))
  try {
    const sourceFiles = await paperCompilationFiles(paperDir)
    for (const source of sourceFiles) {
      const rel = relative(resolve(paperDir), source)
      const target = join(probeDir, rel)
      await mkdir(dirname(target), { recursive: true })
      const bytes = await readFile(source)
      await writeFile(target, rel.toLowerCase() === 'main.tex' ? (probeSource(bytes.toString('utf8')) ?? bytes.toString('utf8')) : bytes)
    }
    const env = engine.env?.()
    const result = spawnSync(engine.command, probeArgs(engine, probeDir), {
      cwd: probeDir,
      encoding: 'utf8',
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    let output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    try { output += `\n${await readFile(join(probeDir, 'main.log'), 'utf8')}` } catch { /* compiler may keep logs elsewhere */ }
    const pages = parseLayoutProbe(output)
    const compilerSucceeded = !result.error && result.status === 0
    const diagnostics = result.error
      ? [{ severity: 'error' as const, code: 'LAYOUT_PROBE_FAILED', message: result.error.message }]
      : result.status !== 0
        ? [{ severity: 'error' as const, code: 'LAYOUT_PROBE_FAILED', message: `layout probe exited with status ${result.status ?? 'unknown'}` }]
        : []
    if (compilerSucceeded && pages.length === 0) diagnostics.push({ severity: 'error', code: 'LAYOUT_PROBE_UNMEASURED', message: 'layout probe produced no page measurements' })
    const measured = compilerSucceeded && pages.length > 0
    return { status: measured ? 'measured' : 'unknown', ...(measured ? { measurementSource: 'tex-probe' as const } : {}), pages: measured ? pages : [], diagnostics }
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
}

export function validatePageGeometry(inspection: PaperPdfInspection, profile?: PaperLayoutProfile): PaperPdfInspection {
  if (!profile) return inspection
  const tolerance = 1
  for (const page of inspection.pages) {
    if (Math.abs(page.widthPt - profile.page.widthPt) > tolerance || Math.abs(page.heightPt - profile.page.heightPt) > tolerance) {
      inspection.issues.push({
        code: 'PAGE_SIZE_MISMATCH',
        severity: 'error',
        page: page.page,
        detail: `measured ${page.widthPt}x${page.heightPt}pt; expected ${profile.page.widthPt}x${profile.page.heightPt}pt`,
      })
    }
  }
  return inspection
}

export function parseCompileDiagnostics(output: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  const add = (severity: CompileDiagnostic['severity'], code: string, message: string, source?: string, line?: number) => {
    const normalizedSource = source?.replace(/^(?:warning|error):\s*/iu, '').trim() || undefined
    const existing = diagnostics.find(diagnostic => diagnostic.severity === severity && diagnostic.code === code && diagnostic.message === message)
    if (existing) {
      if (!existing.source && normalizedSource) existing.source = normalizedSource
      if (existing.line === undefined && line !== undefined) existing.line = line
      return
    }
    diagnostics.push({ severity, code, message, ...(normalizedSource === undefined ? {} : { source: normalizedSource }), ...(line === undefined ? {} : { line }) })
  }
  for (const raw of output.split(/\r?\n/u)) {
    const location = /^(.*?):(\d+):\s*(?:Warning:\s*)?(.*)$/u.exec(raw)
    const source = location?.[1] || undefined
    const line = location ? Number(location[2]) : undefined
    const message = (location?.[3] ?? raw).trim()
    if (/^!\s*LaTeX Error:\s*/u.test(raw) || /^LaTeX Error:/u.test(raw)) add('error', 'LATEX_ERROR', raw.replace(/^!\s*LaTeX Error:\s*/u, '').replace(/^LaTeX Error:\s*/u, '').trim(), source, line)
    else if (/Overfull \\hbox/u.test(raw)) add('warning', 'OVERFULL_HBOX', message, source, line)
    else if (/Overfull \\vbox/u.test(raw)) add('warning', 'OVERFULL_VBOX', message, source, line)
    else if (/Underfull \\hbox/u.test(raw)) add('warning', 'UNDERFULL_HBOX', message, source, line)
    else if (/Underfull \\vbox/u.test(raw)) add('warning', 'UNDERFULL_VBOX', message, source, line)
    else if (/(?:warning:.*(?:float|figure|table)|(?:float|figure|table).*(?:too large|unprocessed)|too many unprocessed floats)/iu.test(raw)) add('warning', 'FLOAT_LAYOUT', message, source, line)
  }
  return diagnostics
}

function pythonCandidates(): string[] { return process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'] }

export async function inspectPaperPdf(paperDir: string, options: InspectPaperPdfOptions = {}): Promise<PaperPdfInspection> {
  const pdfPath = resolve(options.pdfPath ?? join(paperDir, 'main.pdf'))
  let bytes: Buffer
  try { bytes = await readFile(pdfPath) } catch {
    return { schema: 'autoresearch/paper-pdf-inspection/v1', pdfHash: '', pdfPath, pages: [], issues: [{ code: 'PDF_MISSING', severity: 'error', detail: `PDF not found: ${pdfPath}` }], coverage: { complete: false, renderedPages: 0, pageCount: 0, visuallyReviewed: false } }
  }
  const pdfHash = digest(bytes)
  const renderDir = resolve(options.renderDir ?? join(paperDir, '.paper-review', 'render', pdfHash))
  await mkdir(renderDir, { recursive: true })
  const script = fileURLToPath(new URL('../../scripts/inspect-paper-pdf.py', import.meta.url))
  let result: ReturnType<typeof spawnSync> | undefined
  for (const python of pythonCandidates()) {
    result = spawnSync(python, [script, '--pdf', pdfPath, '--render-dir', renderDir], { encoding: 'utf8' })
    if (!result.error) break
  }
  if (!result || result.error || result.status !== 0) {
    const detail = String(result?.stderr ?? '').trim() || result?.error?.message || 'PyMuPDF renderer unavailable'
    return { schema: 'autoresearch/paper-pdf-inspection/v1', pdfHash, pdfPath, pages: [], issues: [{ code: 'RENDERER_UNAVAILABLE', severity: 'error', detail }], coverage: { complete: false, renderedPages: 0, pageCount: 0, visuallyReviewed: false } }
  }
  try {
    const parsed = JSON.parse(String(result.stdout ?? '')) as Omit<PaperPdfInspection, 'pdfHash' | 'pdfPath'>
    const inspection: PaperPdfInspection = { ...parsed, schema: 'autoresearch/paper-pdf-inspection/v1', pdfHash, pdfPath }
    const expected = inspection.pages.length === inspection.coverage.pageCount && inspection.pages.every(page => page.imagePath)
    if (!expected) inspection.coverage.complete = false
    validatePageGeometry(inspection, options.layout)
    await writeFile(join(renderDir, 'inspection.json'), `${JSON.stringify(inspection, null, 2)}\n`, 'utf8')
    return inspection
  } catch (error) {
    return { schema: 'autoresearch/paper-pdf-inspection/v1', pdfHash, pdfPath, pages: [], issues: [{ code: 'RENDERER_OUTPUT_INVALID', severity: 'error', detail: String(error) }], coverage: { complete: false, renderedPages: 0, pageCount: 0, visuallyReviewed: false } }
  }
}
