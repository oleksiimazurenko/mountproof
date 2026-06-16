import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  detectFramework,
  extractRoutes,
  parseFile,
  parseProject,
  walkSourceFiles,
} from '../../src/discover/ast/index.js'
import type { ComponentUsage, RouteDef } from '../../src/discover/ast/index.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/next-app-tiny', import.meta.url))

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/next-app-tiny/${rel}`, import.meta.url)), 'utf8')
}

function usage(usages: ComponentUsage[], child: string): ComponentUsage | undefined {
  return usages.find((u) => u.child === child)
}

function route(routes: RouteDef[], path: string): RouteDef | undefined {
  return routes.find((r) => r.path === path)
}

describe('detectFramework', () => {
  it('identifies a Next.js App Router project', () => {
    const { framework, evidence } = detectFramework(FIXTURE)
    expect(framework).toBe('next-app-router')
    expect(evidence.join(' ')).toContain('next')
    expect(evidence.join(' ')).toContain('app/')
  })

  it('returns unknown for a directory with no signals', () => {
    const { framework } = detectFramework(fileURLToPath(new URL('.', import.meta.url)))
    expect(framework).toBe('unknown')
  })
})

describe('walkSourceFiles', () => {
  // The fixture's own .gitignore lists `generated/`, so git won't commit a real
  // file there. Create it hermetically so the gitignore-respect assertions hold
  // on a fresh clone / in CI, and remove it afterwards.
  const generatedDir = join(FIXTURE, 'generated')
  beforeAll(() => {
    mkdirSync(generatedDir, { recursive: true })
    writeFileSync(join(generatedDir, 'Ignored.tsx'), 'export default function Ignored(){return null}\n')
  })
  afterAll(() => {
    rmSync(generatedDir, { recursive: true, force: true })
  })

  it('finds source files and excludes build/ (default ignore) and gitignored dirs', async () => {
    const files = await walkSourceFiles(FIXTURE)
    expect(files).toContain('app/page.tsx')
    expect(files).toContain('components/Header.tsx')
    expect(files).toContain('app/products/[id]/page.tsx')

    // build/ is in the default ignore set.
    expect(files.some((f) => f.startsWith('build/'))).toBe(false)
    // generated/ is listed in the fixture .gitignore.
    expect(files.some((f) => f.startsWith('generated/'))).toBe(false)
  })

  it('can be told to ignore the project gitignore', async () => {
    const files = await walkSourceFiles(FIXTURE, { respectGitignore: false })
    expect(files.some((f) => f.startsWith('generated/'))).toBe(true)
    // build/ is still excluded by the default ignore set.
    expect(files.some((f) => f.startsWith('build/'))).toBe(false)
  })
})

describe('extractComponents (via parseFile)', () => {
  it('extracts an exported function component with file/line/flags', () => {
    const parsed = parseFile('components/Header.tsx', read('components/Header.tsx'))
    expect(parsed.parseErrors).toEqual([])
    const defs = parsed.componentDefs
    expect(defs).toHaveLength(1)
    const header = defs[0]
    expect(header.name).toBe('Header')
    expect(header.file).toBe('components/Header.tsx')
    expect(header.kind).toBe('function')
    expect(header.exported).toBe(true)
    expect(header.isDefault).toBe(false)
    expect(header.line).toBeGreaterThan(0)
  })

  it('marks a default-exported arrow component (const + export default X)', () => {
    const parsed = parseFile('components/ProductCard.tsx', read('components/ProductCard.tsx'))
    const def = parsed.componentDefs.find((d) => d.name === 'ProductCard')
    expect(def).toBeDefined()
    expect(def?.kind).toBe('arrow')
    expect(def?.exported).toBe(true)
    expect(def?.isDefault).toBe(true)
  })

  it('marks a default-exported function declaration', () => {
    const parsed = parseFile('components/PremiumBadge.tsx', read('components/PremiumBadge.tsx'))
    const def = parsed.componentDefs.find((d) => d.name === 'PremiumBadge')
    expect(def?.isDefault).toBe(true)
    expect(def?.exported).toBe(true)
    expect(def?.kind).toBe('function')
  })

  it('does not treat lowercase helpers or constants as components', () => {
    const parsed = parseFile('x.tsx', 'function helper(){return 42}\nconst PI = 3.14\nexport {}')
    expect(parsed.componentDefs).toHaveLength(0)
  })
})

describe('extractUsages', () => {
  it('classifies the conditional context of each JSX child in Header', () => {
    const parsed = parseFile('components/Header.tsx', read('components/Header.tsx'))
    const u = parsed.componentUsages
    expect(usage(u, 'Logo')?.conditional).toBe('unconditional')
    expect(usage(u, 'Spinner')?.conditional).toBe('ternary')
    expect(usage(u, 'Nav')?.conditional).toBe('ternary')
    expect(usage(u, 'Avatar')?.conditional).toBe('logical-and')
    expect(usage(u, 'PremiumBadge')?.conditional).toBe('if-block')
  })

  it('attributes usages to their parent component and records props', () => {
    const parsed = parseFile('components/Header.tsx', read('components/Header.tsx'))
    const nav = usage(parsed.componentUsages, 'Nav')
    expect(nav?.parent).toBe('Header')
    expect(nav?.props).toContain('items')
  })

  it('skips lowercase host elements', () => {
    const parsed = parseFile('components/Header.tsx', read('components/Header.tsx'))
    expect(usage(parsed.componentUsages, 'header')).toBeUndefined()
  })
})

describe('extractImports (via parseFile)', () => {
  it('records default and named import bindings with their source', () => {
    const parsed = parseFile('components/Header.tsx', read('components/Header.tsx'))
    const logo = parsed.imports.find((i) => i.source === './Logo')
    expect(logo?.bindings[0]).toMatchObject({ local: 'Logo', kind: 'default' })
    const nav = parsed.imports.find((i) => i.source === './Nav')
    expect(nav?.bindings[0]).toMatchObject({ local: 'Nav', imported: 'Nav', kind: 'named' })
  })
})

describe('extractRoutes', () => {
  it('derives Next.js App Router routes from the filesystem', async () => {
    const project = await parseProject(FIXTURE)
    const paths = project.routes.map((r) => r.path)
    expect(paths).toEqual(['/', '/about', '/blog/[...slug]', '/products/[id]'])
  })

  it('captures dynamic segments and route components', async () => {
    const project = await parseProject(FIXTURE)
    expect(route(project.routes, '/products/[id]')).toMatchObject({
      dynamicSegments: ['id'],
      component: 'ProductPage',
    })
    expect(route(project.routes, '/blog/[...slug]')?.dynamicSegments).toEqual(['slug'])
    expect(route(project.routes, '/')?.component).toBe('HomePage')
  })

  it('strips route groups from the URL', async () => {
    const project = await parseProject(FIXTURE)
    expect(route(project.routes, '/about')).toBeDefined()
    expect(project.routes.some((r) => r.path.includes('(marketing)'))).toBe(false)
  })

  it('returns no routes for non-Next frameworks', () => {
    expect(extractRoutes([], 'remix')).toEqual([])
  })
})

describe('parseProject', () => {
  it('parses every walked file without fatal errors', async () => {
    const project = await parseProject(FIXTURE)
    expect(project.framework).toBe('next-app-router')
    expect(project.files.length).toBeGreaterThan(5)
    for (const f of project.files) {
      expect(f.parseErrors, `parse errors in ${f.file}`).toEqual([])
    }
  })
})
