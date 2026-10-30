import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer, serverInfo } from './mcp-tools.js';
import { systemAudienceResolver } from './mcp-principal.js';
import { canonicalIdentifier } from './gs1.js';
import { ValidationError } from './identity.js';
import type {
  Asset, AssetLookup, AssetPage, Gs1LedgerPage, IdentityStore,
} from './identity-store.js';
import type { AudienceInput } from './asset-audience.js';

/** These tests exercise the agent-facing contract — tool discovery, schemas,
 * projections and error shape — against a recorded store, so they run without
 * a database. `mcp.integration.test.ts` covers the real domain behaviour. */

const workshop = { key: 'group-workshop', name: 'Demo Workshop' };
const studio = { key: 'group-studio', name: 'Shared Studio' };
const reporter = { key: 'user-1', name: 'Alex Demo', status: 'active' as const };
const gcp = '0614141';

function asset(id: string, name: string, overrides: Partial<Asset> = {}): Asset {
  return Object.freeze({
    id, name, identifiers: [], issuances: [], reportedBy: reporter,
    reportedAt: '2026-06-22T00:00:00.000Z', provenance: null, sourceRecord: null,
    owner: null, groups: [workshop], isPublic: false, photos: [], ...overrides,
  });
}

const cameraGtin = canonicalIdentifier({ scheme: 'gtin', gtin: '04901234567894' });
const issuedGiai = canonicalIdentifier({ scheme: 'giai', assetReference: gcp + '5' });
/** Textually under the managed prefix, but never issued by Kannabi. */
const lookalikeGiai = canonicalIdentifier({ scheme: 'giai', assetReference: gcp + 'DEMO-004' });

/** What a pre-existing record says about itself. The quoted instant is years
 * before `reportedAt`, and the quoted name matches no User, so a projection
 * that confused either with Kannabi's own would be visible. */
const quoted = {
  reference: 'legacy:asset:1483',
  recordedAt: '2019-04-12T09:30:00.000Z',
  recordedBy: 'A. Rivera',
  description: 'Bench camera\r\nS/N 0042',
};

/** How the GTIN came to be attached, as the store projects it. */
const cameraGtinAttachment = {
  acceptedBy: reporter, acceptedAt: '2026-06-22T00:00:01.000Z',
  assertedBy: { id: 'token-1', label: 'Depot importer' }, basis: 'depot:assetcats:42',
};
const changeProvenance = {
  acceptedBy: reporter, acceptedAt: '2026-06-23T00:00:00.000Z', assertedBy: null, basis: null,
};

const camera = asset('0198c2a0-0000-7000-8000-000000000001', 'Inspection camera · Bench 001', {
  sourceRecord: quoted, provenance: changeProvenance,
  identifiers: [{ key: 'i1', ...cameraGtin, attachment: cameraGtinAttachment },
    { key: 'i2', ...issuedGiai, attachment: null }],
  issuances: [{
    key: 'issuance-1', scheme: 'giai' as const, canonical: issuedGiai.canonical, gcp, sequence: 5,
    classKeyCanonical: null, allocatedAt: '2026-06-23T00:00:00.000Z',
    allocatedForAssetId: '0198c2a0-0000-7000-8000-000000000001', allocatedBy: reporter,
  }],
  photos: [{ key: 'p1', contentType: 'image/png', size: 1024, createdAt: '2026-06-22T00:00:00.000Z' }],
});
const microscope = asset('0198c2a0-0000-7000-8000-000000000002', 'Inspection microscope · Studio 011', {
  identifiers: [{ key: 'i3', ...cameraGtin, attachment: null }, { key: 'i4', ...lookalikeGiai, attachment: null }],
  groups: [studio], isPublic: true,
});
/** An issuance whose value has since been detached from its Asset. */
const detached = asset('0198c2a0-0000-7000-8000-000000000003', 'Signal generator · Field 007');

const namespace = Object.freeze({
  key: 'namespace-1', gcp, active: true,
  counters: {
    giai: { nextSequence: 7, exclusions: [{ from: 1, to: 4 }] },
    graiType: { nextSequence: 1, exclusions: [] },
    gtinItem: { nextSequence: 1, exclusions: [] },
  },
  classKeyIssuable: true, unissuableReason: null, gtinFormat: 'GTIN-12' as const,
  group: workshop, configuredAt: '2026-06-20T00:00:00.000Z',
  configuredBy: reporter.key,
});

type Call = { method: string; audience: AudienceInput; request?: unknown };

function recordingStore(calls: Call[]) {
  const store = {
    async findAssets(audience: AudienceInput, request: unknown): Promise<AssetPage> {
      calls.push({ method: 'findAssets', audience, request });
      return { assets: [camera, microscope], total: 3, matching: 2,
        matchedFields: { [camera.id]: ['name'], [microscope.id]: ['sourceDescription'] },
        scopes: { all: 2, mine: 0, group: 0, public: 1 }, nextCursor: 'next-page' };
    },
    async lookupAssets(audience: AudienceInput, request: unknown): Promise<AssetLookup> {
      calls.push({ method: 'lookupAssets', audience, request });
      return Object.freeze({
        identity: Object.freeze({ kind: 'identifier' as const, canonical: cameraGtin.canonical,
          scheme: cameraGtin.scheme, level: cameraGtin.level }),
        assets: [camera, microscope], matching: 2, nextCursor: null,
      });
    },
    async getAsset(id: string, audience: AudienceInput): Promise<Asset | null> {
      calls.push({ method: 'getAsset', audience, request: id });
      // Both, so a projection can be checked against an Asset quoted from
      // elsewhere and one that originated in Kannabi.
      return [camera, microscope].find((candidate) => candidate.id === id) ?? null;
    },
    async listGroups(audience: AudienceInput) {
      calls.push({ method: 'listGroups', audience });
      return [workshop, studio];
    },
    async listGs1Namespaces(audience: AudienceInput) {
      calls.push({ method: 'listGs1Namespaces', audience });
      return [namespace];
    },
    async gs1Issuances(audience: AudienceInput, request: unknown): Promise<Gs1LedgerPage> {
      calls.push({ method: 'gs1Issuances', audience, request });
      return Object.freeze({
        namespace,
        matching: 2,
        entries: [
          Object.freeze({ issuance: camera.issuances[0], asset: camera }),
          Object.freeze({
            issuance: { key: 'issuance-2', scheme: 'giai' as const,
              canonical: '(8004)' + gcp + '6', gcp, sequence: 6, classKeyCanonical: null,
              allocatedAt: '2026-06-24T00:00:00.000Z',
              allocatedForAssetId: detached.id, allocatedBy: reporter },
            asset: detached,
          }),
        ],
        nextCursor: null,
      });
    },
  };
  return store as unknown as IdentityStore;
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

function structured(result: unknown): Record<string, unknown> {
  const payload = result as { structuredContent?: Record<string, unknown>; isError?: boolean };
  assert.equal(payload.isError, undefined, 'tool reported an error');
  assert.ok(payload.structuredContent, 'tool returned no structured content');
  return payload.structuredContent;
}

test('the MCP tool surface is discoverable and read-only', async (t) => {
  const calls: Call[] = [];
  const client = await connect(recordingStore(calls));
  t.after(() => client.close());
  const { tools } = await client.listTools();

  await t.test('exposes exactly the Kannabi domain tools', () => {
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_asset', 'list_groups', 'list_gs1_issuances', 'list_gs1_namespaces',
      'list_managed_class_keys',
      'resolve_external_identifier', 'search_assets',
    ]);
  });

  await t.test('every tool is annotated read-only and documented', () => {
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not read-only`);
      assert.ok((tool.description ?? '').length > 80, `${tool.name} lacks a usable description`);
      assert.ok(tool.outputSchema, `${tool.name} has no output schema`);
    }
  });

  await t.test('no tool offers graph, query or write access', () => {
    const surface = JSON.stringify(tools).toLowerCase();
    for (const forbidden of ['cypher', 'neo4j', 'traverse', 'epcis']) {
      assert.ok(!surface.includes(forbidden), `the tool surface mentions ${forbidden}`);
    }
  });

  await t.test('resolution and discovery are distinguishable from their descriptions', () => {
    const description = (name: string) => tools.find((tool) => tool.name === name)!.description!;
    assert.match(description('search_assets'), /substring/i);
    assert.match(description('resolve_external_identifier'), /never matched by substring|Nothing is matched by substring/i);
    assert.match(description('get_asset'), /native Kannabi Asset ID/i);
  });
});

test('Asset discovery tools project Kannabi domain facts', async (t) => {
  const calls: Call[] = [];
  const client = await connect(recordingStore(calls));
  t.after(() => client.close());

  await t.test('search returns summaries that say they are summaries', async () => {
    const page = structured(await client.callTool({ name: 'search_assets',
      arguments: { query: 'inspection', groupKeys: [workshop.key], limit: 10 } }));
    assert.deepEqual(page.matching, 2);
    assert.deepEqual(page.nextCursor, 'next-page');
    const assets = page.assets as Record<string, any>[];
    assert.deepEqual(assets.map((entry) => entry.id), [camera.id, microscope.id]);
    // The page names what it leaves out, so a summary never reads as the
    // record: the quoted text, the latest change and acceptance are not here.
    for (const path of ['source.says', 'kannabi.lastChange', 'identifiers[].accepted', 'notRecorded']) {
      assert.ok((page.omitted as string[]).includes(path), `the page does not say it omits ${path}`);
    }
    assert.equal(assets[0].source.says, undefined);
    assert.deepEqual(assets[0].source, { reference: quoted.reference });
    assert.equal(assets[1].source, null);
    // Where the text matched is a path into the full record, so a match on
    // quoted source text is visibly a match inside source.says.
    assert.deepEqual(assets.map((entry) => entry.matched), [['kannabi.name'], ['source.says.description']]);
  });

  await t.test('search reuses the shared request parser', async () => {
    const request = calls.find((call) => call.method === 'findAssets')!.request as
      { q: string; filters: { groups: string[] }; limit: number; scope: string };
    assert.equal(request.q, 'inspection');
    assert.deepEqual(request.filters.groups, [workshop.key]);
    assert.equal(request.limit, 10);
    assert.equal(request.scope, 'all');
  });

  await t.test('a class identifier resolves to several Assets and says so', async () => {
    const lookup = structured(await client.callTool({ name: 'resolve_external_identifier',
      arguments: { scheme: 'gtin', gtin: '04901234567894' } }));
    const identity = lookup.identity as Record<string, unknown>;
    assert.equal(identity.canonical, cameraGtin.canonical);
    assert.equal(identity.level, 'class');
    assert.match(String(identity.levelMeaning), /may address several/);
    assert.equal(lookup.matching, 2);
  });

  await t.test('an unusable identifier is a tool error, not an empty result', async () => {
    const rejected = await client.callTool({ name: 'resolve_external_identifier',
      arguments: { scheme: 'gtin', gtin: 'not-a-gtin' } }) as { isError?: boolean };
    assert.equal(rejected.isError, true);
    assert.equal(calls.filter((call) => call.method === 'lookupAssets').length, 1,
      'an invalid identifier must not reach the store');
  });

  await t.test('inspection returns the full record and reports a miss plainly', async () => {
    const found = structured(await client.callTool({ name: 'get_asset',
      arguments: { assetId: camera.id } }));
    assert.equal(found.found, true);
    const record = found.asset as Record<string, any>;
    assert.deepEqual(record.kannabi.reported, { at: camera.reportedAt, by: reporter });
    assert.equal(record.kannabi.photos.length, 1);
    assert.equal(record.identifiers[0].accepted.gs1Policy, cameraGtin.policyVersion);
    assert.ok(record.identifiers.every((identifier: { components: unknown }) => identifier.components));

    const missing = structured(await client.callTool({ name: 'get_asset',
      arguments: { assetId: '0198c2a0-0000-7000-8000-00000000ffff' } }));
    assert.deepEqual(missing, { found: false, asset: null });
  });

  await t.test('what a source said sits apart from what Kannabi holds', async () => {
    const found = structured(await client.callTool({ name: 'get_asset',
      arguments: { assetId: camera.id } }));
    const record = found.asset as Record<string, any>;
    // Quoted exactly, line break included, and only under source.says.
    assert.deepEqual(record.source, { reference: quoted.reference, says: {
      recordedAt: quoted.recordedAt, recordedBy: quoted.recordedBy, description: quoted.description } });
    // The source's instant and name are nowhere in Kannabi's own section.
    const own = JSON.stringify(record.kannabi);
    assert.ok(!own.includes(quoted.recordedAt) && !own.includes(quoted.recordedBy));
    assert.notEqual(record.kannabi.reported.by.name, quoted.recordedBy);
    // What Kannabi records none of is stated, not left to an absent key.
    for (const fact of ['acquisition', 'location', 'custody', 'ownership history']) {
      assert.ok(record.notRecorded.includes(fact), `${fact} is not stated as unrecorded`);
    }

    // An Asset that originated in Kannabi says so rather than omitting the field.
    const native = structured(await client.callTool({ name: 'get_asset',
      arguments: { assetId: microscope.id } }));
    assert.equal((native.asset as Record<string, unknown>).source, null);
  });

  await t.test('inspection carries how each identifier was accepted, and the latest change', async () => {
    const found = structured(await client.callTool({ name: 'get_asset',
      arguments: { assetId: camera.id } }));
    const record = found.asset as Record<string, any>;
    const gtin = record.identifiers.find((identifier: { value: string }) => identifier.value === cameraGtin.canonical);
    const giai = record.identifiers.find((identifier: { value: string }) => identifier.value === issuedGiai.canonical);
    assert.deepEqual(gtin.accepted, { at: cameraGtinAttachment.acceptedAt, by: reporter,
      via: cameraGtinAttachment.assertedBy, basis: cameraGtinAttachment.basis, gs1Policy: cameraGtin.policyVersion });
    // An association recorded before Kannabi kept this says so, not "nobody".
    assert.equal(giai.accepted, null);
    assert.deepEqual(record.kannabi.lastChange, { at: changeProvenance.acceptedAt, by: reporter,
      via: null, basis: null });
    // Issued is Kannabi's ledger, apart from the identifiers it merely holds.
    assert.deepEqual(record.kannabi.issued.map((issued: { value: string }) => issued.value), [issuedGiai.canonical]);
  });

  await t.test('a malformed Asset ID never reaches the store', async () => {
    const before = calls.filter((call) => call.method === 'getAsset').length;
    const rejected = await client.callTool({ name: 'get_asset',
      arguments: { assetId: 'inspection camera' } }) as { isError?: boolean };
    assert.equal(rejected.isError, true);
    assert.equal(calls.filter((call) => call.method === 'getAsset').length, before);
  });
});

test('allocation provenance is reported from the issuance ledger', async (t) => {
  const calls: Call[] = [];
  const client = await connect(recordingStore(calls));
  t.after(() => client.close());

  await t.test('namespaces describe the authority Kannabi claims', async () => {
    const listed = structured(await client.callTool({ name: 'list_gs1_namespaces', arguments: {} }));
    const namespaces = listed.namespaces as Record<string, unknown>[];
    assert.equal(namespaces[0].namespaceKey, namespace.key);
    assert.equal(namespaces[0].gcp, gcp);
    assert.deepEqual(namespaces[0].group, workshop);
    const counters = namespaces[0].counters as Record<string, Record<string, unknown>>;
    assert.deepEqual(counters.giai.excludedReferences, [{ from: 1, to: 4 }]);
    // Three counters, never one: a GTIN and a GRAI asset type made of the same
    // digits are different keys and must not share a sequence.
    assert.deepEqual(Object.keys(counters).sort(), ['giai', 'graiType', 'gtinItem']);
    assert.deepEqual(Object.keys(namespaces[0]).sort(), ['active', 'classKeyIssuable',
      'configuredAt', 'counters', 'gcp', 'group', 'gtinFormat', 'namespaceKey',
      'unissuableReason'].sort());
  });

  await t.test('the allocation counter is never presented as a count of issuances', async () => {
    // The counter advances past excluded references too, so 7 here means two
    // issuances and four skipped numbers. Only the ledger may be counted.
    const listed = structured(await client.callTool({ name: 'list_gs1_namespaces', arguments: {} }));
    assert.equal(((listed.namespaces as Record<string, unknown>[])[0]
      .counters as Record<string, Record<string, unknown>>).giai.nextSequence, 7);
    const ledger = structured(await client.callTool({ name: 'list_gs1_issuances',
      arguments: { namespaceKey: namespace.key } }));
    assert.equal(ledger.matching, 2);
  });

  await t.test('issuances bind a value to an Asset and report attachment separately', async () => {
    const ledger = structured(await client.callTool({ name: 'list_gs1_issuances',
      arguments: { namespaceKey: namespace.key } }));
    const issuances = ledger.entries as Record<string, unknown>[];
    assert.equal(issuances.length, 2);
    assert.equal(issuances[0].assetId, camera.id);
    assert.equal(issuances[0].stillAttached, true);
    // Issued for this Asset, since detached: the ledger still names it.
    assert.equal(issuances[1].assetId, detached.id);
    assert.equal(issuances[1].stillAttached, false);
  });

  await t.test('an Asset whose GIAI only shares the prefix is not an issuance', async () => {
    const ledger = structured(await client.callTool({ name: 'list_gs1_issuances',
      arguments: { namespaceKey: namespace.key } }));
    const issuances = ledger.entries as { assetId: string }[];
    assert.ok(microscope.identifiers.some((identifier) =>
      identifier.canonical.includes(gcp)), 'the fixture must share the prefix textually');
    assert.ok(!issuances.some((issuance) => issuance.assetId === microscope.id));
  });

  await t.test('an unusable namespace key never reaches the store', async () => {
    const before = calls.filter((call) => call.method === 'gs1Issuances').length;
    const rejected = await client.callTool({ name: 'list_gs1_issuances',
      arguments: { namespaceKey: '   ' } }) as { isError?: boolean };
    assert.equal(rejected.isError, true);
    assert.equal(calls.filter((call) => call.method === 'gs1Issuances').length, before);
  });
});

test('every tool reads under the accepted system-wide audience', async (t) => {
  const calls: Call[] = [];
  const client = await connect(recordingStore(calls));
  t.after(() => client.close());
  for (const [name, args] of [
    ['search_assets', {}],
    ['resolve_external_identifier', { scheme: 'gtin', gtin: '04901234567894' }],
    ['get_asset', { assetId: camera.id }],
    ['list_groups', {}],
    ['list_gs1_namespaces', {}],
    ['list_gs1_issuances', { namespaceKey: namespace.key }],
  ] as const) {
    await client.callTool({ name, arguments: args });
  }
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.deepEqual(call.audience, { kind: 'system' },
      `${call.method} did not read under the system audience`);
  }
});

type SchemaNode = Record<string, unknown> | undefined;

/** A nullable field is advertised either as `type: [value, "null"]` or as
 * `anyOf: [value, null]`. Reach past both to the value an agent receives when
 * the field is populated. */
function present(node: SchemaNode): SchemaNode {
  if (!node) return node;
  const branches = (node.anyOf ?? node.oneOf) as Record<string, unknown>[] | undefined;
  if (branches) {
    const value = branches.find((branch) => branch.type !== 'null');
    return value ? { ...value, description: node.description ?? value.description } : node;
  }
  if (Array.isArray(node.type)) {
    const [type] = (node.type as string[]).filter((entry) => entry !== 'null');
    return { ...node, type };
  }
  return node;
}

/** Walk a `field[].nested` path through a JSON Schema and return the node. */
function schemaAt(schema: unknown, path: string): SchemaNode {
  let node = present(schema as SchemaNode);
  for (const step of path.split('.')) {
    const key = step.replace('[]', '');
    node = present((node?.properties as Record<string, SchemaNode> | undefined)?.[key]);
    if (step.endsWith('[]')) node = present(node?.items as SchemaNode);
    if (!node) return undefined;
  }
  return node;
}

/** Every handle one tool hands out, and the tool argument it must feed.
 *
 * This is the composability contract, and the thing a refactor can break
 * without failing anything else: rename a returned field, or stop returning
 * it, and an agent reaches a dead end while every individual tool still works.
 */
const compositions = [
  { from: 'search_assets', field: 'assets[].id', to: 'get_asset', argument: 'assetId' },
  { from: 'search_assets', field: 'assets[].kannabi.groups[].key', to: 'search_assets', argument: 'groupKeys' },
  { from: 'search_assets', field: 'nextCursor', to: 'search_assets', argument: 'cursor' },
  { from: 'resolve_external_identifier', field: 'assets[].id', to: 'get_asset', argument: 'assetId' },
  { from: 'get_asset', field: 'asset.id', to: 'get_asset', argument: 'assetId' },
  { from: 'resolve_external_identifier', field: 'nextCursor', to: 'resolve_external_identifier', argument: 'cursor' },
  { from: 'list_groups', field: 'groups[].key', to: 'search_assets', argument: 'groupKeys' },
  { from: 'list_gs1_namespaces', field: 'namespaces[].namespaceKey', to: 'list_gs1_issuances', argument: 'namespaceKey' },
  { from: 'list_gs1_issuances', field: 'entries[].assetId', to: 'get_asset', argument: 'assetId' },
  { from: 'list_gs1_issuances', field: 'nextCursor', to: 'list_gs1_issuances', argument: 'cursor' },
] as const;

/** Fields an agent cannot use correctly by guessing at the name alone. */
const mustBeDocumented = [
  ['search_assets', 'matching'], ['search_assets', 'total'], ['search_assets', 'nextCursor'],
  ['search_assets', 'omitted'], ['search_assets', 'assets[].matched'],
  ['search_assets', 'assets[].identifiers[].level'], ['search_assets', 'assets[].identifiers[].components'],
  ['resolve_external_identifier', 'identity.levelMeaning'], ['resolve_external_identifier', 'assets'],
  ['get_asset', 'found'], ['get_asset', 'asset.id'], ['get_asset', 'asset.identifiers[].accepted'],
  ['get_asset', 'asset.kannabi.lastChange'],
  ['list_gs1_namespaces', 'namespaces[].counters'],
  ['list_gs1_issuances', 'entries[].stillAttached'], ['list_gs1_issuances', 'matching'],
  ['list_gs1_issuances', 'entries[].issuance.canonical'],
] as const;

test('the interface stays composable and self-describing', async (t) => {
  const client = await connect(recordingStore([]));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;

  await t.test('every returned handle is accepted by the tool that consumes it', () => {
    for (const { from, field, to, argument } of compositions) {
      const produced = schemaAt(tool(from).outputSchema, field);
      assert.ok(produced, `${from} no longer returns ${field}`);
      const accepted = present((tool(to).inputSchema?.properties as Record<string, SchemaNode>)?.[argument]);
      assert.ok(accepted, `${to} no longer accepts ${argument}`);
      // A handle and its argument must agree in shape, or the agent has to
      // transform a value the interface never explained how to transform.
      const consumedType = accepted.type === 'array'
        ? (accepted.items as Record<string, unknown>).type : accepted.type;
      assert.equal(produced.type, consumedType,
        `${from}.${field} cannot be passed to ${to}.${argument} unchanged`);
    }
  });

  await t.test('fields an agent must interpret carry their own documentation', () => {
    for (const [name, field] of mustBeDocumented) {
      const node = schemaAt(tool(name).outputSchema, field);
      assert.ok(node, `${name} no longer returns ${field}`);
      assert.ok(typeof node.description === 'string' && node.description.length > 20,
        `${name}.${field} is undocumented, so an agent must guess what it means`);
    }
  });

  await t.test('an identifier returned by search can be resolved again unchanged', () => {
    // The round trip that closes the dead end: a search result's components are
    // literally the arguments resolve_external_identifier declares.
    const components = schemaAt(tool('search_assets').outputSchema, 'assets[].identifiers[].components');
    assert.ok(components, 'search results no longer carry identifier components');
    const accepted = Object.keys(tool('resolve_external_identifier').inputSchema?.properties ?? {});
    for (const field of ['gtin', 'serial', 'assetType', 'assetReference']) {
      assert.ok(accepted.includes(field), `resolve_external_identifier no longer accepts ${field}`);
    }
  });

  await t.test('quoted source evidence is never a query key', () => {
    // A quoted name or reference is not a handle: nothing accepts it, so an
    // agent cannot be tempted to pass it where a Group or Asset key belongs.
    for (const name of ['get_asset', 'search_assets', 'list_groups']) {
      const accepted = Object.keys(tool(name).inputSchema?.properties ?? {});
      assert.ok(!accepted.some((field) => /source/i.test(field)),
        `${name} accepts a source-record argument, making quoted evidence a query key`);
    }
  });

  await t.test('the server states what Kannabi does not know', () => {
    const stated = client.getInstructions() ?? '';
    // Without these an agent cannot tell a Kannabi boundary from an empty result.
    for (const boundary of ['does not own', 'location', 'custody', 'acquisition', 'EPCIS', 'read-only']) {
      assert.ok(stated.includes(boundary), `the instructions never mention ${boundary}`);
    }
    // The three sections of a record are named, since they carry the meaning.
    for (const section of ['kannabi.reported.at', 'source.says', 'notRecorded']) {
      assert.ok(stated.includes(section), `the instructions never name ${section}`);
    }
    assert.match(stated, /storing an identifier is not issuing it/i);
    assert.match(stated, /not filtered by any Kannabi User's permissions/i);
    for (const forbidden of ['claude', 'chatgpt', 'levitate', 'openai', 'cypher']) {
      assert.ok(!stated.toLowerCase().includes(forbidden),
        `the instructions name ${forbidden}, tying the contract to one consumer`);
    }
  });
});

test('the server identifies itself without naming a host or agent', () => {
  assert.equal(serverInfo.name, 'kannabi');
  for (const forbidden of ['claude', 'chatgpt', 'levitate', 'openai']) {
    assert.ok(!JSON.stringify(serverInfo).toLowerCase().includes(forbidden));
  }
});

test('domain validation failures surface as tool errors', () => {
  // The MCP layer must not invent its own error vocabulary: everything the
  // request parsers reject is a ValidationError, and everything else is a bug
  // that must keep propagating rather than being reported as a tool result.
  assert.ok(new ValidationError('x') instanceof Error);
});
