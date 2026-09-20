import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetCursor, assetPageRequest } from './asset-page.js';
import { newAssetId } from './asset-id.js';
import { ValidationError } from './identity.js';

test('Asset page bounds and cursor use Asset-native ordering only', () => {
  assert.deepEqual(assetPageRequest({}), { q: '', scope: 'all', limit: 30, after: null });
  const id = newAssetId();
  const cursor = assetCursor('測定', { name: '測定器 — A', id });
  const parsed = assetPageRequest({ q: '測定', limit: '100', cursor });
  assert.deepEqual(parsed.after, { name: '測定器 — A', id });
  assert.throws(() => assetPageRequest({ q: 'other', cursor }), ValidationError);
  assert.throws(() => assetPageRequest({ q: '測定', scope: 'mine', cursor }), ValidationError);
  assert.equal(assetPageRequest({ q: '測定', scope: 'mine',
    cursor: assetCursor('測定', { name: '測定器 — A', id }, 'mine') }).scope, 'mine');
  for (const limit of ['', '0', '-1', '101', '1.5', 'NaN', 'Infinity']) {
    assert.throws(() => assetPageRequest({ limit }), ValidationError);
  }
  for (const cursor of ['', '%', 'null',
    // No identifier may act as a cursor position, and the id must be a native one.
    Buffer.from(JSON.stringify({ q: '', scope: 'all', name: 'Asset', identifier: { scheme: 'sgtin' } })).toString('base64url'),
    Buffer.from(JSON.stringify({ q: '', scope: 'all', name: 'Asset', id: 'not-a-native-id' })).toString('base64url'),
    Buffer.from(JSON.stringify({ q: '', scope: 'all', name: 'Asset' })).toString('base64url'),
  ]) assert.throws(() => assetPageRequest({ cursor }), ValidationError);
  assert.throws(() => assetPageRequest({ q: 'a'.repeat(201) }), ValidationError);
  assert.throws(() => assetPageRequest({ scope: 'owner' }), ValidationError);
});
