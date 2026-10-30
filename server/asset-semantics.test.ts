import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { assetSemantics, type FieldSemantics } from './asset-semantics.js';
import { createInventoryApi } from './inventory-api.js';
import { createMcpServer, instructions } from './mcp-tools.js';
import { systemAudienceResolver } from './mcp-principal.js';
import { canonicalIdentifier } from './gs1.js';
import type { Auth } from './auth.js';
import type { Asset, IdentityStore } from './identity-store.js';

/** The statement of what Asset fields mean is only worth anything if it is
 * complete, if it says the things a client is most likely to get wrong, and if
 * both surfaces answer with it. These tests hold it to all three against a
 * recorded store, so they run without a database;
 * `asset-semantics.integration.test.ts` holds real Assets to it. */

const reporter = { key: 'user-1', name: 'Alex Demo', status: 'active' as const };
const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '04901234567894' });
const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '06141415' });

/** Every field populated, so nothing the representation can carry escapes the
 * walk below because it happened to be null in the fixture. */
const populated: Asset = Object.freeze({
  id: '0198c2a0-0000-7000-8000-000000000001',
  name: 'Spectrum analyser',
  identifiers: [{ key: 'i1', ...gtin, attachment: {
    acceptedBy: reporter, acceptedAt: '2026-06-22T00:00:01.000Z',
    assertedBy: { id: 'token-1', label: 'Depot loader' }, basis: 'depot:assets:101' } },
  { key: 'i2', ...giai, attachment: null }],
  issuances: [{ key: 'issuance-1', scheme: 'giai' as const, canonical: giai.canonical, gcp: '0614141',
    sequence: 5, classKeyCanonical: null, allocatedAt: '2026-06-23T00:00:00.000Z',
    allocatedForAssetId: '0198c2a0-0000-7000-8000-000000000001', allocatedBy: reporter }],
  reportedBy: reporter,
  reportedAt: '2026-06-22T00:00:00.000Z',
  provenance: { acceptedBy: reporter, acceptedAt: '2026-06-23T00:00:00.000Z',
    assertedBy: { id: 'token-1', label: 'Depot loader' }, basis: 'depot:assets:101' },
  sourceRecord: { reference: 'depot:assets:101', recordedAt: '2016-05-10T01:00:00.000Z',
    recordedBy: 'K. Sato', description: 'Purchased from Example Trading, 2015-11-02.' },
  owner: { key: 'owner-1', name: 'Physics Department' },
  groups: [{ key: 'group-1', name: 'Workshop' }],
  isPublic: true,
  photos: [{ key: 'p1', contentType: 'image/png', size: 1024, createdAt: '2026-06-22T00:00:02.000Z' }],
});

/** Every leaf path of a JSON value, `[]` marking a list element. */
function leaves(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  }
  return [path];
}

/** Every value at a leaf, with its path. */
function values(value: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => values(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => values(item, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

type Surface = 'http' | 'mcp';

/** The declaration governing a path: its own, or its nearest listed ancestor's. */
function governing(surface: Surface, path: string): FieldSemantics | undefined {
  const steps = path.split('.');
  for (let length = steps.length; length > 0; length--) {
    const candidate = steps.slice(0, length).join('.');
    const found = assetSemantics.fields.find((field) =>
      field.paths[surface] === candidate || field.paths[surface] === candidate.replace(/\[\]$/, ''));
    if (found) return found;
  }
  return undefined;
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function assertComplete(surface: Surface, representation: unknown) {
  const paths = leaves(representation);
  for (const path of paths) {
    assert.ok(governing(surface, path), `${surface} ${path} has no stated meaning`);
  }
  for (const field of assetSemantics.fields) {
    const declared = field.paths[surface];
    if (declared === null) continue;
    assert.ok(paths.some((path) => path === declared || path.startsWith(declared + '.')
      || path.startsWith(declared + '[]')), `${surface} carries no ${declared}, yet its meaning is stated`);
  }
  // An instant whose clock is not stated is exactly what lets a client read an
  // import time as an acquisition date, so inheriting a parent's meaning is not
  // enough here: each instant needs its own.
  for (const [path, value] of values(representation)) {
    if (typeof value !== 'string' || !instant.test(value)) continue;
    const field = assetSemantics.fields.find((entry) => entry.paths[surface] === path);
    assert.ok(field?.time, `${surface} ${path} is an instant with no stated clock`);
  }
}

async function connect(store: IdentityStore) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kannabi-test-client', version: '0.0.0' });
  await Promise.all([
    createMcpServer(store, systemAudienceResolver()).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

const store = {
  async getAsset(id: string) { return id === populated.id ? populated : null; },
} as unknown as IdentityStore;
const anonymous = { api: { getSession: async () => null } } as unknown as Auth;
const origin = 'http://localhost:3000';
const api = createInventoryApi(store, anonymous, origin);

test('every field of the HTTP Asset representation has a stated meaning', async () => {
  const response = await api.request(origin + `/assets/${populated.id}`);
  assert.equal(response.status, 200);
  const { asset } = await response.json();
  assertComplete('http', asset);
});

test('every field get_asset returns has a stated meaning', async (t) => {
  const client = await connect(store);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'get_asset', arguments: { assetId: populated.id } }) as {
    structuredContent: { asset: unknown } };
  assertComplete('mcp', result.structuredContent.asset);
});

test('no instant on an Asset is the time of a physical event', () => {
  const instants = assetSemantics.fields.filter((field) => field.time);
  assert.ok(instants.length >= 6);
  for (const field of instants) {
    // Stated as a reading to refuse, so a client looking for an acquisition
    // date is told where not to find one rather than left to infer it.
    assert.ok(field.never?.some((reading) => /acquisition/.test(reading)),
      `${field.paths.http ?? field.paths.mcp} never says it is not an acquisition date`);
    assert.doesNotMatch(field.time!.instantOf, /acqui|purchas|manufactur|loan|lent|disposal/i);
  }
  // One instant orders Assets, it is Kannabi's own, and it is the import time
  // for an imported Asset rather than anything earlier.
  const chronology = instants.filter((field) => field.paths.http === assetSemantics.chronology);
  assert.equal(chronology.length, 1);
  assert.equal(chronology[0].time!.clock, 'kannabi');
  assert.match(chronology[0].time!.instantOf, /import/);
  // Exactly one instant is a source's statement, and it is the source's
  // registration of its own record.
  const sourced = instants.filter((field) => field.time!.clock === 'source');
  assert.deepEqual(sourced.map((field) => field.paths.http), ['sourceRecord.recordedAt']);
  assert.match(sourced[0].time!.instantOf, /source system registering its record/);
  assert.ok(sourced[0].never?.some((reading) => /when Kannabi learned/.test(reading)));
});

test('quoted evidence is quoted and nothing else is', () => {
  for (const field of assetSemantics.fields) {
    const path = field.paths.http ?? field.paths.mcp!;
    assert.equal(field.standing === 'quoted', path === 'sourceRecord' || path.startsWith('sourceRecord.'),
      `${path} is ${field.standing}`);
  }
  const description = assetSemantics.fields.find((field) => field.paths.http === 'sourceRecord.description')!;
  assert.match(description.means, /whatever date the text itself gives, or none/);
  assert.ok(description.never?.some((reading) => /current state/.test(reading)));
  assert.match(description.absent!, /Never that the source had none/);
  assert.match(assetSemantics.quotedMentions, /derives no field, date or current state/);
});

test('what Kannabi does not hold is stated, not left to an empty field', () => {
  const unheld = assetSemantics.unheld.map((fact) => fact.fact);
  for (const fact of ['acquisition', 'location', 'custody', 'ownership-history', 'events', 'condition']) {
    assert.ok(unheld.includes(fact), `${fact} is not stated as unheld`);
  }
  // A historical loan in a source description is not custody, and nothing an
  // Asset carries is either.
  assert.match(assetSemantics.unheld.find((fact) => fact.fact === 'custody')!.statement,
    /borrowed or lent it, now or at any earlier time/);
  // An absent owner is Kannabi holding none, never the thing being unowned.
  const owner = assetSemantics.fields.find((field) => field.paths.http === 'owner')!;
  assert.equal(owner.standing, 'state');
  assert.match(owner.absent!, /Never that the Asset is unowned/);
  assert.ok(owner.never?.some((reading) => /owned it before/.test(reading)));
  assert.match(assetSemantics.absence, /never evidence that it is false/);
});

test('the HTTP API and MCP answer with one statement', async (t) => {
  const response = await api.request(origin + '/semantics');
  assert.equal(response.status, 200, 'the statement needs no sign-in, as a public Asset needs none');
  const { semantics } = await response.json();
  assert.deepEqual(semantics, JSON.parse(JSON.stringify(assetSemantics)));

  const client = await connect(store);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'describe_asset_semantics', arguments: {} }) as {
    structuredContent: { semantics: unknown }; isError?: boolean };
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.semantics, semantics);

  // The connection instructions list what Kannabi does not hold from the same
  // statement, so the boundary cannot be stated one way here and another there.
  for (const fact of assetSemantics.unheld) {
    assert.ok(instructions.includes(`- ${fact.statement};`), `the instructions omit ${fact.fact}`);
  }
  assert.ok(instructions.includes(assetSemantics.quotedMentions));
});

test('an Asset response points at the statement of what it means', async () => {
  const response = await api.request(origin + `/assets/${populated.id}`);
  assert.equal(response.headers.get('Link'), `<${origin}/api/semantics>; rel="describedby"`);
  // An unknown Asset is still an answer about Assets; an unrelated route is not.
  const missing = await api.request(origin + '/assets/0198c2a0-0000-7000-8000-00000000ffff');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Link'), `<${origin}/api/semantics>; rel="describedby"`);
  assert.equal((await api.request(origin + '/semantics')).headers.get('Link'), null);
});
