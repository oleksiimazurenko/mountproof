/**
 * Source hashing for drift detection. A trajectory goes stale when the component
 * it covers — or anything that component transitively imports — changes. So we
 * hash a component's own source plus the source of every file reachable through
 * its (resolvable, in-project) imports.
 *
 * File reads are injectable so the hasher is unit-testable without disk; the
 * default reads from the project root.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectParse } from '../ast/types.js'
import { resolveModule } from '../graph/builder.js'
import { componentNameOf } from '../emit/serialize.js'

export type FileReader = (relPath: string) => string

function defaultReader(root: string): FileReader {
  return (rel) => readFileSync(join(root, rel), 'utf8')
}

/**
 * Files reachable from `startFile` through resolvable relative imports
 * (inclusive, transitive). Bare-package imports are not followed.
 */
export function dependencyClosure(project: ProjectParse, startFile: string): string[] {
  const byPath = new Map(project.files.map((f) => [f.file, f]))
  const known = new Set(byPath.keys())
  const visited = new Set<string>()
  const queue = [startFile]

  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)
    const parsed = byPath.get(file)
    if (!parsed) continue
    for (const rec of parsed.imports) {
      const resolved = resolveModule(file, rec.source, known)
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }

  return [...visited].sort()
}

/** Hash a file's dependency closure (its own source + transitive imports). */
export function hashFileClosure(
  project: ProjectParse,
  file: string,
  readFile: FileReader = defaultReader(project.root),
): string {
  const closure = dependencyClosure(project, file)
  const hash = createHash('sha256')
  for (const rel of closure) {
    let content = ''
    try {
      content = readFile(rel)
    } catch {
      content = '\0missing'
    }
    hash.update(rel)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Hash a component's source closure, keyed by its `file:name` id. Two components
 * in the same file share a hash (same closure) — fine for drift, since a change
 * to either file invalidates both.
 */
export function hashComponent(
  project: ProjectParse,
  componentId: string,
  readFile?: FileReader,
): string {
  const file = componentFileOf(project, componentId)
  if (!file) return ''
  return hashFileClosure(project, file, readFile ?? defaultReader(project.root))
}

/** Resolve a component id to the file that declares it. */
export function componentFileOf(project: ProjectParse, componentId: string): string | null {
  const name = componentNameOf(componentId)
  const idx = componentId.lastIndexOf(':')
  const file = idx === -1 ? null : componentId.slice(0, idx)
  if (!file) return null
  const parsed = project.files.find((f) => f.file === file)
  if (!parsed) return null
  return parsed.componentDefs.some((d) => d.name === name) ? file : null
}

/** Hash every component in the project, returning id → hash. */
export function hashAllComponents(
  project: ProjectParse,
  readFile?: FileReader,
): Record<string, string> {
  const reader = readFile ?? defaultReader(project.root)
  const out: Record<string, string> = {}
  for (const f of project.files) {
    for (const def of f.componentDefs) {
      out[`${f.file}:${def.name}`] = hashFileClosure(project, f.file, reader)
    }
  }
  return out
}
