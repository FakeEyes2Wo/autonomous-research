import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoResearchError } from './errors.js'
import { RESEARCH_TREE_FILE } from './constants.js'
import { atomicWriteJson, newId, readJson, safeResolve } from './utils.js'
import type { ResearchNode, ResearchNodeKind, ResearchNodeStatus } from './types.js'

export interface ResearchTreeQuery {
  id?: string
  kind?: ResearchNodeKind
  status?: ResearchNodeStatus
  parent?: string
}

export class ResearchTree {
  readonly file: string
  nodes: ResearchNode[]

  constructor(file: string, nodes: ResearchNode[] = []) {
    this.file = file
    this.nodes = nodes
  }

  static async load(runDir: string): Promise<ResearchTree> {
    const file = safeResolve(runDir, RESEARCH_TREE_FILE)
    try {
      await access(file)
    } catch {
      return new ResearchTree(file, [])
    }
    const data = await readJson<{ nodes: ResearchNode[] }>(file)
    return new ResearchTree(file, Array.isArray(data.nodes) ? data.nodes : [])
  }

  async save(): Promise<void> {
    await atomicWriteJson(this.file, { schema: 'autoresearch/research-tree/v1', nodes: this.nodes })
  }

  add(kind: ResearchNodeKind, content: string, options: { id?: string; status?: ResearchNodeStatus; parent?: string; artifacts?: string[] } = {}): ResearchNode {
    const id = options.id ?? newId(kind === 'hypothesis' ? 'hyp' : kind === 'action' ? 'act' : 'evi')
    if (this.nodes.some((node) => node.id === id)) {
      throw new AutoResearchError(`duplicate research node id: ${id}`, 'INVALID_ARGUMENT')
    }
    if (options.parent !== undefined && !this.nodes.some((node) => node.id === options.parent)) {
      throw new AutoResearchError(`unknown parent node: ${options.parent}`, 'INVALID_ARGUMENT')
    }
    if (kind === 'action' && options.parent === undefined) {
      throw new AutoResearchError('action node requires a parent hypothesis', 'INVALID_ARGUMENT')
    }
    if (kind === 'evidence' && options.parent === undefined) {
      throw new AutoResearchError('evidence node requires a parent action or hypothesis', 'INVALID_ARGUMENT')
    }
    const node: ResearchNode = {
      id,
      kind,
      status: options.status ?? defaultStatus(kind),
      ...(options.parent !== undefined ? { parent: options.parent } : {}),
      content,
      ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    }
    this.nodes.push(node)
    return node
  }

  update(id: string, patch: Partial<Pick<ResearchNode, 'status' | 'content' | 'artifacts' | 'parent'>>): ResearchNode {
    const node = this.get(id)
    if (patch.parent !== undefined && patch.parent !== node.parent && !this.nodes.some((n) => n.id === patch.parent)) {
      throw new AutoResearchError(`unknown parent node: ${patch.parent}`, 'INVALID_ARGUMENT')
    }
    Object.assign(node, patch)
    return node
  }

  get(id: string): ResearchNode {
    const node = this.nodes.find((n) => n.id === id)
    if (!node) throw new AutoResearchError(`research node not found: ${id}`, 'NOT_FOUND')
    return node
  }

  query(query: ResearchTreeQuery = {}): ResearchNode[] {
    return this.nodes.filter((node) => {
      if (query.id !== undefined && node.id !== query.id) return false
      if (query.kind !== undefined && node.kind !== query.kind) return false
      if (query.status !== undefined && node.status !== query.status) return false
      if (query.parent !== undefined && node.parent !== query.parent) return false
      return true
    })
  }

  toJSON(): { schema: string; nodes: ResearchNode[] } {
    return { schema: 'autoresearch/research-tree/v1', nodes: this.nodes }
  }

  path(): string {
    return join(this.file)
  }
}

function defaultStatus(kind: ResearchNodeKind): ResearchNodeStatus {
  switch (kind) {
    case 'hypothesis':
      return 'proposed'
    case 'action':
      return 'running'
    case 'evidence':
      return 'recorded'
  }
}
