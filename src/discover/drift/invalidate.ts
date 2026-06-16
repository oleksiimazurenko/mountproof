/**
 * Turn a {@link DriftComparison} into an actionable plan: which components to
 * re-discover, which orphaned trajectory files to remove, and how much work was
 * skipped. The CLI executes the plan (re-run discovery on `rediscover`, delete
 * `deleteOrphans`); this module stays pure so it's trivially testable.
 */

import type { DriftComparison } from './compare.js'

export interface RediscoveryPlan {
  /** Component ids to run discovery on again. */
  rediscover: string[]
  /** Trajectory names whose component is gone — safe to delete. */
  deleteOrphans: string[]
  /** Count of trajectories left untouched (unchanged). */
  skipped: number
}

export interface PlanOptions {
  /** Also re-discover components that have no trajectory yet. Default false. */
  includeMissing?: boolean
}

export function planRediscovery(
  comparison: DriftComparison,
  opts: PlanOptions = {},
): RediscoveryPlan {
  const rediscover = [
    ...comparison.stale.map((e) => e.component),
    ...(opts.includeMissing ? comparison.missing : []),
  ]
  return {
    rediscover: [...new Set(rediscover)].sort(),
    deleteOrphans: comparison.orphaned.map((e) => e.trajectory).sort(),
    skipped: comparison.unchanged.length,
  }
}

/** True if anything needs doing (stale, orphaned, or — if asked — missing). */
export function hasDrift(comparison: DriftComparison, includeMissing = false): boolean {
  return (
    comparison.stale.length > 0 ||
    comparison.orphaned.length > 0 ||
    (includeMissing && comparison.missing.length > 0)
  )
}
