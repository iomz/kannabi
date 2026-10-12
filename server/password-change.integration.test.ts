import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const databasePassword = process.env.KANNABI_TEST_NEO4J_PASSWORD;

test('Better Auth password change enforces credentials and replaces caller session',
  { skip: !uri || !databasePassword }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', databasePassword!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver);
    await admitSignups(driver);
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomBytes(32).toString('hex'));
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin));
    let clientNumber = 0;
    function client() {
      let cookie = '';
      const peer = `192.0.2.${++clientNumber}`;
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, { method,
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
            'x-kannabi-client-ip': peer },
          body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()
          .map((value) => value.split(';')[0]).join('; ');
        return response;
      };
    }

    const oldPassword = 'current-password-12345';
    const newPassword = 'replacement-password-67890';
    const current = client(), otherSession = client();
    assert.equal((await current('/auth/sign-up/email', 'POST', {
      name: 'Password User', email: 'password@example.com', password: oldPassword,
    })).status, 200);
    assert.equal((await otherSession('/auth/sign-in/email', 'POST', {
      email: 'password@example.com', password: oldPassword,
    })).status, 200);

    await t.test('wrong current password and short new password do not mutate credential', async () => {
      assert.equal((await current('/auth/change-password', 'POST', {
        currentPassword: 'wrong-password-12345', newPassword, revokeOtherSessions: true,
      })).status, 400);
      assert.equal((await current('/auth/change-password', 'POST', {
        currentPassword: oldPassword, newPassword: 'too-short', revokeOtherSessions: true,
      })).status, 400);
      assert.equal((await client()('/auth/sign-in/email', 'POST', {
        email: 'password@example.com', password: oldPassword,
      })).status, 200);
      assert.notEqual((await client()('/auth/sign-in/email', 'POST', {
        email: 'password@example.com', password: newPassword,
      })).status, 200);
    });

    await t.test('successful change preserves caller through replacement and revokes other sessions', async () => {
      const response = await current('/auth/change-password', 'POST', {
        currentPassword: oldPassword, newPassword, revokeOtherSessions: true,
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok((await response.json()).token);
      assert.ok((await (await current('/me')).json()).user);
      assert.equal((await (await otherSession('/me')).json()).user, null);
      assert.notEqual((await client()('/auth/sign-in/email', 'POST', {
        email: 'password@example.com', password: oldPassword,
      })).status, 200);
      assert.equal((await client()('/auth/sign-in/email', 'POST', {
        email: 'password@example.com', password: newPassword,
      })).status, 200);
    });
  });
