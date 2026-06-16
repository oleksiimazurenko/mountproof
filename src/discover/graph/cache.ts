/**
 * Graph cache. Building the graph is cheap, but discovery (Phase C) is not — the
 * cache lets later runs skip rebuilding when source hasn't changed, and is the
 * substrate Phase E's drift detection compares against.
 *
 * We hash the Phase A output (the only input to the graph) and persist the graph
 * alongside that hash. A load is valid only if the stored hash matches the
 * current project's hash. Maps are serialized to arrays for JSON portability.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ProjectParse, RouteDef } from '../ast/types.js'
import type { ComponentGraph, ComponentNode, Edge } from './types.js'

const CACHE_REL = join('.mountproof', 'cache', 'graph.json')

/** Deterministic hash of the parse result that fully determines the graph. */
export function hashProject(project: ProjectParse): string {
  const normalized = {
    framework: project.framework,
    files: project.files.map((f) => ({
      file: f.file,
      componentDefs: f.componentDefs,
      componentUsages: f.componentUsages,
      imports: f.imports,
    })),
    routes: project.routes,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

interface SerializedGraph {
  nodes: ComponentNode[]
  edges: Edge[]
  routes: RouteDef[]
}

export function serializeGraph(graph: ComponentGraph): SerializedGraph {
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    routes: [...graph.routes.values()],
  }
}

export function deserializeGraph(data: SerializedGraph): ComponentGraph {
  const nodes = new Map<string, ComponentNode>()
  for (const n of data.nodes) nodes.set(n.id, n)
  const routes = new Map<string, RouteDef>()
  for (const r of data.routes) routes.set(r.path, r)
  return { nodes, edges: data.edges, routes }
}

interface CacheFile {
  version: 1
  hash: string
  graph: SerializedGraph
}

export function cachePath(root: string): string {
  return join(root, CACHE_REL)
}

/** Persist the graph + its source hash under `<root>/.mountproof/cache/`. */
export function saveGraph(root: string, project: ProjectParse, graph: ComponentGraph): void {
  const payload: CacheFile = {
    version: 1,
    hash: hashProject(project),
    graph: serializeGraph(graph),
  }
  const file = cachePath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2))
}

/**
 * Load a cached graph if present AND its stored hash matches `project`'s current
 * hash. Returns null on miss, mismatch, or unreadable/corrupt cache.
 */
export function loadGraph(root: string, project: ProjectParse): ComponentGraph | null {
  const file = cachePath(root)
  if (!existsSync(file)) return null
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as CacheFile
    if (payload.version !== 1) return null
    if (payload.hash !== hashProject(project)) return null
    return deserializeGraph(payload.graph)
  } catch {
    return null
  }
}
