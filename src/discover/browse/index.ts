/**
 * Discover · browse layer (Phase C) — public surface.
 *
 * Drive a browser (or any {@link DiscoveryPage}) to confirm components are
 * reachable and record reproducible trajectories. The Playwright adapter is
 * exported separately so consumers that bring their own page can avoid it.
 */

export type {
  AttemptLogEntry,
  AuthAdapter,
  DiscoverOptions,
  DiscoveryPage,
  DiscoveryResult,
  DiscoveryStrategy,
  UnreachableReason,
} from './types.js'

export { synthesizeSelectors, kebabCase } from './selector.js'
export { findTrigger, type TriggerCandidate } from './trigger.js'
export { suggestMountProof, isEmptyProof } from './proof-suggest.js'
export { attemptRoute, buildUrl, fillRoute } from './attempt.js'
export { discoverComponent, discoverAll, type DiscoverAllOptions } from './executor.js'
export { formLoginAdapter, type FormLoginConfig } from './auth-flow.js'
export { playwrightDiscoveryPage } from './driver-playwright.js'
