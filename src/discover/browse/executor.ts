/**
 * Discovery orchestration. For one component: enumerate the routes that render
 * it (shortest chain first), try each until one reaches the component, and
 * return either a reproducible trajectory or an unreachable verdict with the
 * full attempt trace. `discoverAll` runs the whole graph through the same loop.
 */

import { findRoutesRendering } from '../graph/traverse.js'
import type { ComponentGraph, ComponentId } from '../graph/types.js'
import { attemptRoute } from './attempt.js'
import { synthesizeSelectors } from './selector.js'
import type { DiscoverOptions, DiscoveryPage, DiscoveryResult, UnreachableReason } from './types.js'

/** Discover how to reach a single component, trying its routes shortest-first. */
export async function discoverComponent(
  page: DiscoveryPage,
  graph: ComponentGraph,
  componentId: ComponentId,
  opts: DiscoverOptions,
): Promise<DiscoveryResult> {
  const node = graph.nodes.get(componentId)
  if (!node) {
    return { componentId, status: 'unreachable', reason: 'no-route-renders-component', attemptLog: [] }
  }

  const routes = findRoutesRendering(graph, componentId)
  if (routes.length === 0) {
    return { componentId, status: 'unreachable', reason: 'no-route-renders-component', attemptLog: [] }
  }

  const selectors = synthesizeSelectors(node, opts.selectorOverrides?.[componentId])
  const attemptLog: DiscoveryResult['attemptLog'] = []
  let lastReason: UnreachableReason = 'not-rendered-after-navigate'

  for (const reach of routes) {
    const outcome = await attemptRoute(page, graph, node, reach.routeDef, selectors, opts)
    attemptLog.push(outcome.log)

    if (outcome.result?.status === 'reached') {
      return { componentId, attemptLog, ...outcome.result }
    }
    if (outcome.result?.reason) lastReason = outcome.result.reason
  }

  return { componentId, status: 'unreachable', reason: lastReason, attemptLog }
}

export interface DiscoverAllOptions extends DiscoverOptions {
  /** Restrict discovery to these component ids (default: every node). */
  only?: ComponentId[]
  /** Skip components matching this predicate (e.g. layouts). */
  skip?: (id: ComponentId, graph: ComponentGraph) => boolean
}

/**
 * Discover every component (or a subset) in the graph, sequentially on one page.
 * Returns one result per component, in graph node order.
 */
export async function discoverAll(
  page: DiscoveryPage,
  graph: ComponentGraph,
  opts: DiscoverAllOptions,
): Promise<DiscoveryResult[]> {
  const ids = opts.only ?? [...graph.nodes.keys()]
  const results: DiscoveryResult[] = []
  for (const id of ids) {
    if (opts.skip?.(id, graph)) continue
    results.push(await discoverComponent(page, graph, id, opts))
  }
  return results
}
