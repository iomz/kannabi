import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { assetLookupQuery } from './asset-lookup.js';
import { assetPageRequest } from './asset-page.js';
import { assetRecord } from './asset-representation.js';
import { gs1Rule, gs1Schemes } from './gs1-schemes.js';
import { ValidationError } from './identity.js';
import { DuplicateIdentityError, IdentityStore } from './identity-store.js';
import { identifierSchemes, type Identifier, type IdentifierScheme } from './identifier.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** A scheme with nothing of GS1 in it. Its component is named `gtin` on
 * purpose: anything that reads components by name rather than by scheme would
 * take a shelf tag for a trade item. */
const tag: IdentifierScheme = Object.freeze({
  id: 'tag',
  fields: ['code'],
  accept(input: Record<string, unknown>): Identifier {
    if (typeof input.code !== 'string' || !/^T-\d+$/.test(input.code)) throw new ValidationError('A tag is T- and digits');
    return this.restore('tag:' + input.code, 'tag-1');
  },
  restore(canonical: unknown, policyVersion: unknown): Identifier {
    return Object.freeze({ scheme: 'tag', canonical: String(canonical),
      components: Object.freeze({ gtin: String(canonical).slice(4) }),
      level: 'individual' as const, policyVersion: String(policyVersion) });
  },
});

test('Kannabi with no identifier scheme installed registers and finds Assets',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const none = identifierSchemes([]);
    const store = await IdentityStore.open(driver, none);
    const alex = await store.createUser('Alex');
    const group = await store.createReportingGroup('Workshop', alex.key);
    const context = { actorKey: alex.key, groupKey: group.key };

    const vice = await store.reportAsset({ name: 'Bench vice' }, context);
    assert.deepEqual(vice.identifiers, []);
    assert.deepEqual((await store.getAsset(vice.id, alex.key))?.identifiers, []);
    assert.deepEqual(assetRecord(vice, none).identifiers, []);

    const byId = await store.lookupAssets(alex.key, assetLookupQuery({ id: vice.id }, none));
    assert.deepEqual(byId.assets.map((asset) => asset.id), [vice.id]);
    const page = await store.findAssets(alex.key, assetPageRequest({}, none.ids));
    assert.deepEqual(page.assets.map((asset) => asset.id), [vice.id]);
    const unidentified = await store.findAssets(alex.key, assetPageRequest({ identified: 'none' }, none.ids));
    assert.equal(unidentified.matching, 1);

    // Naming an identifier is refused for what it is, and writes nothing.
    await assert.rejects(store.reportAsset({ name: 'Lathe',
      identifiers: [{ scheme: 'gtin', gtin: '04901234567894' }] }, context), /No identifier scheme is installed/);
    await assert.rejects(store.attachIdentifier(vice.id, alex.key, { scheme: 'gtin', gtin: '04901234567894' }),
      /No identifier scheme is installed/);
    assert.equal((await store.findAssets(alex.key, assetPageRequest({}, none.ids))).matching, 1);
  });

test('a scheme that is not GS1 is stored, read, found and kept unique like any other',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const schemes = identifierSchemes([...gs1Schemes, tag], [gs1Rule]);
    const store = await IdentityStore.open(driver, schemes);
    const alex = await store.createUser('Alex');
    const group = await store.createReportingGroup('Stores', alex.key);
    const context = { actorKey: alex.key, groupKey: group.key };

    // Reported with a tag beside a GTIN. The tag's `gtin` component differs
    // from the product's, and GTIN consistency is enforced: no conflict.
    const drill = await store.reportAsset({ name: 'Drill',
      identifiers: [{ scheme: 'tag', code: 'T-7' }, { scheme: 'gtin', gtin: '04901234567894' }] }, context);
    assert.deepEqual(drill.identifiers.map((identifier) => [identifier.scheme, identifier.canonical, identifier.level]),
      [['gtin', '(01)04901234567894', 'class'], ['tag', 'tag:T-7', 'individual']]);
    const stored = (await store.getAsset(drill.id, alex.key))!;
    const shelf = stored.identifiers.find((identifier) => identifier.scheme === 'tag')!;
    assert.deepEqual(shelf.components, { gtin: 'T-7' });
    assert.equal(shelf.policyVersion, 'tag-1');
    assert.equal(shelf.attachment?.acceptedBy.key, alex.key);

    // The record gives it no address, because its scheme supplies none.
    const record = assetRecord(stored, schemes);
    assert.deepEqual(record.identifiers.map((identifier) => [identifier.scheme, identifier.digitalLink]),
      [['gtin', null], ['tag', null]]);

    // Found by exact identity and by the scheme filter.
    const found = await store.lookupAssets(alex.key, assetLookupQuery({ scheme: 'tag', code: 'T-7' }, schemes));
    assert.deepEqual(found.assets.map((asset) => asset.id), [drill.id]);
    assert.deepEqual(found.identity, { kind: 'identifier', canonical: 'tag:T-7', scheme: 'tag', level: 'individual' });
    const filtered = await store.findAssets(alex.key, assetPageRequest({ scheme: 'tag' }, schemes.ids));
    assert.deepEqual(filtered.assets.map((asset) => asset.id), [drill.id]);

    // An individual identifier identifies one Asset, whatever its scheme.
    const saw = await store.reportAsset({ name: 'Saw' }, context);
    await assert.rejects(store.attachIdentifier(saw.id, alex.key, { scheme: 'tag', code: 'T-7' }), DuplicateIdentityError);
    await assert.rejects(store.attachIdentifier(drill.id, alex.key, { scheme: 'tag', code: 'T-7' }),
      /An Asset cannot carry the same identifier twice/);

    // Attached and detached after creation, beside GS1 identifiers, and the
    // GS1 conflict set is untouched by an identifier that is not GS1's.
    const tagged = await store.attachIdentifier(saw.id, alex.key, { scheme: 'tag', code: 'T-8' });
    const withSerial = await store.attachIdentifier(saw.id, alex.key,
      { scheme: 'sgtin', gtin: '04912345678904', serial: 'A1' });
    assert.deepEqual(withSerial.identifiers.map((identifier) => identifier.scheme), ['sgtin', 'tag']);
    const session = driver.session();
    try {
      const conflicts = await session.run('MATCH (:Settings)-[c:HAS_GTIN_CONFLICT]->(:Asset) RETURN count(c) AS total');
      assert.equal(conflicts.records[0].get('total').toNumber(), 0);
    } finally { await session.close(); }
    const key = tagged.identifiers.find((identifier) => identifier.scheme === 'tag')!.key;
    const detached = await store.detachIdentifier(saw.id, alex.key, key);
    assert.deepEqual(detached.identifiers.map((identifier) => identifier.scheme), ['sgtin']);

    // The same canonical form under another scheme is a different identity.
    // `verbatim` and `kind` take any text as their canonical form, so they can
    // be made to collide with a value another scheme already stored.
    const verbatim = (id: string, level: 'individual' | 'class'): IdentifierScheme => Object.freeze({
      id, fields: ['text'],
      accept(input: Record<string, unknown>): Identifier { return this.restore(String(input.text), id + '-1'); },
      restore: (canonical: unknown, policyVersion: unknown): Identifier => Object.freeze({ scheme: id,
        canonical: String(canonical), components: Object.freeze({}), level, policyVersion: String(policyVersion) }),
    });
    const colliding = identifierSchemes([...gs1Schemes, tag, verbatim('alias', 'individual'), verbatim('kind', 'class')],
      [gs1Rule]);
    const crowded = await IdentityStore.open(driver, colliding);
    // A lookup under one scheme never answers with another scheme's Asset.
    const other = await crowded.lookupAssets(alex.key, assetLookupQuery({ scheme: 'alias', text: 'tag:T-7' }, colliding));
    assert.deepEqual(other.assets, []);
    assert.equal(other.matching, 0);
    const kind = await crowded.lookupAssets(alex.key,
      assetLookupQuery({ scheme: 'kind', text: '(01)04901234567894' }, colliding));
    assert.deepEqual(kind.assets, []);
    // A class value already recorded under one scheme is refused under
    // another, rather than attached as the first scheme's identifier.
    await assert.rejects(crowded.attachIdentifier(saw.id, alex.key, { scheme: 'kind', text: '(01)04901234567894' }),
      /already recorded under another scheme/);
    await assert.rejects(crowded.reportAsset({ name: 'Plane',
      identifiers: [{ scheme: 'kind', text: '(01)04901234567894' }] }, context),
    /already recorded under another scheme/);
    assert.deepEqual((await crowded.getAsset(saw.id, alex.key))!.identifiers.map((identifier) => identifier.scheme),
      ['sgtin']);
    // The scheme that recorded it still shares the one node across Assets.
    const chisel = await crowded.reportAsset({ name: 'Chisel',
      identifiers: [{ scheme: 'gtin', gtin: '04901234567894' }] }, context);
    const shared = await crowded.lookupAssets(alex.key,
      assetLookupQuery({ scheme: 'gtin', gtin: '04901234567894' }, colliding));
    assert.deepEqual(shared.assets.map((asset) => asset.id).sort(), [chisel.id, drill.id].sort());

    // Reopening reads every stored identifier back through its own scheme.
    const reopened = await IdentityStore.open(driver, schemes);
    assert.deepEqual((await reopened.getAsset(drill.id, alex.key))!.identifiers.map((identifier) => identifier.canonical),
      ['(01)04901234567894', 'tag:T-7']);
  });
