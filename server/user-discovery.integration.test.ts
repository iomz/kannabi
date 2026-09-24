import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore } from './identity-store.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** One rule decides who a viewer may know exists. These are the cases it is
 * made of, each arranged on its own so a change to the rule fails on the case
 * it broke rather than on a fixture that happens to cover several. */
test('User discoverability', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const session = driver.session();
  t.after(() => session.close());

  /** A User straight into the graph: this is about reachability, not sign-up. */
  const person = async (name: string, admin = false) => {
    const key = randomUUID();
    await session.run(`CREATE (u:User { key: $key, id: $key, name: $name, email: $email
      ${admin ? ", role: 'admin'" : ''} })`,
    { key, name, email: `${key}@example.invalid` });
    return key;
  };
  const group = async (name: string, members: string[]) => {
    const key = randomUUID();
    await session.run(`CREATE (g:Group { key: $key, name: $name })
      WITH g UNWIND $members AS member
      MATCH (u:User { key: member }) CREATE (u)-[:MEMBER_OF]->(g)`, { key, name, members });
    return key;
  };
  const asset = async (reporter: string, groupKey: string, isPublic: boolean) => {
    const id = randomUUID();
    await session.run(`MATCH (u:User { key: $reporter }), (g:Group { key: $groupKey })
      CREATE (a:Asset { id: $id, name: $id, isPublic: $isPublic, reportedAt: datetime() })
      CREATE (a)-[:REPORTED_BY]->(u) CREATE (g)-[:CAN_COLLABORATE]->(a)`,
    { reporter, groupKey, id, isPublic });
    return id;
  };

  const viewer = await person('Viewer');
  const colleague = await person('Colleague');
  const distant = await person('Distant reporter');
  const stranger = await person('Stranger');
  const administrator = await person('Administrator', true);
  const tombstone = await person('Departed');
  await session.run(`MATCH (u:User { key: $key })
    SET u.accountDeletedAt = datetime(), u.provenanceName = 'Departed'
    REMOVE u.email, u.role`, { key: tombstone });

  const shared = await group('Shared', [viewer, colleague]);
  const elsewhere = await group('Elsewhere', [distant, stranger]);
  // The distant reporter's work is public, so the viewer can read it and knows
  // the name on it. The stranger's is not, and shares no Group.
  await asset(distant, elsewhere, true);
  await asset(stranger, elsewhere, false);
  await asset(colleague, shared, false);

  const reaches = async (actor: string, target: string) =>
    (await store.userProfile(actor, target)) !== null;
  const directory = async (actor: string) =>
    (await store.listUsers(actor)).map((person) => person.key).sort();

  await t.test('yourself, your Group, and whoever’s work you can read', async () => {
    assert.ok(await reaches(viewer, viewer), 'self');
    assert.ok(await reaches(viewer, colleague), 'shares a Group');
    assert.ok(await reaches(viewer, distant), 'reported something readable');
    assert.ok(!await reaches(viewer, stranger), 'shares nothing and reported nothing readable');
  });

  await t.test('a tombstone is not a person to visit', async () => {
    assert.ok(!await reaches(viewer, tombstone));
    assert.ok(!await reaches(administrator, tombstone), 'not even for an administrator');
    assert.ok(!(await directory(administrator)).includes(tombstone));
  });

  await t.test('an administrator sees every account, and no more Assets for it', async () => {
    assert.ok(await reaches(administrator, stranger), 'the member list already shows them');
    // Administration is a system role. It reaches an account, never its work:
    // the count is through the administrator's own readability, and they share
    // no Group with the stranger, whose Asset is private.
    const seen = await store.userProfile(administrator, stranger);
    assert.equal(seen?.reportedAssets, 0, 'administration is not Asset access');
    const own = await store.userProfile(viewer, distant);
    assert.equal(own?.reportedAssets, 1, 'a public Asset is readable by anybody signed in');
  });

  await t.test('the directory and a page never disagree about somebody', async () => {
    for (const [actor, name] of [[viewer, 'viewer'], [administrator, 'administrator']] as const) {
      const listed = await directory(actor);
      for (const target of [viewer, colleague, distant, stranger, administrator, tombstone]) {
        assert.equal(listed.includes(target), await reaches(actor, target),
          `${name} and ${target}`);
      }
    }
  });

  await t.test('discovery never produces an address', async () => {
    const everybody = [...await store.listUsers(administrator),
      (await store.userProfile(viewer, colleague))!];
    for (const person of everybody) {
      assert.deepEqual(Object.keys(person).sort(),
        ['avatarHash', 'key', 'name', 'reportedAssets', 'self']);
      assert.ok(!JSON.stringify(person).includes('@'), person.name);
    }
  });

  await t.test('sharing a Group is not access to that person’s Assets', async () => {
    // The colleague's Asset is in the shared Group, so the viewer reads it.
    // The stranger's is not, and being able to see a name has not changed that.
    const page = await store.findAssets(viewer,
      { q: '', scope: 'all', sort: 'name', dir: 'asc',
        filters: { groups: [], schemes: [], identified: null, reportedFrom: null, reportedTo: null,
          reportedToEndOfDay: false }, limit: 50, after: null });
    const reporters = page.assets.map((found) => found.reportedBy.key);
    assert.ok(reporters.includes(colleague), 'the shared Group is readable');
    assert.ok(!reporters.includes(stranger), 'a private Asset elsewhere is not');
  });
});
