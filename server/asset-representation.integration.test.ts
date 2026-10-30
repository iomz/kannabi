import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { admitSignups } from './test-admission.js';
import { createInventoryApi } from './inventory-api.js';
import { ApiTokenService } from './api-token.js';
import { createMcpServer } from './mcp-tools.js';
import { systemAudienceResolver } from './mcp-principal.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Legacy records loaded the way a corpus loader loads them, then read back
 * through the HTTP API's structured representation and through MCP.
 *
 * The records are invented and shaped like those a decade-old inventory holds:
 * a registration time and a description that dates a purchase, names a
 * supplier without a date, places the thing somewhere without saying when, or
 * recounts a loan. What is asserted is where each claim ends up — under
 * Kannabi's own section, under what the source says, or nowhere — because
 * that placement is the whole of what the representation means.
 */

type Json = Record<string, any>;

function leaves(value: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}
/** Every path at which some fragment of text appears. */
const where = (record: unknown, fragment: string) => leaves(record)
  .filter(([, value]) => typeof value === 'string' && value.includes(fragment)).map(([path]) => path);
const instants = (record: unknown) => leaves(record)
  .filter(([, value]) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) as [string, string][];

test('legacy records keep what the source said apart from what Kannabi knows',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const session = driver.session();
    await session.run("MERGE (s:Settings {key: 'instance'}) SET s.requirePhoto = false, s.revision = 0");
    await session.close();
    const store = await IdentityStore.open(driver);
    await admitSignups(driver);
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, undefined,
      new ApiTokenService(auth, store)));

    const signup = await app.request(origin + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': '192.0.2.1' },
      body: JSON.stringify({ name: 'operator', email: `operator-${randomUUID()}@example.com`,
        password: 'test-password-12345' }),
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const browser = (path: string, method = 'GET', body?: unknown) => app.request(origin + '/api' + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': '192.0.2.1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const groupKey = (await (await browser('/groups', 'POST', { name: 'Lab ' + randomUUID() })).json()).group.key;
    const { secret } = await (await browser('/api-tokens', 'POST', { label: 'legacy loader', lifetimeDays: 1 })).json();

    /** The loader: a bearer credential and one basis per source row. */
    const load = async (row: number, body: Json) => {
      const response = await app.request(origin + '/api/assets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json',
          'x-kannabi-client-ip': '192.0.2.200', 'X-Kannabi-Basis': `legacy:assets:${row}` },
        body: JSON.stringify({ groupKey, ...body }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).asset as Json;
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'kannabi-test-client', version: '0.0.0' });
    await Promise.all([createMcpServer(store, systemAudienceResolver()).connect(serverTransport),
      client.connect(clientTransport)]);
    t.after(() => client.close());
    const tool = async (name: string, args: Json) =>
      ((await client.callTool({ name, arguments: args })) as { structuredContent: Json }).structuredContent;

    /** One Asset as each surface answers it. */
    async function read(id: string) {
      const response = await browser(`/v2/assets/${id}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.representation, 2);
      const mcp = (await tool('get_asset', { assetId: id })).asset as Json;
      assert.deepEqual(mcp, body.asset, 'HTTP and MCP answer with different records');
      return body.asset as Json;
    }

    const loadStarted = Date.now();
    const registered = '2016-05-10T10:00:00+09:00';
    const purchasedText = 'Purchased from Example Trading on 2015-11-02.\r\nLent to Lab B in 2018, see memo.';
    const purchased = await load(101, { name: 'Spectrum analyser', sourceRecord: {
      reference: 'legacy:assets:101', recordedAt: registered, recordedBy: 'K. Sato', description: purchasedText } });
    const supplierOnly = await load(102, { name: 'Oscilloscope', sourceRecord: {
      reference: 'legacy:assets:102', recordedAt: '2017-01-20T03:00:00Z', description: 'From Example Trading.' } });
    const undated = await load(103, { name: '会議用プロジェクター', sourceRecord: {
      reference: 'legacy:assets:103', description: '402号室に保管\t(棚 B)' } });
    const unattributed = await load(104, { name: 'Bench power supply' });
    const loadEnded = Date.now();
    // Reported in a browser, as every Asset was before attribution existed.
    const ordinary = (await (await browser('/assets', 'POST', { groupKey, name: 'Soldering station' })).json())
      .asset as Json;

    await t.test('a source registration time is only what the source says', async () => {
      const record = await read(purchased.id);
      assert.equal(Date.parse(record.source.says.recordedAt), Date.parse(registered));
      const sourced = instants(record).filter(([, value]) => Date.parse(value) === Date.parse(registered));
      assert.deepEqual(sourced.map(([path]) => path), ['source.says.recordedAt']);
    });

    await t.test('the import time is Kannabi\'s record of the import', async () => {
      const record = await read(purchased.id);
      const reportedAt = Date.parse(record.kannabi.reported.at);
      assert.ok(reportedAt >= loadStarted - 1000 && reportedAt <= loadEnded + 1000,
        `kannabi.reported.at ${record.kannabi.reported.at} is not when Kannabi loaded the record`);
      // Every instant outside source.says is a write during this test, so none
      // can be a date from the source's past dressed as Kannabi's own.
      for (const [path, value] of instants(record)) {
        if (path.startsWith('source.')) continue;
        assert.ok(path.startsWith('kannabi.') || path.startsWith('identifiers[].accepted.'), path);
        assert.ok(Date.parse(value) >= loadStarted - 1000, `${path} predates the load`);
      }
      // The loader's credential and basis are Kannabi's record of the write.
      assert.equal(record.kannabi.lastChange.via.label, 'legacy loader');
      assert.equal(record.kannabi.lastChange.basis, 'legacy:assets:101');
    });

    await t.test('an acquisition date in the evidence stays inside the evidence', async () => {
      const record = await read(purchased.id);
      for (const fragment of ['2015-11-02', 'Example Trading']) {
        assert.deepEqual(where(record, fragment), ['source.says.description'], `${fragment} escaped the quotation`);
      }
      assert.ok(!instants(record).some(([, value]) => value.startsWith('2015-11-02')));
      assert.ok(record.notRecorded.includes('acquisition'));
    });

    await t.test('a purchase source with no date gains neither a date nor a supplier', async () => {
      const record = await read(supplierOnly.id);
      assert.deepEqual(where(record, 'Example Trading'), ['source.says.description']);
      assert.deepEqual(instants(record).filter(([path]) => path.startsWith('source.')).map(([path]) => path),
        ['source.says.recordedAt']);
    });

    await t.test('an undated description stays undated and is not a location', async () => {
      const record = await read(undated.id);
      assert.deepEqual(record.source.says, { recordedAt: null, recordedBy: null, description: '402号室に保管\t(棚 B)' });
      assert.deepEqual(where(record, '402号室'), ['source.says.description']);
      assert.ok(record.notRecorded.includes('location'));
    });

    await t.test('a historical loan is not custody, and an absent owner is not ownership', async () => {
      const record = await read(purchased.id);
      assert.deepEqual(where(record, 'Lent to Lab B'), ['source.says.description']);
      // Nothing from the text became Kannabi's: the Groups are the one the
      // loader reported into, no Owner was taken from anywhere, and the
      // source's recorder is not the reporter.
      assert.deepEqual(record.kannabi.groups.map((group: Json) => group.key), [groupKey]);
      assert.equal(record.kannabi.owner, null);
      assert.equal(record.kannabi.reported.by.name, 'operator');
      assert.deepEqual(where(record, 'K. Sato'), ['source.says.recordedBy']);
      for (const fact of ['custody', 'ownership history']) assert.ok(record.notRecorded.includes(fact));
    });

    await t.test('the source\'s content is kept exactly', async () => {
      assert.equal((await read(purchased.id)).source.says.description, purchasedText);
      assert.equal((await read(purchased.id)).source.reference, 'legacy:assets:101');
    });

    await t.test('search returns summaries that point at the full record', async () => {
      const response = await browser('/v2/assets?q=Example%20Trading');
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.ok(page.omitted.includes('source.says'));
      assert.deepEqual(page.assets.map((asset: Json) => asset.id).sort(), [purchased.id, supplierOnly.id].sort());
      for (const asset of page.assets) {
        // The match is in quoted text, and the summary says where without
        // carrying the text as if it were the Asset's own.
        assert.deepEqual(asset.matched, ['source.says.description']);
        assert.equal(asset.source.says, undefined);
      }
      const mcp = await tool('search_assets', { query: 'Example Trading' });
      assert.deepEqual(mcp.assets, page.assets);
      assert.deepEqual(mcp.omitted, page.omitted);
    });

    await t.test('Assets without an attribution read with explicit nulls', async () => {
      for (const asset of [unattributed, ordinary]) {
        const record = await read(asset.id);
        assert.equal(record.source, null);
        assert.equal(record.kannabi.owner, null);
        assert.ok(!instants(record).some(([path]) => path.startsWith('source.')));
      }
      const record = await read(ordinary.id);
      assert.equal(record.kannabi.lastChange.via, null);
      assert.equal(record.kannabi.lastChange.basis, null);
    });

    await t.test('the first representation is unchanged for existing clients', async () => {
      const { asset } = await (await browser(`/assets/${purchased.id}`)).json();
      assert.equal(asset.sourceRecord.description, purchasedText);
      assert.equal(asset.reportedAt, purchased.reportedAt);
      assert.equal(asset.kannabi, undefined);
    });
  });
