/**
 * Route extraction. Phase A covers Next.js App Router: routes are derived from
 * the filesystem positions of `app/**​/page.{tsx,jsx,ts,js}` files.
 *
 * Normalization rules (matching Next's own routing):
 *   - route groups `(marketing)` are stripped from the URL
 *   - private folders `_internal` opt out of routing (skipped)
 *   - parallel/intercepting segments (`@slot`, `(.)`) are skipped
 *   - dynamic `[id]`, catch-all `[...slug]`, optional catch-all `[[...slug]]`
 *     are kept verbatim and their parameter names collected
 *
 * Other frameworks return `[]` for now (recognized, extractor pending).
 */

import type { Framework, ParsedFile, RouteDef } from './types.js'

const PAGE_FILE = /\/page\.(tsx|jsx|ts|js)$/

/** Find the route segments between the `app` dir and the page file. */
function appSegments(relPath: string): string[] | null {
  const parts = relPath.split('/')
  // Accept `app/...` or `src/app/...`.
  let appIdx = -1
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'app' && (i === 0 || parts[i - 1] === 'src')) {
      appIdx = i
      break
    }
  }
  if (appIdx === -1) return null
  // Segments between app/ and the final `page.ext`.
  return parts.slice(appIdx + 1, parts.length - 1)
}

interface NormalizedRoute {
  path: string
  dynamicSegments: string[]
}

/** Turn route segments into a URL path + dynamic params, or null if non-routable. */
function normalize(segments: string[]): NormalizedRoute | null {
  const out: string[] = []
  const dynamicSegments: string[] = []

  for (const seg of segments) {
    if (!seg) continue
    // Route group: (marketing) — stripped from the URL entirely.
    if (seg.startsWith('(') && seg.endsWith(')')) continue
    // Private folder: _components — opts out of routing.
    if (seg.startsWith('_')) return null
    // Parallel route slot: @modal — not part of the URL path.
    if (seg.startsWith('@')) continue

    const dyn = seg.match(/^\[+(\.\.\.)?([^\]]+?)\]+$/)
    if (dyn) {
      dynamicSegments.push(dyn[2])
      out.push(seg)
    } else {
      out.push(seg)
    }
  }

  return { path: '/' + out.join('/'), dynamicSegments }
}

function defaultComponentName(file: ParsedFile): string | null {
  const def = file.componentDefs.find((d) => d.isDefault) ?? file.componentDefs[0]
  return def ? def.name : null
}

export function extractRoutes(files: ParsedFile[], framework: Framework): RouteDef[] {
  if (framework !== 'next-app-router') return []

  const routes: RouteDef[] = []
  for (const file of files) {
    if (!PAGE_FILE.test(file.file)) continue
    const segments = appSegments(file.file)
    if (segments === null) continue
    const normalized = normalize(segments)
    if (normalized === null) continue
    routes.push({
      path: normalized.path === '/' ? '/' : normalized.path.replace(/\/$/, ''),
      file: file.file,
      component: defaultComponentName(file),
      dynamicSegments: normalized.dynamicSegments,
    })
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path))
}
