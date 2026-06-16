/**
 * Browser-driven discovery shapes (Phase C).
 *
 * The executor is written against {@link DiscoveryPage} — a minimal browser
 * abstraction — so the whole state machine (direct → auth → trigger) is
 * unit-testable with a scripted fake page. The real Playwright implementation is
 * a thin adapter (driver-playwright.ts) that isn't part of the unit suite.
 */

import type { MountProof, Step } from '../../types.js'
import type { RouteDef } from '../ast/types.js'

/** The browser operations the discovery executor needs. */
export interface DiscoveryPage {
  /** Navigate; resolve with the URL actually landed on (after redirects). */
  goto(url: string): Promise<{ finalUrl: string }>
  /** Wait up to `timeoutMs` for a selector to appear; resolve true if it did. */
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>
  /** Click an element by selector. */
  click(selector: string): Promise<void>
  /** Fill a form field by selector. */
  fill(selector: string, value: string): Promise<void>
  /** Current URL without navigating. */
  currentUrl(): string
}

/** Pluggable authentication, invoked when discovery hits a login wall. */
export interface AuthAdapter {
  /** Decide whether a landed URL is a login/redirect wall. */
  isLoginUrl(url: string): boolean
  /** Perform the login flow on the page (fill form, submit, set cookies, …). */
  login(page: DiscoveryPage): Promise<void>
}

/** How a component ended up being reached (or why it wasn't). */
export type DiscoveryStrategy =
  | 'direct'
  | 'auth+direct'
  | 'trigger'
  | 'auth+trigger'

export type UnreachableReason =
  | 'no-route-renders-component'
  | 'auth-required'
  | 'not-rendered-after-navigate'
  | 'no-trigger'
  | 'trigger-clicked-but-not-rendered'
  | 'navigation-error'

/** One line of the attempt log — useful for debugging discovery failures. */
export interface AttemptLogEntry {
  route: string
  strategyTried: DiscoveryStrategy | 'direct-after-auth'
  outcome: 'reached' | 'failed'
  detail?: string
}

/** Result of trying to discover one component. */
export interface DiscoveryResult {
  componentId: string
  status: 'reached' | 'unreachable'
  /** Set when reached. */
  strategy?: DiscoveryStrategy
  /** Route the component was reached on (when reached). */
  route?: string
  /** Steps to reproduce reaching it (when reached). */
  steps?: Step[]
  /** Suggested mount proof for the trajectory (when reached). */
  mountProof?: MountProof
  /** Selector the component was matched by (when reached). */
  matchedSelector?: string
  /** Set when unreachable. */
  reason?: UnreachableReason
  /** Per-route attempt trace. */
  attemptLog: AttemptLogEntry[]
}

export interface DiscoverOptions {
  /** Base URL of the running app, e.g. `http://localhost:3000`. */
  baseUrl: string
  /** Optional auth adapter; without it, login walls mark the component auth-required. */
  auth?: AuthAdapter
  /** Values to fill dynamic route segments with (`{ id: '1' }`). */
  paramValues?: Record<string, string>
  /** Per-selector wait budget in ms (default 8000). */
  waitTimeoutMs?: number
  /** Explicit selector overrides per component id. */
  selectorOverrides?: Record<string, string[]>
  /** Explicit trigger selector overrides per component id. */
  triggerOverrides?: Record<string, string>
}

export type { RouteDef }
