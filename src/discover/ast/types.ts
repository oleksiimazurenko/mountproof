/**
 * Internal data shapes for the discover module's static-analysis layer.
 *
 * These are NOT part of the public package contract (that's `src/types.ts`,
 * the Trajectory schema shared with the runner). They describe the intermediate
 * representation discover builds from source code: parsed files, the components
 * they declare, the `<X />` usages between them, the imports that wire files
 * together, and the framework routes derived from the filesystem.
 *
 * Phase B turns `ParsedFile[]` + `RouteDef[]` into a queryable component graph.
 */

/** Frameworks the route extractor knows how to map. `unknown` = scan files, skip routes. */
export type Framework =
  | 'next-app-router'
  | 'next-pages-router'
  | 'react-router'
  | 'remix'
  | 'sveltekit'
  | 'vue-router'
  | 'astro'
  | 'unknown'

/** How a JSX child is gated by its parent — a signal for trigger detection later. */
export type ConditionalKind =
  | 'unconditional'
  | 'ternary'
  | 'logical-and'
  | 'if-block'

/** The syntactic form a component is declared with. */
export type ComponentKind = 'function' | 'arrow' | 'class'

/** A single component declaration found in a source file. */
export interface ComponentDef {
  /** Component identifier (e.g. `Header`). */
  name: string
  /** Source file this is declared in (path as given to the parser). */
  file: string
  /** 1-based line of the declaration. */
  line: number
  /** Reachable from another module via any `export`. */
  exported: boolean
  /** This is the file's `export default`. */
  isDefault: boolean
  kind: ComponentKind
}

/** A `<Child .../>` element used inside some component's render output. */
export interface ComponentUsage {
  /** Name of the component whose body contains this usage, or null if module-scope. */
  parent: string | null
  /** Tag name as written (e.g. `Bar`, `ns.Thing`). */
  child: string
  /** Prop names passed (spread props recorded as `...`). */
  props: string[]
  /** How the usage is gated within its parent. */
  conditional: ConditionalKind
  /** 1-based line of the usage. */
  line: number
}

/** One imported binding, used to resolve `<Child />` to the file that defines it. */
export interface ImportBinding {
  /** Local name in this file. */
  local: string
  /** Original exported name, or null for default / namespace imports. */
  imported: string | null
  kind: 'default' | 'named' | 'namespace'
}

/** An `import ... from '<source>'` statement. */
export interface ImportRecord {
  source: string
  bindings: ImportBinding[]
}

/** A framework route derived from the filesystem or a router config. */
export interface RouteDef {
  /** Route path, framework-normalized (e.g. `/products/[id]`). */
  path: string
  /** File backing the route (path as walked). */
  file: string
  /** Default-export component name of the route file, best-effort. */
  component: string | null
  /** Dynamic segment names (e.g. `['id']` for `/products/[id]`). */
  dynamicSegments: string[]
}

/** Everything extracted from one source file. */
export interface ParsedFile {
  /** Path as handed to the parser. */
  file: string
  componentDefs: ComponentDef[]
  componentUsages: ComponentUsage[]
  imports: ImportRecord[]
  /** Non-fatal parse diagnostics (syntax errors, unsupported extension, …). */
  parseErrors: string[]
}

/** Aggregate result of statically analysing a whole project. */
export interface ProjectParse {
  root: string
  framework: Framework
  files: ParsedFile[]
  routes: RouteDef[]
}
