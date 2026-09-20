import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore, DuplicateIdentityError } from './identity-store.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('GIAI allocation is an invariant, not a code path', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  // A second store over the same database stands in for a second process.
  const peer = await IdentityStore.open(driver);
  const actor = await store.createUser('Allocator');
  const group = await store.createReportingGroup('Allocation team', actor.key);
  const context = { actorKey: actor.key, groupKey: group.key };
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }
  const counter = async (key: string) =>
    (await store.listGiaiNamespaces(actor.key)).find((namespace) => namespace.key === key)!.nextSequence;

  await t.test('concurrent allocation for one Asset issues once and wastes no sequence', async () => {
    const namespace = await store.configureGiaiNamespace(actor.key, group.key, { gcp: '0614141' });
    const asset = await store.reportAsset({ name: 'Contended Asset' }, context);
    const before = await counter(namespace.key);
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) =>
      (n % 2 ? peer : store).allocateGiai(asset.id, actor.key, namespace.key)));
    const values = results.map((result) => result.allocation!.value);
    // Every caller gets the same GIAI; the ledger holds exactly one row.
    assert.equal(new Set(values).size, 1, values.join(' '));
    assert.equal((await query('MATCH (l:GiaiAllocation) RETURN count(l) AS n')).records[0].get('n').toNumber(), 1);
    // Taking the namespace lock before the decision is what makes a
    // double-click cost exactly one sequence number.
    assert.equal(await counter(namespace.key), before + 1);
    assert.equal(results[0].allocation!.sequence, before);
  });

  await t.test('concurrent allocation for different Assets issues distinct, monotonic references', async () => {
    const namespace = await store.configureGiaiNamespace(actor.key, group.key,
      { gcp: '9521234', exclusions: [{ from: 1, to: 4 }, { from: 9, to: 11 }] });
    const assets = await Promise.all(Array.from({ length: 12 }, (_, n) =>
      store.reportAsset({ name: `Racing Asset ${n}` }, context)));
    const results = await Promise.all(assets.map((asset, n) =>
      (n % 2 ? peer : store).allocateGiai(asset.id, actor.key, namespace.key)));
    const sequences = results.map((result) => result.allocation!.sequence).sort((a, b) => a - b);
    // Excluded ranges are skipped even under contention, and nothing repeats.
    assert.deepEqual(sequences, [5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(new Set(results.map((result) => result.allocation!.value)).size, 12);
    assert.equal(await counter(namespace.key), 20);
    for (const result of results) {
      assert.equal(result.allocation!.value, '9521234' + String(result.allocation!.sequence));
    }
  });

  await t.test('one Asset racing two namespaces yields one allocation and no lost counter', async () => {
    const first = await store.configureGiaiNamespace(actor.key, group.key, { gcp: '0455123' });
    const second = await store.configureGiaiNamespace(actor.key, group.key, { gcp: '0771234' });
    const asset = await store.reportAsset({ name: 'Two namespace Asset' }, context);
    const results = await Promise.all([
      store.allocateGiai(asset.id, actor.key, first.key),
      peer.allocateGiai(asset.id, actor.key, second.key),
    ]);
    // The loser rolls back and returns the winner's allocation rather than
    // reporting a conflict the caller could not act on.
    assert.equal(results[0].allocation!.value, results[1].allocation!.value);
    const rows = await query('MATCH (l:GiaiAllocation {allocatedForAssetId: $id}) RETURN l.gcp AS gcp',
      { id: asset.id });
    assert.equal(rows.records.length, 1);
    const winner = rows.records[0].get('gcp') as string;
    const loser = winner === '0455123' ? second : first;
    // The losing transaction rolled its counter change back entirely.
    assert.equal(await counter(loser.key), 1);
    assert.equal(await counter(winner === '0455123' ? first.key : second.key), 2);
  });

  await t.test('the database refuses a duplicate issuance whatever the application does', async () => {
    const existing = await query('MATCH (l:GiaiAllocation) RETURN l.value AS value, l.allocatedForAssetId AS id LIMIT 1');
    const value = existing.records[0].get('value') as string;
    const allocatedForAssetId = existing.records[0].get('id') as string;
    // Uniqueness is schema, not sequencing: writing directly still fails.
    await assert.rejects(query(`CREATE (:GiaiAllocation {value: $value, gcp: 'x', sequence: 1,
      allocatedAt: datetime(), allocatedForAssetId: 'other-asset', allocatedBy: 'x'})`, { value }),
    /already exists|ConstraintValidationFailed/);
    await assert.rejects(query(`CREATE (:GiaiAllocation {value: 'unrelated-value', gcp: 'x', sequence: 1,
      allocatedAt: datetime(), allocatedForAssetId: $allocatedForAssetId, allocatedBy: 'x'})`, { allocatedForAssetId }),
    /already exists|ConstraintValidationFailed/);
    // And a second namespace can never be configured for a managed prefix.
    await assert.rejects(store.configureGiaiNamespace(actor.key, group.key, { gcp: '0614141' }), DuplicateIdentityError);
    assert.equal((await query("MATCH (n:GiaiNamespace {gcp: '0614141'}) RETURN count(n) AS n")).records[0].get('n').toNumber(), 1);
  });
});
