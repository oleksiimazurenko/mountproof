# Example — Button v2 → v3 migration

A minimal end-to-end demo of why `mountproof` exists.

## The scenario

You're shipping a "button v3" redesign. CI runs visual regression: take a
screenshot of the page on `main`, take one on the PR branch, pixel-diff
them. If the diff is non-trivial → PR fails. Easy.

There's a class of bug this misses: **the new bundle never loaded on the
target side.** Stale build cache, fallback path, missing migration apply,
A/B variant locked, deploy didn't actually deploy — pick your poison. Your
"target" URL is serving the old code. Pixel diff says PASS — both sides
are identical (because both are running v2). You merge a regression you
didn't even test.

`mountproof` fixes this with one line of JSON: a **mount proof** the
target side must satisfy before the pixel diff runs. If the proof isn't
found → exit 5, no diff, with diagnostics that name what was missing.

## Files

| File | Role |
|---|---|
| `baseline.html` | Button v2 — flat blue, the "old" version |
| `target.html` | Button v3 — gradient, `<style data-href="button_v3">` marker |
| `target-stale.html` | Button v2 served as "target" by mistake — NO marker |
| `trajectory.json` | The check: navigate, screenshot button, **require `style[data-href='button_v3']` on target** |
| `run.sh` | Starts servers, runs mountproof twice (honest, stale) |

## Run it

```bash
# One-time: install Playwright Chromium
npx playwright install chromium

./run.sh
```

Two runs:

**Run 1 — Honest.** Baseline serves v2, target serves v3 (with the
`data-href="button_v3"` marker). mountproof finds the proof on target →
runs pixel diff → reports the genuine visual change. **Verdict: FAIL or
PASS depending on whether you want the style change accepted.**

**Run 2 — Stale.** Baseline serves v2, target *also* serves v2 (without
the marker — simulating a stale deploy). Without mountproof, pixel diff
would say `STRICT_PASS` (the images are pixel-identical) and you'd ship a
regression you never tested. With mountproof, the run aborts before
diffing:

```
[trajectory target] {"stage":"mount-proof","ok":false,"side":"target","error":"MOUNT_PROOF_FAIL on target: 1 proof(s) not satisfied at http://localhost:4502/\n  • domTag `style[data-href='button_v3']`\n  Closest matches:\n    domTag `style[data-href='button_v3']` →\n      [style] <style>…</style>"}
Exit code: 5 (expected 5 = MOUNT_PROOF_FAIL)
```

The diagnostic tells you:
- which proof failed (`domTag style[data-href='button_v3']`)
- the URL it was looking at (`http://localhost:4502/`)
- the closest DOM matches it could find (relaxed `style[data-href]` →
  `style`) so you can see what the page actually had

## How it works

`trajectory.json` declares one trajectory:

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

The `mountProof` is **asymmetric** — `baseline: []` (nothing to verify on
the old side, of course it doesn't have a v3 marker) and `target: [...]`
(must find the v3 marker, otherwise abort). This is the common case:
proofs name something the new code is supposed to introduce.

`mountproof trajectory` runs the trajectory on both sides in parallel,
runs `verifyMountProof('baseline', …)` and `verifyMountProof('target', …)`
after the steps complete, only proceeds to `diffPair` if both proof
checks pass.

## Picking the right proof type

Seven proof types ship in core (see `src/types.ts`):

| Type | When to use |
|---|---|
| `domSelector` | Component renders a stable `[data-version='v3']` attribute |
| `domTag` | New code injects a CSS module / inline style with a known marker |
| `domTextContains` | Hard-coded version label visible in DOM |
| `network` | New code loads a versioned bundle (`/static/v3.*.js`) |
| `console` | New code prints a `[Header] mounted: v3` line during boot |
| `eval` | Page exposes `window.__BUILD_HASH` or a feature flag check |
| `htmlContains` | Server-rendered marker baked into HTML output |

Choose the cheapest, most specific proof you have. Whatever survives
build steps and isn't accidentally present in the old code.
