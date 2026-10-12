import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { ApiTokenService } from './api-token.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Group roles over the HTTP API the web UI calls.
 *
 * One relationship with a role: a Group Manager is a member who also manages.
 * These prove that every read answers members only, that every change is a
 * Group Manager's, that a role never outlives its membership, that recovery
 * promotes a member and never adds one, and that a Group read by somebody
 * outside it is indistinguishable from one that does not exist.
 */
test('Group roles: one membership, with a role', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const origin = 'http://localhost:3000';
  const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
  const tokens = new ApiTokenService(auth, store);
  const app = new Hono().route('/api', createInventoryApi(store, auth, origin, undefined, undefined, tokens));

  let peer = 0;
  function client() {
    let cookie = '';
    let bearer = '';
    const address = `192.0.2.${++peer}`;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await app.request(origin + '/api' + path, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address,
          ...bearer ? { Authorization: `Bearer ${bearer}` } : { Cookie: cookie } },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = response.headers.getSetCookie();
      if (set.length && !bearer) cookie = set.map((value) => value.split(';')[0]).join('; ');
      return response;
    };
    return Object.assign(call, { useToken(token: string) { bearer = token; } });
  }
  async function query(statement: string, params = {}) {
    const session = driver.session();
    try { return await session.run(statement, params); } finally { await session.close(); }
  }
  const json = async (response: Response | Promise<Response>) => {
    const resolved = await response;
    assert.ok(resolved.ok, `${resolved.status} ${await resolved.clone().text()}`);
    return resolved.json();
  };

  const names = ['founder', 'member', 'second', 'outsider', 'admin'] as const;
  const people = Object.fromEntries(names.map((name) => [name, client()])) as Record<(typeof names)[number], ReturnType<typeof client>>;
  const key = {} as Record<(typeof names)[number], string>;
  for (const name of names) {
    assert.equal((await people[name]('/auth/sign-up/email', 'POST', { name: `Roles ${name}`,
      email: `roles-${name}-${randomUUID()}@example.com`, password: 'test-password-12345' })).status, 200);
    key[name] = (await json(people[name]('/me'))).user.key;
  }
  await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: key.admin });
  const { founder, member, second, outsider, admin } = people;

  const group = (await json(founder('/groups', 'POST', { name: 'Shared bench' }))).group;
  const base = `/groups/${group.key}`;
  const unknown = `/groups/${randomUUID()}`;
  const roleOf = async (name: (typeof names)[number]) => {
    const { members } = await json(founder(`${base}/members`));
    return (members as { key: string; role: string }[]).find((person) => person.key === key[name])?.role ?? null;
  };
  const asUnknown = async (call: ReturnType<typeof client>, suffix: string) => {
    const [left, right] = [await call(base + suffix), await call(unknown + suffix)];
    assert.deepEqual([left.status, await left.json()], [right.status, await right.json()],
      `${suffix || 'the Group'} answers exactly as an unknown Group`);
    assert.equal(left.status, 404);
  };

  await t.test('creating a Group makes its creator a member who manages it', async () => {
    assert.deepEqual(await json(founder(base)), { group, viewer: { role: 'manager' } });
    const listed = (await json(founder('/groups'))).groups;
    assert.deepEqual(listed, [{ ...group, role: 'manager', people: 1, assets: 0 }]);
    assert.equal((await founder('/groups/controlled')).status, 404, 'there is no separate list of managed Groups');
  });

  await t.test('a Group Manager adds people with a role; a member reads everybody and changes nothing', async () => {
    assert.deepEqual(await json(founder(`${base}/members`, 'POST', { userKey: key.member })), { ok: true, added: true });
    assert.deepEqual(await json(founder(`${base}/members`, 'POST', { userKey: key.second, role: 'manager' })),
      { ok: true, added: true });
    // Adding somebody already here changes nothing, their role included.
    assert.deepEqual(await json(founder(`${base}/members`, 'POST', { userKey: key.member, role: 'manager' })),
      { ok: true, added: false });
    assert.equal(await roleOf('member'), 'member');
    assert.equal((await founder(`${base}/members`, 'POST', { userKey: key.member, role: 'owner' })).status, 400);

    assert.deepEqual(await json(member(base)), { group, viewer: { role: 'member' } });
    const seen = (await json(member(`${base}/members`))).members as Record<string, unknown>[];
    assert.deepEqual(seen.map((person) => [person.key, person.role]).sort(),
      [[key.founder, 'manager'], [key.member, 'member'], [key.second, 'manager']].sort());
    for (const person of seen) assert.deepEqual(Object.keys(person).sort(), ['email', 'key', 'name', 'role', 'status']);
    // A member changes nothing, and is answered as if the Group were unknown.
    for (const [path, method, body] of [
      [`${base}/members`, 'POST', { userKey: key.outsider }],
      [`${base}/members/${key.second}`, 'PATCH', { role: 'member' }],
      [`${base}/members/${key.founder}`, 'DELETE', undefined],
    ] as const) assert.equal((await member(path, method, body)).status, 404, `${method} ${path}`);
  });

  await t.test('somebody outside the Group, an administrator included, cannot tell it from an unknown one', async () => {
    for (const call of [outsider, admin]) {
      await asUnknown(call, '');
      await asUnknown(call, '/members');
      assert.equal((await call(`${base}/members`, 'POST', { userKey: key.outsider })).status, 404);
      assert.equal((await call(`${base}/members/${key.member}`, 'PATCH', { role: 'manager' })).status, 404);
    }
  });

  await t.test('Group Managers are peers: any of them changes any role, their own included', async () => {
    assert.deepEqual(await json(second(`${base}/members/${key.member}`, 'PATCH', { role: 'manager' })), { changed: true });
    assert.deepEqual(await json(second(`${base}/members/${key.member}`, 'PATCH', { role: 'manager' })), { changed: false });
    assert.deepEqual(await json(member(`${base}/members/${key.founder}`, 'PATCH', { role: 'member' })), { changed: true });
    assert.equal(await roleOf('founder'), 'member', 'the creator holds no special standing');
    assert.equal((await founder(`${base}/members/${key.member}`, 'PATCH', { role: 'member' })).status, 404,
      'a demoted Group Manager is refused on the next request');
    assert.deepEqual(await json(second(`${base}/members/${key.second}`, 'PATCH', { role: 'member' })), { changed: true });
    // A role is changed only on somebody in the Group.
    assert.equal((await member(`${base}/members/${key.outsider}`, 'PATCH', { role: 'manager' })).status, 404);
    assert.deepEqual(await json(member(`${base}/members/${key.founder}`, 'PATCH', { role: 'manager' })), { changed: true });
  });

  await t.test('a role never outlives its membership', async () => {
    // Removing somebody who manages ends both, together.
    assert.deepEqual(await json(founder(`${base}/members/${key.member}`, 'DELETE')), { changed: true });
    assert.equal(await roleOf('member'), null);
    await asUnknown(member, '');
    assert.equal((await member(`${base}/members/${key.second}`, 'PATCH', { role: 'manager' })).status, 404);
    // So does leaving.
    await json(founder(`${base}/members`, 'POST', { userKey: key.member, role: 'manager' }));
    assert.equal((await member(`${base}/membership`, 'DELETE')).status, 200);
    await asUnknown(member, '');
    const stray = await query(`MATCH (:User {key: $key})-[r]->(:Group {key: $group}) RETURN count(r) AS n`,
      { key: key.member, group: group.key });
    assert.equal(Number(stray.records[0].get('n')), 0, 'nothing of the relationship is left behind');
    // Removing somebody not in the Group is an authorized no-op.
    assert.deepEqual(await json(founder(`${base}/members/${key.outsider}`, 'DELETE')), { changed: false });
  });

  await t.test('managing a Group still reaches only its Assets, and only through membership', async () => {
    const reported = (await json(founder('/assets', 'POST', { name: 'Private rig', groupKey: group.key }))).asset;
    assert.equal((await second(`/assets/${reported.id}`)).status, 200, 'a member reads it, whatever their role');
    assert.equal((await outsider(`/assets/${reported.id}`)).status, 404);
    assert.equal((await admin(`/assets/${reported.id}`)).status, 404, 'administration reaches no Asset');
    assert.equal((await json(founder('/groups'))).groups[0].assets, 1);
  });

  await t.test('an API token acts under its owner’s role as it is now', async () => {
    const issued = await json(second('/api-tokens', 'POST', { label: 'roles', lifetimeDays: 1 }));
    const robot = client();
    robot.useToken(issued.secret);
    assert.equal((await robot(`${base}/members/${key.founder}`, 'PATCH', { role: 'manager' })).status, 404,
      'a member’s token changes nothing');
    await json(founder(`${base}/members/${key.second}`, 'PATCH', { role: 'manager' }));
    assert.deepEqual(await json(robot(`${base}/members/${key.founder}`, 'PATCH', { role: 'manager' })), { changed: false });
    await json(founder(`${base}/members/${key.second}`, 'PATCH', { role: 'member' }));
    assert.equal((await robot(`${base}/members/${key.founder}`, 'PATCH', { role: 'member' })).status, 404,
      'the demotion lands on the token’s next request');
  });

  await t.test('a Group may be left with no Group Manager, and recovery promotes one of its members', async () => {
    assert.deepEqual(await json(founder(`${base}/members/${key.founder}`, 'PATCH', { role: 'member' })), { changed: true });
    const unmanaged = (await json(admin('/admin/groups/unmanaged'))).groups as { key: string }[];
    assert.ok(unmanaged.some((entry) => entry.key === group.key));
    assert.equal((await member('/admin/groups/unmanaged')).status, 403);
    // Recovery never adds a membership: somebody outside the Group, the
    // administrator included, cannot be appointed.
    for (const target of [key.outsider, key.admin]) {
      assert.equal((await admin(`/admin/groups/${group.key}/recover`, 'POST', { userKey: target })).status, 404);
    }
    await asUnknown(admin, '');
    assert.equal((await admin(`/admin/groups/${group.key}/recover`, 'POST', { userKey: key.second })).status, 200);
    assert.equal(await roleOf('second'), 'manager');
    assert.equal((await admin(`/admin/groups/${group.key}/recover`, 'POST', { userKey: key.founder })).status, 404,
      'only a Group with no Group Manager is recovered');
  });

  await t.test('a Group with no members has nobody to promote, and stays valid', async () => {
    const empty = (await json(outsider('/groups', 'POST', { name: 'Soon empty' }))).group;
    assert.equal((await outsider(`/groups/${empty.key}/membership`, 'DELETE')).status, 200);
    assert.equal((await query('MATCH (g:Group {key: $key}) RETURN g', { key: empty.key })).records.length, 1);
    assert.ok(((await json(admin('/admin/groups/unmanaged'))).groups as { key: string }[]).some((entry) => entry.key === empty.key));
    assert.equal((await admin(`/admin/groups/${empty.key}/recover`, 'POST', { userKey: key.outsider })).status, 404);
  });

  await t.test('startup refuses Group data that predates roles', async () => {
    await query(`MATCH (u:User {key: $user}), (g:Group {key: $group}) CREATE (u)-[:CONTROLS]->(g)`,
      { user: key.outsider, group: group.key });
    await assert.rejects(IdentityStore.open(driver), /predates Group roles/);
    await query('MATCH ()-[c:CONTROLS]->() DELETE c');
    await query(`MATCH (u:User {key: $user}), (g:Group {key: $group}) CREATE (u)-[:MEMBER_OF]->(g)`,
      { user: key.outsider, group: group.key });
    await assert.rejects(IdentityStore.attachReadOnly(driver), /predates Group roles/);
    await query(`MATCH (:User {key: $user})-[m:MEMBER_OF]->(:Group {key: $group}) DELETE m`,
      { user: key.outsider, group: group.key });
    await IdentityStore.open(driver);
  });
});
