/**
 * runStrapiAudit — the generic Strapi v4→v5 migration orchestration, in the lib.
 *
 * For each target (route + collection + slug): build a SAFE populate query from
 * the schema, read the entry back from BOTH instances, check field parity
 * (leaf-set comparison, shape-agnostic), and emit a mountproof Trajectory whose
 * proofs assert every field renders. The caller's harness stays thin: it supplies
 * the route map (content-type→URL, which can't be derived from the schema), the
 * two instance URLs, and optional per-type depth. Everything Strapi-generic lives
 * here, so the next migration doesn't reimplement it.
 *
 * Network is injectable (`fetch`) so the whole flow is unit-testable without a
 * live Strapi.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Trajectory } from '../types.js'
import { entryToTrajectory, extractLeaves, type ProofGenOptions } from './expectations.js'
import { buildPopulatePlan, toPopulateQuery } from './populate.js'
import { findByPluralApiId } from './schema.js'
import type { StrapiSchema, StrapiVersion } from './types.js'
import { firstEntry, inferVersionFromEntry } from './version.js'

export interface AuditTarget {
  /** Frontend route (slug already filled), e.g. `/blog/dating-slang`. */
  route: string
  /** Strapi REST plural id, e.g. `articles`. */
  pluralApiId: string
  /** Slug to filter by (omit for single types). */
  slug?: string
  /** Mark single types so the response is read as an object, not an array. */
  kind?: 'single'
}

export interface ParityResult {
  ok: boolean
  /** Content leaves present on baseline but missing on target (regressions). */
  missingOnTarget: string[]
}

export interface AuditResult {
  route: string
  pluralApiId: string
  baselineVersion: StrapiVersion | null
  targetVersion: StrapiVersion | null
  parity: ParityResult
  trajectory?: Trajectory
  error?: string
}

export interface RunStrapiAuditOptions extends ProofGenOptions {
  baselineUrl: string
  targetUrl: string
  targets: AuditTarget[]
  /** Schema for both instances (build populate queries). Without it, no populate. */
  schema?: StrapiSchema
  /** Per content-type deep-populate attributes (pluralApiId → attribute names). */
  perTypeDepth?: Record<string, string[]>
  /** Populate dynamic zones (default true — needed to see nested content fields). */
  includeDynamicZones?: boolean
  /** Injectable fetch for testing. */
  fetch?: typeof fetch
  /** If set, write trajectories/ + _parity.json under this dir. */
  outDir?: string
  /** Timestamp for the parity report (deterministic in tests). */
  generatedAt?: string
}

export interface RunStrapiAuditResult {
  results: AuditResult[]
  trajectories: Trajectory[]
  parityFailures: number
}

function buildQuery(opts: RunStrapiAuditOptions, pluralApiId: string): string {
  if (!opts.schema) return ''
  const ct = findByPluralApiId(opts.schema, pluralApiId)
  if (!ct) return ''
  const plan = buildPopulatePlan(ct, {
    includeDynamicZones: opts.includeDynamicZones ?? true,
    deepAttributes: opts.perTypeDepth?.[pluralApiId],
  })
  // Shallow query is version-agnostic; version only matters for global deep mode.
  return toPopulateQuery(plan, 5)
}

async function fetchEntry(
  baseUrl: string,
  target: AuditTarget,
  query: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const filter = target.slug ? `filters[slug]=${encodeURIComponent(target.slug)}` : ''
  const qs = [filter, query].filter(Boolean).join('&')
  const url = `${baseUrl.replace(/\/$/, '')}/api/${target.pluralApiId}${qs ? `?${qs}` : ''}`
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`${target.pluralApiId} → HTTP ${res.status}`)
  return firstEntry(await res.json())
}

/** Run the migration audit across all targets. */
export async function runStrapiAudit(opts: RunStrapiAuditOptions): Promise<RunStrapiAuditResult> {
  const fetchImpl = opts.fetch ?? fetch
  const results: AuditResult[] = []
  const trajectories: Trajectory[] = []

  for (const target of opts.targets) {
    const query = buildQuery(opts, target.pluralApiId)
    try {
      const [bRaw, tRaw] = await Promise.all([
        fetchEntry(opts.baselineUrl, target, query, fetchImpl),
        fetchEntry(opts.targetUrl, target, query, fetchImpl),
      ])

      // Leaf-set parity is shape-agnostic: extractLeaves recurses through v4's
      // `attributes` envelope and v5's flat shape alike, so the two leaf sets are
      // directly comparable. Missing-on-target = a content regression.
      const baselineLeaves = new Set(extractLeaves(bRaw))
      const targetLeaves = new Set(extractLeaves(tRaw))
      const missingOnTarget = [...baselineLeaves].filter((l) => !targetLeaves.has(l))

      const trajectory = entryToTrajectory(target.route, tRaw, opts)
      trajectories.push(trajectory)

      results.push({
        route: target.route,
        pluralApiId: target.pluralApiId,
        baselineVersion: inferVersionFromEntry(bRaw),
        targetVersion: inferVersionFromEntry(tRaw),
        parity: { ok: missingOnTarget.length === 0, missingOnTarget },
        trajectory,
      })
    } catch (err) {
      results.push({
        route: target.route,
        pluralApiId: target.pluralApiId,
        baselineVersion: null,
        targetVersion: null,
        parity: { ok: false, missingOnTarget: [] },
        error: String(err),
      })
    }
  }

  if (opts.outDir) writeAuditArtifacts(opts.outDir, results, opts.generatedAt)

  return {
    results,
    trajectories,
    parityFailures: results.filter((r) => !r.parity.ok).length,
  }
}

function writeJson(filePath: string, value: unknown): void {
  if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function writeAuditArtifacts(outDir: string, results: AuditResult[], generatedAt?: string): void {
  for (const r of results) {
    if (r.trajectory) writeJson(join(outDir, 'trajectories', `${r.trajectory.name}.json`), r.trajectory)
  }
  writeJson(join(outDir, 'trajectories', '_parity.json'), {
    generatedAt: generatedAt ?? new Date().toISOString(),
    failures: results.filter((r) => !r.parity.ok).length,
    results: results.map((r) => ({
      route: r.route,
      pluralApiId: r.pluralApiId,
      baselineVersion: r.baselineVersion,
      targetVersion: r.targetVersion,
      parityOk: r.parity.ok,
      missingOnTarget: r.parity.missingOnTarget,
      error: r.error,
    })),
  })
}
