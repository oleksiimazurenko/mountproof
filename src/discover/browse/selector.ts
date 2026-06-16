/**
 * Selector synthesis. Given a component, produce an ordered list of candidate
 * CSS selectors to wait for, most-stable first — mirroring Playwright codegen's
 * priority (test ids → semantic attributes → class/name fallbacks).
 *
 * Without a rendered DOM we can't observe the actual attributes, so candidates
 * are derived from the component name (kebab + Pascal forms). Explicit overrides
 * (from config) always win and come first.
 */

import type { ComponentNode } from '../graph/types.js'

/** `CheckoutModal` → `checkout-modal`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

/**
 * Ordered candidate selectors for a component node. Overrides are honored first;
 * the rest are name-derived guesses in descending stability order.
 */
export function synthesizeSelectors(node: ComponentNode, overrides?: string[]): string[] {
  const kebab = kebabCase(node.name)
  const candidates = [
    ...(overrides ?? []),
    `[data-test-id="${kebab}"]`,
    `[data-testid="${kebab}"]`,
    `[data-cy="${kebab}"]`,
    `[data-component="${node.name}"]`,
    `.${kebab}`,
  ]
  // De-dup while preserving order.
  return [...new Set(candidates)]
}
