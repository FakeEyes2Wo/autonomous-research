import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** The consuming TeX command, never the filename suffix, determines evidence semantics. */
export interface PaperSourceDependency { path: string; kind: 'manuscript' | 'bibliography'; missing?: boolean }

export async function resolvePaperSources(paperDir: string, options: { allowMissingMain?: boolean; allowMissingDependencies?: boolean } = {}): Promise<PaperSourceDependency[]> {
  const root = await realpath(resolve(paperDir)), files = new Map<string, PaperSourceDependency>()
  const inside = (path: string) => {
    const rel = relative(root, path)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: paper input escapes paper directory')
  }
  const visit = async (path: string, kind: PaperSourceDependency['kind']): Promise<void> => {
    inside(path)
    // Symbolic dependency aliases would otherwise be skipped by the compiler's directory snapshot.
    let actual: string
    try { actual = await realpath(path) } catch (error) {
      if (options.allowMissingDependencies && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        files.set(`${kind}:${path}`, { path, kind, missing: true })
        return
      }
      throw error
    }
    inside(actual)
    if (actual.toLowerCase() !== resolve(path).toLowerCase()) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: materialize symlinked manuscript dependencies')
    const key = `${kind}:${path}`
    if (files.has(key)) return
    const text = await readFile(path, 'utf8')
    if (text.includes('\u0000')) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: manuscript input must be text')
    files.set(key, { path, kind })
    if (kind === 'bibliography') return
    const uncommented = text.replace(/(?<!\\)%[^\r\n]*/g, '')
    if (/\\(?:import|subimport|includefrom|subincludefrom|inputfrom|subinputfrom|InputIfFileExists|inputminted|verbatiminput|lstinputlisting)\b/.test(uncommented)) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: use literal input/include paths for auditable manuscript content')
    const braced = /\\(input|include|subfile|bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g
    const unbraced = /\\input\s+([^\s{}%]+)/g
    const unresolved = uncommented.replace(braced, '').replace(unbraced, '')
    if (/\\(?:input|include|subfile|bibliography|addbibresource)\b/.test(unresolved)) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: dynamic or malformed manuscript input')
    const follow = async (name: string, dependencyKind: PaperSourceDependency['kind']) => {
      if (!name.trim() || /[\\#$]/.test(name)) throw new Error('UNSUPPORTED_SOURCE_DEPENDENCY: paper input cannot be resolved statically: ' + name)
      const target = name.trim() + (extname(name.trim()) ? '' : dependencyKind === 'bibliography' ? '.bib' : '.tex')
      let candidate = resolve(root, target)
      try { await readFile(candidate) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        candidate = resolve(dirname(path), target)
      }
      await visit(candidate, dependencyKind)
    }
    for (const match of uncommented.matchAll(braced)) {
      const dependencyKind = ['bibliography', 'addbibresource'].includes(match[1]!) ? 'bibliography' : 'manuscript'
      for (const name of dependencyKind === 'bibliography' ? match[2]!.split(',') : [match[2]!]) await follow(name, dependencyKind)
    }
    for (const match of uncommented.matchAll(unbraced)) await follow(match[1]!, 'manuscript')
  }
  const main = join(root, 'main.tex')
  if (options.allowMissingMain) {
    try { await readFile(main) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  await visit(main, 'manuscript')
  try { await visit(join(root, 'references.bib'), 'bibliography') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return [...files.values()]
}

export async function readPaperSources(paperDir: string): Promise<string[]> {
  return [...new Set((await resolvePaperSources(paperDir)).map(file => file.path))]
}
