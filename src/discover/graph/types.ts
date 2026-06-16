/**
 * Component-graph data shapes (Phase B).
 *
 * Phase A produces `ParsedFile[]` + `RouteDef[]`; this layer glues them into one
 * queryable graph. Nodes are components, edges are `<Child/>` render relations,
 * and routes index the page-level entry points. The headline query the runner
 * cares about is "every route that renders component X" — `findRoutesRendering`.
 *
 * Edges reference nodes by `id` (not by object) so the whole graph serializes to
 * JSON cleanly for the Phase B cache.
 */

import type { ConditionalKind, Framework, RouteDef } from '../ast/types.js'

/** Stable component identity: `<root-relative-file>:<name>`. */
export type ComponentId = string

/** Best-effort behavioural metadata used by discovery planning. */
export interface ComponentMetadata {
  /** Reachable only behind an auth wall (auth hook/wrapper detected). */
  authGated: boolean
  /** Reachable only with a paid entitlement (premium hook/wrapper detected). */
  premiumGated: boolean
  /** Rendered as a modal/overlay (structural or path heuristic). */
  isModal: boolean
  /** Code-split / dynamically imported. Best-effort; see annotate.ts. */
  isLazy: boolean
  /** Rendering technology of the component. */
  framework: 'react' | 'vue' | 'svelte' | 'astro'
}

export interface ComponentNode {
  id: ComponentId
  file: string
  name: string
  exported: boolean
  /** True if this is a page-level component backing a route. */
  isRouteRoot: boolean
  metadata: ComponentMetadata
}

export interface Edge {
  /** Parent component id (renders the child). */
  from: ComponentId
  /** Child component id (being rendered). */
  to: ComponentId
  conditional: ConditionalKind
  /** Best-effort: state/prop variable that gates a conditional child (Phase C). */
  triggerProp?: string
  /** Best-effort: CSS selector that toggles the child (Phase C). */
  triggerSelector?: string
}

export interface ComponentGraph {
  nodes: Map<ComponentId, ComponentNode>
  edges: Edge[]
  /** Route path → its page route definition. */
  routes: Map<string, RouteDef>
}

/** One way a route reaches a target component, with the component chain taken. */
export interface RouteReachability {
  /** Route path the chain starts from (e.g. `/products/[id]`). */
  route: string
  /** Component ids from route root → target (inclusive). */
  chain: ComponentId[]
  /** Edges traversed, in order (chain.length - 1 entries). */
  edges: Edge[]
  /** Route definition for convenience. */
  routeDef: RouteDef
}

export type { Framework }
