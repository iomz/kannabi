import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j, { int } from 'neo4j-driver';
import { IdentityStore, DuplicateIdentityError, ReferenceError, type ReportAsset } from './identity-store.js';
import { ValidationError, type AssetIdentifier } from './identity.js';
import { isAssetId, newAssetId } from './asset-id.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('Neo4j identity integrity', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  // A pre-Phase-1 database in mixed state: one Asset already carries a native
  // identity, and more legacy Assets than fit in a single backfill batch do not.
  const alreadyMigrated = '01900000-0000-7000-8000-000000000001';
  const legacyCount = 602;
  const seed = driver.session();
  try {
    await seed.run("CREATE (:Asset {name: 'Legacy migrated', id: $id})", { id: alreadyMigrated });
    await seed.run("UNWIND range(1, $n) AS n CREATE (:Asset {name: 'Legacy ' + n})", { n: int(legacyCount) });
  } finally { await seed.close(); }
  const store = await IdentityStore.open(driver);
  const legacyIds = async (): Promise<Record<string, unknown>> => {
    const session = driver.session();
    try {
      const result = await session.run(`MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy'
        RETURN a.name AS name, a.id AS id`);
      return Object.fromEntries(result.records.map((r) => [r.get('name') as string, r.get('id')]));
    } finally { await session.close(); }
  };

  await t.test('startup migration assigns one canonical UUIDv7 to every legacy Asset and keeps existing ones', async () => {
    const assigned = await legacyIds();
    assert.equal(Object.keys(assigned).length, legacyCount + 1);
    // An Asset that already had an identity keeps exactly that value.
    assert.equal(assigned['Legacy migrated'], alreadyMigrated);
    const values = Object.values(assigned) as string[];
    // More than one batch, every value canonical, every value distinct.
    assert.ok(legacyCount > 500);
    assert.ok(values.every(isAssetId), values.filter((v) => !isAssetId(v)).slice(0, 3).join(' '));
    assert.equal(new Set(values).size, values.length);
    const session = driver.session();
    try {
      const public_ = await session.run("MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy' RETURN DISTINCT a.isPublic AS p");
      assert.deepEqual(public_.records.map((r) => r.get('p')), [false]);
      const constraints = await session.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties RETURN *');
      for (const label of ['Asset', 'Migration']) {
        assert.ok(constraints.records.some((row) => row.get('type') === 'UNIQUENESS'
          && JSON.stringify(row.get('labelsOrTypes')) === JSON.stringify([label])), label);
      }
    } finally { await session.close(); }
    // Reopening must never replace an already assigned native identity.
    await IdentityStore.open(driver);
    assert.deepEqual(await legacyIds(), assigned);
  });

  const otherStore = await IdentityStore.open(driver);

  await t.test('concurrent startup never replaces or double-assigns a native Asset ID', async () => {
    // Constraints already exist, so this exercises the migration itself rather
    // than concurrent schema installation.
    for (let round = 0; round < 3; round++) {
      const before = await legacyIds();
      const session = driver.session();
      try { await session.run("UNWIND range(1, 400) AS n CREATE (:Asset {name: 'Legacy race ' + $round + '-' + n})", { round: String(round) }); }
      finally { await session.close(); }
      const peers = [neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!)),
        neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!))];
      const results = await Promise.allSettled(peers.map((peer) => IdentityStore.open(peer)));
      await Promise.all(peers.map((peer) => peer.close()));
      // Unrelated concurrent startup contention may fail one peer; the identity
      // invariants below must hold regardless.
      assert.ok(results.some((r) => r.status === 'fulfilled'), JSON.stringify(results));
      const after = await legacyIds();
      for (const [name, id] of Object.entries(before)) assert.equal(after[name], id, name);
      const raced = Object.entries(after).filter(([name]) => name.startsWith(`Legacy race ${round}-`));
      assert.equal(raced.length, 400);
      assert.ok(raced.every(([, id]) => isAssetId(id)));
      const values = Object.values(after) as string[];
      assert.equal(new Set(values).size, values.length);
      const cleanup = driver.session();
      try { await cleanup.run("MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy race' DELETE a"); }
      finally { await cleanup.close(); }
    }
  });

  await t.test('a malformed or wrong-version native Asset ID fails startup closed and is never replaced', async () => {
    const run = async (cypher: string, params = {}) => {
      const session = driver.session();
      try { return await session.run(cypher, params); } finally { await session.close(); }
    };
    const readId = async () => (await run("MATCH (a:Asset {name: 'Legacy 1'}) RETURN a.id AS id")).records[0].get('id');
    const original = await readId();
    for (const invalid of [
      'banana', '', int(42), true,
      // A UUID-shaped value is not automatically a native Asset ID.
      '958558e2-4a1f-47e4-9df3-2d1c02056f97',
      '00000000-0000-0000-0000-000000000000',
      // Correct version and variant, but not the canonical lowercase spelling.
      '01A0BC17-85AD-71D2-B740-C1B89E050F3C',
    ]) {
      await run("MATCH (a:Asset {name: 'Legacy 1'}) SET a.id = $invalid", { invalid });
      await assert.rejects(IdentityStore.open(driver), /missing or invalid native id/, String(invalid));
      assert.deepEqual(await readId(), invalid, String(invalid));
    }
    // A removed id is legacy data, not corruption: it is backfilled, not rejected.
    await run("MATCH (a:Asset {name: 'Legacy 1'}) REMOVE a.id");
    await IdentityStore.open(driver);
    const replacement = await readId();
    assert.ok(isAssetId(replacement), String(replacement));
    assert.notEqual(replacement, original);
    await run("MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy' DELETE a");
  });

  const user = await store.createUser('Reporter');
  const outsider = await store.createUser('Other user');
  const group = await store.createGroup('Inventory team');
  const owner = await store.createOwner('Shared laboratory');
  await store.addMember(user.key, group.key);
  await store.addMember(user.key, group.key);
  const context = { actorKey: user.key, groupKey: group.key };
  const sgtin = (serial: string): AssetIdentifier => ({ scheme: 'sgtin', gtin: '0614141123452', serial });
  const grai: AssetIdentifier = { scheme: 'grai', grai: '00614141234561789' };
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); }
    finally { await session.close(); }
  }
  async function counts() {
    const result = await query(`MATCH (a:Asset) WITH count(a) AS assets
      OPTIONAL MATCH (i:Identifier) RETURN assets, count(i) AS identifiers`);
    return result.records[0].toObject();
  }

  let oscilloscope = '';
  await t.test('reporting persists identity, independent Owner, explicit Group and automatic provenance', async () => {
    const start = Date.now();
    const asset = await store.reportAsset({ name: '  Oscilloscope  ', identifiers: [sgtin('001')], ownerKey: owner.key }, context);
    oscilloscope = asset.id;
    assert.equal(asset.name, 'Oscilloscope');
    assert.deepEqual(asset.identifier, { scheme: 'sgtin', gtin: '00614141123452', serial: '001' });
    assert.deepEqual(asset.reportedBy, { ...user, status: 'active' });
    assert.deepEqual(asset.owner, owner);
    assert.deepEqual(asset.groups, [group]);
    assert.equal(asset.isPublic, false);
    assert.ok(Date.parse(asset.reportedAt) >= start - 1000);
    assert.ok(Date.parse(asset.reportedAt) <= Date.now() + 1000);
    assert.ok(isAssetId(asset.id), asset.id);
    assert.deepEqual(await otherStore.getAsset(asset.id, user.key), asset);
    // Neo4j identity stays an implementation detail; only the native id is exposed.
    for (const key of ['key', 'elementId', 'uuid']) assert.equal(Object.hasOwn(asset, key), false);
    const links = await query('MATCH (u:User)-[r]-(a:Asset) RETURN DISTINCT type(r) AS type');
    assert.deepEqual(links.records.map((r) => r.get('type')), ['REPORTED_BY']);
    assert.equal((await query('MATCH (u:User)-[r:MEMBER_OF]->(g:Group) RETURN count(r) AS n')).records[0].get('n').toNumber(), 1);
  });

  await t.test('missing fields, conflicting claims and invalid references leave no partial records', async () => {
    const before = await counts();
    for (const input of [
      { name: '', identifiers: [sgtin('bad')] },
      { name: 'Asset', identifiers: [] },
      { name: 'Asset', identifiers: [sgtin('bad'), grai] },
      { name: 'Asset', identifiers: [sgtin('bad')], reportedBy: outsider.key },
      { name: 'Asset', identifiers: [sgtin('bad')], reportedAt: '2000-01-01T00:00:00Z' },
    ]) await assert.rejects(store.reportAsset(input as ReportAsset, context), ValidationError);
    await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [sgtin('bad')] },
      { actorKey: user.key, groupKey: '' }), ValidationError);
    for (const actorKey of [outsider.key, 'missing-user']) {
      await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [sgtin('bad')] },
        { actorKey, groupKey: group.key }), ReferenceError);
    }
    await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [sgtin('bad')], ownerKey: 'missing' }, context), ReferenceError);
    await assert.rejects(store.addMember(user.key, 'missing'), ReferenceError);
    assert.deepEqual(await counts(), before);
  });

  await t.test('duplicate canonical claims reject instead of merging or overwriting', async () => {
    const before = await counts();
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate', identifiers: [
      { scheme: 'sgtin', gtin: '00614141123452', serial: '001' },
    ] }, context), DuplicateIdentityError);
    assert.deepEqual(await counts(), before);
    assert.equal((await store.getAsset(oscilloscope, user.key))?.name, 'Oscilloscope');
    const asset = await store.reportAsset({ name: 'Reusable container', identifiers: [grai] }, context);
    assert.equal(asset.owner, null);
    assert.notEqual(asset.id, oscilloscope);
    assert.deepEqual(await store.getAsset(asset.id, user.key), asset);
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate GRAI', identifiers: [grai] }, context), DuplicateIdentityError);
  });

  await t.test('concurrent writers yield exactly one claim and no orphan Assets or identifiers', async () => {
    for (const identity of [sgtin('race'), { scheme: 'grai', grai: '00614141234561race' } as const]) {
      const before = await counts();
      const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => {
        const claim = n % 2 && identity.scheme === 'sgtin'
          ? { ...identity, gtin: '00614141123452' } : identity;
        return (n % 2 ? store : otherStore).reportAsset({ name: `Writer ${n}`, identifiers: [claim] }, context);
      }));
      assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
      for (const result of writes) {
        if (result.status === 'rejected') assert.ok(result.reason instanceof DuplicateIdentityError, String(result.reason));
      }
      const after = await counts();
      assert.equal(after.assets.toNumber(), before.assets.toNumber() + 1);
      assert.equal(after.identifiers.toNumber(), before.identifiers.toNumber() + 1);
    }
    // Distinct serial values remain distinct, even with the same GTIN.
    const zero = await store.reportAsset({ name: 'Zero', identifiers: [sgtin('0')] }, context);
    const doubleZero = await store.reportAsset({ name: 'Double zero', identifiers: [sgtin('00')] }, context);
    assert.equal(new Set([zero.id, doubleZero.id, oscilloscope]).size, 3);
    const persisted = await query('MATCH (a:Asset) RETURN count(DISTINCT a.id) AS ids, count(a) AS assets');
    assert.equal(persisted.records[0].get('ids').toNumber(), persisted.records[0].get('assets').toNumber());
  });

  await t.test('metadata and Owner changes preserve native identity, provenance and identifier', async () => {
    const before = (await store.getAsset(oscilloscope, user.key))!;
    const newOwner = await store.createOwner('Another organization');
    const changed = await store.updateAsset(oscilloscope, { name: 'Updated name', ownerKey: newOwner.key }, user.key);
    assert.equal(changed.name, 'Updated name');
    assert.equal(changed.id, oscilloscope);
    assert.deepEqual(changed.owner, newOwner);
    assert.equal(changed.reportedAt, before.reportedAt);
    assert.deepEqual(changed.reportedBy, before.reportedBy);
    assert.deepEqual(changed.identifier, before.identifier);
    assert.deepEqual(changed.groups, before.groups);
    assert.equal((await store.updateAsset(oscilloscope, { ownerKey: null }, user.key)).owner, null);
    for (const changes of [
      { reportedAt: '2000-01-01T00:00:00Z' }, { reportedBy: outsider.key }, { id: newAssetId() },
      { identifier: grai }, { identifiers: [grai] }, { name: '' }, { name: undefined },
    ]) await assert.rejects(store.updateAsset(oscilloscope, changes as never, user.key), ValidationError);
    await assert.rejects(store.updateAsset(oscilloscope, { name: 'Must roll back', ownerKey: 'missing' }, user.key), ReferenceError);
    const after = (await store.getAsset(oscilloscope, user.key))!;
    assert.equal(after.name, 'Updated name');
    assert.equal(after.id, oscilloscope);
    // An unknown but well-formed native id is simply absent; a malformed one is rejected.
    assert.equal(await store.getAsset(newAssetId(), user.key), null);
    await assert.rejects(store.getAsset('not-a-native-id', user.key), ValidationError);
  });

  await t.test('schema initialization fails closed when a constraint name masks the required schema', async () => {
    // This test runs last and only against the disposable database.
    await query('DROP CONSTRAINT identifier_claim');
    await query('CREATE CONSTRAINT identifier_claim FOR (n:Unrelated) REQUIRE n.key IS UNIQUE');
    await assert.rejects(IdentityStore.open(driver), /Required uniqueness constraint is missing for Identifier/);
  });
});
