import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { assetRecord, assetSummary, notRecorded, summaryOmits } from './asset-representation.js';
import { createInventoryApi } from './inventory-api.js';
import { createMcpServer } from './mcp-tools.js';
import { systemAudienceResolver } from './mcp-principal.js';
import { canonicalIdentifier } from './gs1.js';
import type { Auth } from './auth.js';
import type { Asset, IdentityStore } from './identity-store.js';

/** The representation is only worth having if its structure carries the
 * distinctions on its own. These tests read it the way a client would — by
 * where a value sits — and check that each kind of value can sit in exactly
 * one place. */

const reporter = { key: 'user-1', name: 'Alex Demo', status: 'active' as const };
const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '04901234567894' });
const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '06141415' });
/** What a decade-old record might say, kept as an awkward composite: a dated
 * purchase, a supplier, a loan, a room, CRLF, a tab and non-ASCII text. */
const description = 'Purchased 2015-11-02 from Example Trading.\r\nLent to Lab B (2018).\t保管: 402号室';

const populated: Asset = Object.freeze({
  id: '0198c2a0-0000-7000-8000-000000000001',
  name: 'Spectrum analyser',
  identifiers: [{ key: 'i1', ...gtin, attachment: {
    acceptedBy: reporter, acceptedAt: '2026-06-22T00:00:01.000Z',
    assertedBy: { id: 'token-1', label: 'legacy loader' }, basis: 'legacy:assetcats:42' } },
  { key: 'i2', ...giai, attachment: null }],
  issuances: [{ key: 'issuance-1', scheme: 'giai' as const, canonical: giai.canonical, gcp: '0614141',
    sequence: 5, classKeyCanonical: null, allocatedAt: '2026-06-23T00:00:00.000Z',
    allocatedForAssetId: '0198c2a0-0000-7000-8000-000000000001', allocatedBy: reporter }],
  reportedBy: reporter,
  reportedAt: '2026-06-22T00:00:00.000Z',
  provenance: { acceptedBy: reporter, acceptedAt: '2026-06-23T00:00:00.000Z',
    assertedBy: { id: 'token-1', label: 'legacy loader' }, basis: 'legacy:assets:101' },
  sourceRecord: { reference: 'legacy:assets:101', recordedAt: '2016-05-10T01:00:00.000Z',
    recordedBy: 'K. Sato', description },
  owner: { key: 'owner-1', name: 'Physics Department' },
  groups: [{ key: 'group-1', name: 'Workshop' }],
  isPublic: true,
  photos: [{ key: 'p1', contentType: 'image/png', size: 1024, createdAt: '2026-06-22T00:00:02.000Z' }],
});

/** An Asset as one written before provenance existed would read: everything
 * optional is absent. */
const sparse: Asset = Object.freeze({
  ...populated, id: '0198c2a0-0000-7000-8000-000000000002', identifiers: [{ key: 'i3', ...gtin, attachment: null }],
  issuances: [], provenance: null, sourceRecord: null, owner: null, isPublic: false, photos: [],
});

/** Every leaf of a JSON value with its path, `[]` marking a list element. */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test('every instant is either an act in Kannabi or what a source says', () => {
  // The only places an instant can be. Each is the `at` of something Kannabi
  // did, or the source's own recordedAt: there is no slot an acquisition,
  // loan or other physical event could occupy, so none can be read as one.
  const kannabiClock = /^(kannabi\.(reported|lastChange|issued\[\])\.at|kannabi\.photos\[\]\.receivedAt|identifiers\[\]\.accepted\.at)$/;
  const instants = leaves(json(assetRecord(populated)))
    .filter(([, value]) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value));
  assert.ok(instants.length >= 6);
  for (const [path] of instants) {
    assert.ok(kannabiClock.test(path) || path === 'source.says.recordedAt', `${path} is an instant of unstated standing`);
  }
  // The source's registration time is reachable only as what the source says.
  assert.deepEqual(instants.filter(([, value]) => value === populated.sourceRecord!.recordedAt)
    .map(([path]) => path), ['source.says.recordedAt']);
  // Kannabi's report time is the report, not the source's past.
  assert.equal(assetRecord(populated).kannabi.reported.at, populated.reportedAt);
});

test('everything a source stated is under source, and nothing else is', () => {
  const record = json(assetRecord(populated));
  // The reference is the one exception, and not a quotation: a loader may name
  // the same row as the basis of its write, which is Kannabi's record of what
  // that request said.
  assert.deepEqual(leaves(record).filter(([, leaf]) => leaf === populated.sourceRecord!.reference)
    .map(([path]) => path).sort(), ['kannabi.lastChange.basis', 'source.reference']);
  const stated = [populated.sourceRecord!.recordedAt, populated.sourceRecord!.recordedBy, description];
  for (const value of stated) {
    const at = leaves(record).filter(([, leaf]) => leaf === value).map(([path]) => path);
    assert.equal(at.length, 1, `${value} appears ${at.length} times`);
    assert.match(at[0], /^source\./);
  }
  // The quotation is exact: no trimming, newline conversion or normalisation.
  assert.equal(assetRecord(populated).source!.says.description, description);
  // Kannabi's own section holds Kannabi's values: the reporter, not the
  // source's recorder.
  assert.equal(record.kannabi.reported.by.name, reporter.name);
  assert.ok(!JSON.stringify(record.kannabi).includes('K. Sato'));
});

test('nothing the source mentions becomes a field of its own', () => {
  // A date, supplier, holder or room in quoted text stays quoted text: no key
  // anywhere in the record could hold an acquisition, custody or location.
  const keys = leaves(json(assetRecord(populated))).flatMap(([path]) => path.split(/[.[\]]+/))
    .filter((key) => key !== '');
  for (const key of keys) {
    assert.doesNotMatch(key, /acqui|purchas|supplier|vendor|custod|holder|borrow|loan|lent|location|room|place|cost|price|condition/i);
  }
  for (const fragment of ['2015-11-02', 'Example Trading', 'Lab B', '402号室']) {
    const at = leaves(json(assetRecord(populated)))
      .filter(([, leaf]) => typeof leaf === 'string' && leaf.includes(fragment)).map(([path]) => path);
    assert.deepEqual(at, ['source.says.description'], `${fragment} escaped the quotation`);
  }
  // What Kannabi records none of is named rather than left to an absent key.
  for (const fact of ['acquisition', 'location', 'custody', 'ownership history']) {
    assert.ok(assetRecord(populated).notRecorded.includes(fact as never));
  }
});

test('an unknown stays an explicit null, never a missing key', () => {
  const record = json(assetRecord(sparse));
  assert.deepEqual(Object.keys(record).sort(), Object.keys(json(assetRecord(populated))).sort());
  assert.deepEqual(Object.keys(record.kannabi).sort(), Object.keys(json(assetRecord(populated)).kannabi).sort());
  assert.equal(record.kannabi.owner, null);
  assert.equal(record.kannabi.lastChange, null);
  assert.equal(record.source, null);
  assert.equal(record.identifiers[0].accepted, null);
  // notRecorded does not depend on what an Asset happens to carry.
  assert.deepEqual(record.notRecorded, [...notRecorded]);
  // A source that stated no time or name says so with null inside source.says.
  const silent = assetRecord({ ...sparse, sourceRecord: { reference: 'legacy:assets:7', recordedAt: null,
    recordedBy: null, description: null } });
  assert.deepEqual(silent.source, { reference: 'legacy:assets:7',
    says: { recordedAt: null, recordedBy: null, description: null } });
});

test('a summary is the record with stated omissions, never a different record', () => {
  const record = json(assetRecord(populated));
  const summary = json(assetSummary(populated, ['sourceDescription']));
  const { identifiers, matched, ...rest } = summary;
  const recordLeaves = new Map(leaves(record));
  for (const [path, value] of leaves(rest)) {
    assert.deepEqual(recordLeaves.get(path), value, `${path} differs from the record`);
  }
  identifiers.forEach((identifier: Record<string, unknown>, index: number) => {
    for (const [field, value] of Object.entries(identifier)) {
      assert.deepEqual(record.identifiers[index][field], value, `identifiers[${index}].${field} differs`);
    }
  });
  for (const omitted of summaryOmits) {
    const prefix = omitted.replace('[]', '');
    assert.ok(leaves(record).some(([path]) => path.replace(/\[\]/g, '').startsWith(prefix.replace(/\[\]/g, ''))),
      `${omitted} is not in the record`);
    assert.ok(!leaves(summary).some(([path]) => path.replace(/\[\]/g, '').startsWith(prefix.replace(/\[\]/g, ''))),
      `${omitted} is in the summary although the page says it is omitted`);
  }
  assert.deepEqual(matched, ['source.says.description']);
});

const store = {
  async getAsset(id: string) { return [populated, sparse].find((asset) => asset.id === id) ?? null; },
} as unknown as IdentityStore;
const anonymous = { api: { getSession: async () => null } } as unknown as Auth;
const origin = 'http://localhost:3000';
const api = createInventoryApi(store, anonymous, origin);

test('the HTTP API and MCP return the same record', async (t) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kannabi-test-client', version: '0.0.0' });
  await Promise.all([createMcpServer(store, systemAudienceResolver()).connect(serverTransport),
    client.connect(clientTransport)]);
  t.after(() => client.close());
  for (const asset of [populated, sparse]) {
    const response = await api.request(origin + `/v2/assets/${asset.id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.representation, 2);
    const result = await client.callTool({ name: 'get_asset', arguments: { assetId: asset.id } }) as {
      structuredContent: { asset: unknown } };
    assert.deepEqual(result.structuredContent.asset, body.asset);
    assert.deepEqual(body.asset, json(assetRecord(asset)));
  }
});

test('existing clients are answered exactly as before', async () => {
  const response = await api.request(origin + `/assets/${populated.id}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.asset, json(populated));
  assert.equal(body.representation, undefined);
});
