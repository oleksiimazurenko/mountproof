import { describe, expect, it } from 'vitest'

import { discoverTargets, type RouteMap } from '../../src/strapi/index.js'

const routeMap: RouteMap = {
  collections: [
    { pluralApiId: 'articles', route: '/blog/:slug' },
    { pluralApiId: 'how-to-pronounce-words', route: '/how-to-pronounce/:word', slugField: 'word' },
    { pluralApiId: 'other-articles', route: '/:category/:slug' }, // multi-param → skipped
  ],
  singleTypes: [{ pluralApiId: 'our-editorial-process', route: '/our-editorial-process' }],
}

const fetchImpl = (async (url: string) => {
  const data = url.includes('/api/articles')
    ? [{ slug: 'a1' }, { slug: 'a2' }]
    : url.includes('/api/how-to-pronounce-words')
      ? [{ word: 'hello' }]
      : url.includes('/api/other-articles')
        ? [{ slug: 'oa1' }]
        : []
  return { ok: true, json: async () => ({ data }) }
}) as unknown as typeof fetch

describe('discoverTargets', () => {
  it('samples slugs per collection, fills routes, includes single types + known-hard', async () => {
    const { targets, skipped } = await discoverTargets({
      baseUrl: 'http://x',
      routeMap,
      sampleN: 2,
      fetch: fetchImpl,
      knownHard: [{ route: '/blog/known-hard', pluralApiId: 'articles', slug: 'known-hard' }],
    })
    const routes = targets.map((t) => t.route)

    expect(routes).toContain('/blog/a1')
    expect(routes).toContain('/blog/a2')
    expect(routes).toContain('/how-to-pronounce/hello') // custom slugField 'word'
    expect(routes).toContain('/blog/known-hard') // known-hard preserved
    // single type → slugless target with kind 'single'
    expect(targets).toContainEqual({
      route: '/our-editorial-process',
      pluralApiId: 'our-editorial-process',
      kind: 'single',
    })
    // multi-param route can't be auto-filled → skipped, not emitted
    expect(routes.some((r) => r.includes(':'))).toBe(false)
    expect(skipped).toContain('/:category/:slug')
  })

  it('dedupes by route', async () => {
    const { targets } = await discoverTargets({
      baseUrl: 'http://x',
      routeMap: { collections: [{ pluralApiId: 'articles', route: '/blog/:slug' }] },
      fetch: fetchImpl,
      knownHard: [{ route: '/blog/a1', pluralApiId: 'articles', slug: 'a1' }],
    })
    expect(targets.filter((t) => t.route === '/blog/a1')).toHaveLength(1)
  })
})
