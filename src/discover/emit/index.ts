/**
 * Discover · emit layer (Phase D) — public surface.
 *
 * Turn discovery results into version-controllable artifacts:
 *   <out>/trajectories/<name>.json      one per reached component
 *   <out>/trajectories/_unreachable.json + _unreachable.md
 *   <out>/.mountproof/discover-log/<date>.json   attempt trace
 *
 * Trajectory names are made unique across components reachable from multiple
 * routes (`checkout-modal`, `checkout-modal-via-cart`).
 */

import { join } from 'node:path'

import { kebabCase } from '../browse/selector.js'
import type { DiscoveryResult } from '../browse/types.js'
import {
  type EmittedTrajectory,
  type SerializeOptions,
  componentNameOf,
  serializeTrajectory,
} from './serialize.js'
import {
  type UnreachableReport,
  buildUnreachableReport,
  renderUnreachableMarkdown,
} from './unreachable.js'
import {
  type WriteOutcome,
  writeJsonFile,
  writeTextFile,
  writeTrajectoryFile,
} from './write.js'

export {
  type DiscoveryMetadata,
  type EmittedTrajectory,
  type SerializeOptions,
  componentNameOf,
  serializeTrajectory,
  stableStringify,
} from './serialize.js'
export {
  type UnreachableEntry,
  type UnreachableReport,
  buildUnreachableReport,
  renderUnreachableMarkdown,
} from './unreachable.js'
export {
  type WriteOutcome,
  writeJsonFile,
  writeTextFile,
  writeTrajectoryFile,
} from './write.js'

/** Slug for a route path, used to disambiguate multi-route trajectory names. */
function routeSlug(path: string): string {
  if (path === '/') return 'home'
  return (
    path
      .replace(/^\//, '')
      .replace(/\[\.\.\.([^\]]+)\]/g, '$1')
      .replace(/\[([^\]]+)\]/g, '$1')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9-]/gi, '')
      .toLowerCase() || 'route'
  )
}

/** Assign a unique trajectory name per reached result, disambiguating by route. */
function assignNames(reached: DiscoveryResult[]): Map<DiscoveryResult, string> {
  const names = new Map<DiscoveryResult, string>()
  const used = new Set<string>()
  for (const r of reached) {
    const base = kebabCase(componentNameOf(r.componentId))
    let name = base
    if (used.has(name) && r.route) name = `${base}-via-${routeSlug(r.route)}`
    let i = 2
    while (used.has(name)) name = `${base}-${i++}`
    used.add(name)
    names.set(r, name)
  }
  return names
}

export interface EmitOptions extends SerializeOptions {
  /** Output root. Defaults used: <out>/trajectories, <out>/.mountproof. */
  outDir: string
  /** Override the trajectories directory (default `<outDir>/trajectories`). */
  trajectoriesDir?: string
  /** Write the .mountproof/discover-log attempt trace (default true). */
  writeLog?: boolean
  /** Per-component source hashes to stamp for drift detection (Phase E). */
  sourceHashes?: Record<string, string>
}

export interface EmitSummary {
  created: number
  updated: number
  unchanged: number
  trajectories: Array<{ name: string; path: string; outcome: WriteOutcome }>
  unreachable: UnreachableReport
}

/** Write all discovery artifacts to disk and return a summary. */
export function emitDiscovery(results: DiscoveryResult[], opts: EmitOptions): EmitSummary {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const trajectoriesDir = opts.trajectoriesDir ?? join(opts.outDir, 'trajectories')

  const reached = results.filter((r) => r.status === 'reached')
  const names = assignNames(reached)

  const summary: EmitSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    trajectories: [],
    unreachable: buildUnreachableReport(results, generatedAt),
  }

  for (const r of reached) {
    const name = names.get(r) as string
    const traj: EmittedTrajectory = serializeTrajectory(r, {
      generatedAt,
      name,
      sourceHash: opts.sourceHashes?.[r.componentId],
    })
    const path = join(trajectoriesDir, `${name}.json`)
    const outcome = writeTrajectoryFile(path, traj)
    summary[outcome]++
    summary.trajectories.push({ name, path, outcome })
  }

  // Unreachable report (JSON + Markdown), alongside the trajectories.
  writeJsonFile(join(trajectoriesDir, '_unreachable.json'), summary.unreachable)
  writeTextFile(join(trajectoriesDir, '_unreachable.md'), renderUnreachableMarkdown(summary.unreachable))

  // Attempt log for debugging.
  if (opts.writeLog ?? true) {
    const date = generatedAt.slice(0, 10)
    writeJsonFile(join(opts.outDir, '.mountproof', 'discover-log', `${date}.json`), {
      generatedAt,
      results,
    })
  }

  return summary
}
