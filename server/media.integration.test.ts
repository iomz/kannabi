import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { isAssetId } from './asset-id.js';
import { IdentityStore } from './identity-store.js';
import { defaultToastSeconds } from './settings.js';
import { MediaService } from './media.js';
import { storageFromEnv, type ObjectStorage } from './storage.js';
import { createAuth } from './auth.js';
import { createInventoryApi } from './inventory-api.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxoAAAAASUVORK5CYII=', 'base64');
const photo = () => new File([png], 'photo.png', { type: 'image/png' });
test('S3 media, policy and administration', { skip: !uri || !password || !process.env.S3_ENDPOINT }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const legacy = driver.session();
  await legacy.run("MERGE (s:Settings {key: 'instance'}) SET s.requirePhoto = false, s.displayTimezone = 'UTC', s.revision = 0 REMOVE s.themeId, s.accentColor");
  await legacy.close();
  const store = await IdentityStore.open(driver);
  // An instance older than a setting reads as the shipped default rather than
  // as a missing value, so an upgrade needs no migration to be usable.
  assert.deepEqual(await store.settings(),
    { requirePhoto: false, displayTimezone: 'UTC', themeId: 'default', apiTokenMaxLifetimeDays: null,
      toastSeconds: defaultToastSeconds });
  const storage = storageFromEnv();
  await storage.check();
  const media = new MediaService(store, storage);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, media));
  const signup = await app.request(origin + '/api/auth/sign-up/email', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Reporter', email: 'reporter@example.com', password: randomUUID() }) });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const user = (await (await app.request(origin + '/api/me', { headers: { Cookie: cookie } })).json()).user;
  const member = await store.createUser('Member');
  const stranger = await store.createUser('Stranger');
  const group = await store.createReportingGroup('Team', user.key);
  await store.addGroupMember(user.key, group.key, member.key);
  const context = { actorKey: user.key, groupKey: group.key };
  const identifier = { scheme: 'sgtin' as const, gtin: '00614141123452', serial: 'media' };
  const input = { name: 'Camera', identifiers: [identifier] };
  // The native Asset id, assigned by the first successful report below.
  let assetId = '';
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }
  const request = (path: string, method = 'GET', body?: BodyInit, authenticated = true) => app.request(origin + '/api' + path, {
    method, headers: { Origin: origin, ...(authenticated ? { Cookie: cookie } : {}), ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) }, body,
  });

  await t.test('only explicitly granted administrator can change instance settings', async () => {
    const change = JSON.stringify({ requirePhoto: true, displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue' });
    assert.equal((await request('/settings', 'PATCH', change)).status, 404);
    assert.equal((await request('/settings', 'PATCH', change, false)).status, 401);
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: user.key });
    assert.equal((await request('/settings', 'PATCH', change)).status, 200);
    assert.deepEqual(await store.settings(),
      { requirePhoto: true, displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue', apiTokenMaxLifetimeDays: null,
        toastSeconds: defaultToastSeconds });
    // The API token lifetime ceiling is instance policy and travels with the
    // rest of the settings object, including back to the unconfigured state.
    assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: true,
      displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue', apiTokenMaxLifetimeDays: 30 }))).status, 200);
    assert.equal((await store.settings()).apiTokenMaxLifetimeDays, 30);
    assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: true,
      displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue', apiTokenMaxLifetimeDays: 0 }))).status, 400);
    assert.equal((await request('/settings', 'PATCH', change)).status, 200);
    assert.equal((await store.settings()).apiTokenMaxLifetimeDays, null);
    // How long a message stays is instance policy too, in seconds, and is
    // refused outside a range in which it can be read and still be transient.
    assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: true,
      displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue', toastSeconds: 12 }))).status, 200);
    assert.equal((await store.settings()).toastSeconds, 12);
    for (const toastSeconds of [1, 31, 5.5, '5']) {
      assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: true,
        displayTimezone: 'Asia/Tokyo', themeId: 'mono-blue', toastSeconds }))).status, 400, String(toastSeconds));
    }
    assert.equal((await store.settings()).toastSeconds, 12, 'a refused change leaves the policy alone');
    assert.equal((await request('/settings', 'PATCH', change)).status, 200);
    assert.equal((await store.settings()).toastSeconds, defaultToastSeconds, 'omitted means the shipped default');
    assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: false, displayTimezone: 'unknown', themeId: 'default' }))).status, 400);
    assert.equal((await request('/settings', 'PATCH', JSON.stringify({ requirePhoto: false, displayTimezone: 'UTC', themeId: 'custom' }))).status, 400);
  });

  await t.test('required photo enforced on JSON and multipart reports; successful bytes and metadata commit together', async () => {
    assert.equal((await request('/assets', 'POST', JSON.stringify({ ...input, groupKey: group.key }))).status, 400);
    await assert.rejects(store.reportAsset(input, context), /photo is required/);
    const empty = new FormData(); empty.set('report', JSON.stringify({ ...input, groupKey: group.key }));
    assert.equal((await request('/reports', 'POST', empty)).status, 400);
    assert.equal((await query('MATCH (a:Asset) RETURN count(a) AS n')).records[0].get('n').toNumber(), 0);
    const form = new FormData(); form.set('report', JSON.stringify({ ...input, groupKey: group.key })); form.set('photo', photo());
    const response = await request('/reports', 'POST', form);
    assert.equal(response.status, 201, await response.clone().text());
    const asset = (await response.json()).asset;
    assetId = asset.id;
    assert.ok(isAssetId(assetId), assetId);
    assert.equal(asset.photos.length, 1);
    assert.deepEqual(Buffer.from(await storage.get(asset.photos[0].key)), png);
    assert.match(asset.reportedAt, /Z$/);
  });

  await t.test('photo access follows Asset visibility and membership, including revocation', async () => {
    const asset = (await store.getAsset(assetId, user.key))!;
    const key = asset.photos[0].key;
    const inventory = await (await request('/assets?q=camERA&limit=1')).json();
    assert.equal(inventory.matching, 1);
    assert.deepEqual(inventory.assets[0].photos, asset.photos);
    assert.deepEqual(inventory.assets[0].identifiers.map((i: { canonical: string }) => i.canonical),
      ['(01)00614141123452(21)media']);
    assert.equal(inventory.assets[0].id, assetId);
    const path = `/assets/${assetId}/photos/${key}`;
    assert.equal((await request(path)).status, 200);
    assert.equal((await request(path, 'GET', undefined, false)).status, 404);
    await assert.rejects(media.read(assetId, key, stranger.key));
    await assert.rejects(media.add(assetId, stranger.key, photo()));
    const added = await media.add(assetId, member.key, photo());
    assert.equal(added.photos.length, 2);
    assert.deepEqual(added.photos.map(({ key: photoKey }) => photoKey), [key, added.photos[1].key]);
    assert.ok(added.photos.every(({ createdAt }) => createdAt !== null));
    await store.updateAsset(assetId, { isPublic: true }, user.key);
    const publicRead = await request(path, 'GET', undefined, false);
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()), png);
    await assert.rejects(media.add(assetId, stranger.key, photo()));
    const form = new FormData(); form.set('photo', photo());
    assert.equal((await request(`/assets/${assetId}/photos`, 'POST', form, false)).status, 401);
    await store.updateAsset(assetId, { isPublic: false }, user.key);
    assert.equal((await request(path, 'GET', undefined, false)).status, 404);
    await store.leaveGroup(user.key, group.key);
    assert.equal((await store.accountState(user.key)).isAdmin, true);
    assert.equal((await request(path)).status, 404); // administrator is not an Asset ACL
    await assert.rejects(media.add(assetId, user.key, photo()));
    assert.deepEqual((await store.getAsset(assetId, member.key))!.reportedBy, asset.reportedBy);
    await store.addGroupMember(member.key, group.key, user.key);
  });

  await t.test('authorized deletion removes public photo metadata and object while other actors are rejected', async () => {
    const asset = (await store.getAsset(assetId, user.key))!;
    const key = asset.photos.at(-1)!.key;
    const path = `/assets/${assetId}/photos/${key}`;
    const deletionPath = path;
    await store.updateAsset(assetId, { isPublic: true }, user.key);
    assert.equal((await request(path, 'GET', undefined, false)).status, 200);

    await assert.rejects(media.remove(assetId, stranger.key, key));
    assert.equal((await request(deletionPath, 'DELETE', undefined, false)).status, 401);
    assert.equal((await request(path, 'GET', undefined, false)).status, 200);

    assert.equal((await request(deletionPath, 'DELETE')).status, 200);
    assert.equal((await request(path, 'GET', undefined, false)).status, 404);
    assert.equal((await request(path)).status, 404);
    await assert.rejects(storage.get(key));
    assert.equal((await store.getAsset(assetId, user.key))!.photos.some((candidate) => candidate.key === key), false);
    await store.updateAsset(assetId, { isPublic: false }, user.key);
  });

  await t.test('optional policy accepts photo-free reports and does not affect existing Assets', async () => {
    await store.updateSettings(user.key, { requirePhoto: false, displayTimezone: 'UTC', themeId: 'default' });
    const asset = await media.report({ name: 'Optional', identifiers: [{ ...identifier, serial: 'optional' }] }, context);
    assert.deepEqual(asset.photos, []);
    assert.notEqual(asset.id, assetId);
    await store.updateSettings(user.key, { requirePhoto: true, displayTimezone: 'UTC', themeId: 'default' });
    assert.ok(await store.updateAsset(asset.id, { name: 'Still editable' }, user.key));
  });

  await t.test('failed S3 writes and duplicate identity commits clean bytes without attaching metadata', async () => {
    let failedKey = '';
    const failing: ObjectStorage = {
      put: async (key, bytes, mime) => { failedKey = key; await storage.put(key, bytes, mime); throw new Error('Write acknowledgement lost'); },
      get: (key) => storage.get(key), delete: (key) => storage.delete(key),
    };
    const failedId = { ...identifier, serial: 'failed' };
    await assert.rejects(new MediaService(store, failing).report({ name: 'Failed', identifiers: [failedId] }, context, photo()), /acknowledgement/);
    assert.equal((await query('MATCH (i:Identifier {serial: $serial}) RETURN i', { serial: 'failed' })).records.length, 0);
    await assert.rejects(storage.get(failedKey));
    const before = (await store.getAsset(assetId, user.key))!.photos.length;
    await assert.rejects(media.report(input, context, photo()), /already claimed/);
    assert.equal((await store.getAsset(assetId, user.key))!.photos.length, before);
    const dangling = await query("MATCH (:Asset)-[:HAS_PHOTO]->(m:Media) WHERE m.state <> 'attached' RETURN m");
    assert.equal(dangling.records.length, 0);
  });

  await t.test('failed deletion and abandoned upload recover after restart; attached photo survives ambiguous commit', async () => {
    let failedKey = '';
    const failing: ObjectStorage = {
      put: async (key, bytes, mime) => { failedKey = key; await storage.put(key, bytes, mime); throw new Error('Upload failed'); },
      get: (key) => storage.get(key), delete: async () => { throw new Error('Storage unavailable'); },
    };
    await assert.rejects(new MediaService(store, failing).add(assetId, user.key, photo()));
    assert.deepEqual(Buffer.from(await storage.get(failedKey)), png);
    const abandoned = await store.reservePhoto('image/png', png.length);
    await storage.put(abandoned, png, 'image/png');
    await query("MATCH (m:Media) WHERE m.state <> 'attached' SET m.expiresAt = datetime() - duration('PT1M')");
    await new MediaService(await IdentityStore.open(driver), storage).cleanup();
    await assert.rejects(storage.get(failedKey)); await assert.rejects(storage.get(abandoned));
    assert.equal((await query("MATCH (m:Media) WHERE m.state <> 'attached' RETURN m")).records.length, 0);

    const deletionCandidate = (await media.add(assetId, user.key, photo())).photos.at(-1)!.key;
    await new MediaService(store, failing).remove(assetId, user.key, deletionCandidate);
    assert.deepEqual(Buffer.from(await storage.get(deletionCandidate)), png);
    assert.equal((await store.getAsset(assetId, user.key))!.photos.some(({ key }) => key === deletionCandidate), false);
    await media.cleanup();
    await assert.rejects(storage.get(deletionCandidate));

    const attached = (await store.getAsset(assetId, user.key))!.photos[0].key;
    await media.cleanup(attached);
    assert.deepEqual(Buffer.from(await storage.get(attached)), png);
  });
});
