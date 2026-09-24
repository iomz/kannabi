import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore } from './identity-store.js';

const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;

/** Workspace enumeration and individual profile reachability share one rule:
 * self plus active Users sharing at least one Group. */
test('Workspace Members and User profile reachability', { skip: !uri || !password }, async (t) => {
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
  await group('Second shared', [viewer, colleague]);
  await group('Colleague private', [colleague, stranger]);
  const elsewhere = await group('Elsewhere', [distant, stranger]);
  // The distant reporter's work is public, so the viewer can read it and knows
  // the name on it. The stranger's is not, and shares no Group.
  await asset(distant, elsewhere, true);
  await asset(stranger, elsewhere, false);
  await asset(colleague, shared, false);
  await asset(viewer, shared, false);

  const reaches = async (actor: string, target: string) =>
    (await store.userProfile(actor, target)) !== null;
  const members = async (actor: string) =>
    (await store.listMembers(actor)).map((person) => person.key).sort();

  await t.test('only yourself and active Users sharing a Group are reachable', async () => {
    assert.ok(await reaches(viewer, viewer), 'self');
    assert.ok(await reaches(viewer, colleague), 'shares a Group');
    assert.ok(!await reaches(viewer, distant), 'readable reporting provenance grants nothing');
    assert.ok(!await reaches(viewer, stranger), 'shares nothing and reported nothing readable');
  });

  await t.test('a tombstone is not a person to visit', async () => {
    assert.ok(!await reaches(viewer, tombstone));
    assert.ok(!await reaches(administrator, tombstone), 'not even for an administrator');
    assert.ok(!(await members(administrator)).includes(tombstone));
  });

  await t.test('Workspace Members is strictly shared-Group-derived', async () => {
    assert.deepEqual(await members(viewer), [colleague, viewer].sort());
    assert.ok(!(await members(viewer)).includes(distant),
      'readable provenance does not enumerate its reporter');
    assert.deepEqual(await members(administrator), [administrator],
      'self remains visible without a Group; administrator status adds nobody');
  });

  await t.test('administrator status and readable Assets do not broaden profiles', async () => {
    assert.ok(!await reaches(administrator, stranger), 'administrator sees account only in Administration Users');
    assert.ok(!await reaches(viewer, distant), 'public Asset attribution stays plain text');
  });

  await t.test('Members and profile reachability are identical boundaries', async () => {
    const listed = await members(viewer);
    for (const target of [viewer, colleague, distant, stranger, administrator, tombstone]) {
      assert.equal(listed.includes(target), await reaches(viewer, target), target);
    }
  });

  await t.test('discovery never produces an address', async () => {
    const everybody = [...await store.listMembers(viewer),
      (await store.userProfile(viewer, colleague))!];
    for (const person of everybody) {
      assert.deepEqual(Object.keys(person).sort(),
        ['avatarHash', 'key', 'name', 'reportedAssets', 'self', 'sharedGroups']);
      assert.ok(!JSON.stringify(person).includes('@'), person.name);
    }
  });

  await t.test('shared Groups expose only the intersection with the viewer', async () => {
    const people = await store.listMembers(viewer);
    const colleagueProfile = people.find((person) => person.key === colleague)!;
    assert.deepEqual(colleagueProfile.sharedGroups.map((found) => found.name).sort(),
      ['Second shared', 'Shared']);
    assert.ok(!colleagueProfile.sharedGroups.some((found) => found.name === 'Colleague private'));
    assert.equal(await store.userProfile(administrator, stranger), null,
      'administration does not expose a Workspace profile');
  });

  await t.test('directory, profile, and Asset queries count the same readable reports', async () => {
    const people = await store.listMembers(viewer);
    const page = await store.findAssets(viewer,
      { q: '', scope: 'all', sort: 'name', dir: 'asc',
        filters: { groups: [], schemes: [], identified: null, reportedFrom: null, reportedTo: null,
          reportedToEndOfDay: false }, limit: 50, after: null });
    for (const person of people) {
      const fromAssets = page.assets.filter((found) => found.reportedBy.key === person.key).length;
      assert.equal(person.reportedAssets, fromAssets, person.name);
      assert.equal((await store.userProfile(viewer, person.key))?.reportedAssets, fromAssets, person.name);
    }
    const mine = await store.findAssets(viewer,
      { q: '', scope: 'mine', sort: 'name', dir: 'asc',
        filters: { groups: [], schemes: [], identified: null, reportedFrom: null, reportedTo: null,
          reportedToEndOfDay: false }, limit: 50, after: null });
    assert.equal(people.find((person) => person.self)?.reportedAssets, mine.matching);
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
