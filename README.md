# mountproof

> Visual regression that won't lie to you.

Most visual-regression tools answer one question: "do these two screenshots look the same?" They never check whether you took screenshots of the **right code** on both sides. That's the lie. When a build serves a stale bundle, the diff is `STRICT_PASS` — and you ship a regression you never even tested.

`mountproof` adds **mount proof** to every comparison: a declarative assertion that a verifiable trace of the target component exists in the DOM, network, console, or `window` of both sides *before* pixel-diff runs. Proof missing → exit 5, no diff, with diagnostics that name what was searched for and the closest matches that came up empty.

## Status

Early. PoC publish. Core engine + 7 proof types + Playwright capture + 3-metric diff + HTML report. API may still move.

## Install

```bash
npm i -D @oleksiimazurenko/mountproof
npx playwright install chromium
```

## 5-minute quickstart

Two URLs, one trajectory JSON, one command.

**`trajectory.json`:**

```json
{
  "name": "cta-button-v3",
  "mountProof": {
    "baseline": [],
    "target": [
      { "type": "domTag", "selector": "style[data-href='button_v3']" }
    ]
  },
  "steps": [
    { "type": "navigate", "path": "/" },
    { "type": "waitForSelector", "selector": "[data-test-id='cta-button']" }
  ],
  "capture": {
    "name": "cta-button",
    "selector": "[data-test-id='cta-button']"
  }
}
```

**Run:**

```bash
npx mountproof trajectory ./trajectory.json \
  --baseline http://localhost:3000 \
  --target   http://localhost:3001 \
  --out      /tmp/cta-button-run
```

**You get:**

```
==> Executing trajectory trajectory.json on baseline + target in parallel…
[trajectory baseline] {"stage":"viewport","w":1440,"h":900}
[trajectory target]   {"stage":"viewport","w":1440,"h":900}
[trajectory baseline] {"stage":"step-1-navigate","ok":true}
[trajectory target]   {"stage":"step-1-navigate","ok":true}
[trajectory baseline] {"stage":"step-2-waitForSelector","ok":true}
[trajectory target]   {"stage":"step-2-waitForSelector","ok":true}
[trajectory target]   {"stage":"mount-proof","ok":true,"side":"target","count":1}
[trajectory baseline] {"stage":"capture","ok":true,"file":"…/cta-button-1440.png"}
[trajectory target]   {"stage":"capture","ok":true,"file":"…/cta-button-1440.png"}
==> Diffing captured pairs…
cta-button-1440.png vs cta-button-1440.png: pixelDiffRatio=4.21% ΔE=4.92 SSIM=0.961 verdict=PASS
==> Generating HTML report…
  Report: file:///tmp/cta-button-run/report.html
```

`file:///tmp/cta-button-run/report.html` is a self-contained dashboard — three columns per pair (baseline / target / diff), worst-first sort, mount-proof badge per row.

**If the target is stale** (serving v2 from where v3 was supposed to be), the run aborts with exit code 5 — *before* pixel-diff runs:

```
[trajectory target] {"stage":"mount-proof","ok":false,"side":"target",
  "error":"MOUNT_PROOF_FAIL on target: 1 proof(s) not satisfied at http://localhost:3001/
    • domTag `style[data-href='button_v3']`
    Closest matches:
      domTag `style[data-href='button_v3']` →
        [style] <style>…</style>"}
==> Skipping diff — one or both sides did not complete successfully.
exit 5
```

That's the lie caught.

See `examples/button-versioning/` for a complete runnable demo (two static HTML files, a server starter script, both honest and stale runs side by side).

## The seven proof types

| Type | Use when | Example |
|---|---|---|
| `domSelector` | Component renders a stable attribute | `[data-component='Header'][data-version='v3']` |
| `domTag` | New code injects an inline CSS / `<style>` with a known marker | `style[data-href='header_v3']` |
| `domTextContains` | A version label is rendered as text | selector matches and `.textContent` includes `"v3"` |
| `network` | New code loads a versioned bundle | URL pattern `/header-v3\..*\.js` returned 200 |
| `console` | New code prints a boot line | console contains `"[Header] mounted: v3"` |
| `eval` | App exposes a runtime flag | `await page.evaluate("window.__BUILD_HASH === 'ABCD'")` |
| `htmlContains` | Server-rendered marker baked into the HTML | raw HTML contains `data-flint-build="v3"` |

Asymmetric is the common case — `baseline: []` (the old code obviously doesn't have a v3 marker) and `target: [...]`. The CLI accepts the JSON as-is; if you have legacy Promova-style `assertInlineStyle: ["X"]`, it's auto-translated to `mountProof.target: [{ type: 'domTag', selector: "style[data-href='X']" }]`.

## How it differs from existing tools

| Tool | Catches stale-bundle PASS? | Declarative trajectories? | Multi-metric diff? | Local-only? |
|---|---|---|---|---|
| **mountproof** | **Yes — mount proof** | **JSON** | **pixel + ΔE + SSIM** | **Yes** |
| Percy | No | Imperative (JS test) | Pixel only | Cloud-only |
| Chromatic | No | Imperative (Storybook) | Pixel + heuristics | Cloud-only |
| Playwright snapshots | No | Imperative (JS test) | Pixel only | Yes |
| BackstopJS | No | JSON config | Pixel + threshold | Yes |

The "catches stale-bundle PASS" column is the whole reason this exists. Every tool in that list will happily diff v2 against v2 and call it green if your deploy didn't actually apply.

## Architecture

Six modules, ~1 500 lines TS total:

```
src/
├── types.ts            ← public type contract (Trajectory, MountProof, ProofType, Verdict)
├── mount-proof.ts      ← core: 7 runners, MountProofError, diagnostics — no Playwright import
├── legacy-translate.ts ← backward-compat for assertInlineStyle → mountProof.target
├── diff.ts             ← pixelmatch + ΔE76 + SSIM, with WRONG_FRAME aspect-ratio gate
├── capture.ts          ← Playwright capture (viewports, skeleton-wait, frozen anims)
├── trajectory.ts       ← step engine + mount-proof verification + capture
├── report.ts           ← self-contained HTML report with mount-proof badges
└── cli.ts              ← commander wiring — trajectory, compare, diff, report, validate
```

The mount-proof engine deliberately doesn't import Playwright. It talks through a `PageLike` interface so tests run in pure Vitest (no browser) and the same engine could one day drive Puppeteer / WebDriver / SSR-only HTML checks.

## API (when you want to embed, not CLI)

```ts
import {
  verifyMountProofBothSides,
  diffPair,
  generateReport,
  type Trajectory,
} from '@oleksiimazurenko/mountproof'

const traj: Trajectory = JSON.parse(/* ... */)
// ...drive Playwright yourself, then:
await verifyMountProofBothSides(traj.mountProof, { baseline, target }, { baseline: bctx, target: tctx })
const report = await diffPair('baseline.png', 'target.png', 'diff.png')
await generateReport({ runDir: '/tmp/my-run' })
```

## Verdicts and exit codes

| Verdict | Exit | Meaning |
|---|---|---|
| `STRICT_PASS` | 0 | ≤1% pixel diff, ΔE ≤3, SSIM ≥0.97 — basically identical |
| `PASS` | 1 | ≤8%, ΔE ≤5, SSIM ≥0.95 — minor anti-aliasing/font noise, structurally same |
| `FAIL` | 2 | over thresholds — real CSS / layout change |
| `SCRIPT_ERROR` | 3 | tool bug — missing files, can't decode, etc. |
| `WRONG_FRAME` | 4 | aspect ratio mismatch >15% — image pairing bug, not CSS bug |
| `MOUNT_PROOF_FAIL` | 5 | proof missing — diff didn't run, fix your test or your deploy |

## License

MIT
