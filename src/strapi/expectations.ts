/**
 * Expectation generator — turn a Strapi entry (read back from the API, the
 * ground truth of what's published) into a runnable mountproof Trajectory whose
 * proofs assert that every user-facing field actually rendered on the page.
 *
 * This generalizes the narnia `field-presence-audit.mjs`: recursively extract the
 * "leaf strings" a page should display, then emit `pageTextContains` proofs (a
 * selector-free visible-text check). Because we control nothing about WHERE each
 * field renders, visible-text presence is the right granularity — exactly what
 * the audit proved out against real pages.
 */

import type { ProofType, Trajectory } from '../types.js'
import {
  bucketAttributes,
  extractableKeys,
  extractableTopLevelKeys,
  findByPluralApiId,
} from './schema.js'
import type { StrapiSchema } from './types.js'

/** Keys that never render as user-facing text, regardless of context. */
const ALWAYS_SKIP = new Set([
  'id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale',
  'url', 'ext', 'hash', 'mime', 'previewUrl', 'provider', 'provider_metadata',
  'metaRobots', 'canonicalURL', 'metaImage', 'metaSocial', 'metaViewport',
  'structuredData', 'schemaImage', 'preventIndexing', 'isIndexable',
  '__component', 'componentName', 'kind',
])

/**
 * Keys skipped ONLY inside a media object. These are media-internal there
 * (`name` = file name, `alternativeText`/`caption` = asset metadata) but
 * genuinely user-facing elsewhere (`author.name`, `expert.name`, …) — so we skip
 * them context-sensitively rather than blindly by key name.
 */
const MEDIA_ONLY_SKIP = new Set(['name', 'alternativeText', 'caption'])

/** A Strapi media object: has a `url` plus at least one media-internal marker. */
function isMediaObject(node: Record<string, unknown>): boolean {
  return (
    typeof node.url === 'string' &&
    ('mime' in node || 'ext' in node || 'hash' in node || 'formats' in node)
  )
}

const MIN_STRING_LEN = 4

function isLeafString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const t = value.trim()
  return (
    t.length >= MIN_STRING_LEN &&
    !/^#?[0-9a-f]{6,}$/i.test(t) && // hex id / color
    !/^https?:\/\//.test(t) && // url
    !/^[\d.,\s]+$/.test(t) && // pure number
    !/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(t) && // ISO date / datetime (publish_at etc.)
    !/^\//.test(t) && // path config (/funnels/courses-onboarding)
    !/^[a-z0-9]+_[a-z0-9_]+$/i.test(t) // snake_case identifier (concept_1, event keys)
  )
}

/** Strip tags + decode common entities + collapse whitespace. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ExtractOptions {
  /** Extra keys to skip beyond the built-in internals. */
  skipKeys?: string[]
  /** Schema + content-type id → restrict TOP-LEVEL extraction to content fields. */
  schema?: StrapiSchema
  /** Plural api id of the entry's content type (with `schema`). */
  pluralApiId?: string
  /** Top-level field names to NOT extract into body leaves (e.g. head-only `title`). */
  excludeTopLevel?: string[]
}

/** Unwrap a v4 `{id, attributes:{...}}` envelope so top-level field names are reachable. */
function unwrapFields(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
  const e = entry as Record<string, unknown>
  if (e.attributes && typeof e.attributes === 'object' && !Array.isArray(e.attributes)) {
    return { ...e, ...(e.attributes as Record<string, unknown>) }
  }
  return e
}

/** Recursively collect normalized, deduped leaf strings that should appear on the page. */
export function extractLeaves(entry: unknown, opts: ExtractOptions = {}): string[] {
  const extraSkip = opts.skipKeys ? new Set(opts.skipKeys) : null
  const out = new Set<string>()

  // Schema-aware: only extract from content-bearing top-level fields, so slug,
  // dates, enums and other non-visible scalars don't become false-positive proofs.
  let topKeep: Set<string> | null = null
  if (opts.schema && opts.pluralApiId) {
    const ct = findByPluralApiId(opts.schema, opts.pluralApiId)
    if (ct) topKeep = extractableTopLevelKeys(ct)
  }
  // Drop head-only fields (e.g. a landing-builder's title) from body extraction.
  if (topKeep && opts.excludeTopLevel) for (const k of opts.excludeTopLevel) topKeep.delete(k)

  const walk = (node: unknown): void => {
    if (node == null) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>
      const inMedia = isMediaObject(obj)
      // Component / DZ-section: if we know its schema, filter to content fields
      // so section CONFIG (colors, enum variants, payment-provider keys, paths)
      // doesn't leak in as proofs — the same content-only rule as the top level.
      let compKeep: Set<string> | null = null
      const comp = obj.__component
      if (typeof comp === 'string' && opts.schema?.components?.[comp]) {
        compKeep = extractableKeys(opts.schema.components[comp])
      }
      for (const [k, v] of Object.entries(obj)) {
        if (ALWAYS_SKIP.has(k)) continue
        if (extraSkip?.has(k)) continue
        // Media-internal keys are skipped only inside an actual media object, so
        // author.name / product.name survive.
        if (inMedia && MEDIA_ONLY_SKIP.has(k)) continue
        if (compKeep && !compKeep.has(k)) continue
        walk(v)
      }
      return
    }
    if (isLeafString(node)) {
      const normalized = stripHtml(String(node))
      if (normalized.length >= MIN_STRING_LEN) out.add(normalized)
    }
  }

  if (topKeep) {
    // Gate the top level by schema; deeper levels use the heuristic walk.
    const fields = unwrapFields(entry)
    for (const [k, v] of Object.entries(fields)) {
      if (ALWAYS_SKIP.has(k) || extraSkip?.has(k)) continue
      if (!topKeep.has(k)) continue
      walk(v)
    }
  } else {
    walk(entry)
  }
  return [...out]
}

export interface ProofGenOptions extends ExtractOptions {
  /** Truncate each needle to this many chars (rich text gets ellipsized on-page). Default 60. */
  maxNeedleLen?: number
  /** Cap the number of proofs emitted per page. Default 40. */
  maxProofs?: number
}

/** Truncate, dedupe, and cap leaves into needles for a given proof type. */
function leavesToTypedProofs(
  leaves: string[],
  make: (text: string) => ProofType,
  opts: ProofGenOptions,
): ProofType[] {
  const maxLen = opts.maxNeedleLen ?? 60
  const maxProofs = opts.maxProofs ?? 40
  const seen = new Set<string>()
  const proofs: ProofType[] = []
  for (const leaf of leaves) {
    const text = leaf.length > maxLen ? leaf.slice(0, maxLen) : leaf
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    proofs.push(make(text))
    if (proofs.length >= maxProofs) break
  }
  return proofs
}

/** Turn extracted leaves into `pageTextContains` (visible body) proofs. */
export function leavesToProofs(leaves: string[], opts: ProofGenOptions = {}): ProofType[] {
  return leavesToTypedProofs(leaves, (text) => ({ type: 'pageTextContains', text }), opts)
}

/** Turn leaves into `htmlContains` proofs — for head-only fields (title/meta in <head>). */
export function leavesToHeadProofs(leaves: string[], opts: ProofGenOptions = {}): ProofType[] {
  return leavesToTypedProofs(leaves, (text) => ({ type: 'htmlContains', text }), opts)
}

export interface ExpectationTrajectoryOptions extends ProofGenOptions {
  /** Trajectory name (defaults to a slug of the route). */
  name?: string
}

/**
 * Build a Trajectory that navigates `route` and asserts every field of `entry`
 * renders. Proofs are placed on BOTH sides (migration baseline and target should
 * show identical data), so the same trajectory gates main and migrated.
 */
export function entryToTrajectory(
  route: string,
  entry: unknown,
  opts: ExpectationTrajectoryOptions = {},
): Trajectory {
  const name = opts.name ?? routeToName(route)

  // Per-type: a content type that has a dynamic zone is a landing-builder style
  // page — its visible content is in the DZ sections, and its `title` is a
  // <head>/SEO field, NOT body text. So route such a title to an htmlContains
  // (head) proof and exclude it from body extraction. Types without a DZ
  // (articles, authors) keep `title` as a visible body field.
  const ct =
    opts.schema && opts.pluralApiId ? findByPluralApiId(opts.schema, opts.pluralApiId) : undefined
  const hasDynamicZone = ct ? bucketAttributes(ct.attributes).dynamicZones.length > 0 : false

  const bodyLeaves = extractLeaves(entry, {
    ...opts,
    excludeTopLevel: hasDynamicZone ? ['title'] : opts.excludeTopLevel,
  })
  const bodyProofs = leavesToProofs(bodyLeaves, opts)

  const headProofs = hasDynamicZone ? leavesToHeadProofs(headFieldValues(entry), opts) : []

  const proofs = [...bodyProofs, ...headProofs]
  return {
    name,
    target: route,
    mountProof: { baseline: proofs, target: proofs },
    steps: [{ type: 'navigate', path: route }],
    capture: { name },
  }
}

/** Head-only field values (the title of a landing-builder lives in <head>). */
function headFieldValues(entry: unknown): string[] {
  const fields = unwrapFields(entry)
  const out: string[] = []
  if (typeof fields.title === 'string') out.push(stripHtml(fields.title))
  return out.filter((s) => s.length >= MIN_STRING_LEN)
}

function routeToName(route: string): string {
  return (
    route
      .replace(/^\//, '')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9-]/gi, '')
      .toLowerCase() || 'home'
  )
}
