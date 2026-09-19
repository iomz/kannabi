import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('local authentication and Group authorization', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const secret = randomUUID() + randomUUID();
  const auth = await createAuth(driver, origin, secret);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin));
  const userPassword = 'A-test-password-' + randomUUID();
  let clientNumber = 0;
  function client() {
    const peer = `192.0.2.${++clientNumber}`;
    let cookie = '';
    return {
      cookie: () => cookie,
      async request(path: string, method = 'GET', body?: unknown, requestOrigin = origin) {
        const response = await app.request(origin + '/api' + path, {
          method, headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json', 'x-kannabi-client-ip': peer },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
        return response;
      },
    };
  }
  const reporter = client();
  const member = client();
  const stranger = client();
  const anonymous = client();
  const people: { key: string; name: string }[] = [];

  await t.test('signup persists credentials and binds sessions to existing User model', async () => {
    for (const [i, caller] of [reporter, member, stranger].entries()) {
      const response = await caller.request('/auth/sign-up/email', 'POST', {
        name: `Person ${i}`, email: `person${i}@example.com`, password: userPassword,
      });
      assert.equal(response.status, 200, await response.clone().text());
      const me = await caller.request('/me');
      const { user } = await me.json();
      assert.ok(user.key && user.key !== 'forged');
      people.push(user);
    }
    assert.deepEqual(await (await reporter.request('/assets')).json(), { assets: [], total: 0, matching: 0, scopes: { all: 0, mine: 0, group: 0, public: 0 }, nextCursor: null });
    const session = driver.session();
    try {
      const result = await session.run(`MATCH (u:User), (a:AuthAccount {userId: u.id})
        RETURN u.key AS key, a.password AS password`);
      assert.equal(result.records.length, 3);
      for (const row of result.records) {
        assert.ok(people.some((u) => u.key === row.get('key')));
        assert.notEqual(row.get('password'), userPassword);
        assert.ok(row.get('password').length > 30);
      }
    } finally { await session.close(); }
    const duplicate = await client().request('/auth/sign-up/email', 'POST', {
      name: 'Duplicate', email: 'person0@example.com', password: userPassword,
    });
    assert.notEqual(duplicate.status, 200);
    const forged = await client().request('/auth/sign-up/email', 'POST', {
      name: 'Forged key', email: 'forged@example.com', password: userPassword, key: people[0].key,
    });
    assert.equal(forged.status, 400);
  });

  await t.test('signout revokes session; incorrect password fails; correct password restores identity', async () => {
    const oldCookie = reporter.cookie();
    assert.equal((await reporter.request('/auth/sign-out', 'POST', {})).status, 200);
    assert.equal((await (await reporter.request('/me')).json()).user, null);
    const replay = await app.request(origin + '/api/me', { headers: { Cookie: oldCookie } });
    assert.equal((await replay.json()).user, null);
    const bad = await reporter.request('/auth/sign-in/email', 'POST', { email: 'person0@example.com', password: 'wrong-password' });
    assert.notEqual(bad.status, 200);
    const good = await reporter.request('/auth/sign-in/email', 'POST', { email: 'person0@example.com', password: userPassword });
    assert.equal(good.status, 200, await good.clone().text());
    assert.deepEqual((await (await reporter.request('/me')).json()).user, people[0]);
    // A new library instance reads the persisted session, not process-local state.
    const reopened = await createAuth(driver, origin, secret);
    assert.equal((await reopened.api.getSession({ headers: new Headers({ Cookie: reporter.cookie() }) }))?.user.key, people[0].key);
  });

  let groupKey: string;
  const identifier = { scheme: 'sgtin', gtin: '00614141123452', serial: '001/a%?' };
  const query = new URLSearchParams(identifier).toString();
  let reportedAt: string;
  await t.test('create Group, add member, report in explicit context', async () => {
    const created = await reporter.request('/groups', 'POST', { name: 'Team' });
    assert.equal(created.status, 201);
    groupKey = (await created.json()).group.key;
    const added = await reporter.request(`/groups/${groupKey}/members`, 'POST', { userKey: people[1].key });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).added, true);
    const existing = await reporter.request(`/groups/${groupKey}/members`, 'POST', { userKey: people[1].key });
    assert.equal(existing.status, 200);
    assert.equal((await existing.json()).added, false);
    assert.equal((await stranger.request(`/groups/${groupKey}/members`, 'POST', { userKey: people[2].key })).status, 404);
    const input = { name: 'Oscilloscope', identifiers: [identifier], groupKey };
    assert.equal((await stranger.request('/assets', 'POST', input)).status, 404);
    assert.equal((await reporter.request('/assets', 'POST', { ...input, groupKey: undefined })).status, 400);
    const reported = await reporter.request('/assets', 'POST', input);
    assert.equal(reported.status, 201, await reported.clone().text());
    const { asset } = await reported.json();
    assert.deepEqual(asset.reportedBy, { ...people[0], status: 'active' });
    assert.equal(asset.groups[0].key, groupKey);
    assert.equal(asset.isPublic, false);
    reportedAt = asset.reportedAt;
  });

  await t.test('member reads and edits private Asset; unrelated and anonymous callers cannot', async () => {
    const read = await member.request('/asset?' + query);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).canEdit, true);
    assert.equal((await member.request('/asset?' + query, 'PATCH', { name: 'Bench instrument' })).status, 200);
    for (const [caller, editStatus] of [[stranger, 404], [anonymous, 401]] as const) {
      const inaccessible = await caller.request('/asset?' + query);
      const missing = await caller.request('/asset?' + new URLSearchParams({ ...identifier, serial: 'missing' }));
      assert.equal(inaccessible.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(await inaccessible.json(), await missing.json());
      assert.equal((await caller.request('/asset?' + query, 'PATCH', { name: 'Denied' })).status, editStatus);
    }
    const found = await member.request('/assets?q=Bench');
    assert.equal((await found.json()).assets.length, 1);
    assert.equal((await (await stranger.request('/assets?q=Bench')).json()).assets.length, 0);
    assert.equal((await anonymous.request('/assets')).status, 401);
    assert.equal((await member.request('/asset?' + query, 'PATCH', { reportedBy: people[1].key })).status, 400);
    assert.equal((await member.request('/asset?' + query, 'PATCH', { name: 'CSRF' }, 'https://elsewhere.example')).status, 403);
  });

  await t.test('public full representation is readable anonymously and never grants edit access', async () => {
    assert.equal((await member.request('/asset?' + query, 'PATCH', { isPublic: true })).status, 200);
    const expected = (await (await member.request('/asset?' + query)).json()).asset;
    for (const [caller, editStatus] of [[stranger, 404], [anonymous, 401]] as const) {
      const response = await caller.request('/asset?' + query);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.asset, expected);
      assert.deepEqual(Object.keys(result.asset).sort(),
        ['groups', 'identifier', 'isPublic', 'name', 'owner', 'photos', 'reportedAt', 'reportedBy']);
      assert.equal('email' in result.asset.reportedBy, false);
      assert.equal('role' in result.asset.reportedBy, false);
      assert.equal('password' in result.asset.reportedBy, false);
      assert.equal(result.canEdit, false);
      assert.equal((await caller.request('/asset?' + query, 'PATCH', { name: 'Denied' })).status, editStatus);
    }
    assert.equal((await member.request('/asset?' + query, 'PATCH', { isPublic: false })).status, 200);
    assert.equal((await anonymous.request('/asset?' + query)).status, 404);
  });

  await t.test('leaving Group revokes reporter access while provenance stays immutable', async () => {
    assert.equal((await reporter.request(`/groups/${groupKey}/membership`, 'DELETE')).status, 200);
    assert.equal((await reporter.request('/asset?' + query)).status, 404);
    assert.equal((await reporter.request('/asset?' + query, 'PATCH', { name: 'Denied' })).status, 404);
    const response = await member.request('/asset?' + query);
    const { asset } = await response.json();
    assert.deepEqual(asset.reportedBy, { ...people[0], status: 'active' });
    assert.equal(asset.reportedAt, reportedAt);
    assert.equal(asset.name, 'Bench instrument');
    assert.equal((await (await reporter.request('/assets')).json()).assets.length, 0);
    const session = driver.session();
    try {
      const result = await session.run('MATCH (:User)-[r]-(:Asset) RETURN DISTINCT type(r) AS type');
      assert.deepEqual(result.records.map((r) => r.get('type')), ['REPORTED_BY']);
    } finally { await session.close(); }
  });

  await t.test('cursor pages count only authorized Assets and traverse duplicate names beyond 100', async () => {
    const group = await store.createReportingGroup('Inventory', people[1].key);
    const context = { actorKey: people[1].key, groupKey: group.key };
    for (let i = 0; i < 105; i++) {
      await store.reportAsset({ name: i < 103 ? 'Inventory Twin' : 'Inventory Other', identifiers: [i % 2
        ? { scheme: 'grai', grai: '00614141234561' + String(i).padStart(3, '0') }
        : { scheme: 'sgtin', gtin: '00614141123452', serial: 'page-' + String(i).padStart(3, '0') }] }, context);
    }
    const foreignGroup = await store.createReportingGroup('Foreign', people[2].key);
    for (const serial of ['hidden', 'visible']) {
      const identifier = { scheme: 'sgtin' as const, gtin: '00614141123452', serial };
      await store.reportAsset({ name: 'Inventory Twin', identifiers: [identifier] },
        { actorKey: people[2].key, groupKey: foreignGroup.key });
      if (serial === 'visible') await store.updateAsset(identifier, { isPublic: true }, people[2].key);
    }
    for (const [scope, count] of [['all', 107], ['mine', 105], ['group', 106], ['public', 1]] as const) {
      const page = await (await member.request('/assets?scope=' + scope)).json();
      assert.equal(page.matching, count);
      assert.deepEqual(page.scopes, { all: 107, mine: 105, group: 106, public: 1 });
      if (scope === 'mine') assert.ok(page.assets.every((a: { reportedBy: { key: string } }) => a.reportedBy.key === people[1].key));
      if (scope === 'public') assert.ok(page.assets.every((a: { isPublic: boolean }) => a.isPublic));
    }
    const first = await (await member.request('/assets')).json();
    assert.equal(first.assets.length, 30);
    assert.equal(first.total, 107);
    assert.equal(first.matching, 107);
    const noMatch = await (await member.request('/assets?q=absent')).json();
    assert.deepEqual(noMatch, { assets: [], total: 107, matching: 0, scopes: { all: 0, mine: 0, group: 0, public: 0 }, nextCursor: null });
    const empty = await (await reporter.request('/assets?q=absent')).json();
    assert.deepEqual(empty, { assets: [], total: 1, matching: 0, scopes: { all: 0, mine: 0, group: 0, public: 0 }, nextCursor: null });
    assert.equal((await anonymous.request('/assets?limit=1')).status, 401);

    let cursor: string | null = null;
    const identities: string[] = [];
    let firstCursor = '';
    do {
      const params = new URLSearchParams({ q: 'inVENTory twin', limit: '17', ...(cursor ? { cursor } : {}) });
      const response = await member.request('/assets?' + params);
      assert.equal(response.status, 200, await response.clone().text());
      const page = await response.json();
      assert.equal(page.total, 107);
      assert.equal(page.matching, 104);
      assert.ok(page.assets.length > 0 && page.assets.length <= 17);
      for (const asset of page.assets) {
        assert.notEqual(asset.identifier.serial, 'hidden');
        identities.push(JSON.stringify(asset.identifier));
      }
      cursor = page.nextCursor;
      if (!firstCursor && cursor) firstCursor = cursor;
      assert.ok(identities.length <= 104, 'pagination must terminate');
    } while (cursor);
    assert.equal(identities.length, 104);
    assert.equal(new Set(identities).size, 104, 'equal names must not duplicate or omit identities');
    assert.deepEqual(identities, [...identities].sort(), 'supported identifiers break name ties consistently');
    const atLimit = await (await member.request('/assets?q=inVENTory+twin&limit=100')).json();
    assert.equal(atLimit.assets.length, 100);
    const tail = await (await member.request('/assets?' + new URLSearchParams({ q: 'inVENTory twin', cursor: atLimit.nextCursor }))).json();
    assert.equal(tail.assets.length, 4);
    assert.equal(tail.nextCursor, null);

    for (const suffix of ['limit=0', 'limit=101', 'limit=1.5', 'limit=NaN', 'cursor=invalid', 'q=different&cursor=' + firstCursor]) {
      assert.equal((await member.request('/assets?' + suffix)).status, 400, suffix);
    }
    await store.leaveGroup(people[1].key, group.key);
    const revoked = await (await member.request('/assets?' + new URLSearchParams({ q: 'inVENTory twin', cursor: firstCursor }))).json();
    assert.equal(revoked.total, 2);
    assert.equal(revoked.matching, 1);
    assert.ok(revoked.assets.every((asset: { isPublic: boolean }) => asset.isPublic));
    assert.equal(revoked.nextCursor, null);
    const mineAfterLeaving = await (await member.request('/assets?scope=mine')).json();
    assert.equal(mineAfterLeaving.matching, 0);
    assert.equal(mineAfterLeaving.assets.length, 0);
    assert.deepEqual(mineAfterLeaving.scopes, { all: 2, mine: 0, group: 1, public: 1 });
    const searchScopes = await (await stranger.request('/assets?q=Twin&scope=mine')).json();
    assert.equal(searchScopes.matching, 2);
    assert.deepEqual(searchScopes.scopes, { all: 2, mine: 2, group: 2, public: 1 });
  });

});
