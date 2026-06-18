/**
 * Strapi version detection + response normalization.
 *
 * Don't assume baseline=v4: a prod instance may already be on v5 after the
 * migration merges. Detect from the response SHAPE of the instance itself (not a
 * proxy, which may re-wrap), and normalize both shapes to a flat entry so parity
 * compares like with like.
 *
 *   v4 entry: { id, attributes: { ...fields } }
 *   v5 entry: { id, documentId, ...fields }    (flat)
 */

import type { StrapiVersion } from './types.js'

type Entry = Record<string, unknown>

/** Infer the Strapi major version from a single entry's shape, or null if unknown. */
export function inferVersionFromEntry(entry: unknown): StrapiVersion | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Entry
  if ('documentId' in e) return 5
  if ('attributes' in e && e.attributes && typeof e.attributes === 'object') return 4
  return null
}

/** Pull the first entry out of either a collection (`data[]`) or single-type (`data`) response. */
export function firstEntry(response: unknown): unknown {
  if (!response || typeof response !== 'object') return null
  const data = (response as { data?: unknown }).data
  if (Array.isArray(data)) return data[0] ?? null
  return data ?? null
}

/**
 * Flatten an entry to `{ ...fields }` regardless of version: v4's `attributes`
 * wrapper is spread up; v5 is already flat. Identity/timestamp keys are dropped
 * by default so parity compares only content fields.
 */
export function flattenEntry(entry: unknown, opts: { keepMeta?: boolean } = {}): Entry {
  if (!entry || typeof entry !== 'object') return {}
  const e = { ...(entry as Entry) }
  const attributes = e.attributes
  let flat: Entry
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const { attributes: _drop, ...rest } = e
    void _drop
    flat = { ...rest, ...(attributes as Entry) }
  } else {
    flat = e
  }
  if (!opts.keepMeta) {
    for (const k of ['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale']) {
      delete flat[k]
    }
  }
  return flat
}

/**
 * Probe a running instance to detect its version. Fetches `<baseUrl><probePath>`
 * (a collection endpoint) and infers from the first entry. Returns null if the
 * request fails or the shape is unrecognizable.
 */
export async function detectStrapiVersion(
  baseUrl: string,
  probePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StrapiVersion | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${probePath}`)
    if (!res.ok) return null
    const json = await res.json()
    return inferVersionFromEntry(firstEntry(json))
  } catch {
    return null
  }
}
