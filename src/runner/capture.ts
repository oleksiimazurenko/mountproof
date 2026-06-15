/**
 * Playwright-driven capture engine.
 *
 * Component-scoped screenshots of one environment. For each target,
 * navigates `<base><path>`, freezes animations, takes a selector-scoped
 * screenshot per viewport.
 *
 * Optional persistent profile dir is required if your auth uses IndexedDB
 * (e.g. Firebase) — Playwright's `storageState` cannot serialize IndexedDB,
 * so the only reliable way to carry that state across processes is a
 * persistent BrowserContext.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'

export interface CaptureTarget {
  /** Output file basename and report key. */
  name: string
  /** Path appended to `base` (e.g. `/my-plan`). */
  path: string
  /** CSS selector to crop the screenshot to. Use `body` for full page. */
  selector: string
  /** Required-visible marker that signals "auth done, layout mounted". */
  awaitVisible?: string
  /** Optional follow-up interactions before screenshot (click sequences, waits). */
  setup?: Array<{ click?: string; waitFor?: string; settle?: number }>
  /** Free-form note that surfaces in the report. */
  note?: string
}

export interface CaptureOptions {
  /** Base URL of the environment, e.g. `http://localhost:3000`. */
  base: string
  /** List of targets to screenshot. */
  targets: CaptureTarget[]
  /** Output directory — PNGs land here as `<name>-<viewport>.png`. */
  outDir: string
  /** Pre-authenticated persistent profile dir. */
  profileDir?: string
  /** Widths to capture at; height is computed from content. Default `[1440, 768, 360]`. */
  viewports?: number[]
  /** Per-capture hard timeout. Default 45 000 ms. */
  perCaptureTimeoutMs?: number
}

export interface CaptureRecord {
  name: string
  vp: number
  file: string
  finalUrl: string
  skeletonStillVisible: boolean
}

export interface CaptureFailure {
  name: string
  vp: number
  reason: string
  selector?: string
  url: string
  finalUrl: string
}

export interface CaptureReport {
  base: string
  captured: CaptureRecord[]
  failed: CaptureFailure[]
}

const FREEZE_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important; transition-duration: 0s !important;
  transition-delay: 0s !important; scroll-behavior: auto !important;
  caret-color: transparent !important;
}`

const DEFAULT_VIEWPORTS = [1440, 768, 360]
const DEFAULT_PER_CAPTURE_TIMEOUT_MS = 45_000

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms),
    ),
  ])
}

const SKELETON_CHECK = `() => {
  const sels = ['[class*="Skeleton"]', '[class*="skeleton" i]', '[class*="shimmer" i]', '[class*="Shimmer"]']
  for (const sel of sels) {
    const el = document.querySelector(sel)
    if (el && el.getBoundingClientRect().width > 0) return false
  }
  return true
}`

/**
 * Capture all targets at all viewports. Returns the report; also writes
 * it to `<outDir>/_capture.json` for the HTML report generator.
 *
 * `ctx` may be a fresh `BrowserContext` or one launched with
 * `chromium.launchPersistentContext(profileDir)` — the function does not
 * own it; the caller closes it.
 */
export async function captureAll(ctx: BrowserContext, opts: CaptureOptions): Promise<CaptureReport> {
  const viewports = opts.viewports ?? DEFAULT_VIEWPORTS
  const perCaptureTimeout = opts.perCaptureTimeoutMs ?? DEFAULT_PER_CAPTURE_TIMEOUT_MS
  await mkdir(opts.outDir, { recursive: true })

  const page: Page = ctx.pages()[0] ?? (await ctx.newPage())
  const report: CaptureReport = { base: opts.base, captured: [], failed: [] }

  for (const target of opts.targets) {
    const url = opts.base.replace(/\/$/, '') + target.path
    for (const vp of viewports) {
      const file = path.join(opts.outDir, `${target.name}-${vp}.png`)
      try {
        await withTimeout(
          () => captureOne(page, target, vp, url, file, report),
          perCaptureTimeout,
          `${target.name}-${vp}`,
        )
      } catch (e) {
        report.failed.push({
          name: target.name,
          vp,
          reason: String((e as Error).message ?? e).slice(0, 200),
          url,
          finalUrl: page.url(),
        })
      }
    }
  }

  await writeFile(path.join(opts.outDir, '_capture.json'), JSON.stringify(report, null, 2))
  return report
}

async function captureOne(
  page: Page,
  target: CaptureTarget,
  vp: number,
  url: string,
  file: string,
  report: CaptureReport,
): Promise<void> {
  // Two-pass viewport sizing to avoid "tall body, empty middle" artifact on
  // min-height:100vh layouts. Start small; later re-measure scrollHeight and
  // resize to fit.
  await page.setViewportSize({ width: vp, height: 900 })

  // `load` resolves once main + subresources are loaded; `networkidle` never
  // fires on SPAs with always-on telemetry. `load` + 1 s grace lets
  // client-side router complete its auth-redirect before we screenshot.
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(1000)

  // Two-stage settle: layout-mounted marker, then skeleton-gone. Both
  // non-blocking — we record the final skeleton state in the report.
  if (target.awaitVisible) {
    await page.locator(target.awaitVisible).first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => undefined)
  }
  const skeletonGone = await page
    .waitForFunction(SKELETON_CHECK, { timeout: 6000, polling: 400 })
    .then(() => true)
    .catch(() => false)

  // Extra settle window — lazy-loaded feeds often render in stages and
  // skeleton-gone only signals the FIRST layer. 8 s is a heuristic.
  await page.waitForTimeout(8000)

  // Resize viewport to fit actual content (capped) — eliminates empty-middle
  // artifact on flex-grow layouts where body min-height stretches past
  // rendered content.
  const contentHeight = await page.evaluate(() =>
    Math.min(20000, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)),
  )
  await page.setViewportSize({ width: vp, height: Math.max(900, Math.min(20000, contentHeight)) })
  await page.waitForTimeout(300)
  await page.addStyleTag({ content: FREEZE_CSS })

  if (Array.isArray(target.setup)) {
    for (const step of target.setup) {
      if (step.click) {
        await page.locator(step.click).first().click({ timeout: 5000, force: true }).catch(() => undefined)
      }
      if (step.waitFor) {
        await page.locator(step.waitFor).first().waitFor({ timeout: 5000 }).catch(() => undefined)
      }
      // `settle`: blind sleep after interaction. Use when post-click state
      // is non-deterministic (modal may or may not appear). We screenshot
      // whatever lands; the reader decides if it's right.
      await page.waitForTimeout(typeof step.settle === 'number' ? step.settle : 300)
    }
  }

  const loc = page.locator(target.selector).first()
  const count = await page.locator(target.selector).count()
  if (count === 0) {
    report.failed.push({
      name: target.name,
      vp,
      reason: 'selector-not-found',
      selector: target.selector,
      url,
      finalUrl: page.url(),
    })
    return
  }
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined)
  await loc.screenshot({ path: file, timeout: 15_000 })
  report.captured.push({
    name: target.name,
    vp,
    file,
    finalUrl: page.url(),
    skeletonStillVisible: !skeletonGone,
  })
}

/** Convenience: read targets.json + create context + capture + close. */
export async function captureFromFile(
  targetsPath: string,
  base: string,
  outDir: string,
  profileDir?: string,
  viewports?: number[],
): Promise<CaptureReport> {
  const { chromium } = await import('playwright')
  const targets = JSON.parse(await readFile(targetsPath, 'utf8')) as CaptureTarget[]

  const launchOpts = {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce' as const,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  }

  let ctx: BrowserContext
  if (profileDir) {
    ctx = await chromium.launchPersistentContext(profileDir, launchOpts)
  } else {
    const browser = await chromium.launch({ headless: true })
    ctx = await browser.newContext({ ...launchOpts, viewport: undefined })
  }
  try {
    return await captureAll(ctx, { base, targets, outDir, profileDir, viewports })
  } finally {
    await ctx.close().catch(() => undefined)
  }
}
