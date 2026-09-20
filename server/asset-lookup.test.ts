import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetLookupCursor, assetLookupQuery } from './asset-lookup.js';
import { encodeCursor } from './cursor.js';
import { newAssetId } from './asset-id.js';
import { ValidationError } from './identity.js';

test('lookup accepts exactly one complete identity', () => {
  const id = newAssetId();
  assert.deepEqual(assetLookupQuery({ id }),
    { identity: { kind: 'assetId', id }, limit: 30, after: null });
  const { identity } = assetLookupQuery({ scheme: 'giai', assetReference: '0614141ASSET-001' });
  assert.equal(identity.kind, 'identifier');
  assert.equal(identity.kind === 'identifier' && identity.identifier.canonical, '(8004)0614141ASSET-001');
  for (const query of [
    {},
    { id, scheme: 'giai', assetReference: '0614141ASSET-001' },
    { scheme: 'giai' },
    { assetReference: '0614141ASSET-001' },
    { id, extra: 'x' },
    { q: 'oscilloscope' },
  ]) assert.throws(() => assetLookupQuery(query), ValidationError, JSON.stringify(query));
});

test('an incomplete or malformed identity is rejected, never matched loosely', () => {
  // A native id must be a complete canonical UUIDv7.
  for (const id of ['', 'not-an-id', newAssetId().slice(0, -1), newAssetId().toUpperCase()]) {
    assert.throws(() => assetLookupQuery({ id }), ValidationError, String(id));
  }
  // Identifiers go through the GS1 boundary, so a bad check digit or a
  // partial value is a validation error rather than a prefix search.
  for (const query of [
    { scheme: 'gtin', gtin: '0614141123453' },
    { scheme: 'gtin', gtin: '06141411234' },
    { scheme: 'sgtin', gtin: '0614141123452' },
    { scheme: 'grai', assetType: '061414123456' },
    { scheme: 'giai', assetReference: '' },
    { scheme: 'unknown', assetReference: 'x' },
  ]) assert.throws(() => assetLookupQuery(query), ValidationError, JSON.stringify(query));
});

test('equivalent GS1 input canonicalises to one identity', () => {
  // GTIN-13 and GTIN-14 spellings of the same trade item resolve identically,
  // because canonicalisation belongs to the GS1 boundary, not to lookup.
  const short = assetLookupQuery({ scheme: 'gtin', gtin: '0614141123452' }).identity;
  const padded = assetLookupQuery({ scheme: 'gtin', gtin: '00614141123452' }).identity;
  assert.equal(short.kind === 'identifier' && short.identifier.canonical, '(01)00614141123452');
  assert.deepEqual(short, padded);
  // Level is derived, so callers cannot assert a class identity is unique.
  assert.equal(short.kind === 'identifier' && short.identifier.level, 'class');
  const serialised = assetLookupQuery({ scheme: 'grai', assetType: '0614141234561', serial: '789' }).identity;
  assert.equal(serialised.kind === 'identifier' && serialised.identifier.level, 'individual');
  const bare = assetLookupQuery({ scheme: 'grai', assetType: '0614141234561' }).identity;
  assert.equal(bare.kind === 'identifier' && bare.identifier.level, 'class');
});

test('only a class identifier pages, and its cursor is bound to that identity', () => {
  const gtin = { scheme: 'gtin', gtin: '0614141123452' };
  const canonical = '(01)00614141123452';
  const asset = { name: 'Laptop A', id: newAssetId() };
  const cursor = assetLookupCursor(canonical, asset);
  assert.deepEqual(assetLookupQuery({ ...gtin, cursor }).after, { name: asset.name, id: asset.id });
  assert.equal(assetLookupQuery({ ...gtin, limit: '5' }).limit, 5);

  // A cursor from another identity cannot be replayed.
  assert.throws(() => assetLookupQuery({ ...gtin,
    cursor: assetLookupCursor('(01)04901234567894', asset) }), ValidationError);
  // Identities that resolve to a single Asset reject pagination outright.
  assert.throws(() => assetLookupQuery({ id: newAssetId(), cursor }), ValidationError);
  assert.throws(() => assetLookupQuery({ scheme: 'giai', assetReference: '0614141X', cursor }), ValidationError);
  assert.throws(() => assetLookupQuery({ scheme: 'sgtin', gtin: '0614141123452', serial: 'A', cursor }), ValidationError);
  // Malformed cursors and out-of-range page sizes fail closed.
  for (const bad of ['', '%', 'null', encodeCursor({ canonical, name: 'x', id: 'not-an-id' }),
    Buffer.from(JSON.stringify({ canonical, name: 'x', id: asset.id })).toString('base64url')]) {
    assert.throws(() => assetLookupQuery({ ...gtin, cursor: bad }), ValidationError, bad.slice(0, 20));
  }
  for (const limit of ['0', '101', '1.5', 'NaN']) {
    assert.throws(() => assetLookupQuery({ ...gtin, limit }), ValidationError, limit);
  }
});
