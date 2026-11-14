import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetLookupQuery } from './asset-lookup.js';
import { assetFilters } from './asset-page.js';
import { assetRecord } from './asset-representation.js';
import type { Auth } from './auth.js';
import { createInventoryApi } from './inventory-api.js';
import { gs1Rule, gs1Schemes } from '../plugins/gs1/adapter/schemes.js';
import { ValidationError } from './identity.js';
import type { Asset, IdentityStore } from './identity-store.js';
import {
  identifierSchemes, type Identifier, type IdentifierRule, type IdentifierScheme,
} from './identifier.js';

/** A scheme with nothing of GS1 in it: a shelf tag, read as it is written.
 *
 * Its component is deliberately called `gtin`. A rule that reads components by
 * name would take a shelf tag for a trade item, so this is what shows that a
 * GS1 rule judges GS1 identifiers and no others. */
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

const bare: Asset = Object.freeze({
  id: '0198c2a0-0000-7000-8000-000000000009', name: 'Bench vice', identifiers: [], issuances: [],
  reportedBy: { key: 'u1', name: 'Alex', status: 'active' as const }, reportedAt: '2026-06-22T00:00:00.000Z',
  provenance: null, sourceRecord: null, owner: null, groups: [{ key: 'g1', name: 'Workshop' }],
  isPublic: false, photos: [],
}) as unknown as Asset;

test('Kannabi with no identifier scheme installed is still complete', () => {
  const none = identifierSchemes([]);
  assert.deepEqual(none.ids, []);
  assert.deepEqual(none.inputFields, ['scheme']);
  // Carrying no identifier is an ordinary state, so reporting without one works.
  assert.deepEqual(none.acceptAll(undefined), []);
  assert.deepEqual(none.acceptAll([]), []);
  // Naming a scheme is refused for what it is, not as a malformed value.
  assert.throws(() => none.accept({ scheme: 'gtin', gtin: '04901234567894' }), /No identifier scheme is installed/);
  assert.throws(() => none.restore('gtin', '(01)04901234567894', 'p'), /No identifier scheme is installed/);
  // The native identity needs no scheme at all.
  const byId = assetLookupQuery({ id: bare.id }, none);
  assert.deepEqual(byId.identity, { kind: 'assetId', id: bare.id });
  assert.throws(() => assetLookupQuery({ scheme: 'gtin' }, none), /No identifier scheme is installed/);
  assert.deepEqual(assetFilters({}, none.ids).schemes, []);
  assert.throws(() => assetFilters({ scheme: 'gtin' }, none.ids), ValidationError);
  const record = assetRecord(bare, none);
  assert.deepEqual(record.identifiers, []);
  assert.equal(record.kannabi.name, 'Bench vice');
});

test('a scheme is known to core only by what it supplies', () => {
  const schemes = identifierSchemes([tag]);
  const accepted = schemes.accept({ scheme: 'tag', code: 'T-7' });
  assert.deepEqual(accepted, { scheme: 'tag', canonical: 'tag:T-7', components: { gtin: 'T-7' },
    level: 'individual', policyVersion: 'tag-1' });
  // What was stored is rebuilt by the scheme and never revalidated by core.
  assert.deepEqual(schemes.restore('tag', 'tag:T-7', 'tag-1'), accepted);
  assert.throws(() => schemes.accept({ scheme: 'tag', code: 'seven' }), /A tag is T- and digits/);
  assert.throws(() => schemes.accept({ scheme: 'tag', code: 'T-7', serial: '1' }), /Unsupported field: serial/);
  assert.throws(() => schemes.accept({ scheme: 'gtin' }), /Supported identifier schemes are tag/);
  // A scheme that supplies no address has none; core invents nothing.
  assert.equal(schemes.address(accepted), null);
  assert.equal(assetLookupQuery({ scheme: 'tag', code: 'T-7' }, schemes).identity.kind, 'identifier');
});

test('core refuses only an exact repeat; every other rule belongs to its owner', () => {
  const calls: string[] = [];
  const rule: IdentifierRule = {
    assertSet: (identifiers) => { calls.push(`set:${identifiers.length}`); },
    assertAddition: (existing, addition) => {
      calls.push(`add:${existing.length}:${addition.canonical}`);
      if (addition.canonical === 'tag:T-999') throw new ValidationError('Identifiers are frozen');
    },
  };
  const schemes = identifierSchemes([tag], [rule]);
  const [one, two] = schemes.acceptAll([{ scheme: 'tag', code: 'T-1' }, { scheme: 'tag', code: 'T-2' }]);
  assert.deepEqual(calls, ['set:2']);
  schemes.assertSet([one, two]);
  schemes.assertAddition([one], two);
  assert.deepEqual(calls.slice(1), ['set:2', 'add:1:tag:T-2']);
  const frozen = schemes.accept({ scheme: 'tag', code: 'T-999' });
  assert.throws(() => schemes.assertAddition([one], frozen), /Identifiers are frozen/);
  assert.throws(() => schemes.acceptAll([{ scheme: 'tag', code: 'T-1' }, { scheme: 'tag', code: 'T-1' }]),
    /An Asset cannot carry the same identifier twice/);
  assert.throws(() => schemes.assertAddition([one], one), /An Asset cannot carry the same identifier twice/);
  assert.throws(() => schemes.acceptAll('T-1'), /Identifiers must be a list/);
});

test('GS1 rules judge GS1 identifiers and no others', () => {
  const schemes = identifierSchemes([...gs1Schemes, tag], [gs1Rule]);
  assert.deepEqual(schemes.ids, ['gtin', 'sgtin', 'grai', 'giai', 'tag']);
  assert.deepEqual(schemes.inputFields, ['scheme', 'gtin', 'serial', 'assetType', 'assetReference', 'code']);
  const product = schemes.accept({ scheme: 'gtin', gtin: '04901234567894' });
  const shelf = schemes.accept({ scheme: 'tag', code: 'T-7' });
  // The tag's component is named `gtin` and holds a different value. It is not
  // a trade item, so it conflicts with nothing, in the rule or in the
  // plugin's part of the write, which is where GTIN consistency is enforced.
  schemes.assertSet([product, shelf]);
  schemes.assertAddition([product], shelf);
  schemes.assertAddition([shelf], product);
  // The GS1 rule that needs no setting is unchanged: one asset-type series.
  const crate = schemes.accept({ scheme: 'grai', assetType: '0614141234561' });
  const pallet = schemes.accept({ scheme: 'grai', assetType: '0614141234578' });
  assert.throws(() => schemes.assertSet([crate, pallet, shelf]), /conflicting GRAI asset types/);
  assert.throws(() => schemes.assertAddition([crate, shelf], pallet), /conflicting GRAI asset types/);
  // GS1 supplies an address for an individual identity and none for a class.
  const other = schemes.accept({ scheme: 'sgtin', gtin: '04912345678904', serial: 'A1' });
  assert.equal(schemes.address(product), null);
  assert.equal(schemes.address(other), '/01/04912345678904/21/A1');
  assert.equal(schemes.address(shelf), null);
});

test('a registry refuses a scheme it could not tell apart', () => {
  assert.throws(() => identifierSchemes([tag, tag]), /installed twice/);
  assert.throws(() => identifierSchemes([{ ...tag, id: 'Tag' }]), /not a lowercase token/);
  assert.throws(() => identifierSchemes([{ ...tag, fields: ['scheme'] }]), /reserved field "scheme"/);
  // A lookup already uses these names to steer itself, so a scheme field of
  // the same name would be taken from the request before the scheme saw it.
  for (const field of ['id', 'limit', 'cursor']) {
    assert.throws(() => identifierSchemes([{ ...tag, fields: [field] }]), new RegExp(`reserved field "${field}"`));
  }
});

test('a field belongs to the scheme that declares it, whatever else is installed', () => {
  const alone = identifierSchemes([tag]);
  const beside = identifierSchemes([...gs1Schemes, tag], [gs1Rule]);
  // `serial` is a GS1 field. Installing GS1 must not make a tag accept it.
  const input = { scheme: 'tag', code: 'T-7', serial: '1' };
  assert.throws(() => alone.accept(input), /Unsupported field: serial/);
  assert.throws(() => beside.accept(input), /Unsupported field: serial/);
  assert.throws(() => beside.accept({ scheme: 'gtin', gtin: '04901234567894', code: 'T-7' }), /Unsupported field: code/);
  assert.throws(() => assetLookupQuery(input, beside), /Unsupported field: serial/);
});

test('an Asset carrying an identifier with no address is still served', async () => {
  // The detail response lists an address only where a scheme supplies one. An
  // identifier of a scheme with none must not fail the whole response.
  const schemes = identifierSchemes([...gs1Schemes, tag], [gs1Rule]);
  const carried = [
    { key: 'i1', ...schemes.accept({ scheme: 'sgtin', gtin: '04912345678904', serial: 'A1' }), attachment: null },
    { key: 'i2', ...schemes.accept({ scheme: 'tag', code: 'T-7' }), attachment: null },
    { key: 'i3', ...schemes.accept({ scheme: 'gtin', gtin: '04912345678904' }), attachment: null },
  ];
  const rig = { ...bare, isPublic: true, identifiers: carried } as unknown as Asset;
  const store = { schemes, async getAsset() { return rig; } } as unknown as IdentityStore;
  const anonymous = { api: { getSession: async () => null } } as unknown as Auth;
  const origin = 'http://localhost:3000';
  const response = await createInventoryApi(store, anonymous, origin).request(`${origin}/assets/${rig.id}`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.addresses, [{ identifierKey: 'i1', canonical: '(01)04912345678904(21)A1',
    uri: origin + '/01/04912345678904/21/A1' }]);
  // Which address is surfaced is an installed plugin's presentation choice;
  // with none installed it is the native Asset URI.
  assert.equal(body.surfacedUri, origin + '/asset/' + rig.id);
  assert.deepEqual(body.extensions, {});
});
