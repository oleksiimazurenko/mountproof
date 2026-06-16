/**
 * Idempotent disk writes. Trajectories are version-controlled, so re-running
 * discovery must not churn git history when nothing meaningful changed. A file is
 * rewritten only if its content differs once the volatile `generatedAt` stamp is
 * ignored; otherwise the existing file (and its original timestamp) is left
 * untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { EmittedTrajectory } from './serialize.js'
import { stableStringify } from './serialize.js'

export type WriteOutcome = 'created' | 'updated' | 'unchanged'

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

/** Clone a trajectory with the volatile timestamp removed, for stable comparison. */
function withoutVolatile(traj: EmittedTrajectory): unknown {
  const clone = JSON.parse(JSON.stringify(traj)) as EmittedTrajectory
  if (clone.discoveryMetadata) {
    delete (clone.discoveryMetadata as { generatedAt?: string }).generatedAt
  }
  return clone
}

/**
 * Write a trajectory idempotently. If an existing file is semantically identical
 * (ignoring `generatedAt`), it's left as-is and `unchanged` is returned.
 */
export function writeTrajectoryFile(filePath: string, traj: EmittedTrajectory): WriteOutcome {
  const nextText = stableStringify(traj)

  if (existsSync(filePath)) {
    try {
      const prev = JSON.parse(readFileSync(filePath, 'utf8')) as EmittedTrajectory
      if (stableStringify(withoutVolatile(prev)) === stableStringify(withoutVolatile(traj))) {
        return 'unchanged'
      }
    } catch {
      // Corrupt/unreadable existing file — fall through and overwrite.
    }
    ensureDir(filePath)
    writeFileSync(filePath, nextText)
    return 'updated'
  }

  ensureDir(filePath)
  writeFileSync(filePath, nextText)
  return 'created'
}

/** Write any value as stable-ordered JSON (creates parent dirs). */
export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(filePath)
  writeFileSync(filePath, stableStringify(value))
}

/** Write raw text (creates parent dirs). */
export function writeTextFile(filePath: string, text: string): void {
  ensureDir(filePath)
  writeFileSync(filePath, text)
}
