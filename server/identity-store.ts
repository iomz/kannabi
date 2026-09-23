import { randomUUID } from 'node:crypto';
import { validateSettings, type Settings } from './settings.js';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import neo4j, { int } from 'neo4j-driver';
import {
  assetCursor, type AssetDirection, type AssetFilters, type AssetPageRequest, type AssetScope,
  type AssetSort,
} from './asset-page.js';
import { assetLookupCursor, type AssetLookupRequest } from './asset-lookup.js';
import { giaiLedgerCursor, type GiaiLedgerRequest } from './giai-ledger.js';
import { audienceParameters, type AudienceInput, type NamedAudienceInput } from './asset-audience.js';
import { assetId, assetIdPattern, newAssetId } from './asset-id.js';
import { record, requiredText, ValidationError } from './identity.js';
import { changeParams, type ChangeOrigin, type ChangeProvenance } from './change-provenance.js';
import { externalIdentityKey } from './external-principal.js';
import {
  allocatedGiai, assertCompatible, canonicalGcp, canonicalIdentifier, canonicalIdentifiers,
  storedIdentifier, type ExternalIdentifier, type IdentifierLevel, type IdentifierScheme,
} from './gs1.js';
import {
  allocatableSequence, canonicalExclusions, firstSequence, storedExclusions, type ExclusionRange,
} from './giai-allocation.js';
import { isAppearancePreference, type AppearancePreference } from '../shared/appearance.js';
import { MailRevisionConflictError, type MailVerificationStatus, type PersistedMailSettings,
  type StoredMailConfiguration } from './mail.js';

export class DuplicateIdentityError extends Error {}
export class ReferenceError extends Error {}
export class AdministrationError extends Error {}
export class LastAdministratorError extends Error {}
/** A User an external principal resolved to. Deliberately thin: resolution
 * answers who is acting, and every later authorization decision is made from
 * the Group model as usual rather than from anything carried here. */
export type ResolvedUser = Readonly<{ key: string; name: string }>;
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
  /** Derived from the issuance ledger, not from any identifier property. */
  allocation: GiaiAllocation | null;
  reportedBy: ReporterAttribution;
  reportedAt: string;
  /** Null only for an Asset last written before Kannabi recorded this; it
   * never means the Asset has not changed. */
  provenance: ChangeProvenance | null;
  owner: Entity | null;
  groups: readonly Entity[];
  isPublic: boolean;
  photos: readonly Photo[];
}>;
export type Photo = { key: string; contentType: string; size: number; createdAt: string | null };

/** A GS1 Company Prefix namespace a Group has configured for allocation.
 * `active` is configuration state, never allocation lifecycle. */
export type GiaiNamespace = Readonly<{
  key: string;
  gcp: string;
  active: boolean;
  exclusions: readonly ExclusionRange[];
  nextSequence: number;
  group: Entity;
  configuredAt: string;
  configuredBy: string;
}>;

/** One immutable issuance. Kannabi's claim to have allocated a GIAI rests on
 * this record and nothing else — never on an Asset merely carrying a value. */
export type GiaiAllocation = Readonly<{
  value: string;
  gcp: string;
  sequence: number;
  allocatedAt: string;
  allocatedForAssetId: string;
  /** Public provenance in the same shape as `reportedBy`: who acted, rendered
   * through the same tombstone rules, never a bare stored actor key. */
  allocatedBy: ReporterAttribution;
}>;

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
const namespaceProjection = `n { .key, .gcp, .active, .configuredBy,
  configuredAt: toString(n.configuredAt), nextSequence: toFloat(n.nextSequence),
  exclusionsFrom: n.exclusionsFrom, exclusionsTo: n.exclusionsTo,
  group: head([(n)<-[:MANAGES_NAMESPACE]-(g:Group) | g { .key, .name }]) }`;

type StoredNamespace = Omit<GiaiNamespace, 'exclusions'>
  & { exclusionsFrom: unknown; exclusionsTo: unknown };

function namespaceFrom(stored: StoredNamespace): GiaiNamespace {
  const { exclusionsFrom, exclusionsTo, ...namespace } = stored;
  return { ...namespace, exclusions: storedExclusions(exclusionsFrom, exclusionsTo) };
}

/** Components and level are always re-derived from the canonical form, so a
 * stored identifier cannot become an independent source of GS1 truth. */
function assetFrom(stored: StoredAsset): Asset {
  const identifiers = stored.identifiers
    .map((row) => ({ key: row.key, ...storedIdentifier(row.scheme, row.canonical, row.policyVersion) }))
    .sort((left, right) => (left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0));
  return { ...stored, identifiers, photos: orderPhotos(stored.photos) };
}
export type AssetPage = { assets: Asset[]; total: number; matching: number; scopes: Record<AssetScope, number>; nextCursor: string | null };

/** The resolved identity, echoed from the caller's own input so they can see
 * what it canonicalised to. It is derived before any Asset is read and
 * therefore discloses nothing about what exists. */
export type ResolvedIdentity =
  | Readonly<{ kind: 'assetId'; id: string }>
  | Readonly<{ kind: 'identifier'; canonical: string; scheme: IdentifierScheme; level: IdentifierLevel }>;

/** A native Asset ID and an individual identifier each resolve to at most one
 * Asset; a class identifier describes a class, so it legitimately resolves to
 * many. `assets` is therefore always a list, `matching` reports the complete
 * readable count, and `nextCursor` pages through a class identifier's Assets. */
export type AssetLookup = Readonly<{
  identity: ResolvedIdentity;
  assets: readonly Asset[];
  matching: number;
  nextCursor: string | null;
}>;
/** One ledger row together with the Asset it was issued for, when the audience
 * may read that Asset. `asset` is null for an issuance whose Asset is not
 * readable: the issuance is a Kannabi-owned fact, but it grants no Asset
 * access. */
export type GiaiIssuance = Readonly<{ allocation: GiaiAllocation; asset: Asset | null }>;
export type GiaiIssuancePage = Readonly<{
  namespace: GiaiNamespace;
  issuances: readonly GiaiIssuance[];
  matching: number;
  nextCursor: string | null;
}>;
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
  // One external identity belongs to at most one User. The canonical form
  // carries both the issuer and the subject, because the same subject string
  // from two issuers is two different people.
  'CREATE CONSTRAINT external_identity IF NOT EXISTS FOR (n:ExternalIdentity) REQUIRE n.canonical IS UNIQUE',
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
  // One GCP has exactly one allocation counter, so a prefix can never be
  // configured twice and issue the same reference from two counters.
  'CREATE CONSTRAINT giai_namespace_key IF NOT EXISTS FOR (n:GiaiNamespace) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT giai_namespace_gcp IF NOT EXISTS FOR (n:GiaiNamespace) REQUIRE n.gcp IS UNIQUE',
  // A GIAI is issued once, and Kannabi issues at most one per Asset. Both are
  // schema facts rather than application sequencing.
  'CREATE CONSTRAINT giai_allocation_value IF NOT EXISTS FOR (n:GiaiAllocation) REQUIRE n.value IS UNIQUE',
  'CREATE CONSTRAINT giai_allocation_asset IF NOT EXISTS FOR (n:GiaiAllocation) REQUIRE n.allocatedForAssetId IS UNIQUE',
];

// Installed only once every Asset carries a native id, so a pre-Phase-1
// database is not rejected before its Assets can be migrated.
const assetIdConstraint = 'CREATE CONSTRAINT asset_id IF NOT EXISTS FOR (n:Asset) REQUIRE n.id IS UNIQUE';

/** Range indexes backing the sortable Asset fields.
 *
 * Measured rather than assumed: profiling the browse query showed that with
 * these indexes a keyset continuation page plans as NodeIndexSeekByRange
 * instead of NodeByLabelScan, so deep paging stops re-scanning the label. The
 * first page of a search still scans, because there is no range predicate to
 * seek on and the readability check is applied afterwards.
 *
 * These are performance, not correctness, so unlike the uniqueness constraints
 * they are not part of the fail-closed startup verification: a missing index
 * makes Kannabi slower, never wrong.
 */
const indexes = [
  'CREATE INDEX asset_name IF NOT EXISTS FOR (n:Asset) ON (n.name)',
  'CREATE INDEX asset_reported_at IF NOT EXISTS FOR (n:Asset) ON (n.reportedAt)',
];

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

/** Public attribution for a stored actor key.
 *
 * The key is projected from the stored value rather than from the node,
 * because an actor key outlives the account it names: a provenance record must
 * still render after the account is gone, and it must render a tombstone
 * rather than the person. `node` is therefore allowed to be null even where a
 * particular caller knows it cannot be.
 */
const attribution = (node: string, key: string) => `{ key: ${key},
        name: CASE WHEN ${node} IS NULL THEN 'Deleted member'
          WHEN ${node}.accountDeletedAt IS NULL THEN ${node}.name
          ELSE coalesce(${node}.provenanceName, ${node}.name, 'Deleted member') END,
        status: CASE WHEN ${node} IS NOT NULL AND ${node}.accountDeletedAt IS NULL
          THEN 'active' ELSE 'deleted' END }`;

/** One issuance as the domain sees it. Requires `issuance` and `allocator` in
 * scope. Shared by the Asset projection and by the ledger read, so an Asset's
 * allocation and a namespace's issuance can never describe the same record
 * differently. */
const allocationProjection = `issuance { .value, .gcp, sequence: toFloat(issuance.sequence),
      allocatedAt: toString(issuance.allocatedAt), .allocatedForAssetId,
      allocatedBy: ${attribution('allocator', 'issuance.allocatedBy')} }`;

const identifierProjection = `
    identifiers: [(a)-[:IDENTIFIED_BY]->(x:IndividualIdentifier) |
        x { .key, .canonical, .scheme, .policyVersion }]
      + [(a)-[:CLASSIFIED_AS]->(y:ClassIdentifier) |
        y { .key, .canonical, .scheme, .policyVersion }],
    allocation: ${allocationProjection},`

// The ledger row is found by the Asset id it records, which is unique, so this
// cannot multiply rows and needs no relationship to the Asset to survive one.
// The ledger stores an actor key; the allocator is resolved here so the public
// representation carries attribution rather than that internal key alone.
const allocationMatch = `OPTIONAL MATCH (issuance:GiaiAllocation {allocatedForAssetId: a.id})
  OPTIONAL MATCH (allocator:User {key: issuance.allocatedBy})`;

/** Resolves the accepting User of the Asset's most recent canonical change.
 * Optional in both directions: an Asset may predate this record, and the
 * account may since have been deleted. Requires `a` in scope, yields
 * `acceptor`, and cannot multiply rows because the User key is unique. */
const changeMatch = 'OPTIONAL MATCH (acceptor:User {key: a.changeAcceptedBy})';

/** Bounded change provenance as the domain sees it. Requires `a` and
 * `acceptor` in scope. The whole record is absent together: an Asset written
 * before Kannabi recorded this has no half-filled provenance. */
const changeProjection = `CASE WHEN a.changeAcceptedAt IS NULL THEN null ELSE {
      assertedBy: CASE WHEN a.changeAssertedById IS NULL THEN null
        ELSE { id: a.changeAssertedById, label: a.changeAssertedByLabel } END,
      acceptedBy: ${attribution('acceptor', 'a.changeAcceptedBy')},
      acceptedAt: toString(a.changeAcceptedAt), basis: a.changeBasis } END`;

/** Stamps the Asset with who made this change true. Requires `a` in scope plus
 * `$actorKey` and the parameters `changeParams` produces.
 *
 * It is a clause in the same statement as the change it describes, so the two
 * commit or fail together: provenance can never be missing for a change that
 * happened, or present for one that did not.
 */
const recordChange = `SET a.changeAcceptedBy = $actorKey, a.changeAcceptedAt = datetime(),
    a.changeAssertedById = $assertedById, a.changeAssertedByLabel = $assertedByLabel,
    a.changeBasis = $basis`;

/** How each sortable field is ordered and compared in Cypher.
 *
 * `reportedAt` is compared as a temporal value, not as text: the cursor carries
 * the ISO instant the API returns and Cypher parses it back, so sub-second
 * formatting can never decide ordering. `Asset.id` is appended to every
 * ordering purely to make it total.
 */
const sortExpressions: Readonly<Record<AssetSort, { order: string; bound: string }>> = {
  name: { order: 'a.name', bound: '$after.key' },
  reportedAt: { order: 'a.reportedAt', bound: 'datetime($after.key)' },
};

/** Keyset continuation. The tiebreaker follows the primary direction so the
 * total ordering reverses coherently and a page boundary inside a run of
 * duplicate sort values neither repeats nor skips an Asset. */
function keysetPredicate(sort: AssetSort, dir: AssetDirection): string {
  const { order, bound } = sortExpressions[sort];
  const comparison = dir === 'asc' ? '>' : '<';
  return `($after IS NULL OR ${order} ${comparison} ${bound}
    OR (${order} = ${bound} AND a.id ${comparison} $after.id))`;
}

/** Structured discovery predicates, applied inside the readability boundary so
 * a filter can only ever narrow what the caller may already see. Each filter is
 * inert when unset, which keeps one predicate valid for every combination. */
const filterPredicate = `
  (size($groups) = 0 OR EXISTS {
    MATCH (fg:Group)-[:CAN_COLLABORATE]->(a) WHERE fg.key IN $groups })
  AND (size($schemes) = 0 OR EXISTS {
    MATCH (a)-[:IDENTIFIED_BY|CLASSIFIED_AS]->(fi) WHERE fi.scheme IN $schemes })
  AND ($identified IS NULL
    OR ($identified = 'any' AND EXISTS { MATCH (a)-[:IDENTIFIED_BY|CLASSIFIED_AS]->() })
    OR ($identified = 'none' AND NOT EXISTS { MATCH (a)-[:IDENTIFIED_BY|CLASSIFIED_AS]->() }))
  AND ($reportedFrom IS NULL OR a.reportedAt >= datetime($reportedFrom))
  AND ($reportedTo IS NULL
    OR ($reportedToEndOfDay AND a.reportedAt < datetime($reportedTo) + duration({days: 1}))
    OR (NOT $reportedToEndOfDay AND a.reportedAt <= datetime($reportedTo)))`;

function filterParameters(filters: AssetFilters) {
  return {
    groups: filters.groups,
    schemes: filters.schemes,
    identified: filters.identified,
    reportedFrom: filters.reportedFrom,
    // A date-only bound covers the whole day, so it compares against the start
    // of the next one. Carrying the caller's own value and advancing it here
    // keeps the URL, the chip and the date control showing the chosen day.
    reportedTo: filters.reportedTo,
    reportedToEndOfDay: filters.reportedToEndOfDay,
  };
}

function orderClause(sort: AssetSort, dir: AssetDirection): string {
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sortExpressions[sort].order} ${direction}, a.id ${direction}`;
}

/** Projects a page of Assets already narrowed and ordered by the caller.
 * Requires `a` in scope and yields `rows`. Shared so browse and lookup cannot
 * drift into returning different Asset representations. */
const assetRowsProjection = (order: string) => `
  MATCH (a)-[:REPORTED_BY]->(u:User)
  MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
  OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
  ${allocationMatch}
  ${changeMatch}
  WITH a, u, o, issuance, allocator, acceptor, collect(g { .key, .name }) AS groups
  ${order}
  RETURN collect(a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
    reportedBy: ${attribution('u', 'u.key')}, provenance: ${changeProjection},
    owner: o { .key, .name }, groups: groups, photos: [(a)-[:HAS_PHOTO]->(m:Media) |
      m { .key, .contentType, size: toFloat(m.size), createdAt: toString(m.createdAt) }]}) AS rows`;

/** Which GIAI namespaces an audience may see. Requires `n` in scope. */
const visibleNamespace = `($systemRead OR EXISTS {
  MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(:Group)-[:MANAGES_NAMESPACE]->(n) })`;

const assetMatch = 'MATCH (a:Asset {id: $assetId})';
const collaboration = `EXISTS {
  MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(:Group)-[:CAN_COLLABORATE]->(a)
}`;
/** The one readability rule, as Cypher. Requires `a` in scope and the
 * parameters `audienceParameters` produces.
 *
 * `$systemRead` is the accepted system-wide audience of the local MCP process;
 * it is a parameter rather than a second query so every read path provably
 * shares this predicate and a narrower audience can be introduced later without
 * touching a query. `$actorKey` is null for every audience but `user`, so the
 * collaboration branch is simply unsatisfied there.
 */
const readableAsset = `($systemRead OR a.isPublic = true OR ${collaboration})`;
const assetProjection = `
  MATCH (a)-[:REPORTED_BY]->(u:User)
  MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
  OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
  ${allocationMatch}
  ${changeMatch}
  WITH a, u, o, issuance, allocator, acceptor, collect(g { .key, .name }) AS groups
  RETURN a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
    reportedBy: ${attribution('u', 'u.key')}, provenance: ${changeProjection},
    owner: o { .key, .name },
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
      for (const statement of indexes) await session.run(statement);
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
      await IdentityStore.verifyConstraints(session);
    } finally {
      await session.close();
    }
    return new IdentityStore(driver);
  }

  /** Attach to a database Kannabi has already opened, without writing to it.
   *
   * `open` installs constraints, backfills native Asset ids and migrates
   * identifiers, all of which are writes. A read-only consumer — the stdio MCP
   * server — must do none of that, so it verifies the same invariants instead
   * and fails closed on a database the application has never opened. It never
   * repairs one.
   */
  static async attachReadOnly(driver: Driver): Promise<IdentityStore> {
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    try { await IdentityStore.verifyConstraints(session); }
    finally { await session.close(); }
    return new IdentityStore(driver);
  }

  /** Startup invariant: every uniqueness constraint the domain relies on is
   * installed. Reading `SHOW CONSTRAINTS` never modifies the database, so both
   * the read-write and the read-only entry can assert it. */
  private static async verifyConstraints(session: Session): Promise<void> {
    const result = await session.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties RETURN *');
    for (const [label, properties] of [
      ['Settings', ['key']], ['MailConfiguration', ['key']], ['Media', ['key']], ['User', ['key']], ['Group', ['key']], ['Owner', ['key']],
      ['Migration', ['key']], ['Asset', ['id']], ['ExternalIdentity', ['canonical']],
      ['IndividualIdentifier', ['canonical']], ['IndividualIdentifier', ['key']],
      ['ClassIdentifier', ['canonical']], ['ClassIdentifier', ['key']],
      ['GiaiNamespace', ['key']], ['GiaiNamespace', ['gcp']],
      ['GiaiAllocation', ['value']], ['GiaiAllocation', ['allocatedForAssetId']],
    ] as const) {
      if (!result.records.some((row) => row.get('type') === 'UNIQUENESS'
        && JSON.stringify(row.get('labelsOrTypes')) === JSON.stringify([label])
        && JSON.stringify(row.get('properties')) === JSON.stringify(properties))) {
        throw new Error(`Required uniqueness constraint is missing for ${label}`);
      }
    }
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

  /** The Groups the audience may see: its own memberships, or every Group
   * under the system audience. A Group is a discovery vocabulary, never an
   * access grant: naming one still reaches only Assets the audience may read. */
  async listGroups(audience: NamedAudienceInput): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (g:Group)
        WHERE $systemRead OR EXISTS { MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g) }
        RETURN DISTINCT g { .key, .name } AS entity ORDER BY entity.name`,
      audienceParameters(audience)));
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

  async reportAsset(value: ReportAsset, context: ReportingContext, photoKey: string | null = null,
    origin: ChangeOrigin = {}): Promise<Asset> {
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
      ...changeParams(origin),
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
          ${recordChange}
          WITH a, u, g, o
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

  async getAsset(id: string, audience: AudienceInput): Promise<Asset | null> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(
        `${assetMatch} WHERE ${readableAsset} ${assetProjection}`,
        { assetId: assetId(id), ...audienceParameters(audience) },
      ));
      return result.records.length ? assetFrom(result.records[0].get('asset')) : null;
    } finally { await session.close(); }
  }

  /** Resolve a complete identity to the Assets that carry it.
   *
   * Runs over the caller-readable set, so an identity that exists but is not
   * readable is indistinguishable from one that does not exist: both return no
   * Assets and a matching count of zero. Lookup grants no access of its own.
   *
   * An individual identifier is matched on its canonical form against the
   * unique-constrained node for its level — never by substring, and never by
   * treating a prefix as allocation provenance.
   */
  async lookupAssets(audience: NamedAudienceInput, request: AssetLookupRequest): Promise<AssetLookup> {
    const { identity: query, limit, after } = request;
    if (query.kind === 'assetId') {
      const asset = await this.getAsset(query.id, audience);
      return Object.freeze({ identity: Object.freeze({ kind: 'assetId' as const, id: query.id }),
        assets: asset ? [asset] : [], matching: asset ? 1 : 0, nextCursor: null });
    }
    const { canonical, scheme, level } = query.identifier;
    // The level is derived by the GS1 boundary, so the label and relationship
    // follow from policy rather than from any query-layer GS1 knowledge.
    const individual = level === 'individual';
    const identifierMatch = `MATCH (a:Asset)-[:${individual ? 'IDENTIFIED_BY' : 'CLASSIFIED_AS'}]->
      (:${individual ? 'IndividualIdentifier' : 'ClassIdentifier'} {canonical: $canonical})`;
    const session = this.driver.session();
    try {
      // Ordered by name then id: the same total ordering browse uses by
      // default, which is the simplest stable order for a class's Assets.
      const order = 'ORDER BY a.name ASC, a.id ASC';
      const result = await session.executeRead((tx) => tx.run(`
        CALL {
          ${identifierMatch}
          WHERE ${readableAsset}
          RETURN count(a) AS matching
        }
        CALL {
          ${identifierMatch}
          WHERE ${readableAsset}
            AND ($after IS NULL OR a.name > $after.name
              OR (a.name = $after.name AND a.id > $after.id))
          WITH a ${order} LIMIT $fetchSize
          ${assetRowsProjection(order)}
        }
        RETURN matching, rows`,
      { canonical, after, fetchSize: int(limit + 1), ...audienceParameters(audience) }));
      const row = result.records[0];
      const rows = row.get('rows') as StoredAsset[];
      const assets = rows.slice(0, limit).map(assetFrom);
      return Object.freeze({
        identity: Object.freeze({ kind: 'identifier' as const, canonical, scheme, level }),
        assets,
        // Truthful across the whole readable result set, not just this page.
        matching: row.get('matching').toNumber(),
        nextCursor: rows.length > limit ? assetLookupCursor(canonical, assets.at(-1)!) : null,
      });
    } finally { await session.close(); }
  }

  async findAssets(audience: NamedAudienceInput, request: AssetPageRequest): Promise<AssetPage> {
    const { q: text, scope, sort, dir, filters, limit, after } = request;
    const order = orderClause(sort, dir);
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        CALL {
          MATCH (a:Asset)
          WHERE ${readableAsset}
          WITH a, (toLower(a.name) CONTAINS toLower($text) AND ${filterPredicate}) AS matches,
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
          WHERE ${readableAsset} AND toLower(a.name) CONTAINS toLower($text)
            AND ${filterPredicate}
            AND ($scope = 'all' OR ($scope = 'public' AND a.isPublic = true)
              OR ($scope = 'group' AND ${collaboration})
              OR ($scope = 'mine' AND EXISTS { MATCH (a)-[:REPORTED_BY]->(:User {key: $actorKey}) }))
            AND ${keysetPredicate(sort, dir)}
          WITH a ${order} LIMIT $fetchSize
          ${assetRowsProjection(order)}
        }
        RETURN total, scopes, rows`,
      { text, scope, after, fetchSize: int(limit + 1),
        ...audienceParameters(audience), ...filterParameters(filters) }));
      const row = result.records[0];
      const rows = row.get('rows') as StoredAsset[];
      const assets = rows.slice(0, limit).map(assetFrom);
      const scopes = Object.fromEntries(Object.entries(row.get('scopes')).map(([key, value]) =>
        [key, (value as { toNumber(): number }).toNumber()])) as Record<AssetScope, number>;
      return { assets, total: row.get('total').toNumber(), scopes, matching: scopes[scope],
        nextCursor: rows.length > limit ? assetCursor(request, assets.at(-1)!) : null };
    } finally { await session.close(); }
  }

  /** The User an external identity names, or null when it names none.
   *
   * Matched on the issuer and subject pair alone. Email is never consulted:
   * two issuers may assert the same address for different people, an address
   * can be reassigned, and Kannabi would otherwise hand an account to whoever
   * an unrelated authority says owns a mailbox.
   *
   * A tombstone or a banned account resolves to nothing. Both are states in
   * which the web application refuses to act for this person, and an interface
   * without a session must not become the way around that.
   */
  async userForExternalIdentity(issuer: string, subject: string): Promise<ResolvedUser | null> {
    const canonical = externalIdentityKey(requiredText(issuer, 'issuer'), requiredText(subject, 'subject'));
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (:ExternalIdentity {canonical: $canonical})<-[:HAS_EXTERNAL_IDENTITY]-(u:User)
        WHERE u.accountDeletedAt IS NULL AND coalesce(u.banned, false) = false
        RETURN collect(DISTINCT u { .key, .name }) AS users`, { canonical }));
      const users = result.records[0].get('users') as ResolvedUser[];
      // Linking serialises ownership, so this cannot arise through the API.
      // If it arises anyway, whoever is asserting this identity is one of
      // several people and Kannabi does not know which: refuse rather than
      // pick, because picking would hand one person another's access.
      if (users.length > 1) {
        throw new DuplicateIdentityError('That external identity is linked to more than one User');
      }
      return users.length ? Object.freeze(users[0]) : null;
    } finally { await session.close(); }
  }

  /** Bind an external identity to an existing User.
   *
   * Administrative provisioning, deliberately outside every request path: an
   * assertion from a gateway can never create or claim an account, so a new
   * issuer subject reaches nothing until someone with database access says
   * whose it is.
   */
  async linkExternalIdentity(userKey: string, issuer: string, subject: string): Promise<ResolvedUser> {
    const key = requiredText(userKey, 'user key');
    const canonical = externalIdentityKey(requiredText(issuer, 'issuer'), requiredText(subject, 'subject'));
    return this.write(async (tx) => {
      // 1. Take the identity's write lock before reading who owns it, so a
      //    concurrent link blocks here rather than reading the same empty
      //    answer and adding a second owner. The uniqueness constraint keeps
      //    one node per canonical form; it says nothing about how many Users
      //    may point at that node.
      //
      //    The User is matched first and in the same statement, so a link to
      //    an account that does not exist still creates nothing at all.
      const locked = await tx.run(`
        MATCH (u:User {key: $key}) WHERE u.accountDeletedAt IS NULL
        MERGE (e:ExternalIdentity {canonical: $canonical})
          ON CREATE SET e.issuer = $issuer, e.subject = $subject, e.linkedAt = datetime()
        SET e.lock = true
        WITH u, e
        OPTIONAL MATCH (owner:User)-[:HAS_EXTERNAL_IDENTITY]->(e)
        RETURN u { .key, .name } AS user, collect(DISTINCT owner.key) AS owners`,
      { key, canonical, issuer, subject });
      if (!locked.records.length) throw new ReferenceError('User not found');
      // 2. Decided under the lock, so the answer cannot go stale before the
      //    relationship is written.
      const owners = locked.records[0].get('owners') as string[];
      if (owners.some((owner) => owner !== key)) {
        throw new DuplicateIdentityError('That external identity is already linked to another User');
      }
      await tx.run(`
        MATCH (u:User {key: $key}), (e:ExternalIdentity {canonical: $canonical})
        MERGE (u)-[:HAS_EXTERNAL_IDENTITY]->(e)`, { key, canonical });
      return Object.freeze(locked.records[0].get('user') as ResolvedUser);
    });
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

  /** The Better Auth user id behind a domain actor key, or null when the
   * account is not active. Credential machinery keys on the auth id; the rest
   * of the domain never does. */
  async authUserId(actorKey: string): Promise<string | null> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey})
      WHERE u.accountDeletedAt IS NULL AND u.id IS NOT NULL RETURN u.id AS id`,
    { actorKey: requiredText(actorKey, 'actorKey') }));
    return result.records.length ? String(result.records[0].get('id')) : null;
  }

  /** Whether this actor is an administrator right now.
   *
   * Read at the moment it matters rather than captured anywhere, so
   * administrative authority ends when the role does. It says nothing about
   * Asset access, which stays Group-derived.
   */
  async isAdministrator(actorKey: string): Promise<boolean> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey, role: 'admin'})
      WHERE u.accountDeletedAt IS NULL AND u.id IS NOT NULL RETURN u.key`,
    { actorKey: requiredText(actorKey, 'actorKey') }));
    return result.records.length > 0;
  }

  async settings(): Promise<Settings> {
    const result = await this.write((tx) => tx.run(`MATCH (s:Settings {key: 'instance'})
      RETURN s { .requirePhoto, .displayTimezone, .themeId,
        apiTokenMaxLifetimeDays: toFloat(s.apiTokenMaxLifetimeDays) } AS settings`));
    return result.records[0].get('settings');
  }

  async updateSettings(actorKey: string, value: unknown): Promise<Settings> {
    const settings = validateSettings(value);
    return this.write(async (tx) => {
      const result = await tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}), (s:Settings {key: 'instance'})
        SET s.revision = s.revision + 1, s.requirePhoto = $settings.requirePhoto,
          s.displayTimezone = $settings.displayTimezone, s.themeId = $settings.themeId,
          s.apiTokenMaxLifetimeDays = $settings.apiTokenMaxLifetimeDays
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
  async attachIdentifier(id: string, actorKey: string, value: unknown,
    origin: ChangeOrigin = {}): Promise<Asset> {
    const identifier = canonicalIdentifier(value);
    const assetKey = assetId(id);
    const change = changeParams(origin);
    try {
      return await this.write(async (tx) => {
        await IdentityStore.attachIdentifierWithin(tx, assetKey, actorKey, identifier, change);
        const result = await tx.run(`${assetMatch} WHERE ${collaboration} ${assetProjection}`,
          { assetId: assetKey, actorKey });
        return assetFrom(result.records[0].get('asset'));
      });
    } catch (error) {
      if (isDuplicateIdentifier(error)) {
        throw new DuplicateIdentityError('The individual identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }

  /** The single attachment implementation: Asset authorization, GS1 set
   * compatibility, the issuance guard, and persistence. Allocation runs this
   * inside its own transaction rather than duplicating any of it. */
  private static async attachIdentifierWithin(tx: ManagedTransaction, assetKey: string,
    actorKey: string, identifier: ExternalIdentifier,
    change: ReturnType<typeof changeParams>): Promise<void> {
    const current = await tx.run(`${assetMatch} WHERE ${collaboration}
      RETURN [(a)-[:IDENTIFIED_BY]->(x:IndividualIdentifier) | x { .canonical, .scheme, .policyVersion }]
        + [(a)-[:CLASSIFIED_AS]->(y:ClassIdentifier) | y { .canonical, .scheme, .policyVersion }] AS identifiers`,
    { assetId: assetKey, actorKey });
    if (!current.records.length) throw new ReferenceError('Asset access not found');
    const existing = (current.records[0].get('identifiers') as StoredIdentifier[])
      .map((row) => storedIdentifier(row.scheme, row.canonical, row.policyVersion));
    assertCompatible([...existing, identifier]);
    // A GIAI Kannabi issued may only ever return to the Asset it was issued
    // for. An externally assigned GIAI has no ledger row and keeps the ordinary
    // correction semantics of detaching from one Asset and attaching to another.
    if (identifier.scheme === 'giai') {
      const issued = await tx.run('MATCH (l:GiaiAllocation {value: $value}) RETURN l.allocatedForAssetId AS assetId',
        { value: identifier.components.assetReference });
      const issuedFor = issued.records[0]?.get('assetId') as string | undefined;
      if (issuedFor !== undefined && issuedFor !== assetKey) {
        throw new ValidationError('Kannabi issued that GIAI for another Asset');
      }
    }
    await tx.run(`${assetMatch} WHERE ${collaboration}
      ${recordChange}
      ${attachIdentifiers}`,
    { assetId: assetKey, actorKey, ...change, ...identifierParams([identifier]) });
  }

  /** GIAI namespaces the audience can reach, ordered by prefix. */
  async listGiaiNamespaces(audience: NamedAudienceInput): Promise<GiaiNamespace[]> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (n:GiaiNamespace) WHERE ${visibleNamespace}
        RETURN DISTINCT ${namespaceProjection} AS namespace ORDER BY namespace.gcp`,
      audienceParameters(audience)));
      return result.records.map((row) => namespaceFrom(row.get('namespace')));
    } finally { await session.close(); }
  }

  /** Read a namespace's GIAI issuance ledger.
   *
   * This is the only answer Kannabi can give to "which Assets did Kannabi
   * allocate from this namespace". Matching a stored identifier against the
   * prefix would answer a different question — which values happen to begin
   * with those digits — and would credit Kannabi with issuing values it merely
   * stores. The ledger is read here, and nothing else is consulted.
   *
   * An issuance permanently names the Asset it was issued for, even after the
   * identifier is detached. The Asset itself is attached only where the
   * audience may read it, so the ledger never widens Asset access.
   */
  async giaiIssuances(audience: NamedAudienceInput, request: GiaiLedgerRequest): Promise<GiaiIssuancePage> {
    const { namespaceKey, limit, after } = request;
    const parameters = audienceParameters(audience);
    const session = this.driver.session();
    try {
      return await session.executeRead(async (tx) => {
        const found = await tx.run(`
          MATCH (n:GiaiNamespace {key: $namespaceKey}) WHERE ${visibleNamespace}
          OPTIONAL MATCH (:GiaiAllocation)-[issued:ALLOCATED_FROM]->(n)
          RETURN ${namespaceProjection} AS namespace, count(issued) AS matching`,
        { namespaceKey, ...parameters });
        if (!found.records.length) throw new ReferenceError('Allocation namespace not found');
        const page = await tx.run(`
          MATCH (issuance:GiaiAllocation)-[:ALLOCATED_FROM]->(:GiaiNamespace {key: $namespaceKey})
          WHERE $after IS NULL OR issuance.sequence > $after
          WITH issuance ORDER BY issuance.sequence ASC LIMIT $fetchSize
          OPTIONAL MATCH (allocator:User {key: issuance.allocatedBy})
          WITH issuance, allocator ORDER BY issuance.sequence ASC
          RETURN collect(${allocationProjection}) AS rows`,
        { namespaceKey, after: after === null ? null : int(after), fetchSize: int(limit + 1) });
        const rows = page.records[0].get('rows') as GiaiAllocation[];
        const allocations = rows.slice(0, limit);
        const readable = await tx.run(`
          MATCH (a:Asset) WHERE a.id IN $ids AND ${readableAsset}
          ${assetRowsProjection('ORDER BY a.name ASC, a.id ASC')}`,
        { ids: allocations.map((allocation) => allocation.allocatedForAssetId), ...parameters });
        const assets = new Map((readable.records[0].get('rows') as StoredAsset[])
          .map((stored) => [stored.id, assetFrom(stored)]));
        return Object.freeze({
          namespace: namespaceFrom(found.records[0].get('namespace')),
          matching: found.records[0].get('matching').toNumber(),
          issuances: allocations.map((allocation) => Object.freeze({
            allocation, asset: assets.get(allocation.allocatedForAssetId) ?? null })),
          nextCursor: rows.length > limit
            ? giaiLedgerCursor(namespaceKey, allocations.at(-1)!.sequence) : null,
        });
      });
    } finally { await session.close(); }
  }

  /** Configure a GCP namespace for a Group.
   *
   * The prefix is an assertion by an authorized member, recorded with who made
   * it. Kannabi cannot verify GS1 licensing and does not imply that it did.
   */
  async configureGiaiNamespace(actorKey: string, groupKey: string, value: unknown): Promise<GiaiNamespace> {
    const input = record(value, ['gcp', 'exclusions']);
    const gcp = canonicalGcp(input.gcp);
    const exclusions = canonicalExclusions(input.exclusions);
    const params = {
      actorKey, groupKey: requiredText(groupKey, 'groupKey'), gcp,
      key: randomUUID(), nextSequence: int(firstSequence),
      exclusionsFrom: exclusions.map((range) => int(range.from)),
      exclusionsTo: exclusions.map((range) => int(range.to)),
    };
    return this.write(async (tx) => {
      const owner = await tx.run(`MATCH (n:GiaiNamespace {gcp: $gcp})
        RETURN head([(n)<-[:MANAGES_NAMESPACE]-(g:Group) | g.key]) AS groupKey`, { gcp });
      if (owner.records.length) {
        // One managed GCP belongs to one Group while Group membership is the
        // only authorization we have. Issue #20's privilege model can relax
        // this without touching any namespace or allocation record.
        throw new DuplicateIdentityError(owner.records[0].get('groupKey') === params.groupKey
          ? 'That GS1 Company Prefix is already configured for this Group'
          : 'That GS1 Company Prefix is already managed by another Group');
      }
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group {key: $groupKey})
        CREATE (g)-[:MANAGES_NAMESPACE]->(n:GiaiNamespace {
          key: $key, gcp: $gcp, active: true, nextSequence: $nextSequence,
          exclusionsFrom: $exclusionsFrom, exclusionsTo: $exclusionsTo,
          configuredAt: datetime(), configuredBy: $actorKey })
        RETURN ${namespaceProjection} AS namespace`, params);
      if (!result.records.length) throw new ReferenceError('Group not found');
      return namespaceFrom(result.records[0].get('namespace'));
    });
  }

  /** Deactivate or reactivate a namespace. Deactivation stops new issuance and
   * nothing else: the counter, the exclusions and every ledger row remain, so
   * reactivation resumes the same namespace rather than starting a new one. */
  async setGiaiNamespaceActive(actorKey: string, namespaceKey: string, active: unknown): Promise<GiaiNamespace> {
    if (typeof active !== 'boolean') throw new ValidationError('Namespace active state must be a boolean');
    return this.write(async (tx) => {
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(:Group)-[:MANAGES_NAMESPACE]->(n:GiaiNamespace {key: $key})
        SET n.active = $active
        RETURN ${namespaceProjection} AS namespace`,
      { actorKey, key: requiredText(namespaceKey, 'namespace key'), active });
      if (!result.records.length) throw new ReferenceError('Allocation namespace not found');
      return namespaceFrom(result.records[0].get('namespace'));
    });
  }

  /** Issue a GIAI for an Asset from a managed namespace, idempotently.
   *
   * One transaction, and the namespace write lock is taken before anything is
   * decided — the Phase 1 lesson. A concurrent caller therefore blocks and then
   * observes the committed allocation at step 3, so a double-click returns the
   * same GIAI without consuming a sequence number.
   *
   * The same Asset allocating from two different namespaces at once locks two
   * different nodes, so the `allocatedForAssetId` constraint arbitrates
   * instead: the loser's whole transaction, counter included, rolls back and it
   * returns the winner's allocation.
   */
  async allocateGiai(id: string, actorKey: string, namespaceKey: string,
    origin: ChangeOrigin = {}): Promise<Asset> {
    const assetKey = assetId(id);
    const key = requiredText(namespaceKey, 'namespace key');
    const change = changeParams(origin);
    const project = async (tx: ManagedTransaction) => {
      const result = await tx.run(`${assetMatch} WHERE ${collaboration} ${assetProjection}`,
        { assetId: assetKey, actorKey });
      return assetFrom(result.records[0].get('asset'));
    };
    try {
      return await this.write(async (tx) => {
        // 1. Lock the namespace before reading anything the decision depends on.
        const locked = await tx.run(`MATCH (n:GiaiNamespace {key: $key}) SET n.lock = true
          RETURN n.gcp AS gcp, n.active AS active, toFloat(n.nextSequence) AS nextSequence,
            n.exclusionsFrom AS exclusionsFrom, n.exclusionsTo AS exclusionsTo`, { key });
        if (!locked.records.length) throw new ReferenceError('Allocation namespace not found');
        // 2. Authority comes from the Group that manages the namespace, and
        //    that Group must also collaborate on the Asset.
        const authorized = await tx.run(`
          MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)-[:MANAGES_NAMESPACE]->(:GiaiNamespace {key: $key})
          MATCH (g)-[:CAN_COLLABORATE]->(a:Asset {id: $assetId})
          RETURN a.id AS id`, { actorKey, key, assetId: assetKey });
        if (!authorized.records.length) throw new ReferenceError('Asset access or allocation namespace not found');
        // 3/4. An existing issuance is returned as-is, whether or not the
        //      identifier is still attached, and never consumes a sequence.
        const existing = await tx.run('MATCH (l:GiaiAllocation {allocatedForAssetId: $assetId}) RETURN l.value AS value',
          { assetId: assetKey });
        if (existing.records.length) return project(tx);
        if (locked.records[0].get('active') !== true) {
          throw new ValidationError('That GS1 Company Prefix namespace is deactivated');
        }
        // 5. The next candidate, skipping existing-use ranges by range.
        const row = locked.records[0];
        const sequence = allocatableSequence(row.get('nextSequence') as number,
          storedExclusions(row.get('exclusionsFrom'), row.get('exclusionsTo')));
        // 6. Advance past the candidate; skipping happens again on the next read.
        await tx.run('MATCH (n:GiaiNamespace {key: $key}) SET n.nextSequence = $next',
          { key, next: int(sequence + 1) });
        // 7. Construction and validation belong to the GS1 boundary.
        const identifier = allocatedGiai(row.get('gcp') as string, sequence);
        // 8. The issuance record, which outlives the Asset and the attachment.
        await tx.run(`MATCH (n:GiaiNamespace {key: $key})
          CREATE (l:GiaiAllocation { value: $value, gcp: $gcp, sequence: $sequence,
            allocatedAt: datetime(), allocatedForAssetId: $assetId, allocatedBy: $actorKey })
          CREATE (l)-[:ALLOCATED_FROM]->(n)`,
        { key, value: identifier.components.assetReference, gcp: row.get('gcp'),
          sequence: int(sequence), assetId: assetKey, actorKey });
        // 9. Phase 2 attachment semantics, unchanged and not duplicated.
        await IdentityStore.attachIdentifierWithin(tx, assetKey, actorKey, identifier, change);
        return project(tx);
      });
    } catch (error) {
      if (isDuplicateIdentifier(error)) {
        // Another transaction issued for this Asset first. Return its result
        // rather than reporting a conflict the caller cannot act on.
        const settled = await this.getAsset(assetKey, actorKey);
        if (settled?.allocation) return settled;
        throw new DuplicateIdentityError('The allocated identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }

  /** Detach an identifier by its attachment key. An individual identifier is
   * exclusive, so its node goes with the link; a class identifier node stays
   * while any other Asset still refers to it. */
  async detachIdentifier(id: string, actorKey: string, key: string,
    origin: ChangeOrigin = {}): Promise<Asset> {
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
        WITH a
        ${recordChange}
        RETURN a.id AS id`, { assetId: assetKey, actorKey, key: identifierKey, ...changeParams(origin) });
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

  async attachPhoto(id: string, actorKey: string, photoKey: string,
    origin: ChangeOrigin = {}): Promise<Asset> {
    return this.write(async (tx) => {
      await this.consumePhoto(tx, photoKey);
      const result = await tx.run(`${assetMatch} WHERE ${collaboration}
        MATCH (m:Media {key: $photoKey}) CREATE (a)-[:HAS_PHOTO]->(m)
        ${recordChange}
        WITH a ${assetProjection}`,
      { assetId: assetId(id), actorKey, photoKey, ...changeParams(origin) });
      if (!result.records.length) throw new ReferenceError('Asset access not found');
      return assetFrom(result.records[0].get('asset'));
    });
  }

  async beginPhotoDeletion(id: string, actorKey: string, photoKey: string,
    origin: ChangeOrigin = {}): Promise<void> {
    const result = await this.write((tx) => tx.run(`${assetMatch} WHERE ${collaboration}
      MATCH (a)-[relationship:HAS_PHOTO]->(m:Media {key: $photoKey, state: 'attached'})
      SET m.state = 'deleting', m.expiresAt = datetime()
      ${recordChange}
      DELETE relationship
      RETURN m.key`, {
      assetId: assetId(id), actorKey,
      photoKey: requiredText(photoKey, 'photoKey'),
      ...changeParams(origin),
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

  async updateAsset(id: string, changes: AssetChanges, actorKey: string,
    origin: ChangeOrigin = {}): Promise<Asset> {
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
      ...changeParams(origin),
    };
    return this.write(async (tx) => {
      const result = await tx.run(`${assetMatch} WHERE ${collaboration}
        OPTIONAL MATCH (owner:Owner {key: $ownerKey})
        WITH a, owner WHERE $ownerKey IS NULL OR owner IS NOT NULL
        // Lock the Asset before changing its single Owner relationship.
        SET a.name = coalesce($name, a.name), a.isPublic = coalesce($isPublic, a.isPublic)
        ${recordChange}
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
