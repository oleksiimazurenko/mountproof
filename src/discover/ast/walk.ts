/**
 * Source-file walker. Globs a project root for source files discover can parse,
 * honoring a default ignore set plus a best-effort read of the project's own
 * `.gitignore`.
 *
 * Returns paths relative to `root` (posix-separated) for stable, portable output
 * that doesn't leak the caller's absolute filesystem layout into trajectories.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import fg from 'fast-glob'

/** Extensions discover can statically analyse. */
export const DEFAULT_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro']

/** Directories never worth walking — build output, deps, VCS, test coverage. */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/out/**',
  '**/coverage/**',
  '**/.git/**',
]

export interface WalkOptions {
  /** Override the default extension list. */
  extensions?: string[]
  /** Extra ignore globs (merged with {@link DEFAULT_IGNORE}). */
  ignore?: string[]
  /** Read `<root>/.gitignore` and add its entries to the ignore set. Default: true. */
  respectGitignore?: boolean
}

/**
 * Translate a single `.gitignore` line into fast-glob ignore globs.
 * Best-effort: handles the common comment/blank/dir/anchor cases; negations
 * (`!pattern`) are skipped rather than un-ignoring (intentional, keeps it simple).
 */
function gitignoreLineToGlobs(raw: string): string[] {
  const line = raw.trim()
  if (!line || line.startsWith('#') || line.startsWith('!')) return []

  const anchored = line.startsWith('/')
  const dirOnly = line.endsWith('/')
  let body = line.replace(/^\//, '').replace(/\/$/, '')
  if (!body) return []

  const prefix = anchored ? '' : '**/'
  if (dirOnly) {
    // A directory entry ignores everything beneath it.
    return [`${prefix}${body}/**`, `${prefix}${body}`]
  }
  // A plain entry can be either a file or a directory; cover both.
  return [`${prefix}${body}`, `${prefix}${body}/**`]
}

function readGitignoreGlobs(root: string): string[] {
  const gi = join(root, '.gitignore')
  if (!existsSync(gi)) return []
  try {
    return readFileSync(gi, 'utf8').split('\n').flatMap(gitignoreLineToGlobs)
  } catch {
    return []
  }
}

/**
 * Walk `root` and return matching source files as root-relative posix paths,
 * sorted for deterministic output.
 */
export async function walkSourceFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS
  const respectGitignore = options.respectGitignore ?? true

  const ignore = [
    ...DEFAULT_IGNORE,
    ...(options.ignore ?? []),
    ...(respectGitignore ? readGitignoreGlobs(root) : []),
  ]

  const pattern = `**/*.{${extensions.join(',')}}`
  const files = await fg(pattern, {
    cwd: root,
    ignore,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  })

  return files.sort()
}
