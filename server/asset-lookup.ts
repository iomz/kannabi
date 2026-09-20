import { record, ValidationError } from './identity.js';
import { assetId, isAssetId } from './asset-id.js';
import { assertBound, cursorText, decodeCursor, encodeCursor } from './cursor.js';
import { canonicalIdentifier, identifierInputFields, type ExternalIdentifier } from './gs1.js';

/** Deterministic identity resolution: the caller supplies a complete identity
 * and Kannabi answers with the Assets that carry it.
 *
 * This is not search. Nothing here matches substrings, ranks results, or
 * guesses at intent. An identifier is parsed by the existing GS1 boundary and
 * compared against the stored canonical form, so an identifier Kannabi cannot
 * justify semantically produces a validation error rather than a fuzzy match.
 */
export type AssetLookupQuery =
  | Readonly<{ kind: 'assetId'; id: string }>
  | Readonly<{ kind: 'identifier'; identifier: ExternalIdentifier }>;

export const assetLookupFields = ['id', 'limit', 'cursor', ...identifierInputFields] as const;

/** A position within one class identifier's Assets, ordered by name then id.
 * Bound to the resolved canonical form, so a cursor cannot be replayed against
 * a different identity. */
export type AssetLookupCursor = { name: string; id: string };
export type AssetLookupRequest = {
  identity: AssetLookupQuery; limit: number; after: AssetLookupCursor | null;
};

/** Accept exactly one identity: a native Asset ID, or one external identifier
 * in the same structured form the reporting and attachment APIs accept. */
export function assetLookupQuery(query: Record<string, unknown>): AssetLookupRequest {
  const { id, limit: rawLimit, cursor, ...identifier } = record(query, assetLookupFields);
  if ((id === undefined) === (identifier.scheme === undefined)) {
    throw new ValidationError('Look up either a native Asset ID or one external identifier');
  }
  const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Page size must be an integer between 1 and 100');
  }
  if (id !== undefined) {
    if (!isAssetId(id)) throw new ValidationError('A native Asset ID is required');
    if (cursor !== undefined) throw new ValidationError('A native Asset ID resolves to a single Asset');
    return { identity: Object.freeze({ kind: 'assetId', id }), limit, after: null };
  }
  const resolved = canonicalIdentifier(identifier);
  // Only a class identifier describes enough Assets to page through; an
  // individual one resolves to at most one, so a cursor is meaningless.
  if (cursor !== undefined && resolved.level !== 'class') {
    throw new ValidationError('That identifier resolves to a single Asset');
  }
  let after: AssetLookupCursor | null = null;
  if (cursor !== undefined) {
    try {
      const payload = decodeCursor(cursor, ['canonical', 'name', 'id']);
      assertBound(payload, { canonical: resolved.canonical });
      if (!isAssetId(payload.id)) throw new ValidationError('Invalid cursor');
      after = { name: cursorText(payload, 'name'), id: assetId(payload.id) };
    } catch { throw new ValidationError('Invalid Asset cursor for this identifier'); }
  }
  return { identity: Object.freeze({ kind: 'identifier', identifier: resolved }), limit, after };
}

export function assetLookupCursor(canonical: string, asset: { name: string; id: string }): string {
  return encodeCursor({ canonical, name: asset.name, id: asset.id });
}
