import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isAssetId, newAssetId } from './asset-id.js';
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
  const people: { key: string; name: string; email: string }[] = [];
  /** Public attribution is key, name and status — never an address. */
  const attribution = (person: { key: string; name: string }, status: 'active' | 'deleted') =>
    ({ key: person.key, name: person.name, status });

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
      // `/me` names the caller's own account, address included, so a client can
      // show which one is active without a second request.
      assert.equal(user.email, `person${i}@example.com`);
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
  const canonical = '(01)00614141123452(21)001/a%?';
  // The canonical native Asset path, assigned when the Asset is reported.
  let assetPath = '';
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
    assert.ok(isAssetId(asset.id), asset.id);
    assetPath = '/assets/' + asset.id;
    assert.deepEqual(asset.identifiers.map((i: { canonical: string }) => i.canonical), [canonical]);
    assert.deepEqual(asset.reportedBy, attribution(people[0], 'active'));
    assert.equal(asset.groups[0].key, groupKey);
    assert.equal(asset.isPublic, false);
    reportedAt = asset.reportedAt;
  });

  await t.test('member reads and edits private Asset; unrelated and anonymous callers cannot', async () => {
    const read = await member.request(assetPath);
    assert.equal(read.status, 200);
    const readable = await read.json();
    assert.equal(readable.canEdit, true);
    assert.equal(readable.canViewReporterProfile, true,
      'shared Group makes reporter profile reachable');
    assert.equal((await member.request(assetPath, 'PATCH', { name: 'Bench instrument' })).status, 200);
    for (const [caller, editStatus] of [[stranger, 404], [anonymous, 401]] as const) {
      const inaccessible = await caller.request(assetPath);
      const missing = await caller.request('/assets/' + newAssetId());
      assert.equal(inaccessible.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(await inaccessible.json(), await missing.json());
      assert.equal((await caller.request(assetPath, 'PATCH', { name: 'Denied' })).status, editStatus);
    }
    // The retired identifier-addressed route is gone, not aliased or redirected.
    for (const retired of ['/asset?' + new URLSearchParams(identifier), '/photos/any-key?' + new URLSearchParams(identifier)]) {
      assert.equal((await member.request(retired)).status, 404);
    }
    const found = await member.request('/assets?q=Bench');
    assert.equal((await found.json()).assets.length, 1);
    assert.equal((await (await stranger.request('/assets?q=Bench')).json()).assets.length, 0);
    assert.equal((await anonymous.request('/assets')).status, 401);
    assert.equal((await member.request(assetPath, 'PATCH', { reportedBy: people[1].key })).status, 400);
    assert.equal((await member.request(assetPath, 'PATCH', { id: newAssetId() })).status, 400);
    assert.equal((await member.request(assetPath, 'PATCH', { name: 'CSRF' }, 'https://elsewhere.example')).status, 403);
    // Identifier mutation is Group-authorized like every other Asset change, and
    // submitting an identifier never grants access to the Asset carrying it.
    const attachPath = assetPath + '/identifiers';
    assert.equal((await stranger.request(attachPath, 'POST', { scheme: 'giai', assetReference: '0614141STRANGER' })).status, 404);
    assert.equal((await anonymous.request(attachPath, 'POST', { scheme: 'giai', assetReference: '0614141ANON' })).status, 401);
    const attached = await member.request(attachPath, 'POST', { scheme: 'giai', assetReference: '0614141MEMBER-1' });
    assert.equal(attached.status, 201, await attached.clone().text());
    const identifiers = (await attached.json()).asset.identifiers as { key: string; canonical: string; level: string }[];
    assert.deepEqual(identifiers.map((i) => i.canonical).sort(), [canonical, '(8004)0614141MEMBER-1']);
    // A stranger who learns the identifier still cannot reach or edit the Asset.
    assert.equal((await stranger.request(assetPath)).status, 404);
    const giaiKey = identifiers.find((i) => i.canonical === '(8004)0614141MEMBER-1')!.key;
    assert.equal((await stranger.request(attachPath + '/' + giaiKey, 'DELETE')).status, 404);
    assert.equal((await anonymous.request(attachPath + '/' + giaiKey, 'DELETE')).status, 401);
    const detached = await member.request(attachPath + '/' + giaiKey, 'DELETE');
    assert.equal(detached.status, 200);
    assert.deepEqual((await detached.json()).asset.identifiers.map((i: { canonical: string }) => i.canonical), [canonical]);
  });

  await t.test('public full representation is readable anonymously and never grants edit access', async () => {
    assert.equal((await member.request(assetPath, 'PATCH', { isPublic: true })).status, 200);
    const expected = (await (await member.request(assetPath)).json()).asset;
    for (const [caller, editStatus] of [[stranger, 404], [anonymous, 401]] as const) {
      const response = await caller.request(assetPath);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.asset, expected);
      // The native Asset id, issuance provenance and change provenance all
      // belong to the legitimate public representation: allocation provenance
      // is ledger-derived, so no identifier carries an origin flag of its own,
      // and change provenance is attribution of the same kind as reportedBy.
      // Publication is a whole-Asset decision, so none of it is filtered here.
      assert.deepEqual(Object.keys(result.asset).sort(),
        ['allocation', 'groups', 'id', 'identifiers', 'isPublic', 'name', 'owner', 'photos',
          'provenance', 'reportedAt', 'reportedBy']);
      assert.equal('email' in result.asset.provenance.acceptedBy, false);
      assert.equal(assetPath, '/assets/' + result.asset.id);
      assert.equal('email' in result.asset.reportedBy, false);
      assert.equal('role' in result.asset.reportedBy, false);
      assert.equal('password' in result.asset.reportedBy, false);
      assert.equal(result.canEdit, false);
      assert.equal(result.canViewReporterProfile, false,
        'public Asset readability does not make reporter profile reachable');
      assert.equal((await caller.request(assetPath, 'PATCH', { name: 'Denied' })).status, editStatus);
    }
    assert.equal((await member.request(assetPath, 'PATCH', { isPublic: false })).status, 200);
    assert.equal((await anonymous.request(assetPath)).status, 404);
  });

  await t.test('GIAI allocation is Group-authorized and idempotent over the API', async () => {
    // Configuring a prefix is a Group-member act; outsiders cannot reach it.
    assert.equal((await stranger.request(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '0614141' })).status, 404);
    assert.equal((await anonymous.request(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '0614141' })).status, 401);
    const configured = await member.request(`/groups/${groupKey}/giai-namespaces`, 'POST',
      { gcp: '0614141', exclusions: [{ from: 1, to: 4 }] });
    assert.equal(configured.status, 201, await configured.clone().text());
    const namespace = (await configured.json()).namespace;
    assert.equal(namespace.gcp, '0614141');
    assert.deepEqual(namespace.exclusions, [{ from: 1, to: 4 }]);
    // A second Group cannot claim a managed prefix while Group membership is
    // the only authorization model.
    assert.equal((await member.request(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '0614141' })).status, 409);
    assert.equal((await member.request(`/groups/${groupKey}/giai-namespaces`, 'POST', { gcp: '06141A1' })).status, 400);

    const allocatePath = assetPath + '/giai';
    assert.equal((await anonymous.request(allocatePath, 'POST', { namespaceKey: namespace.key })).status, 401);
    assert.equal((await stranger.request(allocatePath, 'POST', { namespaceKey: namespace.key })).status, 404);
    const allocated = await member.request(allocatePath, 'POST', { namespaceKey: namespace.key });
    assert.equal(allocated.status, 200, await allocated.clone().text());
    const allocation = (await allocated.json()).asset.allocation;
    // Exclusions are honoured, and provenance is derived from the ledger rather
    // than from any flag on the identifier itself.
    assert.equal(allocation.sequence, 5);
    assert.equal(allocation.value, '06141415');
    assert.equal(allocation.allocatedForAssetId, assetPath.slice('/assets/'.length));
    // Public provenance matches reportedBy: attribution, not an internal key,
    // and nothing private rides along with it.
    assert.deepEqual(Object.keys(allocation.allocatedBy).sort(), ['key', 'name', 'status']);
    assert.deepEqual(allocation.allocatedBy, attribution(people[1], 'active'));
    for (const field of ['email', 'role', 'password']) {
      assert.equal(field in allocation.allocatedBy, false, field);
    }
    const identifiers = (await (await member.request(assetPath)).json()).asset.identifiers;
    assert.ok(identifiers.some((identifier: { canonical: string }) => identifier.canonical === '(8004)06141415'));
    assert.ok(identifiers.every((identifier: Record<string, unknown>) => !('origin' in identifier)));
    // Repeating returns the same issuance.
    const repeated = await member.request(allocatePath, 'POST', { namespaceKey: namespace.key });
    assert.deepEqual((await repeated.json()).asset.allocation, allocation);

    // Deactivation is Group-scoped too, and blocks only new issuance.
    assert.equal((await stranger.request(`/giai-namespaces/${namespace.key}`, 'PATCH', { active: false })).status, 404);
    assert.equal((await member.request(`/giai-namespaces/${namespace.key}`, 'PATCH', { active: false })).status, 200);
    assert.equal((await member.request(`/giai-namespaces/${namespace.key}`, 'PATCH', { active: 'no' })).status, 400);
    assert.deepEqual((await (await member.request(assetPath)).json()).asset.allocation, allocation);
    assert.equal((await member.request(`/giai-namespaces/${namespace.key}`, 'PATCH', { active: true })).status, 200);
    // Anonymous readers of a public Asset see provenance but get no controls.
    assert.deepEqual((await (await stranger.request('/giai-namespaces')).json()).namespaces, []);
  });

  await t.test('identity lookup answers only over the readable set and never enumerates', async () => {
    const id = assetPath.slice('/assets/'.length);
    const lookup = (caller: typeof member, params: Record<string, string>) =>
      caller.request('/assets/lookup?' + new URLSearchParams(params));

    // Anonymous callers cannot use lookup at all: #18 adds no anonymous
    // discovery, even though a public Asset stays readable by direct URI.
    assert.equal((await lookup(anonymous, { id })).status, 401);
    assert.equal((await lookup(anonymous, identifier)).status, 401);

    // A member resolves both the native id and the canonical identifier.
    const byId = await lookup(member, { id });
    assert.equal(byId.status, 200);
    assert.deepEqual((await byId.json()).assets.map((asset: { id: string }) => asset.id), [id]);
    const byIdentifier = await (await lookup(member, identifier)).json();
    assert.equal(byIdentifier.identity.canonical, canonical);
    assert.equal(byIdentifier.identity.level, 'individual');
    assert.deepEqual(byIdentifier.assets.map((asset: { id: string }) => asset.id), [id]);
    assert.equal(byIdentifier.matching, 1);

    // For a stranger the very same identities are byte-identical to identities
    // that were never used: same status, same body, no existence side channel.
    const strangerById = await lookup(stranger, { id });
    const strangerAbsentId = await lookup(stranger, { id: newAssetId() });
    assert.equal(strangerById.status, strangerAbsentId.status);
    assert.deepEqual(await strangerById.json(), { ...await strangerAbsentId.json(), identity: { kind: 'assetId', id } });
    const strangerByIdentifier = await lookup(stranger, identifier);
    const strangerAbsent = await lookup(stranger, { scheme: 'sgtin', gtin: '4901234567894', serial: 'never-used' });
    assert.equal(strangerByIdentifier.status, strangerAbsent.status);
    for (const response of [strangerByIdentifier, strangerAbsent]) {
      const body = await response.json();
      assert.deepEqual(body.assets, []);
      assert.equal(body.matching, 0);
    }

    // Malformed input is a validation error, not a probe result, and it never
    // depends on whether anything exists.
    for (const params of [{}, { id: 'not-an-id' }, { id, scheme: 'sgtin' },
      { scheme: 'sgtin', gtin: '0614141123452' }, { q: 'Bench instrument' }]) {
      assert.equal((await lookup(member, params as Record<string, string>)).status, 400, JSON.stringify(params));
    }
    // Lookup grants nothing: the stranger still cannot read or edit the Asset.
    assert.equal((await stranger.request(assetPath)).status, 404);
    assert.equal((await stranger.request(assetPath, 'PATCH', { name: 'Denied' })).status, 404);
  });

  await t.test('leaving Group revokes reporter access while provenance stays immutable', async () => {
    assert.equal((await reporter.request(`/groups/${groupKey}/membership`, 'DELETE')).status, 200);
    assert.equal((await reporter.request(assetPath)).status, 404);
    assert.equal((await reporter.request(assetPath, 'PATCH', { name: 'Denied' })).status, 404);
    const response = await member.request(assetPath);
    const { asset } = await response.json();
    assert.equal('/assets/' + asset.id, assetPath);
    assert.deepEqual(asset.reportedBy, attribution(people[0], 'active'));
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
      // A third of these carry no external identifier at all, so pagination is
      // exercised without any identifier-cardinality assumption.
      const identifiers = i % 3 === 0 ? []
        : i % 3 === 1 ? [{ scheme: 'grai', assetType: '0614141234561', serial: 'p' + String(i).padStart(3, '0') }]
          : [{ scheme: 'sgtin', gtin: '00614141123452', serial: 'page-' + String(i).padStart(3, '0') },
            { scheme: 'gtin', gtin: '00614141123452' }];
      await store.reportAsset({ name: i < 103 ? 'Inventory Twin' : 'Inventory Other', identifiers }, context);
    }
    const foreignGroup = await store.createReportingGroup('Foreign', people[2].key);
    for (const serial of ['hidden', 'visible']) {
      const identifier = { scheme: 'sgtin' as const, gtin: '00614141123452', serial };
      const reported = await store.reportAsset({ name: 'Inventory Twin', identifiers: [identifier] },
        { actorKey: people[2].key, groupKey: foreignGroup.key });
      if (serial === 'visible') await store.updateAsset(reported.id, { isPublic: true }, people[2].key);
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
        assert.ok(!asset.identifiers.some((i: { canonical: string }) => i.canonical.endsWith('hidden')));
        identities.push(asset.id);
      }
      cursor = page.nextCursor;
      if (!firstCursor && cursor) firstCursor = cursor;
      assert.ok(identities.length <= 104, 'pagination must terminate');
    } while (cursor);
    assert.equal(identities.length, 104);
    assert.equal(new Set(identities).size, 104, 'equal names must not duplicate or omit Assets');
    assert.deepEqual(identities, [...identities].sort(), 'Asset ids break name ties consistently');
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
    assert.deepEqual(searchScopes.scopes, { all: 2, mine: 2, group: 1, public: 1 });
  });

});
