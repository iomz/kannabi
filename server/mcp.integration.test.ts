import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IdentityStore } from './identity-store.js';
import { assetPageRequest } from './asset-page.js';
import { canonicalIdentifier } from './gs1.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

const gcp = '0614141';
const unusedGcp = '9521234';
const cameraGtin = '04901234567894';
const laptopGtin = '00614141123452';

type Json = Record<string, unknown>;
type ToolResult = { structuredContent?: Json; isError?: boolean; content?: { text?: string }[] };

test('the Kannabi MCP server serves Asset discovery over stdio', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);

  async function query(cypher: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }

  // A small graph shaped like the demo dataset: one Group an agent may browse,
  // one it has no member in, and the whole 0..n identification model.
  const alex = await store.createUser('Alex Demo');
  const robin = await store.createUser('Robin Demo');
  const workshop = await store.createReportingGroup('Demo Workshop', alex.key);
  const vault = await store.createReportingGroup('Private Store', robin.key);
  const inWorkshop = { actorKey: alex.key, groupKey: workshop.key };

  const camera = await store.reportAsset({ name: 'Inspection camera · Bench 001',
    identifiers: [{ scheme: 'gtin', gtin: cameraGtin }] }, inWorkshop);
  const microscope = await store.reportAsset({ name: 'Inspection microscope · Studio 011',
    identifiers: [{ scheme: 'gtin', gtin: cameraGtin }] }, inWorkshop);
  await store.updateAsset(microscope.id, { isPublic: true }, alex.key);
  const laptop = await store.reportAsset({ name: 'Field laptop · Shelf 003',
    identifiers: [{ scheme: 'sgtin', gtin: laptopGtin, serial: 'DEMO-003' },
      { scheme: 'gtin', gtin: laptopGtin }] }, inWorkshop);
  // Stored, never issued by Kannabi: its asset reference begins with a managed
  // company prefix purely because someone typed a value that starts that way.
  const lookalikeReference = gcp + 'DEMO-004';
  const lookalike = await store.reportAsset({ name: 'Signal generator · Field 007',
    identifiers: [{ scheme: 'giai', assetReference: lookalikeReference }] }, inWorkshop);
  // Private to a Group no browsing User below belongs to.
  const sealed = await store.reportAsset({ name: 'Inspection camera · Vault 900' },
    { actorKey: robin.key, groupKey: vault.key });

  const namespace = await store.configureGiaiNamespace(alex.key, workshop.key,
    { gcp, exclusions: [{ from: 1, to: 4 }] });
  // Configured but never issued from, so the ledger has an empty page to serve.
  const unusedNamespace = await store.configureGiaiNamespace(alex.key, workshop.key,
    { gcp: unusedGcp, exclusions: [] });
  const allocatedCamera = await store.allocateGiai(camera.id, alex.key, namespace.key);
  const allocatedLaptop = await store.allocateGiai(laptop.id, alex.key, namespace.key);
  const issuedToCamera = allocatedCamera.allocation!.value;
  const issuedToLaptop = allocatedLaptop.allocation!.value;
  // Detached afterwards: the issuance survives, the attachment does not.
  await store.detachIdentifier(laptop.id, alex.key,
    allocatedLaptop.identifiers.find((identifier) => identifier.scheme === 'giai')!.key);

  /** Everything in the database, as a value two runs can compare. */
  async function fingerprint() {
    const nodes = await query('MATCH (n) RETURN labels(n) AS labels, properties(n) AS props');
    const edges = await query(
      'MATCH (a)-[r]->(b) RETURN elementId(a) + type(r) + elementId(b) AS edge, properties(r) AS props');
    return JSON.stringify({
      nodes: nodes.records.map((row) => JSON.stringify([row.get('labels'), row.get('props')])).sort(),
      edges: edges.records.map((row) => JSON.stringify([row.get('edge'), row.get('props')])).sort(),
    });
  }
  const before = await fingerprint();

  // The real thing: a child process speaking MCP on its stdio, launched the way
  // a host launches it, with no HTTP server and no Kannabi session anywhere.
  const stderr: string[] = [];
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'server/mcp.ts'],
    env: { ...environment, NEO4J_URI: uri!, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: password! },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'kannabi-integration-client', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  async function call(name: string, args: Json = {}): Promise<Json> {
    const response = await client.callTool({ name, arguments: args }) as ToolResult;
    assert.ok(!response.isError, `${name} failed: ${response.content?.[0]?.text}`);
    assert.ok(response.structuredContent, `${name} returned no structured content`);
    return response.structuredContent;
  }
  async function rejects(name: string, args: Json): Promise<string> {
    const response = await client.callTool({ name, arguments: args }) as ToolResult;
    assert.equal(response.isError, true, `${name} accepted ${JSON.stringify(args)}`);
    return response.content?.[0]?.text ?? '';
  }
  const ids = (page: Json, field = 'assets') =>
    (page[field] as Json[]).map((entry) => entry.assetId as string);

  await t.test('the transport completes initialize and tool discovery', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    assert.equal(client.getServerVersion()?.name, 'kannabi');
  });

  await t.test('diagnostics stay off the protocol channel', async () => {
    // The handshake above already proves stdout carried only JSON-RPC: any
    // stray line would have failed the client's parse. The banner proves the
    // server still reports readiness, on stderr where it belongs.
    assert.match(stderr.join(''), /Kannabi MCP server ready on stdio/);
  });

  await t.test('an incomplete description narrows to candidates', async () => {
    const page = await call('search_assets', { query: 'inspection camera' });
    assert.deepEqual(ids(page).sort(), [camera.id, sealed.id].sort());
    assert.equal(page.matching, 2);
    // Substring, never inference: the microscope is an inspection instrument
    // but is not named an inspection camera.
    assert.ok(!ids(page).includes(microscope.id));
  });

  await t.test('a broad description returns many candidates for the agent to narrow', async () => {
    const page = await call('search_assets', { query: 'inspection' });
    assert.equal(page.matching, 3);
    assert.deepEqual(ids(page).sort(), [camera.id, microscope.id, sealed.id].sort());
  });

  await t.test('an exact individual identity resolves to exactly one Asset', async () => {
    const lookup = await call('resolve_external_identifier',
      { scheme: 'giai', assetReference: issuedToCamera });
    assert.equal((lookup.identity as Json).level, 'individual');
    assert.equal(lookup.matching, 1);
    assert.deepEqual(ids(lookup), [camera.id]);
  });

  await t.test('a class identity legitimately resolves to several Assets', async () => {
    const lookup = await call('resolve_external_identifier', { scheme: 'gtin', gtin: cameraGtin });
    const identity = lookup.identity as Json;
    assert.equal(identity.level, 'class');
    assert.equal(identity.canonical, canonicalIdentifier({ scheme: 'gtin', gtin: cameraGtin }).canonical);
    assert.equal(lookup.matching, 2);
    assert.deepEqual(ids(lookup).sort(), [camera.id, microscope.id].sort());
  });

  await t.test('an identity nothing carries resolves to nothing', async () => {
    const lookup = await call('resolve_external_identifier',
      { scheme: 'giai', assetReference: gcp + 'NEVER-ISSUED' });
    assert.equal(lookup.matching, 0);
    assert.deepEqual(lookup.assets, []);
    assert.equal((lookup.identity as Json).level, 'individual');
  });

  await t.test('an invalid identity is refused rather than answered emptily', async () => {
    assert.match(await rejects('resolve_external_identifier',
      { scheme: 'gtin', gtin: '04901234567890' }), /./);
    assert.match(await rejects('resolve_external_identifier', { scheme: 'sgtin', gtin: cameraGtin }), /./);
  });

  await t.test('a Group narrows discovery to one team', async () => {
    const { groups } = await call('list_groups') as { groups: { key: string; name: string }[] };
    const named = groups.find((group) => group.name === 'Demo Workshop')!;
    assert.ok(named, 'Demo Workshop must be listed');
    const page = await call('search_assets', { query: 'camera', groupKeys: [named.key] });
    assert.deepEqual(ids(page), [camera.id]);
    assert.ok(!ids(page).includes(sealed.id), 'the other Group\'s camera must not appear');
  });

  await t.test('allocation provenance comes from the ledger, not from the prefix', async () => {
    const { namespaces } = await call('list_giai_namespaces') as { namespaces: Json[] };
    const managed = namespaces.find((entry) => entry.gcp === gcp)!;
    assert.deepEqual((managed.group as Json).name, 'Demo Workshop');

    const ledger = await call('list_giai_issuances', { namespaceKey: managed.namespaceKey as string });
    const issuances = ledger.issuances as Json[];
    assert.equal(ledger.matching, 2);
    assert.deepEqual(issuances.map((issuance) => issuance.assetId), [camera.id, laptop.id]);
    assert.deepEqual(issuances.map((issuance) => (issuance.allocation as Json).value),
      [issuedToCamera, issuedToLaptop]);
    // Exclusions 1-4 were never issuable, so issuance starts at 5.
    assert.deepEqual(issuances.map((issuance) => (issuance.allocation as Json).sequence), [5, 6]);
    assert.equal(issuances[0].stillAttached, true);
    assert.equal(issuances[1].stillAttached, false, 'a detached issuance stays in the ledger');

    // The lookalike is findable by its own identifier and is under the same
    // prefix textually, yet Kannabi never claims to have issued it.
    const resolved = await call('resolve_external_identifier',
      { scheme: 'giai', assetReference: lookalikeReference });
    assert.deepEqual(ids(resolved), [lookalike.id]);
    assert.ok(lookalikeReference.startsWith(gcp));
    assert.ok(!issuances.some((issuance) => issuance.assetId === lookalike.id));
    assert.equal((resolved.assets as Json[])[0].kannabiAllocatedGiai, null);
  });

  await t.test('a namespace Kannabi has never issued from reports no issuances', async () => {
    const ledger = await call('list_giai_issuances', { namespaceKey: unusedNamespace.key });
    assert.deepEqual(ledger.issuances, []);
    assert.equal(ledger.matching, 0);
    assert.equal(ledger.nextCursor, null);
    assert.equal((ledger.namespace as Json).gcp, unusedGcp);
  });

  await t.test('an unknown namespace is refused, and knowing a key grants nothing', async () => {
    assert.match(await rejects('list_giai_issuances', { namespaceKey: 'not-a-namespace' }), /not found/i);
  });

  await t.test('a candidate\'s Asset ID carries into inspection unchanged', async () => {
    const page = await call('search_assets', { query: 'Field laptop' });
    const [candidate] = page.assets as Json[];
    const inspected = await call('get_asset', { assetId: candidate.assetId as string });
    assert.equal(inspected.found, true);
    const detail = inspected.asset as Json;
    assert.equal(detail.assetId, laptop.id);
    assert.equal(detail.name, laptop.name);
    assert.equal((detail.reportedBy as Json).name, 'Alex Demo');
    const identifiers = detail.identifiers as Json[];
    assert.deepEqual(identifiers.map((identifier) => identifier.scheme).sort(), ['gtin', 'sgtin']);
    assert.ok(identifiers.every((identifier) => typeof identifier.gs1PolicyVersion === 'string'));
    // Detached, so the Asset no longer carries the issued value even though the
    // ledger still binds it.
    assert.equal(detail.kannabiAllocatedGiai, issuedToLaptop);
    assert.ok(!identifiers.some((identifier) => identifier.scheme === 'giai'));
  });

  await t.test('an Asset that does not exist is reported as a miss', async () => {
    const missing = await call('get_asset', { assetId: '0198c2a0-0000-7000-8000-0000000000ff' });
    assert.deepEqual(missing, { found: false, asset: null });
    await rejects('get_asset', { assetId: laptop.id.toUpperCase() });
  });

  await t.test('paging traverses a result set exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('search_assets',
        { query: 'inspection', limit: 1, ...(cursor ? { cursor } : {}) });
      assert.ok((page.assets as Json[]).length <= 1);
      seen.push(...ids(page));
      cursor = (page.nextCursor as string | null) ?? undefined;
      assert.ok(seen.length <= 6, 'pagination must terminate');
    } while (cursor);
    assert.deepEqual(seen.sort(), [camera.id, microscope.id, sealed.id].sort());
    assert.equal(new Set(seen).size, seen.length);
    // A cursor is bound to its query, so it cannot be replayed under another.
    const first = await call('search_assets', { query: 'inspection', limit: 1 });
    await rejects('search_assets', { query: 'camera', limit: 1, cursor: first.nextCursor as string });
  });

  await t.test('an identifier from a result resolves again without reformatting', async () => {
    // The dead end this guards: `canonical` is an element string, while the
    // resolve arguments are components. If a result stopped carrying
    // components, an agent could only re-resolve an identity it was just given
    // by making an extra get_asset call to reformat the value.
    const page = await call('search_assets', { query: 'Field laptop' });
    const [candidate] = page.assets as Json[];
    const identifier = (candidate.identifiers as Json[]).find((entry) => entry.scheme === 'gtin')!;
    const again = await call('resolve_external_identifier',
      { scheme: identifier.scheme as string, ...(identifier.components as Json) });
    assert.equal((again.identity as Json).canonical, identifier.canonical);
    assert.ok(ids(again).includes(candidate.assetId as string));
  });

  await t.test('an issued GIAI is reported in the form that resolves it', async () => {
    // kannabiAllocatedGiai and allocation.value are bare AI 8004 references,
    // while canonical is the element string. An agent must be able to take the
    // ledger's value straight back to resolve_external_identifier.
    const { namespaces } = await call('list_giai_namespaces') as { namespaces: Json[] };
    const managed = namespaces.find((entry) => entry.gcp === gcp)!;
    const ledger = await call('list_giai_issuances', { namespaceKey: managed.namespaceKey as string });
    const issued = (ledger.issuances as Json[])[0];
    const resolved = await call('resolve_external_identifier',
      { scheme: 'giai', assetReference: (issued.allocation as Json).value as string });
    assert.deepEqual(ids(resolved), [issued.assetId]);
    assert.equal((resolved.assets as Json[])[0].kannabiAllocatedGiai, (issued.allocation as Json).value);
  });

  await t.test('a valid identifier Kannabi never stored answers empty, not error', async () => {
    // 9780306406157 is a checksum-valid GTIN-13 that no seeded Asset carries.
    const lookup = await call('resolve_external_identifier', { scheme: 'gtin', gtin: '9780306406157' });
    assert.equal(lookup.matching, 0);
    assert.deepEqual(lookup.assets, []);
    assert.equal((lookup.identity as Json).level, 'class');
  });

  await t.test('the server tells a client where Kannabi\'s knowledge stops', () => {
    const stated = client.getInstructions() ?? '';
    assert.ok(stated.includes('does not own'), 'no boundary is stated over the wire');
    assert.match(stated, /storing an identifier is not issuing it/i);
  });

  await t.test('the MCP process reads system-wide, crossing Group readability', async () => {
    // The accepted MVP limitation, asserted rather than implied: Alex is in no
    // Group that collaborates on the sealed Asset and cannot read it, while the
    // MCP process reads it and the Group holding it.
    const alexPage = await store.findAssets(alex.key, assetPageRequest({ q: 'inspection' }));
    assert.ok(!alexPage.assets.some((entry) => entry.id === sealed.id));
    assert.equal(await store.getAsset(sealed.id, alex.key), null);

    const inspected = await call('get_asset', { assetId: sealed.id });
    assert.equal(inspected.found, true);
    assert.equal((inspected.asset as Json).isPublic, false);
    const { groups } = await call('list_groups') as { groups: { name: string }[] };
    assert.ok(groups.some((group) => group.name === 'Private Store'));
  });

  await t.test('nothing the MCP server did changed the database', async () => {
    assert.equal(await fingerprint(), before);
  });
});
