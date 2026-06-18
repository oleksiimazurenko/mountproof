import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSchema, runStrapiAudit } from '../../src/strapi/index.js'
import type { AuditTarget } from '../../src/strapi/index.js'

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
          subtitle: { type: 'string' },
          author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
        },
      },
    },
  ],
} as never)

const targets: AuditTarget[] = [{ route: '/blog/x', pluralApiId: 'articles', slug: 'x' }]

/** Build a fake fetch that returns a v4 envelope for baseline, v5 flat for target. */
function makeFetch(v4Entry: Record<string, unknown>, v5Entry: Record<string, unknown>) {
  return (async (url: string) => {
    const isBaseline = url.includes('//v4')
    const entry = isBaseline
      ? { id: 1, attributes: v4Entry } // v4 envelope
      : { id: 1, documentId: 'abc', ...v5Entry } // v5 flat
    return { ok: true, json: async () => ({ data: [entry] }) }
  }) as unknown as typeof fetch
}

describe('runStrapiAudit', () => {
  it('detects versions, confirms parity, and generates a trajectory', async () => {
    const fetchImpl = makeFetch(
      { title: 'Hello World', slug: 'x' },
      { title: 'Hello World', slug: 'x' },
    )
    const { results, trajectories, parityFailures } = await runStrapiAudit({
      baselineUrl: 'http://v4',
      targetUrl: 'http://v5',
      targets,
      schema,
      fetch: fetchImpl,
    })

    expect(parityFailures).toBe(0)
    expect(results[0].baselineVersion).toBe(4)
    expect(results[0].targetVersion).toBe(5)
    expect(results[0].parity.ok).toBe(true)
    expect(trajectories[0].name).toBe('blog-x')
    expect(trajectories[0].mountProof?.target?.some((p) => p.type === 'pageTextContains')).toBe(true)
  })

  it('flags a parity regression when a field is missing on the target', async () => {
    const fetchImpl = makeFetch(
      { title: 'Hello World', subtitle: 'Important subtitle text', slug: 'x' },
      { title: 'Hello World', slug: 'x' }, // subtitle dropped in v5
    )
    const { results, parityFailures } = await runStrapiAudit({
      baselineUrl: 'http://v4',
      targetUrl: 'http://v5',
      targets,
      schema,
      fetch: fetchImpl,
    })
    expect(parityFailures).toBe(1)
    expect(results[0].parity.ok).toBe(false)
    expect(results[0].parity.missingOnTarget).toContain('Important subtitle text')
  })

  it('records an error and a parity failure on a fetch error', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    const { results, parityFailures } = await runStrapiAudit({
      baselineUrl: 'http://v4',
      targetUrl: 'http://v5',
      targets,
      schema,
      fetch: fetchImpl,
    })
    expect(parityFailures).toBe(1)
    expect(results[0].error).toMatch(/HTTP 500/)
  })

  describe('disk output', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'mp-audit-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes trajectories + a parity report when outDir is set', async () => {
      const fetchImpl = makeFetch({ title: 'Hello World', slug: 'x' }, { title: 'Hello World', slug: 'x' })
      await runStrapiAudit({
        baselineUrl: 'http://v4',
        targetUrl: 'http://v5',
        targets,
        schema,
        fetch: fetchImpl,
        outDir: dir,
        generatedAt: '2026-06-18T00:00:00.000Z',
      })
      expect(existsSync(join(dir, 'trajectories', 'blog-x.json'))).toBe(true)
      expect(existsSync(join(dir, 'trajectories', '_parity.json'))).toBe(true)
    })
  })
})
