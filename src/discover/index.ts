/**
 * Discover module — public surface + top-level orchestrators.
 *
 * Re-exports every phase (ast → graph → browse → emit → drift) and wires them
 * into two end-to-end flows the CLI calls:
 *
 *   runDiscovery — parse → graph → (optional drift filter) → browser crawl → emit
 *   runDrift     — parse → graph → compare stored trajectories vs current source
 *
 * Playwright is loaded dynamically (peer dependency) only when a crawl runs, so
 * importing this module for its static analysis costs nothing browser-related.
 */

import { join } from 'node:path'
import { rm } from 'node:fs/promises'

import { parseProject } from './ast/index.js'
import type { Framework } from './ast/index.js'
import { buildGraph } from './graph/index.js'
import { discoverAll, playwrightDiscoveryPage } from './browse/index.js'
import type { AuthAdapter, DiscoveryResult } from './browse/index.js'
import { emitDiscovery } from './emit/index.js'
import type { EmitSummary } from './emit/index.js'
import { compareDrift, hashAllComponents, planRediscovery } from './drift/index.js'
import type { DriftComparison, RediscoveryPlan } from './drift/index.js'

export * from './ast/index.js'
export * from './graph/index.js'
export * from './browse/index.js'
export * from './emit/index.js'
export * from './drift/index.js'

/** Files that never back a directly-reachable view — skipped by default. */
const NON_VIEW_FILE = /(^|\/)(layout|template|loading|error|not-found|default)\.[jt]sx?$/i

export interface RunDiscoveryOptions {
  /** Project root to analyse + crawl. */
  appDir: string
  /** Base URL of the running app, e.g. http://localhost:3000. */
  baseUrl: string
  /** Output root for trajectories + reports. Defaults to `appDir`. */
  outDir?: string
  /** Override framework auto-detection. */
  framework?: Framework
  /** Only re-discover components whose source changed since last run. */
  selective?: boolean
  /** With `selective`, also discover components that have no trajectory yet. */
  includeMissing?: boolean
  /** Values for dynamic route segments (`{ id: '1' }`). */
  paramValues?: Record<string, string>
  /** Per-selector wait budget (ms). */
  waitTimeoutMs?: number
  /** Persistent Playwright profile dir (pre-authenticated context). */
  profileDir?: string
  /** Auth adapter for login walls. */
  auth?: AuthAdapter
  /** Fixed timestamp (tests/determinism). */
  generatedAt?: string
}

export interface RunDiscoveryResult {
  summary: EmitSummary
  results: DiscoveryResult[]
  /** Set when `selective` was used. */
  plan?: RediscoveryPlan
}

/** Launch a browser page, run `fn`, and always tear the browser down. */
async function withPage<T>(
  profileDir: string | undefined,
  fn: (page: ReturnType<typeof playwrightDiscoveryPage>) => Promise<T>,
): Promise<T> {
  const { chromium } = await import('playwright')
  if (profileDir) {
    const ctx = await chromium.launchPersistentContext(profileDir, { headless: true })
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage())
      return await fn(playwrightDiscoveryPage(page))
    } finally {
      await ctx.close()
    }
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    return await fn(playwrightDiscoveryPage(page))
  } finally {
    await browser.close()
  }
}

/** End-to-end discovery: static analysis → browser crawl → emitted trajectories. */
export async function runDiscovery(opts: RunDiscoveryOptions): Promise<RunDiscoveryResult> {
  const outDir = opts.outDir ?? opts.appDir
  const trajectoriesDir = join(outDir, 'trajectories')

  const project = await parseProject(opts.appDir, { framework: opts.framework })
  const graph = buildGraph(project)
  const sourceHashes = hashAllComponents(project)

  // Decide which components to crawl.
  let only: string[] | undefined
  let plan: RediscoveryPlan | undefined
  if (opts.selective) {
    const comparison = compareDrift(trajectoriesDir, project, graph)
    plan = planRediscovery(comparison, { includeMissing: opts.includeMissing })
    only = plan.rediscover
    // Remove orphaned trajectory files.
    await Promise.all(
      plan.deleteOrphans.map((name) => rm(join(trajectoriesDir, `${name}.json`), { force: true })),
    )
  }

  const discoverOpts = {
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    paramValues: opts.paramValues,
    waitTimeoutMs: opts.waitTimeoutMs,
    profileDir: opts.profileDir,
    only,
    skip: (id: string) => NON_VIEW_FILE.test(id),
  }

  const results =
    only && only.length === 0
      ? []
      : await withPage(opts.profileDir, (page) => discoverAll(page, graph, discoverOpts))

  const summary = emitDiscovery(results, {
    outDir,
    trajectoriesDir,
    sourceHashes,
    generatedAt: opts.generatedAt,
  })

  return { summary, results, plan }
}

export interface RunDriftOptions {
  appDir: string
  outDir?: string
  framework?: Framework
  includeMissing?: boolean
}

export interface RunDriftResult {
  comparison: DriftComparison
  plan: RediscoveryPlan
}

/** Compare stored trajectories against current source; return drift + a plan. */
export async function runDrift(opts: RunDriftOptions): Promise<RunDriftResult> {
  const outDir = opts.outDir ?? opts.appDir
  const trajectoriesDir = join(outDir, 'trajectories')

  const project = await parseProject(opts.appDir, { framework: opts.framework })
  const graph = buildGraph(project)
  const comparison = compareDrift(trajectoriesDir, project, graph)
  const plan = planRediscovery(comparison, { includeMissing: opts.includeMissing })
  return { comparison, plan }
}
