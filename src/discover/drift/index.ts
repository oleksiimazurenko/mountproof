/**
 * Discover · drift layer (Phase E) — public surface.
 *
 * Keep stored trajectories in sync with source without re-running full discovery:
 * hash sources, compare against what trajectories recorded, and plan a selective
 * re-discovery of only what changed.
 */

export type { FileReader } from './hash.js'
export {
  componentFileOf,
  dependencyClosure,
  hashAllComponents,
  hashComponent,
  hashFileClosure,
} from './hash.js'

export type { DriftComparison, DriftEntry } from './compare.js'
export { compareDrift } from './compare.js'

export type { PlanOptions, RediscoveryPlan } from './invalidate.js'
export { hasDrift, planRediscovery } from './invalidate.js'
