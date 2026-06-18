/**
 * Trajectory engine — executes a recorded multi-step flow on one
 * environment, verifies mount proof, then captures the target component.
 *
 * Pipeline per viewport:
 *   1. Open a new page; record console + network into per-side context.
 *   2. Execute every `step` in order (navigate, click, waitFor, …).
 *   3. Run `verifyMountProof` for `side` — fail fast on MOUNT_PROOF_FAIL.
 *   4. Screenshot the `capture.selector` (or full page if absent).
 *
 * The same trajectory file runs on BOTH baseline and target; each side
 * gets its own asymmetric `mountProof.{baseline,target}` from the JSON.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'

import { MountProofError, verifyMountProof } from './mount-proof.js'
import type { PageLike } from './mount-proof.js'
import { translateLegacy } from './legacy-translate.js'
import type {
  CaptureConfig,
  LegacyTrajectory,
  ProofContext,
  ProofType,
  Step,
  Trajectory,
  Viewport,
} from '../types.js'

export interface TrajectoryRunOptions {
  /** Side being verified — picks `mountProof.baseline` or `mountProof.target`. */
  side: 'baseline' | 'target'
  /** Base URL for this side, e.g. `http://localhost:3000`. */
  base: string
  /** Output dir — PNGs and `_capture.json` land here. */
  outDir: string
  /** Pre-authenticated persistent profile dir. */
  profileDir?: string
  /** Per-step timeout default (overridden by step.timeout when present). */
  defaultStepTimeoutMs?: number
}

export interface TrajectoryEvent {
  ts: number
  /** Logical phase of the run — `viewport`, `step-N-click`, `mount-proof`, `capture`, etc. */
  stage?: string
  ok?: boolean
  error?: string
  [k: string]: unknown
}

export interface TrajectoryRunReport {
  trajectory: string
  side: 'baseline' | 'target'
  captured: Array<{ name: string; vp: number; file: string; finalUrl: string }>
  failed: Array<{ name: string; vp: number; reason: string; selector?: string; missing?: unknown }>
  log: TrajectoryEvent[]
  /** Thrown MountProofError, if any. Serializable. */
  mountProofError?: { side: 'baseline' | 'target'; failures: unknown; message: string }
}

const DEFAULT_VIEWPORTS: Viewport[] = [
  { w: 1440, h: 900 },
  { w: 768, h: 1024 },
  { w: 360, h: 800 },
]

const DEFAULT_STEP_TIMEOUT_MS = 15_000

/** Run one trajectory on one side. The caller owns the BrowserContext. */
export async function runTrajectory(
  ctx: BrowserContext,
  trajectoryInput: Trajectory | LegacyTrajectory,
  opts: TrajectoryRunOptions,
): Promise<TrajectoryRunReport> {
  // Normalize legacy shape — Promova `assertInlineStyle` becomes mountProof.target.
  const trajectory = translateLegacy(trajectoryInput)
  const viewports = trajectory.viewports ?? DEFAULT_VIEWPORTS
  const defaultTimeout = opts.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  await mkdir(opts.outDir, { recursive: true })

  const log: TrajectoryEvent[] = []
  const captured: TrajectoryRunReport['captured'] = []
  const failed: TrajectoryRunReport['failed'] = []
  let mountProofError: TrajectoryRunReport['mountProofError']

  const logEvent = (event: Omit<TrajectoryEvent, 'ts'>): void => {
    const full: TrajectoryEvent = { ts: Date.now(), ...event }
    log.push(full)
    process.stdout.write(`[trajectory ${opts.side}] ${JSON.stringify(event)}\n`)
  }

  try {
    for (const vp of viewports) {
      const page = await ctx.newPage()
      const proofCtx: ProofContext = { consoleLog: [], requests: [] }

      // Record console + network for mount-proof evaluation.
      page.on('console', msg => {
        proofCtx.consoleLog.push(`${msg.type()}: ${msg.text()}`)
      })
      page.on('response', resp => {
        proofCtx.requests.push({ url: resp.url(), status: resp.status() })
      })

      await page.setViewportSize({ width: vp.w, height: vp.h })
      logEvent({ stage: 'viewport', w: vp.w, h: vp.h })

      let stepIdx = 0
      try {
        for (const step of trajectory.steps) {
          stepIdx++
          const tag = `step-${stepIdx}-${step.type}`
          try {
            await runStep(page, step, opts.base, defaultTimeout)
            logEvent({ stage: tag, ok: true })
          } catch (err) {
            logEvent({ stage: tag, ok: false, error: (err as Error).message })
            await snap(page, opts.outDir, `${trajectory.capture.name}-${vp.w}-FAIL-${tag}`)
            throw new Error(`Step ${stepIdx} (${step.type}) failed: ${(err as Error).message}`)
          }
        }

        // ─── Settle for hydration ────────────────────────────────────────
        // Client-side error boundaries (useEffect/ref crashes) mount AFTER
        // hydration, so proofs must wait past `load`, or they false-green.
        await settleForHydration(page, trajectory.hydrationMarker)

        // ─── Mount proof gate ────────────────────────────────────────────
        // The noErrorBoundary preset is applied to every side by default (it's a
        // universal invariant); opt out per-trajectory with `allowErrorBoundary`.
        const explicitProofs = trajectory.mountProof?.[opts.side] ?? []
        const proofs: ProofType[] = trajectory.allowErrorBoundary
          ? explicitProofs
          : [{ type: 'noErrorBoundary' }, ...explicitProofs]
        if (proofs.length > 0) {
          try {
            await verifyMountProof(opts.side, proofs, page as unknown as PageLike, proofCtx)
            logEvent({ stage: 'mount-proof', ok: true, side: opts.side, count: proofs.length })
          } catch (err) {
            if (err instanceof MountProofError) {
              await snap(page, opts.outDir, `${trajectory.capture.name}-${vp.w}-FAIL-mount-proof`)
              failed.push({
                name: trajectory.capture.name,
                vp: vp.w,
                reason: 'mount-proof-failed',
                missing: err.failures,
              })
              mountProofError = {
                side: err.side,
                failures: err.failures,
                message: err.message,
              }
              logEvent({ stage: 'mount-proof', ok: false, side: opts.side, error: err.message })
              throw err
            }
            throw err
          }
        }

        // ─── Capture ────────────────────────────────────────────────────
        await captureScreenshot(page, trajectory.capture, opts.outDir, vp, captured, failed, logEvent)
      } finally {
        await page.close().catch(() => undefined)
      }
    }
  } finally {
    await writeFile(
      path.join(opts.outDir, '_trajectory.json'),
      JSON.stringify({ trajectory: trajectory.name, side: opts.side, log }, null, 2),
    )
    // Emit capture report in the shape report.ts expects.
    await writeFile(
      path.join(opts.outDir, '_capture.json'),
      JSON.stringify({ captured, failed }, null, 2),
    )
  }

  return {
    trajectory: trajectory.name,
    side: opts.side,
    captured,
    failed,
    log,
    ...(mountProofError ? { mountProofError } : {}),
  }
}

/**
 * Wait past `load` so post-hydration client error boundaries (useEffect / ref
 * crashes) have a chance to mount before proofs run. networkidle + a short fixed
 * settle, plus an optional explicit hydration marker. All waits are best-effort
 * (swallowed on timeout) — they tighten timing, they don't gate the run.
 */
async function settleForHydration(page: Page, marker?: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined)
  if (marker) {
    await page.waitForSelector(marker, { state: 'attached', timeout: 5000 }).catch(() => undefined)
  }
  await page.waitForTimeout(400)
}

async function captureScreenshot(
  page: Page,
  capture: CaptureConfig,
  outDir: string,
  vp: Viewport,
  captured: TrajectoryRunReport['captured'],
  failed: TrajectoryRunReport['failed'],
  logEvent: (e: Omit<TrajectoryEvent, 'ts'>) => void,
): Promise<void> {
  const outFile = path.join(outDir, `${capture.name}-${vp.w}.png`)
  // Capture-time masking: hide dynamic regions so they don't drive spurious
  // diffs. visibility:hidden keeps layout intact (vs display:none) so the rest
  // of the page doesn't reflow between sides.
  if (capture.mask && capture.mask.length > 0) {
    await page.addStyleTag({
      content: `${capture.mask.join(', ')} { visibility: hidden !important; }`,
    })
  }
  if (capture.selector) {
    const locator = page.locator(capture.selector).first()
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
      logEvent({ stage: 'capture-wait', ok: false, selector: capture.selector })
      await snap(page, outDir, `${capture.name}-${vp.w}-FAIL-no-target`)
      failed.push({
        name: capture.name,
        vp: vp.w,
        reason: 'capture-target-not-visible',
        selector: capture.selector,
      })
      throw new Error(`Capture target not visible: ${capture.selector}`)
    }
    await locator.screenshot({ path: outFile })
  } else {
    await page.screenshot({ path: outFile, fullPage: true })
  }
  captured.push({ name: capture.name, vp: vp.w, file: outFile, finalUrl: page.url() })
  logEvent({ stage: 'capture', ok: true, file: outFile, viewport: vp.w })
}

async function runStep(page: Page, step: Step, base: string, defaultTimeout: number): Promise<unknown> {
  const timeout = ('timeout' in step && typeof step.timeout === 'number' ? step.timeout : undefined) ?? defaultTimeout
  switch (step.type) {
    case 'navigate':
      return page.goto(base + (step.path ?? '/'), { waitUntil: 'domcontentloaded', timeout })
    case 'waitForSelector':
      return page.locator(step.selector).first().waitFor({ state: 'visible', timeout })
    case 'waitForText':
      return page.getByText(step.text, { exact: false }).first().waitFor({ state: 'visible', timeout })
    case 'waitForUrl': {
      const pattern = step.regex
        ? new RegExp(step.regex)
        : (u: URL | string) => String(u).includes(step.contains ?? '')
      return page.waitForURL(pattern, { timeout })
    }
    case 'waitForTimeout':
      return page.waitForTimeout(step.ms ?? 1000)
    case 'click': {
      const target = page.locator(step.selector).first()
      await target.waitFor({ state: 'visible', timeout })
      return target.click({ timeout })
    }
    case 'fill':
      return page.locator(step.selector).first().fill(step.value, { timeout })
    case 'select':
      return page.locator(step.selector).first().selectOption(step.value, { timeout })
    case 'evaluate':
      return page.evaluate(step.script)
    case 'reload':
      return page.reload({ waitUntil: 'domcontentloaded', timeout })
    default: {
      // Exhaustiveness check — TypeScript will yell if a new Step variant is added without handling.
      const _exhaustive: never = step
      throw new Error(`Unknown step type: ${(_exhaustive as { type?: string }).type ?? 'unknown'}`)
    }
  }
}

async function snap(page: Page, outDir: string, name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
  } catch {
    // Best-effort diagnostic snapshot — never block the run.
  }
}

/** Convenience: read trajectory.json + create context + run + close. */
export async function runTrajectoryFromFile(
  trajectoryPath: string,
  opts: TrajectoryRunOptions,
): Promise<TrajectoryRunReport> {
  const { chromium } = await import('playwright')
  const trajectory = JSON.parse(await readFile(trajectoryPath, 'utf8')) as Trajectory | LegacyTrajectory

  const browserOpts = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  }
  let ctx: BrowserContext
  if (opts.profileDir) {
    ctx = await chromium.launchPersistentContext(opts.profileDir, browserOpts)
  } else {
    const browser = await chromium.launch(browserOpts)
    ctx = await browser.newContext()
  }
  try {
    return await runTrajectory(ctx, trajectory, opts)
  } finally {
    await ctx.close().catch(() => undefined)
  }
}
