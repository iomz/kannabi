import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';
import { MailDeliveryError, type Mailer, type MailMessage } from './mail.js';
import { passwordResetPrefix } from './password-recovery.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const databasePassword = process.env.KANNABI_TEST_NEO4J_PASSWORD;

class CaptureMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  attempts = 0;
  fail = false;

  async send(message: MailMessage): Promise<void> {
    this.attempts++;
    if (this.fail) throw new MailDeliveryError('disabled', 'private mail state');
    this.messages.push(message);
  }

  async waitForAttempts(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && this.attempts < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(this.attempts >= count, `expected ${count} mail attempts, received ${this.attempts}`);
  }
}

function tokenFrom(message: MailMessage): string {
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, 'reset message must contain a link');
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  assert.ok(token, 'reset link must contain a fragment token');
  return token;
}

test('Better Auth password recovery uses Mailer, consumes tokens, clears siblings, and revokes sessions',
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
      const peer = `192.0.2.${++clientNumber}`;
      let cookie = '';
      return {
        cookie: () => cookie,
        async request(path: string, method = 'GET', body?: unknown, requestOrigin = origin) {
          const response = await app.request(origin + '/api' + path, { method,
            headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json',
              'x-kannabi-client-ip': peer },
            body: body === undefined ? undefined : JSON.stringify(body) });
          if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()
            .map((value) => value.split(';')[0]).join('; ');
          return response;
        },
      };
    }

    const oldPassword = 'old-password-12345';
    const newPassword = 'new-password-67890';
    const firstSession = client();
    const secondSession = client();
    assert.equal((await firstSession.request('/auth/sign-up/email', 'POST', {
      name: 'Recovery User', email: 'recovery@example.com', password: oldPassword,
    })).status, 200);
    assert.equal((await secondSession.request('/auth/sign-in/email', 'POST', {
      email: 'recovery@example.com', password: oldPassword,
    })).status, 200);

    await t.test('existing and missing accounts receive same public response', async () => {
      const existing = await client().request('/auth/request-password-reset', 'POST', { email: 'recovery@example.com' });
      const missing = await client().request('/auth/request-password-reset', 'POST', { email: 'missing@example.com' });
      assert.equal(existing.status, 200);
      assert.equal(missing.status, 200);
      assert.deepEqual(await existing.json(), await missing.json());
      await mailer.waitForAttempts(1);
      assert.equal(mailer.messages.length, 1);
    });

    const firstToken = tokenFrom(mailer.messages[0]);
    let siblingToken = '';
    await t.test('stored identifiers are hashed and sibling links are independently issued', async () => {
      assert.equal((await client().request('/auth/request-password-reset', 'POST', {
        email: 'recovery@example.com',
      })).status, 200);
      await mailer.waitForAttempts(2);
      siblingToken = tokenFrom(mailer.messages[1]);
      assert.notEqual(firstToken, siblingToken);
      const session = driver.session();
      try {
        const result = await session.run(`MATCH (v:AuthVerification)
          WHERE v.identifier STARTS WITH $prefix
          RETURN v.identifier AS identifier ORDER BY v.createdAt`, { prefix: passwordResetPrefix });
        assert.equal(result.records.length, 2);
        for (const record of result.records) {
          const identifier = String(record.get('identifier'));
          assert.ok(identifier.startsWith(passwordResetPrefix));
          assert.ok(!identifier.includes(firstToken));
          assert.ok(!identifier.includes(siblingToken));
        }
      } finally { await session.close(); }
    });

    await t.test('successful reset rejects sibling and revokes every existing session', async () => {
      const reset = await client().request('/auth/reset-password', 'POST', {
        newPassword, token: firstToken,
      });
      assert.equal(reset.status, 200, await reset.clone().text());
      assert.equal((await client().request('/auth/reset-password', 'POST', {
        newPassword: 'another-password-12345', token: siblingToken,
      })).status, 400);
      assert.equal((await (await firstSession.request('/me')).json()).user, null);
      assert.equal((await (await secondSession.request('/me')).json()).user, null);
      const session = driver.session();
      try {
        const result = await session.run(`MATCH (v:AuthVerification)
          WHERE v.identifier STARTS WITH $prefix RETURN count(v) AS count`, { prefix: passwordResetPrefix });
        assert.equal(result.records[0].get('count').toNumber(), 0);
      } finally { await session.close(); }
      assert.notEqual((await client().request('/auth/sign-in/email', 'POST', {
        email: 'recovery@example.com', password: oldPassword,
      })).status, 200);
      assert.equal((await client().request('/auth/sign-in/email', 'POST', {
        email: 'recovery@example.com', password: newPassword,
      })).status, 200);
    });

    await t.test('expired and already consumed tokens fail safely', async () => {
      assert.equal((await client().request('/auth/reset-password', 'POST', {
        newPassword, token: firstToken,
      })).status, 400);
      const before = mailer.messages.length;
      assert.equal((await client().request('/auth/request-password-reset', 'POST', {
        email: 'recovery@example.com',
      })).status, 200);
      await mailer.waitForAttempts(before + 1);
      const expiredToken = tokenFrom(mailer.messages.at(-1)!);
      const session = driver.session();
      try {
        await session.run(`MATCH (v:AuthVerification)
          WHERE v.identifier STARTS WITH $prefix SET v.expiresAt = $expired`,
        { prefix: passwordResetPrefix, expired: new Date(0).toISOString() });
      } finally { await session.close(); }
      assert.equal((await client().request('/auth/reset-password', 'POST', {
        newPassword: 'expired-password-12345', token: expiredToken,
      })).status, 400);
    });

    await t.test('one token has one concurrent winner', async () => {
      const before = mailer.messages.length;
      assert.equal((await client().request('/auth/request-password-reset', 'POST', {
        email: 'recovery@example.com',
      })).status, 200);
      await mailer.waitForAttempts(before + 1);
      const token = tokenFrom(mailer.messages.at(-1)!);
      const responses = await Promise.all([client(), client()].map((caller, index) => caller.request(
        '/auth/reset-password', 'POST', { newPassword: `concurrent-password-${index}-12345`, token })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    });

    await t.test('mail failure stays generic and logs no reset credential', async () => {
      mailer.fail = true;
      const original = console.error;
      const logs: unknown[][] = [];
      console.error = (...values: unknown[]) => { logs.push(values); };
      try {
        const attempts = mailer.attempts;
        const response = await client().request('/auth/request-password-reset', 'POST', {
          email: 'recovery@example.com',
        });
        assert.equal(response.status, 200);
        assert.match((await response.json()).message, /If this email exists/);
        await mailer.waitForAttempts(attempts + 1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(logs, [['Password recovery mail delivery failed', { category: 'disabled' }]]);
        const serialized = JSON.stringify(logs);
        assert.ok(!serialized.includes('recovery@example.com'));
        assert.ok(!serialized.includes('reset-password'));
      } finally { console.error = original; mailer.fail = false; }
    });

    await t.test('request endpoint uses Better Auth per-peer rate limiting', async () => {
      const caller = client();
      const statuses: number[] = [];
      for (let index = 0; index < 4; index++) statuses.push((await caller.request(
        '/auth/request-password-reset', 'POST', { email: `absent-${index}@example.com` })).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
    });

    await t.test('credential-less users retain Better Auth linking semantics', async () => {
      const account = client();
      assert.equal((await account.request('/auth/sign-up/email', 'POST', {
        name: 'Link User', email: 'link@example.com', password: oldPassword,
      })).status, 200);
      const session = driver.session();
      try {
        await session.run(`MATCH (u:User {email: $email})-[:HAS_AUTHACCOUNT]->(a:AuthAccount)
          DETACH DELETE a`, { email: 'link@example.com' });
      } finally { await session.close(); }
      const before = mailer.messages.length;
      assert.equal((await client().request('/auth/request-password-reset', 'POST', {
        email: 'link@example.com',
      })).status, 200);
      await mailer.waitForAttempts(before + 1);
      const token = tokenFrom(mailer.messages.at(-1)!);
      assert.equal((await client().request('/auth/reset-password', 'POST', {
        newPassword, token,
      })).status, 200);
      assert.equal((await client().request('/auth/sign-in/email', 'POST', {
        email: 'link@example.com', password: newPassword,
      })).status, 200);
    });
  });
