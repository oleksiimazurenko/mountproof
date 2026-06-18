/**
 * Parse Strapi content-type / component schemas (as returned by the
 * `/content-type-builder/*` admin endpoints, or read from `schema.json` files)
 * into the normalized {@link StrapiSchema}, and bucket an attribute set by what
 * it means for populate planning.
 *
 * Accepts both the nested `{ uid, schema: {...} }` admin shape and the flat
 * `{ uid, kind, info, attributes }` file shape.
 */

import type {
  AttributeBuckets,
  StrapiAttribute,
  StrapiContentType,
  StrapiSchema,
} from './types.js'

interface RawSchemaBody {
  kind?: 'collectionType' | 'singleType'
  info?: { pluralName?: string; singularName?: string; displayName?: string }
  attributes?: Record<string, StrapiAttribute>
}

interface RawEntry {
  uid?: string
  schema?: RawSchemaBody
  kind?: 'collectionType' | 'singleType'
  info?: RawSchemaBody['info']
  attributes?: Record<string, StrapiAttribute>
}

/** Plural api id for a content type, falling back through info → uid. */
function pluralApiIdOf(uid: string, body: RawSchemaBody): string {
  if (body.info?.pluralName) return body.info.pluralName
  if (body.info?.singularName) return body.info.singularName
  // uid `api::article.article` → `article`
  const tail = uid.split('.').pop() ?? uid
  return tail
}

function bodyOf(raw: RawEntry): RawSchemaBody {
  return raw.schema ?? { kind: raw.kind, info: raw.info, attributes: raw.attributes }
}

/** Normalize a list of content-type entries into {@link StrapiContentType}s. */
export function parseContentTypes(rawList: RawEntry[]): StrapiContentType[] {
  const out: StrapiContentType[] = []
  for (const raw of rawList) {
    if (!raw.uid) continue
    const body = bodyOf(raw)
    out.push({
      uid: raw.uid,
      pluralApiId: pluralApiIdOf(raw.uid, body),
      kind: body.kind ?? 'collectionType',
      attributes: body.attributes ?? {},
    })
  }
  return out
}

/** Normalize component entries into `uid → attributes`. */
export function parseComponents(rawList: RawEntry[]): Record<string, Record<string, StrapiAttribute>> {
  const out: Record<string, Record<string, StrapiAttribute>> = {}
  for (const raw of rawList) {
    if (!raw.uid) continue
    out[raw.uid] = bodyOf(raw).attributes ?? {}
  }
  return out
}

export interface RawSchemaInput {
  contentTypes: RawEntry[]
  components?: RawEntry[]
}

/** Parse both content types and components into a {@link StrapiSchema}. */
export function parseSchema(input: RawSchemaInput): StrapiSchema {
  return {
    contentTypes: parseContentTypes(input.contentTypes),
    components: parseComponents(input.components ?? []),
  }
}

/**
 * Bucket an attribute set. Scalars are tracked explicitly so the populate planner
 * can be sure never to populate them (the most common v5 400). Dynamic zones are
 * kept separate — they're opt-in for populate because deep-populating them is the
 * classic dev-server hang.
 */
export function bucketAttributes(attributes: Record<string, StrapiAttribute>): AttributeBuckets {
  const buckets: AttributeBuckets = {
    populatable: [],
    relations: [],
    components: [],
    media: [],
    dynamicZones: [],
    scalars: [],
  }
  for (const [name, attr] of Object.entries(attributes)) {
    switch (attr.type) {
      case 'relation':
        buckets.relations.push(name)
        buckets.populatable.push(name)
        break
      case 'component':
        buckets.components.push(name)
        buckets.populatable.push(name)
        break
      case 'media':
        buckets.media.push(name)
        buckets.populatable.push(name)
        break
      case 'dynamiczone':
        buckets.dynamicZones.push(name)
        break
      default:
        buckets.scalars.push(name)
    }
  }
  return buckets
}

/** Look up a content type by its plural api id. */
export function findByPluralApiId(
  schema: StrapiSchema,
  pluralApiId: string,
): StrapiContentType | undefined {
  return schema.contentTypes.find((ct) => ct.pluralApiId === pluralApiId)
}

/** Scalar attribute types that render as user-facing text (vs uid/date/enum/bool/number). */
const CONTENT_SCALAR_TYPES = new Set<StrapiAttribute['type']>([
  'string',
  'text',
  'richtext',
  'blocks',
  'email',
])

/**
 * Top-level attribute names worth extracting expectations from: visible content
 * scalars + everything populatable (relations/components/media) + dynamic zones.
 * Excludes uid (slug), dates, enumerations, booleans, numbers, json — none of
 * which render as stable visible text, so asserting them produces false fails.
 */
export function extractableTopLevelKeys(ct: StrapiContentType): Set<string> {
  const buckets = bucketAttributes(ct.attributes)
  const content = Object.entries(ct.attributes)
    .filter(([, attr]) => CONTENT_SCALAR_TYPES.has(attr.type))
    .map(([name]) => name)
  return new Set([...content, ...buckets.populatable, ...buckets.dynamicZones])
}
