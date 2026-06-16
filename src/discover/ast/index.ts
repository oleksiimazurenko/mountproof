/**
 * Discover · AST layer (Phase A) — public surface.
 *
 * `parseProject(root)` is the one-call entry: detect the framework, walk the
 * source tree, parse every file, and derive routes. Lower-level pieces
 * (`parseFile`, `detectFramework`, `walkSourceFiles`, the extractors) are also
 * exported for targeted use by later phases and by tests.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { detectFramework } from './detect-framework.js'
import { parseFile } from './parse.js'
import { extractRoutes } from './routes.js'
import { walkSourceFiles, type WalkOptions } from './walk.js'
import type { ParsedFile, ProjectParse } from './types.js'

export type {
  ComponentDef,
  ComponentKind,
  ComponentUsage,
  ConditionalKind,
  Framework,
  ImportBinding,
  ImportRecord,
  ParsedFile,
  ProjectParse,
  RouteDef,
} from './types.js'

export { detectFramework, type FrameworkDetection } from './detect-framework.js'
export { parseFile } from './parse.js'
export { extractComponents } from './components.js'
export { extractUsages } from './usages.js'
export { extractRoutes } from './routes.js'
export {
  walkSourceFiles,
  DEFAULT_EXTENSIONS,
  DEFAULT_IGNORE,
  type WalkOptions,
} from './walk.js'

export interface ParseProjectOptions extends WalkOptions {
  /** Override framework auto-detection. */
  framework?: ProjectParse['framework']
}

/**
 * Statically analyse a whole project: framework → file walk → parse → routes.
 * Files are read from disk; `ParsedFile.file` paths are root-relative (posix).
 */
export async function parseProject(
  root: string,
  options: ParseProjectOptions = {},
): Promise<ProjectParse> {
  const framework = options.framework ?? detectFramework(root).framework
  const relPaths = await walkSourceFiles(root, options)

  const files: ParsedFile[] = relPaths.map((rel) => {
    const code = readFileSync(join(root, rel), 'utf8')
    return parseFile(rel, code)
  })

  const routes = extractRoutes(files, framework)
  return { root, framework, files, routes }
}
