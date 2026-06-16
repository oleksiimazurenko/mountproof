/**
 * Discover · graph layer (Phase B) — public surface.
 *
 * Build a queryable component graph from Phase A output, ask it which routes
 * render a component, and cache it between runs.
 */

export type {
  ComponentGraph,
  ComponentId,
  ComponentMetadata,
  ComponentNode,
  Edge,
  RouteReachability,
} from './types.js'

export { buildGraph, componentId } from './builder.js'
export { annotateGraph } from './annotate.js'
export {
  findRoutesRendering,
  reachableFromRoute,
  unreachableComponents,
} from './traverse.js'
export {
  cachePath,
  deserializeGraph,
  hashProject,
  loadGraph,
  saveGraph,
  serializeGraph,
} from './cache.js'
