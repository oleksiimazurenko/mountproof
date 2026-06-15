/**
 * Backward compatibility for legacy Promova trajectory format.
 *
 * Old Promova trajectories use `assertInlineStyle: string[]` — a list of
 * `data-href` values whose `<style data-href="X">` tag must exist on the
 * target side (the `--assert-inline-style` flag in run.sh trajectory).
 *
 * New format uses `mountProof.target: ProofType[]` with explicit proof types.
 *
 * `translateLegacy()` rewrites a Trajectory in place — if it already has a
 * `mountProof`, the legacy field is merged in (legacy entries appended to
 * `mountProof.target`); if it doesn't, a fresh `mountProof.target` is built.
 *
 * No-op for trajectories that don't carry `assertInlineStyle`.
 */

import type { LegacyTrajectory, ProofType, Trajectory } from '../types.js'

export function inlineStyleProofs(hrefs: string[]): ProofType[] {
  return hrefs.map(href => ({
    type: 'domTag' as const,
    selector: `style[data-href='${href}']`,
  }))
}

export function translateLegacy<T extends LegacyTrajectory>(input: T): Trajectory {
  // Clone shallowly so we don't mutate caller's object.
  const out: Trajectory & { assertInlineStyle?: unknown } = { ...input }

  if (input.assertInlineStyle && input.assertInlineStyle.length > 0) {
    const legacyProofs = inlineStyleProofs(input.assertInlineStyle)
    const existingTarget = out.mountProof?.target ?? []
    out.mountProof = {
      ...(out.mountProof ?? {}),
      target: [...existingTarget, ...legacyProofs],
    }
  }

  // Strip the legacy field so downstream consumers see only the new shape.
  delete out.assertInlineStyle

  return out
}
