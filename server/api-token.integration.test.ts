import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { ApiTokenService } from './api-token.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** API tokens as a delegated credential.
 *
 * The property under test throughout is that a token changes who holds a
 * credential and nothing about what that credential may reach: both paths
 * resolve to one User and then to the same Group-derived authorization.
 */
test('API token authentication, authority and provenance', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const tokens = new ApiTokenService(auth, store);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, undefined, tokens));
  const userPassword = 'A-test-password-' + randomUUID();

  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); }
    finally { await session.close(); }
  }

  let peerNumber = 0;
  function client() {
    const peer = `198.51.100.${++peerNumber}`;
    let cookie = '';
    return {
      async request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
        const response = await app.request(origin + '/api' + path, {
          method,
          headers: {
            Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
            'x-kannabi-client-ip': peer, ...extra,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = response.headers.getSetCookie();
        if (set.length) cookie = set.map((value) => value.split(';')[0]).join('; ');
        return response;
      },
      cookie: () => cookie,
    };
  }

  /** A machine caller: a bearer credential, no cookie, and no browser Origin. */
  const bearer = (secret: string) => async (path: string, method = 'GET', body?: unknown,
    extra: Record<string, string> = {}) => app.request(origin + '/api' + path, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const owner = client();
  const outsider = client();
  const people: Record<string, { key: string; name: string }> = {};
  let ownerGroup = '';
  let outsiderGroup = '';
  let ownedAsset = '';
  let foreignAsset = '';

  await t.test('two accounts, separate Groups, and one private Asset each', async () => {
    for (const [name, caller] of [['owner', owner], ['outsider', outsider]] as const) {
      const signup = await caller.request('/auth/sign-up/email', 'POST',
        { name: `Token ${name}`, email: `token-${name}@example.com`, password: userPassword });
      assert.equal(signup.status, 200, await signup.clone().text());
      people[name] = (await (await caller.request('/me')).json()).user;
    }
    ownerGroup = (await (await owner.request('/groups', 'POST', { name: 'Token owner team' })).json()).group.key;
    outsiderGroup = (await (await outsider.request('/groups', 'POST', { name: 'Token outsider team' })).json()).group.key;
    ownedAsset = (await (await owner.request('/assets', 'POST',
      { name: 'Owner bench', groupKey: ownerGroup })).json()).asset.id;
    foreignAsset = (await (await outsider.request('/assets', 'POST',
      { name: 'Outsider bench', groupKey: outsiderGroup })).json()).asset.id;
    assert.ok(ownedAsset && foreignAsset);
  });

  await t.test('a browser write records the User as asserting the change directly', async () => {
    const response = await owner.request(`/assets/${ownedAsset}`, 'PATCH', { name: 'Owner bench 2' });
    assert.equal(response.status, 200);
    const { asset } = await response.json();
    assert.equal(asset.provenance.assertedBy, null);
    assert.deepEqual(asset.provenance.acceptedBy, { ...people.owner, status: 'active' });
    assert.equal(asset.provenance.basis, null);
  });

  let ordinarySecret = '';
  let ordinaryId = '';

  await t.test('a User issues a token for themself and sees the secret exactly once', async () => {
    const created = await owner.request('/api-tokens', 'POST', { label: 'Bench integration', lifetimeDays: null });
    assert.equal(created.status, 201);
    const issued = await created.json();
    ordinarySecret = issued.secret;
    ordinaryId = issued.token.id;
    assert.ok(ordinarySecret.length > 16);
    assert.equal(issued.token.label, 'Bench integration');
    assert.equal(issued.token.admin, false);
    assert.equal(issued.token.expiresAt, null);
    // The listing is the token, never the secret.
    const listed = (await (await owner.request('/api-tokens')).json()).tokens;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, ordinaryId);
    assert.equal('secret' in listed[0], false);
    assert.equal('token' in listed[0], false);
    // A browser session is not an API token and never appears here.
    const sessions = await query('MATCH (s:AuthSession) RETURN count(s) AS n');
    assert.ok(sessions.records[0].get('n').toNumber() > listed.length);
    // Another User's tokens are their own.
    assert.deepEqual((await (await outsider.request('/api-tokens')).json()).tokens, []);
  });

  await t.test('a token authenticates as its owner and asserts the change as a credential', async () => {
    const call = bearer(ordinarySecret);
    const me = await (await call('/me')).json();
    assert.equal(me.user.key, people.owner.key);
    const response = await call(`/assets/${ownedAsset}`, 'PATCH', { name: 'Owner bench 3' });
    assert.equal(response.status, 200);
    const { asset } = await response.json();
    // Accepted under the owning User's authority; asserted by the credential.
    assert.deepEqual(asset.provenance.acceptedBy, { ...people.owner, status: 'active' });
    assert.deepEqual(asset.provenance.assertedBy, { id: ordinaryId, label: 'Bench integration' });
  });

  await t.test('a token reaches exactly what its owner reaches, and no more', async () => {
    const call = bearer(ordinarySecret);
    // The owner is not in the outsider's Group, so neither is the credential.
    assert.equal((await call(`/assets/${foreignAsset}`)).status, 404);
    assert.equal((await call(`/assets/${foreignAsset}`, 'PATCH', { name: 'Taken' })).status, 404);
    assert.equal((await call(`/assets/${ownedAsset}`)).status, 200);
    // Group membership is read live, so a change lands on the next request.
    await query(`MATCH (u:User {key: $userKey}), (g:Group {key: $groupKey}) MERGE (u)-[:MEMBER_OF]->(g)`,
      { userKey: people.owner.key, groupKey: outsiderGroup });
    assert.equal((await call(`/assets/${foreignAsset}`)).status, 200);
    await query(`MATCH (:User {key: $userKey})-[m:MEMBER_OF]->(:Group {key: $groupKey}) DELETE m`,
      { userKey: people.owner.key, groupKey: outsiderGroup });
    assert.equal((await call(`/assets/${foreignAsset}`)).status, 404);
  });

  await t.test('an ordinary token may not exercise administrator operations', async () => {
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: people.owner.key });
    // The owning User is an administrator; the credential still is not.
    assert.equal((await owner.request('/members')).status, 200);
    const call = bearer(ordinarySecret);
    assert.equal((await call('/members')).status, 403);
    assert.equal((await call('/settings', 'PATCH', { requirePhoto: true, displayTimezone: 'UTC',
      themeId: 'default', apiTokenMaxLifetimeDays: null })).status, 403);
    assert.equal((await call('/admin/mail')).status, 403);
    // Reading instance settings is not an administrator operation.
    assert.equal((await call('/settings')).status, 200);
  });

  let adminSecret = '';

  await t.test('an admin-enabled token exercises admin authority only while its owner holds it', async () => {
    // Only a current administrator may issue one.
    assert.equal((await outsider.request('/api-tokens', 'POST',
      { label: 'Not allowed', lifetimeDays: null, admin: true })).status, 400);
    const created = await owner.request('/api-tokens', 'POST',
      { label: 'Admin automation', lifetimeDays: null, admin: true });
    assert.equal(created.status, 201);
    const issued = await created.json();
    adminSecret = issued.secret;
    assert.equal(issued.token.admin, true);
    const call = bearer(adminSecret);
    assert.equal((await call('/members')).status, 200);
    // The flag is a ceiling on the credential, never a grant of Asset access.
    assert.equal((await call(`/assets/${foreignAsset}`)).status, 404);
    assert.equal((await call(`/assets/${foreignAsset}`, 'PATCH', { name: 'Taken' })).status, 404);
    // Administrative authority is read from the User at request time, so it
    // ends when the role does rather than being captured in the credential.
    await query("MATCH (u:User {key: $key}) REMOVE u.role", { key: people.owner.key });
    assert.equal((await call('/members')).status, 403);
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: people.owner.key });
    assert.equal((await call('/members')).status, 200);
  });

  await t.test('a bearer credential never falls back to a cookie, and cookies still need the Origin', async () => {
    // A valid cookie alongside a meaningless bearer must not authenticate:
    // otherwise attaching any Authorization header would opt a cookie request
    // out of the Origin check.
    const withCookie = await app.request(origin + '/api/assets/' + ownedAsset, {
      method: 'PATCH',
      headers: {
        Cookie: owner.cookie(), Authorization: 'Bearer not-a-real-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Should not apply' }),
    });
    assert.equal(withCookie.status, 401);
    assert.equal((await (await owner.request(`/assets/${ownedAsset}`)).json()).asset.name, 'Owner bench 3');
    // A cookie-authenticated write still requires the exact application Origin.
    const wrongOrigin = await app.request(origin + '/api/assets/' + ownedAsset, {
      method: 'PATCH',
      headers: { Cookie: owner.cookie(), Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cross site' }),
    });
    assert.equal(wrongOrigin.status, 403);
    // A bearer write needs no browser Origin at all.
    assert.equal((await bearer(ordinarySecret)(`/assets/${ownedAsset}`, 'PATCH',
      { name: 'Owner bench 4' })).status, 200);
  });

  await t.test('basis is an opaque bounded reference, carried identically by every mutation', async () => {
    const call = bearer(ordinarySecret);
    const withBasis = await call(`/assets/${ownedAsset}`, 'PATCH', { name: 'Owner bench 5' },
      { 'X-Kannabi-Basis': 'depot:assets:123' });
    assert.equal(withBasis.status, 200);
    assert.equal((await withBasis.json()).asset.provenance.basis, 'depot:assets:123');
    // A later change without one replaces the whole record rather than
    // inheriting the previous reference.
    assert.equal((await (await call(`/assets/${ownedAsset}`, 'PATCH',
      { name: 'Owner bench 6' })).json()).asset.provenance.basis, null);
    // Identifier attachment and bodyless detachment carry it the same way.
    const attached = await call(`/assets/${ownedAsset}/identifiers`, 'POST',
      { scheme: 'gtin', gtin: '0614141123452' }, { 'X-Kannabi-Basis': 'erp:equipment:4567' });
    assert.equal(attached.status, 201);
    const attachedAsset = (await attached.json()).asset;
    assert.equal(attachedAsset.provenance.basis, 'erp:equipment:4567');
    const detached = await call(`/assets/${ownedAsset}/identifiers/${attachedAsset.identifiers[0].key}`,
      'DELETE', undefined, { 'X-Kannabi-Basis': 'erp:equipment:4568' });
    assert.equal(detached.status, 200);
    assert.equal((await detached.json()).asset.provenance.basis, 'erp:equipment:4568');
    // The lexical contract is the whole of it: a reference, never prose,
    // evidence, or anything that would be unsafe to publish.
    // Non-ASCII cannot even be placed in a request header, so the transport
    // refuses it before Kannabi does; the validator's own rejection of it is
    // covered where the contract lives rather than here.
    for (const basis of ['has space', '_leading', '-leading', 'x'.repeat(129), 'semi;colon', 'at@sign']) {
      const rejected = await call(`/assets/${ownedAsset}`, 'PATCH', { name: 'Rejected' },
        { 'X-Kannabi-Basis': basis });
      assert.equal(rejected.status, 400, basis);
    }
    // A rejected basis leaves the Asset untouched, and a valid one grants
    // nothing: it is metadata, not a key.
    assert.equal((await (await call(`/assets/${ownedAsset}`)).json()).asset.name, 'Owner bench 6');
    assert.equal((await bearer(ordinarySecret)(`/assets/${foreignAsset}`, 'PATCH', { name: 'Taken' },
      { 'X-Kannabi-Basis': 'depot:assets:123' })).status, 404);
  });

  await t.test('a renamed or revoked token leaves historical provenance intact', async () => {
    const before = (await (await owner.request(`/assets/${ownedAsset}`)).json()).asset.provenance;
    assert.deepEqual(before.assertedBy, { id: ordinaryId, label: 'Bench integration' });
    // The label is a snapshot taken at the write, so renaming the credential
    // cannot rewrite what history says happened.
    await query("MATCH (s:AuthSession {id: $id}) SET s.apiTokenLabel = 'Renamed'", { id: ordinaryId });
    assert.deepEqual((await (await owner.request(`/assets/${ownedAsset}`)).json()).asset.provenance.assertedBy,
      { id: ordinaryId, label: 'Bench integration' });
    // Revocation stops the credential without making the record unreadable.
    assert.equal((await owner.request(`/api-tokens/${ordinaryId}`, 'DELETE')).status, 200);
    assert.equal((await bearer(ordinarySecret)('/me')).status, 200);
    assert.equal((await (await bearer(ordinarySecret)('/me')).json()).user, null);
    assert.equal((await bearer(ordinarySecret)(`/assets/${ownedAsset}`, 'PATCH', { name: 'Gone' })).status, 401);
    assert.deepEqual((await (await owner.request(`/assets/${ownedAsset}`)).json()).asset.provenance.assertedBy,
      { id: ordinaryId, label: 'Bench integration' });
    // Revoking one credential does not touch another.
    assert.equal((await bearer(adminSecret)('/me')).status, 200);
  });

  await t.test('an expired token and a deactivated owner both fail closed', async () => {
    const issued = await (await owner.request('/api-tokens', 'POST',
      { label: 'Short lived', lifetimeDays: 1 })).json();
    const call = bearer(issued.secret);
    assert.equal((await (await call('/me')).json()).user.key, people.owner.key);
    assert.notEqual(issued.token.expiresAt, null);
    // The expiry is absolute: reads never slide it forward.
    await query("MATCH (s:AuthSession {id: $id}) SET s.expiresAt = datetime() - duration('P1D')",
      { id: issued.token.id });
    assert.equal((await (await call('/me')).json()).user, null);
    assert.equal((await call(`/assets/${ownedAsset}`, 'PATCH', { name: 'Expired' })).status, 401);

    // Deactivating the owner removes sessions and memberships together, so the
    // credential authenticates as nobody and would reach nothing either way.
    const doomed = await (await outsider.request('/api-tokens', 'POST',
      { label: 'Outsider automation', lifetimeDays: null })).json();
    const doomedCall = bearer(doomed.secret);
    assert.equal((await (await doomedCall('/me')).json()).user.key, people.outsider.key);
    await store.deactivateMember(people.owner.key, people.outsider.key);
    assert.equal((await (await doomedCall('/me')).json()).user, null);
    assert.equal((await doomedCall(`/assets/${foreignAsset}`)).status, 404);
  });

  await t.test('instance policy bounds a token lifetime and is read at creation', async () => {
    assert.equal((await owner.request('/settings', 'PATCH', { requirePhoto: false,
      displayTimezone: 'UTC', themeId: 'default', apiTokenMaxLifetimeDays: 7 })).status, 200);
    // No-expiry is refused while a ceiling is configured, and so is a longer one.
    assert.equal((await owner.request('/api-tokens', 'POST',
      { label: 'Forever', lifetimeDays: null })).status, 400);
    assert.equal((await owner.request('/api-tokens', 'POST',
      { label: 'Too long', lifetimeDays: 8 })).status, 400);
    const allowed = await owner.request('/api-tokens', 'POST', { label: 'Within policy', lifetimeDays: 7 });
    assert.equal(allowed.status, 201);
    assert.notEqual((await allowed.json()).token.expiresAt, null);
    assert.equal((await owner.request('/settings', 'PATCH', { requirePhoto: false,
      displayTimezone: 'UTC', themeId: 'default', apiTokenMaxLifetimeDays: null })).status, 200);
  });

  await t.test('an administrator revokes a credential but never creates one', async () => {
    const victim = client();
    assert.equal((await victim.request('/auth/sign-up/email', 'POST',
      { name: 'Token victim', email: 'token-victim@example.com', password: userPassword })).status, 200);
    const victimKey = (await (await victim.request('/me')).json()).user.key;
    const issued = await (await victim.request('/api-tokens', 'POST',
      { label: 'Victim automation', lifetimeDays: null })).json();
    assert.equal((await (await bearer(issued.secret)('/me')).json()).user.key, victimKey);
    // There is no route by which an administrator obtains somebody else's
    // credential, because that would hand over their Group-derived access.
    const owned = (await (await owner.request('/api-tokens')).json()).tokens;
    assert.equal(owned.some((entry: { id: string }) => entry.id === issued.token.id), false);
    // Stopping one is instance administration and is allowed.
    assert.equal((await owner.request(`/members/${victimKey}/api-tokens/${issued.token.id}`, 'DELETE')).status, 200);
    assert.equal((await (await bearer(issued.secret)('/me')).json()).user, null);
    // A non-administrator cannot revoke somebody else's credential.
    const second = await (await victim.request('/api-tokens', 'POST',
      { label: 'Victim automation 2', lifetimeDays: null })).json();
    assert.equal((await victim.request(`/members/${victimKey}/api-tokens/${second.token.id}`, 'DELETE')).status, 403);
    assert.equal((await (await bearer(second.secret)('/me')).json()).user.key, victimKey);
  });

  await t.test('allocation authority stays independent of the asserting credential', async () => {
    const namespace = await store.configureGiaiNamespace(people.owner.key, ownerGroup, { gcp: '0991122' });
    const call = bearer(adminSecret);
    const allocated = await call(`/assets/${ownedAsset}/giai`, 'POST', { namespaceKey: namespace.key },
      { 'X-Kannabi-Basis': 'depot:assets:900' });
    assert.equal(allocated.status, 200);
    const { asset } = await allocated.json();
    // The ledger records the authorizing User, never the credential, and the
    // credential appears only where it belongs.
    assert.deepEqual(asset.allocation.allocatedBy, { ...people.owner, status: 'active' });
    assert.equal(asset.provenance.assertedBy.label, 'Admin automation');
    assert.equal(asset.provenance.basis, 'depot:assets:900');
  });
});
