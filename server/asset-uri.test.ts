import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyAssetUri } from '../web/asset-uri.js';

test('Asset URI copy writes the complete canonical URI', async () => {
  const uri = 'https://example.test/asset?scheme=sgtin&gtin=00614141123452&serial=long%2Fserial%3Fvalue';
  let copied = '';
  await copyAssetUri(uri, { writeText: async (value) => { copied = value; } });
  assert.equal(copied, uri);
});
