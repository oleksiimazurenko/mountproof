/**
 * Build SAFE Strapi populate plans from a parsed schema, and serialize them to
 * query strings.
 *
 * The hard-won rules (from a live narnia v4→v5 migration) this encodes:
 *   - never populate a scalar — v5 returns 400 'Invalid key' (v4 silently ignored)
 *   - only populate relations/components/media that the type ACTUALLY has, so a
 *     `populate[breadcrumbs]` on a type without that relation can't 400
 *   - dynamic zones are opt-in (deep-populating them hangs the dev server)
 *   - `deep` mode is version-keyed: v4 `populate=deep` (populate-deep plugin) vs
 *     v5 `populate=*` (@fourlights maps deep→*). Deep is the hang risk — shallow
 *     per-field is the safe default.
 */

import { bucketAttributes } from './schema.js'
import type { StrapiContentType, StrapiVersion } from './types.js'

export type PopulatePlan =
  | { mode: 'deep' }
  | {
      mode: 'shallow'
      /** Relation/component/media attribute names to populate (one level, `true`). */
      populate: string[]
      /** Subset of `populate` to deep-populate (`*`) — bounded to that branch. */
      deep: string[]
      /** Dynamic-zone attribute names to populate via `*` (only when opted in). */
      dynamicZones: string[]
      /** Scalar fields to restrict the response to (e.g. `['slug']` for sitemaps). */
      fields?: string[]
    }

export interface PopulatePlanOptions {
  /** Use GLOBAL deep populate (version-keyed). DANGEROUS: can hang the server. Default false. */
  deep?: boolean
  /** Also populate dynamic zones (off by default — the classic hang). */
  includeDynamicZones?: boolean
  /**
   * Attribute names to populate deeply (`*`) instead of one level (`true`). Use
   * for content-rich, nested attributes (e.g. `sections` with nested relations)
   * so expectation read-back sees the nested fields — otherwise a one-level
   * populate misses them and proofs false-green. Bounded to the named branch, so
   * it's safe unlike a global `populate=*`.
   */
  deepAttributes?: string[]
  /** Restrict populate to these attribute names. */
  only?: string[]
  /** Drop these attribute names from populate. */
  exclude?: string[]
  /** Return only these scalar fields (maps to `fields[]`, not populate). */
  scalarFields?: string[]
}

/** Build a populate plan for one content type. */
export function buildPopulatePlan(
  ct: StrapiContentType,
  opts: PopulatePlanOptions = {},
): PopulatePlan {
  if (opts.deep) return { mode: 'deep' }

  const buckets = bucketAttributes(ct.attributes)
  let populate = buckets.populatable
  if (opts.only) populate = populate.filter((n) => opts.only!.includes(n))
  if (opts.exclude) populate = populate.filter((n) => !opts.exclude!.includes(n))

  const deepSet = new Set(opts.deepAttributes ?? [])
  return {
    mode: 'shallow',
    populate,
    deep: populate.filter((n) => deepSet.has(n)),
    dynamicZones: opts.includeDynamicZones ? buckets.dynamicZones : [],
    fields: opts.scalarFields,
  }
}

/**
 * Serialize a plan to a query string (no leading `?`). `version` only changes the
 * `deep` syntax; shallow per-field populate is identical across v4/v5.
 */
export function toPopulateQuery(plan: PopulatePlan, version: StrapiVersion): string {
  const qs = new URLSearchParams()

  if (plan.mode === 'deep') {
    // The one place the version genuinely diverges.
    qs.set('populate', version === 4 ? 'deep' : '*')
    return qs.toString()
  }

  const deep = new Set(plan.deep)
  for (const name of plan.populate) qs.set(`populate[${name}]`, deep.has(name) ? '*' : 'true')
  // DZ scoped to one field stays bounded (vs a global `*` that hangs).
  for (const name of plan.dynamicZones) qs.set(`populate[${name}]`, '*')
  if (plan.fields) plan.fields.forEach((f, i) => qs.set(`fields[${i}]`, f))

  return qs.toString()
}

/** Convenience: full `/api/<pluralApiId>?<query>` path for a content type. */
export function populateUrl(
  ct: StrapiContentType,
  version: StrapiVersion,
  opts?: PopulatePlanOptions,
): string {
  const query = toPopulateQuery(buildPopulatePlan(ct, opts), version)
  return query ? `/api/${ct.pluralApiId}?${query}` : `/api/${ct.pluralApiId}`
}
