/**
 * Component-definition extraction.
 *
 * A declaration is treated as a component when its name starts uppercase AND its
 * body renders JSX (function/arrow returning JSX, or a class with a JSX-rendering
 * `render`). Export status and default-export linkage are resolved by walking the
 * top-level statements, including the `export default Foo` (identifier) case that
 * points back at an earlier declaration.
 */

import { basename } from 'node:path'

import type { ComponentDef, ComponentKind } from './types.js'
import { type AnyNode, containsJSX, isNode } from './traverse.js'

const PASCAL = /^[A-Z]/

function isComponentName(name: string | null): name is string {
  return !!name && PASCAL.test(name)
}

/** Derive a component name for an anonymous default export from the filename. */
function deriveDefaultName(file: string): string {
  const base = basename(file).replace(/\.[^.]+$/, '')
  const pascal = base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
  return pascal || 'Default'
}

/** Classify a function/arrow/class expression node, or return null if not a component shape. */
function kindOf(node: AnyNode): ComponentKind | null {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return 'function'
    case 'ArrowFunctionExpression':
      return 'arrow'
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class'
    default:
      return null
  }
}

/** True if a class declares a JSX-rendering `render` method. */
function classRendersJSX(node: AnyNode): boolean {
  const body = node.body
  if (!isNode(body) || !Array.isArray(body.body)) return false
  for (const member of body.body) {
    if (
      isNode(member) &&
      member.type === 'MethodDefinition' &&
      isNode(member.key) &&
      member.key.name === 'render' &&
      containsJSX(member.value)
    ) {
      return true
    }
  }
  return false
}

function rendersJSX(node: AnyNode): boolean {
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return classRendersJSX(node)
  }
  return containsJSX(node)
}

interface DefContext {
  exported: boolean
  isDefault: boolean
}

export function extractComponents(
  program: AnyNode,
  file: string,
  lineAt: (offset: number) => number,
): ComponentDef[] {
  const defs: ComponentDef[] = []
  /** name → index in defs, for resolving `export {X}` / `export default X` after the fact. */
  const byName = new Map<string, number>()

  const push = (name: string, node: AnyNode, kind: ComponentKind, ctx: DefContext) => {
    const def: ComponentDef = {
      name,
      file,
      line: lineAt(node.start),
      exported: ctx.exported,
      isDefault: ctx.isDefault,
      kind,
    }
    byName.set(name, defs.length)
    defs.push(def)
  }

  /** Try to register a component from a declaration node. */
  const fromDeclaration = (decl: unknown, ctx: DefContext): void => {
    if (!isNode(decl)) return

    // function Foo() {} / class Foo {}
    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
      const kind = kindOf(decl)
      const name = isNode(decl.id) && typeof decl.id.name === 'string' ? decl.id.name : null
      if (kind && name && isComponentName(name) && rendersJSX(decl)) {
        push(name, decl, kind, ctx)
      }
      return
    }

    // const Foo = () => <…/> ;  (and function/class expressions assigned to a name)
    if (decl.type === 'VariableDeclaration' && Array.isArray(decl.declarations)) {
      for (const d of decl.declarations) {
        if (!isNode(d) || !isNode(d.id) || typeof d.id.name !== 'string') continue
        const init = d.init
        if (!isNode(init)) continue
        const kind = kindOf(init)
        if (kind && isComponentName(d.id.name) && rendersJSX(init)) {
          push(d.id.name, d, kind, ctx)
        }
      }
    }
  }

  for (const stmt of program.body as unknown[]) {
    if (!isNode(stmt)) continue

    if (stmt.type === 'ExportNamedDeclaration') {
      if (isNode(stmt.declaration)) {
        fromDeclaration(stmt.declaration, { exported: true, isDefault: false })
      } else if (Array.isArray(stmt.specifiers) && !isNode(stmt.source)) {
        // export { Foo, Bar as default } — mark already-collected defs.
        for (const spec of stmt.specifiers) {
          if (!isNode(spec) || !isNode(spec.local) || typeof spec.local.name !== 'string') continue
          const idx = byName.get(spec.local.name)
          if (idx === undefined) continue
          defs[idx].exported = true
          const exportedName =
            isNode(spec.exported) && typeof spec.exported.name === 'string'
              ? spec.exported.name
              : null
          if (exportedName === 'default') defs[idx].isDefault = true
        }
      }
      continue
    }

    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration
      if (!isNode(decl)) continue
      // export default Foo  → mark earlier def as default.
      if (decl.type === 'Identifier' && typeof decl.name === 'string') {
        const idx = byName.get(decl.name)
        if (idx !== undefined) {
          defs[idx].isDefault = true
          defs[idx].exported = true
        }
        continue
      }
      // export default function Foo()/class Foo / anonymous fn/arrow.
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        const kind = kindOf(decl)
        const name =
          isNode(decl.id) && typeof decl.id.name === 'string'
            ? decl.id.name
            : deriveDefaultName(file)
        if (kind && rendersJSX(decl)) push(name, decl, kind, { exported: true, isDefault: true })
        continue
      }
      if (decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
        const kind = kindOf(decl)
        if (kind && rendersJSX(decl)) {
          push(deriveDefaultName(file), decl, kind, { exported: true, isDefault: true })
        }
        continue
      }
      continue
    }

    // Non-exported top-level declaration.
    fromDeclaration(stmt, { exported: false, isDefault: false })
  }

  return defs
}
