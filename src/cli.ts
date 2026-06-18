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

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Command } from 'commander'

import { captureFromFile, type CaptureTarget } from './runner/capture.js'
import { diffPair, formatDiffLine, isWrongFrame, writeDiffReportJson } from './runner/diff.js'
import { generateReport } from './runner/report.js'
import { runTrajectoryFromFile } from './runner/trajectory.js'
import { runDiscovery, runDrift } from './discover/index.js'
import type { Framework } from './discover/index.js'
import type { LegacyTrajectory, Trajectory } from './types.js'

/** Parse `id=1,slug=foo` into a record for dynamic route segments. */
function parseParams(spec?: string): Record<string, string> | undefined {
  if (!spec) return undefined
  const out: Record<string, string> = {}
  for (const pair of spec.split(',')) {
    const [k, ...rest] = pair.split('=')
    if (k && rest.length) out[k.trim()] = rest.join('=').trim()
  }
  return out
}

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

// ─── run (bulk trajectories) ─────────────────────────────────────────────────

program
  .command('run <trajectoriesDir>')
  .description('Execute every trajectory in a directory on baseline + target; verify proofs; diff; one report')
  .requiredOption('--baseline <url>', 'Baseline base URL')
  .requiredOption('--target <url>', 'Target base URL')
  .requiredOption('--out <dir>', 'Output directory')
  .option('--baseline-profile <dir>', 'Persistent Playwright profile for baseline')
  .option('--target-profile <dir>', 'Persistent Playwright profile for target')
  .action(async (trajectoriesDir: string, opts: {
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

    const dir = path.resolve(trajectoriesDir)
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort()
    if (files.length === 0) {
      console.error(`No trajectory files in ${dir}`)
      process.exit(1)
    }

    console.log(`==> Running ${files.length} trajectories on baseline + target…`)
    let proofFailures = 0
    for (const f of files) {
      const tp = path.join(dir, f)
      console.log(`  • ${f}`)
      const [b, t] = await Promise.allSettled([
        runTrajectoryFromFile(tp, { side: 'baseline', base: opts.baseline, outDir: baselineDir, profileDir: opts.baselineProfile }),
        runTrajectoryFromFile(tp, { side: 'target', base: opts.target, outDir: targetDir, profileDir: opts.targetProfile }),
      ])
      if (b.status === 'rejected') {
        console.error(`    baseline failed: ${b.reason}`)
        if (isMountProofFailure(b.reason)) proofFailures++
      }
      if (t.status === 'rejected') {
        console.error(`    target failed: ${t.reason}`)
        if (isMountProofFailure(t.reason)) proofFailures++
      }
    }

    console.log('==> Diffing all pairs…')
    await diffAllPairs(baselineDir, targetDir, diffDir)
    const reportPath = await generateReport({ runDir })
    console.log(`\n  Artifacts: ${runDir}`)
    console.log(`  Report: file://${reportPath}`)

    if (proofFailures > 0) {
      console.error(`\n${proofFailures} mount-proof failure(s) — stale/broken content detected.`)
      process.exit(5)
    }
    // Reflect worst diff verdict as exit code for CI gating.
    const worst = await worstVerdict(path.join(runDir, 'summary.json'))
    if (worst === 'WRONG_FRAME') process.exit(4)
    if (worst === 'FAIL') process.exit(2)
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

// ─── discover ──────────────────────────────────────────────────────────────

program
  .command('discover <appDir>')
  .description('Crawl a running app, auto-build trajectories/ with mount proofs')
  .requiredOption('--base-url <url>', 'Base URL of the running app (e.g. http://localhost:3000)')
  .option('--out <dir>', 'Output root for trajectories/ (default: appDir)')
  .option('--framework <name>', 'Override framework detection (e.g. next-app-router)')
  .option('--selective', 'Only re-discover components whose source changed since last run')
  .option('--include-missing', 'With --selective, also discover components with no trajectory yet')
  .option('--param <pairs>', 'Dynamic route params, e.g. "id=1,slug=foo"')
  .option('--wait-timeout <ms>', 'Per-selector wait budget in ms', '8000')
  .option('--profile <dir>', 'Persistent Playwright profile dir (pre-authenticated)')
  .action(async (appDir: string, opts: {
    baseUrl: string
    out?: string
    framework?: string
    selective?: boolean
    includeMissing?: boolean
    param?: string
    waitTimeout: string
    profile?: string
  }) => {
    console.log(`==> Discovering components in ${path.resolve(appDir)} against ${opts.baseUrl}…`)
    const { summary, plan } = await runDiscovery({
      appDir: path.resolve(appDir),
      baseUrl: opts.baseUrl,
      outDir: opts.out ? path.resolve(opts.out) : undefined,
      framework: opts.framework as Framework | undefined,
      selective: opts.selective,
      includeMissing: opts.includeMissing,
      paramValues: parseParams(opts.param),
      waitTimeoutMs: parseInt(opts.waitTimeout, 10),
      profileDir: opts.profile,
    })

    if (plan) {
      console.log(`  selective: re-discovered ${plan.rediscover.length}, skipped ${plan.skipped} unchanged, removed ${plan.deleteOrphans.length} orphans`)
    }
    console.log(`  trajectories: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged`)
    console.log(`  unreachable: ${summary.unreachable.count} (see trajectories/_unreachable.md)`)
    const outRoot = opts.out ? path.resolve(opts.out) : path.resolve(appDir)
    console.log(`\n  Output: ${path.join(outRoot, 'trajectories')}`)
  })

// ─── drift ─────────────────────────────────────────────────────────────────

program
  .command('drift <appDir>')
  .description('Show which trajectories are stale/orphaned vs current source (exit 1 if any)')
  .option('--out <dir>', 'Output root containing trajectories/ (default: appDir)')
  .option('--framework <name>', 'Override framework detection')
  .option('--include-missing', 'Also report components with no trajectory as needing discovery')
  .action(async (appDir: string, opts: { out?: string; framework?: string; includeMissing?: boolean }) => {
    const { comparison, plan } = await runDrift({
      appDir: path.resolve(appDir),
      outDir: opts.out ? path.resolve(opts.out) : undefined,
      framework: opts.framework as Framework | undefined,
      includeMissing: opts.includeMissing,
    })

    console.log(`unchanged: ${comparison.unchanged.length}`)
    console.log(`stale:     ${comparison.stale.length}`)
    for (const e of comparison.stale) console.log(`  ~ ${e.trajectory} (${e.component})`)
    console.log(`orphaned:  ${comparison.orphaned.length}`)
    for (const e of comparison.orphaned) console.log(`  - ${e.trajectory} (${e.component})`)
    if (opts.includeMissing) {
      console.log(`missing:   ${comparison.missing.length}`)
      for (const id of comparison.missing) console.log(`  + ${id}`)
    }

    const dirty = plan.rediscover.length > 0 || plan.deleteOrphans.length > 0
    if (dirty) {
      console.log(`\nRun \`mountproof discover ${appDir} --base-url <url> --selective${opts.includeMissing ? ' --include-missing' : ''}\` to update.`)
      process.exit(1)
    }
    console.log('\nUp to date — no drift.')
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

/** Read the run summary and return the worst pair verdict (for CI exit codes). */
async function worstVerdict(summaryPath: string): Promise<string | null> {
  try {
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      pairs: Array<{ verdict?: string }>
    }
    const verdicts = summary.pairs.map((p) => p.verdict).filter(Boolean)
    if (verdicts.includes('WRONG_FRAME')) return 'WRONG_FRAME'
    if (verdicts.includes('FAIL')) return 'FAIL'
    return null
  } catch {
    return null
  }
}

// Avoid `unused import` for CaptureTarget — it's part of the public API surface
// even though not referenced inline.
const _CaptureTargetMarker: undefined | CaptureTarget = undefined
void _CaptureTargetMarker

program.parse()
