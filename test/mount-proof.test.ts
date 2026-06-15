import { describe, expect, it } from 'vitest'
import {
  MountProofError,
  type PageLike,
  relaxSelector,
  verifyMountProof,
  verifyMountProofBothSides,
} from '../src/runner/mount-proof.js'
import type { ProofContext, ProofType } from '../src/types.js'

// ─── Fake Page (Playwright-shaped, in-memory) ───────────────────────────────

type FakePageOpts = {
  dom?: Record<string, { textContent?: string; outerHTML?: string }>
  html?: string
  evalResults?: Record<string, unknown>
  url?: string
}

function makePage(opts: FakePageOpts = {}): PageLike {
  const dom = opts.dom ?? {}
  const html = opts.html ?? ''
  const evalResults = opts.evalResults ?? {}
  const url = opts.url ?? 'http://test/'
  return {
    $: async (selector: string) => (selector in dom ? { selector } : null),
    textContent: async (selector: string) => dom[selector]?.textContent ?? null,
    content: async () => html,
    evaluate: async <R>(script: string) => evalResults[script] as R,
    url: () => url,
    $$eval: async <R>(selector: string, _fn: unknown) => {
      const matches = Object.keys(dom).filter(s => s === selector || s.startsWith(selector))
      return matches.slice(0, 5).map(s => dom[s].outerHTML ?? `<el>${s}</el>`) as R
    },
  }
}

function emptyCtx(): ProofContext {
  return { consoleLog: [], requests: [] }
}

// ─── Runners — happy path ───────────────────────────────────────────────────

describe('verifyMountProof — each runner passes when target exists', () => {
  it('domSelector', async () => {
    const page = makePage({ dom: { "[data-component='Header']": {} } })
    await expect(
      verifyMountProof('target', [{ type: 'domSelector', selector: "[data-component='Header']" }], page, emptyCtx()),
    ).resolves.toBeUndefined()
  })

  it('domTag', async () => {
    const page = makePage({ dom: { "style[data-href='header_v3']": {} } })
    await expect(
      verifyMountProof('target', [{ type: 'domTag', selector: "style[data-href='header_v3']" }], page, emptyCtx()),
    ).resolves.toBeUndefined()
  })

  it('domTextContains', async () => {
    const page = makePage({ dom: { '#version': { textContent: 'mounted: v3 (build abc)' } } })
    await expect(
      verifyMountProof('target', [{ type: 'domTextContains', selector: '#version', text: 'v3' }], page, emptyCtx()),
    ).resolves.toBeUndefined()
  })

  it('network', async () => {
    const page = makePage()
    const ctx: ProofContext = { consoleLog: [], requests: [{ url: 'https://app/header-v3.abc.js', status: 200 }] }
    await expect(
      verifyMountProof('target', [{ type: 'network', urlPattern: 'header-v3\\..*\\.js' }], page, ctx),
    ).resolves.toBeUndefined()
  })

  it('console', async () => {
    const page = makePage()
    const ctx: ProofContext = { consoleLog: ['[Header] mounted: v3'], requests: [] }
    await expect(
      verifyMountProof('target', [{ type: 'console', text: 'mounted: v3' }], page, ctx),
    ).resolves.toBeUndefined()
  })

  it('eval', async () => {
    const page = makePage({ evalResults: { 'window.__BUILD_HASH === "ABCD"': true } })
    await expect(
      verifyMountProof('target', [{ type: 'eval', script: 'window.__BUILD_HASH === "ABCD"' }], page, emptyCtx()),
    ).resolves.toBeUndefined()
  })

  it('htmlContains', async () => {
    const page = makePage({ html: '<html><body data-flint-build="v3"></body></html>' })
    await expect(
      verifyMountProof('target', [{ type: 'htmlContains', text: 'data-flint-build="v3"' }], page, emptyCtx()),
    ).resolves.toBeUndefined()
  })
})

// ─── Runners — fail path (the whole point) ──────────────────────────────────

describe('verifyMountProof — each runner THROWS when target is missing', () => {
  it('domTag throws MountProofError with side + failures', async () => {
    const page = makePage() // empty DOM
    const proof: ProofType = { type: 'domTag', selector: "style[data-href='header_v3']" }
    await expect(verifyMountProof('target', [proof], page, emptyCtx())).rejects.toThrow(MountProofError)
    try {
      await verifyMountProof('target', [proof], page, emptyCtx())
    } catch (e) {
      const err = e as MountProofError
      expect(err.side).toBe('target')
      expect(err.failures).toHaveLength(1)
      expect(err.failures[0]).toEqual(proof)
      expect(err.message).toContain('MOUNT_PROOF_FAIL')
      expect(err.message).toContain("style[data-href='header_v3']")
    }
  })

  it('network throws when no request matches', async () => {
    const page = makePage()
    const ctx: ProofContext = { consoleLog: [], requests: [{ url: 'https://app/other.js', status: 200 }] }
    await expect(
      verifyMountProof('target', [{ type: 'network', urlPattern: 'header-v3' }], page, ctx),
    ).rejects.toThrow(MountProofError)
  })

  it('eval throws when script returns falsy', async () => {
    const page = makePage({ evalResults: { 'window.x': 0 } })
    await expect(
      verifyMountProof('target', [{ type: 'eval', script: 'window.x' }], page, emptyCtx()),
    ).rejects.toThrow(MountProofError)
  })

  it('multiple failures accumulate in `failures` array', async () => {
    const page = makePage()
    const proofs: ProofType[] = [
      { type: 'domTag', selector: 'style[data-href="a"]' },
      { type: 'domSelector', selector: '#b' },
      { type: 'htmlContains', text: 'c' },
    ]
    try {
      await verifyMountProof('target', proofs, page, emptyCtx())
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as MountProofError
      expect(err.failures).toHaveLength(3)
    }
  })
})

// ─── Asymmetric baseline/target (Promova case) ─────────────────────────────

describe('verifyMountProofBothSides — asymmetric is the common case', () => {
  it('baseline empty + target with proof → passes when target proof holds', async () => {
    const baseline = makePage() // no proof asked, no DOM needed
    const target = makePage({ dom: { "style[data-href='header_v3']": {} } })
    await expect(
      verifyMountProofBothSides(
        { baseline: [], target: [{ type: 'domTag', selector: "style[data-href='header_v3']" }] },
        { baseline, target },
        { baseline: emptyCtx(), target: emptyCtx() },
      ),
    ).resolves.toBeUndefined()
  })

  it('baseline empty + target with proof → THROWS when target proof missing', async () => {
    const baseline = makePage()
    const target = makePage() // missing the marker
    await expect(
      verifyMountProofBothSides(
        { baseline: [], target: [{ type: 'domTag', selector: "style[data-href='header_v3']" }] },
        { baseline, target },
        { baseline: emptyCtx(), target: emptyCtx() },
      ),
    ).rejects.toThrow(MountProofError)
  })

  it('symmetric: both sides have separate version markers', async () => {
    const baseline = makePage({ dom: { "[data-component='Header'][data-version='v2']": {} } })
    const target = makePage({ dom: { "[data-component='Header'][data-version='v3']": {} } })
    await expect(
      verifyMountProofBothSides(
        {
          baseline: [{ type: 'domSelector', selector: "[data-component='Header'][data-version='v2']" }],
          target: [{ type: 'domSelector', selector: "[data-component='Header'][data-version='v3']" }],
        },
        { baseline, target },
        { baseline: emptyCtx(), target: emptyCtx() },
      ),
    ).resolves.toBeUndefined()
  })

  it('empty proofs object → no-op (caller explicitly asked for no proof on either side)', async () => {
    await expect(
      verifyMountProofBothSides(
        { baseline: [], target: [] },
        { baseline: makePage(), target: makePage() },
        { baseline: emptyCtx(), target: emptyCtx() },
      ),
    ).resolves.toBeUndefined()
  })

  it('undefined mountProof → no-op', async () => {
    await expect(
      verifyMountProofBothSides(
        undefined,
        { baseline: makePage(), target: makePage() },
        { baseline: emptyCtx(), target: emptyCtx() },
      ),
    ).resolves.toBeUndefined()
  })
})

// ─── Diagnostics — error message carries actionable hints ──────────────────

describe('MountProofError diagnostics', () => {
  it('includes page URL in message', async () => {
    const page = makePage({ url: 'http://localhost:3011/uk/foxtrot/quantum-f' })
    try {
      await verifyMountProof('target', [{ type: 'domTag', selector: "style[data-href='header_v3']" }], page, emptyCtx())
    } catch (e) {
      expect((e as MountProofError).message).toContain('http://localhost:3011/uk/foxtrot/quantum-f')
    }
  })

  it('records up to 10 recent console + requests', async () => {
    const page = makePage()
    const ctx: ProofContext = {
      consoleLog: Array.from({ length: 15 }, (_, i) => `line ${i}`),
      requests: Array.from({ length: 15 }, (_, i) => ({ url: `req-${i}`, status: 200 })),
    }
    try {
      await verifyMountProof('target', [{ type: 'domTag', selector: '#missing' }], page, ctx)
    } catch (e) {
      const err = e as MountProofError
      expect(err.diagnostics.recentConsole).toHaveLength(10)
      expect(err.diagnostics.recentRequests).toHaveLength(10)
      expect(err.diagnostics.recentConsole.at(-1)).toBe('line 14')
    }
  })
})

// ─── relaxSelector helper ───────────────────────────────────────────────────

describe('relaxSelector — diagnostic hint generation', () => {
  it("style[data-href='x'] → [original, style[data-href], style]", () => {
    expect(relaxSelector("style[data-href='header_v3']")).toEqual([
      "style[data-href='header_v3']",
      'style[data-href]',
      'style',
    ])
  })

  it('selector without attrs returns just itself', () => {
    expect(relaxSelector('.foo')).toEqual(['.foo'])
  })

  it("[data-component='Header'][data-version='v3'] → drops both values, then both attrs", () => {
    expect(relaxSelector("[data-component='Header'][data-version='v3']")).toEqual([
      "[data-component='Header'][data-version='v3']",
      '[data-component][data-version]',
    ])
  })
})

// ─── Unknown proof type → fail-fast, not silent pass ───────────────────────

describe('verifyMountProof — unknown proof type', () => {
  it('throws MountProofError instead of silently passing', async () => {
    const page = makePage()
    // Cast to bypass TS — simulates a typo in user JSON
    const bogus = [{ type: 'domSeIector', selector: '#x' }] as unknown as ProofType[]
    await expect(verifyMountProof('target', bogus, page, emptyCtx())).rejects.toThrow(MountProofError)
  })
})
