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

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Object storage that fails loudly. These reports carry no photo, so the
 * bytes path must never be reached; a stub proves that rather than assuming
 * it, and keeps the suite free of an S3 dependency it does not need. */
const unusedStorage: ObjectStorage = {
  put: () => { throw new Error('storage must not be touched'); },
  get: () => { throw new Error('storage must not be touched'); },
  delete: () => { throw new Error('storage must not be touched'); },
};

test('an Asset attributed to the record it came from', { skip: !uri || !password }, async (t) => {
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

  let peer = 0;
  async function person(name: string) {
    const address = `192.0.2.${++peer}`;
    const signup = await app.request(origin + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
      body: JSON.stringify({ name, email: `${name}-${randomUUID()}@example.com`, password: 'test-password-12345' }),
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
    const key = (await (await call('/me')).json()).user.key as string;
    return { key, name, call, cookie, address };
  }
  async function query(cypher: string, params = {}) {
    const s = driver.session();
    try { return await s.run(cypher, params); } finally { await s.close(); }
  }

  const alex = await person('alex');
  const group = await (await alex.call('/groups', 'POST', { name: 'Workshop ' + randomUUID() })).json();
  const groupKey = group.group.key as string;
  const report = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    alex.call('/assets', 'POST', { groupKey, ...body }, headers);

  const attribution = {
    reference: 'legacy:asset:1483',
    recordedAt: '2019-04-12T09:30:00.000Z',
    recordedBy: 'A. Rivera',
  };

  /** The stored value is an instant, not the string that named it: Neo4j
   * renders it the way it already renders `reportedAt`, eliding trailing
   * zeros. What must survive is the moment, so that is what is compared. */
  function assertQuotes(sourceRecord: { reference: string; recordedAt: string | null; recordedBy: string | null },
    expected: { reference: string; recordedAt?: string | null; recordedBy?: string | null }) {
    assert.equal(sourceRecord.reference, expected.reference);
    assert.equal(sourceRecord.recordedBy, expected.recordedBy ?? null);
    if (expected.recordedAt) {
      assert.equal(Date.parse(sourceRecord.recordedAt!), Date.parse(expected.recordedAt));
    } else {
      assert.equal(sourceRecord.recordedAt, null);
    }
  }

  await t.test('an Asset created without an attribution behaves exactly as before', async () => {
    const created = await report({ name: 'Ordinary bench' });
    assert.equal(created.status, 201);
    const { asset } = await created.json();
    assert.equal(asset.sourceRecord, null);
    assert.equal(asset.reportedBy.key, alex.key);
    const read = await (await alex.call(`/assets/${asset.id}`)).json();
    assert.equal(read.asset.sourceRecord, null);
  });

  await t.test('a full attribution is persisted and returned as the source’s own statement', async () => {
    const { asset } = await (await report({ name: 'Quoted bench', sourceRecord: attribution })).json();
    assertQuotes(asset.sourceRecord, attribution);
    // Read back through a separate request, so this is persistence and not an echo.
    const read = await (await alex.call(`/assets/${asset.id}`)).json();
    assertQuotes(read.asset.sourceRecord, attribution);
    // Sub-second precision the source stated is preserved, not rounded away.
    const precise = await (await report({ name: 'Precise bench',
      sourceRecord: { reference: 'legacy:asset:1484', recordedAt: '2019-04-12T09:30:00.123Z' } })).json();
    assert.equal(Date.parse(precise.asset.sourceRecord.recordedAt), Date.parse('2019-04-12T09:30:00.123Z'));
    // Stored flat, present together, exactly as the projection rebuilds them.
    const row = await query(`MATCH (a:Asset {id: $id})
      RETURN a.sourceReference AS reference, toString(a.sourceRecordedAt) AS recordedAt,
        a.sourceRecordedBy AS recordedBy`, { id: asset.id });
    assert.equal(row.records[0].get('reference'), attribution.reference);
    assert.equal(row.records[0].get('recordedBy'), attribution.recordedBy);
    assert.match(row.records[0].get('recordedAt'), /^2019-04-12T09:30/);
  });

  await t.test('reportedAt stays Kannabi chronology and is never backdated from the source', async () => {
    const before = Date.now();
    const { asset } = await (await report({ name: 'Chronology bench', sourceRecord: attribution })).json();
    const after = Date.now();
    const reportedAt = Date.parse(asset.reportedAt);
    assert.ok(reportedAt >= before - 1000 && reportedAt <= after + 1000,
      `reportedAt ${asset.reportedAt} must be when Kannabi recorded it, not ${attribution.recordedAt}`);
    assert.notEqual(asset.reportedAt, attribution.recordedAt);
    // The two live in different properties; neither is derived from the other.
    const row = await query('MATCH (a:Asset {id: $id}) RETURN toString(a.reportedAt) AS reportedAt', { id: asset.id });
    assert.ok(!/^2019/.test(row.records[0].get('reportedAt')));
  });

  await t.test('reportedBy stays the authenticated reporter, whatever the source said', async () => {
    const { asset } = await (await report({ name: 'Reporter bench', sourceRecord: attribution })).json();
    assert.equal(asset.reportedBy.key, alex.key);
    assert.equal(asset.reportedBy.name, 'alex');
    assert.equal(asset.reportedBy.status, 'active');
    assert.notEqual(asset.reportedBy.name, attribution.recordedBy);
  });

  await t.test('a quoted recorder is text: it resolves to nobody and grants nothing', async () => {
    const jordan = await person('jordan');
    // Name the other person exactly, in a Group they do not belong to.
    const { asset } = await (await report({
      name: 'Quoted name bench',
      sourceRecord: { reference: 'legacy:asset:77', recordedBy: 'jordan' },
    })).json();
    assert.equal(asset.sourceRecord.recordedBy, 'jordan');
    assert.equal((await jordan.call(`/assets/${asset.id}`)).status, 404,
      'appearing in quoted evidence must not grant read access');
    // Nothing links the Asset to that account, and no node was created for it.
    const edges = await query(`MATCH (a:Asset {id: $id})-[r]-(n)
      WHERE n.name = 'jordan' OR n.name = $quoted RETURN type(r) AS type`,
    { id: asset.id, quoted: 'jordan' });
    assert.equal(edges.records.length, 0, 'a quoted name is never a node or an edge');
  });

  await t.test('the reference anchors the attribution, and a bad one fails atomically', async () => {
    const names = ['Anchorless bench', 'Malformed anchor bench', 'Bad instant bench', 'Long label bench'];
    const rejected = [
      { name: names[0], sourceRecord: { recordedBy: 'A. Rivera' } },
      { name: names[1], sourceRecord: { reference: 'has space' } },
      { name: names[2], sourceRecord: { reference: 'legacy:a:1', recordedAt: 'whenever' } },
      { name: names[3], sourceRecord: { reference: 'legacy:a:1', recordedBy: 'x'.repeat(81) } },
    ];
    for (const body of rejected) {
      assert.equal((await report(body)).status, 400, body.name);
    }
    // Atomic: no half-made Asset survives a refused attribution.
    const survivors = await query('MATCH (a:Asset) WHERE a.name IN $names RETURN a.name AS name', { names });
    assert.deepEqual(survivors.records.map((r) => r.get('name')), []);
  });

  await t.test('the attribution cannot be changed, or added, after creation', async () => {
    const { asset } = await (await report({ name: 'Immutable bench', sourceRecord: attribution })).json();
    const plain = (await (await report({ name: 'Never attributed bench' })).json()).asset;
    for (const [id, body] of [
      [asset.id, { sourceRecord: { reference: 'legacy:asset:9999' } }],
      [asset.id, { name: 'Renamed', sourceRecord: { reference: 'legacy:asset:9999' } }],
      [plain.id, { sourceRecord: attribution }],
    ] as const) {
      assert.equal((await alex.call(`/assets/${id}`, 'PATCH', body)).status, 400,
        'no update route accepts an attribution');
    }
    // The original is untouched, and the Asset that never had one still has none.
    assertQuotes((await (await alex.call(`/assets/${asset.id}`)).json()).asset.sourceRecord, attribution);
    assert.equal((await (await alex.call(`/assets/${plain.id}`)).json()).asset.sourceRecord, null);
    // A rename that carries no attribution is an ordinary edit and still works.
    const renamed = await alex.call(`/assets/${asset.id}`, 'PATCH', { name: 'Immutable bench, renamed' });
    assert.equal(renamed.status, 200);
    assertQuotes((await renamed.json()).asset.sourceRecord, attribution);
  });

  await t.test('basis and the attribution may start equal and then diverge', async () => {
    const reference = 'legacy:asset:2048';
    const created = await report({ name: 'Divergence bench', sourceRecord: { reference, recordedAt: attribution.recordedAt } },
      { 'X-Kannabi-Basis': reference });
    const { asset } = await created.json();
    assert.equal(asset.sourceRecord.reference, reference);
    assert.equal(asset.provenance.basis, reference, 'at creation the same reference may be both');

    const edited = await alex.call(`/assets/${asset.id}`, 'PATCH', { name: 'Divergence bench, corrected' },
      { 'X-Kannabi-Basis': 'ticket:correction:8' });
    const after = (await edited.json()).asset;
    assert.equal(after.provenance.basis, 'ticket:correction:8', 'the latest change carries its own basis');
    assert.equal(after.sourceRecord.reference, reference, 'where the record came from does not move');
    assert.equal(Date.parse(after.sourceRecord.recordedAt), Date.parse(attribution.recordedAt));
    assert.equal(after.provenance.acceptedBy.key, alex.key);
  });

  await t.test('the multipart reporting path accepts the same attribution', async () => {
    const form = new FormData();
    form.append('report', JSON.stringify({ name: 'Multipart bench', groupKey, sourceRecord: attribution }));
    const response = await app.request(origin + '/api/reports', {
      method: 'POST',
      headers: { Cookie: alex.cookie, Origin: origin, 'x-kannabi-client-ip': alex.address },
      body: form,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const { asset } = await response.json();
    assertQuotes(asset.sourceRecord, attribution);
    assert.equal(asset.reportedBy.key, alex.key);
    assert.ok(!/^2019/.test(asset.reportedAt));

    // And refuses a malformed one on the same path, atomically.
    const bad = new FormData();
    bad.append('report', JSON.stringify({
      name: 'Multipart refused bench', groupKey, sourceRecord: { recordedBy: 'A. Rivera' } }));
    const refused = await app.request(origin + '/api/reports', {
      method: 'POST',
      headers: { Cookie: alex.cookie, Origin: origin, 'x-kannabi-client-ip': alex.address },
      body: bad,
    });
    assert.equal(refused.status, 400);
    const survivors = await query('MATCH (a:Asset {name: $name}) RETURN a.id AS id',
      { name: 'Multipart refused bench' });
    assert.equal(survivors.records.length, 0);
  });

  await t.test('an attribution is never a sort key, a filter, or cursor state', async () => {
    // The sortable and filterable sets are explicit, so an attribution cannot
    // become discovery state by being added to the Asset model.
    assert.equal((await alex.call('/assets?sort=sourceRecordedAt')).status, 400,
      'source time must not become a sort');
    const unfiltered = await (await alex.call('/assets')).json();
    const withParam = await (await alex.call('/assets?sourceReference=legacy:asset:1483')).json();
    assert.equal(withParam.matching, unfiltered.matching,
      'a source reference narrows nothing: it is not a filter, only an ignored parameter');
    // Browsing still works, still orders by Kannabi chronology, and still
    // returns the attribution as ordinary read-only content.
    const page = await alex.call('/assets?sort=reportedAt&dir=desc');
    assert.equal(page.status, 200);
    const { assets, nextCursor } = await page.json();
    assert.ok(assets.length > 0);
    assert.ok(assets.some((a: { sourceRecord: unknown }) => a.sourceRecord !== null),
      'the list representation carries it too, so one Asset shape stays one shape');
    if (nextCursor) assert.ok(!nextCursor.includes('source'), 'never cursor state');
  });
});
