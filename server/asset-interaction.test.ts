import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAction } from '../web/routes/asset.js';
import { newAssetId } from './asset-id.js';

const id = newAssetId();
const assetUrl = 'http://127.0.0.1:3000/asset/' + id;

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
      params: { id }, request: new Request(assetUrl, { method: 'POST', body: edit }),
    } as never);
    assert.deepEqual(editResult, { kind: 'edit', saved: true, error: null, photoKey: null });
    assert.equal(editResult instanceof Response, false);

    const photo = new FormData();
    photo.set('intent', 'photo');
    photo.set('photo', new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }));
    const photoResult = await clientAction({
      params: { id }, request: new Request(assetUrl, { method: 'POST', body: photo }),
    } as never);
    assert.deepEqual(photoResult, { kind: 'photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(photoResult instanceof Response, false);

    const deletion = new FormData();
    deletion.set('intent', 'delete-photo');
    deletion.set('photoKey', 'new-photo');
    const deletionResult = await clientAction({
      params: { id }, request: new Request(assetUrl, { method: 'POST', body: deletion }),
    } as never);
    assert.deepEqual(deletionResult, { kind: 'delete-photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(deletionResult instanceof Response, false);

    assert.deepEqual(requests.map((request) => request.method), ['PATCH', 'POST', 'DELETE']);
    // Every Asset-scoped call addresses the native Asset id, never an external identifier.
    assert.deepEqual(requests.map((request) => new URL(request.url, assetUrl).pathname), [
      `/api/assets/${id}`, `/api/assets/${id}/photos`, `/api/assets/${id}/photos/new-photo`,
    ]);
    assert.ok(requests.every((request) => !new URL(request.url, assetUrl).search));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collaboration actions preserve identity and leave the page only when access ends', async () => {
  const originalFetch = globalThis.fetch;
  let readable = true;
  let conflict = false;
  const requests: { path: string; method: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    requests.push({ path: new URL(url, assetUrl).pathname, method });
    const status = conflict ? 409 : method === 'GET' && !readable ? 404 : 200;
    return new Response(JSON.stringify(status === 200 ? { changed: true } : { error: 'Last Group must remain' }),
      { status, headers: { 'Content-Type': 'application/json' } });
  };
  const change = (intent: string) => {
    const data = new FormData();
    data.set('intent', intent); data.set('groupKey', 'group-b');
    return clientAction({ params: { id }, request: new Request(assetUrl, { method: 'POST', body: data }) } as never);
  };
  try {
    assert.deepEqual(await change('grant-collaboration'), { kind: 'collaboration', saved: true, error: null, photoKey: null });
    assert.deepEqual(requests, [
      { path: `/api/assets/${id}/collaboration/group-b`, method: 'PUT' },
      { path: `/api/assets/${id}`, method: 'GET' },
    ]);
    assert.equal((await change('revoke-collaboration')) instanceof Response, false, 'another Group or public access keeps page readable');
    readable = false;
    const result = await change('revoke-collaboration');
    assert.ok(result instanceof Response);
    assert.equal(result.headers.get('Location'), '/');
    conflict = true;
    assert.deepEqual(await change('revoke-collaboration'), {
      kind: 'collaboration', saved: false, error: 'Last Group must remain', photoKey: null,
    });
  } finally { globalThis.fetch = originalFetch; }
});
