/**
 * Graph queries. The headline one is {@link findRoutesRendering}: given a
 * component, which routes render it and by what component chain. Discovery uses
 * the shortest chain per route as the easiest path to drive in a browser.
 */

import type { ComponentGraph, ComponentId, Edge, RouteReachability } from './types.js'

/** Build a from→edges adjacency map for traversal. */
function adjacency(graph: ComponentGraph): Map<ComponentId, Edge[]> {
  const adj = new Map<ComponentId, Edge[]>()
  for (const edge of graph.edges) {
    const list = adj.get(edge.from)
    if (list) list.push(edge)
    else adj.set(edge.from, [edge])
  }
  return adj
}

/**
 * BFS from `rootId` to `targetId`, returning the shortest edge chain (or null).
 * BFS guarantees the first time we reach the target it's via a shortest path.
 */
function shortestChain(
  adj: Map<ComponentId, Edge[]>,
  rootId: ComponentId,
  targetId: ComponentId,
): Edge[] | null {
  if (rootId === targetId) return []
  const queue: ComponentId[] = [rootId]
  const visited = new Set<ComponentId>([rootId])
  /** node → the edge we arrived by (for path reconstruction). */
  const cameBy = new Map<ComponentId, Edge>()

  while (queue.length > 0) {
    const current = queue.shift() as ComponentId
    for (const edge of adj.get(current) ?? []) {
      if (visited.has(edge.to)) continue
      visited.add(edge.to)
      cameBy.set(edge.to, edge)
      if (edge.to === targetId) {
        // Reconstruct chain of edges root → target.
        const chain: Edge[] = []
        let step: ComponentId | undefined = targetId
        while (step && step !== rootId) {
          const e = cameBy.get(step)
          if (!e) break
          chain.unshift(e)
          step = e.from
        }
        return chain
      }
      queue.push(edge.to)
    }
  }
  return null
}

/**
 * Every route that renders `componentId`, each with the shortest component chain
 * from the route's page root to the target. Sorted by chain length (shortest =
 * easiest to reach in a browser), then by route path for stability.
 */
export function findRoutesRendering(
  graph: ComponentGraph,
  componentId: ComponentId,
): RouteReachability[] {
  if (!graph.nodes.has(componentId)) return []
  const adj = adjacency(graph)
  const results: RouteReachability[] = []

  for (const [path, routeDef] of graph.routes) {
    if (!routeDef.component) continue
    const rootId = `${routeDef.file}:${routeDef.component}`
    if (!graph.nodes.has(rootId)) continue

    const chainEdges = shortestChain(adj, rootId, componentId)
    if (chainEdges === null) continue

    const chain: ComponentId[] = [rootId, ...chainEdges.map((e) => e.to)]
    results.push({ route: path, chain, edges: chainEdges, routeDef })
  }

  results.sort((a, b) => a.chain.length - b.chain.length || a.route.localeCompare(b.route))
  return results
}

/** All component ids reachable from a route path (its page root included). */
export function reachableFromRoute(graph: ComponentGraph, routePath: string): Set<ComponentId> {
  const reached = new Set<ComponentId>()
  const routeDef = graph.routes.get(routePath)
  if (!routeDef?.component) return reached
  const rootId = `${routeDef.file}:${routeDef.component}`
  if (!graph.nodes.has(rootId)) return reached

  const adj = adjacency(graph)
  const queue: ComponentId[] = [rootId]
  reached.add(rootId)
  while (queue.length > 0) {
    const current = queue.shift() as ComponentId
    for (const edge of adj.get(current) ?? []) {
      if (reached.has(edge.to)) continue
      reached.add(edge.to)
      queue.push(edge.to)
    }
  }
  return reached
}

/** Components the graph believes are rendered by NO route (orphans / dead UI). */
export function unreachableComponents(graph: ComponentGraph): ComponentId[] {
  const reachable = new Set<ComponentId>()
  for (const path of graph.routes.keys()) {
    for (const id of reachableFromRoute(graph, path)) reachable.add(id)
  }
  const orphans: ComponentId[] = []
  for (const id of graph.nodes.keys()) {
    if (!reachable.has(id)) orphans.push(id)
  }
  return orphans.sort()
}
