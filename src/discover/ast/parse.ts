/**
 * Parser dispatcher: file extension → parser → unified {@link ParsedFile}.
 *
 * Phase A implements the JS/TS/JSX/TSX path via oxc (Rust-based, ESTree output).
 * `.vue` / `.svelte` / `.astro` are recognized but deferred to a later phase —
 * they return an empty ParsedFile with a `parseErrors` note so the pipeline keeps
 * flowing and the gap is visible rather than silent.
 */

import { extname } from 'node:path'

import { parseSync } from 'oxc-parser'

import { extractComponents } from './components.js'
import { extractUsages } from './usages.js'
import { type AnyNode, isNode, lineLookup } from './traverse.js'
import type { ImportBinding, ImportRecord, ParsedFile } from './types.js'

const OXC_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const DEFERRED_EXTENSIONS = new Set(['.vue', '.svelte', '.astro'])

function extractImports(program: AnyNode): ImportRecord[] {
  const records: ImportRecord[] = []
  for (const stmt of program.body as unknown[]) {
    if (!isNode(stmt) || stmt.type !== 'ImportDeclaration') continue
    if (!isNode(stmt.source) || typeof stmt.source.value !== 'string') continue
    const bindings: ImportBinding[] = []
    if (Array.isArray(stmt.specifiers)) {
      for (const spec of stmt.specifiers) {
        if (!isNode(spec) || !isNode(spec.local) || typeof spec.local.name !== 'string') continue
        const local = spec.local.name
        if (spec.type === 'ImportDefaultSpecifier') {
          bindings.push({ local, imported: null, kind: 'default' })
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          bindings.push({ local, imported: null, kind: 'namespace' })
        } else if (spec.type === 'ImportSpecifier') {
          const imported =
            isNode(spec.imported) && typeof spec.imported.name === 'string'
              ? spec.imported.name
              : null
          bindings.push({ local, imported, kind: 'named' })
        }
      }
    }
    records.push({ source: stmt.source.value, bindings })
  }
  return records
}

function emptyFile(file: string, note: string): ParsedFile {
  return { file, componentDefs: [], componentUsages: [], imports: [], parseErrors: [note] }
}

/**
 * Parse one source file into a {@link ParsedFile}. `file` is used for extension
 * dispatch, line reporting, and default-export naming; it is echoed back on the
 * result unchanged (callers pass root-relative paths for portable output).
 */
export function parseFile(file: string, code: string): ParsedFile {
  const ext = extname(file).toLowerCase()

  if (DEFERRED_EXTENSIONS.has(ext)) {
    return emptyFile(file, `unsupported in Phase A: ${ext} (compiler integration pending)`)
  }
  if (!OXC_EXTENSIONS.has(ext)) {
    return emptyFile(file, `unsupported extension: ${ext}`)
  }

  const result = parseSync(file, code)
  const program = result.program as unknown as AnyNode
  const lineAt = lineLookup(code)

  const imports = extractImports(program)
  const importedLocals = new Set<string>()
  for (const rec of imports) for (const b of rec.bindings) importedLocals.add(b.local)

  const componentDefs = extractComponents(program, file, lineAt)
  const componentUsages = extractUsages(program, file, importedLocals, lineAt)

  const parseErrors = result.errors.map((e) => e.message)

  return { file, componentDefs, componentUsages, imports, parseErrors }
}
