/**
 * Drift comparison. Reads the stored trajectories, recomputes the current source
 * hash for each covered component, and buckets them:
 *
 *   unchanged  — stored hash matches → keep the trajectory as-is
 *   stale      — hash differs → re-discover just this component
 *   orphaned   — component no longer exists → trajectory should be removed/migrated
 *   missing    — component exists in the graph but has no trajectory (uncovered)
 *
 * This is what makes CI cheap: only `stale` (+ optionally `missing`) need the
 * expensive browser pass; everything else is skipped.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectParse } from '../ast/types.js'
import type { ComponentGraph } from '../graph/types.js'
import type { EmittedTrajectory } from '../emit/serialize.js'
import { type FileReader, hashAllComponents } from './hash.js'

export interface DriftEntry {
  /** Trajectory file name (without `.json`). */
  trajectory: string
  /** Component id the trajectory covers. */
  component: string
}

export interface DriftComparison {
  unchanged: DriftEntry[]
  stale: DriftEntry[]
  orphaned: DriftEntry[]
  /** Component ids present in the graph with no trajectory. */
  missing: string[]
}

interface LoadedTrajectory {
  name: string
  component: string
  sourceHash?: string
}

/** Read discover-managed trajectories from a directory (skips `_*` reports). */
function loadTrajectories(trajectoriesDir: string): LoadedTrajectory[] {
  if (!existsSync(trajectoriesDir)) return []
  const out: LoadedTrajectory[] = []
  for (const entry of readdirSync(trajectoriesDir)) {
    if (!entry.endsWith('.json') || entry.startsWith('_')) continue
    try {
      const traj = JSON.parse(readFileSync(join(trajectoriesDir, entry), 'utf8')) as EmittedTrajectory
      const meta = traj.discoveryMetadata
      if (!meta?.sourceComponent) continue // not discover-managed
      out.push({
        name: entry.replace(/\.json$/, ''),
        component: meta.sourceComponent,
        sourceHash: meta.sourceHash,
      })
    } catch {
      // Skip unreadable/corrupt files.
    }
  }
  return out
}

/**
 * Compare stored trajectories against the current source. `readFile` is injectable
 * for testing; defaults to reading from `project.root` via the hasher.
 */
export function compareDrift(
  trajectoriesDir: string,
  project: ProjectParse,
  graph: ComponentGraph,
  readFile?: FileReader,
): DriftComparison {
  const currentHashes = hashAllComponents(project, readFile)
  const loaded = loadTrajectories(trajectoriesDir)

  const comparison: DriftComparison = { unchanged: [], stale: [], orphaned: [], missing: [] }
  const covered = new Set<string>()

  for (const t of loaded) {
    const entry: DriftEntry = { trajectory: t.name, component: t.component }
    if (!graph.nodes.has(t.component)) {
      comparison.orphaned.push(entry)
      continue
    }
    covered.add(t.component)
    const current = currentHashes[t.component]
    if (t.sourceHash && current && t.sourceHash === current) {
      comparison.unchanged.push(entry)
    } else {
      comparison.stale.push(entry)
    }
  }

  for (const id of graph.nodes.keys()) {
    if (!covered.has(id)) comparison.missing.push(id)
  }
  comparison.missing.sort()

  return comparison
}
