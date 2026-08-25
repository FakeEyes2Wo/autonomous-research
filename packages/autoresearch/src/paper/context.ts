import type { RoleExecutionContext } from '../agents/types.js'

/**
 * Filesystem locations relevant to the paper-writing pipeline.
 */
export interface PaperPaths {
  runDir: string
  paperDir: string
}

/**
 * In-memory content passed between paper phases. Every field is derived from
 * the run directory so phases can stay free of ad-hoc positional arguments.
 */
export interface PaperContent {
  planText: string
  matrixText: string
  contractText: string
  figuresLatex: string
  styleProfile?: string
  evidencePath: string
}

/**
 * One paper-writing session: location, already-loaded content, and the agent
 * runtime context. Methods that operate on a paper phase accept this object
 * instead of a long parameter list.
 */
export interface PaperContext {
  paths: PaperPaths
  content: PaperContent
  agentContext: RoleExecutionContext
}
