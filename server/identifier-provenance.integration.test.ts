import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Hono } from 'hono';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { MediaService } from './media.js';
import { ApiTokenService } from './api-token.js';
import type { ObjectStorage } from './storage.js';

/** Quoted source descriptions, the provenance of each Asset–identifier
 * association, the instance's GTIN consistency policy, and free-text search
 * over the quoted description, against a real Neo4j through the HTTP API. */

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

const unusedStorage: ObjectStorage = {
  put: () => { throw new Error('storage must not be touched'); },
  get: () => { throw new Error('storage must not be touched'); },
  delete: () => { throw new Error('storage must not be touched'); },
};

type Attachment = {
  acceptedBy: { key: string; name: string; status: string };
  acceptedAt: string;
  assertedBy: { id: string; label: string } | null;
  basis: string | null;
};
type Identifier = { key: string; scheme: string; canonical: string; policyVersion: string; attachment: Attachment | null };

test('quoted descriptions, identifier provenance and GTIN consistency', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const session = driver.session();
  await session.run("MERGE (s:Settings {key: 'instance'}) SET s.requirePhoto = false, s.revision = 0");
  await session.close();
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const tokens = new ApiTokenService(auth, store);
  const media = new MediaService(store, unusedStorage);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, media, undefined, tokens));

  async function query(cypher: string, params = {}) {
    const s = driver.session();
    try { return await s.run(cypher, params); } finally { await s.close(); }
  }

  const address = '192.0.2.10';
  const signup = await app.request(origin + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
    body: JSON.stringify({ name: 'alex', email: `alex-${randomUUID()}@example.com`, password: 'test-password-12345' }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    app.request(origin + '/api' + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json',
        'x-kannabi-client-ip': address, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const alex = (await (await call('/me')).json()).user as { key: string; name: string };
  await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: alex.key });
  const groupKey = (await (await call('/groups', 'POST', { name: 'Depot ' + randomUUID() })).json()).group.key as string;

  // A machine caller, as a migration loader would be: a bearer credential.
  const created = await call('/api-tokens', 'POST', { label: 'Depot loader', lifetimeDays: null });
  assert.equal(created.status, 201);
  const { secret, token } = await created.json() as { secret: string; token: { id: string; label: string } };
  const loader = (path: string, method = 'GET', body?: unknown, basis?: string) =>
    app.request(origin + '/api' + path, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json',
        ...(basis ? { 'X-Kannabi-Basis': basis } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function setEnforcement(enforceGtinConsistency: boolean) {
    const response = await call('/settings', 'PATCH', { requirePhoto: false, displayTimezone: 'UTC',
      themeId: 'default', enforceGtinConsistency });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).settings.enforceGtinConsistency, enforceGtinConsistency);
  }
  const read = async (id: string) => (await (await call(`/assets/${id}`)).json()).asset as {
    id: string; name: string; identifiers: Identifier[];
    sourceRecord: { reference: string; description: string | null } | null;
    provenance: { acceptedAt: string; basis: string | null } | null;
  };
  const byScheme = (identifiers: Identifier[], scheme: string) =>
    identifiers.filter((identifier) => identifier.scheme === scheme);

  // A product GTIN and a lab number in SGTIN syntax whose GTIN names no
  // trade item: the combination a legacy depot recorded on most of its Assets.
  const productGtin = { scheme: 'gtin', gtin: '4901234567894' };
  const labSgtin = (serial: string) => ({ scheme: 'sgtin', gtin: '04589604681007', serial });

  await t.test('a quoted description round-trips exactly and is never Kannabi\'s to edit', async () => {
    const description = ' Bench camera\r\nS/N\t0042\nfunding <code>  ';
    const response = await loader('/assets', 'POST', { groupKey, name: 'Camera A',
      sourceRecord: { reference: 'https://items.example.test/0104589604681007211', description } },
    'depot:assets:1');
    assert.equal(response.status, 201, await response.clone().text());
    const { asset } = await response.json();
    assert.equal(asset.sourceRecord.description, description);
    assert.equal((await read(asset.id)).sourceRecord!.description, description, 'persisted, not echoed');
    const stored = await query('MATCH (a:Asset {id: $id}) RETURN a.sourceDescription AS d', { id: asset.id });
    assert.equal(stored.records[0].get('d'), description);
    assert.equal((await call(`/assets/${asset.id}`, 'PATCH', {
      sourceRecord: { reference: 'r', description: 'edited' } })).status, 400, 'no update route accepts it');
    assert.equal((await read(asset.id)).sourceRecord!.description, description);
  });

  await t.test('no description recorded is null; a description Kannabi refuses refuses the report', async () => {
    const blank = await (await loader('/assets', 'POST', { groupKey, name: 'Blank description',
      sourceRecord: { reference: 'depot:assets:2', description: '   ' } })).json();
    assert.equal(blank.asset.sourceRecord.description, null);
    for (const description of ['odd\u0012byte', 'Café', 'x'.repeat(4097)]) {
      const name = 'Refused ' + randomUUID();
      const response = await loader('/assets', 'POST', { groupKey, name,
        sourceRecord: { reference: 'depot:assets:3', description } });
      assert.equal(response.status, 400, JSON.stringify(description));
      const survivors = await query('MATCH (a:Asset {name: $name}) RETURN count(a) AS n', { name });
      assert.equal(survivors.records[0].get('n').toNumber(), 0, 'nothing half-made survives');
    }
  });

  await t.test('search matches the quoted description and says which field matched', async () => {
    const quoted = await (await loader('/assets', 'POST', { groupKey, name: 'Grey box',
      sourceRecord: { reference: 'depot:assets:4', description: 'Spectrum analyser, Funding XQ-77' } })).json();
    const named = await (await loader('/assets', 'POST', { groupKey, name: 'xq-77 shelf label' })).json();
    const page = await (await call('/assets?q=XQ-77')).json() as {
      assets: { id: string }[]; matchedFields: Record<string, string[]>; matching: number };
    const ids = page.assets.map((asset) => asset.id);
    assert.ok(ids.includes(quoted.asset.id), 'found through the quoted description');
    assert.ok(ids.includes(named.asset.id), 'and through the name, case-insensitively');
    assert.deepEqual(page.matchedFields[quoted.asset.id], ['sourceDescription']);
    assert.deepEqual(page.matchedFields[named.asset.id], ['name']);
    assert.equal(page.matching, 2);
    const browse = await (await call('/assets')).json() as { matchedFields: Record<string, string[]> };
    assert.ok(Object.values(browse.matchedFields).every((fields) => fields.length === 0),
      'no query text matched no field');
  });

  await t.test('each association records who accepted it, when and on what basis', async () => {
    const response = await loader('/assets', 'POST', { groupKey, name: 'Coherent camera',
      identifiers: [productGtin], sourceRecord: { reference: 'depot:assets:5' } }, 'depot:assets:5');
    assert.equal(response.status, 201);
    const { asset } = await response.json();
    const [gtin] = byScheme(asset.identifiers, 'gtin');
    assert.ok(gtin.attachment);
    assert.equal(gtin.attachment.acceptedBy.key, alex.key, 'the authenticated actor, from no input');
    assert.deepEqual(gtin.attachment.assertedBy, { id: token.id, label: token.label });
    assert.equal(gtin.attachment.basis, 'depot:assets:5');
    // One statement, one statement clock: the association and the Asset's
    // latest change carry the same instant.
    const row = await query(`MATCH (a:Asset {id: $id})-[r:CLASSIFIED_AS]->()
      RETURN r.acceptedAt = a.changeAcceptedAt AS same, r.policyVersion AS policy`, { id: asset.id });
    assert.equal(row.records[0].get('same'), true);
    assert.equal(row.records[0].get('policy'), gtin.policyVersion);

    // A second identifier, attached later on its own basis, keeps it; the
    // first keeps its own through the later change and a rename.
    const giai = await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'giai', assetReference: '4589604681CAM-5' }, 'review:batch-1:5');
    assert.equal(giai.status, 201, await giai.clone().text());
    assert.equal((await call(`/assets/${asset.id}`, 'PATCH', { name: 'Coherent camera, renamed' })).status, 200);
    const after = await read(asset.id);
    assert.equal(byScheme(after.identifiers, 'gtin')[0].attachment!.basis, 'depot:assets:5');
    assert.equal(byScheme(after.identifiers, 'gtin')[0].attachment!.acceptedAt, gtin.attachment.acceptedAt);
    const giaiAttachment = byScheme(after.identifiers, 'giai')[0].attachment!;
    assert.equal(giaiAttachment.basis, 'review:batch-1:5');
    assert.notEqual(giaiAttachment.acceptedAt, gtin.attachment.acceptedAt);
    assert.equal(after.provenance!.basis, null, 'the rename is the latest change, with no basis');

    // A browser session asserts through no credential.
    const plain = await call(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'giai', assetReference: '4589604681CAM-6' });
    assert.equal(plain.status, 201);
    const sessionAttachment = byScheme((await plain.json()).asset.identifiers, 'giai')
      .find((identifier: Identifier) => identifier.canonical.endsWith('CAM-6'))!.attachment!;
    assert.equal(sessionAttachment.assertedBy, null);

    // A basis is only ever the header; the body cannot carry one.
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'giai', assetReference: '4589604681CAM-7', basis: 'forged' })).status, 400);
  });

  await t.test('an issued key gets the same provenance; detaching removes association and provenance', async () => {
    const { asset } = await (await call('/assets', 'POST', { groupKey, name: 'Issued bench' })).json();
    const namespace = await store.configureGs1Namespace(alex.key, groupKey, { gcp: '0614141' });
    const issued = await loader(`/assets/${asset.id}/giai`, 'POST', { namespaceKey: namespace.key }, 'research:arm-b');
    assert.equal(issued.status, 200, await issued.clone().text());
    const [giai] = byScheme((await issued.json()).asset.identifiers, 'giai');
    assert.equal(giai.attachment!.basis, 'research:arm-b');
    assert.deepEqual(giai.attachment!.assertedBy, { id: token.id, label: token.label });
    const detached = await loader(`/assets/${asset.id}/identifiers/${giai.key}`, 'DELETE', undefined, 'review:detach:1');
    assert.equal(detached.status, 200);
    const left = await query(`MATCH (a:Asset {id: $id})-[r:IDENTIFIED_BY]->() RETURN count(r) AS n`, { id: asset.id });
    assert.equal(left.records[0].get('n').toNumber(), 0);
    assert.equal((await read(asset.id)).provenance!.basis, 'review:detach:1', 'Tier-1 records the detach');
  });

  await t.test('an association recorded before Kannabi kept this projects null, never "nobody"', async () => {
    const { asset } = await (await loader('/assets', 'POST', { groupKey, name: 'Old association',
      identifiers: [productGtin] })).json();
    await query(`MATCH (:Asset {id: $id})-[r:CLASSIFIED_AS]->()
      REMOVE r.acceptedBy, r.acceptedAt, r.assertedById, r.assertedByLabel, r.basis, r.policyVersion`,
    { id: asset.id });
    const [gtin] = byScheme((await read(asset.id)).identifiers, 'gtin');
    assert.equal(gtin.attachment, null);
    assert.ok(gtin.policyVersion, 'the node keeps its policy stamp');
  });

  await t.test('two Assets attaching one new GTIN at once share one node with two associations', async () => {
    const a = (await (await call('/assets', 'POST', { groupKey, name: 'Twin A' })).json()).asset;
    const b = (await (await call('/assets', 'POST', { groupKey, name: 'Twin B' })).json()).asset;
    const shared = { scheme: 'gtin', gtin: '4512345678906' };
    const responses = await Promise.all([a, b].map((asset, n) =>
      loader(`/assets/${asset.id}/identifiers`, 'POST', shared, `depot:assetcats:${n}`)));
    assert.deepEqual(responses.map((response) => response.status), [201, 201]);
    const row = await query(`MATCH (c:ClassIdentifier {canonical: '(01)04512345678906'})<-[r:CLASSIFIED_AS]-(a)
      RETURN count(DISTINCT c) AS nodes, collect(r.basis) AS bases`);
    assert.equal(row.records[0].get('nodes').toNumber(), 1);
    assert.deepEqual([...row.records[0].get('bases')].sort(), ['depot:assetcats:0', 'depot:assetcats:1']);
  });

  await t.test('GTIN consistency is enforced by default and is an instance policy', async () => {
    assert.equal((await (await call('/settings')).json()).settings.enforceGtinConsistency, true);
    const refused = await loader('/assets', 'POST', { groupKey, name: 'Conflict refused',
      identifiers: [productGtin, labSgtin('900')] });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /conflicting GTINs/);

    await setEnforcement(false);
    // Off: the conflicting pair is recorded, through either path, each with its
    // own basis, and both stay visible.
    const reported = await loader('/assets', 'POST', { groupKey, name: 'Conflict recorded',
      identifiers: [labSgtin('901')] }, 'depot:assets:901');
    assert.equal(reported.status, 201);
    const { asset } = await reported.json();
    const attached = await loader(`/assets/${asset.id}/identifiers`, 'POST', productGtin, 'depot:assetcats:901');
    assert.equal(attached.status, 201, await attached.clone().text());
    const together = await loader('/assets', 'POST', { groupKey, name: 'Conflict in one report',
      identifiers: [productGtin, labSgtin('902')] });
    assert.equal(together.status, 201);
    const conflicted = await read(asset.id);
    assert.deepEqual(conflicted.identifiers.map((identifier) => [identifier.scheme, identifier.attachment!.basis]).sort(),
      [['gtin', 'depot:assetcats:901'], ['sgtin', 'depot:assets:901']]);
    // Everything else still applies with the policy off.
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST', productGtin)).status, 400,
      'the same identifier twice');
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'gtin', gtin: '4901234567890' })).status, 400, 'a bad check digit');
    const elsewhere = (await (await call('/assets', 'POST', { groupKey, name: 'Uniqueness' })).json()).asset;
    assert.equal((await loader(`/assets/${elsewhere.id}/identifiers`, 'POST', labSgtin('901'))).status, 409,
      'an individual identifier still identifies one Asset');

    // Back on: nothing recorded is removed or rewritten; new conflicts are
    // refused; an identifier that adds no AI 01 is still accepted.
    await setEnforcement(true);
    const kept = await read(asset.id);
    assert.deepEqual(kept.identifiers.map((identifier) => identifier.canonical).sort(),
      conflicted.identifiers.map((identifier) => identifier.canonical).sort());
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'gtin', gtin: '4512345678906' })).status, 400, 'a further conflicting GTIN');
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'giai', assetReference: '4589604681CONFLICT-1' }, 'review:2')).status, 201,
    'unrelated to AI 01');
    assert.equal((await loader('/assets', 'POST', { groupKey, name: 'Conflict refused again',
      identifiers: [productGtin, labSgtin('903')] })).status, 400);
  });
});
