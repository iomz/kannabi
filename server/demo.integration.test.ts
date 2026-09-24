import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import neo4j from 'neo4j-driver';
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { IdentityStore } from './identity-store.js';
import { createAuth } from './auth.js';
import { createInventoryApi } from './inventory-api.js';
import { MediaService } from './media.js';
import { S3Storage } from './storage.js';
import { assetPageRequest } from './asset-page.js';
import { runDemo } from '../scripts/demo/run.js';
import { demoAccounts, demoAdministrators, demoAssets, demoDiscoverable, demoPassword,
  demoScopes } from '../scripts/demo/fixtures.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('development demo seed and full reset on disposable Neo4j and Alarik', { skip: !uri || !password || !process.env.S3_ENDPOINT }, async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const env: NodeJS.ProcessEnv & { APP_URL: string; BETTER_AUTH_SECRET: string } = { ...process.env, KANNABI_DEMO: 'local', NODE_ENV: 'test', APP_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(address.port), NEO4J_URI: uri!, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: password!, BETTER_AUTH_SECRET: randomUUID() + randomUUID() };
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  t.after(async () => { await driver.close(); s3.destroy(); });
  const bucket = env.S3_BUCKET!;
  async function query(text: string, params = {}) {
    const session = driver.session();
    try { return await session.run(text, params); } finally { await session.close(); }
  }
  const keys = async () => (await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents?.map((o) => o.Key!).sort() ?? [];
  async function snapshot() {
    // Assets carrying no external identifier are part of the snapshot too.
    const result = await query(`MATCH (a:Asset)-[:REPORTED_BY]->(u:User),
      (g:Group)-[:CAN_COLLABORATE]->(a) OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
      RETURN a.name AS name, a.isPublic AS public,
        [(a)-[:IDENTIFIED_BY]->(i:IndividualIdentifier) | i.canonical] AS individual,
        [(a)-[:CLASSIFIED_AS]->(c:ClassIdentifier) | c.canonical] AS classLevel,
        u.email AS reporter, g.name AS group, o.name AS owner ORDER BY name`);
    // Pattern comprehensions return relationship order, which is not stable
    // across reseeds; the identifier set is what the snapshot compares.
    return result.records.map((r) => {
      const row = r.toObject() as Record<string, unknown>;
      return { ...row, individual: (row.individual as string[]).sort(),
        classLevel: (row.classLevel as string[]).sort() };
    });
  }
  await t.test('seed creates deterministic content through normal domain and authentication paths', async () => {
    const output = await promisify(execFile)('pnpm', ['demo:seed'], { env });
    assert.match(output.stdout, /Created 140 synthetic Assets/);
    assert.equal((await snapshot()).length, 140);
    assert.equal((await keys()).length, 47);
  });
  const before = await snapshot();
  const mediaKeys = await keys();
  await t.test('repeat seed and unconfirmed reset fail without changing existing data or media', async () => {
    await assert.rejects(runDemo('seed', [], env), /requires empty/);
    await assert.rejects(runDemo('reset', [], env), /DELETES ALL/);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await keys(), mediaKeys);
  });
  await t.test('demo credentials, administration, every scope, pagination, and media authorization work', async () => {
    const store = await IdentityStore.open(driver);
    const auth = await createAuth(driver, env.APP_URL, env.BETTER_AUTH_SECRET);
    const media = new MediaService(store, new S3Storage(s3, bucket));
    const app = new Hono().route('/api', createInventoryApi(store, auth, env.APP_URL, media));
    const users: string[] = [];
    for (const [index, account] of demoAccounts.entries()) {
      const response = await app.request(env.APP_URL + '/api/auth/sign-in/email', { method: 'POST',
        headers: { Origin: env.APP_URL, 'Content-Type': 'application/json', 'x-kannabi-client-ip': `192.0.2.${index + 1}` },
        body: JSON.stringify({ email: account.email, password: demoPassword }) });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const me = await (await app.request(env.APP_URL + '/api/me', { headers: { Cookie: cookie } })).json();
      users.push(me.user.key);
      assert.equal(me.isAdmin, (demoAdministrators as readonly number[]).includes(index));
      const expected = demoScopes(index);
      for (const scope of ['all', 'mine', 'group', 'public'] as const) {
        const page = await store.findAssets(me.user.key, assetPageRequest({ scope }));
        assert.deepEqual(page.scopes, expected);
        assert.equal(page.matching, expected[scope]);
      }
    }

    // What the directory answers is held against an expectation derived from
    // the fixture rather than from the query, so the two have to agree about
    // every account without either being able to explain the other away.
    for (const [index, account] of demoAccounts.entries()) {
      const seen = await store.listUsers(users[index]);
      assert.deepEqual(seen.map((person) => users.indexOf(person.key)).sort((a, b) => a - b),
        demoDiscoverable(index), account.email);
      // A page exists for everybody the directory lists, and for nobody else.
      for (const [other] of demoAccounts.entries()) {
        const reachable = demoDiscoverable(index).includes(other);
        assert.equal(await store.userProfile(users[index], users[other]) !== null, reachable,
          `${account.email} -> ${demoAccounts[other].email}`);
      }
      // Discovery never produces an address, however the person was reached.
      for (const person of seen) {
        assert.ok(!Object.values(person).some((value) =>
          typeof value === 'string' && value.includes('@')), 'no address in the directory');
      }
    }
    let cursor: string | null = null;
    const nativeIds: string[] = [];
    let withoutIdentifiers = 0;
    do {
      const page = await store.findAssets(users[0], assetPageRequest({ ...(cursor ? { cursor } : {}) }));
      page.assets.forEach((a) => {
        nativeIds.push(a.id);
        if (!a.identifiers.length) withoutIdentifiers++;
      });
      cursor = page.nextCursor;
    } while (cursor);
    // Paging is exhaustive and free of duplicates whatever each Asset carries:
    // Assets with none, one, and several identifiers each appear exactly once.
    assert.equal(nativeIds.length, 124);
    assert.equal(new Set(nativeIds).size, 124);
    assert.ok(withoutIdentifiers > 0);
    const hidden = demoAssets().find((a) => a.group === 3 && !a.isPublic && a.photo)!;
    const hiddenId = (await query('MATCH (a:Asset {name: $name}) RETURN a.id AS id',
      { name: hidden.name })).records[0].get('id') as string;
    assert.equal(await store.getAsset(hiddenId, users[0]), null);
    const asset = (await store.getAsset(hiddenId, users[2]))!;
    assert.equal(asset.identifiers.length, hidden.identifiers.length);
    await assert.rejects(media.read(hiddenId, asset.photos[0].key, users[0]));
    assert.deepEqual(Buffer.from((await media.read(hiddenId, asset.photos[0].key, users[2])).bytes),
      await readFile(new URL('../scripts/demo/photos/' + hidden.photo, import.meta.url)));
    for (const key of mediaKeys) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      assert.ok((await object.Body!.transformToByteArray()).length > 100);
    }
    const storedKeys = (await query('MATCH (:Asset)-[:HAS_PHOTO]->(m:Media) RETURN m.key AS key')).records.map((r) => r.get('key')).sort();
    assert.deepEqual(storedKeys, mediaKeys);
    assert.equal((await query('MATCH (m:Media) WHERE NOT (:Asset)-[:HAS_PHOTO]->(m) RETURN count(m) AS count')).records[0].get('count').toNumber(), 0);
    assert.equal((await query('MATCH (:User)-[r]->(:Asset) RETURN count(r) AS count')).records[0].get('count').toNumber(), 0);
  });
  await t.test('seeded GIAI namespaces and issuances survive nothing but a reset', async () => {
    const namespaces = await query(`MATCH (g:Group)-[:MANAGES_NAMESPACE]->(n:GiaiNamespace)
      RETURN g.name AS group, n.gcp AS gcp, n.active AS active, toFloat(n.nextSequence) AS next
      ORDER BY gcp`);
    assert.deepEqual(namespaces.records.map((r) => r.get('gcp')), ['0455123', '0614141', '9521234']);
    assert.ok(namespaces.records.every((r) => r.get('active') === true));
    const allocations = await query(`MATCH (l:GiaiAllocation)-[:ALLOCATED_FROM]->(n:GiaiNamespace)
      RETURN l.value AS value, toFloat(l.sequence) AS sequence, n.gcp AS gcp ORDER BY sequence`);
    // Exclusions on the first namespace make the skips visible in demo data.
    assert.deepEqual(allocations.records.map((r) => r.get('sequence')), [5, 6, 7, 8, 12]);
    assert.deepEqual(allocations.records.map((r) => r.get('value')),
      ['06141415', '06141416', '06141417', '06141418', '061414112']);
    assert.ok(allocations.records.every((r) => r.get('gcp') === '0614141'));
    // Each issued GIAI is attached to the Asset the ledger names.
    const attached = await query(`MATCH (l:GiaiAllocation)
      MATCH (a:Asset {id: l.allocatedForAssetId})-[:IDENTIFIED_BY]->(i:IndividualIdentifier)
      WHERE i.canonical = '(8004)' + l.value RETURN count(i) AS n`);
    assert.equal(attached.records[0].get('n').toNumber(), 5);
  });

  await t.test('confirmed reset replaces all local data and objects without bookkeeping', async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'unrelated-local-object', Body: 'local development data' }));
    await (await IdentityStore.open(driver)).createOwner('Old local Owner');
    const output = await promisify(execFile)('pnpm', ['demo:reset', '--', '--yes'], { env });
    assert.match(output.stdout, /DESTRUCTIVE RESET/);
    assert.deepEqual(await snapshot(), before);
    // Counters must not leak across resets: a fresh namespace starts over.
    const counters = await query('MATCH (n:GiaiNamespace) RETURN toFloat(n.nextSequence) AS next ORDER BY n.gcp');
    assert.deepEqual(counters.records.map((r) => r.get('next')), [1, 13, 1]);
    assert.equal((await query('MATCH (l:GiaiAllocation) RETURN count(l) AS n')).records[0].get('n').toNumber(), 5);
    const after = await keys();
    assert.equal(after.length, 47);
    assert.ok(after.every((key) => !mediaKeys.includes(key)));
    assert.ok(!after.includes('unrelated-local-object'));
    assert.equal((await query("MATCH (o:Owner {name: 'Old local Owner'}) RETURN count(o) AS count")).records[0].get('count').toNumber(), 0);
  });
});
