import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import DigitalLinkPage, { clientAction } from '../web/routes/digital-link.js';
import { canonicalIdentifier } from './gs1.js';
import { digitalLinkPath } from './gs1-digital-link.js';
import { newAssetId } from './asset-id.js';
import { mount, settle } from './dom-render.js';

/** Mutating an Asset entered through a GS1 Digital Link.
 *
 * The presentation address must never become the identity a mutation is
 * addressed by. It cannot be: React Router re-encodes a form's action URL,
 * so a page at `/01/.../21/aB%2Fc%25D` runs its action with a request whose
 * path reads `aB%252Fc%25D`. An action that recovered the Asset from that
 * URL resolved a different identifier, found nothing, and rendered "Asset
 * unavailable" without ever performing the mutation.
 *
 * Driving this through a real router at the encoded location is the point: a
 * hand-built FormData submission never produces the re-encoded URL and so
 * could not catch it.
 */

const serial = 'aB/c%D';
const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial });
const digitalLink = digitalLinkPath(sgtin);
const id = newAssetId();

const asset = {
  id, name: 'Test CSET82', isPublic: false, owner: null,
  groups: [{ key: 'workshop', name: 'Workshop' }],
  reportedBy: { key: 'alex', name: 'Alex', status: 'active' },
  reportedAt: '2026-01-01T00:00:00Z',
  identifiers: [{ key: 'i1', ...sgtin }], photos: [], issuances: [],
};

const loaderData = {
  asset, canEdit: true, canViewReporterProfile: false, authenticated: true,
  settings: { displayTimezone: 'UTC', showAssetId: false, showIdentifierPolicyVersion: false },
  digitalLinks: { i1: 'http://127.0.0.1:3000' + digitalLink },
  nativeUri: `http://127.0.0.1:3000/asset/${id}`,
  surfacedUri: 'http://127.0.0.1:3000' + digitalLink,
  namespaces: [], classKeys: [], controlled: [], canGrant: false,
};

/** Answers the API the way the running instance does, and records the calls.
 * Identity resolution deliberately answers only the identifier that is really
 * attached, so a mutation addressed through a mangled path finds nothing. */
function stubApi(calls: { path: string; method: string; body: unknown }[]) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1:3000');
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method, body });
    const json = (value: unknown) => new Response(JSON.stringify(value),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/assets/lookup') {
      const matches = url.searchParams.get('serial') === serial
        && url.searchParams.get('gtin') === '00614141123452';
      return json({ assets: matches ? [asset] : [], matching: matches ? 1 : 0, nextCursor: null });
    }
    if (url.pathname === `/api/assets/${id}`) return json({ asset, canEdit: true, canViewReporterProfile: false });
    return json({ asset });
  };
  return () => { globalThis.fetch = original; };
}

function renderAtDigitalLink() {
  const router = createMemoryRouter([{
    path: '01/:gtin/21/:serial',
    element: createElement(DigitalLinkPage, { loaderData } as never),
    action: (args) => clientAction(args as never),
  }], { initialEntries: [digitalLink] });
  return mount(createElement(RouterProvider, { router }));
}

test('the router really does re-encode the action URL for this address', () => {
  // The premise of the fix, pinned: if this ever stops being true the fix is
  // still correct, but the reason recorded here would be stale.
  const router = createMemoryRouter([{ path: '01/:gtin/21/:serial', element: createElement('div') }],
    { initialEntries: [digitalLink] });
  assert.equal(router.state.location.pathname, '/01/00614141123452/21/aB%2Fc%25D');
});

test('turning on Public access from a Digital Link page reaches the native Asset', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const restore = stubApi(calls);
  const view = renderAtDigitalLink();
  try {
    // One boolean property, carried by a switch.
    await settle(() => document.querySelector<HTMLInputElement>('input[name="isPublic"]')!.click());

    const patch = calls.find((call) => call.method === 'PATCH');
    assert.ok(patch, 'the visibility change was submitted');
    // Addressed by the native identity, never by the Digital Link.
    assert.equal(patch.path, `/api/assets/${id}`);
    assert.deepEqual(patch.body, { isPublic: true });
    // The identity the page carried is not smuggled into the payload.
    assert.equal(Object.keys(patch.body as object).includes('assetId'), false);
    assert.equal(Object.keys(patch.body as object).includes('at'), false);
    // Nothing had to re-resolve the address to perform the mutation.
    assert.equal(calls.some((call) => call.path === '/api/assets/lookup'), false);
    // The viewer stays on the Asset: no error page, no navigation away.
    assert.doesNotMatch(view.text(), /Asset unavailable/);
    assert.match(view.text(), /Test CSET82/);
  } finally {
    view.stop();
    restore();
  }
});

test('a name change from a Digital Link page addresses the native Asset', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const restore = stubApi(calls);
  const view = renderAtDigitalLink();
  try {
    await settle(() => view.button('Rename Test CSET82')!.click());
    view.field('input[name="name"]')!.value = 'Renamed';
    await settle(() => view.button('Save name')!.click());
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.equal(patch?.path, `/api/assets/${id}`);
    assert.deepEqual(patch?.body, { name: 'Renamed' });
    assert.doesNotMatch(view.text(), /Asset unavailable/);
  } finally {
    view.stop();
    restore();
  }
});

test('an identifier mutation from a Digital Link page addresses the native Asset', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const restore = stubApi(calls);
  const view = renderAtDigitalLink();
  try {
    await settle(() => view.button(/^Detach SGTIN/)!.click());
    // Detaching an identity asks first, so the mutation follows the answer.
    await settle(() => view.button('Detach')!.click());
    const deleted = calls.find((call) => call.method === 'DELETE');
    assert.ok(deleted, 'the identifier was detached');
    assert.match(deleted.path, new RegExp(`^/api/assets/${id}/identifiers/`));
    // Nothing re-resolved the address in order to perform the mutation.
    assert.equal(calls.some((call) => call.path === '/api/assets/lookup'), false);
  } finally {
    view.stop();
    restore();
  }
});

test('a photo upload carries the native identity whatever address it came from', async () => {
  // Driven through the action directly: a file input cannot be populated in
  // this DOM, and the addressing question is settled by what the submission
  // carries rather than by which form raised it.
  const calls: { path: string; method: string; body: unknown }[] = [];
  const restore = stubApi(calls);
  try {
    const form = new FormData();
    form.set('intent', 'photo');
    form.set('assetId', id);
    // Submitted from the Digital Link address, which must not be consulted.
    form.set('at', digitalLink);
    form.set('photo', new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }));
    await clientAction({
      request: new Request('http://127.0.0.1:3000' + digitalLink, { method: 'POST', body: form }),
    } as never);
    assert.equal(calls.find((call) => call.method === 'POST')?.path, `/api/assets/${id}/photos`);
  } finally {
    restore();
  }
});
