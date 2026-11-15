import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAction } from '../web/routes/asset.js';
import { newAssetId } from './asset-id.js';

const id = newAssetId();
const assetUrl = 'http://127.0.0.1:3000/asset/' + id;

/** What the Asset page puts in every submission: the native identity, and
 * the address the viewer is standing on. */
function identify(form: FormData, at = '/asset/' + id) {
  form.set('assetId', id);
  form.set('at', at);
  return form;
}

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
    const rename = new FormData();
    rename.set('intent', 'rename');
    rename.set('name', 'Updated Asset');
    const renameResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: identify(rename) }),
    } as never);
    assert.deepEqual(renameResult, { kind: 'rename', saved: true, error: null, photoKey: null });
    assert.equal(renameResult instanceof Response, false);

    const publish = new FormData();
    publish.set('intent', 'visibility');
    publish.set('isPublic', 'true');
    const publishResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: identify(publish) }),
    } as never);
    assert.deepEqual(publishResult, { kind: 'visibility', saved: true, error: null, photoKey: null });

    const photo = new FormData();
    photo.set('intent', 'photo');
    photo.set('photo', new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }));
    const photoResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: identify(photo) }),
    } as never);
    assert.deepEqual(photoResult, { kind: 'photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(photoResult instanceof Response, false);

    const deletion = new FormData();
    deletion.set('intent', 'delete-photo');
    deletion.set('photoKey', 'new-photo');
    const deletionResult = await clientAction({
      request: new Request(assetUrl, { method: 'POST', body: identify(deletion) }),
    } as never);
    assert.deepEqual(deletionResult, { kind: 'delete-photo', saved: true, error: null, photoKey: 'new-photo' });
    assert.equal(deletionResult instanceof Response, false);

    // Two PATCHes: renaming and publishing are separate mutations now, each
    // carrying only its own field.
    assert.deepEqual(requests.map((request) => request.method), ['PATCH', 'PATCH', 'POST', 'DELETE']);
    // Every Asset-scoped call addresses the native Asset id, never an external identifier.
    assert.deepEqual(requests.map((request) => new URL(request.url, assetUrl).pathname), [
      `/api/assets/${id}`, `/api/assets/${id}`,
      `/api/assets/${id}/photos`, `/api/assets/${id}/photos/new-photo`,
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
    return clientAction({ request: new Request(assetUrl, { method: 'POST', body: identify(data) }) } as never);
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

test('an identifier mutation leaves an address that no longer serves the Asset', async () => {
  const originalFetch = globalThis.fetch;
  // Two shelf tags: an Asset is served at the address of each one it
  // carries, and the first is the one surfaced.
  const first = { scheme: 'tag', level: 'individual', canonical: 'tag:T-1', components: { code: 'T-1' } };
  const second = { scheme: 'tag', level: 'individual', canonical: 'tag:T-2', components: { code: 'T-2' } };
  const firstPath = '/tag/T-1';
  const secondPath = '/tag/T-2';

  /** Every mutation answers with the Asset as it stands afterwards. */
  const respondWith = (identifiers: unknown[]) => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ asset: { id, identifiers } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const detach = () => {
    const form = new FormData();
    form.set('intent', 'detach-identifier');
    form.set('identifierKey', 'k');
    return form;
  };
  // `from` is where the viewer stands, carried by the submission rather than
  // read back out of the action's URL.
  const submit = (from: string, body: FormData) => clientAction({
    request: new Request('http://127.0.0.1:3000' + from, { method: 'POST', body: identify(body, from) }),
  } as never);

  try {
    // Standing on the first tag's address and detaching that tag: the address
    // is now correctly unresolvable, so the viewer is moved to what remains.
    respondWith([second]);
    const moved = await submit(firstPath, detach());
    assert.ok(moved instanceof Response);
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get('location'), secondPath);

    // Nothing left to surface: back to the native Asset URI.
    respondWith([]);
    const home = await submit(firstPath, detach());
    assert.ok(home instanceof Response);
    assert.equal(home.headers.get('location'), '/asset/' + id);

    // Standing on a valid address that is not the surfaced one: that address
    // still serves the Asset, so the viewer stays and
    // the action returns ordinary fetcher data. Navigating here would do by
    // navigation what resolution must never do by redirect.
    respondWith([first, second]);
    const stayed = await submit(secondPath, detach());
    assert.equal(stayed instanceof Response, false);
    assert.deepEqual(stayed, { kind: 'detach-identifier', saved: true, error: null, photoKey: null });

    // Attaching the first addressed identifier while on the native URI moves
    // the viewer, because the server would redirect that URI from now on.
    const attach = new FormData();
    attach.set('intent', 'attach-identifier');
    attach.set('scheme', 'tag');
    attach.set('code', 'T-1');
    respondWith([first]);
    const attached = await submit('/asset/' + id, attach);
    assert.ok(attached instanceof Response);
    assert.equal(attached.headers.get('location'), firstPath);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
