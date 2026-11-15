import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j, { int } from 'neo4j-driver';
import { IdentityStore, DuplicateIdentityError, ReferenceError, type ReportAsset } from './identity-store.js';
import { ValidationError } from './identity.js';
import { emptyAssetFilters } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { isAssetId, newAssetId } from './asset-id.js';
import { composition } from './test-fixture.js';
const { schemes } = composition;

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
  const store = await IdentityStore.open(driver, composition);
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
      // A schema backfill has no actor and asserts nothing. Stamping one would
      // manufacture provenance for a change nobody made, so every migrated
      // Asset keeps an absent record rather than a plausible-looking one.
      const stamped = await session.run(`MATCH (a:Asset) WHERE a.name STARTS WITH 'Legacy'
        AND (a.changeAcceptedAt IS NOT NULL OR a.changeAcceptedBy IS NOT NULL
          OR a.changeAssertedById IS NOT NULL OR a.changeBasis IS NOT NULL)
        RETURN count(a) AS n`);
      assert.equal(stamped.records[0].get('n').toNumber(), 0);
      const constraints = await session.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties RETURN *');
      for (const label of ['Asset', 'Migration']) {
        assert.ok(constraints.records.some((row) => row.get('type') === 'UNIQUENESS'
          && JSON.stringify(row.get('labelsOrTypes')) === JSON.stringify([label])), label);
      }
    } finally { await session.close(); }
    // Reopening must never replace an already assigned native identity.
    await IdentityStore.open(driver, composition);
    assert.deepEqual(await legacyIds(), assigned);
  });

  const otherStore = await IdentityStore.open(driver, composition);

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
      const results = await Promise.allSettled(peers.map((peer) => IdentityStore.open(peer, composition)));
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
      await assert.rejects(IdentityStore.open(driver, composition), /missing or invalid native id/, String(invalid));
      assert.deepEqual(await readId(), invalid, String(invalid));
    }
    // A removed id is legacy data, not corruption: it is backfilled, not rejected.
    await run("MATCH (a:Asset {name: 'Legacy 1'}) REMOVE a.id");
    await IdentityStore.open(driver, composition);
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
  // Individual-level identifiers, and one class-level identifier several
  // Assets share.
  const tag = (code: string) => ({ scheme: 'tag' as const, code: 'T-' + code });
  const container = tag('container-789');
  const model = { scheme: 'model' as const, series: 'laptop' };
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
    const asset = await store.reportAsset({ name: '  Oscilloscope  ', identifiers: [tag('001')], ownerKey: owner.key }, context);
    oscilloscope = asset.id;
    assert.equal(asset.name, 'Oscilloscope');
    assert.deepEqual(canonicals(asset), ['tag:T-001']);
    assert.deepEqual(asset.identifiers[0].components, { code: 'T-001' });
    assert.equal(asset.identifiers[0].level, 'individual');
    // The accepting policy version is recorded and cannot be reconstructed later.
    assert.equal(asset.identifiers[0].policyVersion, 'shelf-1');
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
      { name: '', identifiers: [tag('bad')] },
      { name: 'Asset', identifiers: [tag('bad'), tag('bad')] },
      { name: 'Asset', identifiers: [tag('bad')], reportedBy: outsider.key },
      { name: 'Asset', identifiers: [tag('bad')], reportedAt: '2000-01-01T00:00:00Z' },
    ]) await assert.rejects(store.reportAsset(input as ReportAsset, context), ValidationError);
    await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [tag('bad')] },
      { actorKey: user.key, groupKey: '' }), ValidationError);
    for (const actorKey of [outsider.key, 'missing-user']) {
      await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [tag('bad')] },
        { actorKey, groupKey: group.key }), ReferenceError);
    }
    await assert.rejects(store.reportAsset({ name: 'Asset', identifiers: [tag('bad')], ownerKey: 'missing' }, context), ReferenceError);
    await assert.rejects(store.addMember(user.key, 'missing'), ReferenceError);
    assert.deepEqual(await counts(), before);
  });

  await t.test('an individual identifier may identify only one Asset', async () => {
    const before = await counts();
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate', identifiers: [tag('001')] }, context),
      DuplicateIdentityError);
    assert.deepEqual(await counts(), before);
    assert.equal((await store.getAsset(oscilloscope, user.key))?.name, 'Oscilloscope');
    const asset = await store.reportAsset({ name: 'Reusable container', identifiers: [container] }, context);
    assert.equal(asset.owner, null);
    assert.notEqual(asset.id, oscilloscope);
    assert.deepEqual(await store.getAsset(asset.id, user.key), asset);
    // Every individual-level identifier is exclusive in exactly the same way.
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate container', identifiers: [container] }, context), DuplicateIdentityError);
    const tagged = await store.reportAsset({ name: 'Tagged laptop', identifiers: [tag('LAPTOP-1')] }, context);
    assert.equal(tagged.identifiers[0].level, 'individual');
    await assert.rejects(otherStore.reportAsset({ name: 'Duplicate tag',
      identifiers: [tag('LAPTOP-1')] }, context), DuplicateIdentityError);
  });

  await t.test('an Asset exists with no external identifier and gains or loses them later', async () => {
    const prototype = await store.reportAsset({ name: 'Bench prototype' }, context);
    assert.deepEqual(prototype.identifiers, []);
    assert.deepEqual(await store.getAsset(prototype.id, user.key), prototype);
    // Registration requires no scheme's knowledge; identification is layered on after.
    const withFirst = await store.attachIdentifier(prototype.id, user.key, tag('PROTO-001'));
    assert.deepEqual(canonicals(withFirst), ['tag:T-PROTO-001']);
    assert.equal(withFirst.id, prototype.id);
    const withBoth = await store.attachIdentifier(prototype.id, user.key, tag('proto'));
    assert.deepEqual(canonicals(withBoth), ['tag:T-PROTO-001', 'tag:T-proto']);
    // Detaching leaves the Asset and its native identity untouched.
    const firstKey = withBoth.identifiers.find((i) => i.canonical === 'tag:T-PROTO-001')!.key;
    const detached = await store.detachIdentifier(prototype.id, user.key, firstKey);
    assert.deepEqual(canonicals(detached), ['tag:T-proto']);
    assert.equal(detached.id, prototype.id);
    assert.equal((await query('MATCH (n:IndividualIdentifier {canonical: $c}) RETURN n',
      { c: 'tag:T-PROTO-001' })).records.length, 0);
    // A detached individual identifier is not an allocation, so it can be reused.
    const reused = await store.attachIdentifier(withFirst.id, user.key, tag('PROTO-001'));
    assert.deepEqual(canonicals(reused), ['tag:T-PROTO-001', 'tag:T-proto']);
    await assert.rejects(store.attachIdentifier(prototype.id, user.key, tag('proto')), ValidationError);
    await assert.rejects(store.attachIdentifier(prototype.id, outsider.key, tag('DENIED')), ReferenceError);
    await assert.rejects(store.detachIdentifier(prototype.id, outsider.key, firstKey), ReferenceError);
    await assert.rejects(store.detachIdentifier(prototype.id, user.key, 'missing-key'), ReferenceError);
  });

  await t.test('class identifiers are shared while individual identifiers stay exclusive', async () => {
    const first = await store.reportAsset({ name: 'Laptop A', identifiers: [model, tag('lap-a')] }, context);
    const second = await store.reportAsset({ name: 'Laptop B', identifiers: [model, tag('lap-b')] }, context);
    const third = await store.reportAsset({ name: 'Laptop C', identifiers: [model] }, context);
    for (const asset of [first, second, third]) {
      assert.ok(asset.identifiers.some((i) => i.canonical === 'model:laptop' && i.level === 'class'));
    }
    // One shared node, three Assets: a class identifier describes, never identifies.
    const shared = await query(`MATCH (c:ClassIdentifier {canonical: 'model:laptop'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets, count(c) AS nodes`);
    assert.equal(shared.records[0].get('nodes').toNumber(), 1);
    assert.equal(shared.records[0].get('assets').toNumber(), 3);
    // Any class-level identifier is equally shareable.
    const type = { scheme: 'model' as const, series: 'pallet' };
    const pallets = await Promise.all(['Pallet A', 'Pallet B'].map((name) =>
      store.reportAsset({ name, identifiers: [type] }, context)));
    for (const pallet of pallets) assert.equal(pallet.identifiers[0].level, 'class');
    assert.equal((await query(`MATCH (c:ClassIdentifier {canonical: 'model:pallet'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets`)).records[0].get('assets').toNumber(), 2);
    // Detaching a shared class identifier leaves it for the remaining Assets.
    const classKey = third.identifiers[0].key;
    assert.deepEqual((await store.detachIdentifier(third.id, user.key, classKey)).identifiers, []);
    assert.equal((await query(`MATCH (c:ClassIdentifier {canonical: 'model:laptop'})
      RETURN count { (c)<-[:CLASSIFIED_AS]-(:Asset) } AS assets`)).records[0].get('assets').toNumber(), 2);
  });

  await t.test('concurrent writers yield exactly one claim and no orphan Assets or identifiers', async () => {
    for (const identity of [tag('race'), tag('RACE')]) {
      const before = await counts();
      const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => {
        return (n % 2 ? store : otherStore).reportAsset({ name: `Writer ${n}`, identifiers: [identity] }, context);
      }));
      assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
      for (const result of writes) {
        if (result.status === 'rejected') assert.ok(result.reason instanceof DuplicateIdentityError, String(result.reason));
      }
      const after = await counts();
      assert.equal(after.assets.toNumber(), before.assets.toNumber() + 1);
      assert.equal(after.identifiers.toNumber(), before.identifiers.toNumber() + 1);
    }
    // Distinct values remain distinct, however alike they look.
    const zero = await store.reportAsset({ name: 'Zero', identifiers: [tag('0')] }, context);
    const doubleZero = await store.reportAsset({ name: 'Double zero', identifiers: [tag('00')] }, context);
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
      { identifier: container }, { identifiers: [container] }, { name: '' }, { name: undefined },
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

  await t.test('every canonical change records who accepted it and who asserted it', async () => {
    const stored = async (id: string) => (await query(`MATCH (a:Asset {id: $id})
      RETURN a.changeAcceptedBy AS acceptedBy, a.changeAssertedById AS assertedById,
        a.changeAssertedByLabel AS assertedByLabel, a.changeBasis AS basis,
        a.changeAcceptedAt IS NOT NULL AS stamped`, { id })).records[0].toObject();
    const credential = (n: number) => ({ id: `token-${n}`, label: `Importer ${n}` });

    // Reporting is itself the first canonical change, so provenance is present
    // from the start rather than appearing only once something is edited.
    const asset = await store.reportAsset({ name: 'Provenance bench', identifiers: [tag('900')] }, context);
    assert.deepEqual(Object.keys(asset.provenance!).sort(),
      ['acceptedAt', 'acceptedBy', 'assertedBy', 'basis']);
    assert.deepEqual(asset.provenance!.acceptedBy, { ...user, status: 'active' });
    // A person editing directly is the asserter; null says so without naming them twice.
    assert.equal(asset.provenance!.assertedBy, null);
    assert.equal(asset.provenance!.basis, null);
    assert.ok(Date.parse(asset.provenance!.acceptedAt) > 0);

    // Each write path moves the record forward, in the same statement as the change.
    const paths: [string, () => Promise<unknown>][] = [
      ['update', () => store.updateAsset(asset.id, { name: 'Provenance bench 2' }, user.key,
        { assertedBy: credential(1), basis: 'depot:assets:42' })],
      ['attach', () => store.attachIdentifier(asset.id, user.key, model, { assertedBy: credential(2) })],
      ['detach', async () => {
        const current = (await store.getAsset(asset.id, user.key))!;
        const attached = current.identifiers.find((i) => i.canonical === 'model:laptop')!;
        return store.detachIdentifier(asset.id, user.key, attached.key, { assertedBy: credential(3) });
      }],
      ['photo attach', async () => {
        const photoKey = await store.reservePhoto('image/png', 12);
        return store.attachPhoto(asset.id, user.key, photoKey, { assertedBy: credential(4) });
      }],
      ['photo delete', async () => {
        const current = (await store.getAsset(asset.id, user.key))!;
        return store.beginPhotoDeletion(asset.id, user.key, current.photos[0].key, { assertedBy: credential(5) });
      }],
    ];
    let previous = asset.provenance!.acceptedAt;
    for (const [index, [label, run]] of paths.entries()) {
      await run();
      const now = (await store.getAsset(asset.id, user.key))!.provenance!;
      assert.deepEqual(now.assertedBy, credential(index + 1), label);
      assert.deepEqual(now.acceptedBy, { ...user, status: 'active' }, label);
      assert.ok(Date.parse(now.acceptedAt) >= Date.parse(previous), label);
      // Only the update stated a basis, and it is carried verbatim rather than
      // parsed; every later change replaces the whole record instead of
      // inheriting it.
      assert.equal(now.basis, index === 0 ? 'depot:assets:42' : null, label);
      // The credential is flattened onto the Asset, so a revoked or renamed
      // token can never make historical provenance unreadable.
      const row = await stored(asset.id);
      assert.equal(row.assertedById, credential(index + 1).id, label);
      assert.equal(row.assertedByLabel, credential(index + 1).label, label);
      previous = now.acceptedAt;
    }

    // The asserting credential never nominates the accepting authority.
    const claimed = await store.updateAsset(asset.id, { name: 'Provenance bench 3' }, user.key,
      { assertedBy: { id: outsider.key, label: 'Impostor' } });
    assert.equal(claimed.provenance!.acceptedBy.key, user.key);
    assert.equal((await stored(asset.id)).acceptedBy, user.key);

    // Origin is validated like any other input and cannot carry structure.
    for (const origin of [
      { assertedBy: { id: '', label: 'x' } }, { assertedBy: { id: 'x', label: '   ' } },
      { assertedBy: { id: 'x\u0000y', label: 'x' } }, { assertedBy: { id: 'x', label: 'a'.repeat(81) } },
      { assertedBy: 'importer' }, { assertedBy: { id: 'x' } }, { assertedBy: { id: 'x', label: 'y', extra: 1 } },
      { unsupported: 'x' },
    ]) {
      await assert.rejects(store.updateAsset(asset.id, { name: 'Rejected' }, user.key, origin as never),
        ValidationError, JSON.stringify(origin));
    }

    // `basis` is a bounded ASCII reference: it identifies the basis and is
    // never the basis itself, which is what keeps it safe to publish.
    for (const basis of ['depot:assets:123', 'erp:equipment:4567', 'a', 'A1/b_c.d-e', 'x'.repeat(128)]) {
      const ok = await store.updateAsset(asset.id, { name: 'Provenance bench 3' }, user.key, { basis });
      assert.equal(ok.provenance!.basis, basis, basis);
    }
    for (const basis of ['has space', 'ends\tcontrol', '日本語', '_leading', '-leading', '.leading',
      'x'.repeat(129), 'semi;colon', 'query?x', 'at@sign', 7, {}]) {
      await assert.rejects(store.updateAsset(asset.id, { name: 'Rejected' }, user.key, { basis } as never),
        ValidationError, JSON.stringify(basis));
    }
    assert.equal((await store.getAsset(asset.id, user.key))!.name, 'Provenance bench 3');
  });

  await t.test('change provenance is evidence and never authority', async () => {
    const subject = await store.reportAsset({ name: 'Not the outsider’s Asset' }, context);
    // Name the outsider in every provenance field at once, including as the
    // accepting authority, which no ordinary write path would ever allow.
    await query(`MATCH (a:Asset {id: $id})
      SET a.changeAcceptedBy = $outsider, a.changeAssertedBy = $outsider, a.changeBasis = $outsider`,
    { id: subject.id, outsider: outsider.key });
    // Appearing in provenance grants neither readability nor editability.
    assert.equal(await store.getAsset(subject.id, outsider.key), null);
    await assert.rejects(store.updateAsset(subject.id, { name: 'Taken over' }, outsider.key), ReferenceError);
    await assert.rejects(store.attachIdentifier(subject.id, outsider.key, model), ReferenceError);
    await assert.rejects(store.assertCanEdit(subject.id, outsider.key), ReferenceError);
    // Nor does it widen what the outsider can browse or resolve.
    const page = await store.findAssets(outsider.key,
      { q: '', scope: 'all', sort: 'name', dir: 'asc', filters: emptyAssetFilters, limit: 30, after: null });
    assert.equal(page.assets.some((found) => found.id === subject.id), false);

    // A member still reads it, and the recorded acceptor renders as an
    // attribution rather than as a raw actor key or a live account.
    const readable = (await store.getAsset(subject.id, user.key))!;
    assert.deepEqual(readable.provenance!.acceptedBy, { ...outsider, status: 'active' });
    assert.deepEqual(Object.keys(readable.provenance!.acceptedBy).sort(), ['key', 'name', 'status']);

    // Deleting the accepting account degrades the attribution exactly as
    // reportedBy does. A dedicated account is tombstoned so the shared outsider
    // stays usable by later subtests.
    const leaving = await store.createUser('Departing acceptor');
    await query('MATCH (a:Asset {id: $id}) SET a.changeAcceptedBy = $key',
      { id: subject.id, key: leaving.key });
    await query(`MATCH (u:User {key: $key})
      SET u.provenanceName = u.name, u.accountDeletedAt = datetime() REMOVE u.name`, { key: leaving.key });
    const afterDeletion = (await store.getAsset(subject.id, user.key))!;
    assert.deepEqual(afterDeletion.provenance!.acceptedBy,
      { key: leaving.key, name: 'Departing acceptor', status: 'deleted' });
    for (const field of ['email', 'role', 'password', 'accountDeletedAt', 'provenanceName']) {
      assert.equal(field in afterDeletion.provenance!.acceptedBy, false, field);
    }

    // An Asset written before Kannabi recorded this has no provenance at all,
    // rather than provenance attributed to whoever happens to be nearby.
    const legacyId = newAssetId();
    await query(`MATCH (u:User {key: $userKey}), (g:Group {key: $groupKey})
      CREATE (a:Asset {id: $id, name: 'Unstamped legacy Asset', reportedAt: datetime(), isPublic: false})
      CREATE (a)-[:REPORTED_BY]->(u), (g)-[:CAN_COLLABORATE]->(a)`,
    { id: legacyId, userKey: user.key, groupKey: group.key });
    assert.equal((await store.getAsset(legacyId, user.key))!.provenance, null);
  });

  await t.test('deterministic lookup resolves complete identities over the readable set', async () => {
    const seeker = await store.createUser('Lookup seeker');
    const outsiderGroup = await store.createReportingGroup('Sealed group', outsider.key);
    const seekerGroup = await store.createReportingGroup('Seeker group', seeker.key);
    const readable = await store.reportAsset({ name: 'Readable instrument',
      identifiers: [tag('LOOKUP-1'), { scheme: 'model', series: 'instrument' }] },
    { actorKey: seeker.key, groupKey: seekerGroup.key });
    const sibling = await store.reportAsset({ name: 'Readable sibling',
      identifiers: [{ scheme: 'model', series: 'instrument' }] },
    { actorKey: seeker.key, groupKey: seekerGroup.key });
    // An Asset the seeker cannot read, carrying identities the seeker will probe.
    const hidden = await store.reportAsset({ name: 'Sealed instrument',
      identifiers: [tag('SEALED'), { scheme: 'model', series: 'sealed' }] },
    { actorKey: outsider.key, groupKey: outsiderGroup.key });

    const lookup = (query: Record<string, unknown>) =>
      store.lookupAssets(seeker.key, assetLookupQuery(query, schemes));

    // Native Asset ID: an exact hit, and a well-formed miss.
    const byId = await lookup({ id: readable.id });
    assert.deepEqual(byId.identity, { kind: 'assetId', id: readable.id });
    assert.deepEqual(byId.assets.map((asset) => asset.id), [readable.id]);
    assert.equal(byId.matching, 1);
    const absentId = await lookup({ id: newAssetId() });
    assert.deepEqual(absentId.assets, []);
    assert.equal(absentId.matching, 0);
    // An unreadable Asset answers exactly as a nonexistent one.
    const unreadableById = await lookup({ id: hidden.id });
    assert.deepEqual(unreadableById.assets, absentId.assets);
    assert.equal(unreadableById.matching, absentId.matching);

    // An individual identifier resolves to at most one Asset.
    const byTag = await lookup(tag('LOOKUP-1'));
    assert.deepEqual(byTag.identity,
      { kind: 'identifier', canonical: 'tag:T-LOOKUP-1', scheme: 'tag', level: 'individual' });
    assert.deepEqual(byTag.assets.map((asset) => asset.id), [readable.id]);

    // A class identifier honestly describes several Assets, ordered by name.
    const byModel = await lookup({ scheme: 'model', series: 'instrument' });
    assert.equal(byModel.identity.kind === 'identifier' && byModel.identity.level, 'class');
    assert.deepEqual(byModel.assets.map((asset) => asset.name), ['Readable instrument', 'Readable sibling']);
    assert.equal(byModel.matching, 2);

    // An identifier that exists only on an unreadable Asset is silent.
    const sealedTag = await lookup(tag('SEALED'));
    assert.deepEqual(sealedTag.assets, []);
    assert.equal(sealedTag.matching, 0);
    const sealedModel = await lookup({ scheme: 'model', series: 'sealed' });
    // Byte-identical to an identifier nobody has ever used.
    const neverUsed = await lookup({ scheme: 'model', series: 'unseen' });
    assert.deepEqual({ ...sealedModel, identity: null }, { ...neverUsed, identity: null });

    // Substrings and prefixes are not identities.
    for (const query of [
      tag('SEALE'), tag('LOOKUP'), { scheme: 'model', series: 'instr' },
    ]) assert.deepEqual((await lookup(query)).assets, [], JSON.stringify(query));

    // Ordinary name browsing is untouched by any of this.
    const browsed = await store.findAssets(seeker.key,
      { q: 'Readable', scope: 'all', sort: 'name', dir: 'asc', filters: emptyAssetFilters, limit: 30, after: null });
    assert.deepEqual(browsed.assets.map((asset) => asset.name), ['Readable instrument', 'Readable sibling']);
    assert.equal(browsed.matching, 2);
  });

  await t.test('schema initialization fails closed when a constraint name masks the required schema', async () => {
    // This test runs last and only against the disposable database.
    await query('DROP CONSTRAINT individual_identifier');
    await query('CREATE CONSTRAINT individual_identifier FOR (n:Unrelated) REQUIRE n.key IS UNIQUE');
    await assert.rejects(IdentityStore.open(driver, composition), /Required uniqueness constraint is missing for IndividualIdentifier/);
  });
});
