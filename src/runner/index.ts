/**
 * Runner module barrel — re-exports every runtime symbol the runner provides.
 * Consumed by the package's public entry point (`src/index.ts`) and by the CLI.
 * The discover module (`src/discover/`) is a sibling that shares `src/types.ts`.
 */

// ─── Mount proof core ───────────────────────────────────────────────────────

export {
  MountProofError,
  relaxSelector,
  verifyMountProof,
  verifyMountProofBothSides,
} from './mount-proof.js'

export type { PageLike } from './mount-proof.js'

// ─── Legacy compat (Promova format) ─────────────────────────────────────────

export { inlineStyleProofs, translateLegacy } from './legacy-translate.js'

// ─── Diff engine ────────────────────────────────────────────────────────────

export {
  DEV_PROFILE,
  STRICT_PROFILE,
  diffPair,
  formatDiffLine,
  isWrongFrame,
  readDiffReportJson,
  writeDiffReportJson,
} from './diff.js'

export type { DiffMetrics, DiffReport, WrongFrameReport } from './diff.js'

// ─── Capture engine ─────────────────────────────────────────────────────────

export { captureAll, captureFromFile } from './capture.js'

export type {
  CaptureFailure,
  CaptureOptions,
  CaptureRecord,
  CaptureReport,
  CaptureTarget,
} from './capture.js'

// ─── Trajectory engine ──────────────────────────────────────────────────────

export { runTrajectory, runTrajectoryFromFile } from './trajectory.js'

export type {
  TrajectoryEvent,
  TrajectoryRunOptions,
  TrajectoryRunReport,
} from './trajectory.js'

// ─── Report ─────────────────────────────────────────────────────────────────

export { findPairableScreenshots, generateReport } from './report.js'
export type { ReportOptions } from './report.js'
