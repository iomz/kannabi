import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore } from './identity-store.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** The GIAI-only allocation schema, as a database that predates this milestone
 * actually holds it.
 *
 * Written by downgrading what the store just wrote rather than by hand, so the
 * surrounding Assets, Users and Groups are exactly the shapes the application
 * produces and only the allocation labels are old. Hand-built fixtures drift;
 * this cannot.
 */
const downgrade = [
  `MATCH (n:Gs1Namespace)
   SET n:GiaiNamespace, n.nextSequence = n.giaiNextSequence,
     n.exclusionsFrom = n.giaiExclusionsFrom, n.exclusionsTo = n.giaiExclusionsTo
   REMOVE n:Gs1Namespace, n.giaiNextSequence, n.giaiExclusionsFrom, n.giaiExclusionsTo,
     n.graiTypeNextSequence, n.graiTypeExclusionsFrom, n.graiTypeExclusionsTo,
     n.gtinItemNextSequence, n.gtinItemExclusionsFrom, n.gtinItemExclusionsTo`,
  `MATCH (l:Gs1KeyIssuance {scheme: 'giai'})-[r:ISSUED_FROM]->(n)
   SET l:GiaiAllocation, l.value = substring(l.canonical, 6)
   REMOVE l:Gs1KeyIssuance, l.key, l.scheme, l.canonical
   CREATE (l)-[:ALLOCATED_FROM]->(n)
   DELETE r`,
  // The migration node too, so the upgrade is not skipped as already done.
  "MATCH (m:Migration {key: 'gs1-allocation'}) DELETE m",
  'DROP CONSTRAINT gs1_namespace_key IF EXISTS',
  'DROP CONSTRAINT gs1_namespace_gcp IF EXISTS',
  'DROP CONSTRAINT gs1_issuance_key IF EXISTS',
  'DROP CONSTRAINT gs1_issuance_canonical IF EXISTS',
  'DROP CONSTRAINT gs1_issuance_asset IF EXISTS',
  'CREATE CONSTRAINT giai_namespace_key IF NOT EXISTS FOR (n:GiaiNamespace) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT giai_namespace_gcp IF NOT EXISTS FOR (n:GiaiNamespace) REQUIRE n.gcp IS UNIQUE',
  'CREATE CONSTRAINT giai_allocation_value IF NOT EXISTS FOR (n:GiaiAllocation) REQUIRE n.value IS UNIQUE',
  'CREATE CONSTRAINT giai_allocation_asset IF NOT EXISTS FOR (n:GiaiAllocation) REQUIRE n.allocatedForAssetId IS UNIQUE',
];

test('the GIAI-only allocation schema upgrades without losing provenance', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }
  const count = async (cypher: string, params = {}) =>
    (await query(cypher, params)).records[0].get('n').toNumber();

  // 1. A database as the previous milestone left it.
  const before = await IdentityStore.open(driver);
  const owner = await before.createUser('Prefix owner');
  const group = await before.createReportingGroup('Issuing team', owner.key);
  const context = { actorKey: owner.key, groupKey: group.key };
  const namespace = await before.configureGs1Namespace(owner.key, group.key,
    { gcp: '0614141', giaiExclusions: [{ from: 1, to: 4 }] });
  const asset = await before.reportAsset({ name: 'Migrated Asset' }, context);
  const issued = await before.issueKey(asset.id, owner.key, 'giai', { namespaceKey: namespace.key });
  const original = issued.issuances[0];
  assert.equal(original.sequence, 5, 'the configured exclusions were honoured before migration');

  for (const statement of downgrade) await query(statement);
  assert.equal(await count('MATCH (n:GiaiNamespace) RETURN count(n) AS n'), 1);
  assert.equal(await count('MATCH (l:GiaiAllocation) RETURN count(l) AS n'), 1);

  // 2. Opening the store migrates it.
  const store = await IdentityStore.open(driver);

  await t.test('no GIAI-only node or constraint survives', async () => {
    assert.equal(await count('MATCH (n) WHERE n:GiaiNamespace OR n:GiaiAllocation RETURN count(n) AS n'), 0);
    const constraints = await query('SHOW CONSTRAINTS YIELD name RETURN collect(name) AS names');
    const names = constraints.records[0].get('names') as string[];
    for (const retired of ['giai_namespace_key', 'giai_namespace_gcp',
      'giai_allocation_value', 'giai_allocation_asset']) {
      assert.ok(!names.includes(retired), `${retired} is still enforced`);
    }
    for (const required of ['gs1_namespace_key', 'gs1_namespace_gcp', 'gs1_issuance_key',
      'gs1_issuance_canonical', 'gs1_issuance_asset']) {
      assert.ok(names.includes(required), `${required} was not installed`);
    }
  });

  await t.test('the namespace keeps its counter and gains the two it lacked', async () => {
    const migrated = (await store.listGs1Namespaces(owner.key))
      .find((entry) => entry.key === namespace.key)!;
    assert.equal(migrated.gcp, '0614141');
    assert.equal(migrated.active, true);
    assert.equal(migrated.configuredBy, owner.key);
    // Carried across exactly: the counter had advanced past the exclusions.
    assert.equal(migrated.counters.giai.nextSequence, 6);
    assert.deepEqual(migrated.counters.giai.exclusions, [{ from: 1, to: 4 }]);
    // Started, not invented: a prefix that has issued no class key yet is at
    // the first sequence with nothing excluded.
    assert.equal(migrated.counters.graiType.nextSequence, 1);
    assert.deepEqual(migrated.counters.graiType.exclusions, []);
    assert.equal(migrated.counters.gtinItem.nextSequence, 1);
    assert.deepEqual(migrated.counters.gtinItem.exclusions, []);
  });

  await t.test('the issuance keeps every fact it carried, rebuilt through the GS1 boundary', async () => {
    const migrated = (await store.getAsset(asset.id, owner.key))!;
    assert.equal(migrated.issuances.length, 1);
    const row = migrated.issuances[0];
    assert.equal(row.scheme, 'giai');
    assert.equal(row.canonical, original.canonical);
    assert.equal(row.gcp, original.gcp);
    assert.equal(row.sequence, original.sequence);
    assert.equal(row.allocatedForAssetId, asset.id);
    assert.deepEqual(row.allocatedBy, original.allocatedBy);
    assert.equal(row.allocatedAt, original.allocatedAt);
    // A GIAI has no class level, so migration invents none for it.
    assert.equal(row.classKeyCanonical, null);
    assert.ok(row.key, 'the row gained the handle the new schema addresses it by');
    // The identifier itself is untouched and still attached.
    assert.ok(migrated.identifiers.some((identifier) => identifier.canonical === original.canonical));
    // And the ledger still reports it against its namespace.
    const ledger = await store.gs1Issuances(owner.key,
      { namespaceKey: namespace.key, scheme: null, limit: 10, after: null });
    assert.equal(ledger.matching, 1);
    assert.equal(ledger.entries[0].issuance.canonical, original.canonical);
    assert.equal(ledger.entries[0].asset?.id, asset.id);
  });

  await t.test('the migrated Asset can now carry a second scheme', async () => {
    // The whole point of retiring `allocatedForAssetId IS UNIQUE`: it was only
    // ever true because there was one scheme, and must not survive as a
    // cross-scheme rule the standards never state.
    const classKey = await store.manageClassKey(owner.key, namespace.key, { scheme: 'gtin' });
    const withSgtin = await store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: classKey.key });
    assert.deepEqual(withSgtin.issuances.map((issuance) => issuance.scheme).sort(), ['giai', 'sgtin']);
    // The migrated GIAI is undisturbed by the new issuance beside it.
    assert.ok(withSgtin.issuances.some((issuance) => issuance.canonical === original.canonical));
  });

  await t.test('migration is idempotent and safe to repeat', async () => {
    const again = await IdentityStore.open(driver);
    const reread = (await again.getAsset(asset.id, owner.key))!;
    assert.equal(reread.issuances.length, 2);
    assert.ok(reread.issuances.some((issuance) => issuance.canonical === original.canonical));
    assert.equal(await count('MATCH (n) WHERE n:GiaiNamespace OR n:GiaiAllocation RETURN count(n) AS n'), 0);
  });
});
