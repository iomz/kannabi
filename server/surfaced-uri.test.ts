import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalIdentifier } from './gs1.js';
import { newAssetId } from './asset-id.js';
import { assetPath } from '../shared/asset-uri.js';
import {
  preferredDigitalLinkIdentifier, servingAssetPaths, surfacedAssetPath, surfacedTransition,
} from './surfaced-uri.js';

const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '0614141123452' });
const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'A1B2' });
const grai = canonicalIdentifier({ scheme: 'grai', assetType: '0614141234561', serial: '789' });
const graiClass = canonicalIdentifier({ scheme: 'grai', assetType: '0614141234561' });
const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-001' });
const id = newAssetId();

test('an Asset with no identifier surfaces its native URI', () => {
  assert.equal(preferredDigitalLinkIdentifier([]), null);
  assert.equal(surfacedAssetPath(id, []), assetPath(id));
});

test('only an individual-level identifier may be surfaced for an Asset', () => {
  // A GTIN describes a trade item. An unserialised GRAI describes an asset
  // type. Neither denotes this Asset, whatever its scheme rank would be.
  for (const identifiers of [[gtin], [graiClass], [gtin, graiClass]]) {
    assert.equal(preferredDigitalLinkIdentifier(identifiers), null);
    assert.equal(surfacedAssetPath(id, identifiers), assetPath(id));
  }
  // A serialised GRAI is individual and is eligible.
  assert.equal(preferredDigitalLinkIdentifier([graiClass, grai])?.canonical, grai.canonical);
});

test('GIAI outranks a serialised GRAI, which outranks an SGTIN', () => {
  assert.equal(preferredDigitalLinkIdentifier([sgtin, grai, giai])?.scheme, 'giai');
  assert.equal(preferredDigitalLinkIdentifier([sgtin, grai])?.scheme, 'grai');
  assert.equal(preferredDigitalLinkIdentifier([sgtin])?.scheme, 'sgtin');
  // An SGTIN's path is rooted in the trade-item key; a GIAI's is not.
  assert.equal(surfacedAssetPath(id, [sgtin]), '/01/00614141123452/21/A1B2');
  assert.equal(surfacedAssetPath(id, [sgtin, giai]), '/8004/0614141ASSET-001');
});

test('selection does not depend on the order identifiers arrive in', () => {
  const orderings = [
    [gtin, sgtin, grai, giai], [giai, grai, sgtin, gtin],
    [grai, giai, gtin, sgtin], [sgtin, gtin, giai, grai],
  ];
  const surfaced = orderings.map((identifiers) => surfacedAssetPath(id, identifiers));
  assert.deepEqual(new Set(surfaced), new Set(['/8004/0614141ASSET-001']));
});

test('a tie within one scheme breaks deterministically on the canonical form', () => {
  const first = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141AAA' });
  const second = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141BBB' });
  assert.ok(first.canonical < second.canonical);
  assert.equal(preferredDigitalLinkIdentifier([first, second])?.canonical, first.canonical);
  assert.equal(preferredDigitalLinkIdentifier([second, first])?.canonical, first.canonical);
});

test('issuance provenance never decides what is surfaced', () => {
  // `allocatedGiai` builds what Kannabi issues; a recorded existing GIAI is
  // built the same way here on purpose, because nothing on an identifier
  // marks its origin and nothing about origin may reach this decision.
  const issued = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141999' });
  const recorded = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141111' });
  // The recorded value wins only because it sorts first, not because of
  // anything about who assigned it.
  assert.equal(preferredDigitalLinkIdentifier([issued, recorded])?.canonical, recorded.canonical);
  assert.ok(recorded.canonical < issued.canonical);
});

test('detaching the preferred identifier changes only what is surfaced', () => {
  const withGiai = [sgtin, giai];
  const withoutGiai = withGiai.filter((identifier) => identifier.scheme !== 'giai');
  assert.equal(surfacedAssetPath(id, withGiai), '/8004/0614141ASSET-001');
  assert.equal(surfacedAssetPath(id, withoutGiai), '/01/00614141123452/21/A1B2');
  assert.equal(surfacedAssetPath(id, []), assetPath(id));
  // The native address is unaffected throughout.
  assert.equal(assetPath(id), '/asset/' + id);
});

test('detaching the identifier the viewer is standing on moves them to what remains', () => {
  // The acceptance case: viewing at the GIAI Digital Link, GIAI detached.
  // That address no longer identifies the Asset, so staying would land on
  // the 404 it now correctly returns.
  const current = '/8004/0614141ASSET-001';
  assert.equal(surfacedTransition(current, id, [sgtin, giai]), null);
  assert.equal(surfacedTransition(current, id, [sgtin]), '/01/00614141123452/21/A1B2');
});

test('with no eligible GS1 identity left, the viewer returns to the native URI', () => {
  const current = '/8004/0614141ASSET-001';
  assert.equal(surfacedTransition(current, id, []), assetPath(id));
  // A class-level identifier is not somewhere a viewer can be sent.
  assert.equal(surfacedTransition(current, id, [gtin]), assetPath(id));
  assert.equal(surfacedTransition(current, id, [graiClass]), assetPath(id));
});

test('a valid non-preferred Digital Link is never navigated away from', () => {
  // The invariant: preference governs presentation. Attaching a GIAI while
  // viewing the SGTIN address must not move the viewer to the GIAI, or
  // navigation would do what resolution is forbidden to do by redirect.
  const sgtinPath = '/01/00614141123452/21/A1B2';
  assert.equal(surfacedTransition(sgtinPath, id, [sgtin]), null);
  assert.equal(surfacedTransition(sgtinPath, id, [sgtin, giai]), null);
  // And a serialised GRAI alongside, still not preferred, still not moved.
  assert.equal(surfacedTransition(sgtinPath, id, [sgtin, grai, giai]), null);
});

test('gaining a first Digital Link moves a viewer off the native URI', () => {
  // The server would redirect the native URI from here on, so leaving the
  // viewer on it would disagree with what a reload does.
  const native = assetPath(id);
  assert.equal(surfacedTransition(native, id, []), null);
  assert.equal(surfacedTransition(native, id, [giai]), '/8004/0614141ASSET-001');
  assert.equal(surfacedTransition(native, id, [sgtin]), '/01/00614141123452/21/A1B2');
  // A class-level identifier is not a Digital Link the native URI defers to.
  assert.equal(surfacedTransition(native, id, [gtin]), null);
});

test('issuing a GIAI moves a viewer only when their address stops serving', () => {
  const native = assetPath(id);
  const sgtinPath = '/01/00614141123452/21/A1B2';
  // Issued while on the native URI: the native URI now redirects, so move.
  assert.equal(surfacedTransition(native, id, [giai]), '/8004/0614141ASSET-001');
  // Issued while on the SGTIN address: it still serves, so stay.
  assert.equal(surfacedTransition(sgtinPath, id, [sgtin, giai]), null);
});

test('a transition never depends on which identifier Kannabi issued', () => {
  const recorded = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141111' });
  const current = '/8004/0614141ASSET-001';
  // Whichever GIAI remains is where the viewer goes; issuance says nothing.
  assert.equal(surfacedTransition(current, id, [recorded]), '/8004/0614141111');
});

test('the addresses that serve an Asset are exactly its individual Digital Links', () => {
  assert.deepEqual(servingAssetPaths(id, []), [assetPath(id)]);
  // A class-level identifier adds no address, so the native URI still serves.
  assert.deepEqual(servingAssetPaths(id, [gtin, graiClass]), [assetPath(id)]);
  // Once one exists the native URI is not in the list, because it redirects.
  assert.deepEqual(servingAssetPaths(id, [sgtin, giai]),
    ['/01/00614141123452/21/A1B2', '/8004/0614141ASSET-001']);
  assert.equal(servingAssetPaths(id, [sgtin, giai]).includes(assetPath(id)), false);
});
