import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

test('Group control grants membership, never Asset access', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin));
  let peer = 0;
  function client() {
    let cookie = '';
    const address = `192.0.2.${++peer}`;
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await app.request(origin + '/api' + path, { method,
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
          'x-kannabi-client-ip': address },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const set = response.headers.getSetCookie();
      if (set.length) cookie = set.map((value) => value.split(';')[0]).join('; ');
      return response;
    };
  }
  const controller = client(), member = client(), invited = client(), admin = client(), departing = client();
  const keys: string[] = [];
  for (const [index, call] of [controller, member, invited, admin, departing].entries()) {
    const signup = await call('/auth/sign-up/email', 'POST', {
      name: `Group tester ${index}`, email: `group-tester-${index}@example.com`,
      password: 'test-password-12345',
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    keys.push((await (await call('/me')).json()).user.key);
  }
  async function query(statement: string, params = {}) {
    const session = driver.session();
    try { return await session.run(statement, params); }
    finally { await session.close(); }
  }

  const created = await controller('/groups', 'POST', { name: 'Controlled equipment' });
  assert.equal(created.status, 201);
  const groupKey = (await created.json()).group.key as string;
  const memberPath = `/groups/${groupKey}/members`;

  await t.test('Group creation explicitly grants both membership and control', async () => {
    assert.deepEqual((await (await controller('/groups/controlled')).json()).groups.map((g: { key: string }) => g.key), [groupKey]);
    assert.deepEqual((await (await member('/groups/controlled')).json()).groups, []);
    assert.equal((await member(memberPath, 'POST', { userKey: keys[2] })).status, 404);
    assert.equal((await admin(memberPath, 'POST', { userKey: keys[2] })).status, 404);
    assert.equal((await client()('/groups/controlled')).status, 401);
    const added = await controller(memberPath, 'POST', { userKey: keys[1] });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).added, true);
    assert.equal((await controller(memberPath, 'POST', { userKey: keys[1] })).status, 200);
    assert.equal((await member(memberPath, 'POST', { userKey: keys[2] })).status, 404,
      'membership gives Asset access, not recruitment authority');
  });

  const reported = await member('/assets', 'POST', { name: 'Private controlled Asset', groupKey });
  assert.equal(reported.status, 201);
  const assetId = (await reported.json()).asset.id as string;
  const assetPath = `/assets/${assetId}`;
  const configured = await member(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '0614141' });
  assert.equal(configured.status, 201);
  const namespaceKey = (await configured.json()).namespace.key as string;

  await t.test('a controller without membership cannot read, edit, or issue for a private Asset', async () => {
    assert.equal((await controller(`/groups/${groupKey}/membership`, 'DELETE')).status, 200);
    assert.deepEqual((await (await controller('/groups')).json()).groups, []);
    assert.deepEqual((await (await controller('/groups/controlled')).json()).groups.map((g: { key: string }) => g.key), [groupKey]);
    assert.equal((await controller(assetPath)).status, 404);
    assert.equal((await controller(assetPath, 'PATCH', { name: 'No control-plane edit' })).status, 404);
    assert.equal((await controller(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '9521234' })).status, 404);
    assert.equal((await controller(`${assetPath}/giai`, 'POST', { namespaceKey })).status, 404);
    assert.equal((await member(assetPath)).status, 200);
    assert.equal((await member(assetPath, 'PATCH', { name: 'Member edit' })).status, 200);
    assert.equal((await member(memberPath, 'POST', { userKey: keys[2] })).status, 404);
    const added = await controller(memberPath, 'POST', { userKey: keys[2] });
    assert.equal(added.status, 200);
    assert.equal((await invited(assetPath)).status, 200,
      'an explicit membership grant gives the invitee Asset access');
    assert.deepEqual((await (await invited('/groups/controlled')).json()).groups, []);
  });

  await t.test('administrator and reporter status do not grant Group control or Asset access', async () => {
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: keys[3] });
    assert.equal((await admin('/admin/users')).status, 200);
    assert.deepEqual((await (await admin('/groups/controlled')).json()).groups, []);
    assert.equal((await admin(memberPath, 'POST', { userKey: keys[3] })).status, 404);
    assert.equal((await admin(assetPath)).status, 404);
    assert.equal((await admin(assetPath, 'PATCH', { name: 'No admin edit' })).status, 404);
    assert.equal((await member(`/groups/${groupKey}/membership`, 'DELETE')).status, 200);
    assert.equal((await member(assetPath)).status, 404);
    assert.equal((await member(assetPath, 'PATCH', { name: 'No reporter edit' })).status, 404);
    assert.equal((await invited(assetPath)).status, 200);
    assert.equal((await (await invited(assetPath)).json()).asset.reportedBy.key, keys[1]);
  });

  await t.test('an empty Group remains controlled, then becomes stranded on account deletion', async () => {
    const empty = await departing('/groups', 'POST', { name: 'Eventually empty' });
    const emptyKey = (await empty.json()).group.key as string;
    const onlyAsset = await departing('/assets', 'POST', { name: 'Stranded private Asset', groupKey: emptyKey });
    assert.equal(onlyAsset.status, 201);
    const onlyAssetPath = `/assets/${(await onlyAsset.json()).asset.id}`;
    assert.equal((await departing(`/groups/${emptyKey}/membership`, 'DELETE')).status, 200);
    assert.deepEqual((await (await departing('/groups/controlled')).json()).groups.map((g: { key: string }) => g.key), [emptyKey]);
    assert.equal((await departing('/profile', 'DELETE')).status, 200);
    assert.equal((await departing('/me')).status, 200);
    assert.equal((await (await departing('/me')).json()).user, null);
    const state = await query(`MATCH (g:Group {key: $groupKey})
      RETURN count { (g)<-[:MEMBER_OF]-() } AS members,
        count { (g)<-[:CONTROLS]-() } AS controllers`, { groupKey: emptyKey });
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].get('members').toNumber(), 0);
    assert.equal(state.records[0].get('controllers').toNumber(), 0);
    assert.equal((await departing(`/groups/${emptyKey}/members`, 'POST', { userKey: keys[2] })).status, 401);
    assert.equal((await admin(`/groups/${emptyKey}/members`, 'POST', { userKey: keys[2] })).status, 404);
    assert.equal((await admin(onlyAssetPath)).status, 404);
    assert.deepEqual((await (await admin('/admin/groups/uncontrolled')).json()).groups.map((g: { key: string }) => g.key), [emptyKey]);
    assert.equal((await member('/admin/groups/uncontrolled')).status, 403);
    assert.equal((await admin(`/admin/groups/${emptyKey}/recover`, 'POST', { userKey: keys[4] })).status, 404,
      'a deleted account cannot regain live Group control');
    assert.equal((await admin(`/admin/groups/${emptyKey}/recover`, 'POST', { userKey: keys[2] })).status, 200);
    assert.equal((await invited(onlyAssetPath)).status, 404, 'recovered control does not grant membership');
    assert.equal((await invited(onlyAssetPath, 'PATCH', { name: 'No control-plane edit' })).status, 404);
    assert.deepEqual((await (await invited('/groups/controlled')).json()).groups.map((g: { key: string }) => g.key), [emptyKey]);
    assert.equal((await admin(onlyAssetPath)).status, 404);
    assert.deepEqual((await (await admin('/admin/groups/uncontrolled')).json()).groups, []);
    assert.equal((await admin(`/admin/groups/${emptyKey}/recover`, 'POST', { userKey: keys[0] })).status, 404);
    assert.equal((await invited(`/groups/${emptyKey}/members`, 'POST', { userKey: keys[1] })).status, 200);
    assert.equal((await member(onlyAssetPath)).status, 200, 'membership, not controller status, grants Asset access');
  });

  await t.test('two administrators cannot independently recover the same uncontrolled Group', async () => {
    const legacy = await store.createGroup('Group predating control');
    const results = await Promise.all([
      admin(`/admin/groups/${legacy.key}/recover`, 'POST', { userKey: keys[0] }),
      admin(`/admin/groups/${legacy.key}/recover`, 'POST', { userKey: keys[2] }),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 404]);
    const owners = await query('MATCH (g:Group {key: $key})<-[:CONTROLS]-(u:User) RETURN u.key AS key', { key: legacy.key });
    assert.equal(owners.records.length, 1);
  });
});
