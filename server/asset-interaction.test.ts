import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAction } from '../web/routes/asset.js';

const assetUrl = 'http://127.0.0.1:3000/asset?scheme=sgtin&gtin=00614141123452&serial=interaction';

test('Asset edit and photo actions return fetcher data instead of redirects', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    requests.push({ url, method });
    return new Response(JSON.stringify({ asset: { photos: [{ key: 'new-photo' }] }, deleted: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const edit = new FormData();
    edit.set('intent', 'edit');
    edit.set('name', 'Updated Asset');
    edit.set('isPublic', 'on');
    const editResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: edit }),
    } as never);
    assert.deepEqual(editResult, { kind: 'edit', saved: true, error: null, photoKey: null });
    assert.equal(editResult instanceof Response, false);

    const photo = new FormData();
    photo.set('intent', 'photo');
    photo.set('photo', new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }));
    const photoResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: photo }),
    } as never);
    assert.deepEqual(photoResult, { kind: 'photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(photoResult instanceof Response, false);

    const deletion = new FormData();
    deletion.set('intent', 'delete-photo');
    deletion.set('photoKey', 'new-photo');
    const deletionResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: deletion }),
    } as never);
    assert.deepEqual(deletionResult, { kind: 'delete-photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(deletionResult instanceof Response, false);

    assert.deepEqual(requests.map((request) => request.method), ['PATCH', 'POST', 'DELETE']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
