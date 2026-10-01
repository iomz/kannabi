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
import { storageFromEnv } from './storage.js';
import { checkDigit } from './gs1-syntax.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** A synthetic corpus, loaded the way any client would have to load one.
 *
 * Whether Kannabi can receive records that already existed somewhere else was
 * previously a matter of reading the route list and believing it. This drives
 * the whole load over HTTP, with an API token and nothing else: no store call,
 * no Cypher, no in-process helper, no import-only endpoint. If this test ever
 * needs one of those, the public API is insufficient and that is the finding.
 *
 * The fixtures are invented and demonstrate shapes rather than any deployment's
 * corpus: an identifier the prior system assigned, a value the GS1 boundary
 * refuses, an Asset carrying nothing, an Asset two Groups reach, and a class
 * key whose early serials were spent before Kannabi existed. Counts here are
 * properties of this scenario, never claims about anybody's data.
 */

/** The prefix the operator manages. Outside Restricted Circulation space, and
 * short enough to leave a class reference. */
const gcp = '9520123';
const digits = (itemReference: string) => {
  const body = gcp + itemReference;
  return body + checkDigit(body);
};
/** The trade item the prior system was already serialising. */
const managedGtin = digits('00001');
/** A returnable-asset series it also used. */
const managedAssetType = digits('00003');
/** Serials spent before Kannabi: configuration, not a ledger Kannabi forged. */
const consumedSerials = { from: 1, to: 50 } as const;
/** Two of those spent serials, as the prior system recorded them. */
const priorSerials = ['7', '23'] as const;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxoAAAAASUVORK5CYII=',
  'base64');

test('an existing Asset corpus loads over the public HTTP API',
  { skip: !uri || !password || !process.env.S3_ENDPOINT }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    // Nothing is seeded by hand: opening the store is what a deployment does,
    // and it leaves the instance ready for a client to use.
    const store = await IdentityStore.open(driver);
    const storage = storageFromEnv();
    await storage.check();
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin,
      new MediaService(store, storage), undefined, new ApiTokenService(auth, store)));

    /** A person, reached only through the public sign-up and session routes. */
    let peer = 0;
    async function person(name: string) {
      const address = `192.0.2.${++peer}`;
      const signup = await app.request(origin + '/api/auth/sign-up/email', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
        body: JSON.stringify({
          name, email: `${name}-${randomUUID()}@example.com`, password: 'test-password-12345',
        }),
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const call = (path: string, method = 'GET', body?: unknown) =>
        app.request(origin + '/api' + path, {
          method,
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json',
            'x-kannabi-client-ip': address },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const key = (await (await call('/me')).json()).user.key as string;
      return { key, name, call };
    }

    const operator = await person('operator');
    const colleague = await person('colleague');

    // ─── The credential the corpus is loaded with ────────────────────────────
    // Named, so provenance can say which client asserted each write. From here
    // on every load operation goes through this and no cookie is used.
    const issued = await (await operator.call('/api-tokens', 'POST',
      { label: 'corpus loader', lifetimeDays: 1 })).json();
    const secret = issued.secret as string;
    assert.ok(secret, 'the token is returned once, to be used as a bearer credential');

    /** The importing client. A bearer credential and a per-record basis, which
     * is the only provenance value a caller supplies. */
    const load = (path: string, method = 'GET', body?: unknown, basis?: string) =>
      app.request(origin + '/api' + path, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'x-kannabi-client-ip': '192.0.2.200',
          ...(basis ? { 'X-Kannabi-Basis': basis } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const loaded = async (path: string, method = 'GET', body?: unknown, basis?: string) => {
      const response = await load(path, method, body, basis);
      assert.ok(response.ok, `${method} ${path} -> ${response.status} ${await response.clone().text()}`);
      return response.json();
    };

    await t.test('the token authenticates as its owner and carries no cookie', async () => {
      const me = await loaded('/me');
      assert.equal(me.user.key, operator.key);
      // A bearer credential is authenticated on its own; an invalid one is not
      // rescued by anything, so the load cannot silently fall back to a session.
      const refused = await app.request(origin + '/api/me',
        { headers: { Authorization: 'Bearer not-a-token' } });
      assert.equal((await refused.json()).user, null);
    });

    // ─── Groups, membership, and the managed namespace ───────────────────────
    const holding = (await loaded('/groups', 'POST', { name: 'Holding ' + randomUUID() })).group;
    const partner = (await loaded('/groups', 'POST', { name: 'Partner ' + randomUUID() })).group;

    await t.test('Groups, membership and a managed prefix are all client work', async () => {
      // The colleague reaches the corpus only through a Group, never directly.
      await loaded(`/groups/${partner.key}/members`, 'POST', { userKey: colleague.key });
      const namespace = (await loaded(`/groups/${holding.key}/gs1-namespaces`, 'POST',
        { gcp })).namespace;
      assert.equal(namespace.gcp, gcp);
      assert.equal(namespace.active, true);
    });

    const namespace = (await loaded('/gs1-namespaces')).namespaces
      .find((entry: { gcp: string }) => entry.gcp === gcp);

    await t.test('a class key is adopted, and the serials spent before Kannabi are excluded',
      async () => {
        // Adoption, not allocation: the operator supplies the key's own value,
        // because the prior system already had it. The record says which, and
        // Kannabi never claims to have allocated it.
        const classKey = (await loaded(`/gs1-namespaces/${namespace.key}/class-keys`, 'POST', {
          scheme: 'gtin', gtin: managedGtin,
          serialExclusions: [consumedSerials],
        })).classKey;
        assert.equal(classKey.provenance, 'adopted');
        assert.equal(classKey.sequence, null, 'nothing was allocated to produce it');
        assert.deepEqual(classKey.serial.exclusions, [consumedSerials]);
      });

    const classKey = (await loaded(`/gs1-namespaces/${namespace.key}/class-keys`)).classKeys
      .find((entry: { canonical: string }) => entry.canonical.includes(managedGtin));

    // ─── The corpus ─────────────────────────────────────────────────────────
    /** What each record's own system says about itself. Quoted, never Kannabi's. */
    const stated = {
      rig: { reference: 'legacy:asset:1001', recordedAt: '2019-04-12T09:30:00+09:00', recordedBy: 'A. Rivera' },
      pallet: { reference: 'legacy:asset:1002', recordedAt: '2020-11-03T14:05:00Z', recordedBy: 'Field Team' },
      crate: { reference: 'legacy:asset:1003' },
      bench: { reference: 'legacy:asset:1004', recordedAt: '2021-06-01T00:00:00Z' },
    } as const;
    const loadWindow = { from: Date.now() };
    const assets: Record<string, { id: string }> = {};

    await t.test('records that already existed are reported with what their source said', async () => {
      // One the prior system had serialised, under a serial it had spent.
      assets.rig = (await loaded('/assets', 'POST', {
        name: 'Calibration rig',
        groupKey: holding.key,
        sourceRecord: stated.rig,
        identifiers: [{ scheme: 'sgtin', gtin: managedGtin, serial: priorSerials[0] }],
      }, 'legacy:asset:1001')).asset;

      // One identified at class level, by a returnable-asset series.
      assets.pallet = (await loaded('/assets', 'POST', {
        name: 'Spare pallet',
        groupKey: holding.key,
        sourceRecord: stated.pallet,
        identifiers: [{ scheme: 'grai', assetType: managedAssetType }],
      }, 'legacy:asset:1002')).asset;

      // One carrying nothing. Zero identifiers is an ordinary Asset state.
      assets.crate = (await loaded('/assets', 'POST', {
        name: 'Unlabelled crate', groupKey: holding.key, sourceRecord: stated.crate,
      }, 'legacy:asset:1003')).asset;

      // One whose only recorded value the GS1 boundary will refuse.
      assets.bench = (await loaded('/assets', 'POST', {
        name: 'Bench unit', groupKey: holding.key, sourceRecord: stated.bench,
      }, 'legacy:asset:1004')).asset;

      for (const asset of Object.values(assets)) assert.ok(asset.id);
    });

    await t.test('a source record is quoted, and is not Kannabi chronology or authorship', async () => {
      const { asset } = await loaded(`/assets/${assets.rig.id}`);
      // What the source said, reproduced.
      assert.equal(asset.sourceRecord.reference, stated.rig.reference);
      assert.equal(asset.sourceRecord.recordedBy, stated.rig.recordedBy);
      assert.equal(Date.parse(asset.sourceRecord.recordedAt), Date.parse(stated.rig.recordedAt));

      // Kannabi's own chronology is the load, not 2019.
      const reportedAt = Date.parse(asset.reportedAt);
      assert.ok(reportedAt >= loadWindow.from - 1000 && reportedAt <= Date.now() + 1000,
        `reportedAt ${asset.reportedAt} must be when Kannabi recorded it`);
      assert.ok(reportedAt > Date.parse(stated.rig.recordedAt), 'and later than the source instant');

      // Kannabi's own authorship is the operator. The quoted recorder is text:
      // not a User, not the reporter, and not matchable as either.
      assert.equal(asset.reportedBy.key, operator.key);
      assert.equal(asset.reportedBy.name, 'operator');
      assert.notEqual(asset.reportedBy.name, stated.rig.recordedBy);
      const searched = await loaded(`/assets?q=${encodeURIComponent(stated.rig.recordedBy)}`);
      assert.equal(searched.assets.length, 0, 'a quoted recorder is not discovery text');

      // The client that asserted the write is the token; the authority that
      // accepted it is the User the token belongs to.
      assert.equal(asset.provenance.assertedBy.label, 'corpus loader');
      assert.equal(asset.provenance.acceptedBy.key, operator.key);
      assert.equal(asset.provenance.basis, stated.rig.reference);
    });

    await t.test('further identifiers attach after creation, still as recorded existing', async () => {
      // A second spent serial, and a GIAI the prior system assigned. Both are
      // values under the operator's own prefix, and recording one is still not
      // issuing it.
      const { asset } = await loaded(`/assets/${assets.rig.id}/identifiers`, 'POST',
        { scheme: 'sgtin', gtin: managedGtin, serial: priorSerials[1] }, 'legacy:asset:1001');
      assert.equal(asset.identifiers.length, 2);
      const second = await loaded(`/assets/${assets.pallet.id}/identifiers`, 'POST',
        { scheme: 'giai', assetReference: gcp + 'LEGACY-1' }, 'legacy:asset:1002');
      assert.equal(second.asset.identifiers.length, 2);
    });

    await t.test('a value the boundary refuses is refused with its reason, and its Asset still stands',
      async () => {
        // An empty serial is not a serial; AI 21 takes one to twenty characters.
        const refused = await load(`/assets/${assets.bench.id}/identifiers`, 'POST',
          { scheme: 'sgtin', gtin: managedGtin, serial: '' });
        assert.equal(refused.status, 400);
        assert.match((await refused.json()).error, /Serial must contain/,
          'the refusal says what was wrong rather than failing silently');

        // Refusing a value is not refusing the record. The Asset loaded, and
        // carries no identifier rather than a repaired one.
        const { asset } = await loaded(`/assets/${assets.bench.id}`);
        assert.equal(asset.identifiers.length, 0);
        assert.equal(asset.sourceRecord.reference, stated.bench.reference);
      });

    await t.test('a second Group reaches an Asset, and its members read it through that edge',
      async () => {
        await loaded(`/assets/${assets.pallet.id}/collaboration/${partner.key}`, 'PUT',
          undefined, 'legacy:asset:1002');
        const { asset } = await loaded(`/assets/${assets.pallet.id}`);
        assert.deepEqual(asset.groups.map((group: { key: string }) => group.key).sort(),
          [holding.key, partner.key].sort());
        // The colleague belongs only to the partner Group, so this is the edge
        // working rather than a direct grant.
        assert.equal((await colleague.call(`/assets/${assets.pallet.id}`)).status, 200);
        assert.equal((await colleague.call(`/assets/${assets.rig.id}`)).status, 404,
          'and it reaches nothing else in the corpus');
      });

    await t.test('a photo loads through the ordinary photo route', async () => {
      const form = new FormData();
      form.append('photo', new File([png], 'plate.png', { type: 'image/png' }));
      const response = await app.request(origin + `/api/assets/${assets.rig.id}/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'x-kannabi-client-ip': '192.0.2.200' },
        body: form,
      });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal((await response.json()).asset.photos.length, 1);
    });

    await t.test('nothing in the corpus was issued by Kannabi', async () => {
      for (const [name, asset] of Object.entries(assets)) {
        const current = await loaded(`/assets/${asset.id}`);
        assert.deepEqual(current.asset.issuances, [],
          `${name} must carry no issuance record: every value it has came from elsewhere`);
      }
      // An Asset's issuances are derived from the ledger rather than from its
      // identifiers, so an empty list is the ledger's answer and not an absence
      // of matching values: every Asset above carries one whose digits sit under
      // the managed prefix, and none of them is reported as issued.
      const page = await loaded('/assets?limit=100');
      assert.equal(page.assets.length, Object.keys(assets).length, 'the corpus is exactly this');
      for (const asset of page.assets) assert.deepEqual(asset.issuances, []);
    });

    await t.test('an issuance afterwards skips the serials the prior system spent', async () => {
      const { asset } = await loaded(`/assets/${assets.rig.id}/sgtin`, 'POST',
        { namespaceKey: namespace.key, classKeyKey: classKey.key });
      assert.equal(asset.issuances.length, 1, 'exactly one, and only now');
      const issuance = asset.issuances[0];
      // 1 to 50 were unavailable before Kannabi existed, so the first value it
      // may issue is 51. The exclusions are configuration, never a free list.
      assert.equal(issuance.sequence, consumedSerials.to + 1);
      assert.equal(issuance.canonical, `(01)0${managedGtin}(21)${consumedSerials.to + 1}`);
      assert.equal(issuance.scheme, 'sgtin');
      // It is Kannabi-issued because the ledger says so, not because the digits
      // sit under a managed prefix — the recorded serials do too.
      assert.ok(asset.identifiers.some((identifier: { canonical: string }) =>
        identifier.canonical === issuance.canonical));
      assert.equal(asset.identifiers.length, 3);
    });

    await t.test('an ordinary edit moves basis and leaves the source record alone', async () => {
      const before = (await loaded(`/assets/${assets.rig.id}`)).asset;
      const edited = (await loaded(`/assets/${assets.rig.id}`, 'PATCH',
        { name: 'Calibration rig, recased' }, 'ticket:correction:9')).asset;

      assert.equal(edited.name, 'Calibration rig, recased');
      // The latest change carries its own basis; where the record came from does
      // not move with it.
      assert.equal(edited.provenance.basis, 'ticket:correction:9');
      assert.equal(edited.sourceRecord.reference, stated.rig.reference);
      assert.equal(edited.sourceRecord.recordedBy, stated.rig.recordedBy);
      assert.equal(Date.parse(edited.sourceRecord.recordedAt), Date.parse(stated.rig.recordedAt));
      assert.equal(edited.reportedAt, before.reportedAt, 'Kannabi chronology does not move');
      assert.equal(edited.reportedBy.key, operator.key);

      // And there is no path that revises it.
      const refused = await load(`/assets/${assets.rig.id}`, 'PATCH',
        { sourceRecord: { reference: 'legacy:asset:9999' } });
      assert.equal(refused.status, 400);
      assert.equal((await loaded(`/assets/${assets.rig.id}`)).asset.sourceRecord.reference,
        stated.rig.reference);
    });

    await t.test('every Asset is private, and none is left outside a Group', async () => {
      const page = await loaded('/assets?limit=100');
      assert.equal(page.assets.length, Object.keys(assets).length,
        'the corpus is exactly what was loaded');
      for (const asset of page.assets) {
        assert.equal(asset.isPublic, false,
          `${asset.name} must not be published by being imported`);
        assert.ok(asset.groups.length >= 1, `${asset.name} must be reachable through a Group`);
      }
      // Nothing is readable without a credential, which is the same statement
      // from the other side.
      const anonymous = await app.request(origin + `/api/assets/${assets.rig.id}`);
      assert.equal(anonymous.status, 404);
    });
  });
