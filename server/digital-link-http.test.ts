import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Auth } from './auth.js';
import type { IdentityStore } from './identity-store.js';
import { canonicalIdentifier, type ExternalIdentifier } from './gs1.js';
import { digitalLinkPath } from './gs1-digital-link.js';
import { newAssetId } from './asset-id.js';
import { digitalLinkDocuments } from './digital-link-routes.js';

/** The production HTTP boundary, over a real socket.
 *
 * The rest of the Digital Link tests call the middleware through Hono's
 * in-process `app.request`, which builds a `Request` directly and so proves
 * nothing about what Node, the node-server adapter and Hono's own path
 * extraction do to a percent-encoded path on the way in. A GS1 value may
 * legitimately contain `/` and `%`, and whether those survive that journey is
 * a property of the stack rather than of the parser, so it is asserted here
 * against a listening server reached with `fetch`.
 */

const documentPath = join(mkdtempSync(join(tmpdir(), 'kannabi-dl-http-')), 'index.html');
writeFileSync(documentPath, '<!doctype html><title>Kannabi</title>');

const assetId = newAssetId();

/** A store holding one Asset, readable by everyone or only by a signed-in
 * reader, matching how `lookupAssets` runs over the reader-visible set. */
function storeFor(identifiers: readonly ExternalIdentifier[], requiresReader: boolean) {
  const asset = { id: assetId, identifiers };
  const readable = (audience: unknown) =>
    !requiresReader || (audience as { kind?: string }).kind === 'user';
  return {
    async lookupAssets(audience: unknown, request: { identity: { identifier: { canonical: string } } }) {
      const held = identifiers.some((i) => i.canonical === request.identity.identifier.canonical);
      return { assets: held && readable(audience) ? [asset] : [] };
    },
    async getAsset(id: string, audience: unknown) {
      return id === assetId && readable(audience) ? asset : null;
    },
  } as unknown as IdentityStore;
}

function authFor(userKey: string | null) {
  return { api: { getSession: async () => (userKey ? { user: { key: userKey } } : null) } } as unknown as Auth;
}

/** The middleware in the position and company `server/index.ts` gives it. */
async function withServer(store: IdentityStore, auth: Auth,
  body: (request: (path: string) => Promise<Response>) => Promise<void>) {
  const app = new Hono();
  app.use('/assets/*', serveStatic({ root: './build/client' }));
  app.all('/assets/*', (c) => c.notFound());
  app.use('*', digitalLinkDocuments(store, auth, documentPath));
  app.get('*', (c) => c.text('rendered by the application'));
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await body((path) => fetch(origin + path, { redirect: 'manual' }));
  } finally {
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

/** Every awkward character a GS1 serial may legitimately carry. The first is
 * the exact value reported from acceptance. */
const serials = [
  'aB/c%D', 'a/b', '100%', 'x<y>z', 'who?', 'say"hi"', '%2F', '%25',
  'a+b', 'a&b=c', 'a;b,c:d', "it's(fine)*", 'MiXeD', '(21)notAnAi', 'a//b', '%%%',
];

test('a serial carrying slashes and percents resolves over a real socket', async () => {
  for (const serial of serials) {
    const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial });
    await withServer(storeFor([sgtin], false), authFor(null), async (request) => {
      const path = digitalLinkPath(sgtin);
      const response = await request(path);
      assert.equal(response.status, 200, `${JSON.stringify(serial)} at ${path}`);
      assert.match(await response.text(), /rendered by the application/, serial);
    });
  }
});

test('the exact address the UI emits for the reported Asset resolves', async () => {
  const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
  assert.equal(sgtin.canonical, '(01)00614141123452(21)aB/c%D');
  assert.equal(digitalLinkPath(sgtin), '/01/00614141123452/21/aB%2Fc%25D');
  await withServer(storeFor([sgtin], false), authFor(null), async (request) => {
    const response = await request('/01/00614141123452/21/aB%2Fc%25D');
    assert.equal(response.status, 200);
  });
});

test('a GIAI carrying the same characters resolves, and is reachable from the native URI', async () => {
  const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141A/B%C' });
  await withServer(storeFor([giai], false), authFor(null), async (request) => {
    assert.equal((await request(digitalLinkPath(giai))).status, 200);
    const native = await request('/asset/' + assetId);
    assert.equal(native.status, 307);
    const location = native.headers.get('location')!;
    assert.equal(location, '/8004/0614141A%2FB%25C');
    // Following the redirect over the wire must land on the Asset, which is
    // what proves the emitted Location is encoded for this stack.
    assert.equal((await request(location)).status, 200);
  });
});

test('percent-encoding is decoded exactly once across the wire', async () => {
  // The serial is a literal "%2F", so the path carries "%252F". A stack that
  // decoded twice would resolve this to the serial "/" instead.
  const literal = canonicalIdentifier({ scheme: 'giai', assetReference: '%2F' });
  const slash = canonicalIdentifier({ scheme: 'giai', assetReference: '/' });
  assert.equal(digitalLinkPath(literal), '/8004/%252F');
  assert.equal(digitalLinkPath(slash), '/8004/%2F');
  await withServer(storeFor([literal], false), authFor(null), async (request) => {
    assert.equal((await request('/8004/%252F')).status, 200);
    // The single-encoded form is a different identifier, which this Asset
    // does not carry, so it must not resolve.
    assert.equal((await request('/8004/%2F')).status, 404);
  });
  await withServer(storeFor([slash], false), authFor(null), async (request) => {
    assert.equal((await request('/8004/%2F')).status, 200);
    assert.equal((await request('/8004/%252F')).status, 404);
  });
});

test('the reported 404 is the readability rule, not the encoding', async () => {
  // This is what the acceptance report actually hit: a private Asset fetched
  // without a session. The address is correct and the encoding survives; the
  // reader is simply not entitled to the Asset, and a Digital Link naming an
  // Asset you may not see must answer as one naming nothing.
  const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
  const path = '/01/00614141123452/21/aB%2Fc%25D';
  await withServer(storeFor([sgtin], true), authFor(null), async (request) => {
    assert.equal((await request(path)).status, 404);
    // And the native URI does not redirect, for the same reason.
    assert.equal((await request('/asset/' + assetId)).status, 200);
  });
  await withServer(storeFor([sgtin], true), authFor('member'), async (request) => {
    assert.equal((await request(path)).status, 200);
    assert.equal((await request('/asset/' + assetId)).status, 307);
  });
});

test('status semantics hold over the wire', async () => {
  const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
  const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-001' });
  await withServer(storeFor([sgtin, giai], false), authFor(null), async (request) => {
    // A valid non-preferred Digital Link renders directly. The GIAI is
    // preferred, and the SGTIN address must not be canonicalized to it.
    const nonPreferred = await request('/01/00614141123452/21/aB%2Fc%25D');
    assert.equal(nonPreferred.status, 200);
    assert.equal(nonPreferred.headers.get('location'), null);
    // A retired or unknown but well-formed address stays 404.
    assert.equal((await request('/8004/0614141NOTHING')).status, 404);
    assert.equal((await request('/01/00614141123452/21/gone')).status, 404);
    // Malformed stays 400.
    for (const path of ['/01/abc', '/01/00614141123451', '/8004/%zz', '/01']) {
      assert.equal((await request(path)).status, 400, path);
    }
    // A key Kannabi does not model, and a class-level address.
    assert.equal((await request('/00/195201234567891232')).status, 404);
    assert.equal((await request('/01/00614141123452')).status, 404);
    // Ordinary application paths are untouched.
    assert.equal((await request('/lookup')).status, 200);
  });
});
