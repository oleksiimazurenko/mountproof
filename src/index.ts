/**
 * Public entry point — re-exports the API surface that opensource consumers
 * import from `@oleksiimazurenko/mountproof`.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type {
  CaptureConfig,
  LegacyTrajectory,
  MountProof,
  ProofContext,
  ProofDiagnostics,
  ProofType,
  Step,
  Trajectory,
  Verdict,
  Viewport,
} from './types.js'

export { VERDICT_EXIT } from './types.js'

// ─── Runner module ──────────────────────────────────────────────────────────
// Mount proof, legacy compat, diff, capture, trajectory, and report all live in
// `src/runner/` and are surfaced through its barrel. The discover module will be
// re-exported here too once it lands (`src/discover/`).

export {
  MountProofError,
  relaxSelector,
  verifyMountProof,
  verifyMountProofBothSides,
  inlineStyleProofs,
  translateLegacy,
  DEV_PROFILE,
  STRICT_PROFILE,
  diffPair,
  formatDiffLine,
  isWrongFrame,
  readDiffReportJson,
  writeDiffReportJson,
  captureAll,
  captureFromFile,
  runTrajectory,
  runTrajectoryFromFile,
  findPairableScreenshots,
  generateReport,
} from './runner/index.js'

export type {
  PageLike,
  DiffMetrics,
  DiffReport,
  WrongFrameReport,
  CaptureFailure,
  CaptureOptions,
  CaptureRecord,
  CaptureReport,
  CaptureTarget,
  TrajectoryEvent,
  TrajectoryRunOptions,
  TrajectoryRunReport,
  ReportOptions,
} from './runner/index.js'

// ─── Discover module ────────────────────────────────────────────────────────
// Static analysis + browser-driven discovery that auto-authors trajectories.
// Curated surface; the full per-phase API lives under `src/discover/`.

export {
  runDiscovery,
  runDrift,
  parseProject,
  buildGraph,
  findRoutesRendering,
  emitDiscovery,
  compareDrift,
  planRediscovery,
} from './discover/index.js'

export type {
  RunDiscoveryOptions,
  RunDiscoveryResult,
  RunDriftOptions,
  RunDriftResult,
  ProjectParse,
  ComponentGraph,
  DiscoveryResult,
  DriftComparison,
} from './discover/index.js'
