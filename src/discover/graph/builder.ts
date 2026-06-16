/**
 * Graph builder — turns a {@link ProjectParse} into a {@link ComponentGraph}.
 *
 * Steps:
 *   1. one node per component definition (id = `file:name`)
 *   2. resolve each `<Child/>` usage to the component it refers to (following
 *      relative imports, default/named, or a same-file local definition)
 *   3. one edge per resolved usage, carrying its conditional context
 *   4. mark page components from routes as route roots
 *   5. annotate node metadata (auth/premium/modal/lazy/framework)
 *
 * Unresolved usages (bare-package imports, namespace/member tags, aliases we
 * can't follow yet) are dropped rather than guessed — keeping the graph honest.
 */

import { dirname, join as joinPosix, normalize as normalizePosix } from 'node:path/posix'

import type { ImportBinding, ParsedFile, ProjectParse, RouteDef } from '../ast/types.js'
import { annotateGraph } from './annotate.js'
import type { ComponentGraph, ComponentId, ComponentNode, Edge } from './types.js'

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']

export function componentId(file: string, name: string): ComponentId {
  return `${file}:${name}`
}

/** Resolve a relative import specifier from `fromFile` to a known file path, or null. */
export function resolveModule(fromFile: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null // bare package / alias — not resolvable here
  const base = normalizePosix(joinPosix(dirname(fromFile), specifier))

  // Direct file with an extension guess.
  for (const ext of RESOLVE_EXTENSIONS) {
    if (known.has(base + ext)) return base + ext
  }
  // Already had an extension.
  if (known.has(base)) return base
  // Directory index file.
  for (const ext of RESOLVE_EXTENSIONS) {
    if (known.has(joinPosix(base, 'index' + ext))) return joinPosix(base, 'index' + ext)
  }
  return null
}

/** Pick the target component name within a resolved file, given the import binding. */
function targetName(binding: ImportBinding, child: string): string | null {
  if (binding.kind === 'default') return '\0default' // sentinel: caller resolves default export
  if (binding.kind === 'named') return binding.imported ?? child
  return null // namespace import — can't pin a single component
}

export function buildGraph(project: ProjectParse): ComponentGraph {
  const nodes = new Map<ComponentId, ComponentNode>()
  const byPath = new Map<string, ParsedFile>()
  const knownFiles = new Set<string>()

  for (const file of project.files) {
    byPath.set(file.file, file)
    knownFiles.add(file.file)
  }

  // 1. Nodes.
  for (const file of project.files) {
    for (const def of file.componentDefs) {
      const id = componentId(def.file, def.name)
      nodes.set(id, {
        id,
        file: def.file,
        name: def.name,
        exported: def.exported,
        isRouteRoot: false,
        metadata: {
          authGated: false,
          premiumGated: false,
          isModal: false,
          isLazy: false,
          framework: 'react',
        },
      })
    }
  }

  // 2 + 3. Edges from usages.
  const edges: Edge[] = []
  const seen = new Set<string>()

  for (const file of project.files) {
    const importByLocal = new Map<string, { source: string; binding: ImportBinding }>()
    for (const rec of file.imports) {
      for (const b of rec.bindings) importByLocal.set(b.local, { source: rec.source, binding: b })
    }

    for (const usage of file.componentUsages) {
      if (usage.parent === null) continue
      if (usage.child.includes('.') || usage.child.includes(':')) continue // member/namespaced

      const fromId = componentId(file.file, usage.parent)
      if (!nodes.has(fromId)) continue

      let toId: ComponentId | null = null
      const imp = importByLocal.get(usage.child)

      if (imp) {
        const resolved = resolveModule(file.file, imp.source, knownFiles)
        if (!resolved) continue
        const targetFile = byPath.get(resolved)
        if (!targetFile) continue
        const want = targetName(imp.binding, usage.child)
        if (want === null) continue
        const def =
          want === '\0default'
            ? (targetFile.componentDefs.find((d) => d.isDefault) ?? null)
            : (targetFile.componentDefs.find(
                (d) => d.name === want || d.exportedAs?.includes(want),
              ) ?? null)
        if (!def) continue
        toId = componentId(def.file, def.name)
      } else {
        // Locally-defined component used in the same file.
        const local = file.componentDefs.find((d) => d.name === usage.child)
        if (!local) continue
        toId = componentId(local.file, local.name)
      }

      if (!toId || !nodes.has(toId)) continue
      const key = `${fromId}->${toId}:${usage.conditional}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: fromId, to: toId, conditional: usage.conditional })
    }
  }

  // 4. Route roots.
  const routes = new Map<string, RouteDef>()
  for (const route of project.routes) {
    routes.set(route.path, route)
    if (!route.component) continue
    const id = componentId(route.file, route.component)
    const node = nodes.get(id)
    if (node) node.isRouteRoot = true
  }

  const graph: ComponentGraph = { nodes, edges, routes }

  // 5. Metadata.
  annotateGraph(graph, project)

  return graph
}
