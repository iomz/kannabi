import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { ApiTokenService } from './api-token.js';
import type { Mailer, MailMessage } from './mail.js';

/** Admin-created accounts send a setup link, so something has to accept it. */
class DiscardMailer implements Mailer {
  async send(_message: MailMessage) { /* delivery is not what this suite is about */ }
}

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Admission: signing up makes an account, not a participant.
 *
 * By default a new account waits for an administrator. Until then it is
 * signed in to its own account and answered as an anonymous visitor
 * everywhere else: public Assets stay readable, and the directory, Groups and
 * every change are out of reach. Approval takes effect on the next request.
 */
test('a new account waits for approval, and reaches only itself and public Assets meanwhile',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver);
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomUUID() + randomUUID(), new DiscardMailer());
    const tokens = new ApiTokenService(auth, store);
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, undefined, tokens));
    let peer = 0;
    function client() {
      let cookie = '';
      const address = `192.0.2.${++peer}`;
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, {
          method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = response.headers.getSetCookie();
        if (set.length) cookie = set.map((value) => value.split(';')[0]).join('; ');
        return response;
      };
    }
    async function query(statement: string, params = {}) {
      const session = driver.session();
      try { return await session.run(statement, params); } finally { await session.close(); }
    }
    const json = async (response: Response | Promise<Response>) => {
      const resolved = await response;
      assert.ok(resolved.ok, `${resolved.status} ${await resolved.clone().text()}`);
      return resolved.json();
    };
    async function signUp(name: string) {
      const call = client();
      assert.equal((await call('/auth/sign-up/email', 'POST', { name, email: `admission-${name}-${randomUUID()}@example.com`,
        password: 'test-password-12345' })).status, 200);
      return { call, key: (await json(call('/me'))).user.key as string };
    }

    await t.test('approval is required by a new instance', async () => {
      assert.equal((await store.settings()).requireApproval, true);
    });

    // The first account becomes the administrator the way an operator makes
    // one, which also approves it.
    const admin = await signUp('admin');
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin', u.approvedAt = $now",
      { key: admin.key, now: new Date().toISOString() });
    const group = (await json(admin.call('/groups', 'POST', { name: 'Bench' }))).group;
    const privateAsset = (await json(admin.call('/assets', 'POST', { name: 'Private rig', groupKey: group.key }))).asset;
    const publicAsset = (await json(admin.call('/assets', 'POST', { name: 'Public rig', groupKey: group.key }))).asset;
    await json(admin.call(`/assets/${publicAsset.id}`, 'PATCH', { isPublic: true }));
    const applicant = await signUp('applicant');

    await t.test('a waiting account knows it is waiting, and keeps its own account', async () => {
      const me = await json(applicant.call('/me'));
      assert.equal(me.user.key, applicant.key);
      assert.equal(me.approved, false);
      assert.equal((await applicant.call('/profile')).status, 200);
      assert.equal((await applicant.call('/profile', 'PATCH', { name: 'Applicant renamed' })).status, 200);
      assert.equal((await applicant.call('/settings')).status, 200);
    });

    await t.test('a waiting account reads what anybody may read, and nothing more', async () => {
      assert.equal((await applicant.call(`/assets/${publicAsset.id}`)).status, 200, 'public Assets stay readable');
      assert.equal((await applicant.call(`/assets/${publicAsset.id}`, 'PATCH', { name: 'Taken' })).status, 401,
        'and public is never edit');
      assert.equal((await applicant.call(`/assets/${privateAsset.id}`)).status, 404);
      for (const path of ['/people', `/users/${admin.key}`, '/groups', `/groups/${group.key}`, '/api-tokens']) {
        assert.equal((await applicant.call(path)).status, 401, path);
      }
      assert.equal((await applicant.call('/groups', 'POST', { name: 'Mine' })).status, 401);
      // Nobody can find it, or add it to a Group.
      const people = (await json(admin.call('/people'))).people as { key: string }[];
      assert.ok(!people.some((person) => person.key === applicant.key));
      assert.equal((await admin.call(`/groups/${group.key}/members`, 'POST', { userKey: applicant.key })).status, 404);
    });

    await t.test('an administrator sees who waits, and approval takes effect on the next request', async () => {
      const users = (await json(admin.call('/admin/users'))).users as { key: string; approvedAt: string | null }[];
      assert.equal(users.find((user) => user.key === applicant.key)?.approvedAt, null);
      assert.equal((await applicant.call(`/admin/users/${applicant.key}/approval`, 'POST')).status, 401,
        'nobody approves themself');
      assert.deepEqual(await json(admin.call(`/admin/users/${applicant.key}/approval`, 'POST')), { changed: true });
      assert.deepEqual(await json(admin.call(`/admin/users/${applicant.key}/approval`, 'POST')), { changed: false });
      assert.equal((await json(applicant.call('/me'))).approved, true);
      assert.equal((await applicant.call('/people')).status, 200);
      assert.equal((await applicant.call('/groups', 'POST', { name: 'Mine' })).status, 201);
      // Approval is participation, never access: the private Asset is still
      // its Group's.
      assert.equal((await applicant.call(`/assets/${privateAsset.id}`)).status, 404);
    });

    await t.test('rejecting a waiting account deletes it, and its owner may apply again', async () => {
      const rejected = await signUp('rejected');
      assert.equal((await admin.call(`/admin/users/${rejected.key}`, 'DELETE')).status, 200);
      assert.equal((await rejected.call('/me').then((r) => r.json())).user, null, 'the session ends with the account');
      const users = (await json(admin.call('/admin/users'))).users as { key: string }[];
      assert.ok(!users.some((user) => user.key === rejected.key));
    });

    await t.test('an account an administrator creates, or makes an administrator, takes part at once', async () => {
      const created = await json(admin.call('/admin/users', 'POST',
        { name: 'Created', email: `admission-created-${randomUUID()}@example.com`, isAdmin: false }));
      const stored = await query('MATCH (u:User {key: $key}) RETURN u.approvedAt AS at', { key: created.user.key });
      assert.ok(stored.records[0].get('at'));
      const promoted = await signUp('promoted');
      assert.equal((await admin.call(`/admin/users/${promoted.key}/role`, 'PATCH', { isAdmin: true })).status, 200);
      assert.equal((await json(promoted.call('/me'))).approved, true);
    });

    await t.test('without the requirement, a new account takes part as soon as it signs up', async () => {
      const saved = await json(admin.call('/settings', 'PATCH', { requireApproval: false }));
      assert.equal(saved.settings.requireApproval, false);
      assert.equal(saved.settings.peopleDirectory, 'everyone', 'a change names only what it changes');
      const open = await signUp('open');
      assert.equal((await json(open.call('/me'))).approved, true);
      assert.equal((await open.call('/people')).status, 200);
      // Turning it back on leaves those already approved as they are.
      await json(admin.call('/settings', 'PATCH', { requireApproval: true }));
      assert.equal((await json(open.call('/me'))).approved, true);
      assert.equal((await json((await signUp('later')).call('/me'))).approved, false);
    });

    await t.test('only an administrator changes admission', async () => {
      assert.equal((await applicant.call('/settings', 'PATCH', { requireApproval: false })).ok, false);
      assert.equal((await store.settings()).requireApproval, true);
    });
  });
