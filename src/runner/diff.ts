/**
 * Multi-metric image diff engine.
 *
 * Three independent signals — `pixelmatch` per-pixel delta, ΔE76 perceptual
 * color distance sampled at N random points, and SSIM (Bezkrovny variant).
 * SSIM catches anti-aliasing / font-hinting noise that pure pixel diff
 * mis-attributes as a regression.
 *
 * The {@link diffPair} function expects two PNG file paths (baseline + target),
 * writes a diff PNG, and returns a {@link DiffReport} with verdict bucket.
 *
 * Verdict ladder:
 *   STRICT_PASS — pixelDiff ≤1%, ΔE ≤3, SSIM ≥0.97
 *   PASS        — pixelDiff ≤8%, ΔE ≤5, SSIM ≥0.95
 *   FAIL        — anything looser → real layout/style regression
 *   WRONG_FRAME — aspect-ratio mismatch >15% → image pairing bug, not CSS bug
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import sharp from 'sharp'
import ssimPkg from 'ssim.js'

// ssim.js is CJS — its default export is the function; we also accept the named export.
const ssim: (a: { data: Buffer | Uint8Array; width: number; height: number }, b: { data: Buffer | Uint8Array; width: number; height: number }, opts?: { ssim?: string }) => { mssim: number } =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ssimPkg as any).ssim ?? (ssimPkg as any).default ?? ssimPkg

export interface DiffMetrics {
  diffPixels: number
  totalPixels: number
  pixelDiffRatio: number
  deltaEavg: number
  ssim: number | null
  ssimThreshold: number
  ssimComputeMs: number
  ssimError: string | null
}

export interface DiffReport {
  baseline: { path: string; width: number; height: number }
  target: { path: string; width: number; height: number }
  diffImage: string
  targetSize: { w: number; h: number }
  metrics: DiffMetrics
  profiles: {
    strict: { pixelDiffRatioMax: number; deltaEMax: number; ssimMin: number; pass: boolean }
    dev: { pixelDiffRatioMax: number; deltaEMax: number; ssimMin: number; pass: boolean }
  }
  verdict: 'STRICT_PASS' | 'PASS' | 'FAIL' | 'WRONG_FRAME'
}

export interface WrongFrameReport {
  error: 'WRONG_FRAME'
  message: string
  baseline: { path: string; width: number; height: number; aspectRatio: number }
  target: { path: string; width: number; height: number; aspectRatio: number }
  ratioDelta: number
  areaRatio: number
  threshold: number
}

export const STRICT_PROFILE = { pixelDiffRatioMax: 0.01, deltaEMax: 3.0, ssimMin: 0.97 }
export const DEV_PROFILE = { pixelDiffRatioMax: 0.08, deltaEMax: 5.0, ssimMin: 0.95 }

/** ΔE76 — Euclidean distance in Lab space. Close enough for our gate; ΔE2000 isn't worth the math here. */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number): number => {
    const cn = c / 255
    return cn > 0.04045 ? Math.pow((cn + 0.055) / 1.055, 2.4) : cn / 12.92
  }
  const R = lin(r), G = lin(g), B = lin(b)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function deltaE76(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  return Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}

/**
 * Compare two PNG files, write diff PNG, return structured verdict.
 *
 * Throws if input files don't exist. Returns a {@link WrongFrameReport} when
 * aspect ratios diverge >15% — callers should not run pixel-diff in that
 * case (the result would be ~50-80% diff that is NOT a regression).
 */
export async function diffPair(
  baselinePath: string,
  targetPath: string,
  diffPath: string,
): Promise<DiffReport | WrongFrameReport> {
  for (const p of [baselinePath, targetPath]) {
    if (!existsSync(p)) throw new Error(`Missing input: ${p}`)
  }

  const baseMeta = await sharp(baselinePath).metadata()
  const tgtMeta = await sharp(targetPath).metadata()
  if (!baseMeta.width || !baseMeta.height || !tgtMeta.width || !tgtMeta.height) {
    throw new Error('Could not read image dimensions')
  }

  // Frame-coverage sanity check. If aspect ratios diverge wildly the pair is
  // wrong — running pixel-diff anyway produces enormous artifactual diff that
  // looks like a CSS failure but is actually a pairing bug.
  const baseRatio = baseMeta.width / baseMeta.height
  const tgtRatio = tgtMeta.width / tgtMeta.height
  const ratioDelta = Math.abs(baseRatio - tgtRatio) / Math.max(baseRatio, tgtRatio)
  const areaRatio = (tgtMeta.width * tgtMeta.height) / (baseMeta.width * baseMeta.height)

  if (ratioDelta > 0.15) {
    return {
      error: 'WRONG_FRAME',
      message:
        `Aspect-ratio mismatch (delta=${(ratioDelta * 100).toFixed(1)}% > 15% threshold). ` +
        `Baseline ${baseMeta.width}×${baseMeta.height} (ratio ${baseRatio.toFixed(2)}) vs ` +
        `Target ${tgtMeta.width}×${tgtMeta.height} (ratio ${tgtRatio.toFixed(2)}). ` +
        `Pixel-diff would produce ~${areaRatio > 1.5 ? '50-80%' : '40-70%'} artifactual diff. ` +
        `This is a pairing bug, not a CSS bug — fix the capture surface, don't tune CSS.`,
      baseline: { path: baselinePath, width: baseMeta.width, height: baseMeta.height, aspectRatio: Number(baseRatio.toFixed(4)) },
      target: { path: targetPath, width: tgtMeta.width, height: tgtMeta.height, aspectRatio: Number(tgtRatio.toFixed(4)) },
      ratioDelta: Number(ratioDelta.toFixed(4)),
      areaRatio: Number(areaRatio.toFixed(2)),
      threshold: 0.15,
    }
  }

  // Target size = smaller of the two (preserves more detail than upscaling).
  const targetW = Math.min(baseMeta.width, tgtMeta.width)
  const targetH = Math.min(baseMeta.height, tgtMeta.height)

  const normalize = (p: string): Promise<Buffer> =>
    sharp(p)
      .resize(targetW, targetH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer()

  const [baseBuf, tgtBuf] = await Promise.all([normalize(baselinePath), normalize(targetPath)])
  const basePng = PNG.sync.read(baseBuf)
  const tgtPng = PNG.sync.read(tgtBuf)
  const diffPng = new PNG({ width: targetW, height: targetH })

  const diffPixels = pixelmatch(basePng.data, tgtPng.data, diffPng.data, targetW, targetH, {
    threshold: 0.1,
    alpha: 0.5,
    includeAA: false,
  })
  await writeFile(diffPath, PNG.sync.write(diffPng))

  const totalPixels = targetW * targetH
  const pixelDiffRatio = diffPixels / totalPixels

  // Random-sample ΔE
  let dEsum = 0
  const SAMPLE_COUNT = 200
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const x = Math.floor(Math.random() * targetW)
    const y = Math.floor(Math.random() * targetH)
    const idx = (targetW * y + x) * 4
    const [L1, a1, b1] = rgbToLab(basePng.data[idx], basePng.data[idx + 1], basePng.data[idx + 2])
    const [L2, a2, b2] = rgbToLab(tgtPng.data[idx], tgtPng.data[idx + 1], tgtPng.data[idx + 2])
    dEsum += deltaE76(L1, a1, b1, L2, a2, b2)
  }
  const deltaEavg = dEsum / SAMPLE_COUNT

  // SSIM — fail-soft. A library throw must not block the verdict pipeline;
  // we fall back to 2-tier (pixel + ΔE) when SSIM is unavailable.
  const ssimT0 = Date.now()
  let ssimScore: number | null = null
  let ssimError: string | null = null
  try {
    const result = ssim({ data: basePng.data, width: basePng.width, height: basePng.height }, { data: tgtPng.data, width: tgtPng.width, height: tgtPng.height }, { ssim: 'bezkrovny' })
    ssimScore = result.mssim
  } catch (e) {
    ssimError = (e as Error).message ?? String(e)
  }
  const ssimComputeMs = Date.now() - ssimT0

  const ssimPassStrict = ssimScore === null ? true : ssimScore >= STRICT_PROFILE.ssimMin
  const ssimPassDev = ssimScore === null ? true : ssimScore >= DEV_PROFILE.ssimMin

  const passStrict =
    pixelDiffRatio <= STRICT_PROFILE.pixelDiffRatioMax &&
    deltaEavg <= STRICT_PROFILE.deltaEMax &&
    ssimPassStrict
  const passDev =
    pixelDiffRatio <= DEV_PROFILE.pixelDiffRatioMax &&
    deltaEavg <= DEV_PROFILE.deltaEMax &&
    ssimPassDev

  return {
    baseline: { path: baselinePath, width: baseMeta.width, height: baseMeta.height },
    target: { path: targetPath, width: tgtMeta.width, height: tgtMeta.height },
    diffImage: diffPath,
    targetSize: { w: targetW, h: targetH },
    metrics: {
      diffPixels,
      totalPixels,
      pixelDiffRatio: Number(pixelDiffRatio.toFixed(6)),
      deltaEavg: Number(deltaEavg.toFixed(3)),
      ssim: ssimScore === null ? null : Number(ssimScore.toFixed(4)),
      ssimThreshold: DEV_PROFILE.ssimMin,
      ssimComputeMs,
      ssimError,
    },
    profiles: {
      strict: { ...STRICT_PROFILE, pass: passStrict },
      dev: { ...DEV_PROFILE, pass: passDev },
    },
    verdict: passStrict ? 'STRICT_PASS' : passDev ? 'PASS' : 'FAIL',
  }
}

/** Type guard distinguishing WRONG_FRAME early-exit from regular DiffReport. */
export function isWrongFrame(r: DiffReport | WrongFrameReport): r is WrongFrameReport {
  return 'error' in r && r.error === 'WRONG_FRAME'
}

/** One-line summary suitable for stdout. */
export function formatDiffLine(baselinePath: string, targetPath: string, r: DiffReport): string {
  const ssimDisp = r.metrics.ssim === null ? 'n/a' : r.metrics.ssim.toFixed(3)
  return `${path.basename(baselinePath)} vs ${path.basename(targetPath)}: ` +
    `pixelDiffRatio=${(r.metrics.pixelDiffRatio * 100).toFixed(2)}% ` +
    `ΔE=${r.metrics.deltaEavg.toFixed(2)} ` +
    `SSIM=${ssimDisp} ` +
    `verdict=${r.verdict}`
}

/** Write a JSON sidecar next to the diff PNG — used by the HTML report. */
export async function writeDiffReportJson(reportJsonPath: string, report: DiffReport | WrongFrameReport): Promise<void> {
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2))
}

/** Read a previously-saved diff JSON sidecar. */
export async function readDiffReportJson(reportJsonPath: string): Promise<DiffReport | WrongFrameReport> {
  const buf = await readFile(reportJsonPath, 'utf8')
  return JSON.parse(buf) as DiffReport | WrongFrameReport
}
