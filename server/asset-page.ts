import { ValidationError } from './identity.js';
import { assetId, isAssetId } from './asset-id.js';
import { assertBound, cursorText, decodeCursor, encodeCursor } from './cursor.js';
import { identifierSchemes, type IdentifierScheme } from './gs1.js';

export type AssetScope = 'all' | 'mine' | 'group' | 'public';

/** Sortable Asset fields.
 *
 * Only attributes whose ordering carries domain meaning belong here. `name` is
 * the display ordering; `reportedAt` is the chronology. `Asset.id` is never a
 * sort — its UUIDv7 timestamp has no domain meaning and appears solely as a
 * tiebreaker so every ordering is total.
 *
 * Deliberately absent: external identifiers (an Asset has 0..n, so there is no
 * value to order by), owner and Group (nullable or 0..n), and allocation
 * sequence (meaningful only within one namespace).
 */
export const assetSorts = ['name', 'reportedAt'] as const;
export type AssetSort = (typeof assetSorts)[number];
export const assetDirections = ['asc', 'desc'] as const;
export type AssetDirection = (typeof assetDirections)[number];

/** Structured discovery predicates.
 *
 * Each is a separate, explicitly typed capability rather than a generic query
 * language. Values compose as OR within one filter and AND across filters, so
 * a filter can only ever narrow the caller-readable set.
 *
 * Deliberately absent, with reasons recorded in the Slice 3 report: owner (the
 * API can neither create nor list Owners, so the filter could not be presented
 * truthfully) and reporter (member listing is administrator-only, and
 * `scope=mine` already serves the workflow the filter would cover).
 *
 * Visibility is absent for a different reason. The scope tabs — All, Mine,
 * Group access, Public — already express visibility-oriented browsing at the
 * top level of the inventory, so a second visibility selector inside the
 * filters offered two ways to say one thing. Group stays, because `scope=group`
 * (readable through any Group access) and `group=<key>` (associated with one
 * specific Group) are genuinely different questions.
 */
export type AssetIdentified = 'any' | 'none';
export type AssetFilters = Readonly<{
  groups: readonly string[];
  schemes: readonly IdentifierScheme[];
  identified: AssetIdentified | null;
  reportedFrom: string | null;
  reportedTo: string | null;
}>;

export const emptyAssetFilters: AssetFilters = Object.freeze({
  groups: [], schemes: [], identified: null, reportedFrom: null, reportedTo: null,
});

/** A position in the current ordering: the sort field's value at the page
 * boundary plus the tiebreaker. Never an Asset identity. */
export type AssetCursor = { key: string; id: string };
export type AssetPageRequest = {
  q: string; scope: AssetScope; sort: AssetSort; dir: AssetDirection;
  filters: AssetFilters; limit: number; after: AssetCursor | null;
};

/** The fields a browse cursor is bound to: the complete discovery predicate and
 * ordering. Replaying a cursor under any different query shape is rejected. */
const boundFields = ['q', 'scope', 'sort', 'dir', 'filters'] as const;

/** A stable textual form of the filter state, so a cursor binds to exactly the
 * predicate that produced it. Multi-values are sorted and de-duplicated, so two
 * spellings of the same filter state produce one canonical form. */
export function canonicalFilters(filters: AssetFilters): string {
  const parts: string[] = [];
  if (filters.groups.length) parts.push(`groups=${[...filters.groups].sort().join(',')}`);
  if (filters.schemes.length) parts.push(`schemes=${[...filters.schemes].sort().join(',')}`);
  if (filters.identified) parts.push(`identified=${filters.identified}`);
  if (filters.reportedFrom) parts.push(`from=${filters.reportedFrom}`);
  if (filters.reportedTo) parts.push(`to=${filters.reportedTo}`);
  return parts.join('|');
}

export function hasAssetFilters(filters: AssetFilters): boolean {
  return canonicalFilters(filters).length > 0;
}

function instant(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${field} must be an ISO date or instant`);
  return parsed.toISOString();
}

function many<T extends string>(values: readonly string[], allowed: readonly T[], field: string): T[] {
  const chosen = [...new Set(values.filter((value) => value !== ''))];
  for (const value of chosen) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
    }
  }
  return chosen.sort() as T[];
}

/** Repeatable parameters arrive either as several entries or as one
 * comma-separated value; both canonicalise to the same filter state. */
function list(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value as string]).flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim());
}

/** A single-valued parameter, however the caller spelled it.
 *
 * A query string reaches this code in two shapes: the API hands over scalars,
 * while a browser URL is read with `getAll`, which always yields an array. Both
 * must mean the same thing. An empty value means the filter is unset, so a
 * hand-edited `?identified=` behaves exactly like omitting it.
 */
function single(value: string | readonly string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value as string | undefined;
  return first === undefined || first.trim() === '' ? undefined : first.trim();
}

export function assetFilters(query: Record<string, string | string[] | undefined>): AssetFilters {
  const groups = [...new Set(list(query.group).filter((key) => key !== ''))].sort();
  if (groups.some((key) => key.length > 64)) throw new ValidationError('Invalid Group filter');
  const identified = single(query.identified);
  return Object.freeze({
    groups,
    schemes: many(list(query.scheme), identifierSchemes, 'Identifier scheme filter'),
    identified: identified === undefined
      ? null : member(identified, ['any', 'none'], 'Identifier presence filter'),
    reportedFrom: instant(single(query.reportedFrom), 'Reported from'),
    reportedTo: instant(single(query.reportedTo), 'Reported to'),
  });
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export function assetPageRequest(query: Record<string, string | string[] | undefined>): AssetPageRequest {
  const q = single(query.q) ?? '';
  const filters = assetFilters(query);
  const filterKey = canonicalFilters(filters);
  const scope = member(single(query.scope) ?? 'all', ['all', 'mine', 'group', 'public'], 'Asset scope');
  const sort = member(single(query.sort) ?? 'name', assetSorts, 'Asset sort');
  const dir = member(single(query.dir) ?? 'asc', assetDirections, 'Asset sort direction');
  if (q.length > 200) throw new ValidationError('Search is limited to 200 characters');
  const rawLimit = single(query.limit);
  const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Page size must be an integer between 1 and 100');
  }
  let after: AssetCursor | null = null;
  const cursor = single(query.cursor);
  if (cursor !== undefined) {
    try {
      const payload = decodeCursor(cursor, [...boundFields, 'key', 'id']);
      assertBound(payload, { q, scope, sort, dir, filters: filterKey });
      if (!isAssetId(payload.id)) throw new ValidationError('Invalid cursor');
      after = { key: cursorText(payload, 'key'), id: assetId(payload.id) };
    } catch { throw new ValidationError('Invalid Asset cursor for this search'); }
  }
  return { q, scope, sort, dir, filters, limit, after };
}

/** The sort value carried in the cursor. `reportedAt` travels as the same ISO
 * instant the API returns, and is compared as a temporal value rather than as
 * text so formatting can never decide ordering. */
export function assetSortKey(asset: { name: string; reportedAt: string }, sort: AssetSort): string {
  return sort === 'name' ? asset.name : asset.reportedAt;
}

export function assetCursor(request: AssetPageRequest, asset: { name: string; reportedAt: string; id: string }): string {
  const { q, scope, sort, dir } = request;
  return encodeCursor({ q, scope, sort, dir, filters: canonicalFilters(request.filters),
    key: assetSortKey(asset, sort), id: asset.id });
}
