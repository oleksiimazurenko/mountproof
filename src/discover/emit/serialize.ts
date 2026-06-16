/**
 * Serialize a reached {@link DiscoveryResult} into the public Trajectory JSON
 * shape the runner consumes, plus a `discoveryMetadata` block that records how it
 * was found (for provenance and Phase E drift detection).
 *
 * Output uses stable key ordering so re-emitting an unchanged trajectory produces
 * byte-identical JSON — the basis for the idempotent writer's "skip churn" check.
 */

import type { Trajectory } from '../../types.js'
import { kebabCase } from '../browse/selector.js'
import type { DiscoveryResult, DiscoveryStrategy } from '../browse/types.js'

export interface DiscoveryMetadata {
  /** ISO timestamp the trajectory was generated. */
  generatedAt: string
  /** Graph component id this came from (`file:name`). */
  sourceComponent: string
  /** Strategy that reached the component. */
  strategy: DiscoveryStrategy
  /** How many routes were attempted before success. */
  attempts: number
  /** Selector the component was matched by. */
  matchedSelector?: string
  /** Source hash for drift detection (populated in Phase E). */
  sourceHash?: string
}

/** A Trajectory plus discovery provenance. Extra field; the runner ignores it. */
export interface EmittedTrajectory extends Trajectory {
  discoveryMetadata: DiscoveryMetadata
}

export interface SerializeOptions {
  /** Timestamp to stamp (injectable for deterministic output/tests). */
  generatedAt?: string
  /** Override the trajectory name (else derived from the component name). */
  name?: string
}

/** Component name from a `file:name` id. */
export function componentNameOf(componentId: string): string {
  const idx = componentId.lastIndexOf(':')
  return idx === -1 ? componentId : componentId.slice(idx + 1)
}

/**
 * Convert a reached discovery result into an emitted trajectory.
 * Throws if the result isn't a reached one (callers filter first).
 */
export function serializeTrajectory(
  result: DiscoveryResult,
  opts: SerializeOptions = {},
): EmittedTrajectory {
  if (result.status !== 'reached' || !result.steps) {
    throw new Error(`cannot serialize unreached component ${result.componentId}`)
  }
  const name = opts.name ?? kebabCase(componentNameOf(result.componentId))

  return {
    name,
    target: result.componentId,
    mountProof: result.mountProof,
    steps: result.steps,
    capture: result.matchedSelector
      ? { name, selector: result.matchedSelector }
      : { name },
    discoveryMetadata: {
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      sourceComponent: result.componentId,
      strategy: result.strategy as DiscoveryStrategy,
      attempts: result.attemptLog.length,
      matchedSelector: result.matchedSelector,
    },
  }
}

/**
 * Deterministic JSON stringify with recursively sorted object keys, so semantic
 * equality implies textual equality (clean git diffs, reliable idempotency).
 */
export function stableStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet<object>()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) throw new Error('cannot stableStringify a cyclic value')
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = sort((v as Record<string, unknown>)[key])
    }
    return out
  }
  return JSON.stringify(sort(value), null, indent)
}
