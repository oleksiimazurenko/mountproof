/**
 * Mount-proof suggestion. Once discovery has reached a component, propose the
 * proof that the right code is mounted — so the emitted trajectory ships with a
 * proof instead of being yet another trust-the-screenshot snapshot.
 *
 * The selector that matched the component during discovery is the strongest
 * available signal, so it becomes a `domSelector` target proof. The caller can
 * review/replace it (see ROADMAP open question on auto-proof aggressiveness).
 */

import type { MountProof } from '../../types.js'
import type { ComponentNode } from '../graph/types.js'

/**
 * Suggest a mount proof for a discovered component. `matchedSelector` is the
 * selector discovery actually waited on; absent that we have nothing concrete to
 * assert and return an empty proof (caller should warn rather than ship blind).
 */
export function suggestMountProof(
  _node: ComponentNode,
  matchedSelector: string | null,
): MountProof {
  if (!matchedSelector) return {}
  return {
    target: [{ type: 'domSelector', selector: matchedSelector }],
  }
}

/** Whether a suggestion ended up empty (no concrete proof could be derived). */
export function isEmptyProof(proof: MountProof): boolean {
  return (proof.target?.length ?? 0) === 0 && (proof.baseline?.length ?? 0) === 0
}
