/**
 * Unreachable report — for every component discovery couldn't reach, record why
 * and what the user can do about it. These are review artifacts (a human reads
 * them to add a test-id, fix auth, or write a manual trajectory) as much as
 * machine inputs, so we emit both JSON and Markdown.
 */

import type { DiscoveryResult, UnreachableReason } from '../browse/types.js'
import { componentNameOf } from './serialize.js'

export interface UnreachableEntry {
  component: string
  reason: UnreachableReason | 'unknown'
  attemptedRoutes: string[]
  suggestion: string
}

export interface UnreachableReport {
  generatedAt: string
  count: number
  components: UnreachableEntry[]
}

const SUGGESTIONS: Record<UnreachableReason, string> = {
  'no-route-renders-component':
    'No route renders this component. It may be dead UI, rendered via a portal, or only used in tests — add a manual trajectory if it should be covered.',
  'auth-required':
    'Hit a login wall and no auth adapter was configured. Pass --auth or a profile dir so discovery can sign in.',
  'not-rendered-after-navigate':
    'Navigated but the component never appeared. Add a stable data-test-id, or increase --wait-timeout if it loads slowly.',
  'no-trigger':
    'Looks like a modal/overlay but no trigger could be inferred. Add a triggerOverride selector for this component.',
  'trigger-clicked-but-not-rendered':
    'Clicked the inferred trigger but the component did not render. The trigger guess was likely wrong — set an explicit triggerOverride.',
  'navigation-error':
    'Navigation threw. Check the dev server is up and the route is valid.',
}

function suggestionFor(reason: UnreachableReason | undefined): string {
  if (!reason) return 'Unknown failure — see the discover log for the attempt trace.'
  return SUGGESTIONS[reason]
}

/** Build the unreachable report from the full result set (reached ones ignored). */
export function buildUnreachableReport(
  results: DiscoveryResult[],
  generatedAt: string,
): UnreachableReport {
  const components: UnreachableEntry[] = results
    .filter((r) => r.status === 'unreachable')
    .map((r): UnreachableEntry => ({
      component: r.componentId,
      reason: r.reason ?? 'unknown',
      attemptedRoutes: r.attemptLog.map((a) => a.route),
      suggestion: suggestionFor(r.reason),
    }))
    .sort((a, b) => a.component.localeCompare(b.component))

  return { generatedAt, count: components.length, components }
}

/** Render the report as human-readable Markdown. */
export function renderUnreachableMarkdown(report: UnreachableReport): string {
  if (report.count === 0) return '# Unreachable components\n\nNone — every component was reached. 🎉\n'

  const lines = [`# Unreachable components (${report.count})`, '']
  for (const entry of report.components) {
    lines.push(`## \`${componentNameOf(entry.component)}\``)
    lines.push(`- **id:** \`${entry.component}\``)
    lines.push(`- **reason:** \`${entry.reason}\``)
    if (entry.attemptedRoutes.length) {
      lines.push(`- **attempted routes:** ${entry.attemptedRoutes.map((r) => `\`${r}\``).join(', ')}`)
    }
    lines.push(`- **suggestion:** ${entry.suggestion}`)
    lines.push('')
  }
  return lines.join('\n')
}
