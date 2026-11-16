import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { assetLookupQuery } from './asset-lookup.js';
import { assetPageRequest } from './asset-page.js';
import { assetRecord } from './asset-representation.js';
import { ValidationError } from './identity.js';
import { DuplicateIdentityError, IdentityStore } from './identity-store.js';
import { identifierSchemes, type Identifier, type IdentifierScheme } from './identifier.js';
import { composition as withShelf, tagScheme } from './test-fixture.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

test('Kannabi with no identifier scheme installed registers and finds Assets',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const none = identifierSchemes([]);
    const store = await IdentityStore.open(driver, { schemes: none });
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

test('Kannabi refuses to start on identifiers whose scheme no installed plugin provides',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver, withShelf);
    const sam = await store.createUser('Sam');
    const group = await store.createReportingGroup('Stores', sam.key);
    const shelf = await store.reportAsset({ name: 'Shelf unit',
      identifiers: [{ scheme: 'tag', code: 'T-41' }, { scheme: 'model', series: 'rack' }] },
      { actorKey: sam.key, groupKey: group.key });

    // Every read of the Asset would need the missing scheme, so the store is
    // refused before it serves one, and the refusal names what to install.
    await assert.rejects(IdentityStore.open(driver, { schemes: identifierSchemes([]) }),
      /Stored identifiers use schemes no installed plugin provides: model \(1\), tag \(1\)\. List the plugin/);
    // Each missing scheme is named, and only those.
    await assert.rejects(IdentityStore.open(driver, { schemes: identifierSchemes([tagScheme]) }),
      /provides: model \(1\)\. List/);

    // Refusing changed nothing: with the plugin back, the identifiers read as before.
    const reopened = await IdentityStore.open(driver, withShelf);
    assert.deepEqual((await reopened.getAsset(shelf.id, sam.key))?.identifiers.map((value) => value.canonical),
      ['model:rack', 'tag:T-41']);
  });
