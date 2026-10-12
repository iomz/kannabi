import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { SMTPServer } from 'smtp-server';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';
import { MailService } from './mail.js';
import { MasterKeyManager } from './secrets.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

test('mail configuration, authorization, encrypted persistence, recovery, and SMTP delivery',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const data = mkdtempSync(join(tmpdir(), 'kannabi-mail-integration-'));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    const store = await IdentityStore.open(driver);
    await admitSignups(driver);
    const keyManager = await MasterKeyManager.open(await store.hasEncryptedSecrets(), { KANNABI_DATA_DIR: data });
    const mail = new MailService(store, keyManager);
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomBytes(32).toString('hex'), mail);
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, mail));

    const cookies = new Map<number, string>();
    function client(peer: number) {
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, { method,
          headers: { Origin: origin, Cookie: cookies.get(peer) ?? '', 'Content-Type': 'application/json',
            'x-kannabi-client-ip': `192.0.2.${peer}` },
          body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.getSetCookie().length) cookies.set(peer,
          response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '));
        return response;
      };
    }

    const admin = client(1), member = client(2), anonymous = client(3);
    for (const [index, caller] of [admin, member].entries()) {
      assert.equal((await caller('/auth/sign-up/email', 'POST', { name: `Mail ${index}`,
        email: `mail${index}@example.com`, password: 'test-password-12345' })).status, 200);
    }
    const adminKey = (await (await admin('/me')).json()).user.key;
    const session = driver.session();
    await session.run("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: adminKey });
    await session.close();

    await t.test('mail API is administrator-only and defaults disabled without secret disclosure', async () => {
      assert.equal((await anonymous('/admin/mail')).status, 401);
      assert.equal((await member('/admin/mail')).status, 403);
      const response = await admin('/admin/mail');
      assert.equal(response.status, 200);
      const { configuration } = await response.json();
      assert.equal(configuration.enabled, false);
      assert.equal(configuration.passwordState, 'none');
      assert.equal(configuration.operationalState, 'disabled');
      assert.equal(configuration.verificationStatus, 'not-verified');
      assert.equal(configuration.verificationObservedAt, null);
      assert.ok(!('smtpPasswordEnvelope' in configuration));
      assert.ok(!('smtpPassword' in configuration));
    });

    let received = '';
    const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, _session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => { received = Buffer.concat(chunks).toString('utf8'); callback(); });
      } });
    await new Promise<void>((resolve, reject) => smtp.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
    t.after(() => new Promise<void>((resolve) => smtp.close(() => resolve())));
    const address = (smtp as unknown as { server: { address(): { port: number } } }).server.address();

    await t.test('saved configuration drives real test delivery through Mailer', async () => {
      const update = await admin('/admin/mail', 'PUT', { revision: 0, enabled: true, transport: 'smtp',
        smtpHost: '127.0.0.1', smtpPort: address.port, smtpSecurity: 'none', smtpUsername: '',
        senderAddress: 'kannabi@example.com', senderName: 'Kannabi', password: { action: 'clear' } });
      assert.equal(update.status, 200, await update.clone().text());
      const configured = (await update.json()).configuration;
      assert.equal(configured.operationalState, 'configured');
      assert.equal(configured.verificationStatus, 'verified');
      assert.ok(configured.verificationObservedAt);
      assert.equal((await member('/admin/mail/test', 'POST', { recipient: 'recipient@example.com' })).status, 403);
      const sent = await admin('/admin/mail/test', 'POST', { recipient: 'recipient@example.com' });
      assert.equal(sent.status, 200, await sent.clone().text());
      assert.match(received, /Subject: Kannabi mail delivery test/);
      assert.match(received, /To: recipient@example.com/);
      assert.ok(!received.includes('test-password-12345'));
      const observed = (await (await admin('/admin/mail')).json()).configuration;
      assert.equal(observed.verificationStatus, 'verified');
      assert.ok(observed.verificationObservedAt);
    });

    await t.test('password recovery uses persisted SMTP configuration', async () => {
      received = '';
      const response = await admin('/auth/request-password-reset', 'POST', { email: 'mail0@example.com' });
      assert.equal(response.status, 200, await response.clone().text());
      for (let attempt = 0; attempt < 100 && !received; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const unfolded = received.replace(/=\r?\n/g, '');
      assert.match(unfolded, /Subject: Reset your Kannabi password/);
      assert.match(unfolded, /\/reset-password#token=3D[A-Za-z0-9]/);
      assert.ok(!unfolded.includes('test-password-12345'));
    });

    let envelope = '';
    await t.test('authenticated password is encrypted, preserved explicitly, and survives restart', async () => {
      const update = await admin('/admin/mail', 'PUT', { revision: 1, enabled: false, transport: 'smtp',
        smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUsername: 'mailer',
        senderAddress: 'kannabi@example.com', senderName: 'Kannabi',
        password: { action: 'replace', value: 'smtp-private-password' } });
      assert.equal(update.status, 200, await update.clone().text());
      assert.equal((await update.clone().json()).configuration.verificationStatus, 'not-verified');
      const database = driver.session();
      const row = await database.run("MATCH (m:MailConfiguration {key: 'instance'}) RETURN m.smtpPasswordEnvelope AS envelope");
      await database.close();
      envelope = row.records[0].get('envelope');
      assert.match(envelope, /^secret:v1:/);
      assert.ok(!envelope.includes('smtp-private-password'));
      const responseText = await (await admin('/admin/mail')).text();
      assert.ok(!responseText.includes(envelope));
      assert.ok(!responseText.includes('smtp-private-password'));
      const restartedKeys = await MasterKeyManager.open(true, { KANNABI_DATA_DIR: data });
      assert.equal(restartedKeys.secretStore().decrypt(envelope, 'smtp-password'), 'smtp-private-password');
      const preserve = await admin('/admin/mail', 'PUT', { revision: 2, enabled: false, transport: 'smtp',
        smtpHost: 'smtp2.example.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUsername: 'mailer',
        senderAddress: 'kannabi@example.com', senderName: 'Kannabi', password: { action: 'preserve' } });
      assert.equal(preserve.status, 200);
      assert.equal((await store.effectiveMailConfiguration()).smtpPasswordEnvelope, envelope);
      const stale = await admin('/admin/mail', 'PUT', { revision: 2, enabled: false, transport: 'smtp',
        smtpHost: '', smtpPort: null, smtpSecurity: '', smtpUsername: '', senderAddress: '', senderName: '',
        password: { action: 'clear' } });
      assert.equal(stale.status, 409);
    });

    await t.test('wrong or missing key degrades mail until explicit instance reset', async () => {
      const keyPath = join(data, 'master.key');
      const originalManagedKey = readFileSync(keyPath, 'utf8');
      const wrongKeys = await MasterKeyManager.open(true,
        { KANNABI_SECRET_KEY: randomBytes(32).toString('base64url') });
      const degradedMail = new MailService(store, wrongKeys);
      const degradedApp = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, degradedMail));
      const request = (path: string, method = 'GET', body?: unknown) => degradedApp.request(origin + '/api' + path, {
        method, headers: { Origin: origin, Cookie: cookies.get(1) ?? '', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const status = await request('/admin/mail');
      assert.equal(status.status, 200);
      const degraded = (await status.json()).configuration;
      assert.equal(degraded.passwordState, 'unavailable');
      assert.equal(degraded.masterKeyState, 'ready');
      assert.equal((await request('/admin/mail', 'PUT', { revision: 3, enabled: false, transport: 'smtp',
        smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUsername: 'mailer',
        senderAddress: 'kannabi@example.com', senderName: 'Kannabi', password: { action: 'preserve' } })).status, 409);
      assert.equal((await request('/admin/mail', 'PUT', { revision: 3, enabled: false, transport: 'smtp',
        smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUsername: 'mailer',
        senderAddress: 'kannabi@example.com', senderName: 'Kannabi',
        password: { action: 'replace', value: 'replacement-must-not-bypass-reset' } })).status, 409);

      rmSync(keyPath);
      const missingKeys = await MasterKeyManager.open(true, { KANNABI_DATA_DIR: data });
      assert.equal(missingKeys.state, 'missing');
      assert.throws(() => statSync(keyPath));
      const recoveryApp = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined,
        new MailService(store, missingKeys)));
      const recoveryRequest = (path: string, method = 'GET', body?: unknown) => recoveryApp.request(origin + '/api' + path, {
        method, headers: { Origin: origin, Cookie: cookies.get(1) ?? '', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const reset = await recoveryRequest('/admin/secrets/reset', 'POST',
        { revision: 3, confirmation: 'reset-encrypted-secrets' });
      assert.equal(reset.status, 200, await reset.clone().text());
      assert.equal((await reset.json()).configuration.passwordState, 'none');
      assert.equal((await store.effectiveMailConfiguration()).smtpPasswordEnvelope, null);
      assert.notEqual(readFileSync(keyPath, 'utf8'), originalManagedKey);
      assert.ok(envelope.startsWith('secret:v1:'));
    });
  });
