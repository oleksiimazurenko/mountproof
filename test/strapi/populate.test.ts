import { describe, expect, it } from 'vitest'

import {
  buildPopulatePlan,
  bucketAttributes,
  detectStrapiVersion,
  findByPluralApiId,
  flattenEntry,
  inferVersionFromEntry,
  parseSchema,
  populateUrl,
  toPopulateQuery,
} from '../../src/strapi/index.js'

// Fixture modeled on narnia content types. Mixes the nested `schema` admin shape
// (article) and the flat file shape (ai-landing, how-to-pronounce-word).
const RAW = {
  contentTypes: [
    {
      uid: 'api::article.article',
      schema: {
        kind: 'collectionType',
        info: { pluralName: 'articles', singularName: 'article' },
        attributes: {
          title: { type: 'string' },
          slug: { type: 'uid' },
          body: { type: 'richtext' },
          seo: { type: 'component', component: 'shared.seo' },
          author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
          cover: { type: 'media' },
          blocks: { type: 'dynamiczone', components: ['blocks.faq', 'blocks.cta'] },
        },
      },
    },
    {
      uid: 'api::ai-landing.ai-landing',
      kind: 'collectionType',
      info: { pluralName: 'ai-landings' },
      // No breadcrumbs/localizations relations — populating them would 400.
      attributes: { title: { type: 'string' }, slug: { type: 'uid' } },
    },
    {
      uid: 'api::how-to-pronounce-word.how-to-pronounce-word',
      kind: 'collectionType',
      info: { pluralName: 'how-to-pronounce-words' },
      attributes: { word: { type: 'string' }, audio: { type: 'media' } },
    },
  ],
} as const

const schema = parseSchema(RAW as never)
const article = findByPluralApiId(schema, 'articles')!
const aiLanding = findByPluralApiId(schema, 'ai-landings')!
const pronounce = findByPluralApiId(schema, 'how-to-pronounce-words')!

describe('parseSchema', () => {
  it('normalizes nested and flat shapes; derives pluralApiId', () => {
    expect(schema.contentTypes).toHaveLength(3)
    expect(article.pluralApiId).toBe('articles')
    expect(article.kind).toBe('collectionType')
    expect(aiLanding.attributes.title.type).toBe('string')
  })
})

describe('bucketAttributes', () => {
  it('separates scalars, relations, components, media, dynamic zones', () => {
    const b = bucketAttributes(article.attributes)
    expect(b.relations).toEqual(['author'])
    expect(b.components).toEqual(['seo'])
    expect(b.media).toEqual(['cover'])
    expect(b.dynamicZones).toEqual(['blocks'])
    expect(b.scalars.sort()).toEqual(['body', 'slug', 'title'])
    // scalars are never populatable
    expect(b.populatable.sort()).toEqual(['author', 'cover', 'seo'])
  })
})

describe('buildPopulatePlan + toPopulateQuery', () => {
  it('populates relations/components/media, never scalars or DZ by default', () => {
    const q = toPopulateQuery(buildPopulatePlan(article), 5)
    expect(q).toContain('populate%5Bauthor%5D=true')
    expect(q).toContain('populate%5Bseo%5D=true')
    expect(q).toContain('populate%5Bcover%5D=true')
    // scalar slug must NOT be populated (the classic v5 400)
    expect(q).not.toContain('slug')
    // DZ excluded unless opted in
    expect(q).not.toContain('blocks')
  })

  it('includes dynamic zones via nested [populate]=* only when opted in', () => {
    const q = toPopulateQuery(buildPopulatePlan(article, { includeDynamicZones: true }), 5)
    expect(q).toContain('populate%5Bblocks%5D%5Bpopulate%5D=*')
  })

  it('never emits populate for a relation the type does not have', () => {
    // ai-landing has no relations → no populate at all, so no breadcrumbs 400.
    expect(populateUrl(aiLanding, 5)).toBe('/api/ai-landings')
  })

  it('supports scalar-only fields query (sitemap / how-to-pronounce word)', () => {
    const q = toPopulateQuery(buildPopulatePlan(pronounce, { only: [], scalarFields: ['word'] }), 5)
    expect(q).toContain('fields%5B0%5D=word')
    expect(q).not.toContain('populate')
  })

  it('only / exclude filter the populate set', () => {
    expect(buildPopulatePlan(article, { only: ['author'] })).toMatchObject({ populate: ['author'] })
    const excluded = buildPopulatePlan(article, { exclude: ['cover'] })
    expect(excluded.mode === 'shallow' && excluded.populate).not.toContain('cover')
  })

  it('deep-populates named attributes with * (bounded), others stay true', () => {
    const q = toPopulateQuery(buildPopulatePlan(article, { deepAttributes: ['author'] }), 5)
    expect(q).toContain('populate%5Bauthor%5D%5Bpopulate%5D=*')
    expect(q).toContain('populate%5Bseo%5D=true')
  })

  it('deep mode is version-keyed (v4 deep / v5 *)', () => {
    expect(toPopulateQuery(buildPopulatePlan(article, { deep: true }), 4)).toBe('populate=deep')
    expect(toPopulateQuery(buildPopulatePlan(article, { deep: true }), 5)).toBe('populate=*')
  })
})

describe('version detection + normalization', () => {
  it('infers v4 from attributes wrapper, v5 from documentId', () => {
    expect(inferVersionFromEntry({ id: 1, attributes: { title: 'x' } })).toBe(4)
    expect(inferVersionFromEntry({ id: 1, documentId: 'abc', title: 'x' })).toBe(5)
    expect(inferVersionFromEntry({ id: 1 })).toBeNull()
  })

  it('flattens both shapes to comparable content fields', () => {
    const v4 = flattenEntry({ id: 1, attributes: { title: 'Hello', slug: 'hello' } })
    const v5 = flattenEntry({ id: 1, documentId: 'abc', title: 'Hello', slug: 'hello' })
    expect(v4).toEqual({ title: 'Hello', slug: 'hello' })
    expect(v5).toEqual({ title: 'Hello', slug: 'hello' })
  })

  it('keepMeta preserves identity/timestamps', () => {
    const kept = flattenEntry({ id: 1, documentId: 'abc', title: 'x' }, { keepMeta: true })
    expect(kept).toMatchObject({ id: 1, documentId: 'abc', title: 'x' })
  })

  it('detectStrapiVersion probes an instance via injected fetch', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 1, documentId: 'abc', title: 'x' }] }),
    })) as unknown as typeof fetch
    expect(await detectStrapiVersion('http://x', '/api/articles', fakeFetch)).toBe(5)
  })
})
