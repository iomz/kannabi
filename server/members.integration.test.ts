import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import type { Mailer, MailMessage } from './mail.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

class CaptureMailer implements Mailer {
  messages: MailMessage[] = [];
  async send(message: MailMessage) { this.messages.push(message); }
  async waitFor(count: number) {
    for (let attempt = 0; attempt < 100 && this.messages.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(this.messages.length >= count);
  }
}

function resetToken(message: MailMessage) {
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  assert.ok(token);
  return token;
}

test('administrator-controlled member lifecycle preserves auth and domain invariants',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver);
    const origin = 'http://localhost:3000';
    const mailer = new CaptureMailer();
    const auth = await createAuth(driver, origin, randomUUID() + randomUUID(), mailer);
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin));
    function client(peer: number) {
      let cookie = '';
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, { method,
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
            'x-kannabi-client-ip': `192.0.2.${peer}` },
          body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()
          .map((value) => value.split(';')[0]).join('; ');
        return response;
      };
    }

    const admin = client(1), member = client(2), anonymous = client(3);
    const keys: string[] = [];
    for (const [index, caller] of [admin, member].entries()) {
      const response = await caller('/auth/sign-up/email', 'POST', { name: `Member ${index}`,
        email: `member${index}@example.com`, password: 'test-password-12345' });
      assert.equal(response.status, 200);
      keys.push((await (await caller('/me')).json()).user.key);
    }
    const setup = driver.session();
    await setup.run("MATCH (u:User {key: $key}) SET u.isAdmin = true REMOVE u.role", { key: keys[0] });
    await setup.close();
    await IdentityStore.open(driver);
    const migrated = driver.session();
    const migration = await migrated.run(`MATCH (u:User {key: $key})
      RETURN u.role AS role, u.isAdmin IS NULL AS legacyRemoved`, { key: keys[0] });
    assert.equal(migration.records[0].get('role'), 'admin');
    assert.equal(migration.records[0].get('legacyRemoved'), true);
    await migrated.close();

    await t.test('admin plugin routes stay private and non-admin lifecycle requests fail', async () => {
      assert.equal((await anonymous('/members')).status, 401);
      assert.equal((await member('/members')).status, 403);
      assert.equal((await member('/members', 'POST', {
        name: 'Forbidden', email: 'forbidden@example.com', isAdmin: false,
      })).status, 403);
      assert.equal((await admin('/auth/admin/create-user', 'POST', {
        name: 'Bypass', email: 'bypass@example.com',
      })).status, 404);
    });

    await t.test('self-service profile and appearance remain isolated', async () => {
      assert.equal((await member('/profile', 'PATCH', { name: 'Self renamed' })).status, 200);
      assert.equal((await (await member('/me')).json()).user.name, 'Self renamed');
      assert.equal((await member('/profile', 'PATCH', { name: 'Bad', email: 'changed@example.com' })).status, 400);
      assert.equal((await member('/profile/appearance', 'PATCH', { appearance: 'light' })).status, 200);
      assert.equal((await admin('/profile/appearance', 'PATCH', { appearance: 'dark' })).status, 200);
      assert.equal((await (await member('/me')).json()).appearance, 'light');
      assert.equal((await (await admin('/me')).json()).appearance, 'dark');
    });

    await t.test('self-service deletion uses tombstone semantics and protects the final administrator', async () => {
      const adminProfile = await (await admin('/profile')).json();
      assert.equal(adminProfile.deletionBlocked, true);
      const protectedResponse = await admin('/profile', 'DELETE');
      assert.equal(protectedResponse.status, 409);
      assert.match((await protectedResponse.json()).error, /final system administrator/i);
      assert.ok((await (await admin('/me')).json()).user);

      const selfDeleting = client(11);
      assert.equal((await selfDeleting('/auth/sign-up/email', 'POST', { name: 'Self deleting member',
        email: 'self-delete@example.com', password: 'test-password-12345' })).status, 200);
      assert.equal((await (await selfDeleting('/profile')).json()).deletionBlocked, false);
      const selfKey = (await (await selfDeleting('/me')).json()).user.key;
      const account = await store.memberAccount(keys[0], selfKey);
      const group = await store.createReportingGroup('Self deletion group', selfKey);
      const identifier = { scheme: 'sgtin' as const, gtin: '00614141123452', serial: 'SELF-DELETED' };
      const asset = await store.reportAsset({ name: 'Self-deleted provenance', identifiers: [identifier] },
        { actorKey: selfKey, groupKey: group.key });
      assert.deepEqual(asset.reportedBy, { key: selfKey, name: 'Self deleting member', status: 'active' });
      await store.updateAsset(asset.id, { isPublic: true }, selfKey);
      assert.equal((await selfDeleting('/auth/request-password-reset', 'POST', {
        email: 'self-delete@example.com', redirectTo: origin + '/reset-password',
      })).status, 200);
      assert.equal((await selfDeleting('/profile', 'DELETE')).status, 200);
      assert.equal((await (await selfDeleting('/me')).json()).user, null);

      const session = driver.session();
      try {
        const result = await session.run(`MATCH (a:Asset {name: 'Self-deleted provenance'})-[:REPORTED_BY]->(u:User {key: $key}),
          (g:Group {key: $groupKey})
          OPTIONAL MATCH (u)-[:HAS_AUTHACCOUNT|HAS_AUTHSESSION|MEMBER_OF]->(state)
          RETURN u.id IS NULL AS deleted, u.name IS NULL AS activeNameRemoved, u.email IS NULL AS anonymized,
            u.accountDeletedAt IS NOT NULL AS marked, u.key AS reporterKey, u.provenanceName AS provenanceName,
            count(state) AS stateCount,
            count { (g)<-[:MEMBER_OF]-() } AS groupMembers,
            count { MATCH (v:AuthVerification) WHERE v.value = $userId } AS verificationCount`,
        { key: selfKey, groupKey: group.key, userId: account.id });
        const row = result.records[0];
        assert.equal(row.get('deleted'), true);
        assert.equal(row.get('activeNameRemoved'), true);
        assert.equal(row.get('anonymized'), true);
        assert.equal(row.get('marked'), true);
        assert.equal(row.get('reporterKey'), asset.reportedBy.key);
        assert.equal(row.get('provenanceName'), 'Self deleting member');
        assert.equal(row.get('stateCount').toNumber(), 0);
        assert.equal(row.get('groupMembers').toNumber(), 0);
        assert.equal(row.get('verificationCount').toNumber(), 0);
      } finally { await session.close(); }
      const publicAsset = await anonymous('/assets/' + asset.id);
      assert.equal(publicAsset.status, 200);
      assert.deepEqual((await publicAsset.json()).asset.reportedBy,
        { key: selfKey, name: 'Self deleting member', status: 'deleted' });
      await assert.rejects(store.createReportingGroup('Rejected tombstone group', selfKey), /User does not exist/);
      const replacement = await admin('/members', 'POST', {
        name: 'Self-delete replacement', email: 'self-delete@example.com', isAdmin: false,
      });
      assert.equal(replacement.status, 201, await replacement.clone().text());
    });

    let pendingKey = '';
    await t.test('creation issues setup link and Better Auth establishes credential', async () => {
      const before = mailer.messages.length;
      const response = await admin('/members', 'POST', {
        name: 'Pending Member', email: 'pending@example.com', isAdmin: false,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const created = await response.json();
      pendingKey = created.member.key;
      assert.equal(created.member.credentialState, 'pending');
      await mailer.waitFor(before + 1);
      const setupMessage = mailer.messages.at(-1)!;
      assert.equal(setupMessage.subject, 'Set up your Kannabi account');
      assert.equal((await client(4)('/auth/reset-password', 'POST', {
        token: resetToken(setupMessage), newPassword: 'established-password-12345',
      })).status, 200);
      assert.equal((await client(5)('/auth/sign-in/email', 'POST', {
        email: 'pending@example.com', password: 'established-password-12345',
      })).status, 200);
      const listed = await (await admin('/members')).json();
      assert.equal(listed.members.find((item: { key: string }) => item.key === pendingKey).credentialState, 'established');
    });

    await t.test('admin identity edit uses Better Auth, rejects self email, and revokes target sessions', async () => {
      assert.equal((await admin(`/members/${keys[0]}`, 'PATCH', {
        name: 'Admin renamed', email: 'admin-new@example.com',
      })).status, 409);
      const changed = await admin(`/members/${keys[1]}`, 'PATCH', {
        name: 'Edited member', email: 'edited@example.com',
      });
      assert.equal(changed.status, 200, await changed.clone().text());
      assert.equal((await (await member('/me')).json()).user, null);
      assert.notEqual((await client(6)('/auth/sign-in/email', 'POST', {
        email: 'member1@example.com', password: 'test-password-12345',
      })).status, 200);
      assert.equal((await client(7)('/auth/sign-in/email', 'POST', {
        email: 'edited@example.com', password: 'test-password-12345',
      })).status, 200);
    });

    await t.test('recovery action sends existing Better Auth reset flow', async () => {
      const before = mailer.messages.length;
      assert.equal((await admin(`/members/${keys[1]}/recovery`, 'POST')).status, 200);
      await mailer.waitFor(before + 1);
      assert.equal(mailer.messages.at(-1)!.subject, 'Reset your Kannabi password');
      assert.match(mailer.messages.at(-1)!.text, /one hour/i);
    });

    await t.test('deactivation removes auth and memberships, preserves Group and provenance, and releases email', async () => {
      const targetClient = client(8);
      assert.equal((await targetClient('/auth/sign-in/email', 'POST', {
        email: 'edited@example.com', password: 'test-password-12345',
      })).status, 200);
      const group = await store.createReportingGroup('Former member group', keys[1]);
      const identifier = { scheme: 'sgtin' as const, gtin: '00614141123452', serial: 'DELETED-REPORTER' };
      const asset = await store.reportAsset({ name: 'Retained provenance', identifiers: [identifier] },
        { actorKey: keys[1], groupKey: group.key });
      assert.deepEqual(asset.reportedBy, { key: keys[1], name: 'Edited member', status: 'active' });
      await store.updateAsset(asset.id, { isPublic: true }, keys[1]);
      const targetAccount = await store.memberAccount(keys[0], keys[1]);
      assert.equal((await admin(`/members/${keys[0]}`, 'DELETE')).status, 403);
      assert.equal((await admin(`/members/${keys[1]}`, 'DELETE')).status, 200);
      assert.equal((await (await targetClient('/me')).json()).user, null);
      assert.notEqual((await client(9)('/auth/sign-in/email', 'POST', {
        email: 'edited@example.com', password: 'test-password-12345',
      })).status, 200);
      const session = driver.session();
      try {
        const result = await session.run(`MATCH (a:Asset {name: 'Retained provenance'})-[:REPORTED_BY]->(u:User {key: $key}),
          (g:Group {key: $groupKey})
          OPTIONAL MATCH (u)-[:HAS_AUTHACCOUNT|HAS_AUTHSESSION|MEMBER_OF]->(state)
          RETURN u.id IS NULL AS deleted, u.name IS NULL AS activeNameRemoved, u.email IS NULL AS anonymized,
            u.accountDeletedAt IS NOT NULL AS marked, u.key AS reporterKey, u.provenanceName AS provenanceName,
            count(state) AS stateCount,
            count { (g)<-[:MEMBER_OF]-() } AS groupMembers,
            count { MATCH (v:AuthVerification) WHERE v.value = $userId } AS verificationCount`,
        { key: keys[1], groupKey: group.key, userId: targetAccount.id });
        const row = result.records[0];
        assert.equal(row.get('deleted'), true);
        assert.equal(row.get('activeNameRemoved'), true);
        assert.equal(row.get('anonymized'), true);
        assert.equal(row.get('marked'), true);
        assert.equal(row.get('reporterKey'), asset.reportedBy.key);
        assert.equal(row.get('provenanceName'), 'Edited member');
        assert.equal(row.get('stateCount').toNumber(), 0);
        assert.equal(row.get('groupMembers').toNumber(), 0);
        assert.equal(row.get('verificationCount').toNumber(), 0);
      } finally { await session.close(); }
      const publicAsset = await anonymous('/assets/' + asset.id);
      assert.equal(publicAsset.status, 200);
      assert.deepEqual((await publicAsset.json()).asset.reportedBy,
        { key: keys[1], name: 'Edited member', status: 'deleted' });
      const inventory = await (await admin('/assets?q=Retained%20provenance')).json();
      assert.deepEqual(inventory.assets[0].reportedBy,
        { key: keys[1], name: 'Edited member', status: 'deleted' });
      const replacement = await admin('/members', 'POST', {
        name: 'Replacement', email: 'edited@example.com', isAdmin: false,
      });
      assert.equal(replacement.status, 201, await replacement.clone().text());
      const active = await (await admin('/members')).json();
      assert.ok(!active.members.some((item: { key: string }) => item.key === keys[1]));
    });

    await t.test('final administrator role protection remains atomic', async () => {
      const privateGroup = await store.createReportingGroup('Admin-only asset group', keys[0]);
      const privateAsset = await store.reportAsset({ name: 'Role-independent access',
        identifiers: [{ scheme: 'grai' as const, assetType: '0614141234561', serial: '789' }] },
      { actorKey: keys[0], groupKey: privateGroup.key });
      assert.equal((await admin(`/members/${keys[0]}/role`, 'PATCH', { isAdmin: false })).status, 409);
      assert.equal((await admin(`/members/${pendingKey}/role`, 'PATCH', { isAdmin: true })).status, 200);
      assert.equal(await store.getAsset(privateAsset.id, pendingKey), null);
      const secondAdmin = client(10);
      assert.equal((await secondAdmin('/auth/sign-in/email', 'POST', {
        email: 'pending@example.com', password: 'established-password-12345',
      })).status, 200);
      const responses = await Promise.all([
        admin(`/members/${pendingKey}/role`, 'PATCH', { isAdmin: false }),
        secondAdmin(`/members/${keys[0]}/role`, 'PATCH', { isAdmin: false }),
      ]);
      assert.equal(responses.filter((response) => response.status === 200).length, 1);
      const session = driver.session();
      try {
        const remaining = await session.run("MATCH (u:User {role: 'admin'}) WHERE u.id IS NOT NULL RETURN count(u) AS count");
        assert.equal(remaining.records[0].get('count').toNumber(), 1);
      } finally { await session.close(); }
    });
  });
