import { v7, validate, version } from 'uuid';
import { ValidationError } from './identity.js';

/** Kannabi's native Asset identity: an application-owned UUIDv7 (RFC 9562).
 * It is independent of Neo4j implementation identity and of external
 * identifiers such as SGTIN or GRAI.
 *
 * The UUIDv7 timestamp carries no Kannabi domain meaning. Asset chronology
 * uses explicit domain fields such as `reportedAt`, never UUID ordering.
 */
export function newAssetId(): string {
  return v7();
}

/** The canonical native Asset ID spelling, as a Cypher-compatible regular
 * expression. Persistence verifies stored ids against this; `isAssetId` is the
 * authority for application input, and a test pins the two to agree. */
export const assetIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** Canonical lowercase form only: the id is both a URL path segment and an
 * exact Neo4j lookup key, so a non-canonical spelling could never match. */
export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && value === value.toLowerCase()
    && validate(value) && version(value) === 7;
}

export function assetId(value: unknown): string {
  if (!isAssetId(value)) throw new ValidationError('A native Asset ID is required');
  return value;
}
