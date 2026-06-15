#!/usr/bin/env node
/**
 * mountproof CLI — wires the engine modules to user-invokable subcommands.
 *
 *   mountproof trajectory <file> --baseline <url> --target <url> --out <dir>
 *     Execute one trajectory on both sides in parallel, verify mount proofs,
 *     diff captured screenshots, emit HTML report.
 *
 *   mountproof compare <targets.json> --baseline <url> --target <url> --out <dir>
 *     Same idea, but for a multi-target `targets.json` (no per-target steps).
 *
 *   mountproof diff <baseline.png> <target.png> <diff.png> [--json <report.json>]
 *     One-shot pixel diff between two PNG files.
 *
 *   mountproof report <runDir>
 *     Re-generate HTML report from existing `<runDir>/{baseline,target,diff}/`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Command } from 'commander'

import { captureFromFile, type CaptureTarget } from './runner/capture.js'
import { diffPair, formatDiffLine, isWrongFrame, writeDiffReportJson } from './runner/diff.js'
import { generateReport } from './runner/report.js'
import { runTrajectoryFromFile } from './runner/trajectory.js'
import type { LegacyTrajectory, Trajectory } from './types.js'

const program = new Command()
program
  .name('mountproof')
  .description('Visual regression that won\'t lie to you — declarative trajectories with mount-proof verification + multi-metric pixel diff')
  .version('0.0.1')

// ─── trajectory ────────────────────────────────────────────────────────────

program
  .command('trajectory <trajectory.json>')
  .description('Execute a trajectory on baseline + target in parallel; verify mount proofs; diff; report')
  .requiredOption('--baseline <url>', 'Baseline base URL')
  .requiredOption('--target <url>', 'Target base URL')
  .requiredOption('--out <dir>', 'Output directory for screenshots + report')
  .option('--baseline-profile <dir>', 'Persistent Playwright profile for baseline')
  .option('--target-profile <dir>', 'Persistent Playwright profile for target')
  .action(async (trajectoryPath: string, opts: {
    baseline: string
    target: string
    out: string
    baselineProfile?: string
    targetProfile?: string
  }) => {
    const runDir = path.resolve(opts.out)
    const baselineDir = path.join(runDir, 'baseline')
    const targetDir = path.join(runDir, 'target')
    const diffDir = path.join(runDir, 'diff')
    await mkdir(baselineDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await mkdir(diffDir, { recursive: true })

    console.log(`==> Executing trajectory ${path.basename(trajectoryPath)} on baseline + target in parallel…`)
    const [baselineResult, targetResult] = await Promise.allSettled([
      runTrajectoryFromFile(trajectoryPath, {
        side: 'baseline',
        base: opts.baseline,
        outDir: baselineDir,
        profileDir: opts.baselineProfile,
      }),
      runTrajectoryFromFile(trajectoryPath, {
        side: 'target',
        base: opts.target,
        outDir: targetDir,
        profileDir: opts.targetProfile,
      }),
    ])

    const baselineFailed = baselineResult.status === 'rejected'
    const targetFailed = targetResult.status === 'rejected'
    if (baselineFailed) console.error('baseline trajectory failed:', baselineResult.reason)
    if (targetFailed) console.error('target trajectory failed:', targetResult.reason)

    // If mount-proof failed on either side, report still runs so the user can
    // see the FAIL diagnostic snapshot. We just don't pixel-diff.
    if (!baselineFailed && !targetFailed) {
      console.log('==> Diffing captured pairs…')
      await diffAllPairs(baselineDir, targetDir, diffDir)
    } else {
      console.log('==> Skipping diff — one or both sides did not complete successfully.')
    }

    console.log('==> Generating HTML report…')
    const reportPath = await generateReport({ runDir })
    console.log(`\n  Artifacts: ${runDir}`)
    console.log('    baseline/   target/   diff/   _trajectory.json   report.html')
    console.log(`  Report: file://${reportPath}`)

    // Surface mount-proof failure as exit code 5.
    if (baselineFailed || targetFailed) {
      const exitCode = isMountProofFailure(baselineFailed ? baselineResult.reason : targetFailed ? targetResult.reason : null) ? 5 : 1
      process.exit(exitCode)
    }
  })

// ─── compare ───────────────────────────────────────────────────────────────

program
  .command('compare <targets.json>')
  .description('Capture multi-target list on baseline + target; diff; report')
  .requiredOption('--baseline <url>', 'Baseline base URL')
  .requiredOption('--target <url>', 'Target base URL')
  .requiredOption('--out <dir>', 'Output directory')
  .option('--baseline-profile <dir>', 'Persistent Playwright profile for baseline')
  .option('--target-profile <dir>', 'Persistent Playwright profile for target')
  .option('--viewports <list>', 'Comma-separated widths', '1440,768,360')
  .action(async (targetsPath: string, opts: {
    baseline: string
    target: string
    out: string
    baselineProfile?: string
    targetProfile?: string
    viewports: string
  }) => {
    const runDir = path.resolve(opts.out)
    const baselineDir = path.join(runDir, 'baseline')
    const targetDir = path.join(runDir, 'target')
    const diffDir = path.join(runDir, 'diff')
    await mkdir(baselineDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await mkdir(diffDir, { recursive: true })

    const viewports = opts.viewports.split(',').map(v => parseInt(v.trim(), 10))
    const absTargetsPath = path.resolve(targetsPath)

    console.log(`==> Capturing baseline + target in parallel…`)
    await Promise.all([
      captureFromFile(absTargetsPath, opts.baseline, baselineDir, opts.baselineProfile, viewports),
      captureFromFile(absTargetsPath, opts.target, targetDir, opts.targetProfile, viewports),
    ])

    console.log('==> Diffing pairs…')
    await diffAllPairs(baselineDir, targetDir, diffDir)

    console.log('==> Generating HTML report…')
    const reportPath = await generateReport({ runDir })
    console.log(`\n  Artifacts: ${runDir}`)
    console.log(`  Report: file://${reportPath}`)
  })

// ─── diff ──────────────────────────────────────────────────────────────────

program
  .command('diff <baseline.png> <target.png> <diff.png>')
  .description('One-shot pixel diff: pixelmatch + ΔE + SSIM with WRONG_FRAME gate')
  .option('--json <report.json>', 'Write structured report JSON next to diff.png')
  .action(async (baselinePath: string, targetPath: string, diffPath: string, opts: { json?: string }) => {
    const report = await diffPair(baselinePath, targetPath, diffPath)
    if (isWrongFrame(report)) {
      console.error(`WRONG_FRAME: ${report.message}`)
      if (opts.json) await writeDiffReportJson(opts.json, report)
      process.exit(4)
    }
    console.log(formatDiffLine(baselinePath, targetPath, report))
    if (opts.json) await writeDiffReportJson(opts.json, report)
    if (report.verdict === 'STRICT_PASS') process.exit(0)
    if (report.verdict === 'PASS') process.exit(1)
    process.exit(2)
  })

// ─── report ────────────────────────────────────────────────────────────────

program
  .command('report <runDir>')
  .description('Re-generate HTML report from existing run artifacts')
  .action(async (runDir: string) => {
    const reportPath = await generateReport({ runDir: path.resolve(runDir) })
    console.log(`Report: file://${reportPath}`)
  })

// ─── validate ──────────────────────────────────────────────────────────────

program
  .command('validate <trajectory.json>')
  .description('Schema-check a trajectory file without running it')
  .action(async (trajectoryPath: string) => {
    const raw = await readFile(trajectoryPath, 'utf8')
    const traj = JSON.parse(raw) as Trajectory | LegacyTrajectory
    const errors: string[] = []
    if (!traj.name) errors.push('missing `name`')
    if (!Array.isArray(traj.steps)) errors.push('missing or non-array `steps`')
    if (!traj.capture?.name) errors.push('missing `capture.name`')
    if ('assertInlineStyle' in traj && Array.isArray(traj.assertInlineStyle)) {
      console.log(`note: legacy \`assertInlineStyle\` will be auto-translated to mountProof.target`)
    }
    if (errors.length > 0) {
      console.error(`Invalid trajectory: ${errors.join('; ')}`)
      process.exit(2)
    }
    console.log(`OK: trajectory "${traj.name}" — ${traj.steps.length} step(s), capture "${traj.capture.name}"`)
  })

// ─── helpers ───────────────────────────────────────────────────────────────

async function diffAllPairs(baselineDir: string, targetDir: string, diffDir: string): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const baselineFiles = (await readdir(baselineDir)).filter(f => f.endsWith('.png') && !f.includes('FAIL'))
  for (const name of baselineFiles) {
    const baseline = path.join(baselineDir, name)
    const target = path.join(targetDir, name)
    try {
      await readFile(target).then(() => true)
    } catch {
      console.log(`    SKIP ${name} (no target counterpart)`)
      continue
    }
    const diff = path.join(diffDir, name)
    const reportJson = path.join(diffDir, name.replace(/\.png$/, '.json'))
    try {
      const report = await diffPair(baseline, target, diff)
      await writeDiffReportJson(reportJson, report)
      if (isWrongFrame(report)) {
        console.log(`    WRONG_FRAME ${name} (Δratio=${(report.ratioDelta * 100).toFixed(1)}%)`)
      } else {
        console.log(`    ${formatDiffLine(baseline, target, report)}`)
      }
    } catch (e) {
      console.error(`    ERROR diffing ${name}: ${(e as Error).message}`)
    }
  }
  // Build summary.json with concatenated reports.
  const summary = { run: path.basename(path.dirname(diffDir)), pairs: [] as unknown[] }
  for (const name of baselineFiles) {
    const reportJson = path.join(diffDir, name.replace(/\.png$/, '.json'))
    try {
      summary.pairs.push(JSON.parse(await readFile(reportJson, 'utf8')))
    } catch {
      // Pair didn't get diffed (e.g. missing target) — skip.
    }
  }
  await writeFile(path.join(path.dirname(diffDir), 'summary.json'), JSON.stringify(summary, null, 2))
}

function isMountProofFailure(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'MountProofError'
}

// Avoid `unused import` for CaptureTarget — it's part of the public API surface
// even though not referenced inline.
const _CaptureTargetMarker: undefined | CaptureTarget = undefined
void _CaptureTargetMarker

program.parse()
