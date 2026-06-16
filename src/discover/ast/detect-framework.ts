/**
 * Framework detection — sniff a project root to decide which route extractor to
 * use. Combines package.json dependency names with sentinel files/directories.
 *
 * Phase A ships first-class support for Next.js App Router; the other branches
 * are recognized (so we report them honestly) but their route extractors land in
 * later phases. On `unknown` the caller still parses every source file — it just
 * won't derive routes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Framework } from './types.js'

export interface FrameworkDetection {
  framework: Framework
  /** Human-readable reasons, useful for `--verbose` / debugging. */
  evidence: string[]
}

function readDeps(root: string): Record<string, string> {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return {}
  }
}

function has(root: string, ...rel: string[]): boolean {
  return rel.some((r) => existsSync(join(root, r)))
}

/**
 * Detect the framework at `root`. Order matters: more specific signals win, and
 * Next.js is split into app-router vs pages-router by which directory exists.
 */
export function detectFramework(root: string): FrameworkDetection {
  const deps = readDeps(root)
  const evidence: string[] = []

  const dep = (name: string) => {
    if (deps[name]) {
      evidence.push(`dependency "${name}"`)
      return true
    }
    return false
  }

  if (dep('next')) {
    // App Router and Pages Router can coexist; prefer app/ when present.
    const appDir = has(root, 'app', 'src/app')
    const pagesDir = has(root, 'pages', 'src/pages')
    if (appDir) {
      evidence.push('app/ directory')
      return { framework: 'next-app-router', evidence }
    }
    if (pagesDir) {
      evidence.push('pages/ directory')
      return { framework: 'next-pages-router', evidence }
    }
    // Next installed but neither dir found yet — default to app router (current default).
    return { framework: 'next-app-router', evidence }
  }

  if (dep('@remix-run/react') || dep('@remix-run/node') || has(root, 'app/routes')) {
    return { framework: 'remix', evidence }
  }

  if (dep('@sveltejs/kit') || has(root, 'svelte.config.js', 'src/routes')) {
    return { framework: 'sveltekit', evidence }
  }

  if (dep('astro') || has(root, 'astro.config.mjs', 'astro.config.ts')) {
    return { framework: 'astro', evidence }
  }

  if (dep('vue-router') || dep('nuxt')) {
    return { framework: 'vue-router', evidence }
  }

  if (dep('react-router-dom') || dep('react-router')) {
    return { framework: 'react-router', evidence }
  }

  evidence.push('no known framework signals')
  return { framework: 'unknown', evidence }
}
