import { createRequire } from 'node:module'
import type { PaperRecord } from './paper-record.js'
import { isSurveyPaper } from './paper-record.js'
import { safeResolve, writeText, atomicWriteJson } from '../core/utils.js'

const require = createRequire(import.meta.url)
// These are CommonJS packages; createRequire avoids NodeNext/ESM type friction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Graph = require('graphology') as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forceAtlas2 = require('graphology-layout-forceatlas2') as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const louvain = require('graphology-communities-louvain') as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const betweenness = require('graphology-metrics/centrality/betweenness') as any

export interface KnowledgeCluster {
  id: string
  name: string
  summary?: string
  sourceSurveyIds?: string[]
  openQuestions?: string[]
}

export interface KnowledgeDirection {
  id: string
  name?: string
  statement?: string
  evidence?: string[]
  cheapTest?: string
  risk?: string
}

export interface KnowledgeGraphNode {
  id: string
  type: 'Survey' | 'Cluster' | 'Paper' | 'Direction' | 'OpenProblem'
  label: string
  properties: Record<string, unknown>
}

export interface KnowledgeGraphEdge {
  id: string
  source: string
  target: string
  type:
    | 'SURVEY_COVERS'
    | 'CLUSTER_CONTAINS'
    | 'SURVEY_REVIEWS'
    | 'DIRECTION_BASED_ON'
    | 'OPEN_PROBLEM_IN'
    | 'LATEST_BUILDS_ON'
    | 'SIMILAR_TO'
  properties: Record<string, unknown>
}

export interface PaperKnowledgeGraph {
  schema: 'autoresearch/paper-kg/v1'
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
}

const nodeId = (prefix: string, id: string) => `${prefix}:${id}`
const paperNodeId = (paper: PaperRecord) => nodeId(
  paper.stage === 'survey' && (paper.isSurvey === true || paper.role === 'survey') ? 'survey' : 'paper',
  paper.id,
)

function addNode(
  graph: any,
  id: string,
  type: KnowledgeGraphNode['type'],
  label: string,
  properties: Record<string, unknown>,
): void {
  if (graph.hasNode(id)) return
  graph.addNode(id, { type, label, ...properties })
}

function addEdge(
  graph: any,
  source: string,
  target: string,
  type: KnowledgeGraphEdge['type'],
  properties: Record<string, unknown> = {},
): void {
  if (source === target || !graph.hasNode(source) || !graph.hasNode(target)) return
  if (graph.hasEdge(source, target)) return
  graph.addEdge(source, target, { type, ...properties })
}

/**
 * Build a small directed knowledge graph from normalized paper records,
 * survey clusters, and selected directions.
 */
export function buildPaperKnowledgeGraph(
  records: PaperRecord[],
  clusters: KnowledgeCluster[] = [],
  directions: KnowledgeDirection[] = [],
): PaperKnowledgeGraph {
  const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false })

  // Cluster nodes
  for (const cluster of clusters) {
    addNode(graph, nodeId('cluster', cluster.id), 'Cluster', cluster.name, {
      summary: cluster.summary ?? '',
      sourceSurveyIds: cluster.sourceSurveyIds ?? [],
      openQuestions: cluster.openQuestions ?? [],
    })
  }

  // Direction nodes
  for (const direction of directions) {
    addNode(graph, nodeId('direction', direction.id), 'Direction', direction.name ?? direction.id, {
      statement: direction.statement ?? '',
      evidence: direction.evidence ?? [],
      cheapTest: direction.cheapTest ?? '',
      risk: direction.risk ?? '',
    })
  }

  // Paper / Survey nodes
  for (const paper of records) {
    const isSurvey = isSurveyPaper(paper) && (paper.isSurvey === true || paper.role === 'survey')
    addNode(graph, paperNodeId(paper), isSurvey ? 'Survey' : 'Paper', paper.title, {
      id: paper.id,
      stage: paper.stage,
      role: paper.role,
      year: paper.year ?? '',
      venue: paper.venue ?? '',
      url: paper.url ?? '',
      arxivId: paper.arxivId ?? '',
      doi: paper.doi ?? '',
      clusterId: paper.stage === 'survey' ? (paper.clusterId ?? '') : '',
      directionId: paper.stage === 'latest' ? paper.directionId : '',
      oneLiner: paper.oneLiner,
      keyFinding: paper.keyFinding,
      weakness: paper.weakness,
      implication: paper.implication,
      isSurvey,
    })
  }

  const paperNodeIds = new Map<string, string>()
  for (const paper of records) {
    paperNodeIds.set(paper.id, paperNodeId(paper))
  }

  // Edges: survey/review/paper/cluster relationships
  for (const paper of records) {
    const source = paperNodeId(paper)

    if (paper.stage === 'survey') {
      const clusterIds = paper.clusterIds ?? (paper.clusterId ? [paper.clusterId] : [])
      for (const clusterId of clusterIds) {
        const target = nodeId('cluster', clusterId)
        if (graph.hasNode(target)) {
          addEdge(graph, source, target, 'SURVEY_COVERS', { sourceStage: 'survey' })
          addEdge(graph, target, source, 'CLUSTER_CONTAINS', { sourceStage: 'survey' })
        }
      }

      if (paper.isSurvey) {
        for (const route of records) {
          if (route.id === paper.id) continue
          if ((route.stage === 'survey' && route.sourceSurveyIds.includes(paper.id)) ||
              (route.stage === 'latest' && route.sourceSurveyIds?.includes(paper.id))) {
            addEdge(graph, source, paperNodeId(route), 'SURVEY_REVIEWS')
          }
        }
      }
    }

    if (paper.stage === 'survey' && paper.clusterId) {
      addEdge(graph, nodeId('cluster', paper.clusterId), source, 'CLUSTER_CONTAINS')
    }

    if (paper.stage === 'latest') {
      for (const surveyId of paper.sourceSurveyIds ?? []) {
        const target = paperNodeIds.get(surveyId)
        if (target) addEdge(graph, source, target, 'LATEST_BUILDS_ON')
      }
    }
  }

  // Open-problem nodes + edges
  let problemIndex = 0
  for (const cluster of clusters) {
    for (const question of cluster.openQuestions ?? []) {
      problemIndex += 1
      const problemId = nodeId('problem', `p${String(problemIndex).padStart(3, '0')}`)
      addNode(graph, problemId, 'OpenProblem', question, {
        clusterId: cluster.id,
        question,
      })
      addEdge(graph, nodeId('cluster', cluster.id), problemId, 'OPEN_PROBLEM_IN')
    }
  }

  // Direction evidence edges
  for (const direction of directions) {
    const directionNode = nodeId('direction', direction.id)
    for (const evidence of direction.evidence ?? []) {
      const cleaned = evidence.trim().replace(/^paper_wiki\//, '').replace(/\.md$/, '')
      const possibleTargets = [
        nodeId('paper', cleaned),
        nodeId('survey', cleaned),
        nodeId('cluster', cleaned),
        nodeId('direction', cleaned),
        cleaned.startsWith('paper:') ? cleaned : null,
        cleaned.startsWith('survey:') ? cleaned : null,
        cleaned.startsWith('cluster:') ? cleaned : null,
      ].filter((id): id is string => Boolean(id))
      for (const target of possibleTargets) {
        if (graph.hasNode(target)) {
          addEdge(graph, directionNode, target, 'DIRECTION_BASED_ON')
          break
        }
      }
    }
  }

  // Layout + analytics (cosmetic/optional; failures must not break the pipeline)
  try {
    forceAtlas2.assign(graph, { iterations: 100, settings: { gravity: 0.2, scalingRatio: 10 } })
  } catch {
    // ignore
  }
  try {
    const communities = louvain(graph)
    for (const node of graph.nodes()) {
      graph.setNodeAttribute(node, 'community', communities[node] ?? 0)
    }
  } catch {
    // ignore
  }
  try {
    const centrality = betweenness(graph, { normalized: true })
    for (const node of graph.nodes()) {
      graph.setNodeAttribute(node, 'betweenness', centrality[node] ?? 0)
    }
  } catch {
    // ignore
  }

  const nodes: KnowledgeGraphNode[] = graph.nodes().map((id: string): KnowledgeGraphNode => {
    const attrs = graph.getNodeAttributes(id) as Record<string, unknown>
    return {
      id,
      type: (attrs.type as KnowledgeGraphNode['type']) ?? 'Paper',
      label: (attrs.label as string) ?? id,
      properties: { ...attrs },
    }
  })

  const edges: KnowledgeGraphEdge[] = graph.edges().map((id: string): KnowledgeGraphEdge => {
    const attrs = graph.getEdgeAttributes(id) as Record<string, unknown>
    return {
      id,
      source: graph.source(id),
      target: graph.target(id),
      type: (attrs.type as KnowledgeGraphEdge['type']) ?? 'SIMILAR_TO',
      properties: { ...attrs },
    }
  })

  return { schema: 'autoresearch/paper-kg/v1', nodes, edges }
}

/** Build a compact markdown summary useful as LLM context. */
export function buildKnowledgeGraphSummary(kg: PaperKnowledgeGraph): string {
  const surveyNodes = kg.nodes.filter((node) => node.type === 'Survey')
  const clusterNodes = kg.nodes.filter((node) => node.type === 'Cluster')
  const paperNodes = kg.nodes.filter((node) => node.type === 'Paper')
  const directionNodes = kg.nodes.filter((node) => node.type === 'Direction')
  const problemNodes = kg.nodes.filter((node) => node.type === 'OpenProblem')

  const lines = [
    '# Paper Knowledge Graph Summary',
    '',
    `- nodes: ${kg.nodes.length}`,
    `- edges: ${kg.edges.length}`,
    `- surveys: ${surveyNodes.length}`,
    `- clusters: ${clusterNodes.length}`,
    `- papers: ${paperNodes.length}`,
    `- directions: ${directionNodes.length}`,
    `- open problems: ${problemNodes.length}`,
    '',
    '## Clusters',
    '',
  ]

  for (const cluster of clusterNodes) {
    const label = cluster.label
    const questions = (cluster.properties.openQuestions as string[] | undefined) ?? []
    lines.push(`- ${label}${questions.length > 0 ? ` — open: ${questions.join('; ')}` : ''}`)
  }

  lines.push('', '## Surveys', '')
  for (const survey of surveyNodes) {
    lines.push(`- ${survey.label} (${String(survey.properties.year ?? '')})`)
  }

  lines.push('', '## Directions', '')
  for (const direction of directionNodes) {
    lines.push(`- ${direction.label}: ${String(direction.properties.statement ?? '')}`)
  }

  return `${lines.join('\n')}\n`
}

/** Build a self-contained HTML page using Cytoscape.js from a CDN. */
export function buildKnowledgeGraphHtml(kg: PaperKnowledgeGraph): string {
  const escaped = JSON.stringify(kg).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>Paper Knowledge Graph</title>
<style>
  html, body, #cy { width: 100%; height: 100%; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; }
</style>
<script src="https://unpkg.com/cytoscape@3.34.2/dist/cytoscape.min.js"></script>
</head>
<body>
<div id="cy"></div>
<script>
  const kg = ${escaped};
  const elements = [];
  const colors = {
    Survey: '#e11d48',
    Cluster: '#2563eb',
    Paper: '#16a34a',
    Direction: '#d97706',
    OpenProblem: '#7c3aed'
  };
  for (const node of kg.nodes) {
    elements.push({ data: { id: node.id, label: node.label, type: node.type } });
  }
  for (const edge of kg.edges) {
    elements.push({ data: { id: edge.id, source: edge.source, target: edge.target, type: edge.type } });
  }
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'label': 'data(label)',
          'background-color': 'data(type)',
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'font-size': '10px',
          'width': 'mapData(betweenness, 0, 0.5, 20, 60)',
          'height': 'mapData(betweenness, 0, 0.5, 20, 60)'
        }
      },
      {
        selector: 'edge',
        style: {
          'width': 1,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7,
          'line-color': '#94a3b8'
        }
      }
    ],
    layout: { name: 'cose', animate: false, randomize: true }
  });
</script>
</body>
</html>
`
}

export interface KnowledgeGraphPaths {
  json: string
  html: string
  summary: string
}

export function knowledgeGraphPaths(runDir: string): KnowledgeGraphPaths {
  return {
    json: safeResolve(runDir, 'paper_wiki', 'kg', 'kg.json'),
    html: safeResolve(runDir, 'paper_wiki', 'kg', 'kg.html'),
    summary: safeResolve(runDir, 'paper_wiki', 'kg', 'SUMMARY.md'),
  }
}

export async function writePaperKnowledgeGraph(runDir: string, kg: PaperKnowledgeGraph): Promise<KnowledgeGraphPaths> {
  const paths = knowledgeGraphPaths(runDir)
  await atomicWriteJson(paths.json, kg)
  await writeText(paths.html, buildKnowledgeGraphHtml(kg))
  await writeText(paths.summary, buildKnowledgeGraphSummary(kg))
  return paths
}
