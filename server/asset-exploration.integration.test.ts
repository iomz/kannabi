import assert from 'node:assert/strict';
import { test } from 'node:test';
import neo4j from 'neo4j-driver';
import { IdentityStore } from './identity-store.js';
import { assetPageRequest, assetSorts, type AssetDirection, type AssetSort } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { ValidationError } from './identity.js';

// Only the isolated Docker runner supplies these variables; no default database.
const uri = process.env.KANNABI_TEST_NEO4J_URI;
const password = process.env.KANNABI_TEST_NEO4J_PASSWORD;
test('Asset exploration orders and pages deterministically', { skip: !uri || !password }, async (t) => {
  const driver = neo4j.driver(uri!, neo4j.auth.basic('neo4j', password!));
  t.after(() => driver.close());
  const store = await IdentityStore.open(driver);
  const actor = await store.createUser('Explorer');
  const stranger = await store.createUser('Stranger');
  const group = await store.createReportingGroup('Exploring team', actor.key);
  const sealed = await store.createReportingGroup('Sealed team', stranger.key);
  const context = { actorKey: actor.key, groupKey: group.key };
  async function query(cypher: string, params = {}) {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  }

  // 40 readable Assets. Names repeat in blocks of four and reportedAt repeats in
  // blocks of five, so every ordering crosses runs of duplicate sort values and
  // must lean on the Asset.id tiebreaker.
  const readable: string[] = [];
  for (let n = 0; n < 40; n++) {
    const asset = await store.reportAsset({ name: `Twin ${Math.floor(n / 4)}` }, context);
    readable.push(asset.id);
    await query('MATCH (a:Asset {id: $id}) SET a.reportedAt = datetime($at)',
      { id: asset.id, at: new Date(Date.UTC(2026, 0, 1 + Math.floor(n / 5))).toISOString() });
  }
  // Assets the explorer must never see in any ordering or count.
  const hidden: string[] = [];
  for (let n = 0; n < 6; n++) {
    hidden.push((await store.reportAsset({ name: `Twin ${n}` },
      { actorKey: stranger.key, groupKey: sealed.key })).id);
  }

  async function walk(sort: AssetSort, dir: AssetDirection, limit: number) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const request = assetPageRequest({ sort, dir, limit: String(limit), ...(cursor ? { cursor } : {}) });
      const page = await store.findAssets(actor.key, request);
      pages.push(page.assets.map((asset) => asset.id));
      assert.ok(page.assets.length <= limit);
      cursor = page.nextCursor ?? undefined;
      assert.ok(pages.length <= 60, 'pagination must terminate');
    } while (cursor);
    return pages.flat();
  }

  await t.test('every sort and direction traverses the readable set exactly once', async () => {
    for (const sort of assetSorts) {
      for (const dir of ['asc', 'desc'] as const) {
        for (const limit of [1, 3, 7, 40]) {
          const seen = await walk(sort, dir, limit);
          const label = `${sort} ${dir} limit ${limit}`;
          assert.equal(seen.length, 40, label);
          assert.equal(new Set(seen).size, 40, `${label}: no duplicates`);
          assert.deepEqual([...seen].sort(), [...readable].sort(), `${label}: no omissions`);
          assert.ok(!seen.some((id) => hidden.includes(id)), `${label}: nothing unreadable`);
        }
      }
    }
  });

  await t.test('ordering follows the chosen field, with Asset.id breaking ties only', async () => {
    for (const sort of assetSorts) {
      for (const dir of ['asc', 'desc'] as const) {
        const ordered = await walk(sort, dir, 6);
        const rows = await query(`UNWIND $ids AS id MATCH (a:Asset {id: id})
          RETURN a.id AS id, a.name AS name, toString(a.reportedAt) AS reportedAt`, { ids: ordered });
        const byId = new Map(rows.records.map((row) => [row.get('id') as string, row.toObject()]));
        const keys = ordered.map((id) => byId.get(id)! as { id: string; name: string; reportedAt: string });
        for (let n = 1; n < keys.length; n++) {
          const previous = keys[n - 1];
          const current = keys[n];
          const before = sort === 'name' ? previous.name : previous.reportedAt;
          const after = sort === 'name' ? current.name : current.reportedAt;
          const ascending = dir === 'asc';
          if (before === after) {
            // Duplicate sort values fall back to the id, in the same direction.
            assert.ok(ascending ? previous.id < current.id : previous.id > current.id,
              `${sort} ${dir}: tiebreaker must follow the primary direction`);
          } else {
            assert.ok(ascending ? before < after : before > after, `${sort} ${dir}: ordering`);
          }
        }
      }
    }
  });

  await t.test('counts and search ignore Assets the caller cannot read', async () => {
    const page = await store.findAssets(actor.key, assetPageRequest({}));
    assert.equal(page.total, 40);
    assert.equal(page.matching, 40);
    assert.deepEqual(page.scopes, { all: 40, mine: 40, group: 40, public: 0 });
    // Name search is unchanged by sorting, and still substring over names only.
    const searched = await store.findAssets(actor.key, assetPageRequest({ q: 'twin 3', sort: 'reportedAt', dir: 'desc' }));
    assert.equal(searched.matching, 4);
    assert.ok(searched.assets.every((asset) => asset.name === 'Twin 3'));
  });

  await t.test('structured filters narrow the readable set and compose with q, scope and sort', async () => {
    // A dedicated Group so these fixtures can be isolated from earlier subtests.
    const filterGroup = await store.createReportingGroup('Filter team', actor.key);
    const context2 = { actorKey: actor.key, groupKey: filterGroup.key };
    // A different trade item from the class-lookup subtest, so neither
    // subtest's counts depend on the other's fixtures.
    const gtin = { scheme: 'gtin' as const, gtin: '4901234567894' };
    const giai = (reference: string) => ({ scheme: 'giai' as const, assetReference: reference });
    const made: Record<string, string> = {};
    made.plain = (await store.reportAsset({ name: 'Filter plain' }, context2)).id;
    made.classed = (await store.reportAsset({ name: 'Filter classed', identifiers: [gtin] }, context2)).id;
    made.individual = (await store.reportAsset({ name: 'Filter individual',
      identifiers: [giai('0614141FILTER-1')] }, context2)).id;
    made.published = (await store.reportAsset({ name: 'Filter published',
      identifiers: [giai('0614141FILTER-2')] }, context2)).id;
    await store.updateAsset(made.published, { isPublic: true }, actor.key);
    // Dated apart so a range filter has something to cut.
    await query('MATCH (a:Asset {id: $id}) SET a.reportedAt = datetime($at)',
      { id: made.plain, at: '2025-03-01T00:00:00Z' });

    const base = { group: filterGroup.key };
    const find = async (extra: Record<string, string | string[]> = {}) =>
      store.findAssets(actor.key, assetPageRequest({ ...base, ...extra }));
    const ids = async (extra: Record<string, string | string[]> = {}) =>
      (await find(extra)).assets.map((asset) => asset.id).sort();

    // `total` is the caller's readable set before any discovery predicate, so
    // it never moves as filters, search or scope change.
    const unfiltered = await store.findAssets(actor.key, assetPageRequest({}));
    for (const extra of [{}, { scope: 'public' }, { identified: 'none' },
      { scheme: 'gtin' }, { q: 'Filter' }, { scope: 'mine' }] as Record<string, string>[]) {
      const page = await find(extra);
      assert.equal(page.total, unfiltered.total, JSON.stringify(extra));
    }

    // Each filter independently.
    assert.deepEqual(await ids(), [made.classed, made.individual, made.plain, made.published].sort());
    // Visibility has no structured filter: the scope tabs own that dimension.
    assert.deepEqual(await ids({ scope: 'public' }), [made.published]);
    assert.deepEqual(await ids({ identified: 'none' }), [made.plain]);
    assert.deepEqual(await ids({ identified: 'any' }),
      [made.classed, made.individual, made.published].sort());
    assert.deepEqual(await ids({ scheme: 'gtin' }), [made.classed]);
    assert.deepEqual(await ids({ scheme: 'giai' }), [made.individual, made.published].sort());
    // Multi-value is OR within one filter.
    assert.deepEqual(await ids({ scheme: ['gtin', 'giai'] }),
      [made.classed, made.individual, made.published].sort());
    assert.deepEqual(await ids({ reportedFrom: '2026-01-01' }),
      [made.classed, made.individual, made.published].sort());
    assert.deepEqual(await ids({ reportedTo: '2025-12-31' }), [made.plain]);

    // Filters AND together, and compose with q and scope. The Group filter is
    // the narrower question the scope tabs cannot ask: `scope=group` means any
    // Group access, `group=<key>` means this one Group.
    assert.deepEqual(await ids({ scheme: 'gtin', reportedFrom: '2026-01-01' }), [made.classed]);
    assert.deepEqual(await ids({ q: 'published' }), [made.published]);
    assert.deepEqual(await ids({ q: 'filter', identified: 'none' }), [made.plain]);
    assert.deepEqual(await ids({ scope: 'public' }), [made.published]);
    assert.deepEqual(await ids({ scope: 'public', q: 'filter' }), [made.published]);
    assert.deepEqual(await ids({ scheme: 'giai', q: 'individual' }), [made.individual]);
    // The Group filter narrows a scope that is already wider than one Group.
    const anyGroup = await store.findAssets(actor.key, assetPageRequest({ scope: 'group', q: 'Filter' }));
    assert.ok(anyGroup.assets.length >= 4);
    const oneGroup = await store.findAssets(actor.key,
      assetPageRequest({ scope: 'group', q: 'Filter', group: filterGroup.key }));
    assert.deepEqual(oneGroup.assets.map((asset) => asset.id).sort(),
      [made.classed, made.individual, made.plain, made.published].sort());
    // A contradiction simply yields nothing rather than a special case.
    assert.deepEqual(await ids({ identified: 'none', scheme: 'gtin' }), []);

    // `matching` reflects the complete active predicate, and equals scopes[scope].
    const narrowed = await find({ scheme: 'giai' });
    assert.equal(narrowed.matching, 2);
    assert.equal(narrowed.matching, narrowed.scopes.all);
    assert.equal(narrowed.scopes.public, 1);

    // Sorting composes with filters in both directions.
    for (const dir of ['asc', 'desc'] as const) {
      const page = await find({ sort: 'reportedAt', dir });
      const order = page.assets.map((asset) => asset.reportedAt);
      assert.deepEqual(order, dir === 'asc' ? [...order].sort() : [...order].sort().reverse());
    }

    // Unreadable Assets never appear, and an inaccessible Group key is not an
    // existence oracle: it simply matches nothing the caller may read.
    const sealedOnly = await store.findAssets(actor.key, assetPageRequest({ group: sealed.key }));
    assert.deepEqual(sealedOnly.assets, []);
    assert.equal(sealedOnly.matching, 0);
    assert.equal(sealedOnly.total, unfiltered.total);
    const invented = await store.findAssets(actor.key, assetPageRequest({ group: 'no-such-group' }));
    assert.deepEqual({ ...invented, assets: [] }, { ...sealedOnly, assets: [] });

    // A cursor is bound to the canonical filter state, not just to q/scope/sort.
    const paged = await find({ limit: '1' });
    assert.ok(paged.nextCursor);
    assert.throws(() => assetPageRequest({ ...base, identified: 'any', cursor: paged.nextCursor! }),
      ValidationError);
    assert.throws(() => assetPageRequest({ cursor: paged.nextCursor! }), ValidationError);
    // The same filter state spelled differently still accepts its own cursor.
    assert.doesNotThrow(() => assetPageRequest({ group: [filterGroup.key], cursor: paged.nextCursor! }));

    // Exhaustive traversal under a filter neither duplicates nor omits.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await find({ identified: 'any', sort: 'reportedAt', dir: 'desc',
        limit: '1', ...(cursor ? { cursor } : {}) });
      seen.push(...page.assets.map((asset) => asset.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen.sort(), [made.classed, made.individual, made.published].sort());
  });

  await t.test('a class identifier pages through its Assets without duplicates or omissions', async () => {
    const gtin = { scheme: 'gtin' as const, gtin: '0614141123452' };
    const carriers: string[] = [];
    for (let n = 0; n < 12; n++) {
      const asset = await store.reportAsset({ name: `Class member ${11 - n}`, identifiers: [gtin] }, context);
      carriers.push(asset.id);
    }
    // One carrier the explorer cannot read: absent from every page and the count.
    const sealedCarrier = await store.reportAsset({ name: 'Class member sealed', identifiers: [gtin] },
      { actorKey: stranger.key, groupKey: sealed.key });

    const seen: string[] = [];
    let cursor: string | undefined;
    let matching = 0;
    do {
      const result = await store.lookupAssets(actor.key,
        assetLookupQuery({ ...gtin, limit: '5', ...(cursor ? { cursor } : {}) }));
      matching = result.matching;
      seen.push(...result.assets.map((asset) => asset.id));
      assert.ok(result.assets.length <= 5);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    // `matching` is the complete readable count even while a page is smaller.
    assert.equal(matching, 12);
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.deepEqual([...seen].sort(), [...carriers].sort());
    assert.ok(!seen.includes(sealedCarrier.id));
    // Ordering is by name, so the pages are stable and predictable.
    const names = await query('UNWIND $ids AS id MATCH (a:Asset {id: id}) RETURN a.name AS name', { ids: seen });
    assert.deepEqual(names.records.map((row) => row.get('name')),
      [...names.records.map((row) => row.get('name') as string)].sort());
  });
});
