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
    !/^[\d.,\s]+$/.test(t) // pure number
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
}

/** Recursively collect normalized, deduped leaf strings that should appear on the page. */
export function extractLeaves(entry: unknown, opts: ExtractOptions = {}): string[] {
  const extraSkip = opts.skipKeys ? new Set(opts.skipKeys) : null
  const out = new Set<string>()

  const walk = (node: unknown): void => {
    if (node == null) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>
      const inMedia = isMediaObject(obj)
      for (const [k, v] of Object.entries(obj)) {
        if (ALWAYS_SKIP.has(k)) continue
        if (extraSkip?.has(k)) continue
        // Media-internal keys are skipped only inside an actual media object, so
        // author.name / product.name survive.
        if (inMedia && MEDIA_ONLY_SKIP.has(k)) continue
        walk(v)
      }
      return
    }
    if (isLeafString(node)) {
      const normalized = stripHtml(String(node))
      if (normalized.length >= MIN_STRING_LEN) out.add(normalized)
    }
  }

  walk(entry)
  return [...out]
}

export interface ProofGenOptions extends ExtractOptions {
  /** Truncate each needle to this many chars (rich text gets ellipsized on-page). Default 60. */
  maxNeedleLen?: number
  /** Cap the number of proofs emitted per page. Default 40. */
  maxProofs?: number
}

/** Turn extracted leaves into `pageTextContains` proofs (truncated + capped). */
export function leavesToProofs(leaves: string[], opts: ProofGenOptions = {}): ProofType[] {
  const maxLen = opts.maxNeedleLen ?? 60
  const maxProofs = opts.maxProofs ?? 40
  const seen = new Set<string>()
  const proofs: ProofType[] = []
  for (const leaf of leaves) {
    const text = leaf.length > maxLen ? leaf.slice(0, maxLen) : leaf
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    proofs.push({ type: 'pageTextContains', text })
    if (proofs.length >= maxProofs) break
  }
  return proofs
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
  const proofs = leavesToProofs(extractLeaves(entry, opts), opts)
  return {
    name,
    target: route,
    mountProof: { baseline: proofs, target: proofs },
    steps: [{ type: 'navigate', path: route }],
    capture: { name },
  }
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
