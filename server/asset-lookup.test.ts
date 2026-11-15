import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetLookupCursor, assetLookupQuery } from './asset-lookup.js';
import { encodeCursor } from './cursor.js';
import { newAssetId } from './asset-id.js';
import { ValidationError } from './identity.js';
import { composition } from './test-fixture.js';
const { schemes } = composition;

test('lookup accepts exactly one complete identity', () => {
  const id = newAssetId();
  assert.deepEqual(assetLookupQuery({ id }, schemes),
    { identity: { kind: 'assetId', id }, limit: 30, after: null });
  const { identity } = assetLookupQuery({ scheme: 'tag', code: 'T-1' }, schemes);
  assert.equal(identity.kind, 'identifier');
  assert.equal(identity.kind === 'identifier' && identity.identifier.canonical, 'tag:T-1');
  for (const query of [
    {},
    { id, scheme: 'tag', code: 'T-1' },
    // An identifier field without a scheme is still an identity request: the
    // native-ID branch must not win by ignoring it.
    { id, series: 'drill' },
    { scheme: 'tag' },
    { code: 'T-1' },
    { id, extra: 'x' },
    { q: 'oscilloscope' },
  ]) assert.throws(() => assetLookupQuery(query, schemes), ValidationError, JSON.stringify(query));
});

test('an incomplete or malformed identity is rejected, never matched loosely', () => {
  // A native id must be a complete canonical UUIDv7.
  for (const id of ['', 'not-an-id', newAssetId().slice(0, -1), newAssetId().toUpperCase()]) {
    assert.throws(() => assetLookupQuery({ id }, schemes), ValidationError, String(id));
  }
  // An identifier goes through its scheme, so a value the scheme refuses is a
  // validation error rather than a prefix search.
  for (const query of [
    { scheme: 'tag', code: 'T-' },
    { scheme: 'tag', code: '1' },
    { scheme: 'tag', series: 'drill' },
    { scheme: 'model', series: 'Drill' },
    { scheme: 'model', series: '' },
    { scheme: 'unknown', code: 'T-1' },
  ]) assert.throws(() => assetLookupQuery(query, schemes), ValidationError, JSON.stringify(query));
});

test('the level of an identity is derived by its scheme, never supplied', () => {
  const individual = assetLookupQuery({ scheme: 'tag', code: 'T-1' }, schemes).identity;
  assert.equal(individual.kind === 'identifier' && individual.identifier.level, 'individual');
  const described = assetLookupQuery({ scheme: 'model', series: 'drill' }, schemes).identity;
  assert.equal(described.kind === 'identifier' && described.identifier.level, 'class');
  // `level` is not a field any scheme accepts, so a caller cannot assert it.
  assert.throws(() => assetLookupQuery({ scheme: 'model', series: 'drill', level: 'individual' }, schemes), ValidationError);
});

test('only a class identifier pages, and its cursor is bound to that identity', () => {
  const described = { scheme: 'model', series: 'drill' };
  const canonical = 'model:drill';
  const asset = { name: 'Laptop A', id: newAssetId() };
  const cursor = assetLookupCursor(canonical, asset);
  assert.deepEqual(assetLookupQuery({ ...described, cursor }, schemes).after, { name: asset.name, id: asset.id });
  assert.equal(assetLookupQuery({ ...described, limit: '5' }, schemes).limit, 5);

  // A cursor from another identity cannot be replayed.
  assert.throws(() => assetLookupQuery({ ...described,
    cursor: assetLookupCursor('model:saw', asset) }, schemes), ValidationError);
  // Identities that resolve to a single Asset reject pagination outright.
  assert.throws(() => assetLookupQuery({ id: newAssetId(), cursor }, schemes), ValidationError);
  assert.throws(() => assetLookupQuery({ scheme: 'tag', code: 'T-1', cursor }, schemes), ValidationError);
  // Malformed cursors and out-of-range page sizes fail closed.
  for (const bad of ['', '%', 'null', encodeCursor({ canonical, name: 'x', id: 'not-an-id' }),
    Buffer.from(JSON.stringify({ canonical, name: 'x', id: asset.id })).toString('base64url')]) {
    assert.throws(() => assetLookupQuery({ ...described, cursor: bad }, schemes), ValidationError, bad.slice(0, 20));
  }
  for (const limit of ['0', '101', '1.5', 'NaN']) {
    assert.throws(() => assetLookupQuery({ ...described, limit }, schemes), ValidationError, limit);
  }
});
