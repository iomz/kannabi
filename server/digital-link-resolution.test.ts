import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalIdentifier } from './gs1.js';
import { newAssetId } from './asset-id.js';
import { assetPath } from '../shared/asset-uri.js';
import { publicAudience, userAudience, type AssetAudience } from './asset-audience.js';
import {
  resolveDigitalLinkAddress, resolveNativeAddress,
  type AssetResolver, type ResolvableAsset,
} from './digital-link-resolution.js';

const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-001' });
const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '0614141123452' });
const grai = canonicalIdentifier({ scheme: 'grai', assetType: '0614141234561', serial: '789' });

const owner = userAudience('owner-key');

/** An Asset readable only by `readableBy`, so "unknown" and "not yours" can be
 * told apart in the test even though Kannabi must not tell them apart. */
function resolverFor(asset: ResolvableAsset, readableBy: AssetAudience): AssetResolver {
  const visible = (audience: AssetAudience) =>
    audience.kind === readableBy.kind
    && (audience.kind !== 'user' || audience.actorKey === (readableBy as { actorKey: string }).actorKey);
  return {
    async assetForIdentifier(audience, identifier) {
      if (!visible(audience)) return null;
      return asset.identifiers.some((held) => held.canonical === identifier.canonical) ? asset : null;
    },
    async assetById(audience, id) {
      if (!visible(audience)) return null;
      return id === asset.id ? asset : null;
    },
  };
}

const emptyResolver: AssetResolver = {
  assetForIdentifier: async () => null,
  assetById: async () => null,
};

test('a supported Digital Link address that resolves is rendered, never redirected', async () => {
  const asset = { id: newAssetId(), identifiers: [sgtin, giai] };
  const resolver = resolverFor(asset, publicAudience);
  // The preferred identifier is the GIAI, and the SGTIN address must still
  // render rather than being normalised towards it.
  for (const path of ['/8004/0614141ASSET-001', '/01/00614141123452/21/aB%2Fc%25D']) {
    const resolution = await resolveDigitalLinkAddress(resolver, publicAudience, path);
    assert.deepEqual(resolution, { kind: 'render' }, path);
  }
});

test('a Digital Link naming an unreadable Asset is indistinguishable from one naming nothing', async () => {
  const asset = { id: newAssetId(), identifiers: [giai] };
  const readable = resolverFor(asset, owner);
  const held = await resolveDigitalLinkAddress(readable, publicAudience, '/8004/0614141ASSET-001');
  const absent = await resolveDigitalLinkAddress(emptyResolver, publicAudience, '/8004/0614141ASSET-001');
  // A GTIN and serial are printed on the object, so these two answers must be
  // the same byte for byte or a label would announce that the Asset exists.
  assert.deepEqual(held, absent);
  assert.deepEqual(held, { kind: 'notFound' });
  // The same address resolves for the reader who may see it.
  assert.deepEqual(await resolveDigitalLinkAddress(readable, owner, '/8004/0614141ASSET-001'),
    { kind: 'render' });
});

test('a class-level Digital Link does not resolve to an Asset', async () => {
  const asset = { id: newAssetId(), identifiers: [gtin, giai] };
  const resolver = resolverFor(asset, publicAudience);
  // The Asset genuinely carries this GTIN; a GTIN still does not denote it.
  assert.deepEqual(await resolveDigitalLinkAddress(resolver, publicAudience, '/01/00614141123452'),
    { kind: 'notFound' });
  // An unserialised GRAI is class-level for the same reason.
  assert.deepEqual(await resolveDigitalLinkAddress(resolver, publicAudience, '/8003/00614141234561'),
    { kind: 'notFound' });
});

test('a primary key Kannabi does not model is not found, and a malformed one is invalid', async () => {
  assert.deepEqual(await resolveDigitalLinkAddress(emptyResolver, publicAudience, '/00/195201234567891232'),
    { kind: 'notFound' });
  assert.deepEqual(await resolveDigitalLinkAddress(emptyResolver, publicAudience, '/01/00614141123452/10/LOT1'),
    { kind: 'notFound' });
  for (const path of ['/01/abc', '/01/00614141123451', '/8003/10614141234561789', '/8004/%zz', '/01']) {
    const resolution = await resolveDigitalLinkAddress(emptyResolver, publicAudience, path);
    assert.equal(resolution?.kind, 'invalid', path);
  }
});

test('a path outside the Digital Link space is left to ordinary routing', async () => {
  for (const path of ['/', '/lookup', '/asset/' + newAssetId(), '/settings/appearance']) {
    assert.equal(await resolveDigitalLinkAddress(emptyResolver, publicAudience, path), null, path);
  }
});

test('the native URI redirects to the surfaced Digital Link when one exists', async () => {
  const asset = { id: newAssetId(), identifiers: [sgtin, giai] };
  const resolver = resolverFor(asset, publicAudience);
  assert.deepEqual(await resolveNativeAddress(resolver, publicAudience, asset.id),
    { kind: 'redirect', location: '/8004/0614141ASSET-001' });
});

test('the native URI renders when the Asset has no eligible Digital Link', async () => {
  for (const identifiers of [[], [gtin]]) {
    const asset = { id: newAssetId(), identifiers };
    const resolver = resolverFor(asset, publicAudience);
    assert.deepEqual(await resolveNativeAddress(resolver, publicAudience, asset.id), { kind: 'render' });
  }
});

test('the native URI never redirects for an Asset the reader cannot see', async () => {
  const asset = { id: newAssetId(), identifiers: [giai] };
  const resolver = resolverFor(asset, owner);
  // Redirecting would announce both that the Asset exists and that it carries
  // a GIAI, to someone not entitled to know either.
  assert.deepEqual(await resolveNativeAddress(resolver, publicAudience, asset.id), { kind: 'render' });
  assert.deepEqual(await resolveNativeAddress(emptyResolver, publicAudience, asset.id), { kind: 'render' });
  // A malformed id is left to the application's own unavailable page.
  assert.deepEqual(await resolveNativeAddress(resolver, owner, 'not-a-uuid'), { kind: 'render' });
});

test('every redirect target is a render-only address, so a loop is impossible', async () => {
  // The structural invariant: only the native URI surfaces, and the only
  // thing it surfaces to is a Digital Link address, which always renders.
  for (const identifiers of [[giai], [sgtin], [grai], [sgtin, giai], [gtin, grai, sgtin, giai]]) {
    const asset = { id: newAssetId(), identifiers };
    const resolver = resolverFor(asset, publicAudience);
    const first = await resolveNativeAddress(resolver, publicAudience, asset.id);
    assert.equal(first.kind, 'redirect', JSON.stringify(identifiers.map((i) => i.scheme)));
    assert.ok(first.kind === 'redirect');
    assert.notEqual(first.location, assetPath(asset.id));
    const second = await resolveDigitalLinkAddress(resolver, publicAudience, first.location);
    assert.deepEqual(second, { kind: 'render' }, first.location);
  }
});

test('a redirect location is percent-encoded so following it resolves the same Asset', async () => {
  const asset = { id: newAssetId(), identifiers: [sgtin] };
  const resolver = resolverFor(asset, publicAudience);
  const resolution = await resolveNativeAddress(resolver, publicAudience, asset.id);
  assert.ok(resolution.kind === 'redirect');
  assert.equal(resolution.location, '/01/00614141123452/21/aB%2Fc%25D');
  // The raw separator count proves the serial's slash did not become one.
  assert.equal(resolution.location.split('/').length, 5);
  assert.deepEqual(await resolveDigitalLinkAddress(resolver, publicAudience, resolution.location),
    { kind: 'render' });
});
