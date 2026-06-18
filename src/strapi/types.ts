/**
 * Strapi schema shapes for the migration-testing layer.
 *
 * Isolated from mountproof core (runner/discover) — this is the CMS-specific
 * adapter. It introspects content-type schemas to build SAFE populate plans
 * (v5 rejects populating scalars or non-existent relations with a 400) and, later,
 * to derive per-field expectations for the frontend.
 */

/** Strapi major version — query/response semantics differ between them. */
export type StrapiVersion = 4 | 5

/** Attribute kinds we care about for populate planning. */
export type StrapiAttributeType =
  | 'string'
  | 'text'
  | 'richtext'
  | 'email'
  | 'uid'
  | 'enumeration'
  | 'integer'
  | 'biginteger'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'media'
  | 'relation'
  | 'component'
  | 'dynamiczone'
  | 'blocks'

export interface StrapiAttribute {
  type: StrapiAttributeType
  /** relation: the target content-type uid. */
  target?: string
  /** relation kind, e.g. `oneToMany`. */
  relation?: string
  /** component: the component uid. */
  component?: string
  /** dynamiczone: the allowed component uids. */
  components?: string[]
  /** component/media/relation: many vs one. */
  repeatable?: boolean
  multiple?: boolean
}

export interface StrapiContentType {
  /** Full uid, e.g. `api::article.article`. */
  uid: string
  /** REST plural id, e.g. `articles` (the `/api/<pluralApiId>` segment). */
  pluralApiId: string
  kind: 'collectionType' | 'singleType'
  attributes: Record<string, StrapiAttribute>
}

/** A parsed schema: every content type plus the component definitions they reference. */
export interface StrapiSchema {
  contentTypes: StrapiContentType[]
  /** Component uid → its attributes (for resolving nested component populates). */
  components: Record<string, Record<string, StrapiAttribute>>
}

/** Buckets of an attribute set, by what they mean for populate planning. */
export interface AttributeBuckets {
  /** Attribute names that need `populate` (relations, components, media). */
  populatable: string[]
  /** Relation attribute names only. */
  relations: string[]
  /** Component attribute names. */
  components: string[]
  /** Media attribute names. */
  media: string[]
  /** Dynamic-zone attribute names (populated via `on`/`*`, opt-in). */
  dynamicZones: string[]
  /** Scalar attribute names — must NEVER be populated (v5 400s on this). */
  scalars: string[]
}
