/**
 * Trigger detection. A modal/overlay isn't rendered on navigation — something
 * has to toggle it. We walk the graph backwards from the target to the parents
 * that conditionally render it, and propose a selector to click.
 *
 * Phase B doesn't yet resolve the exact handler→element wiring, so generated
 * candidates are best-effort name heuristics (low confidence). Explicit
 * overrides and any edge-level `triggerSelector` (high confidence) win.
 */

import type { ComponentGraph, ComponentId } from '../graph/types.js'
import { kebabCase } from './selector.js'

export interface TriggerCandidate {
  /** Selector to click to reveal the target. */
  selector: string
  confidence: 'high' | 'low'
  /** Parent component id the trigger was inferred from. */
  via: ComponentId
}

const GATING = new Set(['ternary', 'logical-and', 'if-block'])

/**
 * Best trigger candidate to reveal `componentId`, or null if none can be guessed.
 * Preference: explicit override → edge-level selector → name-derived guess.
 */
export function findTrigger(
  graph: ComponentGraph,
  componentId: ComponentId,
  override?: string,
): TriggerCandidate | null {
  const incoming = graph.edges.filter((e) => e.to === componentId)
  const gatingEdges = incoming.filter((e) => GATING.has(e.conditional))

  // An explicit override is attributed to the nearest gating parent (or any parent).
  const primary = gatingEdges[0] ?? incoming[0]
  if (override) {
    return { selector: override, confidence: 'high', via: primary?.from ?? componentId }
  }

  // Edge already carries a resolved selector (future Phase C wiring).
  const withSelector = gatingEdges.find((e) => e.triggerSelector)
  if (withSelector?.triggerSelector) {
    return { selector: withSelector.triggerSelector, confidence: 'high', via: withSelector.from }
  }

  if (gatingEdges.length === 0) return null

  // Name-derived guess: a button that opens the target.
  const node = graph.nodes.get(componentId)
  const kebab = node ? kebabCase(node.name) : ''
  if (!kebab) return null
  return {
    selector: `[data-test-id="open-${kebab}"]`,
    confidence: 'low',
    via: gatingEdges[0].from,
  }
}
