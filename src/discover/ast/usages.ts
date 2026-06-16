/**
 * JSX usage extraction.
 *
 * For each component body we record every `<Child />` it renders, tagged with the
 * parent component name and how the child is gated (`unconditional`, `ternary`,
 * `logical-and`, `if-block`). The conditional signal is what later lets discover
 * guess which trigger reveals a gated/modal child.
 *
 * We attribute usages to a parent by walking each component declaration's body
 * with a context-carrying visitor, rather than relying on parent pointers (which
 * the AST doesn't provide).
 */

import { deriveDefaultName } from './components.js'
import type { ComponentUsage, ConditionalKind } from './types.js'
import { type AnyNode, isNode, jsxName } from './traverse.js'

const PASCAL = /^[A-Z]/

/** Decide whether a JSX tag name refers to a component (vs a host element like `div`). */
function isComponentTag(name: string, importedLocals: Set<string>): boolean {
  if (!name) return false
  if (name.includes('.') || name.includes(':')) return true // member / namespaced → component
  if (PASCAL.test(name)) return true
  return importedLocals.has(name)
}

function propNames(openingElement: AnyNode): string[] {
  const attrs = openingElement.attributes
  if (!Array.isArray(attrs)) return []
  const out: string[] = []
  for (const attr of attrs) {
    if (!isNode(attr)) continue
    if (attr.type === 'JSXSpreadAttribute') {
      out.push('...')
    } else if (attr.type === 'JSXAttribute' && isNode(attr.name)) {
      const n = jsxName(attr.name) || (typeof attr.name.name === 'string' ? attr.name.name : '')
      if (n) out.push(n)
    }
  }
  return out
}

/**
 * Walk an arbitrary node, carrying the conditional context that applies to the
 * next JSX element encountered. Branch nodes (ternary / `&&` / if) re-scope the
 * context for their branches; a JSX element resets its own children to
 * `unconditional` (they're unconditional relative to that element rendering).
 */
function visit(
  node: unknown,
  conditional: ConditionalKind,
  parent: string | null,
  importedLocals: Set<string>,
  lineAt: (offset: number) => number,
  out: ComponentUsage[],
): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, conditional, parent, importedLocals, lineAt, out)
    return
  }
  if (!isNode(node)) return

  switch (node.type) {
    case 'JSXElement': {
      const opening = node.openingElement
      if (isNode(opening)) {
        const name = jsxName(opening.name)
        if (isComponentTag(name, importedLocals)) {
          out.push({
            parent,
            child: name,
            props: propNames(opening),
            conditional,
            line: lineAt(node.start),
          })
        }
        // Attribute values and children are unconditional relative to this element.
        visit(opening.attributes, 'unconditional', parent, importedLocals, lineAt, out)
      }
      visit(node.children, 'unconditional', parent, importedLocals, lineAt, out)
      return
    }

    case 'JSXFragment':
      visit(node.children, 'unconditional', parent, importedLocals, lineAt, out)
      return

    case 'ConditionalExpression':
      visit(node.test, 'unconditional', parent, importedLocals, lineAt, out)
      visit(node.consequent, 'ternary', parent, importedLocals, lineAt, out)
      visit(node.alternate, 'ternary', parent, importedLocals, lineAt, out)
      return

    case 'LogicalExpression':
      visit(node.left, 'unconditional', parent, importedLocals, lineAt, out)
      // `a && <X/>` and `a || <X/>` and `a ?? <X/>` all gate the right side.
      visit(node.right, 'logical-and', parent, importedLocals, lineAt, out)
      return

    case 'IfStatement':
      visit(node.test, 'unconditional', parent, importedLocals, lineAt, out)
      visit(node.consequent, 'if-block', parent, importedLocals, lineAt, out)
      visit(node.alternate, 'if-block', parent, importedLocals, lineAt, out)
      return

    default: {
      // Generic pass-through, preserving the current conditional context so that
      // e.g. the right operand of `&&` keeps its gating down to its JSX.
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        visit(node[key], conditional, parent, importedLocals, lineAt, out)
      }
    }
  }
}

/** Component-bearing node types whose bodies we scan for usages. */
function componentBodies(
  program: AnyNode,
  file: string,
): Array<{ name: string | null; body: unknown }> {
  const result: Array<{ name: string | null; body: unknown }> = []

  const consider = (name: string | null, fnOrClass: unknown) => {
    if (isNode(fnOrClass)) result.push({ name, body: fnOrClass })
  }

  const fromDecl = (decl: unknown) => {
    if (!isNode(decl)) return
    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
      const name = isNode(decl.id) && typeof decl.id.name === 'string' ? decl.id.name : null
      consider(name, decl)
    } else if (decl.type === 'VariableDeclaration' && Array.isArray(decl.declarations)) {
      for (const d of decl.declarations) {
        if (isNode(d) && isNode(d.id) && typeof d.id.name === 'string') consider(d.id.name, d.init)
      }
    }
  }

  for (const stmt of program.body as unknown[]) {
    if (!isNode(stmt)) continue
    if (stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)) {
      fromDecl(stmt.declaration)
    } else if (stmt.type === 'ExportDefaultDeclaration' && isNode(stmt.declaration)) {
      const decl = stmt.declaration
      if (decl.type === 'Identifier') continue
      // Named default (`export default function Foo`) keeps its name; anonymous
      // defaults are named after the file — matching extractComponents, so that
      // usage `parent` lines up with the component def and edges actually form.
      const named = isNode(decl.id) && typeof decl.id.name === 'string' ? decl.id.name : null
      consider(named ?? deriveDefaultName(file), decl)
    } else {
      fromDecl(stmt)
    }
  }

  return result
}

export function extractUsages(
  program: AnyNode,
  file: string,
  importedLocals: Set<string>,
  lineAt: (offset: number) => number,
): ComponentUsage[] {
  const out: ComponentUsage[] = []
  for (const { name, body } of componentBodies(program, file)) {
    visit(body, 'unconditional', name, importedLocals, lineAt, out)
  }
  return out
}
