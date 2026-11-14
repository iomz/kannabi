import { randomUUID } from 'node:crypto';
import { defaultSettings, validateSettingsChange, type Settings } from './settings.js';
import type { Driver, ManagedTransaction, Record as Neo4jRecord, Session } from 'neo4j-driver';
import neo4j, { int, type Integer } from 'neo4j-driver';
import {
  assetCursor, type AssetDirection, type AssetFilters, type AssetPageRequest, type AssetScope,
  type AssetSort,
} from './asset-page.js';
import { assetLookupCursor, type AssetLookupRequest } from './asset-lookup.js';
import { audienceParameters, type AudienceInput, type NamedAudienceInput } from './asset-audience.js';
import { sourceRecordParams, type SourceRecord, type SourceRecordInput } from './source-record.js';
import { assetId, assetIdPattern, isAssetId, newAssetId } from './asset-id.js';
import { record, requiredText, ValidationError } from './identity.js';
import {
  changeParams, type AssertingCredential, type ChangeOrigin, type ChangeProvenance,
} from './change-provenance.js';
import { gravatarIdentifier } from './avatar.js';
import { externalIdentityKey } from './external-principal.js';
import type { Identifier, IdentifierLevel, IdentifierSchemes } from './identifier.js';
import type { AssetWriteParticipant, PluginConstraint, PluginDefinition } from './plugin.js';
import { isAppearancePreference, type AppearancePreference } from '../shared/appearance.js';
import { MailRevisionConflictError, type MailVerificationStatus, type PersistedMailSettings,
  type StoredMailConfiguration } from './mail.js';

export class DuplicateIdentityError extends Error {}
export class ReferenceError extends Error {}
export class AdministrationError extends Error {}
export class LastAdministratorError extends Error {}
export class LastCollaborationError extends Error {}
/** A change refused because of what the instance currently holds. `detail` is
 * what the caller needs in order to act on the refusal, and is answered beside
 * the message. */
export class ConflictError extends Error {
  constructor(message: string, readonly detail: Readonly<Record<string, unknown>> = {}) { super(message); }
}

/** A User an external principal resolved to. Deliberately thin: resolution
 * answers who is acting, and every later authorization decision is made from
 * the Group model as usual rather than from anything carried here. */
export type ResolvedUser = Readonly<{ key: string; name: string }>;
export type UserAccount = { key: string; name: string; email: string; isAdmin: boolean;
  credentialState: 'pending' | 'established'; createdAt: string | null;
  /** When an administrator approved this account, or null while it waits. */
  approvedAt: string | null };
export type ManagedUserAccount = UserAccount & { id: string };
/** What one User may learn about another: who they are, and how much of their
 * work this particular viewer can already see. */
export type UserProfile = Readonly<{
  key: string;
  name: string;
  avatarHash: string | null;
  /** Group memberships shared with this viewer, never the target's complete membership. */
  sharedGroups: readonly Entity[];
  /** Counted through the viewer's own readability, never the target's. */
  reportedAssets: number;
  self: boolean;
  /** Present unless the People directory shows names only; never a reason
   * this person is listed. */
  email: string | null;
}>;

export type AccountState = {
  isAdmin: boolean;
  /** Whether this account takes part in the instance. A signed-in account that
   * is not approved yet reaches its own account and public Assets only. */
  approved: boolean;
  appearance: AppearancePreference;
  /** Whether this User asked Kannabi to use Gravatar for their own avatar. */
  gravatar: boolean;
  /** The Gravatar identifier, present only while that is true. Kannabi derives
   * one for nobody who has not asked, and the address itself never leaves the
   * server for this purpose. */
  avatarHash: string | null;
};
const userAccountProjection = `u { .key, .name, .email, isAdmin: u.role = 'admin',
  credentialState: CASE WHEN EXISTS { MATCH (u)-[:HAS_AUTHACCOUNT]->(:AuthAccount {providerId: 'credential'}) }
    THEN 'established' ELSE 'pending' END, createdAt: toString(u.createdAt), .approvedAt }`;

// Entity keys are internal references. An Asset carries its own native
// application identity in `id`; external identifiers never address the Asset.
export type Entity = Readonly<{ key: string; name: string }>;
/** A member's role in a Group. A Group Manager is a member who also manages
 * the Group's people and GS1 Company Prefixes; there is no managing a Group
 * without belonging to it. */
export const groupRoles = ['member', 'manager'] as const;
export type GroupRole = (typeof groupRoles)[number];
export function groupRole(value: unknown): GroupRole {
  if (!(groupRoles as readonly unknown[]).includes(value)) throw new ValidationError('role must be member or manager');
  return value as GroupRole;
}
/** A Group as the viewer stands in it. */
export type GroupRelationship = Readonly<{ group: Entity; viewer: Readonly<{ role: GroupRole }> }>;
/** One of the viewer's own Groups, as `/groups` lists it. */
export type GroupSummary = Entity & Readonly<{ role: GroupRole; people: number; assets: number }>;
export type ReporterAttribution = Entity & Readonly<{ status: 'active' | 'deleted' }>;
/** Somebody named on a Group's page: their attribution, and their address
 * where the instance shares addresses and this viewer could already open
 * their profile. Who is listed never depends on the address. */
export type GroupPerson = ReporterAttribution & Readonly<{ email: string | null; role: GroupRole }>;
/** Who accepted one Asset–identifier association, when, and on what stated
 * basis.
 *
 * The same shape and meaning as Tier-1 change provenance, scoped to one
 * association and fixed when it was made. It is an acceptance, never a
 * verification: it says nothing about whether the identifier is correct, and
 * nothing about who issued it, which the issuance ledger alone records. It
 * lasts as long as the association; detaching removes both. */
export type IdentifierAttachment = Readonly<{
  acceptedBy: ReporterAttribution;
  acceptedAt: string;
  assertedBy: AssertingCredential | null;
  basis: string | null;
}>;

/** An external identifier as carried by an Asset. `key` addresses this
 * attachment for detachment; everything else is derived by the GS1 boundary,
 * except `attachment`, which is null for an association recorded before
 * Kannabi kept it. */
export type AttachedIdentifier = Identifier & Readonly<{
  key: string;
  attachment: IdentifierAttachment | null;
}>;

export type Asset = Readonly<{
  id: string;
  name: string;
  identifiers: readonly AttachedIdentifier[];
  reportedBy: ReporterAttribution;
  reportedAt: string;
  /** Null only for an Asset last written before Kannabi recorded this; it
   * never means the Asset has not changed. */
  provenance: ChangeProvenance | null;
  /** The pre-existing record this Asset was created from, as that record
   * describes itself, or null for one that originated in Kannabi.
   *
   * Quoted evidence, immutable after creation. It is never chronology, never
   * identity, never authorization, and never confused with `reportedAt` or
   * `reportedBy` above, which describe what happened in Kannabi. */
  sourceRecord: SourceRecord | null;
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
type StoredAttachedIdentifier = StoredIdentifier & { attachment: IdentifierAttachment | null };
type StoredAsset = Omit<Asset, 'identifiers'> & { identifiers: StoredAttachedIdentifier[] };
function byCanonical<T extends { canonical: string }>(left: T, right: T): number {
  return left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0;
}

/** Components and level are always re-derived from the canonical form by the
 * scheme that owns it, so a stored identifier cannot become an independent
 * source of truth about what its value means. */
function assetFrom(stored: StoredAsset, schemes: IdentifierSchemes): Asset {
  const identifiers = stored.identifiers
    .map((row) => ({ key: row.key, ...schemes.restore(row.scheme, row.canonical, row.policyVersion),
      attachment: row.attachment ?? null }))
    .sort(byCanonical);
  return { ...stored, identifiers, photos: orderPhotos(stored.photos) };
}
/** A searchable field free text can match. `sourceDescription` is quoted
 * source text, so a match there is a match against what a source said. */
export type MatchedField = 'name' | 'sourceDescription';
export type AssetPage = {
  assets: Asset[];
  /** For each Asset on this page, by id, the fields the query text matched.
   * Empty when the query has no text. */
  matchedFields: Record<string, MatchedField[]>;
  total: number; matching: number; scopes: Record<AssetScope, number>; nextCursor: string | null;
};

/** The resolved identity, echoed from the caller's own input so they can see
 * what it canonicalised to. It is derived before any Asset is read and
 * therefore discloses nothing about what exists. */
export type ResolvedIdentity =
  | Readonly<{ kind: 'assetId'; id: string }>
  | Readonly<{ kind: 'identifier'; canonical: string; scheme: string; level: IdentifierLevel }>;

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
export type ReportAsset = {
  name: string;
  /** Optional. An Asset exists independently of GS1 identification. */
  identifiers?: readonly unknown[];
  ownerKey?: string;
  /** Optional. The pre-existing record this Asset is being created from.
   * Accepted here and on no other path: `AssetChanges` has no counterpart,
   * because where a record came from is not something a later edit revises. */
  sourceRecord?: SourceRecordInput;
};
export type ReportingContext = { actorKey: string; groupKey: string };
/** What a store is composed with: the identifier schemes, and the installed
 * plugins' persistence and part in a write. A store with no plugin is whole. */
export type StoreComposition = Readonly<{
  schemes: IdentifierSchemes;
  plugins?: readonly Pick<PluginDefinition, 'manifest' | 'persistence' | 'participant'>[];
}>;
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

/** Refuse a class identifier whose canonical form is already recorded under a
 * different scheme. The uniqueness constraint would refuse it too; asking
 * first lets the refusal say what actually happened. */
async function assertClassSchemes(tx: ManagedTransaction, identifiers: readonly Identifier[]): Promise<void> {
  const rows = identifiers.filter((identifier) => identifier.level === 'class')
    .map((identifier) => ({ canonical: identifier.canonical, scheme: identifier.scheme }));
  if (!rows.length) return;
  const clash = await tx.run(`UNWIND $rows AS c
    MATCH (n:ClassIdentifier {canonical: c.canonical}) WHERE n.scheme <> c.scheme
    RETURN c.canonical AS canonical LIMIT 1`, { rows });
  if (clash.records.length) throw new ValidationError('That identifier is already recorded under another scheme');
}

export function isConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed';
}

function identifierRows(identifiers: readonly Identifier[], level: IdentifierLevel) {
  return identifiers.filter((identifier) => identifier.level === level).map((identifier) => ({
    key: randomUUID(), canonical: identifier.canonical,
    scheme: identifier.scheme, policyVersion: identifier.policyVersion,
  }));
}

function identifierParams(identifiers: readonly Identifier[]) {
  return {
    individualIdentifiers: identifierRows(identifiers, 'individual'),
    classIdentifiers: identifierRows(identifiers, 'class'),
  };
}

// Requires `a` in scope, plus `$actorKey` and the parameters `changeParams`
// produces, which every caller already binds for `recordChange`. The two labels
// record the GS1 level an identifier already has; they add no meaning of their
// own. Individual identifiers are CREATEd so the uniqueness constraint rejects a
// second Asset claiming them; class identifiers are MERGEd so Assets share one
// node. The MERGE matches the scheme as well as the canonical form, so a value
// already recorded under another scheme is refused by that constraint rather
// than silently attached as the other scheme's identifier.
//
// Each association records who accepted it, when, and on what stated basis, on
// the relationship itself: the association is what the provenance describes,
// and a shared class node cannot speak for one Asset. It is written in the same
// statement as the association and as `recordChange`, so `acceptedAt` is the
// same statement-clock instant as the Asset's `changeAcceptedAt`. It says
// nothing about who issued the value or whether it is correct. `ON CREATE`
// keeps an existing association's origin even if a repeat ever reached here;
// the scheme registry refuses repeats before that.
const attachIdentifiers = `
  FOREACH (i IN $individualIdentifiers |
    CREATE (a)-[:IDENTIFIED_BY {
        acceptedBy: $actorKey, acceptedAt: datetime(),
        assertedById: $assertedById, assertedByLabel: $assertedByLabel, basis: $basis
      }]->(:IndividualIdentifier {
        key: i.key, canonical: i.canonical, scheme: i.scheme, policyVersion: i.policyVersion }))
  FOREACH (c IN $classIdentifiers |
    MERGE (n:ClassIdentifier {canonical: c.canonical, scheme: c.scheme})
      ON CREATE SET n.key = c.key, n.policyVersion = c.policyVersion
    MERGE (a)-[r:CLASSIFIED_AS]->(n)
      ON CREATE SET r.acceptedBy = $actorKey, r.acceptedAt = datetime(),
        r.assertedById = $assertedById, r.assertedByLabel = $assertedByLabel,
        r.basis = $basis, r.policyVersion = c.policyVersion)`;

/** Public attribution for a stored actor key.
 *
 * The key is projected from the stored value rather than from the node,
 * because an actor key outlives the account it names: a provenance record must
 * still render after the account is gone, and it must render a tombstone
 * rather than the person. `node` is therefore allowed to be null even where a
 * particular caller knows it cannot be.
 */
export const attribution = (node: string, key: string) => `{ key: ${key},
        name: CASE WHEN ${node} IS NULL THEN 'Deleted member'
          WHEN ${node}.accountDeletedAt IS NULL THEN ${node}.name
          ELSE coalesce(${node}.provenanceName, ${node}.name, 'Deleted member') END,
        status: CASE WHEN ${node} IS NOT NULL AND ${node}.accountDeletedAt IS NULL
          THEN 'active' ELSE 'deleted' END }`;

/** Every identifier this Asset carries, each with the provenance of its
 * association, as one list.
 *
 * A subquery for the same reasons as an Asset's Groups: the accepting User is
 * resolved per association, and aggregating inside keeps an Asset with no
 * identifiers to an empty list rather than a row of nulls. The policy stamp is
 * the association's own where it has one, because a shared class node keeps
 * only the stamp of whichever attachment created it.
 *
 * `attachment` is null for an association recorded before Kannabi kept this.
 * It is never back-filled, so null never means "accepted by nobody".
 */
const identifiersSubquery = `CALL {
    WITH a
    MATCH (a)-[r:IDENTIFIED_BY|CLASSIFIED_AS]->(x)
    WHERE x:IndividualIdentifier OR x:ClassIdentifier
    OPTIONAL MATCH (identifierAcceptor:User {key: r.acceptedBy})
    RETURN collect(x { .key, .canonical, .scheme,
      policyVersion: coalesce(r.policyVersion, x.policyVersion),
      attachment: CASE WHEN r.acceptedAt IS NULL THEN null ELSE {
        acceptedBy: ${attribution('identifierAcceptor', 'r.acceptedBy')},
        acceptedAt: toString(r.acceptedAt),
        assertedBy: CASE WHEN r.assertedById IS NULL THEN null
          ELSE { id: r.assertedById, label: r.assertedByLabel } END,
        basis: r.basis } END }) AS identifiers
  }`;

const identifierProjection = `
    identifiers: identifiers,`

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

/** The source record as the domain sees it. Requires `a` in scope. The
 * reference is the anchor, so its absence is the attribution's absence: there
 * is no half-quoted source record. Deliberately not derived from, compared
 * with, or ordered by anything — it is evidence, read and nothing else. */
const sourceRecordProjection = `CASE WHEN a.sourceReference IS NULL THEN null ELSE {
      reference: a.sourceReference, recordedAt: toString(a.sourceRecordedAt),
      recordedBy: a.sourceRecordedBy, description: a.sourceDescription } END`;

/** Stamps a newly created Asset with the record it came from. Requires `a` in
 * scope plus the parameters `sourceRecordParams` produces.
 *
 * Only ever a clause of the CREATE that makes the Asset. No update path sets
 * these, which is what makes the attribution immutable: a later edit has its
 * own `basis`, and replacing where a record came from is not an edit. */
const recordSource = `SET a.sourceReference = $sourceReference,
    a.sourceRecordedAt = datetime($sourceRecordedAt), a.sourceRecordedBy = $sourceRecordedBy,
    a.sourceDescription = $sourceDescription`;

/** The stored settings, as Cypher over `s`. Numbers come back as JavaScript
 * numbers rather than driver integers. */
const settingsProjection = `s { .requirePhoto, .displayTimezone, .themeId,
  apiTokenMaxLifetimeDays: toFloat(s.apiTokenMaxLifetimeDays), toastSeconds: toFloat(s.toastSeconds),
  .showAssetId, .showIdentifierPolicyVersion, .peopleDirectory, .requireApproval }`;

/** Every identifier one Asset carries, in the shape `storedIdentifier` reads.
 * Requires `a` in scope. */
export const assetIdentifierRows = `[(a)-[:IDENTIFIED_BY]->(x:IndividualIdentifier) | x { .canonical, .scheme, .policyVersion }]
  + [(a)-[:CLASSIFIED_AS]->(y:ClassIdentifier) | y { .canonical, .scheme, .policyVersion }]`;

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

/** The text a free-text query matches, as Cypher. Requires `a` and `$text`.
 *
 * A plain case-insensitive substring of the Asset name or of the source
 * record's quoted description: no ranking, stemming or inference. The
 * description is what a source said, so a match on it is a match against
 * quoted text and never against a fact Kannabi holds; `matchedFieldsExpression`
 * reports which field matched so a caller can say so. */
const textPredicate = `(toLower(a.name) CONTAINS toLower($text)
  OR toLower(coalesce(a.sourceDescription, '')) CONTAINS toLower($text))`;

/** Which searchable fields the query text matched, in a fixed order. Empty for
 * an empty query, which matches everything and so matched no field. */
const matchedFieldsExpression = `[field IN ['name', 'sourceDescription'] WHERE $text <> ''
    AND toLower(CASE field WHEN 'name' THEN a.name ELSE coalesce(a.sourceDescription, '') END)
      CONTAINS toLower($text)]`;

/** Projects a page of Assets already narrowed and ordered by the caller.
 * Requires `a` in scope and yields `rows`. Shared so browse and lookup cannot
 * drift into returning different Asset representations. With `textMatch`, each
 * row also carries `matchedFields`, which requires `$text`. */
const assetRowsProjection = (order: string, textMatch = false) => `
  MATCH (a)-[:REPORTED_BY]->(u:User)
  MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
  OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
  ${identifiersSubquery}
  ${changeMatch}
  WITH a, u, o, identifiers, acceptor, collect(g { .key, .name }) AS groups
  ${order}
  RETURN collect(a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
    reportedBy: ${attribution('u', 'u.key')}, provenance: ${changeProjection},
    sourceRecord: ${sourceRecordProjection},${textMatch ? `
    matchedFields: ${matchedFieldsExpression},` : ''}
    owner: o { .key, .name }, groups: groups, photos: [(a)-[:HAS_PHOTO]->(m:Media) |
      m { .key, .contentType, size: toFloat(m.size), createdAt: toString(m.createdAt) }]}) AS rows`;

/** The organizational authority for privileged operations on what a Group
 * manages: the actor is one of its Group Managers. Requires `g` bound to that
 * Group, plus `$actorKey`.
 *
 * A Group Manager is a member, so this also carries membership. It is one
 * constant rather than a clause per operation so that every privileged
 * managed-GS1 operation provably asks the same question. Where an operation
 * also acts on an Asset, that Asset's own predicate is required independently
 * and in addition: managing a Group never substitutes for collaboration.
 *
 * Deliberately not a per-resource authority. The role carries every privileged
 * operation over everything the Group manages, so Kannabi cannot yet express a
 * GS1 administrator who may not also recruit members; scoping those apart is
 * done with a second Group until a deployment needs otherwise.
 */
export const groupManaged = `EXISTS {
  MATCH (manager:User {key: $actorKey})-[:MEMBER_OF {role: 'manager'}]->(g)
  WHERE manager.accountDeletedAt IS NULL
}`;

export const assetMatch = 'MATCH (a:Asset {id: $assetId})';
export const collaboration = `EXISTS {
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

/** One Asset, as this viewer can read it. The `user` audience of `readableAsset`
 * written on its own, because User discovery always has a signed-in viewer and
 * never the system-wide audience. */
export const readableByViewer = `(a.isPublic = true OR ${collaboration})`;

const activeUser = `u.accountDeletedAt IS NULL AND u.id IS NOT NULL`;
const sharesGroupWithViewer = `EXISTS {
  MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(shared:Group)
  WHERE EXISTS { MATCH (u)-[:MEMBER_OF]->(shared) }
}`;

/** An account that takes part in the instance: active, and approved by an
 * administrator (or created while approval was not required). A pending
 * account is signed in but is nobody's colleague yet. Requires `u`. */
const participant = `(${activeUser} AND u.approvedAt IS NOT NULL)`;

/** An account that may be in a Group: not deleted, and approved. Requires `u`.
 * Narrower than `participant` only in not asking for a credential, so a
 * domain-only User made by the store itself can take part in Groups. */
const approvedAccount = `(u.accountDeletedAt IS NULL AND u.approvedAt IS NOT NULL)`;

/** Whether the instance's People directory is set to this value, read in the
 * statement that uses it, so a change takes effect on the next response. */
const directoryIs = (value: 'names' | 'shared') =>
  `EXISTS { MATCH (:Settings {key: 'instance', peopleDirectory: '${value}'}) }`;

/** Whether this viewer may find `u` in the People directory and open their
 * profile, as Cypher. Requires `u` in scope and `$actorKey`.
 *
 * The viewer must take part in the instance themself. Then: yourself; every
 * other participant, unless the instance limits the directory to shared
 * Groups, in which case somebody you share a Group with.
 *
 * Asset readability and system administration never broaden it; instance-wide
 * account administration belongs to `/admin/users`. A tombstone or a pending
 * account is not a person to find.
 */
const inDirectory = `(${participant} AND EXISTS {
  MATCH (viewer:User {key: $actorKey})
  WHERE viewer.accountDeletedAt IS NULL AND viewer.approvedAt IS NOT NULL
} AND (u.key = $actorKey OR NOT ${directoryIs('shared')} OR ${sharesGroupWithViewer}))`;

/** A person's address, for somebody already in this viewer's directory, as
 * Cypher. Requires `u` and `$actorKey`. Withheld when the instance shows names
 * only — except your own, which is yours. It adds to what is shown about a
 * person and never to who is shown. */
const directoryEmail = `CASE WHEN ${inDirectory} AND (u.key = $actorKey OR NOT ${directoryIs('names')})
  THEN u.email ELSE null END`;

/** The shape every User surface returns, counted through the viewer's own
 * readability rather than the target's. */
const discoveredUser = `u.key AS key, u.name AS name, coalesce(u.gravatar, false) AS gravatar,
  u.email AS email, count(DISTINCT a) AS reportedAssets,
  collect(DISTINCT sharedGroup { .key, .name }) AS sharedGroups`;
const assetProjection = `
  MATCH (a)-[:REPORTED_BY]->(u:User)
  MATCH (g:Group)-[:CAN_COLLABORATE]->(a)
  OPTIONAL MATCH (a)-[:OWNED_BY]->(o:Owner)
  ${identifiersSubquery}
  ${changeMatch}
  WITH a, u, o, identifiers, acceptor, collect(g { .key, .name }) AS groups
  RETURN a { .id, .name, .isPublic, reportedAt: toString(a.reportedAt),${identifierProjection}
    reportedBy: ${attribution('u', 'u.key')}, provenance: ${changeProjection},
    sourceRecord: ${sourceRecordProjection},
    owner: o { .key, .name },
    groups: groups, photos: [(a)-[:HAS_PHOTO]->(m:Media) |
      m { .key, .contentType, size: toFloat(m.size), createdAt: toString(m.createdAt) }] } AS asset`;

/** Internal persistence API. Callers must supply a trusted actor context.
 * No HTTP routes or authentication are provided by this layer.
 * The supplied driver belongs to the caller and is never closed here.
 */
export class IdentityStore {
  /** `schemes` is what this store was composed with: every identifier it
   * accepts or reads back goes through them, and it knows no scheme itself.
   * `participants` are the installed plugins' parts in an identifier write. */
  private constructor(private readonly driver: Driver, readonly schemes: IdentifierSchemes,
    private readonly participants: readonly AssetWriteParticipant[]) {}

  private static composed(composition: StoreComposition): IdentityStore['participants'] {
    return (composition.plugins ?? []).flatMap((plugin) => (plugin.participant ? [plugin.participant] : []));
  }

  /** A plugin's constraints, each checked to be over a label carrying the
   * plugin's own id, so no plugin can constrain core's nodes or another's. */
  private static pluginConstraints(composition: StoreComposition): PluginConstraint[] {
    return (composition.plugins ?? []).flatMap((plugin) => (plugin.persistence?.constraints ?? []).map((constraint) => {
      const prefix = plugin.manifest.id.replaceAll('-', '');
      if (!constraint.label.toLowerCase().startsWith(prefix) || !/^\w+$/.test(constraint.label)
        || !/^\w+$/.test(constraint.name) || !constraint.properties.every((name) => /^\w+$/.test(name))) {
        throw new Error(`Plugin "${plugin.manifest.id}" declares a constraint outside its own labels: ${constraint.label}`);
      }
      return constraint;
    }));
  }

  static async open(driver: Driver, composition: StoreComposition): Promise<IdentityStore> {
    const plugins = composition.plugins ?? [];
    const pluginConstraints = IdentityStore.pluginConstraints(composition);
    const session = driver.session();
    try {
      // Fail closed if constraints cannot be installed, including on dirty data.
      // These do not depend on migrated Asset data, and migration_key must exist
      // before the backfill can take its lock.
      for (const statement of constraints) await session.run(statement);
      for (const { name, label, properties } of pluginConstraints) {
        await session.run(`CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label})
          REQUIRE (${properties.map((property) => `n.${property}`).join(', ')}) IS UNIQUE`);
      }
      for (const statement of indexes) await session.run(statement);
      await IdentityStore.backfillAssetIds(driver);
      await IdentityStore.verifyAssetIds(session);
      await session.run(assetIdConstraint);
      // Every setting is stored, so reads trust what is there. A setting added
      // since a development database was created takes its default here; the
      // defaults themselves are decided once, in `defaultSettings`.
      await session.run(`MERGE (s:Settings {key: 'instance'}) ON CREATE SET s.revision = 0
        SET ${Object.keys(defaultSettings).map((name) => `s.${name} = coalesce(s.${name}, $defaults.${name})`).join(', ')}
        REMOVE s.accentColor`, { defaults: defaultSettings });
      // A plugin brings its own data forward before core verifies what is
      // stored, because an identifier written under an earlier shape is the
      // owning scheme's to rebuild.
      for (const plugin of plugins) await plugin.persistence?.migrate?.(driver);
      await IdentityStore.verifyExternalIdentifiers(session);
      for (const plugin of plugins) await plugin.persistence?.verify?.(session);
      // The pre-Phase-2 identifier schema has no remaining nodes to guard.
      await session.run('DROP CONSTRAINT identifier_claim IF EXISTS');
      await session.run(`MERGE (m:MailConfiguration {key: 'instance'})
        ON CREATE SET m.enabled = false, m.transport = 'smtp', m.revision = 0
        SET m.verificationStatus = coalesce(m.verificationStatus, 'not-verified')`);
      await session.run('MATCH (a:Asset) SET a.isPublic = coalesce(a.isPublic, false)');
      // Better Auth role is sole persisted administrator authority. Preserve existing
      // installations once, then remove legacy duplicate state.
      await session.run(`MATCH (u:User) WHERE u.id IS NOT NULL
        SET u.role = CASE WHEN u.isAdmin = true THEN 'admin' ELSE coalesce(u.role, 'user') END
        REMOVE u.isAdmin`);
      // An administrator takes part in the instance they administer, as one
      // made an administrator is approved then. Accounts from before approval
      // existed otherwise wait for one, so this keeps administration
      // reachable to approve them.
      await session.run(`MATCH (u:User {role: 'admin'})
        WHERE u.id IS NOT NULL AND u.accountDeletedAt IS NULL AND u.approvedAt IS NULL
        SET u.approvedAt = $now`, { now: new Date().toISOString() });
      await IdentityStore.verifyConstraints(session, pluginConstraints);
      await IdentityStore.verifyGroupRoles(session);
    } finally {
      await session.close();
    }
    return new IdentityStore(driver, composition.schemes, IdentityStore.composed(composition));
  }

  /** Attach to a database Kannabi has already opened, without writing to it.
   *
   * `open` installs constraints, backfills native Asset ids and migrates
   * identifiers, all of which are writes. A read-only consumer — the stdio MCP
   * server — must do none of that, so it verifies the same invariants instead
   * and fails closed on a database the application has never opened. It never
   * repairs one.
   */
  static async attachReadOnly(driver: Driver, composition: StoreComposition): Promise<IdentityStore> {
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      await IdentityStore.verifyConstraints(session, IdentityStore.pluginConstraints(composition));
      await IdentityStore.verifyGroupRoles(session);
      for (const plugin of composition.plugins ?? []) await plugin.persistence?.verify?.(session);
    } finally { await session.close(); }
    return new IdentityStore(driver, composition.schemes, IdentityStore.composed(composition));
  }

  /** Startup invariant: every membership carries a role, and nothing records
   * managing a Group apart from belonging to it.
   *
   * The earlier model held control as a separate `CONTROLS` edge. Kannabi has
   * no deployment whose data needs carrying across, so such data is refused
   * rather than converted: a development database is reseeded. */
  private static async verifyGroupRoles(session: Session): Promise<void> {
    const result = await session.run(`
      RETURN COUNT { MATCH ()-[:CONTROLS]->() } AS control,
        COUNT { MATCH ()-[m:MEMBER_OF]->() WHERE m.role IS NULL OR NOT m.role IN $roles } AS unroled`,
    { roles: [...groupRoles] });
    const control = Number(result.records[0].get('control'));
    const unroled = Number(result.records[0].get('unroled'));
    if (control || unroled) {
      throw new Error(`Group data predates Group roles (${control} control grants, ${unroled} memberships without a role); `
        + 'reseed this development database with `pnpm demo:reset`');
    }
  }

  /** Startup invariant: every uniqueness constraint the domain relies on is
   * installed. Reading `SHOW CONSTRAINTS` never modifies the database, so both
   * the read-write and the read-only entry can assert it. */
  private static async verifyConstraints(session: Session,
    pluginConstraints: readonly PluginConstraint[]): Promise<void> {
    const result = await session.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties RETURN *');
    for (const [label, properties] of [
      ['Settings', ['key']], ['MailConfiguration', ['key']], ['Media', ['key']], ['User', ['key']], ['Group', ['key']], ['Owner', ['key']],
      ['Migration', ['key']], ['Asset', ['id']], ['ExternalIdentity', ['canonical']],
      ['IndividualIdentifier', ['canonical']], ['IndividualIdentifier', ['key']],
      ['ClassIdentifier', ['canonical']], ['ClassIdentifier', ['key']],
      ...pluginConstraints.map((constraint) => [constraint.label, constraint.properties] as const),
    ] as (readonly [string, readonly string[]])[]) {
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

  /** One write transaction. Public for the installed plugins, which keep
   * their own data in this database and must commit it with the Asset change
   * it belongs to. */
  async write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session();
    try { return await session.executeWrite(work); }
    finally { await session.close(); }
  }

  /** One read transaction, for the same callers. */
  async read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try { return await session.executeRead(work); }
    finally { await session.close(); }
  }

  private async createEntity(label: 'User' | 'Group' | 'Owner', value: string): Promise<Entity> {
    const entity = { key: randomUUID(), name: requiredText(value, 'name') };
    await this.write(async (tx) => { await tx.run(`CREATE (n:${label} $entity)`, { entity }); });
    return entity;
  }

  /** A domain-only User, with no credential: for tests and tooling that need a
   * person in the graph without an account to sign in to. It is approved, so
   * it can take part in Groups. */
  async createUser(name: string): Promise<Entity> {
    const entity = { key: randomUUID(), name: requiredText(name, 'name') };
    await this.write(async (tx) => {
      await tx.run('CREATE (u:User $entity) SET u.approvedAt = $now', { entity, now: new Date().toISOString() });
    });
    return entity;
  }
  createGroup(name: string) { return this.createEntity('Group', name); }
  createOwner(name: string) { return this.createEntity('Owner', name); }

  async createReportingGroup(name: string, actorKey: string): Promise<Entity> {
    const group = { key: randomUUID(), name: requiredText(name, 'name') };
    return this.write(async (tx) => {
      // Whoever creates a Group is its first member and manages it.
      const result = await tx.run(`MATCH (u:User {key: $actorKey}) WHERE ${approvedAccount}
        CREATE (g:Group $group), (u)-[:MEMBER_OF {role: 'manager'}]->(g)
        RETURN g.key`, { actorKey, group });
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

  /** The viewer's own Groups, each with their role in it and how many people
   * and Assets it has.
   *
   * Every Asset a Group collaborates on is readable by its members, so the
   * Asset count is exactly what the viewer can read through that Group and
   * reveals nothing they could not already list. */
  async listMyGroups(actorKey: string): Promise<GroupSummary[]> {
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (:User {key: $actorKey})-[mine:MEMBER_OF]->(g:Group)
        RETURN g { .key, .name, role: mine.role,
          people: COUNT { MATCH (u:User)-[:MEMBER_OF]->(g) WHERE u.accountDeletedAt IS NULL },
          assets: COUNT { MATCH (g)-[:CAN_COLLABORATE]->(:Asset) } } AS summary
        ORDER BY toLower(summary.name), summary.key`, { actorKey: requiredText(actorKey, 'actorKey') }));
      return result.records.map((row) => {
        const summary = row.get('summary');
        return { ...summary, people: Number(summary.people), assets: Number(summary.assets) } as GroupSummary;
      });
    } finally { await session.close(); }
  }

  /** Recovery reads Group identity only, never an Asset or namespace ledger.
   * The operator sees stranded Groups without acquiring membership. */
  async listUnmanagedGroups(actorKey: string): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      return await session.executeRead(async (tx) => {
        const allowed = await tx.run(`MATCH (admin:User {key: $actorKey, role: 'admin'})
          WHERE admin.id IS NOT NULL AND admin.accountDeletedAt IS NULL
          RETURN admin.key`, { actorKey });
        if (!allowed.records.length) throw new AdministrationError('Administrator access required');
        const result = await tx.run(`MATCH (g:Group)
          WHERE NOT EXISTS { MATCH (:User)-[:MEMBER_OF {role: 'manager'}]->(g) }
          RETURN g { .key, .name } AS group ORDER BY group.name`);
        return result.records.map((row) => row.get('group') as Entity);
      });
    } finally { await session.close(); }
  }

  /** Make one of an unmanaged Group's own members its Group Manager.
   *
   * Only an existing member, so recovery never adds a membership and never
   * opens a Group's Assets to anybody — the administrator included. A Group
   * with no members has nobody to promote and stays unmanaged. The User is
   * locked before the Group, as every Group write orders them, and the Group
   * lock serializes recoveries. */
  async appointGroupManager(actorKey: string, groupKey: string, userKey: string): Promise<void> {
    await this.write(async (tx) => {
      const authorized = await tx.run(`MATCH (admin:User {key: $actorKey, role: 'admin'})
        WHERE admin.id IS NOT NULL AND admin.accountDeletedAt IS NULL
        RETURN admin.key`, { actorKey });
      if (!authorized.records.length) throw new AdministrationError('Administrator access required');
      await tx.run('MATCH (u:User {key: $userKey}) SET u.lock = true', { userKey });
      const group = await tx.run('MATCH (g:Group {key: $groupKey}) SET g.lock = true RETURN g.key', { groupKey });
      if (!group.records.length) throw new ReferenceError('Group not found');
      const appointed = await tx.run(`MATCH (u:User {key: $userKey})-[m:MEMBER_OF]->(g:Group {key: $groupKey})
        WHERE ${approvedAccount}
          AND NOT EXISTS { MATCH (:User)-[:MEMBER_OF {role: 'manager'}]->(g) }
        SET m.role = 'manager' RETURN g.key`, { groupKey, userKey });
      if (!appointed.records.length) throw new ReferenceError('Unmanaged Group or member not found');
    });
  }

  /** One Group as this viewer stands in it: its identity and the viewer's role.
   *
   * Reachable by the Group's members. Anybody else — a system administrator
   * included — is answered exactly as for a Group that does not exist, so the
   * address is never a way to confirm that a Group exists.
   */
  async groupRelationship(actorKey: string, groupKey: string): Promise<GroupRelationship> {
    const params = {
      actorKey: requiredText(actorKey, 'actorKey'), groupKey: requiredText(groupKey, 'groupKey'),
    };
    const session = this.driver.session();
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (actor:User {key: $actorKey})-[m:MEMBER_OF]->(g:Group {key: $groupKey})
        WHERE actor.accountDeletedAt IS NULL
        RETURN g { .key, .name } AS group, m.role AS role`, params));
      if (!result.records.length) throw new ReferenceError('Group not found');
      return { group: result.records[0].get('group') as Entity, viewer: { role: result.records[0].get('role') } };
    } finally { await session.close(); }
  }

  /** Everybody in a Group, with their role, for any of its members.
   *
   * A member already shares this Group with each of them, so listing them
   * discloses nobody new. Unbounded, like every list of people in a Group: it
   * is a working set, not a corpus, and a partial list would be the wrong
   * basis for deciding whom to remove. Addresses follow the People directory
   * setting.
   */
  async listGroupMembers(actorKey: string, groupKey: string): Promise<GroupPerson[]> {
    const params = {
      actorKey: requiredText(actorKey, 'actorKey'), groupKey: requiredText(groupKey, 'groupKey'),
    };
    const session = this.driver.session();
    try {
      return await session.executeRead(async (tx) => {
        const authorized = await tx.run(`
          MATCH (actor:User {key: $actorKey})-[:MEMBER_OF]->(:Group {key: $groupKey})
          WHERE actor.accountDeletedAt IS NULL
          RETURN actor.key`, params);
        if (!authorized.records.length) throw new ReferenceError('Group not found');
        const result = await tx.run(`
          MATCH (u:User)-[m:MEMBER_OF]->(:Group {key: $groupKey})
          WHERE u.accountDeletedAt IS NULL
          RETURN ${attribution('u', 'u.key')} AS member, m.role AS role, ${directoryEmail} AS email
          ORDER BY toLower(coalesce(u.name, '')), u.key`, params);
        return result.records.map((row) =>
          ({ ...row.get('member'), role: row.get('role'), email: row.get('email') ?? null }) as GroupPerson);
      });
    } finally { await session.close(); }
  }

  /** Add somebody to a Group, as one of its Group Managers.
   *
   * Only a participant: a pending account takes no part in any Group. The
   * target User is locked before the Group, the order every Group write takes,
   * so an addition racing a deletion or a role change leaves one coherent
   * result. Adding somebody already in the Group changes nothing — their role
   * is changed deliberately, with `setMemberRole`, never as a side effect. */
  async addGroupMember(actorKey: string, groupKey: string, userKey: string,
    role: GroupRole = 'member'): Promise<boolean> {
    const params = {
      actorKey: requiredText(actorKey, 'actorKey'), groupKey: requiredText(groupKey, 'groupKey'),
      userKey: requiredText(userKey, 'userKey'), role: groupRole(role),
    };
    return this.write(async (tx) => {
      await tx.run('MATCH (u:User {key: $userKey}) SET u.lock = true', params);
      await tx.run('MATCH (g:Group {key: $groupKey}) SET g.lock = true', params);
      const result = await tx.run(`
        MATCH (actor:User {key: $actorKey})-[:MEMBER_OF {role: 'manager'}]->(g:Group {key: $groupKey})
        WHERE actor.accountDeletedAt IS NULL
        MATCH (u:User {key: $userKey}) WHERE ${approvedAccount}
        OPTIONAL MATCH (u)-[existing:MEMBER_OF]->(g)
        FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
          CREATE (u)-[:MEMBER_OF {role: $role}]->(g))
        RETURN existing IS NULL AS added`, params);
      if (!result.records.length) throw new ReferenceError('Group management or target User not found');
      return result.records[0].get('added') === true;
    });
  }

  /** Make a member a Group Manager, or a Group Manager an ordinary member.
   *
   * Group Managers are peers: any of them may change anybody's role, their
   * own included, and a Group may deliberately be left with none — an
   * administrator can then promote one of its members. No successor is ever
   * inferred. The person stays a member either way. */
  async setMemberRole(actorKey: string, groupKey: string, userKey: string,
    role: GroupRole): Promise<{ changed: boolean }> {
    const params = {
      actorKey: requiredText(actorKey, 'actorKey'), groupKey: requiredText(groupKey, 'groupKey'),
      userKey: requiredText(userKey, 'userKey'), role: groupRole(role),
    };
    return this.write(async (tx) => {
      await tx.run('MATCH (u:User {key: $userKey}) SET u.lock = true', params);
      await tx.run('MATCH (g:Group {key: $groupKey}) SET g.lock = true', params);
      const authorized = await tx.run(`
        MATCH (actor:User {key: $actorKey})-[:MEMBER_OF {role: 'manager'}]->(g:Group {key: $groupKey})
        WHERE actor.accountDeletedAt IS NULL
        OPTIONAL MATCH (:User {key: $userKey})-[m:MEMBER_OF]->(g)
        RETURN m.role AS current`, params);
      if (!authorized.records.length) throw new ReferenceError('Group not found');
      const current = authorized.records[0].get('current');
      if (current === null) throw new ReferenceError('Group member not found');
      if (current === params.role) return { changed: false };
      await tx.run(`MATCH (:User {key: $userKey})-[m:MEMBER_OF]->(:Group {key: $groupKey})
        SET m.role = $role`, params);
      return { changed: true };
    });
  }

  /** End somebody's membership, as one of the Group's Managers.
   *
   * Their role ends with it: there is no managing a Group without belonging
   * to it. Collaboration, namespaces, issuance and `reportedBy` are untouched,
   * and an empty Group stays valid. Removing somebody who is not a member is
   * an authorized no-op, and removing yourself is leaving. */
  async removeGroupMember(actorKey: string, groupKey: string, userKey: string): Promise<{ changed: boolean }> {
    const params = {
      actorKey: requiredText(actorKey, 'actorKey'),
      groupKey: requiredText(groupKey, 'groupKey'),
      userKey: requiredText(userKey, 'userKey'),
    };
    return this.write(async (tx) => {
      await tx.run('MATCH (u:User {key: $userKey}) SET u.lock = true', params);
      await tx.run('MATCH (g:Group {key: $groupKey}) SET g.lock = true', params);
      const authorized = await tx.run(`
        MATCH (actor:User {key: $actorKey})-[:MEMBER_OF {role: 'manager'}]->(:Group {key: $groupKey})
        WHERE actor.accountDeletedAt IS NULL
        RETURN actor.key`, params);
      if (!authorized.records.length) throw new ReferenceError('Group not found');
      const removed = await tx.run(`
        MATCH (:User {key: $userKey})-[m:MEMBER_OF]->(:Group {key: $groupKey})
        DELETE m RETURN count(*) AS removed`, params);
      return { changed: removed.records[0].get('removed').toNumber() > 0 };
    });
  }

  /** Leave a Group. Any role goes with the membership; a Group left with no
   * Group Manager stays valid and is recoverable by an administrator. */
  async leaveGroup(actorKey: string, groupKey: string): Promise<void> {
    await this.write(async (tx) => {
      await tx.run('MATCH (u:User {key: $actorKey}) SET u.lock = true', { actorKey });
      await tx.run('MATCH (g:Group {key: $groupKey}) SET g.lock = true', { groupKey });
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[m:MEMBER_OF]->(g:Group {key: $groupKey})
        DELETE m RETURN g.key`, { actorKey, groupKey });
      if (!result.records.length) throw new ReferenceError('Group membership not found');
    });
  }

  async addMember(userKey: string, groupKey: string, role: GroupRole = 'member'): Promise<void> {
    const params = {
      userKey: requiredText(userKey, 'userKey'), groupKey: requiredText(groupKey, 'groupKey'), role: groupRole(role),
    };
    await this.write(async (tx) => {
      const result = await tx.run(`MATCH (u:User {key: $userKey}), (g:Group {key: $groupKey})
        WHERE u.accountDeletedAt IS NULL
        MERGE (u)-[m:MEMBER_OF]->(g) ON CREATE SET m.role = $role RETURN g.key`, params);
      if (!result.records.length) throw new ReferenceError('User or Group does not exist');
    });
  }

  async reportAsset(value: ReportAsset, context: ReportingContext, photoKey: string | null = null,
    origin: ChangeOrigin = {}): Promise<Asset> {
    const input = record(value, ['name', 'identifiers', 'ownerKey', 'sourceRecord']);
    const actor = record(context, ['actorKey', 'groupKey']);
    // Every rule that needs nothing stored is checked here, before the
    // transaction opens; a rule that depends on what the instance holds is the
    // owning plugin's, and is applied inside the transaction below.
    const identifiers = this.schemes.acceptAll(input.identifiers);
    const params = {
      assetId: newAssetId(),
      name: requiredText(input.name, 'name'),
      actorKey: requiredText(actor.actorKey, 'actorKey'),
      groupKey: requiredText(actor.groupKey, 'groupKey'),
      ownerKey: input.ownerKey === undefined ? null : requiredText(input.ownerKey, 'ownerKey'),
      ...identifierParams(identifiers),
      ...changeParams(origin),
      // Validated before the transaction opens, with every other input, so a
      // malformed attribution fails the whole report rather than creating an
      // Asset that then has to be corrected.
      ...sourceRecordParams(input.sourceRecord),
      photoKey,
    };
    try {
      return await this.write(async (tx) => {
        const policy = await tx.run(`MATCH (s:Settings {key: 'instance'}) SET s.revision = s.revision + 1
          RETURN s.requirePhoto AS required`);
        if (!photoKey && policy.records[0].get('required')) throw new ValidationError('A photo is required when reporting an Asset');
        await assertClassSchemes(tx, identifiers);
        for (const participant of this.participants) {
          await participant.beforeIdentifiers(tx, { assetId: params.assetId, existing: [], additions: identifiers });
        }
        if (photoKey) await this.consumePhoto(tx, photoKey);
        const result = await tx.run(`
          MATCH (u:User {key: $actorKey})-[:MEMBER_OF]->(g:Group {key: $groupKey})
          OPTIONAL MATCH (o:Owner {key: $ownerKey})
          WITH u, g, o WHERE $ownerKey IS NULL OR o IS NOT NULL
          CREATE (a:Asset {id: $assetId, name: $name, reportedAt: datetime(), isPublic: false})
          ${recordChange}
          ${recordSource}
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
        for (const participant of this.participants) await participant.afterIdentifiers(tx, params.assetId);
        return assetFrom(result.records[0].get('asset'), this.schemes);
      });
    } catch (error) {
      // CREATE, rather than MERGE, makes every second claim a conflict.
      // The database constraint arbitrates concurrent transactions atomically.
      if (isConstraintViolation(error)) {
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
      return result.records.length ? assetFrom(result.records[0].get('asset'), this.schemes) : null;
    } finally { await session.close(); }
  }

  /** Control authorizes delegation, membership supplies Asset authority. The
   * same actor must represent both sides of a grant; no implicit invitations. */
  async setAssetCollaboration(id: string, actorKey: string, groupKey: string, grant: boolean,
    origin: ChangeOrigin = {}): Promise<{ changed: boolean }> {
    const params = { assetId: assetId(id), actorKey,
      groupKey: requiredText(groupKey, 'groupKey'), ...changeParams(origin) };
    return this.write(async (tx) => {
      // User first: membership departure/deletion cannot invalidate a checked
      // authority while this operation waits for the Asset serialization lock.
      await tx.run('MATCH (u:User {key: $actorKey}) SET u.lock = true', params);
      await tx.run(`${assetMatch} SET a.lock = true`, params);
      const allowed = await tx.run(`${assetMatch}
        MATCH (actor:User {key: $actorKey})-[:MEMBER_OF {role: 'manager'}]->(target:Group {key: $groupKey})
        WHERE actor.accountDeletedAt IS NULL AND ${collaboration}
          ${grant ? `AND EXISTS { MATCH (actor)-[:MEMBER_OF {role: 'manager'}]->(source:Group)-[:CAN_COLLABORATE]->(a) }` : ''}
        RETURN EXISTS { MATCH (target)-[:CAN_COLLABORATE]->(a) } AS linked,
          EXISTS { MATCH (other:Group)-[:CAN_COLLABORATE]->(a) WHERE other <> target } AS hasOther`, params);
      if (!allowed.records.length) throw new ReferenceError('Asset access or Group control not found');
      const row = allowed.records[0];
      if (row.get('linked') === grant) return { changed: false };
      if (!grant && !row.get('hasOther')) {
        throw new LastCollaborationError('An Asset must retain at least one collaboration Group');
      }
      await tx.run(`${assetMatch} MATCH (g:Group {key: $groupKey})
        ${grant ? 'CREATE (g)-[:CAN_COLLABORATE]->(a)'
          : 'MATCH (g)-[edge:CAN_COLLABORATE]->(a) DELETE edge'}
        WITH DISTINCT a ${recordChange} RETURN a.id`, params);
      return { changed: true };
    });
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
    // The level is derived by the scheme, so the label and relationship follow
    // from it rather than from anything the query layer knows. The scheme is
    // matched too: the same canonical form under another scheme is a different
    // identity, and must not answer for this one.
    const individual = level === 'individual';
    const identifierMatch = `MATCH (a:Asset)-[:${individual ? 'IDENTIFIED_BY' : 'CLASSIFIED_AS'}]->
      (:${individual ? 'IndividualIdentifier' : 'ClassIdentifier'} {canonical: $canonical, scheme: $scheme})`;
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
      { canonical, scheme, after, fetchSize: int(limit + 1), ...audienceParameters(audience) }));
      const row = result.records[0];
      const rows = row.get('rows') as StoredAsset[];
      const assets = rows.slice(0, limit).map((stored) => assetFrom(stored, this.schemes));
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
          WITH a, (${textPredicate} AND ${filterPredicate}) AS matches,
            ${collaboration} AS inGroup,
            EXISTS { MATCH (a)-[:REPORTED_BY]->(:User {key: $actorKey}) } AS mine
          RETURN count(a) AS total,
            {all: count(CASE WHEN matches THEN 1 END),
             mine: count(CASE WHEN matches AND mine THEN 1 END),
             group: count(CASE WHEN matches AND inGroup AND a.isPublic = false THEN 1 END),
             public: count(CASE WHEN matches AND a.isPublic = true THEN 1 END)} AS scopes
        }
        CALL {
          MATCH (a:Asset)
          WHERE ${readableAsset} AND ${textPredicate}
            AND ${filterPredicate}
            AND ($scope = 'all' OR ($scope = 'public' AND a.isPublic = true)
              OR ($scope = 'group' AND a.isPublic = false AND ${collaboration})
              OR ($scope = 'mine' AND EXISTS { MATCH (a)-[:REPORTED_BY]->(:User {key: $actorKey}) }))
            AND ${keysetPredicate(sort, dir)}
          WITH a ${order} LIMIT $fetchSize
          ${assetRowsProjection(order, true)}
        }
        RETURN total, scopes, rows`,
      { text, scope, after, fetchSize: int(limit + 1),
        ...audienceParameters(audience), ...filterParameters(filters) }));
      const row = result.records[0];
      const rows = (row.get('rows') as (StoredAsset & { matchedFields: MatchedField[] })[]).slice(0, limit);
      const assets = rows.map(({ matchedFields: _matched, ...stored }) => assetFrom(stored, this.schemes));
      const matchedFields = Object.fromEntries(rows.map((stored) => [stored.id, stored.matchedFields]));
      const scopes = Object.fromEntries(Object.entries(row.get('scopes')).map(([key, value]) =>
        [key, (value as { toNumber(): number }).toNumber()])) as Record<AssetScope, number>;
      return { assets, matchedFields, total: row.get('total').toNumber(), scopes, matching: scopes[scope],
        nextCursor: (row.get('rows') as unknown[]).length > limit ? assetCursor(request, assets.at(-1)!) : null };
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

  async users(actorKey: string): Promise<UserAccount[]> {
    return this.write(async (tx) => {
      const allowed = await tx.run("MATCH (:User {key: $actorKey, role: 'admin'}) RETURN true", { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const result = await tx.run(`MATCH (u:User) WHERE u.id IS NOT NULL RETURN ${userAccountProjection} AS user ORDER BY toLower(u.name), u.key`);
      return result.records.map((row) => row.get('user'));
    });
  }

  async profile(actorKey: string): Promise<UserAccount> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL RETURN ${userAccountProjection} AS user`, { actorKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('user');
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
    if (!actorKey) return { isAdmin: false, approved: false, appearance: 'system', gravatar: false, avatarHash: null };
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey})
      RETURN u.role = 'admin' AS isAdmin, u.approvedAt IS NOT NULL AS approved,
        coalesce(u.appearance, 'system') AS appearance,
        coalesce(u.gravatar, false) AS gravatar, u.email AS email`, { actorKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    const appearance = result.records[0].get('appearance');
    if (!isAppearancePreference(appearance)) throw new Error('Stored User appearance is invalid');
    // Absent unless this User turned it on, so a stored address alone never
    // produces a third-party identifier.
    const gravatar = result.records[0].get('gravatar') === true;
    const email = result.records[0].get('email');
    const avatarHash = gravatar && typeof email === 'string' ? gravatarIdentifier(email) : null;
    return { isAdmin: result.records[0].get('isAdmin') === true, approved: result.records[0].get('approved') === true,
      appearance, gravatar, avatarHash };
  }

  /** A User as another User may see them.
   *
   * Shared Group membership supplies visibility. The avatar exists only where
   * its owner asked for one, and the Asset count is counted through the
   * viewer's own readability rule, so it can never reveal an unreadable Asset.
   *
   * Non-shared Group membership is deliberately absent: being findable never
   * says which Groups somebody is in. The address follows the People directory
   * setting (`directoryEmail`).
   */
  private static discovered(row: Neo4jRecord, actorKey: string): UserProfile {
    const gravatar = row.get('gravatar') === true;
    const email = row.get('email');
    const sharedGroups = [...row.get('sharedGroups') as Entity[]]
      .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
    return {
      key: row.get('key'),
      name: row.get('name'),
      // Derived per request from consent, never stored and never returned as
      // an address: the hash is one-way and exists only for a User who asked
      // for Gravatar.
      avatarHash: gravatar && typeof email === 'string' ? gravatarIdentifier(email) : null,
      sharedGroups: Object.freeze(sharedGroups),
      reportedAssets: row.get('reportedAssets').toNumber(),
      self: row.get('key') === actorKey,
      email: typeof row.get('shownEmail') === 'string' ? row.get('shownEmail') : null,
    };
  }

  /** The People directory: who this viewer may find, optionally narrowed by
   * a search, at most `limit` at a time.
   *
   * The search matches a display name, and an email address only where this
   * viewer is shown it — matching an address they cannot see would answer
   * whether it belongs to somebody here. `more` says the search should be
   * narrowed; there is deliberately no paging through the whole instance.
   * Administrator status and readable reporting provenance never broaden it.
   */
  async listPeople(actorKey: string, request: { query?: string | null; limit?: number } = {}):
    Promise<{ people: UserProfile[]; more: boolean }> {
    const query = (request.query ?? '').trim().toLowerCase();
    if (query.length > 200) throw new ValidationError('Search text is too long');
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1 to 100');
    const parameters = { actorKey: requiredText(actorKey, 'actorKey'), query: query || null, fetch: neo4j.int(limit + 1) };
    const result = await this.write((tx) => tx.run(`
      MATCH (u:User) WHERE ${inDirectory}
      WITH u, ${directoryEmail} AS shownEmail
      WHERE $query IS NULL OR toLower(u.name) CONTAINS $query
        OR (shownEmail IS NOT NULL AND toLower(shownEmail) CONTAINS $query)
      WITH u, shownEmail ORDER BY toLower(u.name), u.key LIMIT $fetch
      OPTIONAL MATCH (a:Asset)-[:REPORTED_BY]->(u) WHERE ${readableByViewer}
      OPTIONAL MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(sharedGroup:Group)
        WHERE EXISTS { MATCH (u)-[:MEMBER_OF]->(sharedGroup) }
      RETURN ${discoveredUser}, shownEmail ORDER BY toLower(u.name), u.key`, parameters));
    const people = result.records.map((row) => IdentityStore.discovered(row, parameters.actorKey));
    return { people: people.slice(0, limit), more: people.length > limit };
  }

  async userProfile(actorKey: string, targetKey: string): Promise<UserProfile | null> {
    const parameters = { actorKey: requiredText(actorKey, 'actorKey') };
    const result = await this.write((tx) => tx.run(`
      MATCH (u:User {key: $targetKey}) WHERE ${inDirectory}
      WITH u, ${directoryEmail} AS shownEmail
      OPTIONAL MATCH (a:Asset)-[:REPORTED_BY]->(u) WHERE ${readableByViewer}
      OPTIONAL MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(sharedGroup:Group)
        WHERE EXISTS { MATCH (u)-[:MEMBER_OF]->(sharedGroup) }
      RETURN ${discoveredUser}, shownEmail`,
    { ...parameters, targetKey: requiredText(targetKey, 'user key') }));
    if (!result.records.length) return null;
    return IdentityStore.discovered(result.records[0], parameters.actorKey);
  }

  /** Records whether this User wants Gravatar used for their own avatar.
   *
   * Turning it off removes the stored consent, and the identifier is derived
   * per request rather than stored, so nothing survives to be rendered
   * afterwards.
   */
  async updateGravatar(actorKey: string, value: unknown): Promise<boolean> {
    const input = record(value, ['gravatar']);
    if (typeof input.gravatar !== 'boolean') throw new ValidationError('Gravatar preference must be a boolean');
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL
      SET u.gravatar = $gravatar RETURN u.gravatar AS gravatar`,
    { actorKey, gravatar: input.gravatar }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('gravatar') === true;
  }

  async updateAppearance(actorKey: string, value: unknown): Promise<AppearancePreference> {
    const input = record(value, ['appearance']);
    if (!isAppearancePreference(input.appearance)) throw new ValidationError('Supported appearance is required');
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE u.id IS NOT NULL
      SET u.appearance = $appearance RETURN u.appearance AS appearance`, { actorKey, appearance: input.appearance }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return result.records[0].get('appearance');
  }

  async managedUserAccount(actorKey: string, targetKey: string): Promise<ManagedUserAccount> {
    const result = await this.write((tx) => tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}),
      (u:User {key: $targetKey}) WHERE u.id IS NOT NULL
      RETURN ${userAccountProjection} AS user, u.id AS id`, { actorKey, targetKey }));
    if (!result.records.length) throw new ReferenceError('User not found');
    return { ...result.records[0].get('user'), id: result.records[0].get('id') };
  }

  async updateUserRole(actorKey: string, targetKey: string, isAdmin: boolean): Promise<UserAccount> {
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
        SET u.role = $role, u.updatedAt = $updatedAt,
          // An administrator takes part in the instance they administer.
          u.approvedAt = CASE WHEN $role = 'admin' THEN coalesce(u.approvedAt, $updatedAt) ELSE u.approvedAt END
        RETURN ${userAccountProjection} AS user`, { targetKey, updatedAt: new Date().toISOString(), role: isAdmin ? 'admin' : 'user' });
      return result.records[0].get('user');
    });
  }

  async deactivateUser(actorKey: string, targetKey: string): Promise<void> {
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
      await tx.run('MATCH (u:User {key: $targetKey}) SET u.lock = true', { targetKey });
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

  /** Whether this account takes part in the instance, read on every request
   * so an approval or a deletion takes effect immediately. */
  async isParticipant(actorKey: string): Promise<boolean> {
    const result = await this.write((tx) => tx.run(`MATCH (u:User {key: $actorKey}) WHERE ${participant}
      RETURN u.key`, { actorKey: requiredText(actorKey, 'actorKey') }));
    return result.records.length > 0;
  }

  /** Let a waiting account take part in the instance. Approving an account
   * already approved changes nothing. Rejecting one is deleting it, through
   * the ordinary administrator deletion, so a rejected applicant leaves no
   * account behind and may apply again. */
  async approveUser(actorKey: string, targetKey: string): Promise<{ changed: boolean }> {
    return this.write(async (tx) => {
      const allowed = await tx.run(`MATCH (admin:User {key: $actorKey, role: 'admin'})
        WHERE admin.accountDeletedAt IS NULL RETURN admin.key`, { actorKey });
      if (!allowed.records.length) throw new AdministrationError('Administrator access required');
      const result = await tx.run(`MATCH (u:User {key: $targetKey}) WHERE ${activeUser}
        WITH u, u.approvedAt IS NULL AS waiting
        SET u.approvedAt = coalesce(u.approvedAt, $now)
        RETURN waiting`, { targetKey, now: new Date().toISOString() });
      if (!result.records.length) throw new ReferenceError('User not found');
      return { changed: result.records[0].get('waiting') === true };
    });
  }

  async settings(): Promise<Settings> {
    const result = await this.write((tx) => tx.run(`MATCH (s:Settings {key: 'instance'}) RETURN ${settingsProjection} AS settings`));
    return result.records[0].get('settings');
  }

  /** Change the settings a request names, and only those. */
  async updateSettings(actorKey: string, value: unknown): Promise<Settings> {
    const change = validateSettingsChange(value);
    return this.write(async (tx) => {
      const state = await tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}), (s:Settings {key: 'instance'})
        SET s.revision = s.revision + 1
        RETURN ${settingsProjection} AS settings`, { actorKey });
      if (!state.records.length) throw new ReferenceError('Administrator access required');
      const current = state.records[0].get('settings') as Settings;
      const settings: Settings = { ...current, ...change };
      const result = await tx.run(`MATCH (:User {key: $actorKey, role: 'admin'}), (s:Settings {key: 'instance'})
        SET ${Object.keys(defaultSettings).map((name) => `s.${name} = $settings.${name}`).join(', ')}
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

  /** Attach an externally assigned identifier to an existing Asset. This path
   * validates the value through its scheme and records no issuance claim.
   * Group authorization is unchanged. */
  async attachIdentifier(id: string, actorKey: string, value: unknown,
    origin: ChangeOrigin = {}): Promise<Asset> {
    const identifier = this.schemes.accept(value);
    const assetKey = assetId(id);
    try {
      return await this.write(async (tx) => {
        await this.attachWithin(tx, assetKey, actorKey, identifier, origin);
        return this.assetWithin(tx, assetKey, actorKey);
      });
    } catch (error) {
      if (isConstraintViolation(error)) {
        throw new DuplicateIdentityError('The individual identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }

  /** The one attachment implementation: Asset authorization, the installed
   * identifier rules, each plugin's part, persistence and provenance.
   *
   * Public so a plugin that issues a value can attach it in the transaction
   * that records the issuance. It is still core that authorizes and writes:
   * the actor must collaborate on the Asset, whoever is calling. */
  async attachWithin(tx: ManagedTransaction, assetKey: string, actorKey: string, identifier: Identifier,
    origin: ChangeOrigin = {}): Promise<void> {
    await tx.run(`${assetMatch} SET a.lock = true`, { assetId: assetKey });
    const current = await tx.run(`${assetMatch} WHERE ${collaboration}
      RETURN ${assetIdentifierRows} AS identifiers`,
    { assetId: assetKey, actorKey });
    if (!current.records.length) throw new ReferenceError('Asset access not found');
    const existing = (current.records[0].get('identifiers') as StoredIdentifier[])
      .map((row) => this.schemes.restore(row.scheme, row.canonical, row.policyVersion));
    this.schemes.assertAddition(existing, identifier);
    await assertClassSchemes(tx, [identifier]);
    for (const participant of this.participants) {
      await participant.beforeIdentifiers(tx, { assetId: assetKey, existing, additions: [identifier] });
    }
    await tx.run(`${assetMatch} WHERE ${collaboration}
      ${recordChange}
      ${attachIdentifiers}`,
    { assetId: assetKey, actorKey, ...changeParams(origin), ...identifierParams([identifier]) });
    for (const participant of this.participants) await participant.afterIdentifiers(tx, assetKey);
  }

  /** One Asset as an actor who collaborates on it reads it, inside a write. */
  async assetWithin(tx: ManagedTransaction, assetKey: string, actorKey: string): Promise<Asset> {
    const result = await tx.run(`${assetMatch} WHERE ${collaboration} ${assetProjection}`,
      { assetId: assetKey, actorKey });
    if (!result.records.length) throw new ReferenceError('Asset access not found');
    return assetFrom(result.records[0].get('asset'), this.schemes);
  }

  /** Those of the named Assets this audience may read, inside a read. What a
   * plugin holds about an Asset never widens who may see the Asset itself. */
  async readableAssets(tx: ManagedTransaction, ids: readonly string[], audience: NamedAudienceInput): Promise<Asset[]> {
    const readable = await tx.run(`
      MATCH (a:Asset) WHERE a.id IN $ids AND ${readableAsset}
      ${assetRowsProjection('ORDER BY a.name ASC, a.id ASC')}`,
    { ids, ...audienceParameters(audience) });
    return (readable.records[0].get('rows') as StoredAsset[]).map((stored) => assetFrom(stored, this.schemes));
  }

  /** Detach an identifier by its attachment key. An individual identifier is
   * exclusive, so its node goes with the link; a class identifier node stays
   * while any other Asset still refers to it. */
  async detachIdentifier(id: string, actorKey: string, key: string,
    origin: ChangeOrigin = {}): Promise<Asset> {
    const assetKey = assetId(id);
    const identifierKey = requiredText(key, 'identifier key');
    return this.write(async (tx) => {
      await tx.run(`${assetMatch} SET a.lock = true`, { assetId: assetKey });
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
      for (const participant of this.participants) await participant.afterIdentifiers(tx, assetKey);
      const result = await tx.run(`${assetMatch} WHERE ${collaboration} ${assetProjection}`,
        { assetId: assetKey, actorKey });
      return assetFrom(result.records[0].get('asset'), this.schemes);
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
      await tx.run(`${assetMatch} SET a.lock = true`, { assetId: assetId(id) });
      const result = await tx.run(`${assetMatch} WHERE ${collaboration}
        MATCH (m:Media {key: $photoKey}) CREATE (a)-[:HAS_PHOTO]->(m)
        ${recordChange}
        WITH a ${assetProjection}`,
      { assetId: assetId(id), actorKey, photoKey, ...changeParams(origin) });
      if (!result.records.length) throw new ReferenceError('Asset access not found');
      return assetFrom(result.records[0].get('asset'), this.schemes);
    });
  }

  async beginPhotoDeletion(id: string, actorKey: string, photoKey: string,
    origin: ChangeOrigin = {}): Promise<void> {
    const result = await this.write(async (tx) => {
      await tx.run(`${assetMatch} SET a.lock = true`, { assetId: assetId(id) });
      return tx.run(`${assetMatch} WHERE ${collaboration}
        MATCH (a)-[relationship:HAS_PHOTO]->(m:Media {key: $photoKey, state: 'attached'})
        SET m.state = 'deleting', m.expiresAt = datetime()
        ${recordChange}
        DELETE relationship
        RETURN m.key`, {
        assetId: assetId(id), actorKey,
        photoKey: requiredText(photoKey, 'photoKey'),
        ...changeParams(origin),
      });
    });
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
      // Re-read collaboration after serializing with access revocation.
      await tx.run(`${assetMatch} SET a.lock = true`, params);
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
      return assetFrom(result.records[0].get('asset'), this.schemes);
    });
  }
}
