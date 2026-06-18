/**
 * Strapi migration-testing adapter — public surface.
 *
 * Isolated from mountproof core (not re-exported by the root index): core stays
 * CMS-agnostic. This layer introspects Strapi schemas to build safe populate
 * plans and normalize responses for parity, feeding the runner's trajectories.
 */

export type {
  AttributeBuckets,
  StrapiAttribute,
  StrapiAttributeType,
  StrapiContentType,
  StrapiSchema,
  StrapiVersion,
} from './types.js'

export {
  bucketAttributes,
  findByPluralApiId,
  parseComponents,
  parseContentTypes,
  parseSchema,
  type RawSchemaInput,
} from './schema.js'

export {
  buildPopulatePlan,
  populateUrl,
  toPopulateQuery,
  type PopulatePlan,
  type PopulatePlanOptions,
} from './populate.js'

export {
  detectStrapiVersion,
  firstEntry,
  flattenEntry,
  inferVersionFromEntry,
} from './version.js'

export {
  entryToTrajectory,
  extractLeaves,
  leavesToProofs,
  type ExpectationTrajectoryOptions,
  type ExtractOptions,
  type ProofGenOptions,
} from './expectations.js'
