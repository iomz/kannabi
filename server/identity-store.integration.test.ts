import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j, { int } from 'neo4j-driver';
import { IdentityStore, DuplicateIdentityError, ReferenceError, type ReportAsset } from './identity-store.js';
import { ValidationError } from './identity.js';
import { gs1Policy } from './gs1.js';
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
    // Pre-Phase-2 Assets carry exactly one SGTIN or GRAI on the retired schema.
    await seed.run(`CREATE (:Asset {name: 'Legacy sgtin'})-[:IDENTIFIED_BY]->
        (:Identifier {scheme: 'sgtin', value: '00614141123452', serial: 'LEGACY-1'})`);
    await seed.run(`CREATE (:Asset {name: 'Legacy grai'})-[:IDENTIFIED_BY]->
        (:Identifier {scheme: 'grai', value: '00614141234561LEGACY-2', serial: ''})`);
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
    // The counted legacy population: the pre-migrated Asset, the id-less run,
    // and the two Assets seeded with pre-Phase-2 identifiers.
    assert.equal(Object.keys(assigned).length, legacyCount + 3);
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

  await t.test('pre-Phase-2 identifiers migrate into the external identifier model', async () => {
    const migrated = await query(`MATCH (a:Asset)-[:IDENTIFIED_BY]->(i:IndividualIdentifier)
      WHERE a.name STARTS WITH 'Legacy '
      RETURN a.name AS name, i.canonical AS canonical, i.scheme AS scheme,
        i.policyVersion AS policyVersion, i.key AS key ORDER BY a.name`);
    const rows = migrated.records.map((row) => row.toObject());
    assert.equal(rows.length, 2);
    // SGTIN components were already separate; GRAI decomposes without ambiguity.
    assert.deepEqual(rows.map((row) => row.canonical),
      ['(8003)00614141234561LEGACY-2', '(01)00614141123452(21)LEGACY-1']);
    assert.deepEqual(rows.map((row) => row.scheme), ['grai', 'sgtin']);
    for (const row of rows) {
      assert.equal(row.policyVersion, gs1Policy.version);
      assert.ok(row.key);
    }
    // Every legacy node and its retired constraint are gone, and no class-level
    // GTIN was materialised from the SGTIN: derived data stays derived.
    assert.equal((await query('MATCH (i:Identifier) RETURN count(i) AS n')).records[0].get('n').toNumber(), 0);
    assert.equal((await query('MATCH (c:ClassIdentifier) RETURN count(c) AS n')).records[0].get('n').toNumber(), 0);
    assert.equal((await query("SHOW CONSTRAINTS YIELD name WHERE name = 'identifier_claim' RETURN name")).records.length, 0);
    // Reopening is idempotent: attachment keys and values are untouched.
    await IdentityStore.open(driver);
    const again = await query(`MATCH (a:Asset)-[:IDENTIFIED_BY]->(i:IndividualIdentifier)
      WHERE a.name STARTS WITH 'Legacy ' RETURN i.key AS key ORDER BY a.name`);
    assert.deepEqual(again.records.map((r) => r.get('key')), rows.map((row) => row.key));
  });

  await t.test('corrupt pre-Phase-2 identifier data fails startup closed', async () => {
    for (const legacy of [
      { scheme: 'sgtin', value: '00614141123452', serial: '' },
      { scheme: 'sgtin', value: 'not-a-gtin', serial: 'X' },
      // GRAI without the zero filler, without a serial, and with a bad check digit.
      { scheme: 'grai', value: '10614141234561X', serial: '' },
      { scheme: 'grai', value: '00614141234561', serial: '' },
      { scheme: 'grai', value: '00614141234562X', serial: '' },
      { scheme: 'giai', value: '0614141ASSET', serial: '' },
      { scheme: 'unknown', value: 'x', serial: '' },
    ]) {
      await query(`CREATE (:Asset {name: 'Corrupt legacy', id: $id})-[:IDENTIFIED_BY]->(:Identifier $legacy)`,
        { id: newAssetId(), legacy });
      await assert.rejects(IdentityStore.open(driver), (error: Error) =>
        /cannot be migrated|not a zero-filled|GTIN|check digit|Serial|GRAI/.test(error.message), JSON.stringify(legacy));
      // Nothing was repaired or discarded on the way out.
      const survived = await query('MATCH (i:Identifier) RETURN i.scheme AS scheme, i.value AS value, i.serial AS serial');
      assert.deepEqual(survived.records.map((r) => r.toObject()), [legacy]);
      await query("MATCH (a:Asset {name: 'Corrupt legacy'})-[:IDENTIFIED_BY]->(i:Identifier) DETACH DELETE a, i");
    }
    await IdentityStore.open(driver);
  });

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
    await run(`MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy'
      OPTIONAL MATCH (a)-[:IDENTIFIED_BY]->(i:IndividualIdentifier)
      DETACH DELETE a, i`);
  });

  const user = await store.createUser('Reporter');
  const outsider = await store.createUser('Other user');
  const group = await store.createGroup('Inventory team');
  const owner = await store.createOwner('Shared laboratory');
  await store.addMember(user.key, group.key);
  await store.addMember(user.key, group.key);
  const context = { actorKey: user.key, groupKey: group.key };
  const sgtin = (serial: string) => ({ scheme: 'sgtin' as const, gtin: '0614141123452', serial });
  const grai = { scheme: 'grai' as const, assetType: '0614141234561', serial: '789' };
  const gtin = { scheme: 'gtin' as const, gtin: '0614141123452' };
  const giai = (reference: string) => ({ scheme: 'giai' as const, assetReference: reference });
  const canonicals = (asset: { identifiers: readonly { canonical: string }[] }) =>
    asset.identifiers.map((identifier) => identifier.canonical).sort();
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); }
    finally { await session.close(); }
  }
  async function counts() {
    const result = await query(`MATCH (a:Asset) WITH count(a) AS assets
      OPTIONAL MATCH (i:IndividualIdentifier) RETURN assets, count(i) AS identifiers`);
    return result.records[0].toObject();
  }

  let oscilloscope = '';
  await t.test('reporting persists identity, independent Owner, explicit Group and automatic provenance', async () => {
    const start = Date.now();
    const asset = await store.reportAsset({ name: '  Oscilloscope  ', identifiers: [sgtin('001')], ownerKey: owner.key }, context);
    oscilloscope = asset.id;
    assert.equal(asset.name, 'Oscilloscope');
    assert.deepEqual(canonicals(asset), ['(01)00614141123452(21)001']);
    assert.deepEqual(asset.identifiers[0].components, { gtin: '00614141123452', serial: '001' });
    assert.equal(asset.identifiers[0].level, 'individual');
    // The accepting policy version is recorded and cannot be reconstructed later.
    assert.equal(asset.identifiers[0].policyVersion, gs1Policy.version);
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
      { name: 'Asset', identifiers: [sgtin('bad'), sgtin('bad')] },
      { name: 'Asset', identifiers: [sgtin('bad'), { scheme: 'gtin', gtin: '4901234567894' }] },
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

  await t.test('an individual identifier may identify only one Asset', async () => {
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
    // Serialised GRAI and GIAI are exclusive in exactly the same way as SGTIN.
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate GRAI', identifiers: [grai] }, context), DuplicateIdentityError);
    const tagged = await store.reportAsset({ name: 'Tagged laptop', identifiers: [giai('0614141LAPTOP-1')] }, context);
    assert.equal(tagged.identifiers[0].level, 'individual');
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate GIAI',
      identifiers: [giai('0614141LAPTOP-1')] }, context), DuplicateIdentityError);
  });

  await t.test('an Asset exists with no external identifier and gains or loses them later', async () => {
    const prototype = await store.reportAsset({ name: 'Bench prototype' }, context);
    assert.deepEqual(prototype.identifiers, []);
    assert.deepEqual(await store.getAsset(prototype.id, user.key), prototype);
    // Registration requires no GS1 knowledge; identification is layered on after.
    const withGiai = await store.attachIdentifier(prototype.id, user.key, giai('0614141PROTO-001'));
    assert.deepEqual(canonicals(withGiai), ['(8004)0614141PROTO-001']);
    assert.equal(withGiai.id, prototype.id);
    const withBoth = await store.attachIdentifier(prototype.id, user.key, sgtin('proto'));
    assert.deepEqual(canonicals(withBoth), ['(01)00614141123452(21)proto', '(8004)0614141PROTO-001']);
    // Detaching leaves the Asset and its native identity untouched.
    const giaiKey = withBoth.identifiers.find((i) => i.scheme === 'giai')!.key;
    const detached = await store.detachIdentifier(prototype.id, user.key, giaiKey);
    assert.deepEqual(canonicals(detached), ['(01)00614141123452(21)proto']);
    assert.equal(detached.id, prototype.id);
    assert.equal((await query('MATCH (n:IndividualIdentifier {canonical: $c}) RETURN n',
      { c: '(8004)0614141PROTO-001' })).records.length, 0);
    // A detached individual identifier is not an allocation, so it can be reused.
    const reused = await store.attachIdentifier(withGiai.id, user.key, giai('0614141PROTO-001'));
    assert.deepEqual(canonicals(reused), ['(01)00614141123452(21)proto', '(8004)0614141PROTO-001']);
    await assert.rejects(store.attachIdentifier(prototype.id, user.key, sgtin('proto')), ValidationError);
    await assert.rejects(store.attachIdentifier(prototype.id, outsider.key, giai('0614141DENIED')), ReferenceError);
    await assert.rejects(store.detachIdentifier(prototype.id, outsider.key, giaiKey), ReferenceError);
    await assert.rejects(store.detachIdentifier(prototype.id, user.key, 'missing-key'), ReferenceError);
  });

  await t.test('class identifiers are shared while individual identifiers stay exclusive', async () => {
    const first = await store.reportAsset({ name: 'Laptop A', identifiers: [gtin, sgtin('lap-a')] }, context);
    const second = await store.reportAsset({ name: 'Laptop B', identifiers: [gtin, sgtin('lap-b')] }, context);
    const third = await store.reportAsset({ name: 'Laptop C', identifiers: [gtin] }, context);
    for (const asset of [first, second, third]) {
      assert.ok(asset.identifiers.some((i) => i.canonical === '(01)00614141123452' && i.level === 'class'));
    }
    // One shared node, three Assets: a class identifier describes, never identifies.
    const shared = await query(`MATCH (c:ClassIdentifier {canonical: '(01)00614141123452'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets, count(c) AS nodes`);
    assert.equal(shared.records[0].get('nodes').toNumber(), 1);
    assert.equal(shared.records[0].get('assets').toNumber(), 3);
    // A type-level GRAI is equally shareable across returnable assets.
    const type = { scheme: 'grai' as const, assetType: '0614141234561' };
    const pallets = await Promise.all(['Pallet A', 'Pallet B'].map((name) =>
      store.reportAsset({ name, identifiers: [type] }, context)));
    for (const pallet of pallets) assert.equal(pallet.identifiers[0].level, 'class');
    assert.equal((await query(`MATCH (c:ClassIdentifier {canonical: '(8003)00614141234561'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets`)).records[0].get('assets').toNumber(), 2);
    // Detaching a shared class identifier leaves it for the remaining Assets.
    const classKey = third.identifiers[0].key;
    assert.deepEqual((await store.detachIdentifier(third.id, user.key, classKey)).identifiers, []);
    assert.equal((await query(`MATCH (c:ClassIdentifier {canonical: '(01)00614141123452'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets`)).records[0].get('assets').toNumber(), 2);
  });

  await t.test('concurrent writers yield exactly one claim and no orphan Assets or identifiers', async () => {
    for (const identity of [sgtin('race'), { ...grai, serial: 'race' }, giai('0614141RACE')]) {
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
    assert.deepEqual(canonicals(changed), canonicals(before));
    assert.deepEqual(changed.groups, before.groups);
    assert.equal((await store.updateAsset(oscilloscope, { ownerKey: null }, user.key)).owner, null);
    for (const changes of [
      { reportedAt: '2000-01-01T00:00:00Z' }, { reportedBy: outsider.key }, { id: newAssetId() },
      { identifier: grai }, { identifiers: [grai] }, { name: '' }, { name: undefined },
      // Identifiers are never edited through the Asset update path.
      { identifierKey: 'x' },
    ]) await assert.rejects(store.updateAsset(oscilloscope, changes as never, user.key), ValidationError);
    await assert.rejects(store.updateAsset(oscilloscope, { name: 'Must roll back', ownerKey: 'missing' }, user.key), ReferenceError);
    const after = (await store.getAsset(oscilloscope, user.key))!;
    assert.equal(after.name, 'Updated name');
    assert.equal(after.id, oscilloscope);
    // An unknown but well-formed native id is simply absent; a malformed one is rejected.
    assert.equal(await store.getAsset(newAssetId(), user.key), null);
    await assert.rejects(store.getAsset('not-a-native-id', user.key), ValidationError);
  });

  await t.test('a GIAI namespace belongs to one Group and its prefix is immutable', async () => {
    const owner = await store.createUser('Namespace owner');
    const otherOwner = await store.createUser('Other namespace owner');
    const nsGroup = await store.createReportingGroup('Allocating team', owner.key);
    const rival = await store.createReportingGroup('Rival team', otherOwner.key);
    const plain = await store.configureGiaiNamespace(owner.key, nsGroup.key, { gcp: '0614141' });
    assert.equal(plain.gcp, '0614141');
    assert.equal(plain.active, true);
    assert.equal(plain.nextSequence, 1);
    assert.deepEqual(plain.exclusions, []);
    assert.equal(plain.configuredBy, owner.key);
    assert.deepEqual(plain.group, nsGroup);
    // Overlapping and adjacent input normalises on the way in.
    const excluded = await store.configureGiaiNamespace(owner.key, nsGroup.key, {
      gcp: '9521234', exclusions: [{ from: 9, to: 11 }, { from: 1, to: 4 }, { from: 3, to: 4 }, { from: 200, to: 300 }],
    });
    assert.deepEqual(excluded.exclusions, [{ from: 1, to: 4 }, { from: 9, to: 11 }, { from: 200, to: 300 }]);
    for (const invalid of [
      { gcp: '06141A1' }, { gcp: '' }, { gcp: '9'.repeat(30) },
      { gcp: '1112223', exclusions: [{ from: 0 }] },
      { gcp: '1112223', exclusions: [{ from: 9, to: 4 }] },
      { gcp: '1112223', exclusions: 'ranges' },
      { gcp: '1112223', prefix: 'extra' },
    ]) await assert.rejects(store.configureGiaiNamespace(owner.key, nsGroup.key, invalid), ValidationError, JSON.stringify(invalid));
    // One managed GCP, one counter, one Group.
    await assert.rejects(store.configureGiaiNamespace(owner.key, nsGroup.key, { gcp: '0614141' }),
      (error: Error) => error instanceof DuplicateIdentityError && /already configured for this Group/.test(error.message));
    await assert.rejects(store.configureGiaiNamespace(otherOwner.key, rival.key, { gcp: '0614141' }),
      (error: Error) => error instanceof DuplicateIdentityError && /managed by another Group/.test(error.message));
    // The prefix is not an editable field at all: there is no path to change it.
    assert.equal((await store.listGiaiNamespaces(owner.key)).map((n) => n.gcp).join(), '0614141,9521234');
    assert.deepEqual(await store.listGiaiNamespaces(otherOwner.key), []);
    // Namespace keys are not authority; a non-member sees and changes nothing.
    await assert.rejects(store.setGiaiNamespaceActive(otherOwner.key, plain.key, false), ReferenceError);
    await assert.rejects(store.configureGiaiNamespace(otherOwner.key, nsGroup.key, { gcp: '7778889' }), ReferenceError);
  });

  await t.test('allocation issues monotonic references, skipping existing use', async () => {
    const owner = (await store.listGiaiNamespaces((await store.createUser('unused')).key), await store.createUser('Allocator'));
    const group = await store.createReportingGroup('Allocation group', owner.key);
    const namespace = await store.configureGiaiNamespace(owner.key, group.key,
      { gcp: '0455123', exclusions: [{ from: 1, to: 4 }, { from: 9, to: 11 }] });
    const context = { actorKey: owner.key, groupKey: group.key };
    const assets = [];
    for (let n = 0; n < 5; n++) assets.push(await store.reportAsset({ name: `Allocated ${n}` }, context));
    const issued = [];
    for (const asset of assets) issued.push(await store.allocateGiai(asset.id, owner.key, namespace.key));
    // Excluded references are skipped by range, never issued.
    assert.deepEqual(issued.map((asset) => asset.allocation!.sequence), [5, 6, 7, 8, 12]);
    assert.deepEqual(issued.map((asset) => asset.allocation!.value),
      ['04551235', '04551236', '04551237', '04551238', '045512312']);
    for (const asset of issued) {
      assert.equal(asset.allocation!.gcp, '0455123');
      // Allocation provenance follows the same public shape as reportedBy:
      // attribution, never the bare actor key the ledger stores internally.
      assert.deepEqual(asset.allocation!.allocatedBy, { ...owner, status: 'active' });
      assert.equal(asset.allocation!.allocatedForAssetId, asset.id);
      // The issued GIAI is attached through ordinary Phase 2 semantics.
      assert.ok(asset.identifiers.some((identifier) =>
        identifier.scheme === 'giai' && identifier.components.assetReference === asset.allocation!.value));
    }
    // Repeating returns the existing issuance and consumes no sequence.
    const before = (await store.listGiaiNamespaces(owner.key)).find((n) => n.key === namespace.key)!.nextSequence;
    const repeated = await store.allocateGiai(assets[0].id, owner.key, namespace.key);
    assert.deepEqual(repeated.allocation, issued[0].allocation);
    assert.equal((await store.listGiaiNamespaces(owner.key)).find((n) => n.key === namespace.key)!.nextSequence, before);
  });

  await t.test('an issued GIAI is bound to its Asset for good', async () => {
    const owner = await store.createUser('Ledger owner');
    const group = await store.createReportingGroup('Ledger group', owner.key);
    const namespace = await store.configureGiaiNamespace(owner.key, group.key, { gcp: '0771234' });
    const context = { actorKey: owner.key, groupKey: group.key };
    const first = await store.reportAsset({ name: 'Issued Asset' }, context);
    const second = await store.reportAsset({ name: 'Other Asset' }, context);
    const allocated = await store.allocateGiai(first.id, owner.key, namespace.key);
    const value = allocated.allocation!.value;
    const attachment = allocated.identifiers.find((identifier) => identifier.scheme === 'giai')!.key;

    // Detaching removes the identifier and leaves the issuance untouched.
    const detached = await store.detachIdentifier(first.id, owner.key, attachment);
    assert.deepEqual(detached.identifiers, []);
    assert.equal(detached.allocation!.value, value);
    // Allocating again returns the same issuance rather than a second one.
    const again = await store.allocateGiai(first.id, owner.key, namespace.key);
    assert.deepEqual(again.allocation, allocated.allocation);
    // It may return to the Asset it was issued for, and only to that Asset.
    await assert.rejects(store.attachIdentifier(second.id, owner.key,
      { scheme: 'giai', assetReference: value }), (error: Error) =>
      error instanceof ValidationError && /issued that GIAI for another Asset/.test(error.message));
    const restored = await store.attachIdentifier(first.id, owner.key, { scheme: 'giai', assetReference: value });
    assert.ok(restored.identifiers.some((identifier) => identifier.components.assetReference === value));
    // An externally assigned GIAI keeps Phase 2 correction semantics.
    const external = { scheme: 'giai' as const, assetReference: 'EXTERNAL-0001' };
    const wrong = await store.attachIdentifier(second.id, owner.key, external);
    const wrongKey = wrong.identifiers.find((identifier) => identifier.scheme === 'giai')!.key;
    await store.detachIdentifier(second.id, owner.key, wrongKey);
    const third = await store.reportAsset({ name: 'Correct Asset' }, context);
    assert.ok((await store.attachIdentifier(third.id, owner.key, external)).identifiers.length);
    // The ledger survives the Asset itself.
    await query('MATCH (a:Asset {id: $id}) DETACH DELETE a', { id: first.id });
    const orphaned = await query('MATCH (l:GiaiAllocation {value: $value}) RETURN l.allocatedForAssetId AS assetId',
      { value });
    assert.equal(orphaned.records[0].get('assetId'), first.id);
  });

  await t.test('allocation provenance degrades to a tombstone like reportedBy', async () => {
    const leaving = await store.createUser('Departing allocator');
    const group = await store.createReportingGroup('Tombstone group', leaving.key);
    const namespace = await store.configureGiaiNamespace(leaving.key, group.key, { gcp: '0334455' });
    const asset = await store.reportAsset({ name: 'Outliving its allocator' },
      { actorKey: leaving.key, groupKey: group.key });
    const allocated = await store.allocateGiai(asset.id, leaving.key, namespace.key);
    assert.deepEqual(allocated.allocation!.allocatedBy, { ...leaving, status: 'active' });
    // Tombstone the allocator exactly as member deactivation does.
    await query(`MATCH (u:User {key: $key})
      SET u.provenanceName = u.name, u.accountDeletedAt = datetime() REMOVE u.name`, { key: leaving.key });
    const after = (await query(`MATCH (a:Asset {id: $id}) RETURN a`, { id: asset.id })).records.length;
    assert.equal(after, 1);
    const reread = await store.getAsset(asset.id, leaving.key);
    assert.deepEqual(reread!.allocation!.allocatedBy,
      { key: leaving.key, name: 'Departing allocator', status: 'deleted' });
    // No email, role or credential material reaches the public representation.
    for (const field of ['email', 'role', 'password', 'id', 'accountDeletedAt', 'provenanceName']) {
      assert.equal(field in reread!.allocation!.allocatedBy, false, field);
    }
    assert.deepEqual(Object.keys(reread!.allocation!.allocatedBy).sort(), ['key', 'name', 'status']);
    assert.deepEqual(Object.keys(reread!.allocation!).sort(),
      ['allocatedAt', 'allocatedBy', 'allocatedForAssetId', 'gcp', 'sequence', 'value']);
  });

  await t.test('deactivation stops issuance and preserves the counter', async () => {
    const owner = await store.createUser('Lifecycle owner');
    const group = await store.createReportingGroup('Lifecycle group', owner.key);
    const namespace = await store.configureGiaiNamespace(owner.key, group.key,
      { gcp: '0881234', exclusions: [{ from: 1, to: 2 }] });
    const context = { actorKey: owner.key, groupKey: group.key };
    const first = await store.reportAsset({ name: 'Before deactivation' }, context);
    assert.equal((await store.allocateGiai(first.id, owner.key, namespace.key)).allocation!.sequence, 3);

    const inactive = await store.setGiaiNamespaceActive(owner.key, namespace.key, false);
    assert.equal(inactive.active, false);
    assert.equal(inactive.nextSequence, 4);
    assert.deepEqual(inactive.exclusions, [{ from: 1, to: 2 }]);
    const blocked = await store.reportAsset({ name: 'During deactivation' }, context);
    await assert.rejects(store.allocateGiai(blocked.id, owner.key, namespace.key),
      (error: Error) => error instanceof ValidationError && /deactivated/.test(error.message));
    // An existing issuance is still returned while the namespace is inactive.
    assert.equal((await store.allocateGiai(first.id, owner.key, namespace.key)).allocation!.sequence, 3);

    const active = await store.setGiaiNamespaceActive(owner.key, namespace.key, true);
    assert.equal(active.active, true);
    // The same namespace resumes; no new counter was created for this prefix.
    assert.equal((await store.allocateGiai(blocked.id, owner.key, namespace.key)).allocation!.sequence, 4);
    assert.equal((await query('MATCH (n:GiaiNamespace {gcp: $gcp}) RETURN count(n) AS n',
      { gcp: '0881234' })).records[0].get('n').toNumber(), 1);
  });

  await t.test('allocation authority comes from the namespace Group, not from the Asset alone', async () => {
    const owner = await store.createUser('Authority owner');
    const collaborator = await store.createUser('Authority collaborator');
    const stranger = await store.createUser('Authority stranger');
    const group = await store.createReportingGroup('Authority group', owner.key);
    const detached = await store.createReportingGroup('Namespace only group', collaborator.key);
    await store.addGroupMember(owner.key, group.key, collaborator.key);
    const namespace = await store.configureGiaiNamespace(owner.key, group.key, { gcp: '0991234' });
    const foreign = await store.configureGiaiNamespace(collaborator.key, detached.key, { gcp: '0991235' });
    const asset = await store.reportAsset({ name: 'Authority Asset' }, { actorKey: owner.key, groupKey: group.key });
    // A stranger, and a member of a Group that manages a namespace but does not
    // collaborate on the Asset, are both refused.
    await assert.rejects(store.allocateGiai(asset.id, stranger.key, namespace.key), ReferenceError);
    await assert.rejects(store.allocateGiai(asset.id, collaborator.key, foreign.key), ReferenceError);
    await assert.rejects(store.allocateGiai(asset.id, owner.key, 'not-a-namespace'), ReferenceError);
    // A Group member of the namespace-owning Group that collaborates succeeds.
    assert.ok((await store.allocateGiai(asset.id, collaborator.key, namespace.key)).allocation);
  });

  await t.test('schema initialization fails closed when a constraint name masks the required schema', async () => {
    // This test runs last and only against the disposable database.
    await query('DROP CONSTRAINT individual_identifier');
    await query('CREATE CONSTRAINT individual_identifier FOR (n:Unrelated) REQUIRE n.key IS UNIQUE');
    await assert.rejects(IdentityStore.open(driver), /Required uniqueness constraint is missing for IndividualIdentifier/);
  });
});
