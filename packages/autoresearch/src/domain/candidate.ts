import { AutoResearchError } from '../core/utils.js'
import { readText, safeResolve } from '../core/utils.js'

export interface Candidate {
  direction: string
  aPrioriIdeas: string[]
  raw: string
}

export async function readCandidate(runDir: string, candidatePath?: string): Promise<Candidate> {
  const file = candidatePath ? safeResolve(runDir, candidatePath) : safeResolve(runDir, 'input', 'candidate.md')
  const raw = await readText(file)
  const directionMatch = raw.match(/^##\s+Direction\s*$/mi)
  if (!directionMatch) {
    throw new AutoResearchError('candidate.md is missing a Direction section', 'INVALID_ARGUMENT')
  }
  const after = raw.slice((directionMatch.index ?? 0) + directionMatch[0].length)
  const ideasMatch = raw.match(/^##\s+A-priori ideas.*$/mi)
  const direction = after.split(/^##\s+/m)[0]?.trim() ?? ''
  if (!direction) throw new AutoResearchError('candidate direction is empty', 'INVALID_ARGUMENT')
  let aPrioriIdeas: string[] = []
  if (ideasMatch && ideasMatch.index !== undefined) {
    const ideasBlock = raw.slice(ideasMatch.index + ideasMatch[0].length)
    const nextHeading = ideasBlock.search(/^##\s+/m)
    const block = nextHeading >= 0 ? ideasBlock.slice(0, nextHeading) : ideasBlock
    aPrioriIdeas = block
      .split('\n')
      .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean)
  }
  return { direction, aPrioriIdeas, raw }
}
