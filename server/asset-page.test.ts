import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetCursor, assetPageRequest, assetSortKey, assetSorts, canonicalFilters,
  emptyAssetFilters } from './asset-page.js';
import { cursorVersion, encodeCursor } from './cursor.js';
import { newAssetId } from './asset-id.js';
import { inventoryPath, noFilters } from '../web/inventory-controls.js';
import { ValidationError } from './identity.js';

const asset = { name: '測定器 — A', reportedAt: '2026-09-20T08:01:49.123000000Z', id: newAssetId() };
const request = { q: '測定', scope: 'all' as const, sort: 'name' as const, dir: 'asc' as const,
  filters: emptyAssetFilters, limit: 30, after: null };
/** The same query shape as `request`, in the string form a URL supplies. */
const base: Record<string, string> = { q: '測定', scope: 'all', sort: 'name', dir: 'asc' };

test('browse defaults preserve the pre-filter contract', () => {
  assert.deepEqual(assetPageRequest({}), { q: '', scope: 'all', sort: 'name', dir: 'asc',
    filters: emptyAssetFilters, limit: 30, after: null });
  assert.deepEqual(assetSorts, ['name', 'reportedAt']);
  // No filter parameters means no discovery predicate at all.
  assert.equal(canonicalFilters(emptyAssetFilters), '');
});

test('filters parse, validate and canonicalise into a stable key', () => {
  const parsed = assetPageRequest({ group: ['b', 'a'], scheme: 'sgtin,gtin',
    identified: 'any', reportedFrom: '2026-01-01', reportedTo: '2026-02-01T00:00:00Z' });
  assert.deepEqual(parsed.filters.groups, ['a', 'b']);
  assert.deepEqual(parsed.filters.schemes, ['gtin', 'sgtin']);
  assert.equal(parsed.filters.identified, 'any');
  assert.equal(parsed.filters.reportedFrom, '2026-01-01T00:00:00.000Z');
  // Repeated entries, comma lists, duplicates and ordering all canonicalise the same.
  const other = assetPageRequest({ group: 'a,b,a', scheme: ['gtin', 'sgtin', 'gtin'],
    identified: 'any', reportedFrom: '2026-01-01T00:00:00.000Z',
    reportedTo: '2026-02-01T00:00:00Z' });
  assert.equal(canonicalFilters(parsed.filters), canonicalFilters(other.filters));
  assert.equal(canonicalFilters(parsed.filters),
    'groups=a,b|schemes=gtin,sgtin|identified=any'
    + '|from=2026-01-01T00:00:00.000Z|to=2026-02-01T00:00:00.000Z');
  // Visibility is not a filter: the scope tabs own that dimension, so the
  // parameter is simply unknown and contributes nothing to the predicate.
  assert.equal(canonicalFilters(assetPageRequest({ visibility: 'public' }).filters), '');
  for (const query of [{ scheme: 'ean' }, { identified: 'maybe' },
    { reportedFrom: 'yesterday' }, { reportedTo: '' , reportedFrom: 'not-a-date' }]) {
    assert.throws(() => assetPageRequest(query), ValidationError, JSON.stringify(query));
  }
});

test('the cursor carries the sort value and the tiebreaker', () => {
  for (const sort of assetSorts) {
    for (const dir of ['asc', 'desc'] as const) {
      const sorted = { ...request, sort, dir };
      const parsed = assetPageRequest({ ...base, sort, dir, cursor: assetCursor(sorted, asset) });
      assert.deepEqual(parsed.after, { key: assetSortKey(asset, sort), id: asset.id }, `${sort} ${dir}`);
      assert.equal(parsed.sort, sort);
      assert.equal(parsed.dir, dir);
    }
  }
  // reportedAt travels as the same ISO instant the API returns.
  assert.equal(assetSortKey(asset, 'reportedAt'), asset.reportedAt);
});

test('a cursor is bound to the whole query shape and fails closed otherwise', () => {
  const cursor = assetCursor(request, asset);
  assert.doesNotThrow(() => assetPageRequest({ ...base, cursor }));
  // Every bound field must match: changing any one rejects the cursor.
  for (const change of [
    { q: 'other' }, { scope: 'mine' }, { sort: 'reportedAt' }, { dir: 'desc' },
    // The complete canonical filter state is bound too, so adding, removing or
    // altering any filter invalidates a cursor taken under another predicate.
    { scheme: 'gtin' }, { identified: 'none' },
    { group: 'a' }, { reportedFrom: '2026-01-01' }, { reportedTo: '2026-01-01' },
  ]) assert.throws(() => assetPageRequest({ ...base, ...change, cursor }),
    ValidationError, JSON.stringify(change));
  // A cursor from another version, or carrying anything else, is rejected.
  for (const foreign of [
    Buffer.from(JSON.stringify({ v: cursorVersion + 1, ...base, key: asset.name, id: asset.id })).toString('base64url'),
    Buffer.from(JSON.stringify({ ...base, key: asset.name, id: asset.id })).toString('base64url'),
    encodeCursor({ ...base, key: asset.name, id: 'not-a-native-id' }),
    encodeCursor({ ...base, key: '', id: asset.id }),
    encodeCursor({ ...base, key: asset.name, id: asset.id, filters: 'future' }),
    '%', 'null',
  ]) assert.throws(() => assetPageRequest({ ...base, cursor: foreign }), ValidationError, foreign.slice(0, 24));
  // An empty parameter means unset everywhere, including the cursor, so a
  // stray `?cursor=` starts from the first page instead of failing.
  assert.equal(assetPageRequest({ ...base, cursor: '' }).after, null);
});

test('sort, direction and page size are validated against closed sets', () => {
  for (const query of [{ sort: 'owner' }, { dir: 'ascending' }, { dir: 'DESC' }, { scope: 'owner' }]) {
    assert.throws(() => assetPageRequest(query), ValidationError, JSON.stringify(query));
  }
  for (const limit of ['0', '-1', '101', '1.5', 'NaN', 'Infinity']) {
    assert.throws(() => assetPageRequest({ limit }), ValidationError);
  }
  assert.throws(() => assetPageRequest({ q: 'a'.repeat(201) }), ValidationError);
  // Empty is unset, never invalid: a form that submits a blank control must not
  // break the page. A present but unrecognised value is still rejected.
  assert.deepEqual(assetPageRequest({ sort: '', dir: '', scope: '', limit: '', q: '' }),
    assetPageRequest({}));
});

test('every query-string shape parses identically, and empty means unset', () => {
  // The API receives scalars; a browser URL is read with getAll and yields
  // arrays. Both must mean the same thing, and an empty value means unset.
  const shapes = (raw: string) => {
    const url = new URL(raw, 'http://kannabi.test');
    return [
      Object.fromEntries(url.searchParams) as Record<string, string>,
      Object.fromEntries([...url.searchParams.keys()]
        .map((key) => [key, url.searchParams.getAll(key)])) as Record<string, string[]>,
    ];
  };
  // The exact URL that previously failed to load: every filter serialised empty.
  for (const shape of shapes('/?q=Camera&scope=group&sort=name&dir=asc'
    + '&group=&identified=&scheme=&reportedFrom=&reportedTo=')) {
    const parsed = assetPageRequest(shape);
    assert.equal(canonicalFilters(parsed.filters), '', 'unset filters must mean no predicate');
    assert.deepEqual(parsed.filters, emptyAssetFilters);
    assert.equal(parsed.q, 'Camera');
    assert.equal(parsed.scope, 'group');
  }
  // The second failing URL: filters set, with one bound left empty.
  for (const shape of shapes('/?sort=name&dir=asc&group=7818b2d4-7ad9-4fa1-8f0c-fa3061584091'
    + '&identified=none&scheme=gtin&reportedFrom=2026-09-19&reportedTo=')) {
    const parsed = assetPageRequest(shape);
    assert.equal(canonicalFilters(parsed.filters),
      'groups=7818b2d4-7ad9-4fa1-8f0c-fa3061584091|schemes=gtin'
      + '|identified=none|from=2026-09-19T00:00:00.000Z');
    assert.equal(parsed.filters.reportedTo, null);
  }
});

test('the URLs the inventory generates round-trip through the parser', () => {
  const view = { q: '', scope: 'all' as const, sort: 'name' as const, dir: 'asc' as const,
    filters: emptyAssetFilters };
  const roundTrip = (path: string) => {
    const params = new URL(path, 'http://kannabi.test').searchParams;
    // Read exactly as the route loader does, through getAll.
    return assetPageRequest(Object.fromEntries([...params.keys()].map((key) => [key, params.getAll(key)])));
  };
  // Apply with everything unset yields a bare path and no predicate.
  assert.equal(inventoryPath(view), '/');
  assert.deepEqual(roundTrip(inventoryPath(view)).filters, emptyAssetFilters);
  // Clearing filters drops the filter parameters rather than emptying them.
  const filtered = { ...view, filters: { ...emptyAssetFilters, identified: 'any' as const } };
  assert.equal(inventoryPath(filtered), '/?identified=any');
  // Clear all and Clear filters are the same canonical operation, and neither
  // disturbs the unrelated query context.
  assert.equal(inventoryPath(filtered, { filters: noFilters }), '/');
  assert.equal(inventoryPath({ ...filtered, q: 'Camera', scope: 'group', sort: 'reportedAt', dir: 'desc' },
    { filters: noFilters }), '/?q=Camera&scope=group&sort=reportedAt&dir=desc');
  // One filter set with the rest unset, and several set with a bound unset.
  for (const filters of [
    { ...emptyAssetFilters, identified: 'none' as const },
    { ...emptyAssetFilters, groups: ['g1'], schemes: ['gtin' as const],
      reportedFrom: '2026-09-19T00:00:00.000Z' },
  ]) {
    const path = inventoryPath({ ...view, filters });
    assert.ok(!path.includes('=&') && !path.endsWith('='), `no empty parameters in ${path}`);
    assert.equal(canonicalFilters(roundTrip(path).filters), canonicalFilters(filters), path);
  }
  // Search, scope and ordering survive the same round trip.
  const full = inventoryPath({ ...view, q: 'Camera', scope: 'group', sort: 'reportedAt', dir: 'desc' });
  const parsed = roundTrip(full);
  assert.deepEqual([parsed.q, parsed.scope, parsed.sort, parsed.dir], ['Camera', 'group', 'reportedAt', 'desc']);
});
