import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Auth } from './auth.js';
import type { IdentityStore } from './identity-store.js';
import { canonicalIdentifier } from './gs1.js';
import { newAssetId } from './asset-id.js';
import { digitalLinkDocuments } from './digital-link-routes.js';

const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-001' });
// A serial carrying both characters that must survive encoding.
const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
const assetId = newAssetId();

const marker = '<!doctype html><title>Kannabi</title>';
const documentPath = join(mkdtempSync(join(tmpdir(), 'kannabi-dl-')), 'index.html');
writeFileSync(documentPath, marker);

/** A store holding one Asset, readable only by `readerKey` (null: anyone). */
function storeFor(identifiers: readonly { canonical: string }[], readerKey: string | null) {
  const asset = { id: assetId, identifiers };
  const visible = (audience: unknown) => {
    const kind = (audience as { kind?: string }).kind;
    if (readerKey === null) return true;
    return kind === 'user' && (audience as { actorKey: string }).actorKey === readerKey;
  };
  return {
    async lookupAssets(audience: unknown, request: { identity: { identifier: { canonical: string } } }) {
      const match = identifiers.some((held) => held.canonical === request.identity.identifier.canonical);
      return { assets: match && visible(audience) ? [asset] : [] };
    },
    async getAsset(id: string, audience: unknown) {
      return id === assetId && visible(audience) ? asset : null;
    },
  } as unknown as IdentityStore;
}

/** A session for `userKey`, or no session at all. */
function authFor(userKey: string | null) {
  return { api: { getSession: async () => (userKey ? { user: { key: userKey } } : null) } } as unknown as Auth;
}

function appWith(store: IdentityStore, auth: Auth) {
  const app = new Hono();
  app.use('*', digitalLinkDocuments(store, auth, documentPath));
  app.get('*', (c) => c.html('<!doctype html><title>fell through</title>'));
  return app;
}

const anonymous = () => appWith(storeFor([giai, sgtin], null), authFor(null));

test('a resolvable Digital Link address falls through to the application with 200', async () => {
  const app = anonymous();
  for (const path of ['/8004/0614141ASSET-001', '/01/00614141123452/21/aB%2Fc%25D']) {
    const response = await app.request('http://kannabi.example' + path);
    assert.equal(response.status, 200, path);
    // Fell through to the ordinary handler rather than being answered here.
    assert.match(await response.text(), /fell through/, path);
  }
});

test('the raw path reaches the parser, so an encoded separator is not a separator', async () => {
  // Decoding before splitting would read this as /01/.../21/aB/c%D and fail.
  const response = await anonymous().request('http://kannabi.example/01/00614141123452/21/aB%2Fc%25D');
  assert.equal(response.status, 200);
});

test('a malformed address is 400 and an unknown one is 404, never 200', async () => {
  const app = anonymous();
  for (const [path, status] of [
    ['/01/abc', 400], ['/01/00614141123451', 400], ['/8004/%zz', 400], ['/01', 400],
    ['/8004/0614141NOTHING', 404], ['/00/195201234567891232', 404],
    ['/01/00614141123452/10/LOT1', 404], ['/01/00614141123452', 404],
  ] as const) {
    const response = await app.request('http://kannabi.example' + path);
    assert.equal(response.status, status, path);
    // The application document is served so the page can explain itself,
    // but the status is the truth of the response.
    assert.match(await response.text(), /Kannabi/, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
});

test('the native URI redirects to the surfaced Digital Link, temporarily and uncacheably', async () => {
  const response = await anonymous().request('http://kannabi.example/asset/' + assetId);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), '/8004/0614141ASSET-001');
  // The preferred identifier can be detached at any moment, so nothing may
  // remember this mapping.
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('following the redirect lands on a page, not another redirect', async () => {
  const app = anonymous();
  const first = await app.request('http://kannabi.example/asset/' + assetId);
  const second = await app.request('http://kannabi.example' + first.headers.get('location'));
  assert.equal(second.status, 200);
  assert.match(await second.text(), /fell through/);
});

test('an Asset with no eligible identity is served at its native URI', async () => {
  const app = appWith(storeFor([], null), authFor(null));
  const response = await app.request('http://kannabi.example/asset/' + assetId);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /fell through/);
});

test('an unreadable Asset answers exactly as an absent one, and never redirects', async () => {
  const guarded = appWith(storeFor([giai], 'owner'), authFor(null));
  const absent = appWith(storeFor([], null), authFor(null));

  const guardedLink = await guarded.request('http://kannabi.example/8004/0614141ASSET-001');
  const absentLink = await absent.request('http://kannabi.example/8004/0614141ASSET-001');
  assert.equal(guardedLink.status, 404);
  assert.equal(absentLink.status, guardedLink.status);

  // The native URI must not redirect either: doing so would disclose both
  // that the Asset exists and that it carries a GIAI.
  const guardedNative = await guarded.request('http://kannabi.example/asset/' + assetId);
  assert.equal(guardedNative.status, 200);
  assert.equal(guardedNative.headers.get('location'), null);
});

test('the reader who may see the Asset gets the resolution and the redirect', async () => {
  const app = appWith(storeFor([giai], 'owner'), authFor('owner'));
  assert.equal((await app.request('http://kannabi.example/8004/0614141ASSET-001')).status, 200);
  const native = await app.request('http://kannabi.example/asset/' + assetId);
  assert.equal(native.status, 307);
  assert.equal(native.headers.get('location'), '/8004/0614141ASSET-001');
});

test('ordinary application paths and non-GET requests are untouched', async () => {
  const app = anonymous();
  for (const path of ['/', '/lookup', '/settings/appearance', '/groups']) {
    const response = await app.request('http://kannabi.example' + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /fell through/, path);
  }
  // A method this middleware does not answer is left entirely alone.
  const posted = await app.request('http://kannabi.example/asset/' + assetId, { method: 'POST' });
  assert.notEqual(posted.status, 307);
});

test('a failing session check narrows to the anonymous audience rather than widening', async () => {
  const broken = { api: { getSession: async () => { throw new Error('session store down'); } } } as unknown as Auth;
  const app = appWith(storeFor([giai], 'owner'), broken);
  // Falls back to public, which can only see less.
  assert.equal((await app.request('http://kannabi.example/8004/0614141ASSET-001')).status, 404);
});

test('the client router and the server agree on where a segment ends', async () => {
  // The server reads the raw path, so resolution never depends on this. The
  // application still has to match the address to a route, and that match
  // must not treat an encoded separator inside a GIAI or serial as one. This
  // pins the behaviour so a router upgrade that changed it is a test failure.
  const { matchRoutes } = await import('react-router');
  const routes = [{ path: 'asset/:id' }, { path: '01/:gtin/21/:serial' },
    { path: '8003/:grai' }, { path: '8004/:giai' }];
  const matched = (path: string) => {
    const match = matchRoutes(routes, path)?.at(-1);
    return match ? { path: match.route.path, params: match.params } : null;
  };
  assert.deepEqual(matched('/8004/a%2Fb'), { path: '8004/:giai', params: { giai: 'a/b' } });
  assert.deepEqual(matched('/01/00614141123452/21/aB%2Fc%25D'),
    { path: '01/:gtin/21/:serial', params: { gtin: '00614141123452', serial: 'aB/c%D' } });
  // Decoded exactly once: a literal percent survives as a literal percent.
  assert.equal(matched('/8004/a%2525b')?.params.giai, 'a%25b');
  // A class-level address has no application route, so it reaches the
  // application's own unavailable page behind the server's 404.
  assert.equal(matched('/01/00614141123452'), null);
  assert.equal(matched('/00/195201234567891232'), null);
});

test('a detached Digital Link stays unresolvable even though the Asset moved elsewhere', async () => {
  // The Asset kept its SGTIN and lost its GIAI. Post-mutation navigation is
  // a client concern; resolution is unchanged, so the retired address is
  // simply unknown and is never quietly forwarded to the surviving one.
  const app = appWith(storeFor([sgtin], null), authFor(null));
  const retired = await app.request('http://kannabi.example/8004/0614141ASSET-001');
  assert.equal(retired.status, 404);
  assert.equal(retired.headers.get('location'), null);
  // The surviving address serves the Asset directly, as it always did.
  assert.equal((await app.request('http://kannabi.example/01/00614141123452/21/aB%2Fc%25D')).status, 200);
  // And the native URI surfaces it, now via the SGTIN.
  const native = await app.request('http://kannabi.example/asset/' + assetId);
  assert.equal(native.status, 307);
  assert.equal(native.headers.get('location'), '/01/00614141123452/21/aB%2Fc%25D');
});
