/**
 * Node annotation — best-effort behavioural metadata that downstream discovery
 * planning uses to decide HOW to reach a component (skip auth walls, click a
 * modal trigger, wait for a lazy chunk, …).
 *
 * Signals are intentionally conservative and derived only from Phase A data
 * (imports, usages, file paths). Marker name sets cover common conventions and
 * will become plugin-configurable in the config phase.
 *
 * Limitation: `isLazy` requires seeing dynamic `import()` / `lazy()` / `dynamic()`
 * call sites, which Phase A's import capture doesn't yet record. It is therefore
 * left `false` for now rather than guessed — flagged here so the gap is explicit.
 */

import type { Framework, ParsedFile, ProjectParse } from '../ast/types.js'
import type { ComponentGraph, ComponentMetadata } from './types.js'

const AUTH_MARKERS = new Set([
  'useAuth',
  'useSession',
  'useUser',
  'useRequireAuth',
  'requireAuth',
  'withAuth',
  'getServerSession',
])
const AUTH_COMPONENTS = new Set([
  'Protected',
  'RequireAuth',
  'AuthGuard',
  'SignedIn',
  'Authenticated',
])

const PREMIUM_MARKERS = new Set(['usePremium', 'useSubscription', 'useEntitlement', 'usePaywall'])
const PREMIUM_COMPONENTS = new Set(['PremiumOnly', 'PremiumGate', 'Paywall', 'SubscriberOnly'])

const MODAL_COMPONENTS = new Set([
  'Dialog',
  'Modal',
  'Drawer',
  'Sheet',
  'Popover',
  'DialogContent',
  'ModalContent',
])
const MODAL_NAME_RE = /modal|dialog|drawer/i
const MODAL_PATH_RE = /(^|\/)(modal|modals|dialog|dialogs)(\/|\.|$)/i

function frameworkOf(framework: Framework): ComponentMetadata['framework'] {
  switch (framework) {
    case 'sveltekit':
      return 'svelte'
    case 'vue-router':
      return 'vue'
    case 'astro':
      return 'astro'
    default:
      return 'react'
  }
}

/** Local + imported names referenced by a file's imports. */
function importedNames(file: ParsedFile): Set<string> {
  const names = new Set<string>()
  for (const rec of file.imports) {
    for (const b of rec.bindings) {
      names.add(b.local)
      if (b.imported) names.add(b.imported)
    }
  }
  return names
}

function anyIn(set: Set<string>, candidates: Set<string>): boolean {
  for (const c of candidates) if (set.has(c)) return true
  return false
}

export function annotateGraph(graph: ComponentGraph, project: ProjectParse): void {
  const framework = frameworkOf(project.framework)
  const byPath = new Map<string, ParsedFile>()
  for (const f of project.files) byPath.set(f.file, f)

  for (const node of graph.nodes.values()) {
    node.metadata.framework = framework

    const file = byPath.get(node.file)
    if (!file) continue

    const imports = importedNames(file)
    // Usages belonging to THIS component (same file, parent === name).
    const ownUsages = file.componentUsages.filter((u) => u.parent === node.name)
    const childNames = new Set(ownUsages.map((u) => u.child))
    const propNames = new Set(ownUsages.flatMap((u) => u.props))

    node.metadata.authGated = anyIn(imports, AUTH_MARKERS) || anyIn(childNames, AUTH_COMPONENTS)
    node.metadata.premiumGated =
      anyIn(imports, PREMIUM_MARKERS) || anyIn(childNames, PREMIUM_COMPONENTS)
    node.metadata.isModal =
      MODAL_NAME_RE.test(node.name) ||
      MODAL_PATH_RE.test(node.file) ||
      anyIn(childNames, MODAL_COMPONENTS) ||
      propNames.has('aria-modal')
    // isLazy intentionally left false — see file header.
  }
}
