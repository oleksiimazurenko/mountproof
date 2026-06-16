import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseFile, parseProject } from '../../src/discover/ast/index.js'
import type { ParsedFile, ProjectParse, RouteDef } from '../../src/discover/ast/index.js'
import {
  buildGraph,
  componentId,
  deserializeGraph,
  findRoutesRendering,
  hashProject,
  loadGraph,
  reachableFromRoute,
  saveGraph,
  serializeGraph,
  unreachableComponents,
} from '../../src/discover/graph/index.js'
import type { Edge } from '../../src/discover/graph/index.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/next-app-tiny', import.meta.url))

function hasEdge(edges: Edge[], from: string, to: string): boolean {
  return edges.some((e) => e.from === from && e.to === to)
}

/** Assemble a ProjectParse from inline-parsed files (no disk). */
function project(files: ParsedFile[], routes: RouteDef[] = []): ProjectParse {
  return { root: '.', framework: 'next-app-router', files, routes }
}

describe('buildGraph', () => {
  it('creates a node per component and marks page roots', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    expect(graph.nodes.has('components/Header.tsx:Header')).toBe(true)
    expect(graph.nodes.get('components/Header.tsx:Header')?.isRouteRoot).toBe(false)
    expect(graph.nodes.get('app/page.tsx:HomePage')?.isRouteRoot).toBe(true)
  })

  it('resolves default and named imports into edges', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const e = graph.edges
    // named import: <Header/> in page.tsx
    expect(hasEdge(e, 'app/page.tsx:HomePage', 'components/Header.tsx:Header')).toBe(true)
    // default import: <ProductCard/> in page.tsx
    expect(hasEdge(e, 'app/page.tsx:HomePage', 'components/ProductCard.tsx:ProductCard')).toBe(true)
    // default import deeper: Header -> PremiumBadge, ProductCard -> PremiumBadge
    expect(hasEdge(e, 'components/Header.tsx:Header', 'components/PremiumBadge.tsx:PremiumBadge')).toBe(true)
    expect(
      hasEdge(e, 'components/ProductCard.tsx:ProductCard', 'components/PremiumBadge.tsx:PremiumBadge'),
    ).toBe(true)
  })

  it('carries the conditional context onto edges', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const badgeEdge = graph.edges.find(
      (e) => e.from === 'components/Header.tsx:Header' && e.to === 'components/PremiumBadge.tsx:PremiumBadge',
    )
    expect(badgeEdge?.conditional).toBe('if-block')
  })

  it('does not create edges to unresolved (bare-package) imports', () => {
    const f = parseFile(
      'C.tsx',
      `import { Button } from 'some-ui-lib'\nexport function C(){ return <div><Button/></div> }`,
    )
    const graph = buildGraph(project([f]))
    expect(graph.edges).toHaveLength(0)
  })

  it('forms edges from an anonymous default-export component', () => {
    const page = parseFile(
      'app/page.tsx',
      `import Child from '../components/Child'\nexport default () => <main><Child/></main>`,
    )
    const child = parseFile('components/Child.tsx', `export default function Child(){ return <div/> }`)
    const graph = buildGraph(project([page, child]))
    // anonymous default is named after the file → "Page"
    expect(graph.nodes.has('app/page.tsx:Page')).toBe(true)
    expect(hasEdge(graph.edges, 'app/page.tsx:Page', 'components/Child.tsx:Child')).toBe(true)
  })

  it('resolves an aliased named re-export (export { Foo as Bar })', () => {
    const lib = parseFile(
      'lib/Foo.tsx',
      `function Foo(){ return <div/> }\nexport { Foo as Bar }`,
    )
    const page = parseFile(
      'app/page.tsx',
      `import { Bar } from '../lib/Foo'\nexport default function HomePage(){ return <Bar/> }`,
    )
    const graph = buildGraph(project([lib, page]))
    expect(hasEdge(graph.edges, 'app/page.tsx:HomePage', 'lib/Foo.tsx:Foo')).toBe(true)
  })
})

describe('findRoutesRendering', () => {
  it('finds every route that renders a deeply-nested component', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const results = findRoutesRendering(graph, 'components/PremiumBadge.tsx:PremiumBadge')
    const routes = results.map((r) => r.route)
    expect(routes).toContain('/')
    expect(routes).toContain('/products/[id]')
    // Every chain starts at a route root and ends at the target.
    for (const r of results) {
      expect(r.chain[r.chain.length - 1]).toBe('components/PremiumBadge.tsx:PremiumBadge')
      expect(graph.nodes.get(r.chain[0])?.isRouteRoot).toBe(true)
    }
  })

  it('returns a length-1 chain when the target is itself a route root', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const results = findRoutesRendering(graph, 'app/page.tsx:HomePage')
    const home = results.find((r) => r.route === '/')
    expect(home?.chain).toEqual(['app/page.tsx:HomePage'])
  })

  it('returns nothing for an unknown component id', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    expect(findRoutesRendering(graph, 'nope.tsx:Nope')).toEqual([])
  })
})

describe('reachability', () => {
  it('reachableFromRoute collects the whole subtree', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const reached = reachableFromRoute(graph, '/')
    expect(reached.has('app/page.tsx:HomePage')).toBe(true)
    expect(reached.has('components/Header.tsx:Header')).toBe(true)
    expect(reached.has('components/PremiumBadge.tsx:PremiumBadge')).toBe(true)
  })

  it('flags components rendered by no route as orphans', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    // layout.tsx is not a page route and is rendered by nothing in the graph.
    expect(unreachableComponents(graph)).toContain('app/layout.tsx:RootLayout')
  })
})

describe('annotate', () => {
  it('detects auth-gated components from auth-hook imports', () => {
    const f = parseFile(
      'Account.tsx',
      `import { useAuth } from './auth'\nexport default function Account(){ useAuth(); return <div/> }`,
    )
    const graph = buildGraph(project([f]))
    expect(graph.nodes.get('Account.tsx:Account')?.metadata.authGated).toBe(true)
  })

  it('detects premium-gated components from entitlement-hook imports', () => {
    const f = parseFile(
      'Pro.tsx',
      `import { usePremium } from './billing'\nexport default function Pro(){ usePremium(); return <div/> }`,
    )
    const graph = buildGraph(project([f]))
    expect(graph.nodes.get('Pro.tsx:Pro')?.metadata.premiumGated).toBe(true)
  })

  it('detects modals by name and by rendered Dialog', () => {
    const byName = parseFile('CheckoutModal.tsx', `export default function CheckoutModal(){ return <div/> }`)
    const byChild = parseFile(
      'Confirm.tsx',
      `import { Dialog } from './ui'\nexport default function Confirm(){ return <Dialog>ok</Dialog> }`,
    )
    const graph = buildGraph(project([byName, byChild]))
    expect(graph.nodes.get('CheckoutModal.tsx:CheckoutModal')?.metadata.isModal).toBe(true)
    expect(graph.nodes.get('Confirm.tsx:Confirm')?.metadata.isModal).toBe(true)
  })

  it('tags react framework on nodes', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    expect(graph.nodes.get('components/Header.tsx:Header')?.metadata.framework).toBe('react')
  })
})

describe('cache', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-graph-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('hashes deterministically for identical input', async () => {
    const p = await parseProject(FIXTURE)
    expect(hashProject(p)).toBe(hashProject(p))
  })

  it('round-trips through serialize/deserialize', async () => {
    const graph = buildGraph(await parseProject(FIXTURE))
    const restored = deserializeGraph(serializeGraph(graph))
    expect(restored.nodes.size).toBe(graph.nodes.size)
    expect(restored.edges.length).toBe(graph.edges.length)
    expect(restored.routes.size).toBe(graph.routes.size)
  })

  it('saves and loads when the hash matches, returns null on mismatch', async () => {
    const p = await parseProject(FIXTURE)
    const graph = buildGraph(p)
    saveGraph(dir, p, graph)

    const loaded = loadGraph(dir, p)
    expect(loaded?.nodes.size).toBe(graph.nodes.size)

    const mutated: ProjectParse = { ...p, framework: 'remix' }
    expect(loadGraph(dir, mutated)).toBeNull()
  })

  it('componentId composes file and name', () => {
    expect(componentId('a/b.tsx', 'X')).toBe('a/b.tsx:X')
  })
})
