import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseProject } from '../../src/discover/ast/index.js'
import type { ProjectParse } from '../../src/discover/ast/index.js'
import { buildGraph } from '../../src/discover/graph/index.js'
import type { ComponentGraph } from '../../src/discover/graph/index.js'
import type { DiscoveryResult } from '../../src/discover/browse/index.js'
import { emitDiscovery, stableStringify } from '../../src/discover/emit/index.js'
import {
  compareDrift,
  componentFileOf,
  dependencyClosure,
  hasDrift,
  hashAllComponents,
  hashComponent,
  planRediscovery,
} from '../../src/discover/drift/index.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/next-app-tiny', import.meta.url))

function reached(componentId: string, route = '/'): DiscoveryResult {
  const selector = '[data-test-id="x"]'
  return {
    componentId,
    status: 'reached',
    strategy: 'direct',
    route,
    steps: [{ type: 'navigate', path: route }, { type: 'waitForSelector', selector }],
    matchedSelector: selector,
    mountProof: { target: [{ type: 'domSelector', selector }] },
    attemptLog: [{ route, strategyTried: 'direct', outcome: 'reached' }],
  }
}

let project: ProjectParse
let graph: ComponentGraph

beforeEach(async () => {
  project = await parseProject(FIXTURE)
  graph = buildGraph(project)
})

describe('hash', () => {
  it('closure includes transitively imported files', () => {
    const closure = dependencyClosure(project, 'components/Header.tsx')
    expect(closure).toContain('components/Header.tsx')
    expect(closure).toContain('components/PremiumBadge.tsx')
  })

  it('componentFileOf resolves ids and rejects unknowns', () => {
    expect(componentFileOf(project, 'components/Header.tsx:Header')).toBe('components/Header.tsx')
    expect(componentFileOf(project, 'components/Header.tsx:Nope')).toBeNull()
  })

  it('is deterministic and changes when a dependency changes', () => {
    const h1 = hashComponent(project, 'components/Header.tsx:Header')
    const h2 = hashComponent(project, 'components/Header.tsx:Header')
    expect(h1).toBe(h2)

    const mutate = (rel: string) => {
      const real = readFileSync(join(FIXTURE, rel), 'utf8')
      return rel.endsWith('PremiumBadge.tsx') ? real + '\n// changed' : real
    }
    const h3 = hashComponent(project, 'components/Header.tsx:Header', mutate)
    expect(h3).not.toBe(h1)
  })
})

describe('compareDrift', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-drift-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function emitWithHashes(results: DiscoveryResult[]) {
    return emitDiscovery(results, {
      outDir: dir,
      generatedAt: '2026-06-16T00:00:00.000Z',
      sourceHashes: hashAllComponents(project),
    })
  }

  it('reports unchanged when nothing changed', () => {
    emitWithHashes([reached('app/page.tsx:HomePage'), reached('components/PremiumBadge.tsx:PremiumBadge')])
    const cmp = compareDrift(join(dir, 'trajectories'), project, graph)
    expect(cmp.unchanged.map((e) => e.component).sort()).toEqual([
      'app/page.tsx:HomePage',
      'components/PremiumBadge.tsx:PremiumBadge',
    ])
    expect(cmp.stale).toHaveLength(0)
  })

  it('marks a component stale when its source closure changes', () => {
    emitWithHashes([reached('components/PremiumBadge.tsx:PremiumBadge')])
    const mutate = (rel: string) => {
      const real = readFileSync(join(FIXTURE, rel), 'utf8')
      return rel.endsWith('PremiumBadge.tsx') ? real + '\n// changed' : real
    }
    const cmp = compareDrift(join(dir, 'trajectories'), project, graph, mutate)
    expect(cmp.stale.map((e) => e.component)).toContain('components/PremiumBadge.tsx:PremiumBadge')
    expect(cmp.unchanged).toHaveLength(0)
  })

  it('flags orphaned trajectories whose component is gone', () => {
    // Emit a real trajectory first so the directory exists.
    emitWithHashes([reached('app/page.tsx:HomePage')])
    writeFileSync(
      join(dir, 'trajectories', 'old.json'),
      stableStringify({
        name: 'old',
        steps: [],
        capture: { name: 'old' },
        discoveryMetadata: { sourceComponent: 'gone/Old.tsx:Old', sourceHash: 'deadbeef' },
      }),
    )
    const cmp = compareDrift(join(dir, 'trajectories'), project, graph)
    expect(cmp.orphaned.map((e) => e.component)).toContain('gone/Old.tsx:Old')
  })

  it('lists graph components with no trajectory as missing', () => {
    emitWithHashes([reached('app/page.tsx:HomePage')])
    const cmp = compareDrift(join(dir, 'trajectories'), project, graph)
    expect(cmp.missing).toContain('components/Header.tsx:Header')
    expect(cmp.missing).not.toContain('app/page.tsx:HomePage')
  })
})

describe('planRediscovery', () => {
  it('plans stale (+ optionally missing) and orphan deletes', () => {
    const cmp = {
      unchanged: [{ trajectory: 'a', component: 'a.tsx:A' }],
      stale: [{ trajectory: 'b', component: 'b.tsx:B' }],
      orphaned: [{ trajectory: 'c', component: 'c.tsx:C' }],
      missing: ['d.tsx:D'],
    }
    const plan = planRediscovery(cmp)
    expect(plan.rediscover).toEqual(['b.tsx:B'])
    expect(plan.deleteOrphans).toEqual(['c'])
    expect(plan.skipped).toBe(1)

    expect(planRediscovery(cmp, { includeMissing: true }).rediscover).toEqual(['b.tsx:B', 'd.tsx:D'])
    expect(hasDrift(cmp)).toBe(true)
    expect(hasDrift({ unchanged: [], stale: [], orphaned: [], missing: ['x'] })).toBe(false)
    expect(hasDrift({ unchanged: [], stale: [], orphaned: [], missing: ['x'] }, true)).toBe(true)
  })
})
