import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DuplicateIdentityError, IdentityStore } from './identity-store.js';
import { assetPageRequest } from './asset-page.js';
import { PrincipalError, principalAudienceResolver, principalMetaKey } from './mcp-principal.js';
import { systemAudience } from './asset-audience.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

const idp = 'https://idp.example.com';
const other = 'https://other-idp.example.com';
type Json = Record<string, unknown>;

function asserted(overrides: Record<string, unknown> = {}) {
  return { issuer: idp, subject: 'subject-alex', subject_type: 'user', auth_kind: 'oidc',
    scopes: ['levitate:read'], asserted_at: '2026-09-22T00:00:00.000Z', ...overrides };
}

test('MCP operations run under an authenticated Kannabi principal', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  async function query(cypher: string, params: Record<string, unknown> = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }

  const alex = await store.createUser('Alex Demo');
  const robin = await store.createUser('Robin Demo');
  const workshop = await store.createReportingGroup('Demo Workshop', alex.key);
  const vault = await store.createReportingGroup('Private Store', robin.key);
  await query('MATCH (u:User {key: $key}) SET u.email = $email', { key: alex.key, email: 'alex@example.com' });

  const inWorkshop = await store.reportAsset({ name: 'Inspection camera · Bench 001' },
    { actorKey: alex.key, groupKey: workshop.key });
  const sealed = await store.reportAsset({ name: 'Inspection camera · Vault 900' },
    { actorKey: robin.key, groupKey: vault.key });
  const shared = await store.reportAsset({ name: 'Inspection camera · Public 500' },
    { actorKey: robin.key, groupKey: vault.key });
  await store.updateAsset(shared.id, { isPublic: true }, robin.key);

  await store.linkExternalIdentity(alex.key, idp, 'subject-alex');
  const resolve = principalAudienceResolver(store);
  const readable = async (meta: Json) =>
    (await store.findAssets(await resolve(meta), assetPageRequest({ q: 'camera' })))
      .assets.map((asset) => asset.id).sort();

  await t.test('a linked identity sees exactly what that User may see', async () => {
    const seen = await readable({ [principalMetaKey]: asserted() });
    // Their own Group, plus the public Asset. Never the sealed one.
    assert.deepEqual(seen, [inWorkshop.id, shared.id].sort());
    assert.ok(!seen.includes(sealed.id));
  });

  await t.test('the same view the web application would give that User', async () => {
    const throughTheApp = (await store.findAssets(alex.key, assetPageRequest({ q: 'camera' })))
      .assets.map((asset) => asset.id).sort();
    assert.deepEqual(await readable({ [principalMetaKey]: asserted() }), throughTheApp);
  });

  await t.test('narrower than the trusted-local process, which still sees everything', async () => {
    const everything = (await store.findAssets(systemAudience, assetPageRequest({ q: 'camera' })))
      .assets.map((asset) => asset.id).sort();
    assert.deepEqual(everything, [inWorkshop.id, sealed.id, shared.id].sort());
  });

  await t.test('Groups narrow to the authenticated User', async () => {
    const groups = await store.listGroups(await resolve({ [principalMetaKey]: asserted() }));
    assert.deepEqual(groups.map((group) => group.name), ['Demo Workshop']);
  });

  await t.test('the same subject from another issuer is a different person', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ issuer: other }) }), PrincipalError);
    // And linking it elsewhere keeps the two apart.
    await store.linkExternalIdentity(robin.key, other, 'subject-alex');
    const groups = await store.listGroups(await resolve({ [principalMetaKey]: asserted({ issuer: other }) }));
    assert.deepEqual(groups.map((group) => group.name), ['Private Store']);
  });

  await t.test('an email that matches an account is not a link', async () => {
    await assert.rejects(() => resolve({ [principalMetaKey]:
      asserted({ subject: 'unlinked-subject', email: 'alex@example.com' }) }), PrincipalError);
    const stored = await query('MATCH (:ExternalIdentity)<-[:HAS_EXTERNAL_IDENTITY]-(u:User) RETURN count(*) AS n');
    assert.equal(stored.records[0].get('n').toNumber(), 2, 'a refused lookup creates nothing');
  });

  await t.test('one external identity belongs to one User', async () => {
    await assert.rejects(() => store.linkExternalIdentity(robin.key, idp, 'subject-alex'),
      DuplicateIdentityError);
    // Re-linking the same pair to the same User stays idempotent.
    const again = await store.linkExternalIdentity(alex.key, idp, 'subject-alex');
    assert.equal(again.key, alex.key);
  });

  await t.test('a tombstoned account resolves to nobody', async () => {
    const ghost = await store.createUser('Ghost Demo');
    await store.linkExternalIdentity(ghost.key, idp, 'subject-ghost');
    assert.ok(await store.userForExternalIdentity(idp, 'subject-ghost'));
    await query('MATCH (u:User {key: $key}) SET u.accountDeletedAt = datetime()', { key: ghost.key });
    assert.equal(await store.userForExternalIdentity(idp, 'subject-ghost'), null);
    await assert.rejects(() => resolve({ [principalMetaKey]: asserted({ subject: 'subject-ghost' }) }),
      PrincipalError);
  });

  await t.test('a banned account resolves to nobody', async () => {
    // The web application refuses to act for this person; an interface with no
    // session must not become the way around that.
    const barred = await store.createUser('Barred Demo');
    await store.linkExternalIdentity(barred.key, idp, 'subject-barred');
    assert.ok(await store.userForExternalIdentity(idp, 'subject-barred'));
    await query('MATCH (u:User {key: $key}) SET u.banned = true', { key: barred.key });
    assert.equal(await store.userForExternalIdentity(idp, 'subject-barred'), null);
  });

  await t.test('an unknown subject type never reaches a lookup', async () => {
    for (const subjectType of ['owner', 'service', 'USER']) {
      await assert.rejects(() => resolve({ [principalMetaKey]:
        asserted({ subject_type: subjectType }) }), PrincipalError, subjectType);
    }
  });

  // The whole path, as a host runs it: a child process in principal mode.
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'server/mcp.ts'],
    env: { ...environment, NEO4J_URI: uri!, NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: password!,
      KANNABI_MCP_AUDIENCE: 'principal' },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'principal-integration-client', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const call = async (name: string, args: Json = {}, meta?: Json) =>
    await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) as
      { structuredContent?: Json; isError?: boolean; content?: { text?: string }[] };

  await t.test('the server announces the mode it is running in', () => {
    assert.match(stderr.join(''), /per-User access for the asserted principal/);
  });

  await t.test('over stdio, a linked User sees only their own Assets', async () => {
    const response = await call('search_assets', { query: 'camera' }, { [principalMetaKey]: asserted() });
    assert.ok(!response.isError, response.content?.[0]?.text);
    const ids = (response.structuredContent!.assets as Json[]).map((asset) => asset.assetId);
    assert.deepEqual([...ids].sort(), [inWorkshop.id, shared.id].sort());
  });

  await t.test('over stdio, a request without a principal is refused', async () => {
    const response = await call('search_assets', { query: 'camera' });
    assert.equal(response.isError, true);
    assert.match(response.content?.[0]?.text ?? '', /no principal was asserted/);
  });

  await t.test('over stdio, an owner assertion gains nothing', async () => {
    const response = await call('search_assets', { query: 'camera' },
      { [principalMetaKey]: asserted({ subject_type: 'owner', scopes: ['admin', '*'] }) });
    assert.equal(response.isError, true);
    assert.match(response.content?.[0]?.text ?? '', /is not a Kannabi User/);
  });

  await t.test('over stdio, an unauthorized Asset is indistinguishable from a missing one', async () => {
    const response = await call('get_asset', { assetId: sealed.id }, { [principalMetaKey]: asserted() });
    assert.ok(!response.isError);
    assert.deepEqual(response.structuredContent, { found: false, asset: null });
  });
});
