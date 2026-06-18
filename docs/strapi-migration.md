# Testing a Strapi migration with mountproof

Migrating a Strapi backend (e.g. v4 → v5) is risky in a way ordinary visual
regression can't see: the frontend still *renders*, but a field can silently stop
arriving — a relation breaks, a dual-shape fetcher returns the wrong branch, a
whole section quietly disappears. The page looks plausible, so a pixel diff passes
and you ship the regression.

mountproof's Strapi layer (`@oleksiimazurenko/mountproof/strapi`) tests this
directly: it reads the CMS, derives **what each page should display**, and asserts
that content actually rendered — then visual-diffs against the old deployment.

## The invariant

For every route, three things must hold:

1. **Parity** — the published data in the new instance equals the old.
2. **Presence** — the frontend actually renders that data (not a stale/empty shell).
3. **Visual** — the layout matches the baseline.

`#1` is a cheap API check, `#2`/`#3` run in a real (hydrated) browser. Presence is
the one most tools skip, and it's the one that catches migration data loss.

## Pipeline

```
route map ─┐
           ├─▶ discoverTargets ─▶ runStrapiAudit ─▶ trajectories/ ─▶ mountproof run ─▶ report
two URLs ──┘    (sample slugs)    (read-back +        (+ _parity)     (presence +
                                   expectations)                       visual diff)
```

```ts
import {
  discoverTargets,
  runStrapiAudit,
  parseSchema,
} from '@oleksiimazurenko/mountproof/strapi'

// 1. Schema — drives safe populate + content-only extraction.
//    Prefer reading the on-disk schema.json files (content-types + components);
//    uid = api::<api>.<ct> for content types, <category>.<name> for components.
const schema = parseSchema({ contentTypes, components })

// 2. Targets — sample real slugs per collection from the route map (no hand-listing).
const { targets } = await discoverTargets({
  baseUrl: 'http://localhost:1337', // a live Strapi to read slugs from
  routeMap,                         // { collections:[{pluralApiId, route, slugField}], singleTypes:[...] }
  sampleN: 3,
  knownHard: [{ route: '/blog/dating-slang', pluralApiId: 'articles', slug: 'dating-slang' }],
})

// 3. Audit — read back both instances, check parity, emit trajectories with proofs.
await runStrapiAudit({
  baselineUrl: 'http://old-strapi',
  targetUrl: 'http://localhost:1337',
  targets,
  schema,
  includeDynamicZones: true,
  perTypeDepth: { builders: ['sections'], articles: ['blocks'] }, // deep-populate nested content
  outDir: '/tmp/mp-strapi',
})
```

```bash
# 4. Run the generated trajectories against both frontends.
mountproof run /tmp/mp-strapi/trajectories \
  --baseline http://main-frontend \
  --target   http://migrated-frontend \
  --out      /tmp/mp-run
```

`mountproof run` verifies the presence proofs (+ a default `noErrorBoundary`
check), then pixel-diffs. CI exit codes: `5` mount-proof fail, `4` WRONG_FRAME,
`2` visual FAIL.

## How expectations are derived (and kept clean)

`runStrapiAudit` reads each entry back from the instance (the published ground
truth) and turns its **visible content** into `pageTextContains` proofs. The hard
part is extracting *only* what renders, so proofs don't false-fail on data that
never appears on the page. The rules, all schema-driven where possible:

- **Top level** — keep content scalars (`string/text/richtext/blocks`) +
  relations/components/dynamic zones; skip `uid` (slug), dates, enumerations,
  booleans, numbers.
- **Components / sections** — same content-only filter, using the component
  registry; a string-typed custom field (e.g. a colorpicker) is config, not
  content.
- **Relations** — a nested relation target renders elsewhere as a link/card, so
  only its label (name/title) is asserted, never its full body.
- **SEO → head** — `seo.metaTitle` is asserted in `<head>` (`htmlContains`), not
  the body; the entry's own `title` is treated as a head/SEO field for
  landing-builder types (it's an internal label there).
- **Value filters** — drop emails, ISO dates, leading-slash paths, and
  space-free snake/kebab identifiers (slugs).
- **Config field names** — skip `color`/`tint`/`theme` and `fail*`/`error*` UI text.

Populate uses the nested `populate[field][populate]=*` form (plain `[field]=*`
500s on dynamic zones in v5), scoped per field so it can't hang like a global
`populate=*`.

## Dev servers need a warm-up

Next.js/Turbopack compiles a route on its **first** hit and serves a shell
meanwhile — so the first proof navigation would see a half-rendered page.
`mountproof run` primes every route on both URLs before proofs (disable with
`--no-warmup` for already-warm/prod servers).

## What it caught (live)

Run against a real narnia v5 → student migration, three routes:

- `/blog/dating-slang` — **clean PASS** (title + body content present).
- `/our-editorial-process` — **clean PASS**, including a `useParallax` page whose
  client-side error boundary only mounts after hydration (caught by the
  hydration-settle + `noErrorBoundary` check).
- `/who-we-are` — clean **except the `our-products` section** ("What we offer",
  "Self-learning app", "Promova podcast", …): the CMS has it, the frontend doesn't
  render it. With every config/relation/SEO false-positive filtered out, those six
  proofs were the *only* residual — a precise, true content gap, not noise.

That last line is the whole point: a section silently vanished, the page still
looked fine, and mountproof named exactly which content didn't arrive.
