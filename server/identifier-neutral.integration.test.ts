import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { assetLookupQuery } from './asset-lookup.js';
import { assetPageRequest } from './asset-page.js';
import { assetRecord } from './asset-representation.js';
import { ValidationError } from './identity.js';
import { DuplicateIdentityError, IdentityStore } from './identity-store.js';
import { identifierSchemes, type Identifier, type IdentifierScheme } from './identifier.js';

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
