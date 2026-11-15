import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IdentityStore } from './identity-store.js';
import { assetPageRequest } from './asset-page.js';
import { composition } from './test-fixture.js';
const { schemes } = composition;

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

type Json = Record<string, unknown>;
type ToolResult = { structuredContent?: Json; isError?: boolean; content?: { text?: string }[] };

test('the Kannabi MCP server serves Asset discovery over stdio', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver, composition);

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
    identifiers: [{ scheme: 'model', series: 'camera' }, { scheme: 'tag', code: 'T-1' }] }, inWorkshop);
  const microscope = await store.reportAsset({ name: 'Inspection microscope · Studio 011',
    identifiers: [{ scheme: 'model', series: 'camera' }] }, inWorkshop);
  await store.updateAsset(microscope.id, { isPublic: true }, alex.key);
  // Created from a record that already existed elsewhere, so the projection can
  // be read against real stored data rather than a fixture's own shape.
  const quoted = {
    reference: 'legacy:asset:1483',
    recordedAt: '2019-04-12T09:30:00.000Z',
    recordedBy: 'A. Rivera',
  };
  const migrated = await store.reportAsset({ name: 'Calibration rig · Store 042',
    sourceRecord: quoted }, inWorkshop);
  const laptop = await store.reportAsset({ name: 'Field laptop · Shelf 003',
    identifiers: [{ scheme: 'tag', code: 'T-3' }, { scheme: 'model', series: 'laptop' }] }, inWorkshop);
  await store.reportAsset({ name: 'Signal generator · Field 007',
    identifiers: [{ scheme: 'tag', code: 'T-7' }] }, inWorkshop);
  // Private to a Group no browsing User below belongs to.
  const sealed = await store.reportAsset({ name: 'Inspection camera · Vault 900' },
    { actorKey: robin.key, groupKey: vault.key });

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
    // The server process is composed with the fixture plugin, as this test is.
    args: ['--import', 'tsx', '--import', './server/test-composition.mjs', 'server/mcp.ts'],
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
    (page[field] as Json[]).map((entry) => entry.id as string);

  await t.test('the transport completes initialize and tool discovery', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
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
      { scheme: 'tag', code: 'T-1' });
    assert.equal((lookup.identity as Json).level, 'individual');
    assert.equal(lookup.matching, 1);
    assert.deepEqual(ids(lookup), [camera.id]);
  });

  await t.test('a class identity legitimately resolves to several Assets', async () => {
    const lookup = await call('resolve_external_identifier', { scheme: 'model', series: 'camera' });
    const identity = lookup.identity as Json;
    assert.equal(identity.level, 'class');
    assert.equal(identity.canonical, 'model:camera');
    assert.equal(lookup.matching, 2);
    assert.deepEqual(ids(lookup).sort(), [camera.id, microscope.id].sort());
  });

  await t.test('an identity nothing carries resolves to nothing', async () => {
    const lookup = await call('resolve_external_identifier',
      { scheme: 'tag', code: 'T-404' });
    assert.equal(lookup.matching, 0);
    assert.deepEqual(lookup.assets, []);
    assert.equal((lookup.identity as Json).level, 'individual');
  });

  await t.test('an invalid identity is refused rather than answered emptily', async () => {
    assert.match(await rejects('resolve_external_identifier',
      { scheme: 'model', series: 'Not A Model' }), /./);
    assert.match(await rejects('resolve_external_identifier', { scheme: 'tag' }), /./);
  });

  await t.test('a Group narrows discovery to one team', async () => {
    const { groups } = await call('list_groups') as { groups: { key: string; name: string }[] };
    const named = groups.find((group) => group.name === 'Demo Workshop')!;
    assert.ok(named, 'Demo Workshop must be listed');
    const page = await call('search_assets', { query: 'camera', groupKeys: [named.key] });
    assert.deepEqual(ids(page), [camera.id]);
    assert.ok(!ids(page).includes(sealed.id), 'the other Group\'s camera must not appear');
  });

  await t.test('a candidate\'s Asset ID carries into inspection unchanged', async () => {
    const page = await call('search_assets', { query: 'Field laptop' });
    const [candidate] = page.assets as Json[];
    const inspected = await call('get_asset', { assetId: candidate.id as string });
    assert.equal(inspected.found, true);
    const record = inspected.asset as Json;
    const kannabi = record.kannabi as Json;
    assert.equal(record.id, laptop.id);
    assert.equal(kannabi.name, laptop.name);
    assert.equal(((kannabi.reported as Json).by as Json).name, 'Alex Demo');
    const identifiers = record.identifiers as Json[];
    assert.deepEqual(identifiers.map((identifier) => identifier.scheme).sort(), ['model', 'tag']);
    assert.ok(identifiers.every((identifier) => typeof (identifier.accepted as Json).policy === 'string'));
    // The fixture plugin states nothing about an Asset, so it has no section.
    assert.deepEqual(record.extensions, {});
  });

  await t.test('an Asset quoted from an earlier system reaches an agent as quoted evidence', async () => {
    const inspected = await call('get_asset', { assetId: migrated.id });
    const record = inspected.asset as Json;
    const source = record.source as Json;
    const says = source.says as Json;
    const reported = (record.kannabi as Json).reported as Json;
    assert.equal(source.reference, quoted.reference);
    assert.equal(says.recordedBy, quoted.recordedBy);
    assert.equal(Date.parse(says.recordedAt as string), Date.parse(quoted.recordedAt));

    // Kannabi's own record of the same Asset stays separate and stays its own:
    // it learned of this Asset now, from a Kannabi User, years after the date
    // the source states.
    assert.equal((reported.by as Json).name, 'Alex Demo');
    assert.notEqual(reported.at, says.recordedAt);
    assert.ok(Date.parse(reported.at as string) > Date.parse(quoted.recordedAt));

    // An Asset that originated in Kannabi says so rather than omitting it.
    const native = await call('get_asset', { assetId: camera.id });
    assert.equal((native.asset as Json).source, null);

    // Quoted evidence is not a discovery key: the name is not searchable, and
    // a search for it finds nothing rather than the Asset that quotes it.
    const searched = await call('search_assets', { query: quoted.recordedBy });
    assert.equal((searched.assets as Json[]).length, 0,
      'a quoted recorder must not be matchable text');
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
    const identifier = (candidate.identifiers as Json[]).find((entry) => entry.scheme === 'model')!;
    const again = await call('resolve_external_identifier',
      { scheme: identifier.scheme as string, ...(identifier.components as Json) });
    assert.equal((again.identity as Json).canonical, identifier.value);
    assert.ok(ids(again).includes(candidate.id as string));
  });

  await t.test('a valid identifier Kannabi never stored answers empty, not error', async () => {
    // A well-formed model that no seeded Asset carries.
    const lookup = await call('resolve_external_identifier', { scheme: 'model', series: 'unseen' });
    assert.equal(lookup.matching, 0);
    assert.deepEqual(lookup.assets, []);
    assert.equal((lookup.identity as Json).level, 'class');
  });

  await t.test('the server tells a client where Kannabi\'s knowledge stops', () => {
    const stated = client.getInstructions() ?? '';
    assert.ok(stated.includes('does not own'), 'no boundary is stated over the wire');
    assert.match(stated, /records identifiers and issues none/i);
  });

  await t.test('the MCP process reads system-wide, crossing Group readability', async () => {
    // The accepted MVP limitation, asserted rather than implied: Alex is in no
    // Group that collaborates on the sealed Asset and cannot read it, while the
    // MCP process reads it and the Group holding it.
    const alexPage = await store.findAssets(alex.key, assetPageRequest({ q: 'inspection' }, schemes.ids));
    assert.ok(!alexPage.assets.some((entry) => entry.id === sealed.id));
    assert.equal(await store.getAsset(sealed.id, alex.key), null);

    const inspected = await call('get_asset', { assetId: sealed.id });
    assert.equal(inspected.found, true);
    assert.equal(((inspected.asset as Json).kannabi as Json).public, false);
    const { groups } = await call('list_groups') as { groups: { name: string }[] };
    assert.ok(groups.some((group) => group.name === 'Private Store'));
  });

  await t.test('nothing the MCP server did changed the database', async () => {
    assert.equal(await fingerprint(), before);
  });
});
