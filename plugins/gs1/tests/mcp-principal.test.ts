import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../../../server/mcp-tools.js';
import { noPlugins } from '../../../server/plugin.js';
import { gs1Mcp } from '../adapter/mcp.js';
import type { Gs1Store } from '../adapter/store.js';
import {
  PrincipalError, principalAudienceResolver, principalFromMeta, principalMetaKey,
  systemAudienceResolver,
} from '../../../server/mcp-principal.js';
import { externalIdentityKey, externalPrincipal } from '../../../server/external-principal.js';
import type { Asset, AssetPage, IdentityStore, ResolvedUser } from '../../../server/identity-store.js';
import type { NamedAudienceInput } from '../../../server/asset-audience.js';
import { composition } from '../testing.js';
const { schemes } = composition;

/** The gateway contract, exercised without a database: what Kannabi accepts as
 * an asserted principal, who it resolves to, and what it refuses. The real
 * Group narrowing is covered by `mcp-principal.integration.test.ts`. */

const idp = 'https://idp.example.com';
const other = 'https://other-idp.example.com';

/** A principal in the shape the gateway emits, on the wire. */
function asserted(overrides: Record<string, unknown> = {}) {
  return {
    issuer: idp,
    subject: 'idp-subject-1',
    subject_type: 'user',
    auth_kind: 'oidc',
    scopes: ['levitate:read'],
    asserted_at: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** Links exactly one external identity, so anything else resolves to nobody. */
function storeWithLink(links: Record<string, ResolvedUser>, calls: unknown[] = []) {
  return {
    schemes,
    async userForExternalIdentity(issuer: string, subject: string): Promise<ResolvedUser | null> {
      calls.push({ issuer, subject });
      return links[externalIdentityKey(issuer, subject)] ?? null;
    },
    async findAssets(audience: NamedAudienceInput): Promise<AssetPage> {
      calls.push({ audience });
      return { assets: [] as Asset[], matchedFields: {}, total: 0, matching: 0,
        scopes: { all: 0, mine: 0, group: 0, public: 0 }, nextCursor: null };
    },
  } as unknown as IdentityStore;
}

const alex: ResolvedUser = Object.freeze({ key: 'user-alex', name: 'Alex Demo' });
const linked = { [externalIdentityKey(idp, 'idp-subject-1')]: alex };






/** Connect a client to a server built with the supplied resolver. */
async function connect(store: IdentityStore, resolver = systemAudienceResolver()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'principal-test-client', version: '0.0.0' });
  await Promise.all([
    createMcpServer(store, resolver, { ...noPlugins, mcp: [gs1Mcp(store as unknown as Gs1Store)] })
      .connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

test('the audience a tool runs under follows the request', async (t) => {
  await t.test('a principal-mode server narrows to the asserted User', async () => {
    const calls: unknown[] = [];
    const client = await connect(storeWithLink(linked, calls), principalAudienceResolver(storeWithLink(linked, calls)));
    t.after(() => client.close());
    const response = await client.callTool({ name: 'search_assets', arguments: {},
      _meta: { [principalMetaKey]: asserted() } }) as { isError?: boolean };
    assert.ok(!response.isError, 'a linked User may search');
    assert.deepEqual(calls.at(-1), { audience: { kind: 'user', actorKey: 'user-alex' } });
  });

  await t.test('a principal-mode server refuses a request carrying no principal', async () => {
    const calls: unknown[] = [];
    const client = await connect(storeWithLink(linked), principalAudienceResolver(storeWithLink(linked, calls)));
    t.after(() => client.close());
    for (const [name, args] of [
      ['search_assets', {}],
      ['get_asset', { assetId: '0198c2a0-0000-7000-8000-000000000001' }],
      ['resolve_external_identifier', { scheme: 'gtin', gtin: '04901234567894' }],
      ['list_groups', {}],
      ['list_gs1_namespaces', {}],
      ['list_managed_class_keys', { namespaceKey: 'n1' }],
      ['list_gs1_issuances', { namespaceKey: 'n1' }],
    ] as const) {
      const response = await client.callTool({ name, arguments: args }) as
        { isError?: boolean; content?: { text?: string }[] };
      assert.equal(response.isError, true, `${name} must refuse without a principal`);
      assert.match(response.content?.[0]?.text ?? '', /no principal was asserted/);
    }
    assert.equal(calls.length, 0, 'no tool reached the store without a principal');
  });

  await t.test('discovery stays open, because a tool list grants nothing', async () => {
    // The principal decides what a call may read, not whether the interface
    // can be described. Refusing tools/list would leave a client unable to
    // learn what it should assert.
    const client = await connect(storeWithLink(linked), principalAudienceResolver(storeWithLink(linked)));
    t.after(() => client.close());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    // What it is told matches how it is read: a server answering for one User
    // must not claim the whole instance, or an empty scoped result would be
    // reported as instance-wide absence.
    const stated = client.getInstructions() ?? '';
    assert.match(stated, /only what that User may read/);
    assert.doesNotMatch(stated, /whole instance/);
    assert.ok(stated.includes('does not own'), 'the knowledge boundary is stated in either posture');
  });

  await t.test('a system-mode server is unchanged by a principal it never asked for', async () => {
    const calls: unknown[] = [];
    const client = await connect(storeWithLink(linked, calls));
    t.after(() => client.close());
    await client.callTool({ name: 'search_assets', arguments: {} });
    assert.deepEqual(calls.at(-1), { audience: { kind: 'system' } });
    // An asserted principal must not silently narrow a trusted local process,
    // or the presence of a header would decide how much a caller sees.
    await client.callTool({ name: 'search_assets', arguments: {},
      _meta: { [principalMetaKey]: asserted() } });
    assert.deepEqual(calls.at(-1), { audience: { kind: 'system' } });
    // Nor may a malformed one break it.
    const response = await client.callTool({ name: 'search_assets', arguments: {},
      _meta: { [principalMetaKey]: 'nonsense' } }) as { isError?: boolean };
    assert.ok(!response.isError, 'system mode does not read the assertion at all');
  });
});
