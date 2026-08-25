import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../core/utils.js'
import { evidenceIdsFromChain, loadEvidenceChain, type EvidenceChain } from '../export/evidence-chain.js'

export interface AuditResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface AuditPaperInput {
  runDir: string
  chain?: EvidenceChain
  knownEvidenceIds?: string[]
}

async function readTextSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function readPaperSources(paperDir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(paperDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.tex') || entry.name.endsWith('.bib'))) {
      files.push(join(paperDir, entry.name))
    } else if (entry.isDirectory()) {
      const sub = await readdir(join(paperDir, entry.name), { withFileTypes: true }).catch(() => [])
      for (const subEntry of sub) {
        if (subEntry.isFile() && (subEntry.name.endsWith('.tex') || subEntry.name.endsWith('.bib'))) {
          files.push(join(paperDir, entry.name, subEntry.name))
        }
      }
    }
  }
  return files
}

function numericClaimAudit(text: string, knownEvidenceIds: Set<string>): AuditResult {
  // The known-evidence set now comes from the structured evidence_chain.json
  // instead of reloading the whole ResearchTree. The LaTeX regex remains only
  // for locating tags in the source, not for reconstructing the tree.
  const errors: string[] = []
  const lines = text.split('\n')
  const evidenceTagRe = /% evidence:\s*(E-[A-Za-z0-9_]+|B-[A-Za-z0-9_]+)/g
  const numberRe = /\d+\.\d+|\b\d+\b/g

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().startsWith('%')) continue
    const numbers = line.match(numberRe)
    if (!numbers) continue
    const nearby = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join('\n')
    const tags = [...nearby.matchAll(evidenceTagRe)].map((m) => m[1] ?? '').filter(Boolean)
    if (tags.length === 0) {
      errors.push(`line ${i + 1}: numeric value without evidence tag: ${line.trim()}`)
      continue
    }
    for (const tag of tags) {
      if (!knownEvidenceIds.has(tag)) errors.push(`line ${i + 1}: unknown evidence tag ${tag}`)
    }
  }

  for (const match of text.matchAll(evidenceTagRe)) {
    const tag = match[1] ?? ''
    if (tag && !knownEvidenceIds.has(tag)) errors.push(`unknown evidence tag ${tag}`)
  }

  return { ok: errors.length === 0, errors, warnings: [] }
}

function citationAudit(tex: string, bib: string): AuditResult {
  const errors: string[] = []
  const bibKeys = new Set([...bib.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]?.trim() ?? ''))
  const cited = new Set([...tex.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)))
  for (const key of cited) {
    if (!bibKeys.has(key)) errors.push(`citation ${key} is not present in references.bib`)
  }
  return { ok: errors.length === 0, errors, warnings: [] }
}

async function resolveKnownEvidenceIds(runDir: string, chain?: EvidenceChain, knownEvidenceIds?: string[]): Promise<Set<string>> {
  if (knownEvidenceIds) return new Set(knownEvidenceIds)
  if (chain) return new Set(evidenceIdsFromChain(chain))
  try {
    return new Set(evidenceIdsFromChain(await loadEvidenceChain(runDir)))
  } catch {
    return new Set()
  }
}

/**
 * Audit a compiled paper using either the structured EvidenceChain, the
 * evidence_chain.json stored in runDir, or an explicit caller-supplied list.
 */
export async function auditPaper(input: AuditPaperInput): Promise<{ numeric: AuditResult; citation: AuditResult }>
export async function auditPaper(runDir: string, knownEvidenceIds: string[]): Promise<{ numeric: AuditResult; citation: AuditResult }>
export async function auditPaper(inputOrRunDir: AuditPaperInput | string, knownEvidenceIds?: string[]): Promise<{ numeric: AuditResult; citation: AuditResult }> {
  const input: AuditPaperInput = typeof inputOrRunDir === 'string'
    ? { runDir: inputOrRunDir, knownEvidenceIds }
    : inputOrRunDir
  const paperDir = join(input.runDir, 'paper')
  const sources = await readPaperSources(paperDir)
  const texTexts = await Promise.all(sources.filter((f) => f.endsWith('.tex')).map((f) => readTextSafe(f)))
  const bibTexts = await Promise.all(sources.filter((f) => f.endsWith('.bib')).map((f) => readTextSafe(f)))
  const allTex = texTexts.join('\n')
  const allBib = bibTexts.join('\n')
  const known = await resolveKnownEvidenceIds(input.runDir, input.chain, input.knownEvidenceIds)
  const numeric = numericClaimAudit(allTex, known)
  const citation = citationAudit(allTex, allBib)
  const result = { numeric, citation }
  await atomicWriteJson(join(paperDir, 'paper_audit.json'), result)
  return result
}
