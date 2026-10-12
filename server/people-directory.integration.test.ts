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

/** The People directory and profiles, under each value of its setting.
 *
 * Who a viewer can find, and whether they see an address, is the instance's
 * setting, enforced in the server's responses. Being findable never says
 * which Groups somebody is in beyond those the viewer shares, and nobody who
 * is deleted or anonymous takes part in it from either side.
 */
test('the People directory follows its setting, and only ever widens what is shown about the findable',
  { skip: !uri || !password }, async (t) => {
    const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
    t.after(() => driver.close());
    const store = await IdentityStore.open(driver);
    const origin = 'http://localhost:3000';
    const auth = await createAuth(driver, origin, randomUUID() + randomUUID());
    const app = new Hono().route('/api', createInventoryApi(store, auth, origin));
    let peer = 0;
    function client() {
      let cookie = '';
      const address = `192.0.2.${++peer}`;
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, {
          method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'x-kannabi-client-ip': address },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = response.headers.getSetCookie();
        if (set.length) cookie = set.map((value) => value.split(';')[0]).join('; ');
        return response;
      };
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

    // viewer and colleague share a Group; stranger shares none; admin is an
    // administrator in no Group; departed is deleted.
    const names = ['viewer', 'colleague', 'stranger', 'admin', 'departed'] as const;
    type Name = (typeof names)[number];
    const people = Object.fromEntries(names.map((name) => [name, client()])) as Record<Name, ReturnType<typeof client>>;
    const key = {} as Record<Name, string>;
    const email = {} as Record<Name, string>;
    for (const name of names) {
      email[name] = `directory-${name}-${randomUUID()}@example.com`;
      assert.equal((await people[name]('/auth/sign-up/email', 'POST', { name: `Directory ${name}`, email: email[name],
        password: 'test-password-12345' })).status, 200);
      key[name] = (await json(people[name]('/me'))).user.key;
    }
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: key.admin });
    const { viewer, colleague, stranger, admin, departed } = people;
    const team = (await json(viewer('/groups', 'POST', { name: 'Team' }))).group;
    const hidden = (await json(colleague('/groups', 'POST', { name: 'Secret prototype' }))).group;
    await json(viewer(`/groups/${team.key}/members`, 'POST', { userKey: key.colleague }));
    assert.equal((await admin(`/admin/users/${key.departed}`, 'DELETE')).status, 200);

    async function directory(value: 'everyone' | 'names' | 'shared') {
      const saved = await json(admin('/settings', 'PATCH', { peopleDirectory: value }));
      assert.equal(saved.settings.peopleDirectory, value);
    }
    type Found = { key: string; email: string | null; sharedGroups: { key: string }[] };
    const found = async (call: ReturnType<typeof client>, q?: string) =>
      (await json(call(`/people${q ? `?q=${encodeURIComponent(q)}` : ''}`))).people as Found[];
    const keys = (list: Found[]) => list.map((person) => person.key).sort();
    const everybodyActive = [key.viewer, key.colleague, key.stranger, key.admin].sort();

    await t.test('the default finds every active person, with their address', async () => {
      assert.equal((await json(viewer('/settings'))).settings.peopleDirectory, 'everyone');
      const seen = await found(viewer);
      assert.deepEqual(keys(seen), everybodyActive, 'nobody deleted');
      for (const person of seen) assert.equal(person.email, email[names.find((name) => key[name] === person.key)!]);
      // Being findable never says which Groups somebody is in.
      const colleagueSeen = (await found(stranger)).find((person) => person.key === key.colleague)!;
      assert.deepEqual(colleagueSeen.sharedGroups, []);
      const fromViewer = seen.find((person) => person.key === key.colleague)!;
      assert.deepEqual(fromViewer.sharedGroups.map((group) => group.key), [team.key], 'only the Group they share');
      assert.ok(!JSON.stringify(await json(stranger(`/users/${key.colleague}`))).includes(hidden.key));
      // A profile is reachable exactly when the person is findable.
      assert.equal((await stranger(`/users/${key.viewer}`)).status, 200);
      assert.equal((await stranger(`/users/${key.departed}`)).status, 404);
    });

    await t.test('search matches names, and addresses only where addresses are shown', async () => {
      assert.deepEqual(keys(await found(stranger, 'directory colleague')), [key.colleague]);
      assert.deepEqual(keys(await found(stranger, email.colleague.slice(0, 30))), [key.colleague]);
      await directory('names');
      assert.deepEqual(keys(await found(stranger, email.colleague.slice(0, 30))), [],
        'an address nobody may see is no way to find anybody');
      assert.deepEqual(keys(await found(stranger, 'directory colleague')), [key.colleague]);
      await directory('everyone');
    });

    await t.test('names only: everybody findable, nobody’s address shown but your own', async () => {
      await directory('names');
      const seen = await found(stranger);
      assert.deepEqual(keys(seen), everybodyActive);
      for (const person of seen) {
        assert.equal(person.email, person.key === key.stranger ? email.stranger : null);
      }
      assert.equal((await json(stranger(`/users/${key.viewer}`))).profile.email, null);
      // Group pages follow the same setting.
      const roster = (await json(viewer(`/groups/${team.key}/members`))).members as Found[];
      assert.equal(roster.find((person) => person.key === key.colleague)!.email, null);
      await directory('everyone');
      const shown = (await json(viewer(`/groups/${team.key}/members`))).members as Found[];
      assert.equal(shown.find((person) => person.key === key.colleague)!.email, email.colleague);
    });

    await t.test('shared Groups only: people find those they share a Group with, and themselves', async () => {
      await directory('shared');
      assert.deepEqual(keys(await found(viewer)), [key.viewer, key.colleague].sort());
      assert.deepEqual(keys(await found(stranger)), [key.stranger]);
      assert.deepEqual(keys(await found(admin)), [key.admin], 'administration broadens nothing');
      assert.equal((await stranger(`/users/${key.viewer}`)).status, 404);
      assert.equal((await json(viewer(`/users/${key.colleague}`))).profile.email, email.colleague);
      await directory('everyone');
    });

    await t.test('nobody signed out reaches the directory', async () => {
      const anonymous = client();
      assert.equal((await anonymous('/people')).status, 401);
      assert.equal((await anonymous(`/users/${key.viewer}`)).status, 401);
      assert.equal((await departed('/people')).status, 401);
    });

    await t.test('a search stays a search: bounded, and saying when to narrow it', async () => {
      const page = await json(viewer('/people?limit=2'));
      assert.equal(page.people.length, 2);
      assert.equal(page.more, true);
      assert.equal((await json(viewer('/people?limit=100'))).more, false);
      for (const limit of ['0', '101', 'x']) assert.equal((await viewer(`/people?limit=${limit}`)).status, 400, limit);
      assert.equal((await viewer(`/people?q=${'x'.repeat(201)}`)).status, 400);
    });
  });
