/**
 * Per-route attempt — the core of the discovery state machine for ONE route:
 *
 *   goto(route) → [login wall? run auth, retry] → component visible? → done
 *               → else modal? find trigger, click, recheck → done / unreachable
 *
 * It operates on a {@link DiscoveryPage}, so it's fully testable with a scripted
 * fake page; no browser is required to exercise the branching logic.
 */

import type { Step } from '../../types.js'
import type { ComponentNode } from '../graph/types.js'
import type { ComponentGraph } from '../graph/types.js'
import { findTrigger } from './trigger.js'
import { suggestMountProof } from './proof-suggest.js'
import type {
  AttemptLogEntry,
  DiscoverOptions,
  DiscoveryPage,
  DiscoveryResult,
  RouteDef,
} from './types.js'

/** Replace dynamic segments (`[id]`, `[...slug]`, `[[...slug]]`) with values. */
export function fillRoute(path: string, params: Record<string, string> = {}): string {
  return path
    .split('/')
    .map((seg) => {
      let m = seg.match(/^\[\[\.\.\.(.+)\]\]$/) // optional catch-all
      if (m) return params[m[1]] ?? 'sample'
      m = seg.match(/^\[\.\.\.(.+)\]$/) // catch-all
      if (m) return params[m[1]] ?? 'sample'
      m = seg.match(/^\[(.+)\]$/) // dynamic
      if (m) return params[m[1]] ?? '1'
      return seg
    })
    .join('/')
}

export function buildUrl(baseUrl: string, routeDef: RouteDef, params?: Record<string, string>): string {
  const path = fillRoute(routeDef.path, params)
  return baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
}

/** Wait for any of the candidate selectors; resolve the first that appears, or null. */
async function waitForAny(
  page: DiscoveryPage,
  selectors: string[],
  timeoutMs: number,
): Promise<string | null> {
  if (selectors.length === 0) return null
  const per = Math.max(500, Math.floor(timeoutMs / selectors.length))
  for (const selector of selectors) {
    if (await page.waitForSelector(selector, per)) return selector
  }
  return null
}

interface AttemptOutcome {
  result: Omit<DiscoveryResult, 'componentId' | 'attemptLog'> | null
  log: AttemptLogEntry
}

/**
 * Try to reach `node` via a single route. Returns a partial result (null if this
 * route failed) plus one attempt-log entry.
 */
export async function attemptRoute(
  page: DiscoveryPage,
  graph: ComponentGraph,
  node: ComponentNode,
  routeDef: RouteDef,
  selectors: string[],
  opts: DiscoverOptions,
): Promise<AttemptOutcome> {
  const route = routeDef.path
  const timeout = opts.waitTimeoutMs ?? 8000
  const steps: Step[] = []
  let authUsed = false

  const url = buildUrl(opts.baseUrl, routeDef, opts.paramValues)

  // 1. Navigate.
  let finalUrl: string
  try {
    finalUrl = (await page.goto(url)).finalUrl
  } catch (err) {
    return {
      result: { status: 'unreachable', reason: 'navigation-error' },
      log: { route, strategyTried: 'direct', outcome: 'failed', detail: String(err) },
    }
  }
  steps.push({ type: 'navigate', path: fillRoute(route, opts.paramValues) })

  // 2. Login wall?
  if (opts.auth?.isLoginUrl(finalUrl)) {
    await opts.auth.login(page)
    authUsed = true
    try {
      finalUrl = (await page.goto(url)).finalUrl
    } catch (err) {
      return {
        result: { status: 'unreachable', reason: 'navigation-error' },
        log: { route, strategyTried: 'direct-after-auth', outcome: 'failed', detail: String(err) },
      }
    }
    // Re-check the login wall: if auth silently failed we're still gated.
    if (opts.auth.isLoginUrl(finalUrl)) {
      return {
        result: { status: 'unreachable', reason: 'auth-required' },
        log: { route, strategyTried: 'direct-after-auth', outcome: 'failed', detail: 'still on login wall after auth' },
      }
    }
  } else if (!opts.auth && pageLooksLikeLogin(finalUrl)) {
    return {
      result: { status: 'unreachable', reason: 'auth-required' },
      log: { route, strategyTried: 'direct', outcome: 'failed', detail: 'login wall, no auth adapter' },
    }
  }

  // 3. Direct hit?
  const directMatch = await waitForAny(page, selectors, timeout)
  if (directMatch) {
    steps.push({ type: 'waitForSelector', selector: directMatch })
    return {
      result: {
        status: 'reached',
        strategy: authUsed ? 'auth+direct' : 'direct',
        route,
        steps,
        matchedSelector: directMatch,
        mountProof: suggestMountProof(node, directMatch),
      },
      log: { route, strategyTried: authUsed ? 'direct-after-auth' : 'direct', outcome: 'reached' },
    }
  }

  // 4. Modal / overlay — needs a trigger.
  if (node.metadata.isModal) {
    const trigger = findTrigger(graph, node.id, opts.triggerOverrides?.[node.id])
    if (!trigger) {
      return {
        result: { status: 'unreachable', reason: 'no-trigger' },
        log: { route, strategyTried: 'trigger', outcome: 'failed', detail: 'no trigger inferred' },
      }
    }
    await page.click(trigger.selector)
    steps.push({ type: 'click', selector: trigger.selector })
    const afterClick = await waitForAny(page, selectors, timeout)
    if (afterClick) {
      steps.push({ type: 'waitForSelector', selector: afterClick })
      return {
        result: {
          status: 'reached',
          strategy: authUsed ? 'auth+trigger' : 'trigger',
          route,
          steps,
          matchedSelector: afterClick,
          mountProof: suggestMountProof(node, afterClick),
        },
        log: { route, strategyTried: authUsed ? 'auth+trigger' : 'trigger', outcome: 'reached' },
      }
    }
    return {
      result: { status: 'unreachable', reason: 'trigger-clicked-but-not-rendered' },
      log: {
        route,
        strategyTried: 'trigger',
        outcome: 'failed',
        detail: `clicked ${trigger.selector} (${trigger.confidence} confidence)`,
      },
    }
  }

  // 5. Not rendered, not a modal.
  return {
    result: { status: 'unreachable', reason: 'not-rendered-after-navigate' },
    log: { route, strategyTried: 'direct', outcome: 'failed', detail: 'component never appeared' },
  }
}

/** Heuristic login-wall detection when no auth adapter is configured. */
function pageLooksLikeLogin(url: string): boolean {
  return /\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(url)
}
