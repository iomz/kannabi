import assert from 'node:assert/strict';
import { connectPlugins } from './plugin.js';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Hono } from 'hono';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';
import { MediaService } from './media.js';
import { ApiTokenService } from './api-token.js';
import type { ObjectStorage } from './storage.js';
import { composition } from './test-fixture.js';

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

test('quoted descriptions and identifier provenance', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const session = driver.session();
  await session.run("MERGE (s:Settings {key: 'instance'}) SET s.requirePhoto = false, s.revision = 0");
  await session.close();
  const store = await IdentityStore.open(driver, composition);
  const plugins = connectPlugins(composition, store);
  await admitSignups(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const tokens = new ApiTokenService(auth, store);
  const media = new MediaService(store, unusedStorage);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, media, undefined, tokens, plugins));

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

  const read = async (id: string) => (await (await call(`/assets/${id}`)).json()).asset as {
    id: string; name: string; identifiers: Identifier[];
    sourceRecord: { reference: string; description: string | null } | null;
    provenance: { acceptedAt: string; basis: string | null } | null;
  };
  const byScheme = (identifiers: Identifier[], scheme: string) =>
    identifiers.filter((identifier) => identifier.scheme === scheme);

  // A class-level identifier, as a product code would be.
  const described = { scheme: 'model', series: 'camera' };

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
      identifiers: [described], sourceRecord: { reference: 'depot:assets:5' } }, 'depot:assets:5');
    assert.equal(response.status, 201);
    const { asset } = await response.json();
    const [model] = byScheme(asset.identifiers, 'model');
    assert.ok(model.attachment);
    assert.equal(model.attachment.acceptedBy.key, alex.key, 'the authenticated actor, from no input');
    assert.deepEqual(model.attachment.assertedBy, { id: token.id, label: token.label });
    assert.equal(model.attachment.basis, 'depot:assets:5');
    // One statement, one statement clock: the association and the Asset's
    // latest change carry the same instant.
    const row = await query(`MATCH (a:Asset {id: $id})-[r:CLASSIFIED_AS]->()
      RETURN r.acceptedAt = a.changeAcceptedAt AS same, r.policyVersion AS policy`, { id: asset.id });
    assert.equal(row.records[0].get('same'), true);
    assert.equal(row.records[0].get('policy'), model.policyVersion);

    // A second identifier, attached later on its own basis, keeps it; the
    // first keeps its own through the later change and a rename.
    const tagged = await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'tag', code: 'T-5' }, 'review:batch-1:5');
    assert.equal(tagged.status, 201, await tagged.clone().text());
    assert.equal((await call(`/assets/${asset.id}`, 'PATCH', { name: 'Coherent camera, renamed' })).status, 200);
    const after = await read(asset.id);
    assert.equal(byScheme(after.identifiers, 'model')[0].attachment!.basis, 'depot:assets:5');
    assert.equal(byScheme(after.identifiers, 'model')[0].attachment!.acceptedAt, model.attachment.acceptedAt);
    const tagAttachment = byScheme(after.identifiers, 'tag')[0].attachment!;
    assert.equal(tagAttachment.basis, 'review:batch-1:5');
    assert.notEqual(tagAttachment.acceptedAt, model.attachment.acceptedAt);
    assert.equal(after.provenance!.basis, null, 'the rename is the latest change, with no basis');

    // A browser session asserts through no credential.
    const plain = await call(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'tag', code: 'T-6' });
    assert.equal(plain.status, 201);
    const sessionAttachment = byScheme((await plain.json()).asset.identifiers, 'tag')
      .find((identifier: Identifier) => identifier.canonical === 'tag:T-6')!.attachment!;
    assert.equal(sessionAttachment.assertedBy, null);

    // A basis is only ever the header; the body cannot carry one.
    assert.equal((await loader(`/assets/${asset.id}/identifiers`, 'POST',
      { scheme: 'tag', code: 'T-7', basis: 'forged' })).status, 400);
  });

  await t.test('detaching removes the association and its provenance', async () => {
    const { asset } = await (await call('/assets', 'POST', { groupKey, name: 'Tagged bench' })).json();
    const attached = await loader(`/assets/${asset.id}/identifiers`, 'POST', { scheme: 'tag', code: 'T-8' }, 'research:arm-b');
    assert.equal(attached.status, 201, await attached.clone().text());
    const [tag] = byScheme((await attached.json()).asset.identifiers, 'tag');
    assert.equal(tag.attachment!.basis, 'research:arm-b');
    assert.deepEqual(tag.attachment!.assertedBy, { id: token.id, label: token.label });
    const detached = await loader(`/assets/${asset.id}/identifiers/${tag.key}`, 'DELETE', undefined, 'review:detach:1');
    assert.equal(detached.status, 200);
    const left = await query(`MATCH (a:Asset {id: $id})-[r:IDENTIFIED_BY]->() RETURN count(r) AS n`, { id: asset.id });
    assert.equal(left.records[0].get('n').toNumber(), 0);
    assert.equal((await read(asset.id)).provenance!.basis, 'review:detach:1', 'Tier-1 records the detach');
  });

  await t.test('an association recorded before Kannabi kept this projects null, never "nobody"', async () => {
    const { asset } = await (await loader('/assets', 'POST', { groupKey, name: 'Old association',
      identifiers: [described] })).json();
    await query(`MATCH (:Asset {id: $id})-[r:CLASSIFIED_AS]->()
      REMOVE r.acceptedBy, r.acceptedAt, r.assertedById, r.assertedByLabel, r.basis, r.policyVersion`,
    { id: asset.id });
    const [model] = byScheme((await read(asset.id)).identifiers, 'model');
    assert.equal(model.attachment, null);
    assert.ok(model.policyVersion, 'the node keeps its policy stamp');
  });

  await t.test('two Assets attaching one new class identifier at once share one node with two associations', async () => {
    const a = (await (await call('/assets', 'POST', { groupKey, name: 'Twin A' })).json()).asset;
    const b = (await (await call('/assets', 'POST', { groupKey, name: 'Twin B' })).json()).asset;
    const shared = { scheme: 'model', series: 'twin' };
    const responses = await Promise.all([a, b].map((asset, n) =>
      loader(`/assets/${asset.id}/identifiers`, 'POST', shared, `depot:assetcats:${n}`)));
    assert.deepEqual(responses.map((response) => response.status), [201, 201]);
    const row = await query(`MATCH (c:ClassIdentifier {canonical: 'model:twin'})<-[r:CLASSIFIED_AS]-(a)
      RETURN count(DISTINCT c) AS nodes, collect(r.basis) AS bases`);
    assert.equal(row.records[0].get('nodes').toNumber(), 1);
    assert.deepEqual([...row.records[0].get('bases')].sort(), ['depot:assetcats:0', 'depot:assetcats:1']);
  });
});
