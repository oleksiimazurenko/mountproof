import { describe, expect, it } from 'vitest'
import { inlineStyleProofs, translateLegacy } from '../src/runner/legacy-translate.js'
import type { LegacyTrajectory } from '../src/types.js'

describe('inlineStyleProofs', () => {
  it('builds correct domTag proofs from data-href values', () => {
    expect(inlineStyleProofs(['header_v3', 'checkout_v2'])).toEqual([
      { type: 'domTag', selector: "style[data-href='header_v3']" },
      { type: 'domTag', selector: "style[data-href='checkout_v2']" },
    ])
  })

  it('empty input → empty output', () => {
    expect(inlineStyleProofs([])).toEqual([])
  })
})

describe('translateLegacy', () => {
  const baseLegacy: LegacyTrajectory = {
    name: 'pgs-5621-header-v3',
    steps: [{ type: 'navigate', path: '/uk/foxtrot/quantum-f' }],
    capture: { name: 'quantum-header-v3' },
    assertInlineStyle: ['header_v3'],
  }

  it('moves assertInlineStyle into mountProof.target', () => {
    const out = translateLegacy(baseLegacy) as { mountProof?: { target?: unknown[] }; assertInlineStyle?: unknown }
    expect(out.mountProof).toEqual({
      target: [{ type: 'domTag', selector: "style[data-href='header_v3']" }],
    })
    expect(out.assertInlineStyle).toBeUndefined()
  })

  it('merges with existing mountProof.target (legacy entries appended)', () => {
    const input: LegacyTrajectory = {
      ...baseLegacy,
      mountProof: {
        baseline: [{ type: 'domSelector', selector: "[data-version='v2']" }],
        target: [{ type: 'domSelector', selector: "[data-version='v3']" }],
      },
    }
    const out = translateLegacy(input)
    expect(out.mountProof?.target).toEqual([
      { type: 'domSelector', selector: "[data-version='v3']" },
      { type: 'domTag', selector: "style[data-href='header_v3']" },
    ])
    expect(out.mountProof?.baseline).toEqual([{ type: 'domSelector', selector: "[data-version='v2']" }])
  })

  it('no assertInlineStyle → trajectory passes through unchanged', () => {
    const input: LegacyTrajectory = {
      name: 't',
      steps: [],
      capture: { name: 'c' },
    }
    const out = translateLegacy(input)
    expect(out).toEqual({ name: 't', steps: [], capture: { name: 'c' } })
  })

  it('empty assertInlineStyle array → no mountProof added', () => {
    const input: LegacyTrajectory = { ...baseLegacy, assertInlineStyle: [] }
    const out = translateLegacy(input) as { mountProof?: unknown; assertInlineStyle?: unknown }
    expect(out.mountProof).toBeUndefined()
    expect(out.assertInlineStyle).toBeUndefined()
  })

  it('does not mutate input', () => {
    const input: LegacyTrajectory = { ...baseLegacy }
    const before = JSON.stringify(input)
    translateLegacy(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('multiple assertInlineStyle entries → each becomes a proof', () => {
    const input: LegacyTrajectory = {
      ...baseLegacy,
      assertInlineStyle: ['header_v3', 'sidebar_v2', 'footer_v1'],
    }
    const out = translateLegacy(input)
    expect(out.mountProof?.target).toHaveLength(3)
    expect(out.mountProof?.target?.[1]).toEqual({
      type: 'domTag',
      selector: "style[data-href='sidebar_v2']",
    })
  })
})
