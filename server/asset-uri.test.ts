import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyAssetUri } from '../web/asset-uri.js';
import { assetPath, assetPhotoPath } from '../shared/asset-uri.js';
import { newAssetId } from './asset-id.js';

test('the canonical Asset URI is the native ID path and is copied complete', async () => {
  const id = newAssetId();
  assert.equal(assetPath(id), '/asset/' + id);
  const uri = new URL(assetPath(id), 'http://127.0.0.1:3000/').toString();
  assert.equal(uri, 'http://127.0.0.1:3000/asset/' + id);
  assert.equal(uri.includes('?'), false);
  assert.equal(assetPhotoPath(id, 'photo-key'), `/api/assets/${id}/photos/photo-key`);
  let copied = '';
  await copyAssetUri(uri, { writeText: async (value) => { copied = value; } });
  assert.equal(copied, uri);
});
