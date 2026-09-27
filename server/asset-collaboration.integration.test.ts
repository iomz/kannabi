import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Hono } from 'hono';
import { createAuth } from './auth.js';
import { IdentityStore, ReferenceError as AccessError, LastCollaborationError } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { assetPageRequest } from './asset-page.js';
import { ApiTokenService } from './api-token.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('multi-Group collaboration is explicit bilateral control, never ownership', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const tokens = new ApiTokenService(auth, store);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, undefined, tokens));
  let peer = 0;
  async function person(name: string) {
    const address = `192.0.2.${++peer}`;
    const response = await app.request(origin + '/api/auth/sign-up/email', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
      body: JSON.stringify({ name, email: `${name}@example.com`, password: 'test-password-12345' }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const call = (path: string, method = 'GET', body?: unknown, requestOrigin = origin) =>
      app.request(origin + '/api' + path, { method,
        headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
        body: body === undefined ? undefined : JSON.stringify(body) });
    const key = (await (await call('/me')).json()).user.key as string;
    return { key, call };
  }
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }
  const bridge = await person('bridge'), aOnly = await person('a-only'), bOnly = await person('b-only');
  const dual = await person('dual'), outsider = await person('outsider'), admin = await person('admin');
  const a = await store.createReportingGroup('A', bridge.key);
  const b = await store.createReportingGroup('B', bridge.key);
  await store.addGroupMember(bridge.key, a.key, aOnly.key);
  await store.addGroupMember(bridge.key, b.key, bOnly.key);
  for (const group of [a, b]) await store.addGroupMember(bridge.key, group.key, dual.key);
  await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: admin.key });
  const asset = await store.reportAsset({ name: 'Shared instrument' }, { actorKey: aOnly.key, groupKey: a.key });
  const path = `/assets/${asset.id}`;
  const edge = (key: string) => `${path}/collaboration/${key}`;

  await t.test('membership, reporter, public read, and system administration cannot delegate', async () => {
    for (const actor of [aOnly, bOnly, dual, outsider, admin]) {
      assert.equal((await actor.call(edge(b.key), 'PUT')).status, 404);
      assert.equal((await actor.call(edge(a.key), 'DELETE')).status, 404);
    }
    assert.equal((await bridge.call(edge(b.key), 'PUT', undefined, 'https://other.example')).status, 403);
    assert.equal((await app.request(origin + '/api' + edge(b.key), { method: 'PUT', headers: { Origin: origin } })).status, 401);
    await store.updateAsset(asset.id, { isPublic: true }, aOnly.key);
    assert.equal((await outsider.call(path)).status, 200);
    assert.equal((await outsider.call(edge(b.key), 'PUT')).status, 404);
    await store.updateAsset(asset.id, { isPublic: false }, aOnly.key);
  });

  await t.test('both controls required; target control needs no target membership', async () => {
    const foreign = await store.createReportingGroup('Foreign', outsider.key);
    assert.equal((await bridge.call(edge(foreign.key), 'PUT')).status, 404, 'source control cannot replace receiver consent');
    await store.addGroupMember(bridge.key, a.key, outsider.key);
    assert.equal((await outsider.call(edge(foreign.key), 'PUT')).status, 404, 'target control plus ordinary source membership is insufficient');
    await store.leaveGroup(outsider.key, a.key);
    await store.leaveGroup(bridge.key, b.key);
    const granted = await bridge.call(edge(b.key), 'PUT');
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.deepEqual(await granted.json(), { changed: true });
    const before = await store.getAsset(asset.id, bridge.key);
    assert.deepEqual(await (await bridge.call(edge(b.key), 'PUT')).json(), { changed: false });
    assert.deepEqual((await store.getAsset(asset.id, bridge.key))?.provenance, before?.provenance);
    assert.equal(before?.provenance?.acceptedBy.key, bridge.key);
    assert.equal((await bOnly.call(path, 'PATCH', { name: 'Shared instrument edited by B' })).status, 200);
    for (const actor of [aOnly, bOnly, dual]) {
      const page = await (await actor.call('/assets?q=Shared')).json();
      assert.equal(page.assets.length, 1);
      assert.equal(page.matching, 1);
      assert.equal(page.total, 1);
      assert.equal(page.assets[0].id, asset.id);
      assert.equal(page.assets[0].groups.length, 2);
      const lookup = await (await actor.call('/assets/lookup?id=' + asset.id)).json();
      assert.equal(lookup.assets.length, 1);
      assert.equal(lookup.matching, 1);
    }
  });

  await t.test('B collaboration never grants A namespace authority', async () => {
    const namespace = await store.configureGiaiNamespace(aOnly.key, a.key, { gcp: '0614141' });
    assert.equal((await bOnly.call(`${path}/giai`, 'POST', { namespaceKey: namespace.key })).status, 404);
    assert.equal((await bOnly.call(`/giai-namespaces/${namespace.key}`, 'PATCH', { active: false })).status, 404);
    assert.equal((await bOnly.call(`/groups/${a.key}/giai-namespaces`, 'POST', { gcp: '9521234' })).status, 404);
    assert.equal((await dual.call(`${path}/giai`, 'POST', { namespaceKey: namespace.key })).status, 200);
  });

  await t.test('bearer grants record credential and basis; owner authority remains live', async () => {
    const tokenResponse = await bridge.call('/api-tokens', 'POST', { label: 'Collaboration automation', lifetimeDays: 30 });
    assert.equal(tokenResponse.status, 201, await tokenResponse.clone().text());
    const token = await tokenResponse.json();
    const c = await store.createReportingGroup('C', bridge.key);
    const bearer = (method: string) => app.request(origin + '/api' + edge(c.key), { method,
      headers: { Authorization: `Bearer ${token.secret}`, 'X-Kannabi-Basis': 'collaboration:test' } });
    assert.equal((await bearer('PUT')).status, 200);
    const current = await store.getAsset(asset.id, bridge.key);
    assert.equal(current?.provenance?.assertedBy?.label, 'Collaboration automation');
    assert.equal(current?.provenance?.acceptedBy.key, bridge.key);
    assert.equal(current?.provenance?.basis, 'collaboration:test');
    assert.equal((await bearer('DELETE')).status, 200);
    await tokens.revokeOwn(bridge.key, token.token.id);
    assert.equal((await bearer('PUT')).status, 401);
  });

  await t.test('reporter departure and tombstone preserve identity, not authority', async () => {
    await store.leaveGroup(aOnly.key, a.key);
    assert.equal((await aOnly.call(path)).status, 404);
    assert.equal((await aOnly.call(edge(b.key), 'DELETE')).status, 404);
    assert.equal((await aOnly.call('/profile', 'DELETE')).status, 200);
    const current = (await (await bOnly.call(path)).json()).asset;
    assert.equal(current.id, asset.id);
    assert.equal(current.reportedBy.key, aOnly.key);
    assert.equal(current.reportedBy.status, 'deleted');
  });

  await t.test('revoke target requires its control, keeps other access, and does not erase ledger', async () => {
    assert.equal((await bOnly.call(edge(a.key), 'DELETE')).status, 404);
    assert.deepEqual(await (await bridge.call(edge(b.key), 'DELETE')).json(), { changed: true });
    assert.deepEqual(await (await bridge.call(edge(b.key), 'DELETE')).json(), { changed: false });
    assert.equal((await bOnly.call(path)).status, 404);
    assert.equal((await bOnly.call(path, 'PATCH', { name: 'Denied' })).status, 404);
    assert.equal((await dual.call(path)).status, 200);
    assert.ok((await store.getAsset(asset.id, dual.key))?.allocation);
    assert.equal((await bridge.call(edge(a.key), 'DELETE')).status, 409);
    await store.updateAsset(asset.id, { isPublic: true }, bridge.key);
    assert.equal((await bridge.call(edge(a.key), 'DELETE')).status, 409);
    assert.equal((await bOnly.call(path)).status, 200);
    assert.equal((await bOnly.call(path, 'PATCH', { name: 'Public is not edit' })).status, 404);
    await store.updateAsset(asset.id, { isPublic: false }, bridge.key);
  });

  await t.test('concurrent grants produce one edge; competing removals retain one', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      store.setAssetCollaboration(asset.id, bridge.key, b.key, true)));
    assert.equal(results.filter((r) => r.changed).length, 1);
    await query('MATCH (u:User {key: $user}), (g:Group {key: $group}) CREATE (u)-[:CONTROLS]->(g)',
      { user: dual.key, group: b.key });
    const removals = await Promise.allSettled([
      store.setAssetCollaboration(asset.id, bridge.key, a.key, false),
      store.setAssetCollaboration(asset.id, dual.key, b.key, false),
    ]);
    assert.equal(removals.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = removals.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && (rejected.reason instanceof LastCollaborationError || rejected.reason instanceof AccessError));
    const current = await store.getAsset(asset.id, dual.key);
    assert.equal(current?.groups.length, 1);
    // Restore A then B using an actor who still has the required membership.
    await store.addGroupMember(bridge.key, b.key, bridge.key);
    for (const group of [a, b]) await store.setAssetCollaboration(asset.id, bridge.key, group.key, true);
    await query('MATCH (:User {key: $user})-[r:CONTROLS]->(:Group {key: $group}) DELETE r',
      { user: dual.key, group: b.key });
  });

  await t.test('writes waiting behind revocation recheck access before changing anything', async () => {
    const namespace = await store.configureGiaiNamespace(bOnly.key, b.key, { gcp: '9521234' });
    const target = await store.reportAsset({ name: 'Revocation race' }, { actorKey: bridge.key, groupKey: a.key });
    await store.setAssetCollaboration(target.id, bridge.key, b.key, true);
    const session = driver.session();
    const tx = session.beginTransaction();
    try {
      await tx.run('MATCH (a:Asset {id: $id}) SET a.lock = true', { id: target.id });
      const writes = [
        store.updateAsset(target.id, { name: 'Must not commit' }, bOnly.key),
        store.attachIdentifier(target.id, bOnly.key, { scheme: 'giai', assetReference: '0614141RACE' }),
        store.allocateGiai(target.id, bOnly.key, namespace.key),
        store.setAssetCollaboration(target.id, bridge.key, b.key, false),
      ].map((promise) => promise.then(() => null, (error: unknown) => error));
      // Observe actual blocked transactions, rather than assuming a timeout
      // means the operations have reached their authorization boundary.
      const deadline = Date.now() + 10000;
      for (;;) {
        const waiting = await query(`SHOW TRANSACTIONS YIELD currentQuery, status
          WHERE currentQuery CONTAINS 'SET a.lock = true' AND status STARTS WITH 'Blocked'
          RETURN count(*) AS waiting`);
        if (waiting.records[0].get('waiting').toNumber() >= 4) break;
        assert.ok(Date.now() < deadline, 'writes must wait for the Asset lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await tx.run('MATCH (:Group {key: $key})-[r:CAN_COLLABORATE]->(:Asset {id: $id}) DELETE r',
        { key: b.key, id: target.id });
      await tx.commit();
      const results = await Promise.all(writes);
      assert.ok(results.slice(0, 3).every((error) => error instanceof AccessError));
      assert.equal(results[3], null, 'authorized duplicate revoke is a no-op');
      const unchanged = await store.getAsset(target.id, bridge.key);
      assert.equal(unchanged?.name, 'Revocation race');
      assert.equal(unchanged?.identifiers.length, 0);
      assert.equal(unchanged?.allocation, null);
    } finally { await tx.close(); await session.close(); }
  });

  await t.test('controller-only cannot act; empty Groups persist; initial Group can leave', async () => {
    await store.leaveGroup(bridge.key, a.key);
    await store.leaveGroup(bridge.key, b.key);
    assert.equal((await bridge.call(path)).status, 404);
    assert.equal((await bridge.call(edge(a.key), 'DELETE')).status, 404);
    assert.equal((await bridge.call(edge(b.key), 'PUT')).status, 404);
    await store.leaveGroup(dual.key, a.key);
    assert.equal((await store.getAsset(asset.id, bOnly.key))?.groups.length, 2, 'empty A stays attached');
    await store.addGroupMember(bridge.key, b.key, bridge.key);
    assert.equal((await bridge.call(edge(a.key), 'DELETE')).status, 200, 'initial Group has no special authority');
    assert.equal((await store.getAsset(asset.id, bOnly.key))?.groups[0].key, b.key);
    await store.deactivateOwnAccount(bridge.key);
    assert.equal((await bOnly.call(path)).status, 200, 'controller deletion does not remove collaboration');
    const page = await store.findAssets(dual.key, assetPageRequest({}));
    assert.equal(page.assets.filter((entry) => entry.id === asset.id).length, 1);
  });
});
