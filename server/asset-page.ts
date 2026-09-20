import { record, ValidationError } from './identity.js';
import { assetId, isAssetId } from './asset-id.js';

export type AssetScope = 'all' | 'mine' | 'group' | 'public';
/** Asset-native ordering. `Asset.id` is a deterministic tiebreaker only; its
 * UUIDv7 timestamp is never read as chronology. */
export type AssetCursor = { name: string; id: string };
export type AssetPageRequest = { q: string; scope: AssetScope; limit: number; after: AssetCursor | null };

export function assetPageRequest(query: Record<string, string | undefined>): AssetPageRequest {
  const q = query.q ?? '';
  const scope = query.scope ?? 'all';
  if (!['all', 'mine', 'group', 'public'].includes(scope)) throw new ValidationError('Invalid Asset scope');
  if (q.length > 200) throw new ValidationError('Search is limited to 200 characters');
  const limit = query.limit === undefined ? 30 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Page size must be an integer between 1 and 100');
  }
  let after: AssetCursor | null = null;
  if (query.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const cursor = record(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        ['q', 'scope', 'name', 'id']);
      if (cursor.q !== q || cursor.scope !== scope || typeof cursor.name !== 'string' || !cursor.name
          || !isAssetId(cursor.id)) throw new Error();
      after = { name: cursor.name, id: assetId(cursor.id) };
    } catch { throw new ValidationError('Invalid Asset cursor for this search'); }
  }
  return { q, scope: scope as AssetScope, limit, after };
}

export function assetCursor(q: string, asset: { name: string; id: string }, scope: AssetScope = 'all'): string {
  // A position in the existing name/id ordering, never a new Asset identity.
  return Buffer.from(JSON.stringify({ q, scope, name: asset.name, id: asset.id })).toString('base64url');
}
