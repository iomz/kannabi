import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import neo4j from 'neo4j-driver';
import { createAuth } from './auth.js';
import { IdentityStore } from './identity-store.js';
import { createInventoryApi } from './inventory-api.js';
import { ApiTokenService } from './api-token.js';
import { checkDigit } from './gs1-syntax.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Who may exercise a Group's managed GS1 authority.
 *
 * Until now any member of the managing Group could configure a prefix, manage
 * its class keys and issue from it. That was a documented temporary assumption
 * shipped with the allocation machinery, and it meant a routine collaborator
 * invited for Asset work also acquired the power to allocate identifiers under
 * the operator's own company prefix.
 *
 * The authority is now membership **and** control of that Group, and for
 * issuance that Group's collaboration on the Asset as well. These assert the
 * boundary from every side rather than the happy path: each of the three
 * conjuncts is removed in turn and the operation must be refused.
 */
test('managed GS1 authority is membership and control of the managing Group',
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

    // founder: membership and control of the managing Group.
    // plainMember: membership without control.
    // controllerOnly: control without membership.
    // admin: system administration and nothing else.
    const founder = client(), plainMember = client(), controllerOnly = client(), admin = client();
    const keys: string[] = [];
    for (const [index, call] of [founder, plainMember, controllerOnly, admin].entries()) {
      const signup = await call('/auth/sign-up/email', 'POST', {
        name: `GS1 authority tester ${index}`,
        email: `gs1-authority-${index}-${randomUUID()}@example.com`,
        password: 'test-password-12345',
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      keys.push((await (await call('/me')).json()).user.key);
    }
    const [founderKey, plainMemberKey, controllerOnlyKey, adminKey] = keys;
    await query("MATCH (u:User {key: $key}) SET u.role = 'admin'", { key: adminKey });

    const gcp = '9520123';
    const classKeyDigits = (() => {
      const body = gcp + '00001';
      return body + checkDigit(body);
    })();

    const group = (await (await founder('/groups', 'POST',
      { name: 'Managing ' + randomUUID() })).json()).group;
    // A member without control, and a controller without membership.
    assert.equal((await founder(`/groups/${group.key}/members`, 'POST',
      { userKey: plainMemberKey })).status, 200);
    assert.equal((await founder(`/groups/${group.key}/control/${controllerOnlyKey}`, 'PUT')).status, 200);

    const asset = (await (await founder('/assets', 'POST',
      { name: 'Managed rig', groupKey: group.key })).json()).asset;
    const assetPath = `/assets/${asset.id}`;
    const namespacePath = `/groups/${group.key}/gs1-namespaces`;

    await t.test('configuring a prefix needs membership and control, not either alone', async () => {
      assert.equal((await plainMember(namespacePath, 'POST', { gcp })).status, 404,
        'a member who does not control the Group holds no authority over what it manages');
      assert.equal((await controllerOnly(namespacePath, 'POST', { gcp })).status, 404,
        'and control without membership is not authority over it either');
      assert.equal((await admin(namespacePath, 'POST', { gcp })).status, 404,
        'system administration is neither');

      const configured = await founder(namespacePath, 'POST', { gcp });
      assert.equal(configured.status, 201, await configured.clone().text());
      assert.equal((await configured.json()).namespace.gcp, gcp);
    });

    const namespace = (await (await founder('/gs1-namespaces')).json()).namespaces
      .find((entry: { gcp: string }) => entry.gcp === gcp);

    await t.test('reading a namespace stays with membership, which mutation no longer is', async () => {
      // Narrowing who may change a namespace says nothing about who may know it
      // exists. A member can already see every value the Group issued on its own
      // Assets, so hiding it would conceal nothing and would stop them finding
      // out who to ask.
      const visible = await (await plainMember('/gs1-namespaces')).json();
      assert.ok(visible.namespaces.some((entry: { key: string }) => entry.key === namespace.key));
      assert.equal((await plainMember(`/gs1-namespaces/${namespace.key}/class-keys`)).status, 200);
      // Control without membership never saw it and still does not.
      assert.deepEqual((await (await controllerOnly('/gs1-namespaces')).json()).namespaces, []);
    });

    await t.test('deactivating a namespace needs both', async () => {
      const path = `/gs1-namespaces/${namespace.key}`;
      assert.equal((await plainMember(path, 'PATCH', { active: false })).status, 404);
      assert.equal((await controllerOnly(path, 'PATCH', { active: false })).status, 404);
      assert.equal((await founder(path, 'PATCH', { active: false })).status, 200);
      assert.equal((await founder(path, 'PATCH', { active: true })).status, 200);
    });

    await t.test('managing a class key needs both', async () => {
      const path = `/gs1-namespaces/${namespace.key}/class-keys`;
      const body = { scheme: 'gtin', gtin: classKeyDigits };
      assert.equal((await plainMember(path, 'POST', body)).status, 404);
      assert.equal((await controllerOnly(path, 'POST', body)).status, 404);
      const adopted = await founder(path, 'POST', body);
      assert.equal(adopted.status, 201, await adopted.clone().text());
      assert.equal((await adopted.json()).classKey.provenance, 'adopted');
    });

    const classKey = (await (await founder(`/gs1-namespaces/${namespace.key}/class-keys`)).json())
      .classKeys[0];

    await t.test('deactivating a class key needs both', async () => {
      const path = `/gs1-namespaces/${namespace.key}/class-keys/${classKey.key}`;
      assert.equal((await plainMember(path, 'PATCH', { active: false })).status, 404);
      assert.equal((await controllerOnly(path, 'PATCH', { active: false })).status, 404);
      assert.equal((await founder(path, 'PATCH', { active: false })).status, 200);
      assert.equal((await founder(path, 'PATCH', { active: true })).status, 200);
    });

    await t.test('issuance needs membership, control and the Group’s collaboration', async () => {
      const giai = `${assetPath}/giai`;
      assert.equal((await plainMember(giai, 'POST', { namespaceKey: namespace.key })).status, 404,
        'membership and collaboration without control');
      assert.equal((await controllerOnly(giai, 'POST', { namespaceKey: namespace.key })).status, 404,
        'control without membership, and without collaboration either');

      // Control is the organizational half and never stands in for the Asset
      // half: a second Group with the same person holding both, whose Group does
      // not collaborate on this Asset, still cannot issue for it.
      const elsewhere = (await (await founder('/groups', 'POST',
        { name: 'Unrelated ' + randomUUID() })).json()).group;
      const otherAsset = (await (await founder('/assets', 'POST',
        { name: 'Unrelated rig', groupKey: elsewhere.key })).json()).asset;
      assert.equal((await founder(`/assets/${otherAsset.id}/giai`, 'POST',
        { namespaceKey: namespace.key })).status, 404,
      'the managing Group must also collaborate on the Asset');

      const issued = await founder(giai, 'POST', { namespaceKey: namespace.key });
      assert.equal(issued.status, 200, await issued.clone().text());
      assert.equal((await issued.json()).asset.issuances.length, 1);

      // A serial under a managed class key passes the same gate, so the
      // narrowing cannot hold for a GIAI and leak for an SGTIN.
      const sgtin = `${assetPath}/sgtin`;
      const serial = { namespaceKey: namespace.key, classKeyKey: classKey.key };
      assert.equal((await plainMember(sgtin, 'POST', serial)).status, 404);
      const serialised = await founder(sgtin, 'POST', serial);
      assert.equal(serialised.status, 200, await serialised.clone().text());
      assert.equal((await serialised.json()).asset.issuances.length, 2);
    });

    await t.test('an API token gains and loses this authority with its owner', async () => {
      const issued = await (await plainMember('/api-tokens', 'POST',
        { label: 'gs1 authority', lifetimeDays: 1 })).json();
      const bearer = (path: string, method = 'GET', body?: unknown) =>
        app.request(origin + '/api' + path, {
          method,
          headers: { Authorization: `Bearer ${issued.secret}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const path = `/gs1-namespaces/${namespace.key}`;

      // The owner is a member without control, so the credential is too.
      assert.equal((await bearer(path, 'PATCH', { active: false })).status, 404);
      // Authority is read live rather than captured when the token was made.
      assert.equal((await founder(`/groups/${group.key}/control/${plainMemberKey}`, 'PUT')).status, 200);
      assert.equal((await bearer(path, 'PATCH', { active: false })).status, 200);
      assert.equal((await bearer(path, 'PATCH', { active: true })).status, 200);
      assert.equal((await founder(`/groups/${group.key}/control/${plainMemberKey}`, 'DELETE')).status, 200);
      assert.equal((await bearer(path, 'PATCH', { active: false })).status, 404,
        'a withdrawal lands on the next request without revoking the credential');
    });

    await t.test('control still reaches no Asset, and an administrator still reaches nothing',
      async () => {
        // The narrowing adds authority to control; it takes none away from the
        // boundary that control has always respected.
        assert.equal((await controllerOnly(assetPath)).status, 404);
        assert.equal((await controllerOnly(assetPath, 'PATCH', { name: 'No control-plane edit' })).status, 404);
        assert.equal((await admin(assetPath)).status, 404);
        assert.equal((await admin(`/gs1-namespaces/${namespace.key}`, 'PATCH', { active: false })).status, 404);
        assert.deepEqual((await (await admin('/gs1-namespaces')).json()).namespaces, []);
      });

    await t.test('an uncontrolled Group keeps its namespace, and recovery restores authority',
      async () => {
        // Reaching zero controllers freezes what the Group manages rather than
        // destroying it, and the existing administrator boundary is the repair.
        assert.equal((await founder(`/groups/${group.key}/control/${controllerOnlyKey}`, 'DELETE')).status, 200);
        assert.equal((await founder(`/groups/${group.key}/control/${founderKey}`, 'DELETE')).status, 200);
        const path = `/gs1-namespaces/${namespace.key}`;
        assert.equal((await founder(path, 'PATCH', { active: false })).status, 404,
          'a member of an uncontrolled Group holds no authority over what it manages');
        // The namespace and its ledger are untouched, and still readable.
        const visible = await (await founder('/gs1-namespaces')).json();
        assert.ok(visible.namespaces.some((entry: { key: string }) => entry.key === namespace.key));

        assert.deepEqual((await (await admin('/admin/groups/uncontrolled')).json()).groups
          .map((entry: { key: string }) => entry.key), [group.key]);
        assert.equal((await admin(`/admin/groups/${group.key}/recover`, 'POST',
          { userKey: founderKey })).status, 200);
        assert.equal((await founder(path, 'PATCH', { active: false })).status, 200,
          'recovered control plus existing membership restores it');
        assert.equal((await founder(path, 'PATCH', { active: true })).status, 200);
      });
  });
