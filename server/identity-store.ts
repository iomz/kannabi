import { randomUUID } from 'node:crypto';
import { validateSettings, type Settings } from './settings.js';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import { int } from 'neo4j-driver';
import { assetCursor, type AssetPageRequest, type AssetScope } from './asset-page.js';
import { assetId, assetIdPattern, newAssetId } from './asset-id.js';
import { record, requiredText, ValidationError } from './identity.js';
import {
  assertCompatible, canonicalIdentifier, canonicalIdentifiers, storedIdentifier,
  type ExternalIdentifier,
} from './gs1.js';
import { isAppearancePreference, type AppearancePreference } from '../shared/appearance.js';
import { MailRevisionConflictError, type MailVerificationStatus, type PersistedMailSettings,
  type StoredMailConfiguration } from './mail.js';

export class DuplicateIdentityError extends Error {}
export class ReferenceError extends Error {}
export class AdministrationError extends Error {}
export class LastAdministratorError extends Error {}
export type Member = { key: string; name: string; email: string; isAdmin: boolean;
  credentialState: 'pending' | 'established'; createdAt: string | null };
export type MemberAccount = Member & { id: string };
export type AccountState = { isAdmin: boolean; appearance: AppearancePreference };
const memberProjection = `u { .key, .name, .email, isAdmin: u.role = 'admin',
  credentialState: CASE WHEN EXISTS { MATCH (u)-[:HAS_AUTHACCOUNT]->(:AuthAccount {providerId: 'credential'}) }
    THEN 'established' ELSE 'pending' END, createdAt: toString(u.createdAt) }`;

// Entity keys are internal references. An Asset carries its own native
// application identity in `id`; external identifiers never address the Asset.
export type Entity = Readonly<{ key: string; name: string }>;
export type ReporterAttribution = Entity & Readonly<{ status: 'active' | 'deleted' }>;
/** An external identifier as carried by an Asset. `key` addresses this
 * attachment for detachment; everything else is derived by the GS1 boundary. */
export type AttachedIdentifier = ExternalIdentifier & Readonly<{ key: string }>;
export type Asset = Readonly<{
  id: string;
  name: string;
  identifiers: readonly AttachedIdentifier[];
  reportedBy: ReporterAttribution;
  reportedAt: string;
  owner: Entity | null;
  groups: readonly Entity[];
  isPublic: boolean;
  photos: readonly Photo[];
}>;
export type Photo = { key: string; contentType: string; size: number; createdAt: string | null };

export function orderPhotos(photos: readonly Photo[]): Photo[] {
  return [...photos].sort((left, right) => {
    const leftCreatedAt = left.createdAt ?? '';
    const rightCreatedAt = right.createdAt ?? '';
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

type StoredIdentifier = { key: string; canonical: string; scheme: string; policyVersion: string };
type StoredAsset = Omit<Asset, 'identifiers'> & { identifiers: StoredIdentifier[] };

/** Components and level are always re-derived from the canonical form, so a
 * stored identifier cannot become an independent source of GS1 truth. */
function assetFrom(stored: StoredAsset): Asset {
  const identifiers = stored.identifiers
    .map((row) => ({ key: row.key, ...storedIdentifier(row.scheme, row.canonical, row.policyVersion) }))
    .sort((left, right) => (left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0));
  return { ...stored, identifiers, photos: orderPhotos(stored.photos) };
}
export type AssetPage = { assets: Asset[]; total: number; matching: number; scopes: Record<AssetScope, number>; nextCursor: string | null };
export type ReportAsset = {
  name: string;
  /** Optional. An Asset exists independently of GS1 identification. */
  identifiers?: readonly unknown[];
  ownerKey?: string;
};
export type ReportingContext = { actorKey: string; groupKey: string };
export type AssetChanges = { name?: string; ownerKey?: string | null; isPublic?: boolean };

const constraints = [
  'CREATE CONSTRAINT settings_key IF NOT EXISTS FOR (n:Settings) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT mail_configuration_key IF NOT EXISTS FOR (n:MailConfiguration) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT media_key IF NOT EXISTS FOR (n:Media) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT user_key IF NOT EXISTS FOR (n:User) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT group_key IF NOT EXISTS FOR (n:Group) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT owner_key IF NOT EXISTS FOR (n:Owner) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT migration_key IF NOT EXISTS FOR (n:Migration) REQUIRE n.key IS UNIQUE',
  // :IndividualIdentifier and :ClassIdentifier are persistence vocabulary, not
  // domain concepts. They exist only because Neo4j Community cannot express a
  // conditional uniqueness constraint, so the derived GS1 level is carried by
  // the label and each rule becomes a plain constraint. A :ClassIdentifier
  // holding a GTIN is that GTIN and nothing more: Kannabi defines no parallel
  // class-identity scheme, mints no identifier of its own, and these labels
  // must never be promoted into the domain model or exposed as schemes.
  'CREATE CONSTRAINT individual_identifier IF NOT EXISTS FOR (n:IndividualIdentifier) REQUIRE n.canonical IS UNIQUE',
  'CREATE CONSTRAINT individual_identifier_key IF NOT EXISTS FOR (n:IndividualIdentifier) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT class_identifier IF NOT EXISTS FOR (n:ClassIdentifier) REQUIRE n.canonical IS UNIQUE',
  'CREATE CONSTRAINT class_identifier_key IF NOT EXISTS FOR (n:ClassIdentifier) REQUIRE n.key IS UNIQUE',
];

// Installed only once every Asset carries a native id, so a pre-Phase-1
// database is not rejected before its Assets can be migrated.
const assetIdConstraint = 'CREATE CONSTRAINT asset_id IF NOT EXISTS FOR (n:Asset) REQUIRE n.id IS UNIQUE';

function isDuplicateIdentifier(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed';
}

/** Rebuild a pre-Phase-2 claim through the GS1 boundary so migration validates
 * rather than transcribes. SGTIN stored its components already; GRAI stored the
 * whole AI 8003 payload, whose serial the legacy model always required. */
function legacyIdentifier(scheme: unknown, value: unknown, serial: unknown): ExternalIdentifier {
  if (scheme === 'sgtin') return canonicalIdentifier({ scheme: 'sgtin', gtin: value, serial });
  if (scheme === 'grai') {
    if (typeof value !== 'string' || value.length <= 14 || value[0] !== '0') {
      throw new ValidationError(`Legacy GRAI ${JSON.stringify(value)} is not a zero-filled AI 8003 payload with a serial`);
    }
    return canonicalIdentifier({ scheme: 'grai', assetType: value.slice(1, 14), serial: value.slice(14) });
  }
  throw new ValidationError(`Legacy identifier scheme ${JSON.stringify(scheme)} cannot be migrated`);
}

function identifierRows(identifiers: readonly ExternalIdentifier[], level: 'individual' | 'class') {
  return identifiers.filter((identifier) => identifier.level === level).map((identifier) => ({
    key: randomUUID(), canonical: identifier.canonical,
    scheme: identifier.scheme, policyVersion: identifier.policyVersion,
  }));
}

function identifierParams(identifiers: readonly ExternalIdentifier[]) {
  return {
    individualIdentifiers: identifierRows(identifiers, 'individual'),
    classIdentifiers: identifierRows(identifiers, 'class'),
  };
}

// Requires `a` in scope. The two labels record the GS1 level an identifier
// already has; they add no meaning of their own. Individual identifiers are
// CREATEd so the uniqueness constraint rejects a second Asset claiming them;
// class identifiers are MERGEd so Assets share one node.
const attachIdentifiers = `
  FOREACH (i IN $individualIdentifiers |
    CREATE (a)-[:IDENTIFIED_BY]->(:IndividualIdentifier {
      key: i.key, canonical: i.canonical, scheme: i.scheme, policyVersion: i.policyVersion }))
  FOREACH (c IN $classIdentifiers |
    MERGE (n:ClassIdentifier {canonical: c.canonical})
      ON CREATE SET n.key = c.key, n.scheme = c.scheme, n.policyVersion = c.policyVersion
    MERGE (a)-[:CLASSIFIED_AS]->(n))`;

const identifierProjection = `
    identifiers: [(a)-[:IDENTIFIED_BY]->(x:IndividualIdentifier) |
        x { .key, .canonical, .scheme, .policyVersion }]
      + [(a)-[:CLASSIFIED_AS]->(y:ClassIdentifier) |
        y { .key, .canonical, .scheme, .policyVersion }],`

const assetMatch = 'MATCH (a:Asset {id: $assetId})';
const collaboration = `EXISTS {
  MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(:Group)-[:CAN_COLLABORATE]->(a)
}`;
const assetProjection = `
  MATCH (a)-[:REPORTED_BY]->(u:User)
  MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
  OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
  WITH a, u, o, collect(g { .key, .name }) AS groups
  RETURN a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
    reportedBy: { key: u.key,
      name: CASE WHEN u.accountDeletedAt IS NULL THEN u.name ELSE coalesce(u.provenanceName, u.name, 'Deleted member') END,
      status: CASE WHEN u.accountDeletedAt IS NULL THEN 'active' ELSE 'deleted' END }, owner: o { .key, .name },
    groups: groups, photos: [(a)-[:HAS_PHOTO]->(m:Media) |
      m { .key, .contentType, size: toFloat(m.size), createdAt: toString(m.createdAt) }] } AS asset`;

/** Internal persistence API. Callers must supply a trusted actor context.
 * No HTTP routes or authentication are provided by this layer.
 * The supplied driver belongs to the caller and is never closed here.
 */
export class IdentityStore {
  private constructor(private readonly driver: Driver) {}

  static async open(driver: Driver): Promise<IdentityStore> {
    const session = driver.session();
    try {
      // Fail closed if constraints cannot be installed, including on dirty data.
      // These do not depend on migrated Asset data, and migration_key must exist
      // before the backfill can take its lock.
      for (const statement of constraints) await session.run(statement);
      await IdentityStore.backfillAssetIds(driver);
      await IdentityStore.verifyAssetIds(session);
      await session.run(assetIdConstraint);
      await IdentityStore.migrateExternalIdentifiers(driver);
      await IdentityStore.verifyExternalIdentifiers(session);
      // The pre-Phase-2 identifier schema has no remaining nodes to guard.
      await session.run('DROP CONSTRAINT identifier_claim IF EXISTS');
      await session.run(`MERGE (s:Settings {key: 'instance'})
        ON CREATE SET s.requirePhoto = false, s.displayTimezone = 'UTC', s.revision = 0
        SET s.themeId = coalesce(s.themeId, 'default') REMOVE s.accentColor`);
      await session.run(`MERGE (m:MailConfiguration {key: 'instance'})
        ON CREATE SET m.enabled = false, m.transport = 'smtp', m.revision = 0
        SET m.verificationStatus = coalesce(m.verificationStatus, 'not-verified')`);
      await session.run('MATCH (a:Asset) SET a.isPublic = coalesce(a.isPublic, false)');
      // Better Auth role is sole persisted administrator authority. Preserve existing
      // installations once, then remove legacy duplicate state.
      await session.run(`MATCH (u:User) WHERE u.id IS NOT NULL
        SET u.role = CASE WHEN u.isAdmin = true THEN 'admin' ELSE coalesce(u.role, 'user') END
        REMOVE u.isAdmin`);
      const result = await session.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties RETURN *');
      for (const [label, properties] of [
        ['Settings', ['key']], ['MailConfiguration', ['key']], ['Media', ['key']], ['User', ['key']], ['Group', ['key']], ['Owner', ['key']],
        ['Migration', ['key']], ['Asset', ['id']],
        ['IndividualIdentifier', ['canonical']], ['IndividualIdentifier', ['key']],
        ['ClassIdentifier', ['canonical']], ['ClassIdentifier', ['key']],
      ] as const) {
        if (!result.records.some((row) => row.get('type') === 'UNIQUENESS'
          && JSON.stringify(row.get('labelsOrTypes')) === JSON.stringify([label])
          && JSON.stringify(row.get('properties')) === JSON.stringify(properties))) {
          throw new Error(`Required uniqueness constraint is missing for ${label}`);
        }
      }
    } finally {
      await session.close();
    }
    return new IdentityStore(driver);
  }

  /** Assign a native identity to Assets reported before Phase 1.
   *
   * Each batch runs in one transaction that first takes a write lock on the
   * migration node, so a concurrently starting Kannabi blocks there and only
   * reads `id IS NULL` once the peer's assignments are committed. Without that
   * lock both processes read the same rows as null and the second overwrites
   * ids the first already assigned.
   *
   * Idempotent: only `id IS NULL` Assets are written, so an interrupted or
   * repeated migration never replaces an assigned id. Values are ordinary
   * UUIDv7s generated now; no chronology is synthesized from `reportedAt`.
   */
  private static async backfillAssetIds(driver: Driver): Promise<void> {
    const batch = 500;
    const session = driver.session();
    try {
      for (;;) {
        const ids = Array.from({ length: batch }, () => newAssetId());
        const assigned = await session.executeWrite(async (tx) => {
          // Held until this transaction commits, covering the read below.
          await tx.run("MERGE (m:Migration {key: 'asset-id'}) SET m.lock = true");
          const result = await tx.run(`
            MATCH (a:Asset) WHERE a.id IS NULL
            WITH a LIMIT $batch
            WITH collect(a) AS legacy
            UNWIND range(0, size(legacy) - 1) AS position
            WITH legacy[position] AS asset, $ids[position] AS id
            SET asset.id = id
            RETURN count(asset) AS assigned`, { batch: int(batch), ids });
          return result.records[0].get('assigned').toNumber() as number;
        });
        if (!assigned) return;
      }
    } finally { await session.close(); }
  }

  /** A uniqueness constraint establishes neither presence nor format, and
   * Neo4j Community cannot express either, so startup checks them here.
   * A non-null id that is not a canonical lowercase UUIDv7 is corrupt or
   * unsupported data: fail closed rather than replace a value we do not
   * recognize. The pattern is shared with `isAssetId`.
   */
  private static async verifyAssetIds(session: Session): Promise<void> {
    const result = await session.run(`MATCH (a:Asset)
      WHERE NOT coalesce(toString(a.id), '') =~ $pattern
      RETURN count(a) AS invalid, collect(a.id)[0..3] AS samples`, { pattern: assetIdPattern });
    const invalid = result.records[0].get('invalid').toNumber();
    if (invalid) {
      const samples = (result.records[0].get('samples') as unknown[]).map((value) => JSON.stringify(value)).join(', ');
      throw new Error(`${invalid} Asset(s) have a missing or invalid native id `
        + `(${samples}); a canonical lowercase UUIDv7 is required and unrecognized values are never replaced`);
    }
  }

  /** Move pre-Phase-2 Assets from the single required SGTIN/GRAI claim to
   * external identifiers. Serialised on a migration node for the same reason
   * as the native-id backfill: a concurrent peer must observe committed work
   * rather than re-reading rows it is about to rewrite.
   *
   * Legacy shape is migrated; anything else is corruption and fails closed.
   * Nothing is repaired or discarded, and no class-level GTIN is materialised
   * from an SGTIN — that stays derivable.
   */
  private static async migrateExternalIdentifiers(driver: Driver): Promise<void> {
    const session = driver.session();
    try {
      for (;;) {
        const migrated = await session.executeWrite(async (tx) => {
          await tx.run("MERGE (m:Migration {key: 'external-identifiers'}) SET m.lock = true");
          const legacy = await tx.run(`MATCH (a:Asset)-[:IDENTIFIED_BY]->(i:Identifier)
            WITH a, i LIMIT $batch
            RETURN a.id AS assetId, i.scheme AS scheme, i.value AS value, i.serial AS serial`,
          { batch: int(500) });
          if (!legacy.records.length) return 0;
          const rows = legacy.records.map((row) => {
            const identifier = legacyIdentifier(row.get('scheme'), row.get('value'), row.get('serial'));
            return { assetId: row.get('assetId') as string, key: randomUUID(),
              canonical: identifier.canonical, scheme: identifier.scheme,
              policyVersion: identifier.policyVersion };
          });
          await tx.run(`UNWIND $rows AS row
            MATCH (a:Asset {id: row.assetId})-[r:IDENTIFIED_BY]->(i:Identifier)
            DELETE r, i
            CREATE (a)-[:IDENTIFIED_BY]->(:IndividualIdentifier {
              key: row.key, canonical: row.canonical, scheme: row.scheme,
              policyVersion: row.policyVersion })`, { rows });
          return rows.length;
        });
        if (!migrated) return;
      }
    } finally { await session.close(); }
  }

  /** Startup invariant: no pre-Phase-2 identifier survives, and every stored
   * identifier carries the properties the GS1 boundary needs to rebuild it. */
  private static async verifyExternalIdentifiers(session: Session): Promise<void> {
    const legacy = await session.run('MATCH (i:Identifier) RETURN count(i) AS remaining');
    const remaining = legacy.records[0].get('remaining').toNumber();
    if (remaining) throw new Error(`${remaining} pre-Phase-2 Identifier node(s) could not be migrated`);
    const incomplete = await session.run(`MATCH (n)
      WHERE (n:IndividualIdentifier OR n:ClassIdentifier)
        AND (n.key IS NULL OR n.canonical IS NULL OR n.scheme IS NULL OR n.policyVersion IS NULL)
      RETURN count(n) AS invalid`);
    const invalid = incomplete.records[0].get('invalid').toNumber();
    if (invalid) throw new Error(`${invalid} external identifier(s) are missing required properties`);
  }

  private async write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session();
    try { return await session.executeWrite(work); }
    finally { await session.close(); }
  }

  private async createEntity(label: 'User' | 'Group' | 'Owner', value: string): Promise<Entity> {
    const entity = { key: randomUUID(), name: requiredText(value, 'name') };
    await this.write(async (tx) => { await tx.run(`CREATE (n:${label} $entity)`, { entity }); });
    return entity;
  }

  createUser(name: string) { return this.createEntity('User', name); }
  createGroup(name: string) { return this.createEntity('Group', name); }
  createOwner(name: string) { return this.createEntity('Owner', name); }

  async createReportingGroup(name: string, actorKey: string): Promise<Entity> {
    const group = { key: randomUUID(), name: requiredText(name, 'name') };
    return this.write(async (tx) => {
      const result = await tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.accountDeletedAt IS NULL
        CREATE (g:Group $group), (u)-[:MEMBER_OF]->(g) RETURN g.key`, { actorKey, group });
      if (!result.records.length) throw new ReferenceError('User does not exist');
      return group;
    });
  }

  async listGroups(actorKey: string): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)
        RETURN DISTINCT g { .key, .name } AS entity ORDER BY entity.name`, { actorKey }));
      return result.records.map((row) => row.get('entity') as Entity);
    } finally { await session.close(); }
  }

  async addGroupMember(actorKey: string, groupKey: string, userKey: string): Promise<boolean> {
    return this.write(async (tx) => {
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group {key: $groupKey})
        MATCH (u:User {key: $userKey}) WHERE u.accountDeletedAt IS NULL
        OPTIONAL MATCH (u)-[existing:MEMBER_OF]->(g)
        WITH u, g, existing IS NOT NULL AS alreadyMember
        MERGE (u)-[:MEMBER_OF]->(g) RETURN alreadyMember`, { actorKey, groupKey, userKey });
      if (!result.records.length) throw new ReferenceError('Group access or target User not found');
      return result.records[0].get('alreadyMember') !== true;
    });
  }

  async leaveGroup(actorKey: string, groupKey: string): Promise<void> {
    await this.write(async (tx) => {
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[m:MEMBER_OF]->(g:Group {key: $groupKey})
        DELETE m RETURN g.key`, { actorKey, groupKey });
      if (!result.records.length) throw new ReferenceError('Group membership not found');
    });
  }

  async addMember(userKey: string, groupKey: string): Promise<void> {
    const params = {
      userKey: requiredText(userKey, 'userKey'), groupKey: requiredText(groupKey, 'groupKey'),
    };
    await this.write(async (tx) => {
      const result = await tx.run(`MATCH (u:User {key: $userKey}), (g:Group {key: $groupKey})
        WHERE u.accountDeletedAt IS NULL
        MERGE (u)-[:MEMBER_OF]->(g) RETURN g.key`, params);
      if (!result.records.length) throw new ReferenceError('User or Group does not exist');
    });
  }

  async reportAsset(value: ReportAsset, context: ReportingContext, photoKey: string | null = null): Promise<Asset> {
    const input = record(value, ['name', 'identifiers', 'ownerKey']);
    const actor = record(context, ['actorKey', 'groupKey']);
    const identifiers = canonicalIdentifiers(input.identifiers);
    const params = {
      assetId: newAssetId(),
      name: requiredText(input.name, 'name'),
      actorKey: requiredText(actor.actorKey, 'actorKey'),
      groupKey: requiredText(actor.groupKey, 'groupKey'),
      ownerKey: input.ownerKey === undefined ? null : requiredText(input.ownerKey, 'ownerKey'),
      ...identifierParams(identifiers),
      photoKey,
    };
    try {
      return await this.write(async (tx) => {
        const policy = await tx.run("MATCH (s:Settings {key: 'instance'}) SET s.revision = s.revision + 1 RETURN s.requirePhoto AS required");
        if (!photoKey && policy.records[0].get('required')) throw new ValidationError('A photo is required when reporting an Asset');
        if (photoKey) await this.consumePhoto(tx, photoKey);
        const result = await tx.run(`
          MATCH (u:User {key: $actorKey})-[:MEMBER_OF]->(g:Group {key: $groupKey})
          OPTIONAL MATCH (o:Owner {key: $ownerKey})
          WITH u, g, o WHERE $ownerKey IS NULL OR o IS NOT NULL
          CREATE (a:Asset {id: $assetId, name: $name, reportedAt: datetime(), isPublic: false})
          CREATE (a)-[:REPORTED_BY]->(u), (g)-[:CAN_COLLABORATE]->(a)
          FOREACH (owner IN CASE WHEN o IS NULL THEN [] ELSE [o] END |
            CREATE (a)-[:OWNED_BY]->(owner))
          ${attachIdentifiers}
          WITH a
          OPTIONAL MATCH (m:Media {key: $photoKey})
          FOREACH (photo IN CASE WHEN m IS NULL THEN [] ELSE [m] END | CREATE (a)-[:HAS_PHOTO]->(photo))
          WITH a ${assetProjection}`, params);
        if (!result.records.length) {
          throw new ReferenceError('Reporter must belong to the selected Group and any Owner must exist');
        }
        return assetFrom(result.records[0].get('asset'));
      });
    } catch (error) {
      // CREATE, rather than MERGE, makes every second claim a conflict.
      // The database constraint arbitrates concurrent transactions atomically.
      if (isDuplicateIdentifier(error)) {
        throw new DuplicateIdentityError('The individual identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }

  async getAsset(id: string, actorKey: string | null): Promise<Asset | null> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(
        `${assetMatch} WHERE a.isPublic = true OR ${collaboration} ${assetProjection}`,
        { assetId: assetId(id), actorKey },
      ));
      return result.records.length ? assetFrom(result.records[0].get('asset')) : null;
    } finally { await session.close(); }
  }

  async findAssets(actorKey: string, { q: text, scope, limit, after }: AssetPageRequest): Promise<AssetPage> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        CALL {
          MATCH (a:Asset)
          WHERE a.isPublic = true OR ${collaboration}
          WITH a, toLower(a.name) CONTAINS toLower($text) AS matches,
            ${collaboration} AS inGroup,
            EXISTS { MATCH (a)-[:REPORTED_BY]->(:User {key: $actorKey}) } AS mine
          RETURN count(a) AS total,
            {all: count(CASE WHEN matches THEN 1 END),
             mine: count(CASE WHEN matches AND mine THEN 1 END),
             group: count(CASE WHEN matches AND inGroup THEN 1 END),
             public: count(CASE WHEN matches AND a.isPublic = true THEN 1 END)} AS scopes
        }
        CALL {
          MATCH (a:Asset)
          WHERE (a.isPublic = true OR ${collaboration}) AND toLower(a.name) CONTAINS toLower($text)
            AND ($scope = 'all' OR ($scope = 'public' AND a.isPublic = true)
              OR ($scope = 'group' AND ${collaboration})
              OR ($scope = 'mine' AND EXISTS { MATCH (a)-[:REPORTED_BY]->(:User {key: $actorKey}) }))
            AND ($after IS NULL OR a.name > $after.name
              OR (a.name = $after.name AND a.id > $after.id))
          WITH a ORDER BY a.name, a.id LIMIT $fetchSize
          MATCH (a)-[:REPORTED_BY]->(u:User)
          MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
          OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
          WITH a, u, o, collect(g { .key, .name }) AS groups
          ORDER BY a.name, a.id
          RETURN collect(a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
            reportedBy: { key: u.key,
              name: CASE WHEN u.accountDeletedAt IS NULL THEN u.name ELSE coalesce(u.provenanceName, u.name, 'Deleted member') END,
              status: CASE WHEN u.accountDeletedAt IS NULL THEN 'active' ELSE 'deleted' END },
            owner: o { .key, .name }, groups: groups, photos: [(a)-[:HAS_PHOTO]->(m:Media) |
              m { .key, .contentType, size: toFloat(m.size), createdAt: toString(m.createdAt) }]}) AS rows
        }
        RETURN total, scopes, rows`, { actorKey, text, scope, after, fetchSize: int(limit + 1) }));
      const row = result.records[0];
      const rows = row.get('rows') as StoredAsset[];
      const assets = rows.slice(0, limit).map(assetFrom);
      const scopes = Object.fromEntries(Object.entries(row.get('scopes')).map(([key, value]) =>
        [key, (value as { toNumber(): number }).toNumber()])) as Record<AssetScope, number>;
      return { assets, total: row.get('total').toNumber(), scopes, matching: scopes[scope],
        nextCursor: rows.length > limit ? assetCursor(text, assets.at(-1)!, scope) : null };
    } finally { await session.close(); }
  }

  async members(actorKey: string): Promise<Member[]> {
    return this.write(async (tx) => {
      const allowed = await tx.run("MATCH (:User {key: $actorKey, role: 'admin'}) RETURN true", { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const result = await tx.run(`MATCH (u:User) WHERE u.id IS NOT NULL RETURN ${memberProjection} AS member ORDER BY toLower(u.name), u.key`);
      return result.records.map((row) => row.get('member'));
    });
  }

  async profile(actorKey: string): Promise<Member> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL RETURN ${memberProjection} AS member`, { actorKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('member');
  }

  async ownDeletionBlocked(actorKey: string): Promise<boolean> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL
      OPTIONAL MATCH (administrator:User {role: 'admin'}) WHERE administrator.id IS NOT NULL
      WITH u, count(administrator) AS administratorCount
      RETURN u.role = 'admin' AND administratorCount <= 1 AS blocked`, { actorKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('blocked') === true;
  }

  async accountState(actorKey: string | null): Promise<AccountState> {
    if (!actorKey) return { isAdmin: false, appearance: 'system' };
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey})
      RETURN u.role = 'admin' AS isAdmin, coalesce(u.appearance, 'system') AS appearance`, { actorKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    const appearance = result.records[0].get('appearance');
    if (!isAppearancePreference(appearance)) throw new Error('Stored User appearance is invalid');
    return { isAdmin: result.records[0].get('isAdmin') === true, appearance };
  }

  async updateAppearance(actorKey: string, value: unknown): Promise<AppearancePreference> {
    const input = record(value, ['appearance']);
    if (!isAppearancePreference(input.appearance)) throw new ValidationError('Supported appearance is required');
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL
      SET u.appearance = $appearance RETURN u.appearance AS appearance`, { actorKey, appearance: input.appearance }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('appearance');
  }

  async memberAccount(actorKey: string, targetKey: string): Promise<MemberAccount> {
    const result = await this.write((tx) => tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}),
      (u:User {key: $targetKey}) WHERE u.id IS NOT NULL
      RETURN ${memberProjection} AS member, u.id AS id`, { actorKey, targetKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return { ...result.records[0].get('member'), id: result.records[0].get('id') };
  }

  async updateMemberRole(actorKey: string, targetKey: string, isAdmin: boolean): Promise<Member> {
    if (typeof isAdmin !== 'boolean') throw new ValidationError('Administrator status must be a boolean');
    return this.write(async (tx) => {
      // Serialize role changes before checking the actor and counting administrators.
      // Reuse the existing instance lock; no separate role or locking framework.
      await tx.run("MATCH (s:Settings {key: 'instance'}) SET s.revision = s.revision + 1 RETURN s.key");
      const allowed = await tx.run("MATCH (:User {key: $actorKey, role: 'admin'}) RETURN true", { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const target = await tx.run("MATCH (u:User {key: $targetKey}) WHERE u.id IS NOT NULL RETURN u.role = 'admin' AS admin", { targetKey });
      if (!target.records.length) throw new ReferenceError('User not found');
      if (!isAdmin && target.records[0].get('admin') === true) {
        const count = await tx.run("MATCH (u:User {role: 'admin'}) WHERE u.id IS NOT NULL RETURN count(u) AS count");
        if (count.records[0].get('count').toNumber() <= 1) throw new LastAdministratorError('The final system administrator cannot be removed');
      }
      const result = await tx.run(`MATCH (u:User {key: $targetKey})
        SET u.role = $role, u.updatedAt = $updatedAt
        RETURN ${memberProjection} AS member`, { targetKey, updatedAt: new Date().toISOString(), role: isAdmin ? 'admin' : 'user' });
      return result.records[0].get('member');
    });
  }

  async deactivateMember(actorKey: string, targetKey: string): Promise<void> {
    await this.deactivateAccount(actorKey, targetKey, 'administrator');
  }

  async deactivateOwnAccount(actorKey: string): Promise<void> {
    await this.deactivateAccount(actorKey, actorKey, 'self');
  }

  private async deactivateAccount(actorKey: string, targetKey: string,
    authority: 'administrator' | 'self'): Promise<void> {
    await this.write(async (tx) => {
      await tx.run("MATCH (s:Settings {key: 'instance'}) SET s.revision = s.revision + 1 RETURN s.key");
      if (authority === 'administrator') {
        const actor = await tx.run("MATCH (u:User {key: $actorKey, role: 'admin'}) WHERE u.id IS NOT NULL RETURN u.key", { actorKey });
        if (!actor.records.length) throw new AdministrationError('Administrator access required');
        if (actorKey === targetKey) throw new AdministrationError('Delete your own account from Profile');
      }
      const target = await tx.run(`MATCH (u:User {key: $targetKey}) WHERE u.id IS NOT NULL
        RETURN u.id AS id, u.role = 'admin' AS admin`, { targetKey });
      if (!target.records.length) throw new ReferenceError('User not found');
      if (target.records[0].get('admin') === true) {
        const count = await tx.run("MATCH (u:User {role: 'admin'}) WHERE u.id IS NOT NULL RETURN count(u) AS count");
        if (count.records[0].get('count').toNumber() <= 1) throw new LastAdministratorError('The final system administrator cannot be removed');
      }
      const userId = target.records[0].get('id');
      await tx.run(`MATCH (u:User {key: $targetKey})
        OPTIONAL MATCH (u)-[:HAS_AUTHSESSION]->(s:AuthSession)
        OPTIONAL MATCH (u)-[:HAS_AUTHACCOUNT]->(a:AuthAccount)
        DETACH DELETE s, a`, { targetKey });
      await tx.run(`MATCH (v:AuthVerification) WHERE v.value = $userId DETACH DELETE v`, { userId });
      await tx.run(`MATCH (u:User {key: $targetKey})-[m:MEMBER_OF]->(:Group) DELETE m`, { targetKey });
      await tx.run(`MATCH (u:User {key: $targetKey})
        SET u.provenanceName = u.name, u.accountDeletedAt = $deletedAt
        REMOVE u.id, u.name, u.email, u.emailVerified, u.image, u.createdAt, u.updatedAt, u.appearance, u.role,
          u.banned, u.banReason, u.banExpires`, { targetKey, deletedAt: new Date().toISOString() });
    });
  }

  async settings(): Promise<Settings> {
    const result = await this.write((tx) => tx.run("MATCH (s:Settings {key: 'instance'}) RETURN s { .requirePhoto, .displayTimezone, .themeId } AS settings"));
    return result.records[0].get('settings');
  }

  async updateSettings(actorKey: string, value: unknown): Promise<Settings> {
    const settings = validateSettings(value);
    return this.write(async (tx) => {
      const result = await tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}), (s:Settings {key: 'instance'})
        SET s.revision = s.revision + 1, s.requirePhoto = $settings.requirePhoto,
          s.displayTimezone = $settings.displayTimezone, s.themeId = $settings.themeId
        RETURN s.key`, { actorKey, settings });
      if (!result.records.length) throw new ReferenceError('Administrator access required');
      return settings;
    });
  }

  private static mailProjection = `m { revision: toFloat(m.revision), .enabled, .transport, .smtpHost,
    smtpPort: toFloat(m.smtpPort), .smtpSecurity, .smtpUsername, .smtpPasswordEnvelope,
    .senderAddress, .senderName, verificationStatus: coalesce(m.verificationStatus, 'not-verified'),
    verificationObservedAt: m.verificationObservedAt }`;

  async hasEncryptedSecrets(): Promise<boolean> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(
        "MATCH (m:MailConfiguration {key: 'instance'}) RETURN m.smtpPasswordEnvelope IS NOT NULL AS present"));
      return result.records[0]?.get('present') === true;
    } finally { await session.close(); }
  }

  async readMailConfiguration(actorKey: string): Promise<StoredMailConfiguration> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`MATCH (:User {key: $actorKey, role: 'admin'})
        MATCH (m:MailConfiguration {key: 'instance'}) RETURN ${IdentityStore.mailProjection} AS configuration`, { actorKey }));
      if (!result.records.length) throw new AdministrationError('Administrator access required');
      return result.records[0].get('configuration');
    } finally { await session.close(); }
  }

  async effectiveMailConfiguration(): Promise<StoredMailConfiguration> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(
        `MATCH (m:MailConfiguration {key: 'instance'}) RETURN ${IdentityStore.mailProjection} AS configuration`));
      return result.records[0].get('configuration');
    } finally { await session.close(); }
  }

  async replaceMailConfiguration(actorKey: string, expectedRevision: number,
    configuration: PersistedMailSettings): Promise<StoredMailConfiguration> {
    return this.write(async (tx) => {
      const allowed = await tx.run("MATCH (u:User {key: $actorKey, role: 'admin'}) RETURN u.key", { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const result = await tx.run(`MATCH (m:MailConfiguration {key: 'instance', revision: $expectedRevision})
        SET m += $configuration, m.revision = m.revision + 1
        SET m.verificationStatus = 'not-verified'
        REMOVE m.verificationObservedAt
        RETURN ${IdentityStore.mailProjection} AS configuration`, { expectedRevision, configuration });
      if (!result.records.length) throw new MailRevisionConflictError('Mail configuration changed; reload and try again');
      return result.records[0].get('configuration');
    });
  }

  async recordMailVerification(expectedRevision: number, status: MailVerificationStatus,
    observedAt: string): Promise<StoredMailConfiguration | null> {
    return this.write(async (tx) => {
      const result = await tx.run(`MATCH (m:MailConfiguration {key: 'instance', revision: $expectedRevision})
        SET m.verificationStatus = $status, m.verificationObservedAt = $observedAt
        RETURN ${IdentityStore.mailProjection} AS configuration`, { expectedRevision, status, observedAt });
      return result.records[0]?.get('configuration') ?? null;
    });
  }

  async resetEncryptedSecrets(actorKey: string, expectedRevision: number): Promise<StoredMailConfiguration> {
    return this.write(async (tx) => {
      const allowed = await tx.run("MATCH (u:User {key: $actorKey, role: 'admin'}) RETURN u.key", { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const result = await tx.run(`MATCH (m:MailConfiguration {key: 'instance', revision: $expectedRevision})
        SET m.enabled = false, m.revision = m.revision + 1, m.verificationStatus = 'not-verified'
        REMOVE m.smtpUsername, m.smtpPasswordEnvelope, m.verificationObservedAt
        RETURN ${IdentityStore.mailProjection} AS configuration`, { expectedRevision });
      if (!result.records.length) throw new MailRevisionConflictError('Mail configuration changed; reload and try again');
      return result.records[0].get('configuration');
    });
  }

  /** Attach an external identifier to an existing Asset. Group authorization is
   * unchanged and identifier knowledge grants nothing: the caller must already
   * be able to edit the Asset. Phase 3 allocation will attach through here. */
  async attachIdentifier(id: string, actorKey: string, value: unknown): Promise<Asset> {
    const identifier = canonicalIdentifier(value);
    const assetKey = assetId(id);
    try {
      return await this.write(async (tx) => {
        const current = await tx.run(`${assetMatch} WHERE ${collaboration}
          RETURN [(a)-[:IDENTIFIED_BY]->(x:IndividualIdentifier) | x { .canonical, .scheme, .policyVersion }]
            + [(a)-[:CLASSIFIED_AS]->(y:ClassIdentifier) | y { .canonical, .scheme, .policyVersion }] AS identifiers`,
        { assetId: assetKey, actorKey });
        if (!current.records.length) throw new ReferenceError('Asset access not found');
        const existing = (current.records[0].get('identifiers') as StoredIdentifier[])
          .map((row) => storedIdentifier(row.scheme, row.canonical, row.policyVersion));
        assertCompatible([...existing, identifier]);
        const result = await tx.run(`${assetMatch} WHERE ${collaboration}
          ${attachIdentifiers}
          WITH a ${assetProjection}`, { assetId: assetKey, actorKey, ...identifierParams([identifier]) });
        return assetFrom(result.records[0].get('asset'));
      });
    } catch (error) {
      if (isDuplicateIdentifier(error)) {
        throw new DuplicateIdentityError('The individual identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }

  /** Detach an identifier by its attachment key. An individual identifier is
   * exclusive, so its node goes with the link; a class identifier node stays
   * while any other Asset still refers to it. */
  async detachIdentifier(id: string, actorKey: string, key: string): Promise<Asset> {
    const assetKey = assetId(id);
    const identifierKey = requiredText(key, 'identifier key');
    return this.write(async (tx) => {
      const detached = await tx.run(`${assetMatch} WHERE ${collaboration}
        OPTIONAL MATCH (a)-[individualLink:IDENTIFIED_BY]->(individual:IndividualIdentifier {key: $key})
        OPTIONAL MATCH (a)-[classLink:CLASSIFIED_AS]->(:ClassIdentifier {key: $key})
        WITH a, individualLink, individual, classLink
        WHERE individualLink IS NOT NULL OR classLink IS NOT NULL
        DELETE individualLink, classLink
        WITH a, individual
        FOREACH (node IN CASE WHEN individual IS NULL THEN [] ELSE [individual] END | DELETE node)
        RETURN a.id AS id`, { assetId: assetKey, actorKey, key: identifierKey });
      if (!detached.records.length) throw new ReferenceError('Asset access or identifier not found');
      await tx.run(`MATCH (c:ClassIdentifier {key: $key})
        WHERE NOT EXISTS { ()-[:CLASSIFIED_AS]->(c) } DELETE c`, { key: identifierKey });
      const result = await tx.run(`${assetMatch} WHERE ${collaboration} ${assetProjection}`,
        { assetId: assetKey, actorKey });
      return assetFrom(result.records[0].get('asset'));
    });
  }

  async assertCanEdit(id: string, actorKey: string) {
    const result = await this.write((tx) => tx.run(`${assetMatch} WHERE ${collaboration} RETURN a.name`, { assetId: assetId(id), actorKey }));
    if (!result.records.length) throw new ReferenceError('Asset access not found');
  }

  async reservePhoto(contentType: string, size: number): Promise<string> {
    const key = randomUUID();
    await this.write((tx) => tx.run(`CREATE (:Media {key: $key, contentType: $contentType, size: $size,
      state: 'pending', createdAt: datetime(), expiresAt: datetime() + duration('PT10M')})`, { key, contentType, size }));
    return key;
  }

  private async consumePhoto(tx: ManagedTransaction, key: string) {
    // The write acquires a node lock before checking state and the upload lease.
    const result = await tx.run(`MATCH (m:Media {key: $key}) SET m.lock = true
      WITH m WHERE m.state = 'pending' AND m.expiresAt > datetime()
      SET m.state = 'attached' REMOVE m.expiresAt RETURN m.key`, { key });
    if (!result.records.length) throw new ValidationError('Photo upload expired or unavailable');
  }

  async attachPhoto(id: string, actorKey: string, photoKey: string): Promise<Asset> {
    return this.write(async (tx) => {
      await this.consumePhoto(tx, photoKey);
      const result = await tx.run(`${assetMatch} WHERE ${collaboration}
        MATCH (m:Media {key: $photoKey}) CREATE (a)-[:HAS_PHOTO]->(m)
        WITH a ${assetProjection}`, { assetId: assetId(id), actorKey, photoKey });
      if (!result.records.length) throw new ReferenceError('Asset access not found');
      return assetFrom(result.records[0].get('asset'));
    });
  }

  async beginPhotoDeletion(id: string, actorKey: string, photoKey: string): Promise<void> {
    const result = await this.write((tx) => tx.run(`${assetMatch} WHERE ${collaboration}
      MATCH (a)-[relationship:HAS_PHOTO]->(m:Media {key: $photoKey, state: 'attached'})
      SET m.state = 'deleting', m.expiresAt = datetime()
      DELETE relationship
      RETURN m.key`, {
      assetId: assetId(id), actorKey,
      photoKey: requiredText(photoKey, 'photoKey'),
    }));
    if (!result.records.length) throw new ReferenceError('Asset access or photo not found');
  }

  async getPhoto(id: string, key: string, actorKey: string | null): Promise<Photo> {
    const asset = await this.getAsset(id, actorKey);
    const photo = asset?.photos.find((p) => p.key === key);
    if (!photo) throw new ReferenceError('Photo not found');
    return photo;
  }

  async claimPhotoCleanup(key?: string): Promise<string[]> {
    const result = await this.write((tx) => tx.run(`MATCH (m:Media)
      WHERE ($key IS NULL AND (m.state = 'deleting' OR (m.state = 'pending' AND m.expiresAt <= datetime()))) OR m.key = $key
      SET m.lock = true
      WITH m WHERE m.state IN ['pending', 'deleting']
      SET m.state = 'deleting' RETURN m.key AS key`, { key: key ?? null }));
    return result.records.map((r) => r.get('key'));
  }

  async finishPhotoCleanup(key: string) {
    await this.write((tx) => tx.run("MATCH (m:Media {key: $key, state: 'deleting'}) WHERE m.expiresAt <= datetime() DELETE m", { key }));
  }

  async updateAsset(id: string, changes: AssetChanges, actorKey: string): Promise<Asset> {
    const input = record(changes, ['name', 'ownerKey', 'isPublic']);
    if (Object.hasOwn(input, 'isPublic') && typeof input.isPublic !== 'boolean') {
      throw new ValidationError('isPublic must be a boolean');
    }
    if (!Object.keys(input).length) throw new ValidationError('At least one change is required');
    const params = {
      assetId: assetId(id),
      actorKey,
      isPublic: input.isPublic ?? null,
      name: Object.hasOwn(input, 'name') ? requiredText(input.name, 'name') : null,
      changeOwner: Object.hasOwn(input, 'ownerKey'),
      ownerKey: input.ownerKey === null || !Object.hasOwn(input, 'ownerKey')
        ? null : requiredText(input.ownerKey, 'ownerKey'),
    };
    return this.write(async (tx) => {
      const result = await tx.run(`${assetMatch} WHERE ${collaboration}
        OPTIONAL MATCH (owner:Owner {key: $ownerKey})
        WITH a, owner WHERE $ownerKey IS NULL OR owner IS NOT NULL
        // Lock the Asset before changing its single Owner relationship.
        SET a.name = coalesce($name, a.name), a.isPublic = coalesce($isPublic, a.isPublic)
        WITH a, owner
        OPTIONAL MATCH (a)-[old:OWNED_BY]->(:Owner)
        FOREACH (r IN CASE WHEN $changeOwner THEN [old] ELSE [] END | DELETE r)
        WITH DISTINCT a, owner
        FOREACH (o IN CASE WHEN $changeOwner AND owner IS NOT NULL THEN [owner] ELSE [] END |
          CREATE (a)-[:OWNED_BY]->(o))
        WITH a ${assetProjection}`, params);
      if (!result.records.length) throw new ReferenceError('Asset or Owner does not exist');
      return assetFrom(result.records[0].get('asset'));
    });
  }
}
