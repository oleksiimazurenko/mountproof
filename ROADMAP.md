# mountproof — Roadmap

> Detailed plan for the full system. Source of truth for what mountproof is, what's built today, and what's left.

## Vision in one paragraph

`mountproof` automatically guarantees that **every visually-significant component in your codebase** is exercised by visual regression — without humans writing snapshot tests by hand. It does this in two layers: **discover** (which reads your code, maps every component to the routes/interactions that render it, and writes trajectories) and **runner** (which executes those trajectories against baseline + target deployments, verifies a *mount proof* that the right code actually loaded, and pixel-diffs the screenshots with a three-metric verdict). The unique guarantee no other tool gives you is: *if the diff says PASS, you know the new code was actually under test — not a stale bundle pretending to be it.*

## The headline problem we solve

Existing visual regression tools (Percy, Chromatic, Playwright snapshots, BackstopJS, Loki) have two structural gaps:

1. **They trust the screenshot.** If your `next build` quietly served a cached v2 bundle on the "target" URL, the pixel diff is `STRICT_PASS` (both sides are identical) — you ship a regression you never even tested. This is *the worst class of false negative* because it looks indistinguishable from honest success.
2. **They require humans to write snapshot tests.** Every component you care about needs a manually-authored test that navigates to it and screenshots it. Coverage equals dedication. New components ship untested by default.

mountproof closes both:

- **Mount proof** in every trajectory — a verifiable trace (DOM node, network response, console line, eval result, HTML substring) that the new code is actually mounted on the target side. Missing proof → exit 5, no diff, with diagnostics. Stale bundles can no longer pass.
- **Discovery** — a static + dynamic pipeline that reads your repo, finds every component, figures out how to reach it in a browser (including auth gates, modal triggers, route params), and writes the trajectory for you. Coverage stops being a discipline problem.

## High-level architecture

```
   ┌────────────────────────────────────────────────────────────────┐
   │                       mountproof (one npm package)             │
   │                                                                │
   │   ┌──────────────────┐         ┌──────────────────────────┐    │
   │   │  src/discover/   │ writes  │      trajectories/       │    │
   │   │  ───────────     │ ──────▶ │   ───────────────        │    │
   │   │  • AST parser    │  JSON   │   one .json per          │    │
   │   │  • Route mapper  │         │   (component, route)     │    │
   │   │  • Component     │         │   discovery cell         │    │
   │   │    graph         │         │                          │    │
   │   │  • Browser-      │         └────────────┬─────────────┘    │
   │   │    driven        │                      │ consumed by      │
   │   │    discovery     │                      ▼                  │
   │   │  • Drift         │         ┌──────────────────────────┐    │
   │   │    detection     │         │     src/runner/          │    │
   │   └──────────────────┘         │     ───────────          │    │
   │            ▲                   │   • Playwright capture   │    │
   │            │ reads             │   • Mount proof verify   │    │
   │            │                   │   • Pixel+ΔE+SSIM diff   │    │
   │   ┌──────────────────┐         │   • HTML report          │    │
   │   │  your codebase   │         └──────────────────────────┘    │
   │   │  (.tsx, .vue,    │                      │                  │
   │   │   /app, etc.)    │                      ▼                  │
   │   └──────────────────┘         ┌──────────────────────────┐    │
   │                                │   /tmp/run-42/           │    │
   │                                │   baseline/  target/     │    │
   │                                │   diff/      report.html │    │
   │                                └──────────────────────────┘    │
   └────────────────────────────────────────────────────────────────┘
```

One npm package, one `npm i`, two CLI surfaces:

```bash
mountproof discover ./my-app                    # build trajectories/ from code
mountproof run      ./trajectories/  --baseline … --target …   # execute them
mountproof full     ./my-app         --baseline … --target …   # discover + run in one go
```

Internally `src/discover/` and `src/runner/` are sibling directories. They share `src/types.ts` (Trajectory shape is the contract between them). `src/cli.ts` wires both to commander subcommands.

## Why this is one package, not two

- One `npm i` for the user is dramatically less friction than `i discover` + `i runner`. JS dev culture rewards single-install tools.
- The contract between discover and runner is **the Trajectory JSON shape** — a stable schema, not an API. Splitting into two packages would just mean publishing two versions in lockstep forever.
- Both modules share `playwright` as a peer dep, share TS types, share build tooling. Splitting doubles the maintenance surface for no isolation win.
- If someone wants discover-only or runner-only, the CLI subcommands let them use one without the other. The dead-code shipped is ~50 KB — within the noise.

## Tech decisions

### Language: TypeScript, with native libraries for hotspots

Rust was considered. Reasons not to use it:

- **Playwright.** No mature first-party Rust Playwright binding exists. `playwright-rust` is third-party, lags the official API, has thinner community fixes. Browser automation is our core dependency — depending on a third-party port for it is a permanent maintenance drag.
- **Distribution.** Our target audience is JS developers. `npm i mountproof` works today on any machine with Node. A Rust CLI requires pre-built binaries for 5 platforms (macOS x86/arm, Linux x86/arm, Windows) shipped through `cargo install` or curl-scripts. That cuts ~90% of the addressable user base before we even start.
- **Iteration speed.** A PoC needs fast feedback loops. Rust compile times + borrow checker friction is 2-3× slower per iteration. For the first 6 months that compounds badly.
- **Library availability.** Most of the work we want Rust for is already done by Rust libraries with JS bindings. We can use them from TS without writing Rust ourselves:
  - **AST parsing** — `oxc` (Rust-based JS/TS parser, 3× faster than babel) ships a Node binding.
  - **Image diff** — `sharp` (libvips, native C++) is already in our stack and dominates `pngjs` for raw decode/resize.
  - **Pixel matching** — `pixelmatch` is pure JS but operates on small buffers; not a real bottleneck.

The hybrid result: **TS where it matters for developer experience and ecosystem fit, native libraries via bindings where performance matters.** If a specific hotspot later proves to be CPU-bound past tolerance, we replace just that hotspot with a `napi-rs` native module — no rewrite needed.

### Module organization: monolith package, split directories

```
src/
├── types.ts                  ← shared contract (Trajectory, MountProof, ProofType, …)
├── cli.ts                    ← commander wiring; subcommands route to runner or discover
├── index.ts                  ← public API re-exports
│
├── runner/                   ← what exists today; runs trajectories
│   ├── mount-proof.ts
│   ├── trajectory.ts
│   ├── capture.ts
│   ├── diff.ts
│   ├── report.ts
│   ├── legacy-translate.ts
│   └── login.ts              ← not yet ported; auth flows
│
└── discover/                 ← to build; turns code into trajectories
    ├── ast/                  ← parse JS/TS/JSX/TSX → component graph
    │   ├── parse.ts          ← oxc-based file parser
    │   ├── components.ts     ← extract component defs from AST
    │   ├── usages.ts         ← extract <X /> usages from AST
    │   └── routes.ts         ← framework-specific route extraction (Next, Remix, Vue Router, …)
    │
    ├── graph/                ← build & query component graph
    │   ├── builder.ts        ← walk repo, glue ASTs into one graph
    │   ├── traverse.ts       ← "find all routes that render component X"
    │   └── annotate.ts       ← attach metadata (auth-gated, lazy, modal, etc.)
    │
    ├── plan/                 ← decide HOW to reach each component
    │   ├── pathfinder.ts     ← graph traversal: pick shortest reachable path per component
    │   └── strategy.ts       ← which proofs to suggest given component metadata
    │
    ├── browse/               ← actually drive a browser to verify the plan works
    │   ├── attempt.ts        ← try-direct → try-with-trigger → try-with-auth state machine
    │   ├── auth-flow.ts      ← generic login adapter (built-ins + plugin hook)
    │   └── selector.ts       ← derive stable selectors from rendered DOM
    │
    ├── emit/                 ← write trajectories/<name>.json
    │   ├── serialize.ts      ← Plan → Trajectory JSON
    │   └── unreachable.ts    ← emit unreachable-report.json with reason per fail
    │
    └── drift/                ← detect when stored trajectories go stale
        ├── hash.ts           ← hash component source + route definition
        ├── compare.ts        ← cached hash vs current → which trajectories need re-discovery
        └── invalidate.ts     ← schedule selective re-runs
```

Each subdirectory is a small focused module (~200-400 lines). The directory layout doubles as documentation: *the data flows top-to-bottom through these stages*.

## Module 1 — runner (existing, mostly done)

### Status: PoC v0.0.1 shipped

| Component | State |
|---|---|
| `mount-proof.ts` — 7 runners, MountProofError, diagnostics | ✅ done, 22 tests |
| `legacy-translate.ts` — Promova `assertInlineStyle` backward compat | ✅ done, 8 tests |
| `diff.ts` — pixelmatch + ΔE + SSIM + WRONG_FRAME gate | ✅ done |
| `capture.ts` — Playwright headless capture, skeleton-wait, viewport sizing | ✅ done |
| `trajectory.ts` — step engine + mount-proof gate + capture | ✅ done |
| `report.ts` — self-contained HTML report with mount-proof badges | ✅ done |
| `cli.ts` — commander subcommands: trajectory, compare, diff, report, validate | ✅ done |
| `examples/button-versioning/` — end-to-end demo with stale-bundle simulation | ✅ done, RUN 1 validated end-to-end |
| `login.ts` / `login-headless.ts` — generic auth profile setup | ⚠️ not yet ported from Promova |
| `register-headless.ts` — register-then-onboard for fresh test accounts | ⚠️ not yet ported (low priority) |

### Outstanding work for runner v0.1

1. **Port login flows.** Promova's `login.ts` and `login-headless.ts` carry Firebase-specific selectors. The generic version should:
   - Detect framework (Firebase, Auth0, NextAuth, Supabase) by URL pattern + DOM markers
   - Run a per-framework login flow plugin
   - Save persistent BrowserContext profile to `--profile-dir`
   - Plugin API for custom auth flows (Promova ships its plugin separately)
2. **Network/console capture wiring on runner side.** trajectory.ts records `page.on('console')` and `page.on('response')` already, but `capture.ts` (the multi-target version) doesn't. Unify so all capture paths populate `proofCtx`.
3. **Report polish.** Add baseline/target proof status badges per pair (✓ verified, ⊘ skipped, ✗ failed) in addition to the existing single mount-proof banner.
4. **CI mode.** `--format github-actions` emits GitHub annotations for FAIL pairs (so PR check inline shows the diff).

### Outstanding work for runner v1.0

- Snapshot baselines for the no-target case (single-side mode for traditional "review changes against committed PNGs" workflow).
- Threshold profiles configurable per-trajectory (some components tolerate more noise than others).
- Diff masks (`maskSelector`: regions to exclude from diff — useful for timestamps, randomized avatars).
- Lazy capture: only screenshot if mount proof passes — saves work on broken targets.

## Module 2 — discover (Phases A–E implemented)

This is the bigger half. Five phases, each independently shippable. All five are
now implemented under `src/discover/{ast,graph,browse,emit,drift}` and wired into
the CLI (`mountproof discover` / `drift`). The static-analysis and discovery
logic are unit-tested; the live Playwright crawl path is not yet validated
against a real running app. The phase write-ups below are the original design.

### Phase A — AST parsing (`src/discover/ast/`)

**Goal:** turn a directory of source files into structured component metadata.

**Inputs:**
- Project root directory
- Optional `mountproof.config.ts` (file globs, framework hint, opt-out paths)

**Outputs:**
- `ParsedFile[]` — one record per source file, containing:
  - `componentDefs[]` — every component declared (function/class/arrow, exported or not)
  - `componentUsages[]` — every `<X />` JSX usage, with the parent component and props
  - `routes[]` — framework-specific route declarations (`page.tsx`, `app/.../page.tsx`, Vue Router config, etc.)
  - `dependencies[]` — `import` graph

**Concrete tasks:**

1. **Framework detection** (`detectFramework.ts`):
   - Scan `package.json` for `next`, `react-router`, `vue-router`, `@remix-run/*`, `@sveltejs/kit`, `astro`
   - Scan for sentinel files (`next.config.js`, `vite.config.ts`, `nuxt.config.ts`)
   - Emit `{ framework: 'next-app-router' | 'next-pages-router' | 'react-router' | 'remix' | 'sveltekit' | 'vue-router' | 'astro' | 'unknown' }`
   - On 'unknown', warn the user and default to "scan all source files, no route extraction"

2. **File walker** (`walk.ts`):
   - Use `fast-glob` with project gitignore respected
   - Include patterns from config: default `**/*.{ts,tsx,js,jsx,vue,svelte,astro}`
   - Skip `node_modules`, `dist`, `build`, `.next`, `coverage`

3. **Parser dispatcher** (`parse.ts`):
   - `.ts/.tsx/.js/.jsx` → `oxc` (Rust-based, fast, returns ESTree-compatible AST)
   - `.vue` → `@vue/compiler-sfc` (extracts template + script + style)
   - `.svelte` → `svelte/compiler` (parse function)
   - `.astro` → `@astrojs/compiler` (parse function)
   - Each emits a unified `ParsedFile` shape

4. **Component extractor** (`components.ts`):
   - Pattern: any function/arrow/class that returns JSX (or template root, for non-React)
   - Heuristic for "is this a component, not a regular function":
     - Returns JSX/template root
     - Name starts with uppercase
     - Default-exported from a `.tsx/.vue/.svelte` file
   - Extract: `{ name, file, line, exported: boolean, default: boolean, propsType: string | null, hasState: boolean }`

5. **Usage extractor** (`usages.ts`):
   - Walk JSX in each component body; record every `<X ... />` element where X starts uppercase OR is a local variable from import
   - Extract: `{ parent: ComponentDef, child: string, propsPassed: string[], conditional: 'unconditional' | 'ternary' | 'logical-and' | 'if-block' }`
   - The `conditional` field captures gating: `{user && <Premium />}` is `logical-and`, becomes signal in metadata

6. **Route extractor** (`routes.ts`):
   - Framework-specific (lots of branches; the framework taxonomy is real):
     - Next.js App Router → walk `app/**/page.tsx`, derive route from filesystem path, parse `[param]` segments
     - Next.js Pages Router → walk `pages/**/*.tsx` excluding `_app`/`_document`/api
     - Remix → walk `app/routes/**/*.tsx`
     - SvelteKit → walk `src/routes/**/+page.svelte`
     - Vue Router → parse the router config file (`router.ts`, `router/index.ts`)
   - Emit: `{ path: '/products/[id]', file: 'app/products/[id]/page.tsx', component: 'ProductPage', dynamicSegments: ['id'] }`

**Estimated work:** ~5 days. The framework matrix is the painful part; everything else is mechanical.

### Phase B — Component graph (`src/discover/graph/`)

**Goal:** glue all `ParsedFile[]` together into a single queryable graph where you can ask "every route that renders component X."

**Graph shape:**

```ts
interface ComponentNode {
  id: string                          // file:name (e.g. "src/components/CheckoutModal/index.tsx:CheckoutModal")
  file: string
  name: string
  exported: boolean
  isRouteRoot: boolean                // true if this is a page-level component
  metadata: {
    authGated: boolean                // detected from imports of auth hooks / wrappers
    premiumGated: boolean             // detected from `usePremium()`, `<PremiumOnly>`
    isModal: boolean                  // detected from `<Dialog>`, `role="dialog"`, `<Modal>` parent
    isLazy: boolean                   // dynamic import or React.lazy
    framework: 'react' | 'vue' | 'svelte' | 'astro'
  }
}

interface Edge {
  from: ComponentNode                 // parent that renders this child
  to: ComponentNode                   // child being rendered
  conditional: 'unconditional' | 'ternary' | 'logical-and' | 'if-block'
  triggerProp?: string                // if conditional, what variable controls it (best-effort)
  triggerSelector?: string            // if known, the CSS selector that toggles it (best-effort)
}

interface ComponentGraph {
  nodes: Map<string, ComponentNode>
  edges: Edge[]
  routes: Map<string, RouteDef>       // route path → page component id
}
```

**Concrete tasks:**

1. **Builder** (`builder.ts`):
   - Take `ParsedFile[]` from Phase A
   - For each `componentDef` → create node
   - For each `componentUsage` → create edge
   - Resolve imports: `<Header />` → find which file's `export default Header` it refers to
   - Mark page components from `routes[]` as `isRouteRoot: true`

2. **Annotator** (`annotate.ts`):
   - Detect `authGated` by walking up the import chain looking for `useAuth`, `requireAuth`, `withAuth`, `<Protected>`, etc.
   - Detect `premiumGated` similarly (project-specific patterns, configurable via plugin)
   - Detect `isModal` by structural pattern (e.g. wraps in `<Dialog>`, has `aria-modal` prop, file path contains `modal`)
   - Detect `isLazy` by checking imports for `React.lazy(() => import(...))` or `defineAsyncComponent`

3. **Traverser** (`traverse.ts`):
   - Public API: `findRoutesRendering(componentId: string): Route[]`
   - BFS from each route root, collecting paths that lead to the target component
   - Return all paths sorted by length (shortest = easiest to reach in browser)

4. **Cache** (`cache.ts`):
   - Hash all `ParsedFile[]` → cache key
   - Persist the built graph to `.mountproof/cache/graph.json`
   - On next discovery run, skip rebuilding if files haven't changed

**Estimated work:** ~3 days.

### Phase C — Discovery executor (`src/discover/browse/`)

**Goal:** for each component in the graph, drive a browser to confirm it's reachable, and record the steps that worked.

**State machine per (component, route) pair:**

```
START
  │
  ▼
[Open browser, goto(route)]
  │
  ▼
[Component already rendered?]──Yes──▶ [Record direct trajectory] ──▶ END (success)
  │
  No
  │
  ▼
[Redirected to /login?]──Yes──▶ [Run auth-flow] ──▶ [Retry route]
  │
  No
  │
  ▼
[Is this a modal/overlay?] (from graph metadata)
  │
  Yes
  │
  ▼
[Walk graph for trigger]──Found──▶ [Click trigger] ──▶ [Recheck]
  │                          │
  Not found                  No-show after click
  │                          │
  ▼                          ▼
[Mark unreachable]    [Mark unreachable]
   reason="no-trigger"  reason="trigger-clicked-but-component-not-rendered"
  │
  ▼
END (recorded as unreachable, with reason)
```

**Concrete tasks:**

1. **Direct attempt** (`attempt.ts`):
   - `page.goto(route)` with reasonable waitUntil
   - Wait for any of the component's stable selectors (heuristic-derived from JSX attributes)
   - If found in 8s → record `[{ type: 'navigate', path: route }]` as the trajectory
   - If redirected → attempt detection (URL contains `/login`, `/signin`, query param `?from=`)

2. **Auth flow** (`auth-flow.ts`):
   - Generic adapter that takes:
     - `--auth-user-flow free` or `premium` profile dir (pre-authenticated)
     - OR `--auth-email`/`--auth-password` to log in fresh
     - OR `--auth-plugin ./my-auth.ts` for custom flows
   - On redirect-to-login, ensure profile is loaded; if absent, run the flow once and save profile

3. **Trigger detection** (`trigger.ts`):
   - For modal components, walk graph back to find parents that conditionally render this child
   - For each parent, examine the conditional:
     - Is it tied to a state variable? Find handlers that set that variable
     - Is the handler attached to a JSX element? Extract that element's selector
   - Output: best-guess `triggerSelector` (e.g. `[data-test-id='buy-now-btn']`)
   - Confidence score: high (direct handler), medium (handler in same file), low (cross-file inferred)

4. **Selector synthesis** (`selector.ts`):
   - Prefer `data-test-id`, `data-testid`, `data-cy`
   - Fallback: `aria-label`, `role` + text
   - Last resort: `nth-of-type` chain (least stable, last priority)
   - Same algorithm as Playwright codegen

5. **Per-attempt recording** (`recorder.ts`):
   - For each step the executor takes (navigate, waitForSelector, click, fill, …), record into a `steps[]` array
   - When component is finally visible → emit the trajectory.json with the full step chain
   - Also record `attemptLog[]` (which strategies were tried, what failed, what worked) — debug aid

6. **Mount proof selection** (`proof-suggest.ts`):
   - For each successful discovery, suggest 1-2 proof types:
     - If component has a stable `data-test-id` → `domSelector`
     - If component's file declares an inline-style (Promova case) → `domTag`
     - If component lazy-loads → `network` proof on the chunk URL
   - User can review/edit, or accept auto-suggested

**Estimated work:** ~5 days. The state machine is non-trivial.

### Phase D — Emit (`src/discover/emit/`)

**Goal:** write the discovered trajectories to disk in a stable, version-controllable shape.

**Output layout:**

```
trajectories/
├── checkout-modal.json
├── header-v3.json
├── product-page.json
└── _unreachable.json        ← components we couldn't reach + reason

.mountproof/
├── cache/
│   └── graph.json           ← cached component graph from Phase B
└── discover-log/
    └── 2026-06-15.json      ← attempt log for debugging
```

**Concrete tasks:**

1. **Serializer** (`serialize.ts`):
   - Convert internal `DiscoveredTrajectory` to the public Trajectory JSON shape (defined in `src/types.ts`)
   - Add `discoveryMetadata` block: `{ generatedAt, sourceComponent: 'src/Modal/index.tsx:CheckoutModal', strategy: 'direct'|'auth+click'|..., attempts: 3 }`
   - Stable key ordering for clean diffs in git

2. **Unreachable report** (`unreachable.ts`):
   - For every component the graph thinks is rendered somewhere but discover couldn't reach, write entry with `{ component, attemptedRoutes, lastError, suggestion }`
   - Suggestions: "add `data-test-id` to component X", "auth flow timeout, increase --auth-timeout", "component is only rendered via portal — needs manual trajectory"

3. **Idempotent writes** (`write.ts`):
   - Before overwriting an existing `trajectories/X.json`, diff against the new content
   - If only `discoveryMetadata.generatedAt` changed → don't touch the file (avoid churning git history)
   - If steps or mountProof changed → write, log the diff

**Estimated work:** ~1.5 days.

### Phase E — Drift detection (`src/discover/drift/`)

**Goal:** keep trajectories in sync with code without re-running full discovery every time.

**The problem:** running discovery on a 10 000-component repo costs 30+ minutes. We don't want that on every PR. But trajectories DO need updating when source moves.

**Strategy:**

1. **Hash component source** when first discovered. Store hash in `trajectories/X.json` under `discoveryMetadata.sourceHash`.
2. **On next run**, hash all components, compare to stored hashes.
3. **Re-discover only stale ones.** Component unchanged → trajectory stays. Component changed → re-run discovery on JUST that component (1-2s instead of 30 min).

**Concrete tasks:**

1. **Hasher** (`hash.ts`):
   - Hash component source + all transitively-imported file sources (because changes to a dep can affect rendering)
   - Use `xxhash` or `sha-256` (fast, deterministic)

2. **Comparator** (`compare.ts`):
   - Load all `trajectories/*.json`, extract `sourceHash`
   - Compare to current hashes
   - Emit `{ unchanged: [...], staleRediscoverNeeded: [...], orphaned: [...] }`
   - Orphaned = trajectory exists but component is gone → mark for deletion or migration

3. **Selective re-runner** (`invalidate.ts`):
   - Call Phase A+B+C only on stale components
   - Most CI runs do nothing (component unchanged)
   - Refactors trigger targeted re-discovery

**Estimated work:** ~1 day.

## CLI surface after both modules are built

```bash
# Discover and run in one command (most common — what CI uses)
mountproof full ./my-app \
  --baseline http://localhost:3000 \
  --target   http://localhost:3001 \
  --out      /tmp/mp-run

# Discover only — write trajectories/, don't run yet
mountproof discover ./my-app \
  --out ./trajectories

# Run only — execute existing trajectories/
mountproof run ./trajectories \
  --baseline http://localhost:3000 \
  --target   http://localhost:3001 \
  --out      /tmp/mp-run

# Selective re-discovery — only update what changed
mountproof discover ./my-app --selective

# Show diff between cached graph and current — what changed since last run
mountproof drift ./my-app

# Health check — every trajectory still produces a screenshot?
mountproof check ./trajectories --baseline http://localhost:3000
```

## Configuration file

Project-level config at `mountproof.config.ts` (loaded via tsx, optional):

```ts
import { defineConfig } from '@oleksiimazurenko/mountproof'

export default defineConfig({
  // Where to find source
  source: {
    root: './apps/web',
    include: ['src/**/*.{ts,tsx}'],
    exclude: ['**/*.stories.tsx', '**/*.test.tsx'],
  },

  // Framework override (if auto-detect picks the wrong one)
  framework: 'next-app-router',

  // How to authenticate
  auth: {
    free:    { kind: 'profile-dir', dir: '.mountproof/profiles/free' },
    premium: { kind: 'plugin',      file: './my-premium-auth.ts' },
  },

  // Per-component overrides
  overrides: {
    'src/CheckoutModal/index.tsx:CheckoutModal': {
      mountProof: {
        target: [{ type: 'domSelector', selector: '[data-test-id="checkout-modal"]' }],
      },
      trigger: { selector: '[data-test-id="buy-now-btn"]' },
    },
  },

  // Plugins (custom auth, custom step types, custom proof types)
  plugins: [
    require('./plugins/firebase-auth'),
    require('./plugins/gsap-wait'),
  ],
})
```

## Roadmap with phases

### v0.0.x — PoC (current)
- ✅ Mount proof core + 7 runners + diagnostics
- ✅ Legacy translation for Promova
- ✅ Multi-metric diff with WRONG_FRAME gate
- ✅ Playwright capture (headless, persistent profiles)
- ✅ Trajectory engine with mount-proof gate
- ✅ HTML report with mount-proof badges
- ✅ CLI: trajectory, compare, diff, report, validate
- ✅ Example: button-versioning (validated end-to-end)
- ✅ GitHub repo created (public, empty)
- ⏳ npm publish

### v0.1 — runner production-ready
- Port login flows from Promova, make framework-agnostic
- Network/console recording unified across all capture paths
- Report polish: per-side proof badges
- `--format github-actions` CI output mode
- Documentation site (just the README expanded)

### v0.2 — discover Phase A+B (static analysis) ✅ implemented
- ✅ AST parser dispatcher (oxc for JS/TS/JSX/TSX; vue/svelte/astro deferred)
- ✅ Framework detection
- ✅ File walker (fast-glob + .gitignore respect)
- ✅ Component graph builder + annotator
- ✅ Public API: `findRoutesRendering(componentId)` and friends
- ✅ Tests with a fixture Next.js App Router project (`test/fixtures/next-app-tiny/`)

### v0.3 — discover Phase C+D (browser-driven discovery + emit) ✅ implemented
- ✅ Discovery state machine (direct → auth → trigger), against an abstract `DiscoveryPage`
- ✅ Auth flow adapter: built-in email/password form + `AuthAdapter` plugin interface
- ✅ Trigger detection from graph (override > edge > name heuristic)
- ✅ Selector synthesis (test-id-first priority list)
- ✅ Per-component mount-proof suggestion
- ✅ Emit trajectories + unreachable report (JSON + Markdown), idempotent writes
- ⏳ Live Playwright crawl not yet validated against a real running app

### v0.4 — discover Phase E (drift detection) ✅ implemented
- ✅ Source hashing (component source closure: own file + transitive imports)
- ✅ Selective re-discovery (`--selective`)
- ✅ `mountproof drift` + `mountproof discover` subcommands wired into the CLI

### v0.5 — Configuration + plugins
- `mountproof.config.ts` loader
- Plugin API for auth flows, step types, proof types
- Documented plugin authoring guide

### v1.0 — Production readiness
- All frameworks supported reliably (`next-app`, `next-pages`, `remix`, `sveltekit`, `vue-router`, `astro`)
- Snapshot baseline mode (single-side, against committed PNGs)
- Diff masks
- Mature CI integration (GitHub annotations, GitLab format, Buildkite annotations)
- Documentation site with searchable docs

## Open questions

1. **Multi-package monorepo or single-package directory split?** Currently single-package. Revisit at v0.4 — if discover plugins become non-trivial, split into `@oleksiimazurenko/mountproof-discover` as separate package consuming `@oleksiimazurenko/mountproof-runner`. For now: KISS.

2. **What's the right output of unreachable-components?** A JSON for tooling, also a human-readable Markdown report? Likely both, since these are review artifacts as much as machine inputs.

3. **How aggressive should auto-proof-suggestion be?** Too eager → every trajectory has a `domSelector` for `[data-test-id]` even when not meaningful. Too conservative → trajectories ship without proof, mountproof becomes "yet another snapshot tool." Trade-off: warn loudly when no proof suggested.

4. **Storybook integration.** If the codebase already has Storybook, discover could **reuse** Storybook stories as discovery seeds (each story = pre-isolated component render). This skips Phase C for components that have stories. Decision: yes — but as an optional adapter, not a hard dependency.

5. **Trajectory naming collisions.** When the same component is reachable from multiple routes, do we write `checkout-modal.json` or `checkout-modal-via-buy-now.json`/`checkout-modal-via-cart.json`? Probably the second — multiple trajectories per component is realistic.

6. **Should discover skip server components / `'use server'` files?** Almost certainly yes for the visual side. They have no client render path.

7. **How do we handle internationalization?** Promova has 10 locales. Discovery on every locale × every component = combinatorial explosion. Default: discover at one locale (configurable), test trajectories at all locales (cheap — same trajectory.json runs everywhere).

## Non-goals (explicit)

To keep the project focused:

- **Not a general-purpose e2e framework.** mountproof discovers and verifies *visual mounts*, not user flows. Use Playwright/Cypress for the latter.
- **Not a Storybook replacement.** Storybook shows components in isolation; mountproof verifies them in their real rendering context.
- **Not a cloud service.** Everything runs locally or in your CI. No tracking, no upload, no account.
- **Not for native apps.** Web only (DOM + HTML + Playwright). React Native / Flutter need different tooling.
