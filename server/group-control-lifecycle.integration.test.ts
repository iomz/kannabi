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

/** Handing Group control on, and giving it up.
 *
 * Control could previously only be created — at Group creation and by
 * administrator recovery — and only ended with the account. So it could not be
 * transferred, could not be stood down from, and a Group could not reach zero
 * controllers while a living one remained, which also put recovery out of reach
 * in precisely the case that needed it.
 *
 * What these assert is the lifecycle and its boundaries: that control moves,
 * that it can reach zero and be recovered, and that none of it leaks into
 * membership or Asset access on the way.
 */
test('Group control can be granted, stood down from, and recovered',
  { skip: !uri || !password }, async (t) => {
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
      const address = `192.0.2.${++peer}`;
      return async (path: string, method = 'GET', body?: unknown) => {
        const response = await app.request(origin + '/api' + path, {
          method,
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
            'x-kannabi-client-ip': address },
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

    const founder = client(), successor = client(), outsider = client(), admin = client();
    const keys: string[] = [];
    for (const [index, call] of [founder, successor, outsider, admin].entries()) {
      const signup = await call('/auth/sign-up/email', 'POST', {
        name: `Control tester ${index}`,
        email: `control-lifecycle-${index}-${randomUUID()}@example.com`,
        password: 'test-password-12345',
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      keys.push((await (await call('/me')).json()).user.key);
    }
    const [founderKey, successorKey, outsiderKey, adminKey] = keys;
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: adminKey });

    const group = (await (await founder('/groups', 'POST',
      { name: 'Handed on ' + randomUUID() })).json()).group;
    const control = `/groups/${group.key}/control`;
    // One private Asset, so every claim about access can be checked against
    // something real rather than against an empty instance.
    const asset = (await (await founder('/assets', 'POST',
      { name: 'Controlled rig', groupKey: group.key })).json()).asset;
    const assetPath = `/assets/${asset.id}`;

    const controllers = async (call: ReturnType<typeof client>) =>
      ((await (await call(control)).json()).controllers as { key: string }[])
        .map((entry) => entry.key).sort();

    await t.test('only a controller sees who controls a Group', async () => {
      assert.deepEqual(await controllers(founder), [founderKey]);
      // Not a member, not a controller, and an administrator is neither.
      assert.equal((await outsider(control)).status, 404);
      assert.equal((await admin(control)).status, 404);
    });

    await t.test('a controller grants control, and the grant carries nothing else', async () => {
      const granted = await founder(`${control}/${successorKey}`, 'PUT');
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { changed: true });
      assert.deepEqual(await controllers(founder), [founderKey, successorKey].sort());

      // Control is a control-plane relationship: it adds no membership and
      // reaches no Asset.
      assert.deepEqual((await (await successor('/groups')).json()).groups, [],
        'a grant of control is not a grant of membership');
      assert.equal((await successor(assetPath)).status, 404);
      assert.equal((await successor(assetPath, 'PATCH', { name: 'No control-plane edit' })).status, 404);
      assert.deepEqual((await (await successor('/groups/controlled')).json()).groups
        .map((entry: { key: string }) => entry.key), [group.key]);

      // Idempotent, and reported as a no-op rather than as a change.
      assert.deepEqual(await (await founder(`${control}/${successorKey}`, 'PUT')).json(),
        { changed: false });
    });

    await t.test('controllers are peers: the new one can administer and can withdraw the first',
      async () => {
        // What control is actually for.
        assert.equal((await successor(`/groups/${group.key}/members`, 'POST',
          { userKey: outsiderKey })).status, 200);
        assert.equal((await outsider(assetPath)).status, 200,
          'an explicit membership grant does reach the Asset');

        // No primary controller exists, so withdrawal runs in both directions.
        const withdrawn = await successor(`${control}/${founderKey}`, 'DELETE');
        assert.equal(withdrawn.status, 200);
        assert.deepEqual(await withdrawn.json(), { changed: true });
        assert.deepEqual(await controllers(successor), [successorKey]);
        assert.equal((await founder(control)).status, 404, 'and it takes effect at once');
        assert.equal((await founder(`/groups/${group.key}/members`, 'POST',
          { userKey: adminKey })).status, 404);
        // Withdrawing control does not touch the founder's membership or the
        // Asset access that membership carries.
        assert.equal((await founder(assetPath)).status, 200);
      });

    await t.test('leaving a Group leaves control intact, in both directions', async () => {
      // Membership and control are independent, and neither departure implies
      // the other. The founder is a member without control; make the successor
      // a member, then have them leave, and the control must survive it.
      assert.equal((await successor(`/groups/${group.key}/members`, 'POST',
        { userKey: successorKey })).status, 200);
      assert.deepEqual((await (await successor('/groups')).json()).groups
        .map((entry: { key: string }) => entry.key), [group.key]);
      assert.equal((await successor(`/groups/${group.key}/membership`, 'DELETE')).status, 200);
      assert.deepEqual(await controllers(successor), [successorKey],
        'leaving a Group is not standing down from controlling it');
      assert.equal((await successor(assetPath)).status, 404, 'but the Asset access goes');
    });

    await t.test('an API token observes a grant and a withdrawal on its next request', async () => {
      const issued = await (await successor('/api-tokens', 'POST',
        { label: 'control lifecycle', lifetimeDays: 1 })).json();
      const bearer = (path: string, method = 'GET') => app.request(origin + '/api' + path, {
        method, headers: { Authorization: `Bearer ${issued.secret}` },
      });
      assert.equal((await bearer(control)).status, 200);
      // Authority is read live rather than captured when the credential was
      // made, so a withdrawal lands without revoking the token.
      await query('MATCH (:User {key: $userKey})-[c:CONTROLS]->(:Group {key: $groupKey}) DELETE c',
        { userKey: successorKey, groupKey: group.key });
      assert.equal((await bearer(control)).status, 404);
      await query(`MATCH (u:User {key: $userKey}), (g:Group {key: $groupKey})
        CREATE (u)-[:CONTROLS]->(g)`, { userKey: successorKey, groupKey: group.key });
      assert.equal((await bearer(control)).status, 200);
    });

    await t.test('a controller may stand down to nobody, and recovery is then reachable',
      async () => {
        // The case the old model could not express: a living controller giving
        // up the last control, deliberately, with no successor invented.
        const stoodDown = await successor(`${control}/${successorKey}`, 'DELETE');
        assert.equal(stoodDown.status, 200);
        assert.deepEqual(await stoodDown.json(), { changed: true });
        assert.equal((await successor(control)).status, 404);

        const state = await query(`MATCH (g:Group {key: $groupKey})
          RETURN count { (g)<-[:CONTROLS]-() } AS controllers,
            count { (g)<-[:MEMBER_OF]-() } AS members`, { groupKey: group.key });
        assert.equal(state.records[0].get('controllers').toNumber(), 0);
        assert.ok(state.records[0].get('members').toNumber() > 0,
          'an uncontrolled Group keeps its members and their Asset access');
        assert.equal((await outsider(assetPath)).status, 200);

        // Which is exactly what the existing administrator boundary repairs,
        // and only now that it genuinely has no controller.
        assert.deepEqual((await (await admin('/admin/groups/uncontrolled')).json()).groups
          .map((entry: { key: string }) => entry.key), [group.key]);
        assert.equal((await admin(`/admin/groups/${group.key}/recover`, 'POST',
          { userKey: outsiderKey })).status, 200);
        assert.deepEqual(await controllers(outsider), [outsiderKey]);
        assert.deepEqual((await (await admin('/admin/groups/uncontrolled')).json()).groups, []);
      });

    await t.test('recovery grants control alone, and an administrator gains nothing by it',
      async () => {
        // Recovery appointed somebody who already had membership, so check the
        // boundary with one who does not.
        assert.equal((await outsider(`${control}/${founderKey}`, 'PUT')).status, 200);
        assert.equal((await outsider(`${control}/${outsiderKey}`, 'DELETE')).status, 200);
        assert.equal((await founder(control)).status, 200);
        // The administrator never acquired control or access along the way.
        assert.deepEqual((await (await admin('/groups/controlled')).json()).groups, []);
        assert.equal((await admin(control)).status, 404);
        assert.equal((await admin(assetPath)).status, 404);
        assert.equal((await admin(`${control}/${adminKey}`, 'PUT')).status, 404,
          'an administrator cannot appoint themselves to a controlled Group');
      });

    await t.test('control is only ever granted to an account that can exercise it', async () => {
      const ghost = client();
      const signup = await ghost('/auth/sign-up/email', 'POST', {
        name: 'Departing controller', email: `control-ghost-${randomUUID()}@example.com`,
        password: 'test-password-12345',
      });
      assert.equal(signup.status, 200);
      const ghostKey = (await (await ghost('/me')).json()).user.key as string;
      assert.equal((await founder(`${control}/${ghostKey}`, 'PUT')).status, 200);
      assert.deepEqual(await controllers(founder), [founderKey, ghostKey].sort());

      // Account deletion still removes control, without a successor and
      // without being blocked to preserve one.
      assert.equal((await ghost('/profile', 'DELETE')).status, 200);
      assert.deepEqual(await controllers(founder), [founderKey]);
      // And a tombstone can never be appointed: control nobody can exercise
      // would be authority nobody can withdraw either.
      assert.equal((await founder(`${control}/${ghostKey}`, 'PUT')).status, 404);
      assert.equal((await founder(`${control}/${randomUUID()}`, 'PUT')).status, 404);
    });

    await t.test('withdrawing control nobody holds is a no-op, not an error', async () => {
      assert.deepEqual(await (await founder(`${control}/${successorKey}`, 'DELETE')).json(),
        { changed: false });
    });
  });
