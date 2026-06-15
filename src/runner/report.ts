/**
 * Static HTML report generator.
 *
 * Reads `<runDir>/{baseline,target,diff}/` plus `_capture.json` sidecars
 * and emits a single self-contained `report.html` (PNGs inlined as data
 * URIs). Pairs are sorted worst-first so suspicious cases land at the top.
 *
 * Adds a mount-proof badge per pair: green tick if both sides verified,
 * red MOUNT_PROOF_FAIL if either failed (with the failing proofs listed).
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DiffReport, WrongFrameReport } from './diff.js'

interface CaptureSidecar {
  captured: Array<{ name: string; vp: number; file: string; finalUrl?: string; skeletonStillVisible?: boolean }>
  failed: Array<{ name: string; vp: number; reason: string; missing?: unknown }>
}

interface PairView {
  name: string
  target: string
  vp: number
  baselinePng: string
  targetPng: string
  diffPng: string | null
  metrics: DiffReport | WrongFrameReport | null
  baselineFinalUrl: string | undefined
  targetFinalUrl: string | undefined
  baselineSkeleton: boolean
  targetSkeleton: boolean
  /** Failure record from `_capture.json` — present when mount-proof failed for this name+vp. */
  failure: { reason: string; missing?: unknown; side: 'baseline' | 'target' } | null
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readSidecar(p: string): Promise<CaptureSidecar> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as CaptureSidecar
  } catch {
    return { captured: [], failed: [] }
  }
}

async function dataUri(p: string | null): Promise<string> {
  if (!p) return ''
  const buf = await readFile(p)
  return `data:image/png;base64,${buf.toString('base64')}`
}

export interface ReportOptions {
  /** Run directory containing `baseline/`, `target/`, `diff/` subdirs. */
  runDir: string
  /** Output file path. Default `<runDir>/report.html`. */
  out?: string
  /** Override directory names if your run uses different ones (e.g. legacy `prod`/`stage`). */
  baselineDir?: string
  targetDir?: string
  diffDir?: string
}

/**
 * Generate `report.html` for a finished run. Returns the output path.
 *
 * Auto-detects legacy `prod/`/`stage/` directory layout when
 * `baseline/`/`target/` are absent — keeps backward compat with
 * Promova runs.
 */
export async function generateReport(opts: ReportOptions): Promise<string> {
  const runDir = opts.runDir
  let baselineDir = opts.baselineDir ?? path.join(runDir, 'baseline')
  let targetDir = opts.targetDir ?? path.join(runDir, 'target')
  const diffDir = opts.diffDir ?? path.join(runDir, 'diff')

  // Backward compat with the old prod/stage layout.
  if (!(await exists(baselineDir)) && (await exists(path.join(runDir, 'prod')))) {
    baselineDir = path.join(runDir, 'prod')
  }
  if (!(await exists(targetDir)) && (await exists(path.join(runDir, 'stage')))) {
    targetDir = path.join(runDir, 'stage')
  }

  const baselineCap = await readSidecar(path.join(baselineDir, '_capture.json'))
  const targetCap = await readSidecar(path.join(targetDir, '_capture.json'))

  const pairs: PairView[] = []
  for (const c of baselineCap.captured) {
    const fileBase = path.basename(c.file)
    const targetPng = path.join(targetDir, fileBase)
    if (!(await exists(targetPng))) continue
    const diffPng = path.join(diffDir, fileBase)
    const diffJsonPath = path.join(diffDir, fileBase.replace(/\.png$/, '.json'))
    let metrics: DiffReport | WrongFrameReport | null = null
    if (await exists(diffJsonPath)) {
      metrics = JSON.parse(await readFile(diffJsonPath, 'utf8')) as DiffReport | WrongFrameReport
    }
    const stageMatch = targetCap.captured.find(s => s.name === c.name && s.vp === c.vp)
    pairs.push({
      name: fileBase.replace(/\.png$/, ''),
      target: c.name,
      vp: c.vp,
      baselinePng: c.file,
      targetPng,
      diffPng: (await exists(diffPng)) ? diffPng : null,
      metrics,
      baselineFinalUrl: c.finalUrl,
      targetFinalUrl: stageMatch?.finalUrl,
      baselineSkeleton: !!c.skeletonStillVisible,
      targetSkeleton: !!stageMatch?.skeletonStillVisible,
      failure: findFailure(c.name, c.vp, baselineCap, targetCap),
    })
  }

  // Surface mount-proof failures that don't have a matching capture (because
  // the side blew up before screenshotting).
  for (const f of [...baselineCap.failed, ...targetCap.failed]) {
    const key = `${f.name}-${f.vp}`
    if (pairs.some(p => p.name === key)) continue
    pairs.push({
      name: key,
      target: f.name,
      vp: f.vp,
      baselinePng: '',
      targetPng: '',
      diffPng: null,
      metrics: null,
      baselineFinalUrl: undefined,
      targetFinalUrl: undefined,
      baselineSkeleton: false,
      targetSkeleton: false,
      failure: {
        reason: f.reason,
        missing: f.missing,
        side: baselineCap.failed.includes(f) ? 'baseline' : 'target',
      },
    })
  }

  // Sort: mount-proof failures first, then FAIL > WRONG_FRAME > PASS > STRICT_PASS;
  // within each tier, highest pixel diff first.
  pairs.sort((a, b) => {
    const va = effectiveVerdict(a)
    const vb = effectiveVerdict(b)
    const order: Record<string, number> = {
      MOUNT_PROOF_FAIL: 0,
      FAIL: 1,
      WRONG_FRAME: 2,
      PASS: 3,
      STRICT_PASS: 4,
    }
    const oa = order[va] ?? 9
    const ob = order[vb] ?? 9
    if (oa !== ob) return oa - ob
    const pa = (a.metrics && 'metrics' in a.metrics ? a.metrics.metrics.pixelDiffRatio : 0) ?? 0
    const pb = (b.metrics && 'metrics' in b.metrics ? b.metrics.metrics.pixelDiffRatio : 0) ?? 0
    return pb - pa
  })

  const cards = await Promise.all(pairs.map(renderCard))
  const counts = {
    MOUNT_PROOF_FAIL: pairs.filter(p => effectiveVerdict(p) === 'MOUNT_PROOF_FAIL').length,
    FAIL: pairs.filter(p => effectiveVerdict(p) === 'FAIL').length,
    WRONG_FRAME: pairs.filter(p => effectiveVerdict(p) === 'WRONG_FRAME').length,
    PASS: pairs.filter(p => effectiveVerdict(p) === 'PASS').length,
    STRICT_PASS: pairs.filter(p => effectiveVerdict(p) === 'STRICT_PASS').length,
  }
  const html = renderHtml(runDir, pairs.length, counts, cards.join('\n'))

  const outFile = opts.out ?? path.join(runDir, 'report.html')
  await writeFile(outFile, html)
  return outFile
}

function findFailure(name: string, vp: number, baseline: CaptureSidecar, target: CaptureSidecar): PairView['failure'] {
  const bFail = baseline.failed.find(f => f.name === name && f.vp === vp)
  if (bFail) return { reason: bFail.reason, missing: bFail.missing, side: 'baseline' }
  const tFail = target.failed.find(f => f.name === name && f.vp === vp)
  if (tFail) return { reason: tFail.reason, missing: tFail.missing, side: 'target' }
  return null
}

function effectiveVerdict(p: PairView): string {
  if (p.failure?.reason === 'mount-proof-failed') return 'MOUNT_PROOF_FAIL'
  if (p.metrics && 'error' in p.metrics) return 'WRONG_FRAME'
  return (p.metrics as DiffReport | null)?.verdict ?? 'UNKNOWN'
}

async function renderCard(p: PairView): Promise<string> {
  const baseline64 = await dataUri(p.baselinePng)
  const target64 = await dataUri(p.targetPng)
  const diff64 = await dataUri(p.diffPng)
  const m = p.metrics && 'metrics' in p.metrics ? p.metrics.metrics : null
  const verdict = effectiveVerdict(p)
  const verdictClass =
    verdict === 'STRICT_PASS' ? 'v-pass-strict' :
    verdict === 'PASS' ? 'v-pass' :
    verdict === 'FAIL' ? 'v-fail' :
    verdict === 'WRONG_FRAME' ? 'v-warn' :
    verdict === 'MOUNT_PROOF_FAIL' ? 'v-fail' :
    'v-unknown'
  const metricsStr = m
    ? `diff <b>${(m.pixelDiffRatio * 100).toFixed(2)}%</b> · ΔE ${m.deltaEavg.toFixed(2)} · SSIM ${m.ssim?.toFixed(3) ?? 'n/a'}`
    : verdict === 'MOUNT_PROOF_FAIL' ? '(diff not run — mount proof failed)' : 'no metrics'
  const skeletonWarn =
    p.baselineSkeleton || p.targetSkeleton
      ? `<span class="warn">⚠ skeleton still visible${p.baselineSkeleton && p.targetSkeleton ? ' (both)' : p.baselineSkeleton ? ' (baseline)' : ' (target)'} — diff inflated</span>`
      : ''
  const mountProofBlock = p.failure?.reason === 'mount-proof-failed'
    ? `<div class="mount-proof-fail">
        <strong>MOUNT_PROOF_FAIL</strong> on <code>${escapeHtml(p.failure.side)}</code> —
        proof was missing, screenshot is the FAIL diagnostic snapshot.
        <pre>${escapeHtml(JSON.stringify(p.failure.missing, null, 2))}</pre>
      </div>`
    : ''
  return `
<section class="card">
  <header>
    <div>
      <span class="title">${escapeHtml(p.target)}</span>
      <span class="vp">vp ${p.vp}</span>
      <span class="verdict ${verdictClass}">${verdict}</span>
      ${skeletonWarn}
    </div>
    <div class="metrics">${metricsStr}</div>
  </header>
  <div class="urls">
    <span>baseline → ${escapeHtml(p.baselineFinalUrl ?? '')}</span>
    <span>target → ${escapeHtml(p.targetFinalUrl ?? '')}</span>
  </div>
  ${mountProofBlock}
  <div class="triple">
    <figure><figcaption>baseline${p.baselineSkeleton ? ' · ⚠ skeleton' : ''}</figcaption>${baseline64 ? `<img src="${baseline64}" alt="baseline">` : '<div class="no-diff">(no capture)</div>'}</figure>
    <figure><figcaption>target${p.targetSkeleton ? ' · ⚠ skeleton' : ''}</figcaption>${target64 ? `<img src="${target64}" alt="target">` : '<div class="no-diff">(no capture)</div>'}</figure>
    <figure><figcaption>diff</figcaption>${diff64 ? `<img src="${diff64}" alt="diff">` : '<div class="no-diff">no diff image</div>'}</figure>
  </div>
</section>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
}

function renderHtml(
  runDir: string,
  total: number,
  counts: Record<string, number>,
  cards: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mountproof — ${escapeHtml(path.basename(runDir))}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; background: #0f1115; color: #e7e7e7; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .sub { color: #888; margin-bottom: 16px; }
  .card { background: #16191f; border: 1px solid #262932; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .card header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .title { font-weight: 700; font-size: 15px; }
  .vp { color: #888; margin-left: 8px; }
  .verdict { display: inline-block; padding: 2px 8px; border-radius: 4px; margin-left: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
  .v-fail { background: #3b1414; color: #ff6b6b; }
  .v-warn { background: #3b2914; color: #ffb86b; }
  .v-pass { background: #143b25; color: #6bff8d; }
  .v-pass-strict { background: #143b25; color: #6bff8d; }
  .v-unknown { background: #2a2a2a; color: #999; }
  .warn { background: #3b2914; color: #ffb86b; padding: 2px 8px; border-radius: 4px; margin-left: 8px; font-size: 11px; font-weight: 600; }
  .metrics { color: #c8c8c8; font-size: 12px; font-family: ui-monospace, monospace; }
  .urls { color: #6e7280; font-size: 11px; margin: 4px 0 10px; display: flex; gap: 16px; flex-wrap: wrap; font-family: ui-monospace, monospace; }
  .mount-proof-fail { background: #3b1414; border: 1px solid #5b2424; border-radius: 6px; padding: 8px 12px; margin: 8px 0; color: #ff9b9b; font-size: 12px; }
  .mount-proof-fail pre { background: #1a0808; padding: 6px 8px; border-radius: 4px; margin: 6px 0 0; font-family: ui-monospace, monospace; font-size: 11px; overflow-x: auto; color: #ffcfcf; }
  .triple { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  figure { margin: 0; background: #0b0d11; border: 1px solid #262932; border-radius: 6px; overflow: hidden; }
  figcaption { padding: 4px 8px; background: #1c1f27; color: #aaa; font-size: 11px; font-family: ui-monospace, monospace; }
  img { display: block; width: 100%; height: auto; background: #fff; }
  .no-diff { padding: 40px 12px; color: #666; font-size: 12px; text-align: center; }
  .summary { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  .summary span { padding: 4px 10px; border: 1px solid #262932; border-radius: 4px; font-size: 12px; }
  .summary .crit { border-color: #5b2424; background: #1a0808; color: #ff9b9b; }
</style>
</head>
<body>
  <h1>mountproof — <span style="font-family: ui-monospace, monospace;">${escapeHtml(path.basename(runDir))}</span></h1>
  <p class="sub">${total} pair(s) · sorted worst-first</p>
  <div class="summary">
    <span class="crit">MOUNT_PROOF_FAIL: ${counts.MOUNT_PROOF_FAIL}</span>
    <span>FAIL: ${counts.FAIL}</span>
    <span>WRONG_FRAME: ${counts.WRONG_FRAME}</span>
    <span>PASS: ${counts.PASS}</span>
    <span>STRICT_PASS: ${counts.STRICT_PASS}</span>
  </div>
  ${cards}
</body>
</html>`
}

/** List PNGs in `<runDir>/baseline/` whose names also exist in `<runDir>/target/`. */
export async function findPairableScreenshots(baselineDir: string, targetDir: string): Promise<string[]> {
  const baselineFiles = (await readdir(baselineDir).catch(() => [])).filter(f => f.endsWith('.png'))
  const targetSet = new Set((await readdir(targetDir).catch(() => [])).filter(f => f.endsWith('.png')))
  return baselineFiles.filter(f => targetSet.has(f))
}
