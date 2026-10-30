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
import { assetSemantics, type FieldSemantics } from './asset-semantics.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Legacy records loaded the way a corpus loader loads them, then read back
 * through the HTTP API and MCP and held to what Kannabi says its fields mean.
 *
 * The records are invented and shaped like the ones a decade-old inventory
 * holds: a registration time and a free-text description that dates a
 * purchase, names a supplier without a date, places the thing somewhere
 * without saying when, or recounts a loan. What is asserted is semantic —
 * where each claim ends up and what Kannabi says that place means — rather
 * than the shape of the JSON.
 */

type Json = Record<string, unknown>;

/** Every value at a leaf, with its path, `[]` marking a list element. */
function values(value: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((item) => values(item, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => values(item, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

function governing(surface: 'http' | 'mcp', path: string): FieldSemantics {
  const steps = path.split('.');
  for (let length = steps.length; length > 0; length--) {
    const candidate = steps.slice(0, length).join('.');
    const found = assetSemantics.fields.find((field) =>
      field.paths[surface] === candidate || field.paths[surface] === candidate.replace(/\[\]$/, ''));
    if (found) return found;
  }
  throw new Error(`${surface} ${path} has no stated meaning`);
}

/** Where each fragment of the source's text appears in a representation, and
 * the standing Kannabi states for that place. */
function standingsOf(surface: 'http' | 'mcp', asset: unknown, fragment: string) {
  return values(asset).filter(([, value]) => typeof value === 'string' && value.includes(fragment))
    .map(([path]) => governing(surface, path).standing);
}

/** The instants a representation carries, each with the clock Kannabi states. */
function instants(surface: 'http' | 'mcp', asset: unknown) {
  return values(asset).filter(([, value]) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    .map(([path, value]) => {
      const field = assetSemantics.fields.find((entry) => entry.paths[surface] === path);
      assert.ok(field?.time, `${surface} ${path} is an instant with no stated clock`);
      return { path, value: value as string, clock: field.time.clock };
    });
}

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

    /** One Asset as each surface answers it. */
    async function read(id: string) {
      const response = await browser(`/assets/${id}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Link'), `<${origin}/api/semantics>; rel="describedby"`);
      const http = (await response.json()).asset as Json;
      const result = await client.callTool({ name: 'get_asset', arguments: { assetId: id } }) as {
        structuredContent: { asset: Json } };
      return { http, mcp: result.structuredContent.asset };
    }

    const loadStarted = Date.now();
    const registered = '2016-05-10T10:00:00+09:00';
    const purchased = await load(101, { name: 'Spectrum analyser', sourceRecord: {
      reference: 'legacy:assets:101', recordedAt: registered, recordedBy: 'K. Sato',
      description: 'Purchased from Example Trading on 2015-11-02.\r\nLent to Lab B in 2018, see memo.' } });
    const supplierOnly = await load(102, { name: 'Oscilloscope', sourceRecord: {
      reference: 'legacy:assets:102', recordedAt: '2017-01-20T03:00:00Z',
      description: 'From Example Trading.' } });
    const undated = await load(103, { name: '会議用プロジェクター', sourceRecord: {
      reference: 'legacy:assets:103', description: '402号室に保管\t(棚 B)' } });
    const unattributed = await load(104, { name: 'Bench power supply' });
    const loadEnded = Date.now();
    // An Asset reported in a browser, as every Asset was before attribution
    // existed: no source, no credential, no basis.
    const ordinary = (await (await browser('/assets', 'POST', { groupKey, name: 'Soldering station' })).json())
      .asset as Json;

    await t.test('a source registration time is the source\'s statement, never an acquisition date', async () => {
      const { http } = await read(purchased.id as string);
      const sourceRecord = http.sourceRecord as Json;
      assert.equal(Date.parse(sourceRecord.recordedAt as string), Date.parse(registered));
      const sourced = instants('http', http).filter((entry) => entry.clock === 'source');
      assert.deepEqual(sourced.map((entry) => entry.path), ['sourceRecord.recordedAt']);
      const stated = assetSemantics.fields.find((field) => field.paths.http === 'sourceRecord.recordedAt')!;
      assert.ok(stated.never?.some((reading) => /acquisition/.test(reading)));
    });

    await t.test('the import time is Kannabi\'s record of the import, never a physical event', async () => {
      const { http } = await read(purchased.id as string);
      const reportedAt = Date.parse(http.reportedAt as string);
      assert.ok(reportedAt >= loadStarted - 1000 && reportedAt <= loadEnded + 1000,
        `reportedAt ${http.reportedAt} is not when Kannabi loaded the record`);
      const kannabi = instants('http', http).filter((entry) => entry.clock === 'kannabi');
      assert.ok(kannabi.length >= 2);
      // Every instant on Kannabi's clock is a write in this test run, so none
      // of them can be a date from the source's past.
      for (const entry of kannabi) {
        assert.ok(Date.parse(entry.value) >= loadStarted - 1000, `${entry.path} predates the load`);
      }
      // And it is the only chronology, which a source time never joins.
      assert.equal(assetSemantics.chronology, 'reportedAt');
    });

    await t.test('an acquisition date stated in the evidence stays inside the evidence', async () => {
      const { http, mcp } = await read(purchased.id as string);
      for (const fragment of ['2015-11-02', 'Example Trading']) {
        assert.deepEqual(standingsOf('http', http, fragment), ['quoted'], `${fragment} escaped the quotation`);
        assert.deepEqual(standingsOf('mcp', mcp, fragment), ['quoted'], `${fragment} escaped the quotation`);
      }
      // No instant anywhere is the purchase: Kannabi holds no acquisition date.
      for (const entry of instants('http', http)) assert.doesNotMatch(entry.value, /^2015-11-02/);
      assert.ok(assetSemantics.unheld.some((fact) => fact.fact === 'acquisition'));
    });

    await t.test('a purchase source with no date gains neither a date nor a supplier field', async () => {
      const { http, mcp } = await read(supplierOnly.id as string);
      assert.deepEqual(standingsOf('http', http, 'Example Trading'), ['quoted']);
      assert.deepEqual(standingsOf('mcp', mcp, 'Example Trading'), ['quoted']);
      // The only source instant is the registration; nothing stands in for the
      // purchase the text does not date.
      assert.deepEqual(instants('http', http).filter((entry) => entry.clock === 'source')
        .map((entry) => entry.path), ['sourceRecord.recordedAt']);
    });

    await t.test('an undated description stays undated and is not a current location', async () => {
      const { http, mcp } = await read(undated.id as string);
      const sourceRecord = http.sourceRecord as Json;
      assert.equal(sourceRecord.recordedAt, null);
      assert.equal(sourceRecord.recordedBy, null);
      assert.deepEqual(standingsOf('http', http, '402号室'), ['quoted']);
      assert.deepEqual(standingsOf('mcp', mcp, '402号室'), ['quoted']);
      assert.deepEqual(instants('http', http).filter((entry) => entry.clock === 'source'), []);
      const recordedAt = assetSemantics.fields.find((field) => field.paths.http === 'sourceRecord.recordedAt')!;
      assert.match(recordedAt.absent!, /Never that it was recorded now/);
      assert.ok(assetSemantics.unheld.some((fact) => fact.fact === 'location'));
    });

    await t.test('a historical loan is not custody, and an absent owner is not ownership', async () => {
      const { http, mcp } = await read(purchased.id as string);
      assert.deepEqual(standingsOf('http', http, 'Lent to Lab B'), ['quoted']);
      assert.deepEqual(standingsOf('mcp', mcp, 'Lent to Lab B'), ['quoted']);
      // Nothing from the text became current state: the Groups are the one the
      // loader reported into, and no Owner was taken from anywhere.
      assert.deepEqual((http.groups as Json[]).map((group) => group.key), [groupKey]);
      assert.equal(http.owner, null);
      assert.equal(mcp.owner, null);
      const owner = assetSemantics.fields.find((field) => field.paths.http === 'owner')!;
      assert.match(owner.absent!, /Never that the Asset is unowned/);
      assert.ok(assetSemantics.unheld.some((fact) => fact.fact === 'custody'));
      // The quoted recorder is not the reporter and resolves to nobody.
      assert.equal((http.reportedBy as Json).name, 'operator');
      assert.equal(governing('http', 'sourceRecord.recordedBy').standing, 'quoted');
    });

    await t.test('the source\'s content and its provenance are kept exactly', async () => {
      const { http } = await read(purchased.id as string);
      const sourceRecord = http.sourceRecord as Json;
      assert.equal(sourceRecord.description,
        'Purchased from Example Trading on 2015-11-02.\r\nLent to Lab B in 2018, see memo.');
      assert.equal(sourceRecord.reference, 'legacy:assets:101');
      assert.equal(sourceRecord.recordedBy, 'K. Sato');
      const undatedRead = (await read(undated.id as string)).http.sourceRecord as Json;
      assert.equal(undatedRead.description, '402号室に保管\t(棚 B)');
      // Which credential loaded it and on what basis is Kannabi's record of
      // the write, beside the quotation rather than inside it.
      const provenance = http.provenance as Json;
      assert.deepEqual((provenance.assertedBy as Json).label, 'legacy loader');
      assert.equal(provenance.basis, 'legacy:assets:101');
      assert.equal(governing('http', 'provenance.basis').standing, 'record');
    });

    await t.test('the HTTP API and MCP report the same facts with the same meaning', async () => {
      for (const asset of [purchased, supplierOnly, undated, unattributed, ordinary]) {
        const { http, mcp } = await read(asset.id as string);
        const httpValues = values(http);
        const mcpValues = values(mcp);
        let compared = 0;
        for (const field of assetSemantics.fields) {
          const { http: httpPath, mcp: mcpPath } = field.paths;
          if (!httpPath || !mcpPath) continue;
          const under = (entries: [string, unknown][], prefix: string) => new Map(entries
            .filter(([path]) => path === prefix || path.startsWith(prefix + '.') || path.startsWith(prefix + '[]'))
            .map(([path, value]) => [path.slice(prefix.length), value]));
          const left = under(httpValues, httpPath);
          const right = under(mcpValues, mcpPath);
          for (const [suffix, value] of left) {
            if (!right.has(suffix)) continue;
            assert.deepEqual(right.get(suffix), value, `${httpPath}${suffix} differs between HTTP and MCP`);
            compared++;
          }
        }
        assert.ok(compared > 10, `only ${compared} values were compared`);
        // Each surface's every instant has a clock, so both are self-describing.
        instants('http', http);
        instants('mcp', mcp);
      }
    });

    await t.test('Assets without an attribution read exactly as they always have', async () => {
      for (const asset of [unattributed, ordinary]) {
        const { http } = await read(asset.id as string);
        assert.equal(http.sourceRecord, null);
        assert.equal(http.owner, null);
        assert.deepEqual(instants('http', http).filter((entry) => entry.clock === 'source'), []);
      }
      const { http } = await read(ordinary.id as string);
      assert.equal((http.provenance as Json).basis, null);
      assert.equal((http.provenance as Json).assertedBy, null);
    });

    await t.test('the statement itself is served without signing in', async () => {
      const response = await app.request(origin + '/api/semantics');
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).semantics, JSON.parse(JSON.stringify(assetSemantics)));
    });
  });
