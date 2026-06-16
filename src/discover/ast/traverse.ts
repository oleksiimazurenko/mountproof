/**
 * Small AST traversal utilities shared by the extractors.
 *
 * oxc returns ESTree-compatible nodes (re-exported from `@oxc-project/types`) as
 * a deep discriminated union. Walking that union generically while staying
 * type-safe is awkward, so we model a node as "an object with a string `type`"
 * and let each extractor narrow on `node.type` before reading typed fields.
 */

/** A generic AST node — anything with a string `type` discriminant. */
export interface AnyNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const SKIP_KEYS = new Set(['type', 'start', 'end'])

export function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** Depth-first pre-order walk, calling `enter` on every node. */
export function walk(node: unknown, enter: (node: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, enter)
    return
  }
  if (!isNode(node)) return
  enter(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    walk(node[key], enter)
  }
}

/** True if `node` or any descendant is a JSX element/fragment. */
export function containsJSX(node: unknown): boolean {
  let found = false
  walk(node, (n) => {
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') found = true
  })
  return found
}

/**
 * Build a fast offset→line lookup for one source text.
 * Returns a function mapping a byte offset to a 1-based line number.
 */
export function lineLookup(code: string): (offset: number) => number {
  const lineStarts: number[] = [0]
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1)
  }
  return (offset: number) => {
    // Binary search for the last line start <= offset.
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Resolve a JSX element/member name node to its written string form. */
export function jsxName(nameNode: unknown): string {
  if (!isNode(nameNode)) return ''
  switch (nameNode.type) {
    case 'JSXIdentifier':
      return typeof nameNode.name === 'string' ? nameNode.name : ''
    case 'JSXMemberExpression':
      return `${jsxName(nameNode.object)}.${jsxName(nameNode.property)}`
    case 'JSXNamespacedName': {
      const ns = jsxName(nameNode.namespace)
      const name = jsxName(nameNode.name)
      return `${ns}:${name}`
    }
    default:
      return ''
  }
}
