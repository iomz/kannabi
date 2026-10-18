import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';
import type { Mailer, MailMessage } from './mail.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const databasePassword = process.env.KANNABI_TEST_NEO4J_PASSWORD;

class CaptureMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> { this.messages.push(message); }
  async waitForMessages(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && this.messages.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(this.messages.length, count);
  }
}

test('self-service email change uses password step-up and becomes recovery identity',
  { skip: !uri || !databasePassword }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', databasePassword!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver);
    await admitSignups(driver);
    const origin = 'http://localhost:3000';
    const mailer = new CaptureMailer();
    const auth = await createAuth(driver, origin, randomBytes(32).toString('hex'), mailer);
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

    const password = 'current-password-12345';
    const first = client(), second = client(), other = client(), anonymous = client();
    assert.equal((await first('/auth/sign-up/email', 'POST', {
      name: 'Email Owner', email: 'old@example.com', password,
    })).status, 200);
    assert.equal((await second('/auth/sign-in/email', 'POST', {
      email: 'old@example.com', password,
    })).status, 200);
    assert.equal((await other('/auth/sign-up/email', 'POST', {
      name: 'Other User', email: 'taken@example.com', password,
    })).status, 200);

    await t.test('public Better Auth route cannot bypass password step-up', async () => {
      assert.equal((await first('/auth/change-email', 'POST', { newEmail: 'bypass@example.com' })).status, 404);
      assert.equal((await (await first('/profile')).json()).member.email, 'old@example.com');
    });

    await t.test('wrong password, malformed input, and duplicate address preserve identity', async () => {
      assert.equal((await first('/profile/email', 'PATCH', {
        newEmail: 'wrong@example.com', currentPassword: 'wrong-password-12345',
      })).status, 400);
      assert.equal((await first('/profile/email', 'PATCH', {
        newEmail: 'not-an-email', currentPassword: password,
      })).status, 400);
      assert.equal((await first('/profile/email', 'PATCH', {
        newEmail: 'taken@example.com', currentPassword: password,
      })).status, 409);
      assert.equal((await first('/profile/email', 'PATCH', {
        newEmail: 'extra@example.com', currentPassword: password, isAdmin: true,
      })).status, 400);
      assert.equal((await (await first('/profile')).json()).member.email, 'old@example.com');
      assert.equal((await (await other('/profile')).json()).member.email, 'taken@example.com');
    });

    await t.test('correct password changes sign-in identity and keeps existing sessions', async () => {
      const response = await first('/profile/email', 'PATCH', {
        newEmail: 'NEW@example.com', currentPassword: password,
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).member.email, 'new@example.com');
      assert.equal((await (await first('/me')).json()).user.name, 'Email Owner');
      assert.equal((await (await second('/profile')).json()).member.email, 'new@example.com');
      assert.notEqual((await anonymous('/auth/sign-in/email', 'POST', {
        email: 'old@example.com', password,
      })).status, 200);
      assert.equal((await client()('/auth/sign-in/email', 'POST', {
        email: 'new@example.com', password,
      })).status, 200);
    });

    await t.test('password recovery follows new address immediately', async () => {
      const oldResponse = await anonymous('/auth/request-password-reset', 'POST', { email: 'old@example.com' });
      const newResponse = await client()('/auth/request-password-reset', 'POST', { email: 'new@example.com' });
      assert.equal(oldResponse.status, 200);
      assert.equal(newResponse.status, 200);
      assert.deepEqual(await oldResponse.json(), await newResponse.json());
      await mailer.waitForMessages(1);
      assert.equal(mailer.messages[0].to, 'new@example.com');
    });
  });
