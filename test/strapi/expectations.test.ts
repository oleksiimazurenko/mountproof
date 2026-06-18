import { describe, expect, it } from 'vitest'

import {
  entryToTrajectory,
  extractLeaves,
  leavesToProofs,
  parseSchema,
} from '../../src/strapi/index.js'

const ENTRY = {
  id: 12,
  documentId: 'abc',
  title: 'Dating Slang Explained',
  slug: 'dating-slang',
  createdAt: '2026-01-01T00:00:00.000Z',
  seo: {
    metaTitle: 'Dating Slang',
    metaDescription: 'Learn modern dating slang terms',
    canonicalURL: 'https://promova.com/blog/dating-slang',
  },
  // author.name is a real user-facing name — must survive (not a media file name).
  author: { name: 'Ugo Ezenduka', bio: 'Writer and editor' },
  blocks: [
    { __component: 'blocks.faq', question: 'What is rizz?', answer: 'Charisma, basically.' },
    { __component: 'blocks.cta', label: 'Start learning' },
  ],
  // A realistic media object — its name/alternativeText are media-internal.
  cover: {
    url: 'https://cdn.promova.com/x.jpg',
    mime: 'image/jpeg',
    ext: '.jpg',
    hash: 'x_abc123',
    name: 'cover-hero.jpg',
    alternativeText: 'cover hero alt text',
  },
}

describe('extractLeaves', () => {
  it('collects user-facing strings across nested components and arrays', () => {
    const leaves = extractLeaves(ENTRY)
    expect(leaves).toContain('Dating Slang Explained')
    // 'Learn modern dating slang terms' is seo.metaDescription → routed to head, not body
    expect(leaves).not.toContain('Learn modern dating slang terms')
    expect(leaves).toContain('Ugo Ezenduka')
    expect(leaves).toContain('What is rizz?')
    expect(leaves).toContain('Start learning')
  })

  it('skips ids, urls, timestamps, and media internals', () => {
    const leaves = extractLeaves(ENTRY)
    expect(leaves).not.toContain('abc') // documentId (and too short)
    expect(leaves.some((l) => l.includes('https://'))).toBe(false) // urls
    expect(leaves.some((l) => l.includes('2026-01-01'))).toBe(false) // createdAt
    // media-internal name/alt skipped ONLY inside the media object
    expect(leaves).not.toContain('cover hero alt text')
    expect(leaves.some((l) => l.includes('cover-hero'))).toBe(false)
  })

  it('keeps a real name field that is NOT inside a media object (schema-aware)', () => {
    expect(extractLeaves(ENTRY)).toContain('Ugo Ezenduka')
  })

  it('component-schema-aware: filters section config, keeps section content', () => {
    const schema = parseSchema({
      contentTypes: [
        {
          uid: 'api::builder.builder',
          schema: {
            kind: 'collectionType',
            info: { pluralName: 'builders' },
            attributes: { title: { type: 'string' }, sections: { type: 'dynamiczone', components: ['s.price'] } },
          },
        },
      ],
      components: [
        {
          uid: 's.price',
          schema: {
            attributes: {
              heading: { type: 'string' }, // content
              color: { type: 'enumeration' }, // config
              tint: { type: 'string', customField: 'plugin::color-picker.color' }, // colorpicker config
            },
          },
        },
      ],
    } as never)
    const entry = {
      title: 'Builder',
      sections: [{ __component: 's.price', heading: 'Save Big Today', color: 'Premium', tint: 'BrandBlue' }],
    }
    const leaves = extractLeaves(entry, { schema, pluralApiId: 'builders' })
    expect(leaves).toContain('Save Big Today') // section content kept
    expect(leaves).not.toContain('Premium') // enumeration config dropped
    expect(leaves).not.toContain('BrandBlue') // colorpicker (string customField) dropped
  })

  it('honors extra skipKeys', () => {
    const leaves = extractLeaves(ENTRY, { skipKeys: ['bio'] })
    expect(leaves).not.toContain('Writer and editor')
  })

  it('drops ISO date/datetime values (e.g. publish_at) — value filter (a)', () => {
    const leaves = extractLeaves({ when: '2022-11-04T08:45:00.000Z', label: 'Visible Label' })
    expect(leaves).toEqual(['Visible Label'])
  })

  it('drops paths, identifiers (snake/kebab), and emails via value filter', () => {
    const leaves = extractLeaves({
      a: '/funnels/courses-onboarding',
      b: 'concept_1',
      c: 'tori-torn',
      d: 'viktoriia.khutorna@gen.tech',
      e: 'Real Visible Text',
    })
    expect(leaves).toEqual(['Real Visible Text'])
  })

  it('skips color-component and error-button config by key name', () => {
    const entry = {
      heading: 'Real Heading',
      sectionColor: { name: 'Gray', hex: '#888' },
      failButtonText: 'try again',
    }
    const leaves = extractLeaves(entry)
    expect(leaves).toContain('Real Heading')
    expect(leaves).not.toContain('Gray')
    expect(leaves).not.toContain('try again')
  })

  it('extracts only a label from a nested relation target, not its body', () => {
    const entry = {
      title: 'Post Title',
      content: 'Post body text',
      author: {
        documentId: 'a1',
        id: 5,
        name: 'Jane Doe',
        bio: 'A long author biography that should not be asserted on the post page',
      },
    }
    const leaves = extractLeaves(entry)
    expect(leaves).toContain('Jane Doe') // relation label kept
    expect(leaves.some((l) => l.includes('author biography'))).toBe(false) // bio excluded
    expect(leaves).toContain('Post body text') // own content kept
  })

  it('routes SEO meta to head, not body (entryToTrajectory)', () => {
    const entry = {
      title: 'Article H1',
      content: 'Body paragraph here',
      seo: { metaTitle: 'SEO Meta Title', metaDescription: 'SEO meta description text' },
    }
    const traj = entryToTrajectory('/blog/x', entry)
    const proofs = traj.mountProof!.target!
    // SEO meta → htmlContains (head); never body, and the field name never leaks
    expect(proofs.some((p) => p.type === 'htmlContains' && p.text === 'SEO Meta Title')).toBe(true)
    expect(proofs.some((p) => p.type === 'pageTextContains' && p.text.includes('SEO Meta'))).toBe(false)
    // real body content still present
    expect(proofs.some((p) => p.type === 'pageTextContains' && p.text === 'Body paragraph here')).toBe(true)
  })

  it('schema-aware: keeps content fields, drops slug/date/enum/boolean — (b)', () => {
    const schema = parseSchema({
      contentTypes: [
        {
          uid: 'api::article.article',
          schema: {
            kind: 'collectionType',
            info: { pluralName: 'articles' },
            attributes: {
              title: { type: 'string' },
              slug: { type: 'uid' },
              publish_at: { type: 'datetime' },
              ready: { type: 'boolean' },
              content: { type: 'richtext' },
            },
          },
        },
      ],
    } as never)
    const entry = {
      id: 1,
      documentId: 'abc',
      title: 'Real Article Title',
      slug: 'real-article-title',
      publish_at: '2022-11-04T08:45:00.000Z',
      ready: true,
      content: '<p>The body content paragraph.</p>',
    }
    const leaves = extractLeaves(entry, { schema, pluralApiId: 'articles' })
    expect(leaves).toContain('Real Article Title')
    expect(leaves).toContain('The body content paragraph.')
    expect(leaves).not.toContain('real-article-title') // slug (uid) excluded
    expect(leaves.some((l) => l.includes('2022-11-04'))).toBe(false) // datetime excluded
  })
})

describe('leavesToProofs', () => {
  it('emits pageTextContains proofs, truncated and deduped', () => {
    const long = 'A very long rich-text paragraph that the page will almost certainly ellipsize before the end of it'
    const proofs = leavesToProofs(['Hello world', 'Hello world', long], { maxNeedleLen: 20 })
    expect(proofs).toHaveLength(2) // dedup
    expect(proofs[0]).toEqual({ type: 'pageTextContains', text: 'Hello world' })
    const longProof = proofs[1]
    expect(longProof.type).toBe('pageTextContains')
    expect(longProof.type === 'pageTextContains' && longProof.text.length).toBe(20)
  })

  it('caps the number of proofs', () => {
    const many = Array.from({ length: 100 }, (_, i) => `leaf number ${i}`)
    expect(leavesToProofs(many, { maxProofs: 10 })).toHaveLength(10)
  })
})

describe('per-type title routing', () => {
  const schema = parseSchema({
    contentTypes: [
      {
        uid: 'api::builder.builder',
        schema: {
          kind: 'collectionType',
          info: { pluralName: 'builders' },
          attributes: {
            title: { type: 'string' },
            slug: { type: 'uid' },
            sections: { type: 'dynamiczone', components: ['x.hero'] },
          },
        },
      },
      {
        uid: 'api::article.article',
        schema: {
          kind: 'collectionType',
          info: { pluralName: 'articles' },
          attributes: { title: { type: 'string' }, content: { type: 'richtext' } },
        },
      },
    ],
  } as never)

  it('landing-builder: seo.metaTitle→head, section content→body, internal title dropped', () => {
    const traj = entryToTrajectory(
      '/page/bf',
      {
        title: 'internal builder name',
        seo: { metaTitle: 'BF Rendered Title' },
        sections: [{ __component: 'x.hero', heading: 'Visible Hero Heading' }],
      },
      { schema, pluralApiId: 'builders' },
    )
    const proofs = traj.mountProof!.target!
    expect(proofs.some((p) => p.type === 'htmlContains' && p.text === 'BF Rendered Title')).toBe(true)
    expect(proofs.some((p) => p.type === 'pageTextContains' && p.text === 'Visible Hero Heading')).toBe(true)
    // the internal title is asserted nowhere (not body, not head)
    expect(proofs.some((p) => p.text.includes('internal builder name'))).toBe(false)
  })

  it('keeps an article title as a visible body proof (no DZ)', () => {
    const traj = entryToTrajectory(
      '/blog/x',
      { title: 'Article H1 Title', content: 'Body paragraph text' },
      { schema, pluralApiId: 'articles' },
    )
    const proofs = traj.mountProof!.target!
    expect(proofs.some((p) => p.type === 'pageTextContains' && p.text === 'Article H1 Title')).toBe(true)
    expect(proofs.some((p) => p.type === 'htmlContains')).toBe(false)
  })
})

describe('entryToTrajectory', () => {
  it('builds a full-page trajectory with symmetric proofs from the entry', () => {
    const traj = entryToTrajectory('/blog/dating-slang', ENTRY)
    expect(traj.name).toBe('blog-dating-slang')
    expect(traj.steps).toEqual([{ type: 'navigate', path: '/blog/dating-slang' }])
    expect(traj.capture).toEqual({ name: 'blog-dating-slang' })
    // Same proofs on both sides — main and migrated must show identical data.
    expect(traj.mountProof?.baseline).toEqual(traj.mountProof?.target)
    expect(traj.mountProof?.target?.some((p) => p.type === 'pageTextContains')).toBe(true)
  })
})
