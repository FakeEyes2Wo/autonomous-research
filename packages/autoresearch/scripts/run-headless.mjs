import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgRoot, '..', '..')
const defaultExample = join(repoRoot, 'examples_articles', 'reliable_conflictive_multi_view_learning')

function parseArgs(argv) {
  const args = {
    profile: 'headless',
    runDir: undefined,
    candidate: join(defaultExample, 'candidate.md'),
    profileFile: join(defaultExample, 'PROFILE.md'),
    maxCycles: 5,
    paper: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--profile': args.profile = argv[++i]; break
      case '--run-dir': args.runDir = argv[++i]; break
      case '--candidate': args.candidate = argv[++i]; break
      case '--profile-file': args.profileFile = argv[++i]; break
      case '--max-cycles': args.maxCycles = Number(argv[++i]); break
      case '--venue': (args.paper ??= {}).venue = argv[++i]; break
      case '--assurance': (args.paper ??= {}).assurance = argv[++i]; break
      case '--effort': (args.paper ??= {}).effort = argv[++i]; break
      case '--illustration': (args.paper ??= {}).illustration = argv[++i]; break
      case '--style-ref': (args.paper ??= {}).styleRef = argv[++i]; break
      case '--auto-proceed': (args.paper ??= {}).autoProceed = argv[++i] !== 'false'; break
      case '--max-improvement-rounds': (args.paper ??= {}).maxImprovementRounds = Number(argv[++i]); break
      case '--human-checkpoint': (args.paper ??= {}).humanCheckpoint = argv[++i] !== 'false'; break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  if (!args.runDir) {
    args.runDir = join(pkgRoot, '.runs', `run-${Date.now()}`)
  }
  return args
}

async function prepareRunDir(runDir, candidatePath, profilePath) {
  await mkdir(join(runDir, 'input'), { recursive: true })
  await cp(candidatePath, join(runDir, 'input', 'candidate.md'), { force: true })
  if (existsSync(profilePath)) {
    await cp(profilePath, join(runDir, 'PROFILE.md'), { force: true })
  } else {
    await writeFile(join(runDir, 'PROFILE.md'), '# PROFILE\n\n- Allowed: local analysis, public search, code, statistics.\n- Forbidden: reading hidden target paper.\n', 'utf8')
  }
  return runDir
}

function normalizePatch(patch) {
  const lines = patch.split(/\r?\n/)
  const withoutEmptyFlow = lines.filter((line) => line.trim() !== '[]')
  let normalized = withoutEmptyFlow.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized.includes('@athena/autoresearch')) {
    const insert = `- insert:\n    - id: autoresearch\n      name: '@athena/autoresearch'`
    normalized = normalized.length === 0 ? insert : `${normalized}\n${insert}`
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

async function ensureHeadlessProfile(profileName) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', profileName)
  const packageJsonPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')

  mkdirSync(profileDir, { recursive: true })

  if (!existsSync(packageJsonPath)) {
    const bundles = profileName === 'headless'
      ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
      : ['@deepseek-ai/dsh-base']
    await writeFile(packageJsonPath, `${JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }, null, 2)}\n`, 'utf8')
  }

  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  pkg.dependencies ??= {}
  if (!pkg.dependencies['@athena/autoresearch']) {
    pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }

  if (!existsSync(patchPath)) {
    await writeFile(patchPath, '# User patch layer\n[]\n', 'utf8')
  }
  let patch = await readFile(patchPath, 'utf8')
  let normalized = normalizePatch(patch)
  if (profileName === 'headless') {
    if (!normalized.includes('pwsh-local')) {
      normalized = normalized.trimEnd() + `\n\n# Use local shell/fs providers to avoid Windows ACL sandbox failures\n- id: pwsh-sandbox\n  disabled: true\n- id: fs-sandbox\n  disabled: true\n- insert:\n    - id: pwsh-local\n      name: '@deepseek-ai/dsh-pwsh-local'\n    - id: fs-local\n      name: '@deepseek-ai/dsh-fs-local'\n`
    }
    if (!normalized.includes('permission\n  disabled: true') && !normalized.includes("permission:\n  disabled: true")) {
      normalized = normalized.trimEnd() + `\n\n# Permission presets require a confining shell; disable when using local providers\n- id: permission\n  disabled: true\n`
    }
  }
  if (normalized !== patch || !normalized.includes('@athena/autoresearch')) {
    await writeFile(patchPath, normalized, 'utf8')
  }

  if (!existsSync(workspacePath)) {
    await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  }

  const comSpec = process.env.ComSpec || 'cmd.exe'
  const pnpm = spawnSync(comSpec, ['/d', '/s', '/c', 'pnpm install'], { cwd: profileDir, stdio: 'inherit' })
  if (pnpm.status !== 0) {
    console.error(`pnpm install failed in ${profileDir}`)
    process.exit(pnpm.status ?? 1)
  }

  return profileDir
}

function findLatexEngine() {
  const candidates = ['xelatex', 'tectonic', 'latexmk', 'pdflatex']
  for (const name of candidates) {
    const probe = spawnSync(name, ['--version'], { stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return name
    if (name === 'latexmk') {
      const probe2 = spawnSync(name, ['-version'], { stdio: 'ignore' })
      if (!probe2.error && probe2.status === 0) return name
    }
  }
  // Fallback: probe known absolute install paths even when the current PATH is stale.
  const knownPaths = [
    'D:\\Tectonic\\bin\\tectonic.exe',
    'C:\\Tectonic\\bin\\tectonic.exe',
    'C:\\Program Files\\Tectonic\\bin\\tectonic.exe',
  ]
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\80163\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const probe = spawnSync('chrome', ['--version'], { stdio: 'ignore' })
  if (!probe.error && probe.status === 0) return 'chrome'
  const edgeProbe = spawnSync('msedge', ['--version'], { stdio: 'ignore' })
  if (!edgeProbe.error && edgeProbe.status === 0) return 'msedge'
  return undefined
}

async function compilePdfWithChromeFallback(runDir, paperDir) {
  const draft = join(runDir, 'paper_draft.md')
  const htmlPath = join(paperDir, 'main.html')
  const pdfPath = join(paperDir, 'main.pdf')

  const pandocHtml = spawnSync('pandoc', [draft, '-o', htmlPath, '--standalone', '--metadata', 'title=Research Paper'], { stdio: 'ignore' })
  if (pandocHtml.error || pandocHtml.status !== 0 || !existsSync(htmlPath)) {
    console.log('[autoresearch] pandoc HTML fallback unavailable; cannot produce PDF without LaTeX bundle.')
    return false
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('[autoresearch] Chrome not found; cannot use HTML->PDF fallback.')
    return false
  }

  console.log(`[autoresearch] trying HTML->PDF fallback with ${chrome} ...`)
  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`
  const chromeArgs = [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    fileUrl,
  ]
  const result = spawnSync(chrome, chromeArgs, { stdio: 'inherit' })
  if (result.status === 0 && existsSync(pdfPath)) {
    console.log(`[autoresearch] PDF (HTML fallback): ${pdfPath}`)
    return true
  }
  console.log('[autoresearch] HTML->PDF fallback failed; main.tex is still available.')
  return false
}

async function compilePaper(runDir) {
  const draft = join(runDir, 'paper_draft.md')
  const paperDir = join(runDir, 'paper')
  mkdirSync(paperDir, { recursive: true })
  const texPath = join(paperDir, 'main.tex')

  if (existsSync(texPath)) {
    console.log(`[autoresearch] using existing LaTeX: ${texPath}`)
  } else if (existsSync(draft)) {
    const pandoc = spawnSync('pandoc', [draft, '-o', texPath, '--standalone'], { stdio: 'ignore' })
    if (pandoc.error || pandoc.status !== 0) {
      // Fallback: wrap the markdown as literal text inside a minimal LaTeX document.
      const content = await readFile(draft, 'utf8')
      await writeFile(texPath, `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\n\\begin{verbatim}\n${content}\n\\end{verbatim}\n\\end{document}\n`, 'utf8')
      console.log('[autoresearch] pandoc unavailable; wrote a minimal main.tex fallback.')
    } else {
      console.log(`[autoresearch] generated LaTeX: ${texPath}`)
    }
  } else {
    console.log('[autoresearch] no paper_draft.md or main.tex found; skip LaTeX generation.')
    return
  }

  const engine = findLatexEngine()
  if (!engine) {
    console.log('[autoresearch] no LaTeX compiler found; trying HTML->PDF fallback...')
    await compilePdfWithChromeFallback(runDir, paperDir)
    return
  }

  const engineName = basename(engine).replace(/\.exe$/i, '')
  console.log(`[autoresearch] compiling with ${engine} ...`)
  let compile
  if (engineName === 'latexmk') {
    compile = spawnSync(engine, ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: paperDir, stdio: 'inherit' })
  } else if (engineName === 'tectonic') {
    // Tectonic downloads its TeX bundle on demand. This machine reaches the
    // Internet through a local proxy; without it the bundle fetch fails/panics.
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    if (!process.env.ALL_PROXY) process.env.ALL_PROXY = 'http://127.0.0.1:7890'
    compile = spawnSync(engine, ['main.tex'], { cwd: paperDir, stdio: 'inherit' })
  } else {
    compile = spawnSync(engine, ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: paperDir, stdio: 'inherit' })
  }
  if (compile.status === 0 && existsSync(join(paperDir, 'main.pdf'))) {
    console.log(`[autoresearch] PDF: ${join(paperDir, 'main.pdf')}`)
  } else {
    console.log('[autoresearch] LaTeX compilation failed; trying HTML->PDF fallback...')
    await compilePdfWithChromeFallback(runDir, paperDir)
  }
}

function buildPrompt(runDir, maxCycles, paper) {
  const absolute = resolve(runDir)
  const lines = [
    'Run the autonomous research loop in the directory below.',
    '',
    `runDir: ${absolute}`,
    `maxCycles: ${maxCycles}`,
    '',
    'Call the `research_run` tool with `runDir` set to that absolute path and `maxCycles` set to the value above.',
  ]
  if (paper && Object.keys(paper).length > 0) {
    lines.push('', `Pass this paper pipeline configuration to research_run as the "paper" argument: ${JSON.stringify(paper)}`)
  }
  lines.push(
    '',
    'Work autonomously until the loop completes. Do not inspect the hidden target paper.',
    'When finished, report the final status and the paths of the produced files (state.json, evidence_chain.json, paper_draft.md, FINAL_REPORT.md or FAILURE_REPORT.md).',
  )
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = resolve(args.runDir)
  await prepareRunDir(runDir, resolve(args.candidate), resolve(args.profileFile))
  console.log(`[autoresearch] run dir: ${runDir}`)
  process.env.DSH_PERMISSION_MODE ??= 'danger-full-access'
  process.env.DSH_AUTORESEARCH_AUTO ??= '1'
  await ensureHeadlessProfile(args.profile)

  const prompt = buildPrompt(runDir, args.maxCycles, args.paper)
  const nodeDir = dirname(process.execPath)
  const dshBin = join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let result
  if (existsSync(dshBin)) {
    result = spawnSync(process.execPath, [dshBin, '--profile', args.profile, prompt], { stdio: 'inherit' })
  } else {
    result = spawnSync('dsh', ['--profile', args.profile, prompt], { stdio: 'inherit', shell: true })
  }
  if (result.error) {
    console.error(`[autoresearch] failed to launch dsh: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[autoresearch] dsh exited with code ${result.status}`)
    process.exit(result.status ?? 1)
  }

  console.log('\n[autoresearch] run finished. Paper pipeline artifacts:')

  console.log('\n[autoresearch] Artifacts:')
  const interesting = [
    'state.json',
    'research_tree.json',
    'evidence_chain.json',
    'paper_draft.md',
    'paper/main.tex',
    'paper/main.pdf',
    'evidence/citations.json',
    'FINAL_REPORT.md',
    'FAILURE_REPORT.md',
  ]
  for (const name of interesting) {
    const file = join(runDir, name)
    if (existsSync(file)) console.log(`  ${name}: ${file}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
