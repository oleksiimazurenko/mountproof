import { describe, expect, it } from 'vitest'

import {
  entryToTrajectory,
  extractLeaves,
  leavesToProofs,
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
  // `name` is intentionally a skip-key (media file names), so use `fullName`.
  author: { fullName: 'Ugo Ezenduka', bio: 'Writer and editor' },
  blocks: [
    { __component: 'blocks.faq', question: 'What is rizz?', answer: 'Charisma, basically.' },
    { __component: 'blocks.cta', label: 'Start learning' },
  ],
  cover: { url: 'https://cdn.promova.com/x.jpg', alternativeText: 'cover' },
}

describe('extractLeaves', () => {
  it('collects user-facing strings across nested components and arrays', () => {
    const leaves = extractLeaves(ENTRY)
    expect(leaves).toContain('Dating Slang Explained')
    expect(leaves).toContain('Learn modern dating slang terms')
    expect(leaves).toContain('Ugo Ezenduka')
    expect(leaves).toContain('What is rizz?')
    expect(leaves).toContain('Start learning')
  })

  it('skips ids, urls, timestamps, and media internals', () => {
    const leaves = extractLeaves(ENTRY)
    expect(leaves).not.toContain('abc') // documentId (and too short)
    expect(leaves.some((l) => l.includes('https://'))).toBe(false) // urls
    expect(leaves.some((l) => l.includes('2026-01-01'))).toBe(false) // createdAt
    expect(leaves).not.toContain('cover') // alternativeText skip-key
  })

  it('honors extra skipKeys', () => {
    const leaves = extractLeaves(ENTRY, { skipKeys: ['bio'] })
    expect(leaves).not.toContain('Writer and editor')
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
