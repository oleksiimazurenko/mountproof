/**
 * Public type contract for mountproof trajectories.
 *
 * A Trajectory describes ONE component-level visual check:
 *   - mountProof — the proof that the right code is actually mounted on each side
 *   - steps      — recorded browser interactions to reach the state worth screenshotting
 *   - capture    — what to screenshot (selector or full page) and at which viewports
 */

// ─── Mount proof ────────────────────────────────────────────────────────────

/**
 * A single proof predicate. One of seven discriminated variants — each checks a
 * different kind of artifact in the running page.
 */
export type ProofType =
  /** CSS selector resolves to ≥1 DOM node. */
  | { type: 'domSelector'; selector: string }
  /** Same as domSelector but with a name that reads better for tag-with-attribute proofs (`style[data-href='x']`, `script[src*='y']`). */
  | { type: 'domTag'; selector: string }
  /** Selector resolves AND its textContent includes `text`. */
  | { type: 'domTextContains'; selector: string; text: string }
  /** Some recorded HTTP response URL matches `urlPattern` (regex source) with the given status (defaults to 200). */
  | { type: 'network'; urlPattern: string; status?: number }
  /** Some recorded console line includes `text`. */
  | { type: 'console'; text: string }
  /** `await page.evaluate(script)` returns truthy. */
  | { type: 'eval'; script: string }
  /** Raw HTML of the page contains the substring `text`. */
  | { type: 'htmlContains'; text: string }
  /**
   * Negative proof: the selector resolves to NO node. Use to assert a thing is
   * absent — e.g. a client-side error boundary did not mount. Runs against the
   * live (hydrated) DOM, so it catches crashes that only surface after hydration.
   */
  | { type: 'domAbsent'; selector: string }
  /** Negative proof: the page DOM/HTML does NOT contain the substring `text` (e.g. "Something went wrong"). */
  | { type: 'htmlNotContains'; text: string }
  /**
   * No broken images: every `<img>` (optionally scoped to `within`) has a usable
   * `src`. Fails on missing/empty src or the literal strings `undefined`/`null`
   * and `/undefined`,`/null` path fragments — the classic v4→v5 media-shape bug.
   */
  | { type: 'noBrokenImages'; within?: string }
  /**
   * No error boundary mounted: the page shows none of the error-boundary `phrases`
   * and none of the framework `overlaySelectors` (defaults cover Next.js). A
   * legitimate 404 ("page not found") is treated as an EXPECTED state and passes —
   * it isn't a crash. Auto-applied to every trajectory unless opted out via
   * {@link Trajectory.allowErrorBoundary}; runs against the hydrated DOM so it
   * catches client-side crashes that only surface after hydration.
   */
  | { type: 'noErrorBoundary'; phrases?: string[]; overlaySelectors?: string[] }

/**
 * Mount proof for a trajectory. Both sides are optional and independent:
 * - `baseline` runs against the "old" / "main" side
 * - `target` runs against the "new" / "PR" side
 *
 * Asymmetric proofs are the common case — e.g. only the target carries an
 * `InlineCSS` marker that wasn't in the baseline.
 */
export interface MountProof {
  baseline?: ProofType[]
  target?: ProofType[]
}

// ─── Steps (trajectory body) ────────────────────────────────────────────────

export type Step =
  | { type: 'navigate'; path: string }
  | { type: 'waitForSelector'; selector: string; timeout?: number }
  | { type: 'waitForText'; text: string; timeout?: number }
  | { type: 'waitForUrl'; contains?: string; regex?: string; timeout?: number }
  | { type: 'waitForTimeout'; ms: number }
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'evaluate'; script: string }
  | { type: 'reload' }

// ─── Capture ────────────────────────────────────────────────────────────────

export interface Viewport {
  w: number
  h: number
}

export interface CaptureConfig {
  /** Name used in output filenames. */
  name: string
  /** CSS selector to crop to. Defaults to `body` (full page). */
  selector?: string
  /**
   * Selectors to neutralize before screenshotting (set `visibility:hidden`) so
   * dynamic regions — timestamps, "X min ago", randomized avatars — don't create
   * spurious diffs. Capture-time masking keeps both sides pixel-identical.
   */
  mask?: string[]
}

// ─── Trajectory (top-level) ─────────────────────────────────────────────────

export interface Trajectory {
  name: string
  /** Optional human-readable description of what's being verified. */
  target?: string
  /** Optional longer context paragraph. */
  context?: string
  /** Mount proof — the answer to "did the right code actually load?". */
  mountProof?: MountProof
  /**
   * Opt out of the default `noErrorBoundary` check (auto-applied to every
   * trajectory). Set true only when an error-boundary-like UI is the expected
   * render. Default false → the check runs.
   */
  allowErrorBoundary?: boolean
  /**
   * Optional selector to wait for as the "hydration done" signal before proofs
   * run, in addition to the networkidle settle. Use when a page hydrates a known
   * marker (e.g. `[data-hydrated]`).
   */
  hydrationMarker?: string
  viewports?: Viewport[]
  steps: Step[]
  capture: CaptureConfig
}

/**
 * Legacy Promova format — kept here only for the auto-translator's input type.
 * New trajectories should use `mountProof.target` directly.
 *
 * @deprecated use {@link Trajectory.mountProof} instead
 */
export interface LegacyTrajectory extends Trajectory {
  /**
   * Promova-only: list of `data-href` values whose `<style data-href="X">`
   * tags must be present on the target side. Auto-translated to
   * `mountProof.target: [{ type: 'domTag', selector: "style[data-href='X']" }, …]`.
   */
  assertInlineStyle?: string[]
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/**
 * Verdict for a single (target × viewport) pair after the full pipeline runs.
 *
 * Exit code mapping (used by the CLI):
 *   STRICT_PASS      → 0
 *   PASS             → 1   (passed loose tolerance, failed strict)
 *   FAIL             → 2   (real layout/style regression — pixel diff over threshold)
 *   WRONG_FRAME      → 4   (aspect-ratio mismatch — pairing bug, not CSS bug)
 *   MOUNT_PROOF_FAIL → 5   (proof missing → diff never ran; fix the test before judging)
 *   SCRIPT_ERROR     → 3   (anything else: missing files, can't align sizes, etc.)
 */
export type Verdict =
  | 'STRICT_PASS'
  | 'PASS'
  | 'FAIL'
  | 'WRONG_FRAME'
  | 'MOUNT_PROOF_FAIL'
  | 'SCRIPT_ERROR'

export const VERDICT_EXIT: Record<Verdict, number> = {
  STRICT_PASS: 0,
  PASS: 1,
  FAIL: 2,
  WRONG_FRAME: 4,
  MOUNT_PROOF_FAIL: 5,
  SCRIPT_ERROR: 3,
}

// ─── Mount proof runner context ─────────────────────────────────────────────

/**
 * Side context carried through proof evaluation. The runner records network
 * responses and console messages while steps execute; proofs that need
 * non-DOM evidence consult these arrays.
 */
export interface ProofContext {
  consoleLog: string[]
  requests: Array<{ url: string; status: number }>
}

/** Diagnostic dump emitted when a proof fails — used in error messages. */
export interface ProofDiagnostics {
  pageUrl: string
  /** Up to 5 closest DOM matches (per failed selector). */
  closestMatches: Array<{ proof: ProofType; matches: string[] }>
  /** Top 10 recent network requests (most relevant first). */
  recentRequests: Array<{ url: string; status: number }>
  /** Last 10 console lines. */
  recentConsole: string[]
}
