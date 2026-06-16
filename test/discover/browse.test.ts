import { describe, expect, it } from 'vitest'

import { parseFile } from '../../src/discover/ast/index.js'
import type { ParsedFile, ProjectParse, RouteDef } from '../../src/discover/ast/index.js'
import { buildGraph } from '../../src/discover/graph/index.js'
import type { ComponentGraph, ComponentNode } from '../../src/discover/graph/index.js'
import {
  buildUrl,
  discoverComponent,
  fillRoute,
  findTrigger,
  formLoginAdapter,
  isEmptyProof,
  suggestMountProof,
  synthesizeSelectors,
} from '../../src/discover/browse/index.js'
import type { DiscoveryPage } from '../../src/discover/browse/index.js'

const BASE = 'http://localhost:3000'

interface Script {
  onGoto?: (url: string, page: FakePage) => string
  onClick?: (selector: string, page: FakePage) => void
}

/** Scriptable DiscoveryPage for unit-testing the discovery state machine. */
class FakePage implements DiscoveryPage {
  url = 'about:blank'
  authed = false
  visible = new Set<string>()
  navigations: string[] = []
  clicks: string[] = []
  fills: Array<[string, string]> = []

  constructor(private script: Script = {}) {}

  async goto(url: string): Promise<{ finalUrl: string }> {
    this.navigations.push(url)
    const finalUrl = this.script.onGoto?.(url, this) ?? url
    this.url = finalUrl
    return { finalUrl }
  }
  async waitForSelector(selector: string): Promise<boolean> {
    return this.visible.has(selector)
  }
  async click(selector: string): Promise<void> {
    this.clicks.push(selector)
    this.script.onClick?.(selector, this)
  }
  async fill(selector: string, value: string): Promise<void> {
    this.fills.push([selector, value])
  }
  currentUrl(): string {
    return this.url
  }
}

function project(files: ParsedFile[], routes: RouteDef[]): ProjectParse {
  return { root: '.', framework: 'next-app-router', files, routes }
}

function route(path: string, file: string, component: string): RouteDef {
  return { path, file, component, dynamicSegments: [] }
}

describe('fillRoute / buildUrl', () => {
  it('fills dynamic, catch-all, and optional segments', () => {
    expect(fillRoute('/products/[id]', { id: '42' })).toBe('/products/42')
    expect(fillRoute('/products/[id]')).toBe('/products/1')
    expect(fillRoute('/blog/[...slug]')).toBe('/blog/sample')
    expect(fillRoute('/')).toBe('/')
  })

  it('joins base and path without double slashes', () => {
    expect(buildUrl('http://x/', route('/a', 'f', 'C'))).toBe('http://x/a')
    expect(buildUrl('http://x', route('/products/[id]', 'f', 'C'), { id: '9' })).toBe(
      'http://x/products/9',
    )
  })
})

const fakeNode = (name: string): ComponentNode => ({ name } as unknown as ComponentNode)

describe('synthesizeSelectors', () => {
  it('orders test-id selectors first and honors overrides', () => {
    const sels = synthesizeSelectors(fakeNode('CheckoutModal'), ['#explicit'])
    expect(sels[0]).toBe('#explicit')
    expect(sels).toContain('[data-test-id="checkout-modal"]')
  })
})

describe('proof suggestion', () => {
  it('suggests a domSelector proof from the matched selector', () => {
    const node = fakeNode('X')
    const proof = suggestMountProof(node, '[data-test-id="x"]')
    expect(proof.target).toEqual([{ type: 'domSelector', selector: '[data-test-id="x"]' }])
    expect(isEmptyProof(proof)).toBe(false)
    expect(isEmptyProof(suggestMountProof(node, null))).toBe(true)
  })
})

describe('discoverComponent — direct', () => {
  it('reaches a component visible right after navigation', () => {
    const page = new FakePage()
    const home = parseFile(
      'app/page.tsx',
      `export default function HomePage(){ return <main>hi</main> }`,
    )
    const graph = buildGraph(project([home], [route('/', 'app/page.tsx', 'HomePage')]))
    const sels = synthesizeSelectors(graph.nodes.get('app/page.tsx:HomePage')!)
    page.script = { onGoto: (_u, p) => { p.visible.add(sels[0]); return _u } }

    return discoverComponent(page, graph, 'app/page.tsx:HomePage', { baseUrl: BASE }).then((r) => {
      expect(r.status).toBe('reached')
      expect(r.strategy).toBe('direct')
      expect(r.matchedSelector).toBe(sels[0])
      expect(r.steps?.[0]).toEqual({ type: 'navigate', path: '/' })
      expect(r.mountProof?.target?.[0]).toMatchObject({ type: 'domSelector' })
    })
  })

  it('reports navigation-error when navigation throws', async () => {
    const home = parseFile('app/page.tsx', `export default function HomePage(){ return <main/> }`)
    const graph = buildGraph(project([home], [route('/', 'app/page.tsx', 'HomePage')]))
    const page = new FakePage({
      onGoto: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const r = await discoverComponent(page, graph, 'app/page.tsx:HomePage', { baseUrl: BASE })
    expect(r.status).toBe('unreachable')
    expect(r.reason).toBe('navigation-error')
  })

  it('marks no-route-renders-component when nothing renders it', () => {
    const page = new FakePage()
    const orphan = parseFile('Lonely.tsx', `export default function Lonely(){ return <div/> }`)
    const graph = buildGraph(project([orphan], []))
    return discoverComponent(page, graph, 'Lonely.tsx:Lonely', { baseUrl: BASE }).then((r) => {
      expect(r.status).toBe('unreachable')
      expect(r.reason).toBe('no-route-renders-component')
    })
  })
})

describe('discoverComponent — modal trigger', () => {
  function modalGraph(conditional: 'gated' | 'unconditional'): ComponentGraph {
    const page = parseFile(
      'app/page.tsx',
      conditional === 'gated'
        ? `import Modal from '../components/CheckoutModal'\nexport default function HomePage(){ return <main>{open && <Modal/>}</main> }`
        : `import Modal from '../components/CheckoutModal'\nexport default function HomePage(){ return <main><Modal/></main> }`,
    )
    const modal = parseFile(
      'components/CheckoutModal.tsx',
      `export default function CheckoutModal(){ return <div/> }`,
    )
    return buildGraph(project([page, modal], [route('/', 'app/page.tsx', 'HomePage')]))
  }

  it('clicks an inferred trigger to reveal a gated modal', async () => {
    const graph = modalGraph('gated')
    const id = 'components/CheckoutModal.tsx:CheckoutModal'
    const modalSel = synthesizeSelectors(graph.nodes.get(id)!)[0]
    const triggerSel = '[data-test-id="open-checkout-modal"]'

    const page = new FakePage({
      onClick: (sel, p) => {
        if (sel === triggerSel) p.visible.add(modalSel)
      },
    })

    const r = await discoverComponent(page, graph, id, { baseUrl: BASE })
    expect(r.status).toBe('reached')
    expect(r.strategy).toBe('trigger')
    expect(page.clicks).toContain(triggerSel)
    expect(r.steps?.some((s) => s.type === 'click' && s.selector === triggerSel)).toBe(true)
  })

  it('reports no-trigger when a modal has no gating parent', async () => {
    const graph = modalGraph('unconditional')
    const id = 'components/CheckoutModal.tsx:CheckoutModal'
    const page = new FakePage() // modal never becomes visible
    const r = await discoverComponent(page, graph, id, { baseUrl: BASE })
    expect(r.status).toBe('unreachable')
    expect(r.reason).toBe('no-trigger')
  })
})

describe('findTrigger', () => {
  it('prefers an explicit override at high confidence', () => {
    const page = parseFile(
      'app/page.tsx',
      `import Modal from '../components/CheckoutModal'\nexport default function HomePage(){ return <main>{open && <Modal/>}</main> }`,
    )
    const modal = parseFile('components/CheckoutModal.tsx', `export default function CheckoutModal(){ return <div/> }`)
    const graph = buildGraph(project([page, modal], [route('/', 'app/page.tsx', 'HomePage')]))
    const t = findTrigger(graph, 'components/CheckoutModal.tsx:CheckoutModal', '#open')
    expect(t).toMatchObject({ selector: '#open', confidence: 'high' })
  })
})

describe('discoverComponent — auth', () => {
  function authGraph(): ComponentGraph {
    const page = parseFile(
      'app/account/page.tsx',
      `import Dashboard from '../../components/Dashboard'\nexport default function AccountPage(){ return <main><Dashboard/></main> }`,
    )
    const dash = parseFile('components/Dashboard.tsx', `export default function Dashboard(){ return <div/> }`)
    return buildGraph(project([page, dash], [route('/account', 'app/account/page.tsx', 'AccountPage')]))
  }

  it('runs the auth adapter on a login wall, then reaches the component', async () => {
    const graph = authGraph()
    const id = 'components/Dashboard.tsx:Dashboard'
    const dashSel = synthesizeSelectors(graph.nodes.get(id)!)[0]

    const page = new FakePage({
      onGoto: (url, p) => {
        if (url.includes('/account') && !p.authed) return `${BASE}/login`
        if (url.includes('/account') && p.authed) {
          p.visible.add(dashSel)
          return url
        }
        return url
      },
      onClick: (sel, p) => {
        if (sel === 'button[type="submit"]') p.authed = true
      },
    })

    const auth = formLoginAdapter({
      loginUrlPattern: /\/login/,
      email: 'a@b.c',
      password: 'pw',
    })

    const r = await discoverComponent(page, graph, id, { baseUrl: BASE, auth })
    expect(r.status).toBe('reached')
    expect(r.strategy).toBe('auth+direct')
    expect(page.fills).toContainEqual(['input[type="email"]', 'a@b.c'])
  })

  it('reports auth-required when login fails to clear the wall', async () => {
    const graph = authGraph()
    const id = 'components/Dashboard.tsx:Dashboard'
    const page = new FakePage({ onGoto: () => `${BASE}/login` }) // never clears, even after login
    const auth = formLoginAdapter({ loginUrlPattern: /\/login/, email: 'a@b.c', password: 'pw' })
    const r = await discoverComponent(page, graph, id, { baseUrl: BASE, auth })
    expect(r.status).toBe('unreachable')
    expect(r.reason).toBe('auth-required')
  })

  it('marks auth-required when a login wall has no adapter', async () => {
    const graph = authGraph()
    const id = 'components/Dashboard.tsx:Dashboard'
    const page = new FakePage({ onGoto: (url) => (url.includes('/account') ? `${BASE}/login` : url) })
    const r = await discoverComponent(page, graph, id, { baseUrl: BASE })
    expect(r.status).toBe('unreachable')
    expect(r.reason).toBe('auth-required')
  })
})
