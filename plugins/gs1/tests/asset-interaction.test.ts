import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAction } from '../../../web/routes/asset.js';
import { newAssetId } from '../../../server/asset-id.js';

const id = newAssetId();
const assetUrl = 'http://127.0.0.1:3000/asset/' + id;

/** What the Asset page puts in every submission: the native identity, and
 * the address the viewer is standing on. */
function identify(form: FormData, at = '/asset/' + id) {
  form.set('assetId', id);
  form.set('at', at);
  return form;
}



test('an identifier mutation leaves an address that no longer serves the Asset', async () => {
  const originalFetch = globalThis.fetch;
  const sgtin = { scheme: 'sgtin', level: 'individual', canonical: '(01)00614141123452(21)A1B2',
    components: { gtin: '00614141123452', serial: 'A1B2' } };
  const giai = { scheme: 'giai', level: 'individual', canonical: '(8004)0614141ASSET-001',
    components: { assetReference: '0614141ASSET-001' } };
  const giaiPath = '/8004/0614141ASSET-001';
  const sgtinPath = '/01/00614141123452/21/A1B2';

  /** Every mutation answers with the Asset as it stands afterwards. */
  // Mutation responses carry issuances as well as identifiers, because the
  // real endpoints do and the issuance branch reads them to name what it just
  // produced.
  const respondWith = (identifiers: unknown[], issuances: unknown[] = []) => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ asset: { id, identifiers }, issuances }),
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
    // Standing on the GIAI Digital Link and detaching that GIAI: the address
    // is now correctly unresolvable, so the viewer is moved to what remains.
    respondWith([sgtin]);
    const moved = await submit(giaiPath, detach());
    assert.ok(moved instanceof Response);
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get('location'), sgtinPath);

    // Nothing left to surface: back to the native Asset URI.
    respondWith([]);
    const home = await submit(giaiPath, detach());
    assert.ok(home instanceof Response);
    assert.equal(home.headers.get('location'), '/asset/' + id);

    // Standing on a valid non-preferred Digital Link while a preferred one
    // exists: that address still serves the Asset, so the viewer stays and
    // the action returns ordinary fetcher data. Navigating here would do by
    // navigation what resolution must never do by redirect.
    respondWith([sgtin, giai]);
    const stayed = await submit(sgtinPath, detach());
    assert.equal(stayed instanceof Response, false);
    assert.deepEqual(stayed, { kind: 'detach-identifier', saved: true, error: null, photoKey: null });

    // Attaching the first Digital Link while on the native URI moves the
    // viewer, because the server would redirect that URI from now on.
    const attach = new FormData();
    attach.set('intent', 'attach-identifier');
    attach.set('scheme', 'giai');
    attach.set('assetReference', '0614141ASSET-001');
    respondWith([giai]);
    const attached = await submit('/asset/' + id, attach);
    assert.ok(attached instanceof Response);
    assert.equal(attached.headers.get('location'), giaiPath);

    // Issuance is the same rule, not a special case.
    const allocate = new FormData();
    allocate.set('intent', 'add-identifier');
    allocate.set('plugin', 'gs1');
    allocate.set('scheme', 'giai');
    allocate.set('namespaceKey', 'ns');
    respondWith([sgtin, giai]);
    const issued = await submit('/asset/' + id, allocate);
    assert.ok(issued instanceof Response);
    assert.equal(issued.headers.get('location'), giaiPath);
    // Issued while already on an address that serves: stay.
    respondWith([sgtin, giai]);
    assert.equal((await submit(sgtinPath, allocate)) instanceof Response, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
