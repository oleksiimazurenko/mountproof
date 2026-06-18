/**
 * discoverTargets — turn a route map + a live instance into AuditTargets, so the
 * harness doesn't hand-list slugs. For each collection in the route map it fetches
 * a sample of real entries, reads their slug, and fills the route pattern; single
 * types become slugless targets. "Known-hard" targets (e.g. an article with DZ
 * blocks, a content-rich builder) are always included.
 *
 * Closes the last manual step before a full migration audit over every collection.
 */

import { flattenEntry } from './version.js'
import type { AuditTarget } from './audit.js'

export interface RouteMapCollection {
  pluralApiId: string
  /** Route pattern with a slug placeholder, e.g. `/blog/:slug` or `/how-to-pronounce/:word`. */
  route: string
  /** Field the placeholder is filled from (default `slug`). */
  slugField?: string
}

export interface RouteMapSingle {
  pluralApiId: string
  route: string
}

export interface RouteMap {
  collections?: RouteMapCollection[]
  singleTypes?: RouteMapSingle[]
}

export interface DiscoverTargetsOptions {
  baseUrl: string
  routeMap: RouteMap
  /** Sample size per collection (default 2). */
  sampleN?: number
  /** Always-included targets (known-tricky pages). */
  knownHard?: AuditTarget[]
  /** Injectable fetch for testing. */
  fetch?: typeof fetch
}

/** Fill a route's `:<slugField>` placeholder; returns null if other params remain unfilled. */
function fillRoute(route: string, slugField: string, slug: string): string | null {
  const filled = route.replace(new RegExp(`:${slugField}(?![A-Za-z0-9_])`, 'g'), slug)
  // Multi-param routes (e.g. /:category/:slug) we can't auto-fill — skip.
  return /:[A-Za-z]/.test(filled) ? null : filled
}

async function fetchSlugs(
  baseUrl: string,
  pluralApiId: string,
  slugField: string,
  n: number,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  // Plain page fetch (robust across query-param quirks); read slugField off each entry.
  const url = `${baseUrl.replace(/\/$/, '')}/api/${pluralApiId}?pagination[pageSize]=${n}`
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return []
    const json = (await res.json()) as { data?: unknown }
    const data = Array.isArray(json.data) ? json.data : []
    const slugs: string[] = []
    for (const entry of data) {
      const flat = flattenEntry(entry, { keepMeta: true })
      const slug = flat[slugField]
      if (typeof slug === 'string' && slug) slugs.push(slug)
    }
    return slugs
  } catch {
    return []
  }
}

export interface DiscoverTargetsResult {
  targets: AuditTarget[]
  /** Routes skipped because they had params beyond the slug (e.g. /:category/:slug). */
  skipped: string[]
}

/** Build AuditTargets by sampling real slugs from each route-map collection. */
export async function discoverTargets(opts: DiscoverTargetsOptions): Promise<DiscoverTargetsResult> {
  const fetchImpl = opts.fetch ?? fetch
  const sampleN = opts.sampleN ?? 2
  const seen = new Set<string>()
  const targets: AuditTarget[] = []
  const skipped: string[] = []

  const add = (t: AuditTarget) => {
    if (seen.has(t.route)) return
    seen.add(t.route)
    targets.push(t)
  }

  for (const t of opts.knownHard ?? []) add(t)

  for (const single of opts.routeMap.singleTypes ?? []) {
    add({ route: single.route, pluralApiId: single.pluralApiId, kind: 'single' })
  }

  for (const col of opts.routeMap.collections ?? []) {
    const slugField = col.slugField ?? 'slug'
    const slugs = await fetchSlugs(opts.baseUrl, col.pluralApiId, slugField, sampleN, fetchImpl)
    for (const slug of slugs) {
      const route = fillRoute(col.route, slugField, slug)
      if (route === null) {
        skipped.push(col.route)
        continue
      }
      add({ route, pluralApiId: col.pluralApiId, slug })
    }
  }

  return { targets, skipped: [...new Set(skipped)] }
}
