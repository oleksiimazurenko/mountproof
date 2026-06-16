import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DiscoveryResult } from '../../src/discover/browse/index.js'
import {
  buildUnreachableReport,
  emitDiscovery,
  renderUnreachableMarkdown,
  serializeTrajectory,
  stableStringify,
  writeTrajectoryFile,
} from '../../src/discover/emit/index.js'
import type { EmittedTrajectory } from '../../src/discover/emit/index.js'

const AT = '2026-06-16T10:00:00.000Z'

function reached(componentId: string, route = '/', selector = '[data-test-id="x"]'): DiscoveryResult {
  return {
    componentId,
    status: 'reached',
    strategy: 'trigger',
    route,
    steps: [
      { type: 'navigate', path: route },
      { type: 'click', selector: '[data-test-id="open-x"]' },
      { type: 'waitForSelector', selector },
    ],
    matchedSelector: selector,
    mountProof: { target: [{ type: 'domSelector', selector }] },
    attemptLog: [{ route, strategyTried: 'trigger', outcome: 'reached' }],
  }
}

function unreachable(componentId: string, reason: DiscoveryResult['reason']): DiscoveryResult {
  return { componentId, status: 'unreachable', reason, attemptLog: [] }
}

describe('serializeTrajectory', () => {
  it('produces a trajectory with discovery metadata', () => {
    const t = serializeTrajectory(reached('components/CheckoutModal.tsx:CheckoutModal'), {
      generatedAt: AT,
    })
    expect(t.name).toBe('checkout-modal')
    expect(t.target).toBe('components/CheckoutModal.tsx:CheckoutModal')
    expect(t.capture).toEqual({ name: 'checkout-modal', selector: '[data-test-id="x"]' })
    expect(t.mountProof?.target?.[0]).toMatchObject({ type: 'domSelector' })
    expect(t.discoveryMetadata).toMatchObject({
      generatedAt: AT,
      strategy: 'trigger',
      sourceComponent: 'components/CheckoutModal.tsx:CheckoutModal',
    })
  })

  it('throws on an unreached result', () => {
    expect(() => serializeTrajectory(unreachable('a.tsx:A', 'no-trigger'))).toThrow()
  })
})

describe('stableStringify', () => {
  it('sorts keys so reordered objects serialize identically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })
  it('throws on cyclic input', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    expect(() => stableStringify(o)).toThrow()
  })
})

describe('unreachable report', () => {
  it('lists unreachable components with suggestions, sorted', () => {
    const report = buildUnreachableReport(
      [reached('a.tsx:A'), unreachable('z.tsx:Z', 'auth-required'), unreachable('b.tsx:B', 'no-trigger')],
      AT,
    )
    expect(report.count).toBe(2)
    expect(report.components.map((c) => c.component)).toEqual(['b.tsx:B', 'z.tsx:Z'])
    expect(report.components[0].suggestion).toMatch(/trigger/i)
  })

  it('renders celebratory markdown when nothing is unreachable', () => {
    const md = renderUnreachableMarkdown(buildUnreachableReport([reached('a.tsx:A')], AT))
    expect(md).toMatch(/None/)
  })

  it('renders entries as markdown when there are unreachable components', () => {
    const md = renderUnreachableMarkdown(
      buildUnreachableReport([unreachable('b.tsx:Modal', 'no-trigger')], AT),
    )
    expect(md).toContain('Modal')
    expect(md).toContain('no-trigger')
  })
})

describe('idempotent writes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-emit-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, then leaves unchanged when only the timestamp differs', () => {
    const file = join(dir, 'x.json')
    const t1 = serializeTrajectory(reached('a.tsx:X'), { generatedAt: AT, name: 'x' })
    expect(writeTrajectoryFile(file, t1)).toBe('created')

    const t2 = serializeTrajectory(reached('a.tsx:X'), {
      generatedAt: '2030-01-01T00:00:00.000Z',
      name: 'x',
    })
    expect(writeTrajectoryFile(file, t2)).toBe('unchanged')
    // The original timestamp is preserved (file not rewritten).
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as EmittedTrajectory
    expect(onDisk.discoveryMetadata.generatedAt).toBe(AT)
  })

  it('updates when steps change', () => {
    const file = join(dir, 'x.json')
    writeTrajectoryFile(file, serializeTrajectory(reached('a.tsx:X'), { generatedAt: AT, name: 'x' }))
    const changed = serializeTrajectory(reached('a.tsx:X', '/other'), { generatedAt: AT, name: 'x' })
    expect(writeTrajectoryFile(file, changed)).toBe('updated')
  })
})

describe('emitDiscovery', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-emit-all-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes trajectories, unreachable report, and log; disambiguates names', () => {
    const results = [
      reached('a/CheckoutModal.tsx:CheckoutModal', '/'),
      reached('b/CheckoutModal.tsx:CheckoutModal', '/cart'),
      unreachable('c/Ghost.tsx:Ghost', 'no-route-renders-component'),
    ]
    const summary = emitDiscovery(results, { outDir: dir, generatedAt: AT })

    expect(summary.created).toBe(2)
    const names = summary.trajectories.map((t) => t.name).sort()
    expect(names).toEqual(['checkout-modal', 'checkout-modal-via-cart'])

    expect(existsSync(join(dir, 'trajectories', 'checkout-modal.json'))).toBe(true)
    expect(existsSync(join(dir, 'trajectories', '_unreachable.json'))).toBe(true)
    expect(existsSync(join(dir, 'trajectories', '_unreachable.md'))).toBe(true)
    expect(existsSync(join(dir, '.mountproof', 'discover-log', '2026-06-16.json'))).toBe(true)
    expect(summary.unreachable.count).toBe(1)
  })

  it('merges the unreachable report on a partial (selective) re-run', () => {
    // Full run: HomePage reached, Ghost unreachable.
    emitDiscovery(
      [reached('app/page.tsx:HomePage'), unreachable('c/Ghost.tsx:Ghost', 'no-route-renders-component')],
      { outDir: dir, generatedAt: AT },
    )
    // Partial run re-evaluating only HomePage must NOT drop Ghost from the report.
    emitDiscovery([reached('app/page.tsx:HomePage')], { outDir: dir, generatedAt: AT, partial: true })

    const report = JSON.parse(
      readFileSync(join(dir, 'trajectories', '_unreachable.json'), 'utf8'),
    ) as { components: Array<{ component: string }> }
    expect(report.components.map((c) => c.component)).toContain('c/Ghost.tsx:Ghost')
  })

  it('is idempotent across identical re-runs', () => {
    const results = [reached('a.tsx:X', '/')]
    emitDiscovery(results, { outDir: dir, generatedAt: AT })
    const second = emitDiscovery(results, { outDir: dir, generatedAt: AT })
    expect(second.unchanged).toBe(1)
    expect(second.created).toBe(0)
  })
})
