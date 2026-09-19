import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore, DuplicateIdentityError, ReferenceError, type ReportAsset } from './identity-store.js';
import { ValidationError, type AssetIdentifier } from './identity.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('Neo4j identity integrity', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const legacy = driver.session();
  try { await legacy.run("CREATE (:Asset {name: 'Legacy visibility'})"); }
  finally { await legacy.close(); }
  const store = await IdentityStore.open(driver);
  const migrated = driver.session();
  try {
    const result = await migrated.run("MATCH (a:Asset {name: 'Legacy visibility'}) RETURN a.isPublic AS public");
    assert.equal(result.records[0].get('public'), false);
    await migrated.run("MATCH (a:Asset {name: 'Legacy visibility'}) DELETE a");
  } finally { await migrated.close(); }
  const otherStore = await IdentityStore.open(driver);
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

  await t.test('reporting persists identity, independent Owner, explicit Group and automatic provenance', async () => {
    const start = Date.now();
    const asset = await store.reportAsset({ name: '  Oscilloscope  ', identifiers: [sgtin('001')], ownerKey: owner.key }, context);
    assert.equal(asset.name, 'Oscilloscope');
    assert.deepEqual(asset.identifier, { scheme: 'sgtin', gtin: '00614141123452', serial: '001' });
    assert.deepEqual(asset.reportedBy, { ...user, status: 'active' });
    assert.deepEqual(asset.owner, owner);
    assert.deepEqual(asset.groups, [group]);
    assert.equal(asset.isPublic, false);
    assert.ok(Date.parse(asset.reportedAt) >= start - 1000);
    assert.ok(Date.parse(asset.reportedAt) <= Date.now() + 1000);
    assert.deepEqual(await otherStore.getAsset(sgtin('001'), user.key), asset);
    for (const key of ['id', 'key', 'elementId', 'uuid']) assert.equal(Object.hasOwn(asset, key), false);
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
    assert.equal((await store.getAsset(sgtin('001'), user.key))?.name, 'Oscilloscope');
    const asset = await store.reportAsset({ name: 'Reusable container', identifiers: [grai] }, context);
    assert.equal(asset.owner, null);
    assert.deepEqual(await store.getAsset(grai, user.key), asset);
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
    await store.reportAsset({ name: 'Zero', identifiers: [sgtin('0')] }, context);
    await store.reportAsset({ name: 'Double zero', identifiers: [sgtin('00')] }, context);
  });

  await t.test('metadata and Owner changes preserve provenance and identifier', async () => {
    const before = (await store.getAsset(sgtin('001'), user.key))!;
    const newOwner = await store.createOwner('Another organization');
    const changed = await store.updateAsset(sgtin('001'), { name: 'Updated name', ownerKey: newOwner.key }, user.key);
    assert.equal(changed.name, 'Updated name');
    assert.deepEqual(changed.owner, newOwner);
    assert.equal(changed.reportedAt, before.reportedAt);
    assert.deepEqual(changed.reportedBy, before.reportedBy);
    assert.deepEqual(changed.identifier, before.identifier);
    assert.deepEqual(changed.groups, before.groups);
    assert.equal((await store.updateAsset(sgtin('001'), { ownerKey: null }, user.key)).owner, null);
    for (const changes of [
      { reportedAt: '2000-01-01T00:00:00Z' }, { reportedBy: outsider.key },
      { identifier: grai }, { identifiers: [grai] }, { name: '' }, { name: undefined },
    ]) await assert.rejects(store.updateAsset(sgtin('001'), changes as never, user.key), ValidationError);
    await assert.rejects(store.updateAsset(sgtin('001'), { name: 'Must roll back', ownerKey: 'missing' }, user.key), ReferenceError);
    assert.equal((await store.getAsset(sgtin('001'), user.key))?.name, 'Updated name');
    assert.equal(await store.getAsset(sgtin('unknown'), user.key), null);
  });

  await t.test('schema initialization fails closed when a constraint name masks the required schema', async () => {
    // This test runs last and only against the disposable database.
    await query('DROP CONSTRAINT identifier_claim');
    await query('CREATE CONSTRAINT identifier_claim FOR (n:Unrelated) REQUIRE n.key IS UNIQUE');
    await assert.rejects(IdentityStore.open(driver), /Required uniqueness constraint is missing for Identifier/);
  });
});
