import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp-tools.js';
import {
  PrincipalError, principalAudienceResolver, principalFromMeta, principalMetaKey,
  systemAudienceResolver,
} from './mcp-principal.js';
import { externalIdentityKey, externalPrincipal } from './external-principal.js';
import type { Asset, AssetPage, IdentityStore, ResolvedUser } from './identity-store.js';
import type { NamedAudienceInput } from './asset-audience.js';

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
    async userForExternalIdentity(issuer: string, subject: string): Promise<ResolvedUser | null> {
      calls.push({ issuer, subject });
      return links[externalIdentityKey(issuer, subject)] ?? null;
    },
    async findAssets(audience: NamedAudienceInput): Promise<AssetPage> {
      calls.push({ audience });
      return { assets: [] as Asset[], total: 0, matching: 0,
        scopes: { all: 0, mine: 0, group: 0, public: 0 }, nextCursor: null };
    },
  } as unknown as IdentityStore;
}

const alex: ResolvedUser = Object.freeze({ key: 'user-alex', name: 'Alex Demo' });
const linked = { [externalIdentityKey(idp, 'idp-subject-1')]: alex };

test('an asserted principal is read from the agreed metadata key', async (t) => {
  await t.test('a well-formed assertion normalises', () => {
    const principal = principalFromMeta({ [principalMetaKey]: asserted({ email: 'alex@example.com', client_id: 'c1' }) })!;
    assert.equal(principal.issuer, idp);
    assert.equal(principal.subject, 'idp-subject-1');
    assert.equal(principal.subjectType, 'user');
    assert.deepEqual([...principal.scopes], ['levitate:read']);
    assert.equal(principal.email, 'alex@example.com');
    assert.equal(principal.clientId, 'c1');
  });

  await t.test('absence is not an error, so the mode decides what it means', () => {
    assert.equal(principalFromMeta(undefined), null);
    assert.equal(principalFromMeta({}), null);
    assert.equal(principalFromMeta({ 'unrelated/key': { a: 1 } }), null);
  });

  await t.test('optional fields stay absent rather than becoming empty strings', () => {
    const principal = principalFromMeta({ [principalMetaKey]: asserted() })!;
    assert.equal(principal.email, null);
    assert.equal(principal.clientId, null);
  });

  await t.test('a field added later is ignored, not refused', () => {
    // The assertion is additive by contract; refusing unknown fields would
    // break Kannabi on an upgrade of whatever is in front of it.
    const principal = principalFromMeta({ [principalMetaKey]: asserted({ future_field: 'x' }) })!;
    assert.equal(principal.subject, 'idp-subject-1');
  });

  await t.test('anything malformed is refused rather than partially believed', () => {
    for (const [label, value] of [
      ['not an object', 'principal'],
      ['an array', []],
      ['missing issuer', asserted({ issuer: undefined })],
      ['empty issuer', asserted({ issuer: '   ' })],
      ['missing subject', asserted({ subject: undefined })],
      ['missing subject_type', asserted({ subject_type: undefined })],
      ['missing auth_kind', asserted({ auth_kind: undefined })],
      ['missing asserted_at', asserted({ asserted_at: undefined })],
      ['non-string subject', asserted({ subject: 42 })],
      ['scopes not a list', asserted({ scopes: 'levitate:read' })],
      ['scopes holding a non-string', asserted({ scopes: ['ok', 7] })],
      ['email not a string', asserted({ email: 42 })],
    ] as const) {
      assert.throws(() => principalFromMeta({ [principalMetaKey]: value }), PrincipalError, label);
    }
  });
});

test('identity is the issuer and the subject together', async (t) => {
  await t.test('the key is injective across separator-shaped values', () => {
    // Two different pairs must never collapse onto one key.
    assert.notEqual(externalIdentityKey('a', 'b:c'), externalIdentityKey('a:b', 'c'));
    assert.notEqual(externalIdentityKey('a', '"b"'), externalIdentityKey('a"', 'b'));
    assert.equal(externalIdentityKey(idp, 's'), externalIdentityKey(idp, 's'));
  });

  await t.test('email never participates in the key', () => {
    assert.equal(externalIdentityKey(idp, 's'), externalIdentityKey(idp, 's'));
    const withEmail = externalPrincipal(asserted({ subject: 's', email: 'alex@example.com' }));
    const withoutEmail = externalPrincipal(asserted({ subject: 's' }));
    assert.equal(externalIdentityKey(withEmail.issuer, withEmail.subject),
      externalIdentityKey(withoutEmail.issuer, withoutEmail.subject));
  });

  await t.test('resolution is asked for the issuer and subject only', async () => {
    const calls: unknown[] = [];
    const resolve = principalAudienceResolver(storeWithLink(linked, calls));
    await resolve({ [principalMetaKey]: asserted({ email: 'someone.else@example.com' }) });
    assert.deepEqual(calls[0], { issuer: idp, subject: 'idp-subject-1' });
  });
});

test('an authenticated User acts under their own audience', async (t) => {
  const resolve = principalAudienceResolver(storeWithLink(linked));

  await t.test('a linked user subject resolves to that User', async () => {
    assert.deepEqual(await resolve({ [principalMetaKey]: asserted() }),
      { kind: 'user', actorKey: 'user-alex' });
  });

  await t.test('the same subject from another issuer is a different identity', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ issuer: other }) }),
      PrincipalError, 'a subject string must not be portable between issuers');
  });

  await t.test('an unlinked identity reaches nobody', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ subject: 'stranger' }) }),
      (error: Error) => error instanceof PrincipalError && /not linked to a Kannabi User/.test(error.message));
  });

  await t.test('a matching email does not stand in for a link', async () => {
    // The linked subject carries no email; asserting one must not create a path.
    await assert.rejects(() => resolve({ [principalMetaKey]:
      asserted({ subject: 'stranger', email: 'alex@example.com' }) }), PrincipalError);
  });
});

test('Kannabi refuses to act for anything that is not an identified person', async (t) => {
  const resolve = principalAudienceResolver(storeWithLink(linked));

  await t.test('no assertion at all fails closed', async () => {
    // Whether the gateway refuses an unidentifiable caller itself or forwards
    // the request with nothing attached, this end refuses either way.
    await assert.rejects(() => resolve(undefined), PrincipalError);
    await assert.rejects(() => resolve({}), PrincipalError);
  });

  await t.test('a deployment owner does not acquire a User', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ subject_type: 'owner' }) }),
      (error: Error) => error instanceof PrincipalError && /is not a Kannabi User/.test(error.message));
  });

  await t.test('an owner subject is never even looked up', async () => {
    const calls: unknown[] = [];
    const owned = principalAudienceResolver(storeWithLink(linked, calls));
    await assert.rejects(() => owned({ [principalMetaKey]:
      asserted({ subject_type: 'owner', subject: 'idp-subject-1' }) }), PrincipalError);
    assert.equal(calls.length, 0, 'the subject type is decided before any identity lookup');
  });

  await t.test('an unknown subject type fails closed', async () => {
    for (const subjectType of ['service', 'User', 'USER', 'bot', '']) {
      await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ subject_type: subjectType }) }),
        PrincipalError, `subject_type ${JSON.stringify(subjectType)} must not resolve`);
    }
  });

  await t.test('a malformed assertion fails closed rather than falling back', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: { issuer: idp } }), PrincipalError);
    await assert.rejects(() => resolve({ [principalMetaKey]: 'alex' }), PrincipalError);
  });
});

test('gateway scopes never substitute for a Kannabi decision', async (t) => {
  const resolve = principalAudienceResolver(storeWithLink(linked));

  await t.test('an unlinked identity is refused however broad its scopes', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({
      subject: 'stranger',
      scopes: ['levitate:read', 'levitate:write', 'admin', '*'],
    }) }), PrincipalError);
  });

  await t.test('an owner is refused however broad its scopes', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({
      subject_type: 'owner', scopes: ['admin', '*'],
    }) }), PrincipalError);
  });

  await t.test('no scopes at all is fine for a linked User', async () => {
    assert.deepEqual(await resolve({ [principalMetaKey]: asserted({ scopes: [] }) }),
      { kind: 'user', actorKey: 'user-alex' });
    assert.deepEqual(await resolve({ [principalMetaKey]: asserted({ scopes: undefined }) }),
      { kind: 'user', actorKey: 'user-alex' });
  });
});

/** Connect a client to a server built with the supplied resolver. */
async function connect(store: IdentityStore, resolver = systemAudienceResolver()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'principal-test-client', version: '0.0.0' });
  await Promise.all([
    createMcpServer(store, resolver).connect(serverTransport),
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
      ['list_giai_namespaces', {}],
      ['list_giai_issuances', { namespaceKey: 'n1' }],
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
    assert.equal(tools.length, 6);
    assert.ok(client.getInstructions());
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
