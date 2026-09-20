import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { canonicalIdentifiers } from './gs1.js';
import { demoAssets, evaluatorScopes } from '../scripts/demo/fixtures.js';
import { demoConfiguration, requireStoppedApp, requireUnversionedBucket } from '../scripts/demo/safety.js';

const env = { KANNABI_DEMO: 'local', NODE_ENV: 'development', APP_URL: 'http://127.0.0.1:3000',
  NEO4J_URI: 'bolt://127.0.0.1:7687', NEO4J_PASSWORD: 'test', S3_ENDPOINT: 'http://127.0.0.1:8080',
  S3_BUCKET: 'kannabi-photos', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test', BETTER_AUTH_SECRET: 'x'.repeat(32) };

test('demo contents and supported identifiers are deterministic with overlapping scopes', () => {
  const assets = demoAssets();
  assert.deepEqual(assets, demoAssets());
  assert.equal(assets.length, 140);
  // Every identifier set is accepted by the pinned GS1 policy.
  const identifiers = assets.map((asset) => canonicalIdentifiers(asset.identifiers));
  const flat = identifiers.flat();
  const has = (scheme: string) => identifiers.filter((set) => set.some((i) => i.scheme === scheme)).length;
  // The seed demonstrates the whole 0..n model, not one identifier shape.
  assert.equal(identifiers.filter((set) => !set.length).length, 20, 'Assets with no external identifier');
  assert.equal(has('gtin'), 40, 'class-level GTIN, alone or beside its SGTIN');
  assert.equal(has('sgtin'), 40);
  assert.equal(has('giai'), 40);
  assert.equal(has('grai'), 40);
  assert.equal(identifiers.filter((set) =>
    set.some((i) => i.scheme === 'sgtin') && set.some((i) => i.scheme === 'giai')).length, 20,
  'an Asset carrying both a manufacturer SGTIN and an owner-assigned GIAI');
  // Individual identifiers are exclusive, so every one of them must be distinct.
  const individual = flat.filter((identifier) => identifier.level === 'individual');
  assert.equal(individual.length, 100);
  assert.equal(new Set(individual.map((identifier) => identifier.canonical)).size, individual.length);
  // Class identifiers are shared: two GTINs and one returnable asset type,
  // each describing many Assets.
  const classLevel = flat.filter((identifier) => identifier.level === 'class');
  const shared = new Map<string, number>();
  for (const identifier of classLevel) shared.set(identifier.canonical, (shared.get(identifier.canonical) ?? 0) + 1);
  assert.deepEqual([...shared.values()], [20, 20, 20]);
  assert.equal([...shared.keys()].filter((canonical) => canonical.startsWith('(01)')).length, 2);
  assert.equal([...shared.keys()].filter((canonical) => canonical.startsWith('(8003)')).length, 1);
  // Serialised GRAIs share one asset type while identifying individual pallets.
  const pallets = individual.filter((identifier) => identifier.scheme === 'grai');
  assert.equal(pallets.length, 20);
  assert.equal(new Set(pallets.map((identifier) => identifier.components.assetType)).size, 1);
  const readable = assets.filter((a) => a.group !== 3 || a.isPublic);
  assert.deepEqual({ all: readable.length, mine: readable.filter((a) => a.reporter === 0).length,
    group: readable.filter((a) => a.group !== 3).length, public: readable.filter((a) => a.isPublic).length }, evaluatorScopes);
  assert.ok(readable.some((a) => a.reporter === 0 && a.isPublic));
  assert.ok(assets.some((a) => a.owner === null));
  assert.ok(assets.some((a) => a.owner !== null));
  assert.equal(assets.filter((a) => a.photo).length, 47);
});

test('demo safety requires explicit opt-in, loopback configuration and exact destructive confirmation', () => {
  assert.doesNotThrow(() => demoConfiguration('seed', [], env));
  assert.doesNotThrow(() => demoConfiguration('reset', ['--', '--yes'], env));
  for (const args of [[], ['yes'], ['--yes', '--yes'], ['--force'], ['--', '--yes', 'extra']]) {
    assert.throws(() => demoConfiguration('reset', args, env));
  }
  for (const change of [
    { KANNABI_DEMO: undefined }, { KANNABI_DEMO: 'true' }, { NODE_ENV: 'production' }, { NODE_ENV: 'staging' },
    { APP_URL: 'https://demo.example.com' }, { APP_URL: 'http://0.0.0.0:3000' },
    { NEO4J_URI: 'neo4j://127.0.0.1:7687' }, { NEO4J_URI: 'bolt://neo4j:7687' },
    { NEO4J_URI: 'bolt://127.0.0.1.evil.example:7687' }, { NEO4J_URI: 'bolt://user:password@127.0.0.1:7687' },
    { S3_ENDPOINT: 'http://192.168.1.2:8080' }, { S3_ENDPOINT: 'https://s3.example.com' },
    { S3_ENDPOINT: 'http://localhost:8080/path' }, { S3_BUCKET: 'other-bucket' }, { NEO4J_PASSWORD: '' },
  ]) assert.throws(() => demoConfiguration('reset', ['--yes'], { ...env, ...change }));
});

test('demo refuses a running local application before connecting to persistence', async () => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}`);
  try { await assert.rejects(requireStoppedApp(url, address.port), /Stop the local application/); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  await assert.doesNotReject(requireStoppedApp(url, address.port));
});

test('demo refuses buckets that could retain hidden media versions', () => {
  assert.doesNotThrow(() => requireUnversionedBucket(undefined));
  for (const status of ['Enabled', 'Suspended', 'unknown']) assert.throws(() => requireUnversionedBucket(status));
});
