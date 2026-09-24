import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { canonicalIdentifiers } from './gs1.js';
import { demoAccounts, demoAdministrators, demoAllocatedSequences, demoAllocations, demoAssets,
  demoDiscoverable, demoGroupMembers, demoMembers, demoNamespaces, demoScopes,
  evaluatorScopes } from '../scripts/demo/fixtures.js';
import { allocatableSequence, canonicalExclusions, firstSequence } from './giai-allocation.js';
import { canonicalGcp } from './gs1.js';
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
    group: readable.filter((a) => a.group !== 3 && !a.isPublic).length,
    public: readable.filter((a) => a.isPublic).length }, evaluatorScopes);
  assert.ok(readable.some((a) => a.reporter === 0 && a.isPublic));
  assert.ok(assets.some((a) => a.owner === null));
  assert.ok(assets.some((a) => a.owner !== null));
  assert.equal(assets.filter((a) => a.photo).length, 47);
});

test('demo GIAI namespaces cover every allocation state and issue deterministic references', () => {
  // Zero, one and multiple configured namespaces are all reachable in the UI.
  const perGroup = [0, 1, 2, 3].map((group) => demoNamespaces.filter((n) => n.group === group).length);
  assert.deepEqual(perGroup, [2, 1, 0, 0]);
  assert.equal(new Set(demoNamespaces.map((n) => n.gcp)).size, demoNamespaces.length);
  for (const namespace of demoNamespaces) {
    assert.equal(canonicalGcp(namespace.gcp), namespace.gcp);
    assert.deepEqual(canonicalExclusions(namespace.exclusions), namespace.exclusions);
  }
  // The seeded issuance order produces exactly the documented references, so
  // the skipped ranges are visible in the demo without reading configuration.
  const exclusions = canonicalExclusions(demoNamespaces[0].exclusions);
  const issued: number[] = [];
  let next = firstSequence;
  for (let n = 0; n < demoAllocations.length; n++) {
    const sequence = allocatableSequence(next, exclusions);
    issued.push(sequence);
    next = sequence + 1;
  }
  assert.deepEqual(issued, [...demoAllocatedSequences]);
  // Allocation targets are all in the namespace-owning Group, and deliberately
  // include an Asset with no identifier and one with a manufacturer SGTIN.
  const assets = demoAssets();
  assert.ok(demoAllocations.every((index) => assets[index].group === demoNamespaces[0].group));
  assert.ok(demoAllocations.some((index) => assets[index].pattern === 'none'));
  assert.ok(demoAllocations.some((index) => assets[index].pattern === 'sgtin'));
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

test('the demo cast makes Members and User profile reachability inspectable', () => {
  // Fictional identities only, and enough of them that each way of being
  // discoverable — and of not being — is represented by somebody.
  assert.equal(demoAccounts.length, 10);
  assert.equal(new Set(demoAccounts.map((account) => account.email)).size, demoAccounts.length);
  for (const account of demoAccounts) assert.match(account.email, /@demo\.invalid$/);
  // Deterministic: the same cast, the same memberships, the same answers.
  assert.deepEqual(demoDiscoverable(0), demoDiscoverable(0));
  assert.deepEqual(demoMembers(0), demoMembers(0));
  assert.deepEqual(demoScopes(1), demoScopes(1));

  // Every reporter is a member of the Group they reported into, which is what
  // the domain requires of a report.
  for (const asset of demoAssets()) {
    assert.ok(demoGroupMembers[asset.group].includes(asset.reporter),
      `reporter ${asset.reporter} is in Group ${asset.group}`);
  }

  // The evaluator's own counts are unchanged by the new cast, and are the ones
  // the seed has always verified.
  assert.deepEqual(demoScopes(0), evaluatorScopes);

  // Administration never broadens Workspace profiles or Asset access.
  for (const index of demoAdministrators) assert.deepEqual(demoDiscoverable(index), demoMembers(index));
  assert.ok(demoMembers(9).length < demoAccounts.length,
    'administrator status does not broaden Workspace Members');
  assert.ok(demoScopes(9).all < demoScopes(0).all, 'an administrator is not an Asset superuser');

  const seenBy = (viewer: number) => new Set(demoDiscoverable(viewer));
  // Somebody in a Group of their own is visible only to themself.
  const alone = 6;
  const finds = demoAccounts.flatMap((_, viewer) => (seenBy(viewer).has(alone) ? [viewer] : []));
  assert.deepEqual(finds, [alone], 'only themselves');

  // Sharing a Group is enough on its own: these two have reported nothing.
  for (const quiet of [3, 8]) {
    assert.equal(demoScopes(quiet).mine, 0);
    assert.ok(seenBy(0).has(quiet) && seenBy(3).has(quiet) && !seenBy(1).has(quiet),
      'seen by the Group they share, not beyond it');
  }
  // Readable reporting provenance is not enough without a shared Group.
  assert.ok(!demoGroupMembers.some((members) => members.includes(1) && members.includes(5)));
  assert.ok(!seenBy(1).has(5), 'not known through their work alone');
  assert.ok(!demoMembers(1).includes(5), 'reporter-only reachability does not enumerate a Member');
});
