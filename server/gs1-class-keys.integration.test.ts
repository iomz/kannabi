import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { DuplicateIdentityError, IdentityStore, ReferenceError } from './identity-store.js';
import { ValidationError } from './identity.js';
import { allocatedGtin, gs1Policy, storedIdentifier } from './gs1.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Issuance under a managed class key, which is what separates a GRAI or an
 * SGTIN Kannabi may issue from a GTIN it merely stores. */
test('class keys carry the authority a serial is issued under', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const owner = await store.createUser('Namespace owner');
  const outsider = await store.createUser('Outsider');
  const group = await store.createReportingGroup('Issuing team', owner.key);
  const foreign = await store.createReportingGroup('Another team', outsider.key);
  const context = { actorKey: owner.key, groupKey: group.key };
  const namespace = await store.configureGs1Namespace(owner.key, group.key, { gcp: '0614141' });
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }

  /** The class keys this suite manages, by canonical form, so a subtest never
   * depends on the order a listing happens to return. */
  const allocatedGtinKey = '(01)00614141000012';
  const adoptedGraiKey = '(8003)00614141234561';
  const classKey = async (canonical: string) => (await store.listClassKeys(owner.key, namespace.key))
    .find((entry) => entry.canonical === canonical)!;

  await t.test('allocation and adoption are recorded as the different assertions they are', async () => {
    const allocated = await store.manageClassKey(owner.key, namespace.key, { scheme: 'gtin' });
    assert.equal(allocated.provenance, 'allocated');
    assert.equal(allocated.scheme, 'gtin');
    assert.equal(allocated.canonical, allocatedGtinKey);
    assert.equal(allocated.sequence, 1);
    assert.equal(allocated.active, true);
    assert.equal(allocated.serial.nextSequence, 1);
    assert.deepEqual(allocated.assertedBy, { ...owner, status: 'active' });

    // Adopting says Kannabi did not allocate it, and never fakes a sequence.
    const adopted = await store.manageClassKey(owner.key, namespace.key,
      { scheme: 'grai', assetType: '0614141234561', serialExclusions: [{ from: 1, to: 9 }] });
    assert.equal(adopted.provenance, 'adopted');
    assert.equal(adopted.sequence, null);
    assert.equal(adopted.canonical, adoptedGraiKey);
    assert.deepEqual(adopted.serial.exclusions, [{ from: 1, to: 9 }]);

    // The counters are independent: allocating a GTIN never moved the GRAI
    // asset-type counter, because the keys do not collide (§2.3).
    const refreshed = (await store.listGs1Namespaces(owner.key))
      .find((entry) => entry.key === namespace.key)!;
    assert.equal(refreshed.counters.gtinItem.nextSequence, 2);
    assert.equal(refreshed.counters.graiType.nextSequence, 1);
    assert.equal(refreshed.counters.giai.nextSequence, 1);
  });

  await t.test('the same digits under two AIs are two keys, not a collision', async () => {
    // General Specifications 26.0 §2.3: there is no conflict when a GTIN and
    // a GRAI asset type have the same digits, because the carrier
    // distinguishes the keys. The canonical form carries the AI, so the
    // uniqueness constraint says the same thing.
    const twin = await store.manageClassKey(owner.key, namespace.key,
      { scheme: 'gtin', gtin: '0614141234561' });
    assert.equal(twin.canonical, '(01)00614141234561');
    assert.notEqual(twin.canonical, adoptedGraiKey);
    assert.equal((await classKey(adoptedGraiKey)).scheme, 'grai');
    // Managing the very same key twice is a duplicate, and is refused once.
    await assert.rejects(store.manageClassKey(owner.key, namespace.key,
      { scheme: 'grai', assetType: '0614141234561' }), DuplicateIdentityError);
    await assert.rejects(store.manageClassKey(owner.key, namespace.key,
      { scheme: 'gtin', gtin: '0614141234561' }), DuplicateIdentityError);
  });

  await t.test('a key outside the asserted prefix is refused, as is a non-member', async () => {
    // Containment is checked against the prefix this Group asserted. It is
    // not a licensing check, and it is the whole reason another company's
    // GTIN can never become serialisable here.
    await assert.rejects(store.manageClassKey(owner.key, namespace.key,
      { scheme: 'gtin', gtin: '9521234000013' }), ValidationError);
    // Only a member of the managing Group may manage a class key, and doing
    // so touches no Asset.
    await assert.rejects(store.manageClassKey(outsider.key, namespace.key, { scheme: 'gtin' }),
      ReferenceError);
  });

  await t.test('one Asset carries issued GIAI, serialised GRAI and SGTIN together', async () => {
    const asset = await store.reportAsset({ name: 'Returnable case 001' }, context);
    const gtinKey = await classKey(allocatedGtinKey);
    const graiKey = await classKey(adoptedGraiKey);

    const withGiai = await store.issueKey(asset.id, owner.key, 'giai', { namespaceKey: namespace.key });
    const withGrai = await store.issueKey(asset.id, owner.key, 'grai',
      { namespaceKey: namespace.key, classKeyKey: graiKey.key });
    const withSgtin = await store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: gtinKey.key });
    assert.equal(withGiai.issuances.length, 1);
    assert.equal(withGrai.issuances.length, 2);
    assert.deepEqual(withSgtin.issuances.map((issuance) => issuance.scheme).sort(),
      ['giai', 'grai', 'sgtin']);
    // Every issued value is attached, and each names what it was issued under.
    const bySchema = new Map(withSgtin.issuances.map((issuance) => [issuance.scheme, issuance]));
    assert.equal(bySchema.get('giai')!.classKeyCanonical, null);
    assert.equal(bySchema.get('grai')!.classKeyCanonical, graiKey.canonical);
    assert.equal(bySchema.get('sgtin')!.classKeyCanonical, gtinKey.canonical);
    // Adopted serial exclusions are honoured: 1-9 were already in use.
    assert.equal(bySchema.get('grai')!.sequence, 10);
    assert.equal(bySchema.get('sgtin')!.sequence, 1);
    for (const issuance of withSgtin.issuances) {
      assert.ok(withSgtin.identifiers.some((identifier) => identifier.canonical === issuance.canonical),
        issuance.canonical);
    }

    // Idempotent per scheme, and only per scheme.
    const repeated = await store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: gtinKey.key });
    assert.deepEqual(repeated.issuances, withSgtin.issuances);
  });

  await t.test('a recorded class key is not a managed one, so it cannot be serialised', async () => {
    const asset = await store.reportAsset({ name: 'Manufactured elsewhere' }, context);
    // A GTIN from another company's prefix, recorded as the observation it is.
    const recorded = await store.attachIdentifier(asset.id, owner.key,
      { scheme: 'gtin', gtin: '9521234000013' });
    assert.equal(recorded.identifiers.length, 1);
    // There is no class key to name, so there is no call that serialises it.
    const managed = await store.listClassKeys(owner.key, namespace.key, 'gtin');
    assert.ok(!managed.some((entry) => entry.canonical === '(01)09521234000013'));
    await assert.rejects(store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: 'not-a-class-key' }), ReferenceError);
    assert.deepEqual((await store.getAsset(asset.id, owner.key))!.issuances, []);
  });

  await t.test('a deactivated class key stops new serials and keeps every issued one', async () => {
    const asset = await store.reportAsset({ name: 'Returnable case 002' }, context);
    const graiKey = await classKey(adoptedGraiKey);
    const issued = await store.issueKey(asset.id, owner.key, 'grai',
      { namespaceKey: namespace.key, classKeyKey: graiKey.key });
    assert.equal(issued.issuances.length, 1);
    const deactivated = await store.setClassKeyActive(owner.key, graiKey.key, false);
    assert.equal(deactivated.active, false);
    assert.equal(deactivated.serial.nextSequence, 12, 'the counter survives deactivation');
    const blocked = await store.reportAsset({ name: 'Returnable case 003' }, context);
    await assert.rejects(store.issueKey(blocked.id, owner.key, 'grai',
      { namespaceKey: namespace.key, classKeyKey: graiKey.key }), ValidationError);
    // Repeating an existing issuance still works while deactivated.
    assert.deepEqual((await store.issueKey(asset.id, owner.key, 'grai',
      { namespaceKey: namespace.key, classKeyKey: graiKey.key })).issuances, issued.issuances);
    await store.setClassKeyActive(owner.key, graiKey.key, true);
  });

  await t.test('issuance needs namespace membership and collaboration on the Asset', async () => {
    const asset = await store.reportAsset({ name: 'Guarded' }, context);
    const gtinKey = await classKey(allocatedGtinKey);
    // An outsider has neither.
    await assert.rejects(store.issueKey(asset.id, outsider.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: gtinKey.key }), ReferenceError);
    // A class key from a namespace this Group does not manage is unreachable
    // even for a member who does collaborate on the Asset.
    const otherNamespace = await store.configureGs1Namespace(outsider.key, foreign.key, { gcp: '9521234' });
    const otherKey = await store.manageClassKey(outsider.key, otherNamespace.key, { scheme: 'gtin' });
    await assert.rejects(store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: otherKey.key }), ReferenceError);
    // And the scheme must match the class key it is issued under.
    const graiKey = await classKey(adoptedGraiKey);
    await assert.rejects(store.issueKey(asset.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: graiKey.key }), ValidationError);
  });

  await t.test('an issued value never rebinds to another Asset, whatever its scheme', async () => {
    const source = await classKey(allocatedGtinKey);
    const holder = await store.reportAsset({ name: 'First holder' }, context);
    const issued = await store.issueKey(holder.id, owner.key, 'sgtin',
      { namespaceKey: namespace.key, classKeyKey: source.key });
    const value = issued.issuances.find((issuance) => issuance.scheme === 'sgtin')!;
    const attachment = issued.identifiers.find((identifier) => identifier.canonical === value.canonical)!;
    await store.detachIdentifier(holder.id, owner.key, attachment.key);
    // Detaching is not releasing: the ledger still names the original Asset.
    const other = await store.reportAsset({ name: 'Second holder' }, context);
    await assert.rejects(store.attachIdentifier(other.id, owner.key,
      { scheme: 'sgtin', gtin: source.canonical.slice(4), serial: String(value.sequence) }),
    ValidationError);
    // It may return to the Asset it was issued for.
    const returned = await store.attachIdentifier(holder.id, owner.key,
      { scheme: 'sgtin', gtin: source.canonical.slice(4), serial: String(value.sequence) });
    assert.ok(returned.identifiers.some((identifier) => identifier.canonical === value.canonical));
  });

  await t.test('the ledger reports every scheme and narrows to one on request', async () => {
    const all = await store.gs1Issuances(owner.key,
      { namespaceKey: namespace.key, scheme: null, limit: 100, after: null });
    assert.ok(all.matching >= 3);
    const sgtins = await store.gs1Issuances(owner.key,
      { namespaceKey: namespace.key, scheme: 'sgtin', limit: 100, after: null });
    assert.ok(sgtins.entries.every((entry) => entry.issuance.scheme === 'sgtin'));
    assert.ok(sgtins.matching < all.matching);
    // Every row names the Asset it was issued for, and the class key it came
    // from where there is one.
    for (const entry of sgtins.entries) {
      assert.ok(entry.issuance.allocatedForAssetId);
      assert.ok(entry.issuance.classKeyCanonical);
    }
    // Nothing in the ledger is keyed on digits: a recorded lookalike under
    // the same prefix never appears.
    const lookalike = await store.reportAsset({ name: 'Lookalike' }, context);
    await store.attachIdentifier(lookalike.id, owner.key,
      { scheme: 'giai', assetReference: '0614141NOT-ISSUED' });
    const after = await store.gs1Issuances(owner.key,
      { namespaceKey: namespace.key, scheme: null, limit: 100, after: null });
    assert.equal(after.matching, all.matching);
    assert.ok(!after.entries.some((entry) => entry.issuance.allocatedForAssetId === lookalike.id));
  });

  await t.test('allocating a class key makes it no more discoverable than recording one', async () => {
    // Resolution must not disclose allocation authority. A class-level
    // address answers the same way whether or not Kannabi allocated the key,
    // so probing one can never reveal that this deployment issued it — and
    // answering it at all would settle the trade-item referent question by
    // accident. Lookup is what the Digital Link resolver consults, so this is
    // asserted where that decision is actually made.
    // A key Kannabi allocates here and now, so nothing else in this suite has
    // touched it, and a foreign key of the same shape that Kannabi did not.
    const allocated = await store.manageClassKey(owner.key, namespace.key, { scheme: 'gtin' });
    assert.equal(allocated.provenance, 'allocated');
    // A valid GTIN under a prefix this suite neither manages nor attaches
    // anywhere, built through the GS1 boundary so its check digit is right by
    // construction rather than by hand.
    const foreignKey = allocatedGtin('9520123', 1).canonical;
    const asClassIdentifier = (canonical: string) => ({
      kind: 'identifier' as const,
      identifier: storedIdentifier('gtin', canonical, gs1Policy.version),
    });
    const resolve = (canonical: string) => store.lookupAssets(owner.key,
      { identity: asClassIdentifier(canonical), limit: 10, after: null });

    // Unattached, both answer with nothing: the allocation record contributes
    // nothing to resolution, so it cannot be probed for.
    const mine = await resolve(allocated.canonical);
    const foreign = await resolve(foreignKey);
    assert.equal(mine.matching, 0);
    assert.equal(foreign.matching, 0);
    assert.deepEqual(mine.assets, foreign.assets);
    // The level is class either way, which is what makes the Digital Link
    // resolver refuse both before it ever reaches an Asset.
    assert.equal(mine.identity.kind === 'identifier' && mine.identity.level, 'class');
    assert.equal(foreign.identity.kind === 'identifier' && foreign.identity.level, 'class');

    // Attached, both answer with exactly the Asset that carries them, and no
    // more: allocation confers no extra visibility, and costs none either.
    const holder = await store.reportAsset({ name: 'Carries an allocated GTIN' }, context);
    const other = await store.reportAsset({ name: 'Carries a foreign GTIN' }, context);
    await store.attachIdentifier(holder.id, owner.key,
      { scheme: 'gtin', gtin: allocated.canonical.slice(4) });
    await store.attachIdentifier(other.id, owner.key,
      { scheme: 'gtin', gtin: foreignKey.slice(4) });
    assert.deepEqual((await resolve(allocated.canonical)).assets.map((entry) => entry.id), [holder.id]);
    assert.deepEqual((await resolve(foreignKey)).assets.map((entry) => entry.id), [other.id]);
  });

  await t.test('the issuance relationships the ledger relies on are actually written', async () => {
    const edges = await query(`MATCH (l:Gs1KeyIssuance)-[:ISSUED_FROM]->(:Gs1Namespace)
      RETURN count(l) AS n`);
    assert.ok(edges.records[0].get('n').toNumber() >= 3);
    const under = await query(`MATCH (l:Gs1KeyIssuance)-[:ISSUED_UNDER]->(:Gs1ClassKeyAllocation)
      RETURN collect(DISTINCT l.scheme) AS schemes`);
    assert.deepEqual((under.records[0].get('schemes') as string[]).sort(), ['grai', 'sgtin']);
    const giai = await query(`MATCH (l:Gs1KeyIssuance {scheme: 'giai'})
      RETURN count { (l)-[:ISSUED_UNDER]->() } AS n`);
    assert.equal(giai.records[0].get('n').toNumber(), 0, 'a GIAI has no class level to be issued under');
  });
});
