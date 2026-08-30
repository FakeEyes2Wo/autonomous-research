import { safeResolve, IDEA_FILE, INPUT_DIR, PROFILE_FILE, writeText } from '../core/utils.js'

/**
 * Brainstorm path constants and small markdown helpers.
 *
 * Keeping the filesystem layout and the IDEA.md line reader in one dedicated
 * module prevents the pipeline from scattering raw path strings and hand-written
 * markdown parsing across phase methods.
 */
export const BRAINSTORM_DIR = 'brainstorm'
export const PAPER_WIKI_DIR = 'paper_wiki'
export const DEBATE_FILE = 'DEBATE.md'
export const IDEA_FILE_NAME = 'IDEA.md'
export const WIKI_INDEX_FILE = '_index.md'

export const brainstormDirPath = (runDir: string) => safeResolve(runDir, BRAINSTORM_DIR)
export const debatePath = (runDir: string) => safeResolve(runDir, BRAINSTORM_DIR, DEBATE_FILE)
export const ideaPath = (runDir: string) => safeResolve(runDir, BRAINSTORM_DIR, IDEA_FILE_NAME)
export const wikiIndexPath = (runDir: string) => safeResolve(runDir, PAPER_WIKI_DIR, WIKI_INDEX_FILE)
export const paperWikiPath = (runDir: string, id: string) => safeResolve(runDir, PAPER_WIKI_DIR, `${id}.md`)
export const paperWikiRelativePath = (id: string) => `${PAPER_WIKI_DIR}/${id}.md`
export const inputIdeaPath = (runDir: string) => safeResolve(runDir, INPUT_DIR, IDEA_FILE)
export const profilePath = (runDir: string) => safeResolve(runDir, PROFILE_FILE)

/**
 * Structured handoff produced at the end of the brainstorm pre-phase.
 *
 * The previous implementation read input/idea.md back with a regex to rebuild
 * this object. The pipeline now carries this typed object directly into the
 * input writer, so the handoff format is explicit and testable.
 */
export interface IdeaHandoff {
  direction: string
  cheapTest: string
  backups: string[]
}

const DEFAULT_DIRECTION = 'Reformed research direction'
const DEFAULT_CHEAP_TEST = 'Run the minimal validation experiment'

/**
 * Convert the chair's IDEA.md into a structured IdeaHandoff.
 *
 * This is intentionally a small markdown line reader rather than a regex-based
 * reverse parser: it only extracts the fields the old handoff consumed.
 */
export function buildIdeaHandoff(ideaMd: string): IdeaHandoff {
  let direction = DEFAULT_DIRECTION
  let cheapTest: string | undefined
  const backups: string[] = []
  const cheapSectionLines: string[] = []
  let inCheapSection = false

  for (const rawLine of ideaMd.split('\n')) {
    const line = rawLine.trim()

    if (line.startsWith('## ')) {
      if (inCheapSection && line !== '## cheap_test') {
        inCheapSection = false
      }
      if (line === '## cheap_test') {
        inCheapSection = true
        cheapSectionLines.length = 0
      }
      continue
    }

    if (line.startsWith('- direction:')) {
      direction = line.slice('- direction:'.length).trim() || DEFAULT_DIRECTION
    }

    if (line.startsWith('- cheap_test:')) {
      cheapTest = line.slice('- cheap_test:'.length).trim() || DEFAULT_CHEAP_TEST
    }

    if (line.startsWith('- rank 2:')) {
      backups.push(line.slice('- rank 2:'.length).trim())
    }

    if (line.startsWith('- rank 3:')) {
      backups.push(line.slice('- rank 3:'.length).trim())
    }

    if (inCheapSection) {
      cheapSectionLines.push(rawLine)
    }
  }

  if (cheapTest === undefined && cheapSectionLines.length > 0) {
    cheapTest = cheapSectionLines.map((value) => value.trim()).filter(Boolean).join('\n')
  }

  return {
    direction,
    cheapTest: cheapTest ?? DEFAULT_CHEAP_TEST,
    backups,
  }
}

/** Render the unified two-stage paper wiki index. */
export function renderUnifiedWikiIndex(records: readonly import('./paper-record.js').PaperRecord[]): string {
  const rows = records.map((paper) => {
    const place = paper.stage === 'survey'
      ? (paper.clusterId ?? paper.clusterIds?.join(',') ?? '-')
      : (paper.directionId ?? '-')
    return `| ${paper.id} | ${paper.title} | ${paper.role} | ${paper.stage} | ${place} | ${paperWikiRelativePath(paper.id)} |`
  })
  return ['# Paper Wiki Index', '', '| id | title | type | stage | cluster/direction | wiki |', '|---|---|---|---|---|---|', ...rows].join('\n')
}

/** Count chair IDEA.md references to paper wiki files. */
export function countPaperWikiCitations(ideaMd: string): number {
  return (ideaMd.match(/paper_wiki\//g) ?? []).length
}

export interface BrainstormHandoffRequest {
  runDir: string
  handoff: IdeaHandoff
}

/**
 * Write the two handoff files consumed by the research loop:
 * input/idea.md and PROFILE.md.
 */
export async function writeBrainstormHandoff(request: BrainstormHandoffRequest): Promise<void> {
  const { runDir, handoff } = request
  await writeText(inputIdeaPath(runDir), [
    '## Direction', '', handoff.direction, '', '## A-priori ideas', '',
    `- ${handoff.cheapTest}`,
    ...handoff.backups.map((backup) => `- ${backup}`),
    '',
  ].join('\n'))
  await writeText(profilePath(runDir), [
    '# PROFILE', '',
    `- Brainstorm source: ${ideaPath(runDir)}`,
    `- Paper wiki: ${wikiIndexPath(runDir)}`,
    '- Allowed: public literature search, local code, small real-data experiments.',
    '- Forbidden: hidden target papers, fabricated citations or results.',
    '',
  ].join('\n'))
}
