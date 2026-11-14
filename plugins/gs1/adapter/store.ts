import { randomUUID } from 'node:crypto';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import { int, type Integer } from 'neo4j-driver';
import { audienceParameters, type AudienceInput, type NamedAudienceInput } from '../../../server/asset-audience.js';
import { assetId, isAssetId } from '../../../server/asset-id.js';
import type { ChangeOrigin } from '../../../server/change-provenance.js';
import { record, requiredText, ValidationError } from '../../../server/identity.js';
import type { Identifier } from '../../../server/identifier.js';
import {
  AdministrationError, assetIdentifierRows, assetMatch, attribution, ConflictError, DuplicateIdentityError,
  groupManaged, isConstraintViolation, readableByViewer, ReferenceError,
  type Asset, type Entity, type IdentityStore, type ReporterAttribution,
} from '../../../server/identity-store.js';
import type { AssetWriteParticipant, PluginPersistence } from '../../../server/plugin.js';
import {
  adoptableClassKey, allocatedGiai, allocatedGraiAssetType, allocatedGraiSerial, allocatedGtin,
  allocatedGtinFormat, allocatedSgtin, assertAttachable, assertCompatible, canIssueClassKey, canonicalGcp,
  canonicalIdentifier, classKeyWithinGcp, gcpRefusalReason, gs1Policy,
  hasGtinConflict, isGs1Scheme, issuanceClassScheme,
  storedIdentifier, type ClassKeyScheme, type ExternalIdentifier, type IssuanceScheme,
} from '../toolkit/gs1.js';
import {
  allocatableSequence, canonicalExclusions, firstSequence, storedExclusions, type ExclusionRange,
} from '../toolkit/reference-allocation.js';
import { gs1LedgerCursor, type Gs1LedgerRequest } from './ledger.js';
import { refuse, refusing } from './refusal.js';

/** Everything the GS1 plugin keeps in Kannabi's database, and every operation
 * over it: namespaces, class keys, the issuance ledger, the GTIN consistency
 * policy and the set of Assets that conflict with it.
 *
 * The plugin owns the `Gs1…` node labels and the edges that leave them. It
 * never sets a property on a core node and never joins two core nodes. Where
 * an operation also changes an Asset, core does that part: this module calls
 * core's attachment and never writes an identifier or provenance itself.
 */

/** One page of the Assets that currently carry a GTIN conflict, as one reader
 * may see them.
 *
 * `total` counts every conflicting Asset in the instance, so the number that
 * blocks enforcement is never understated; `assets` lists only those the reader
 * can read, because system administration grants no Asset access, and
 * `hidden` says how many of the total that leaves out. `next` continues the
 * list after the last Asset shown, or is null when there are no more. */
export type GtinConflictPage = Readonly<{
  total: number;
  hidden: number;
  assets: readonly Readonly<{ id: string; name: string }>[];
  next: string | null;
}>;

/** Enforcement was asked to resume while Assets still carry conflicting GTINs. */
export class GtinConflictError extends ConflictError {
  constructor(readonly conflicts: GtinConflictPage) {
    super('GTIN consistency cannot be enabled while Assets carry conflicting GTINs', { gtinConflicts: conflicts });
  }
}

/** How many conflicting Assets one response lists. */
export const gtinConflictPageSize = 20;

/** One counter and the numbers it must never produce.
 *
 * The same arithmetic serves four counters with two different standings. A
 * namespace's reference counters are authoritative, because inside a managed
 * namespace Kannabi is the only allocator. A class key's serial counter is
 * not: serial non-duplication for a GTIN is the GTIN allocator's
 * responsibility as a party (GS1 General Specifications 26.0 §3.5.2), so
 * Kannabi discharges it for the serials it issues and records a commitment it
 * cannot enforce for serials issued elsewhere. The counters are kept as inline
 * state on whichever record owns them rather than as one shared node type, so
 * that difference stays visible where each is read.
 */
export type AllocationCounter = Readonly<{
  nextSequence: number;
  exclusions: readonly ExclusionRange[];
}>;

/** The counters a namespace owns. Independent by design: §2.3 states that a
 * GTIN and a GRAI sharing the same digits do not conflict, because the data
 * carrier distinguishes the two keys, so one prefix issues each key type from
 * its own sequence. */
export const namespaceCounters = ['giai', 'graiType', 'gtinItem'] as const;
export type NamespaceCounter = (typeof namespaceCounters)[number];

/** Which namespace counter a class-level scheme draws on. Separate counters
 * for the same prefix, because the two keys do not collide. */
const classKeyCounters: Readonly<Record<ClassKeyScheme, NamespaceCounter>> = {
  grai: 'graiType', gtin: 'gtinItem',
};
function classKeyCounter(scheme: ClassKeyScheme): NamespaceCounter {
  return classKeyCounters[scheme];
}
/** Refuse issuance from a prefix today's rules would not accept, saying why.
 *
 * Reachable only for a namespace configured under an earlier, looser policy.
 * Checked at the top of every issuance path so the caller gets the actual
 * reason rather than a validation error thrown from inside value
 * construction, and so the refusal reads the same as the capability the
 * namespace already reports.
 */
function refuseUnissuable(gcp: string): void {
  const reason = gcpRefusalReason(gcp);
  if (reason) {
    throw new ValidationError(`This namespace can no longer issue: ${reason}. Its issued values and ledger are unchanged.`);
  }
}

function classKeyScheme(value: unknown): ClassKeyScheme {
  if (value !== 'grai' && value !== 'gtin') {
    throw new ValidationError('A managed class key is a GTIN or a GRAI asset type');
  }
  return value;
}

/** A GS1 Company Prefix namespace a Group has configured for allocation.
 * `active` is configuration state, never allocation lifecycle. */
export type Gs1Namespace = Readonly<{
  key: string;
  gcp: string;
  active: boolean;
  counters: Readonly<Record<NamespaceCounter, AllocationCounter>>;
  /** Whether this prefix leaves room for a class reference at all. A prefix
   * too long for one stays fully valid for GIAI; this is reduced capability,
   * never an invalid namespace. */
  classKeyIssuable: boolean;
  /** Why this namespace can issue nothing at all, or null when it can.
   *
   * Only ever set for a namespace configured under an earlier, looser policy —
   * a prefix outside four to twelve digits, or in restricted-circulation
   * space. Kannabi keeps the record and its whole issuance ledger readable and
   * refuses new issuance, rather than rewriting the prefix or failing startup:
   * the values already issued from it were accepted when they were issued, and
   * a configuration value is not a reason to take a deployment offline.
   */
  unissuableReason: string | null;
  /** Which GTIN format this namespace's own allocations take, derived from
   * the prefix on every read. Presentation for whoever prints the symbol. */
  gtinFormat: 'GTIN-12' | 'GTIN-13';
  group: Entity;
  configuredAt: string;
  configuredBy: string;
}>;

/** A class-level key inside a managed namespace, and the serial space under
 * it.
 *
 * Two provenances, kept apart because they are different assertions.
 * `allocated` means Kannabi produced the reference from this namespace's
 * counter; `adopted` means the Group asserted a key it had already allocated
 * elsewhere into its own namespace so Kannabi may issue serials under it.
 * Neither is inferred from the other, and a row missing the discriminator is
 * rejected rather than defaulted.
 *
 * Deliberately absent: any name, description, product attribute, dimension or
 * image. This is allocation bookkeeping. It is not a trade item, a product or
 * an asset class, and giving it a label would be the cheapest way to answer
 * #50 by accretion.
 */
export type Gs1ClassKeyAllocation = Readonly<{
  key: string;
  scheme: ClassKeyScheme;
  canonical: string;
  gcp: string;
  namespaceKey: string;
  /** The counter position that produced it, or null when adopted. */
  sequence: number | null;
  provenance: 'allocated' | 'adopted';
  active: boolean;
  serial: AllocationCounter;
  assertedAt: string;
  assertedBy: ReporterAttribution;
}>;

/** One immutable issuance. Kannabi's claim to have allocated a value rests on
 * this record and nothing else — never on an Asset merely carrying a value
 * whose digits fall inside a managed prefix. */
export type Gs1KeyIssuance = Readonly<{
  key: string;
  scheme: IssuanceScheme;
  canonical: string;
  gcp: string;
  sequence: number;
  allocatedForAssetId: string;
  /** The class key this was serialised under, for GRAI and SGTIN. Null for a
   * GIAI, which is allocated straight from the prefix. */
  classKeyCanonical: string | null;
  allocatedAt: string;
  /** Public provenance in the same shape as `reportedBy`: who acted, rendered
   * through the same tombstone rules, never a bare stored actor key. */
  allocatedBy: ReporterAttribution;
}>;


/** A counter's three stored properties, named for the counter that owns them
 * so a reader never has to join to learn what a sequence counts. */
const counterProperties = (counter: string) => ({
  nextSequence: `${counter}NextSequence`,
  exclusionsFrom: `${counter}ExclusionsFrom`,
  exclusionsTo: `${counter}ExclusionsTo`,
});

/** Project one inline counter from `node` into a nested `{nextSequence, …}`. */
function counterProjection(node: string, counter: string): string {
  const property = counterProperties(counter);
  return `{ nextSequence: toFloat(${node}.${property.nextSequence}),
    exclusionsFrom: ${node}.${property.exclusionsFrom},
    exclusionsTo: ${node}.${property.exclusionsTo} }`;
}

type StoredCounter = { nextSequence: number; exclusionsFrom: unknown; exclusionsTo: unknown };
function counterFrom(stored: StoredCounter): AllocationCounter {
  return Object.freeze({
    nextSequence: stored.nextSequence,
    exclusions: storedExclusions(stored.exclusionsFrom, stored.exclusionsTo),
  });
}

/** `property: $property` assignments for one counter, for a CREATE clause,
 * paired with the parameters `counterParams` produces under the same names. */
function counterAssignments(counter: string): string {
  return Object.values(counterProperties(counter))
    .map((property) => `${property}: $${property}`).join(', ');
}

/** The parameters that initialise one counter on a freshly created record. */
function counterParams(counter: string, exclusions: readonly ExclusionRange[]) {
  const property = counterProperties(counter);
  return {
    [property.nextSequence]: int(firstSequence),
    [property.exclusionsFrom]: exclusions.map((range) => int(range.from)),
    [property.exclusionsTo]: exclusions.map((range) => int(range.to)),
  };
}

const namespaceProjection = `n { .key, .gcp, .active, .configuredBy,
  configuredAt: toString(n.configuredAt),
  counters: { ${namespaceCounters.map((counter) =>
    `${counter}: ${counterProjection('n', counter)}`).join(', ')} },
  group: head([(n)<-[:MANAGES_NAMESPACE]-(g:Group) | g { .key, .name }]) }`;

type StoredNamespace =
  Omit<Gs1Namespace, 'counters' | 'classKeyIssuable' | 'gtinFormat' | 'unissuableReason'>
  & { counters: Record<NamespaceCounter, StoredCounter> };

function namespaceFrom(stored: StoredNamespace): Gs1Namespace {
  const unissuableReason = gcpRefusalReason(stored.gcp);
  return Object.freeze({
    ...stored,
    counters: Object.freeze(Object.fromEntries(namespaceCounters
      .map((counter) => [counter, counterFrom(stored.counters[counter])])) as
        Record<NamespaceCounter, AllocationCounter>),
    // All three derived on every read from the prefix alone, never stored:
    // what a prefix may issue, what it can still issue under today's rules,
    // and which GTIN format it yields all follow from its digits.
    classKeyIssuable: unissuableReason === null && canIssueClassKey(stored.gcp),
    unissuableReason,
    gtinFormat: allocatedGtinFormat(stored.gcp),
  });
}

type StoredClassKey = Omit<Gs1ClassKeyAllocation, 'serial'> & { serial: StoredCounter };
function classKeyFrom(stored: StoredClassKey): Gs1ClassKeyAllocation {
  return Object.freeze({ ...stored, serial: counterFrom(stored.serial) });
}

/** The GS1 identifiers among what an Asset carries, as GS1 reads them. The
 * GTIN conflict set is a GS1 fact, and an identifier of another scheme is not
 * GS1's to interpret. */
type StoredIdentifier = Readonly<{ canonical: string; scheme: string; policyVersion: string }>;
function gs1Identifiers(rows: readonly StoredIdentifier[]): ExternalIdentifier[] {
  return rows.filter((row) => isGs1Scheme(row.scheme))
    .map((row) => storedIdentifier(row.scheme, row.canonical, row.policyVersion));
}


/** One ledger row together with the Asset it was issued for, when the audience
 * may read that Asset. `asset` is null for an issuance whose Asset is not
 * readable: the issuance is a Kannabi-owned fact, but it grants no Asset
 * access. */
export type Gs1LedgerEntry = Readonly<{ issuance: Gs1KeyIssuance; asset: Asset | null }>;
export type Gs1LedgerPage = Readonly<{
  namespace: Gs1Namespace;
  entries: readonly Gs1LedgerEntry[];
  matching: number;
  nextCursor: string | null;
}>;

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


/** One issuance as the domain sees it. Requires `issuance` and `allocator` in
 * scope. Shared by the Asset projection and by the ledger read, so an Asset's
 * issuances and a namespace's ledger can never describe the same record
 * differently. */
const issuanceProjection = `issuance { .key, .scheme, .canonical, .gcp,
      sequence: toFloat(issuance.sequence),
      allocatedAt: toString(issuance.allocatedAt), .allocatedForAssetId,
      classKeyCanonical: head([(issuance)-[:ISSUED_UNDER]->(c:Gs1ClassKeyAllocation) | c.canonical]),
      allocatedBy: ${attribution('allocator', 'issuance.allocatedBy')} }`;

/** One class key as the domain sees it. Requires `classKey` in scope. */
const classKeyProjection = `classKey { .key, .scheme, .canonical, .gcp, .provenance, .active,
      sequence: CASE WHEN classKey.sequence IS NULL THEN null ELSE toFloat(classKey.sequence) END,
      assertedAt: toString(classKey.assertedAt),
      assertedBy: ${attribution('asserter', 'classKey.assertedBy')},
      namespaceKey: head([(classKey)-[:IN_NAMESPACE]->(ns:Gs1Namespace) | ns.key]),
      serial: ${counterProjection('classKey', 'serial')} }`;


/** Which GS1 namespaces an audience may see. Requires `n` in scope.
 *
 * Reading stays with membership. Narrowing privileged mutation to Group Managers
 * says who may change a namespace, not who may know it exists: a member can
 * already see every value the Group issued on its own Assets, so hiding the
 * namespace from them would conceal nothing and would stop them finding out
 * who to ask. */
const visibleNamespace = `($systemRead OR EXISTS {
  MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(:Group)-[:MANAGES_NAMESPACE]->(n) })`;


/** Move pre-Phase-2 Assets from the single required SGTIN/GRAI claim to
 * external identifiers. Serialised on a migration node for the same reason
 * as the native-id backfill: a concurrent peer must observe committed work
 * rather than re-reading rows it is about to rewrite.
 *
 * Legacy shape is migrated; anything else is corruption and fails closed.
 * Nothing is repaired or discarded, and no class-level GTIN is materialised
 * from an SGTIN — that stays derivable.
 */
async function migrateLegacyIdentifiers(driver: Driver): Promise<void> {
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

/** Move the GIAI-only allocation schema onto the scheme-discriminated one.
 *
 * Serialised on its own migration node for the reason the native-id backfill
 * established: a concurrent peer must block and then observe committed work
 * rather than re-reading rows it is about to rewrite.
 *
 * Two rewrites, both shape-preserving:
 *
 *   Gs1Namespace   → Gs1Namespace, its single counter renamed to the GIAI
 *                     counter and the two class-reference counters started
 *                     at the first sequence with no exclusions.
 *   Gs1KeyIssuance  → Gs1KeyIssuance, scheme 'giai', its bare AI 8004 value
 *                     rebuilt into a canonical form through the GS1 boundary.
 *
 * Nothing gains authority it did not have. A namespace keeps exactly the
 * prefix it was configured with, a GIAI keeps the Asset it was issued for
 * and the sequence that produced it, and no class key is invented for a
 * GIAI, which has no class level to invent one from.
 */
async function migrateAllocation(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run("MERGE (m:Migration {key: 'gs1-allocation'}) SET m.lock = true");
      // The left-hand labels here are the OLD ones and must stay old: this
      // statement reads what the previous schema wrote. Renaming them to the
      // new labels would make the migration a no-op on a database that needs
      // it, and would strip the label off a namespace that does not.
      await tx.run(`MATCH (n:GiaiNamespace)
        SET n:Gs1Namespace,
          n.giaiNextSequence = n.nextSequence,
          n.giaiExclusionsFrom = n.exclusionsFrom,
          n.giaiExclusionsTo = n.exclusionsTo,
          n.graiTypeNextSequence = $first, n.graiTypeExclusionsFrom = [], n.graiTypeExclusionsTo = [],
          n.gtinItemNextSequence = $first, n.gtinItemExclusionsFrom = [], n.gtinItemExclusionsTo = []
        REMOVE n:GiaiNamespace, n.nextSequence, n.exclusionsFrom, n.exclusionsTo`,
      { first: int(firstSequence) });
    });
    for (;;) {
      const migrated = await session.executeWrite(async (tx) => {
        await tx.run("MERGE (m:Migration {key: 'gs1-allocation'}) SET m.lock = true");
        const legacy = await tx.run(`MATCH (l:GiaiAllocation)
          WITH l LIMIT $batch RETURN l.value AS value`, { batch: int(500) });
        if (!legacy.records.length) return 0;
        // Rebuilt through the GS1 boundary so migration validates rather
        // than transcribes, exactly as the identifier migration does.
        const rows = legacy.records.map((row) => {
          const value = row.get('value') as string;
          return { value, key: randomUUID(),
            canonical: canonicalIdentifier({ scheme: 'giai', assetReference: value }).canonical };
        });
        await tx.run(`UNWIND $rows AS row
          MATCH (l:GiaiAllocation {value: row.value})
          SET l:Gs1KeyIssuance, l.key = row.key, l.scheme = 'giai', l.canonical = row.canonical
          REMOVE l:GiaiAllocation, l.value
          WITH l
          MATCH (l)-[old:ALLOCATED_FROM]->(n:Gs1Namespace)
          CREATE (l)-[:ISSUED_FROM]->(n)
          DELETE old`, { rows });
        return rows.length;
      });
      if (!migrated) return;
    }
  } finally { await session.close(); }
}

/** Startup invariant: no GIAI-only allocation node survives, and every
 * migrated record carries what the domain needs to read it back. A row
 * missing its scheme or its provenance is corruption, never a default. */
async function verifyAllocation(session: Session): Promise<void> {
  // Old labels on purpose: this asserts that nothing from the previous
  // schema survived, so it is the one place that must still name them.
  const legacy = await session.run(`MATCH (n) WHERE n:GiaiNamespace OR n:GiaiAllocation
    RETURN count(n) AS remaining`);
  const remaining = legacy.records[0].get('remaining').toNumber();
  if (remaining) throw new Error(`${remaining} GIAI-only allocation node(s) could not be migrated`);
  const incomplete = await session.run(`MATCH (n:Gs1Namespace)
    WHERE ${namespaceCounters.map((counter) =>
  `n.${counter}NextSequence IS NULL`).join(' OR ')}
    RETURN count(n) AS invalid`);
  if (incomplete.records[0].get('invalid').toNumber()) {
    throw new Error('A GS1 namespace is missing an allocation counter');
  }
  const issuances = await session.run(`MATCH (n:Gs1KeyIssuance)
    WHERE n.key IS NULL OR n.scheme IS NULL OR n.canonical IS NULL OR n.allocatedForAssetId IS NULL
    RETURN count(n) AS invalid`);
  if (issuances.records[0].get('invalid').toNumber()) {
    throw new Error('An issuance record is missing required properties');
  }
  const classKeys = await session.run(`MATCH (n:Gs1ClassKeyAllocation)
    WHERE n.key IS NULL OR n.scheme IS NULL OR n.canonical IS NULL OR n.provenance IS NULL
      OR n.serialNextSequence IS NULL
    RETURN count(n) AS invalid`);
  if (classKeys.records[0].get('invalid').toNumber()) {
    throw new Error('A class key allocation is missing required properties');
  }
}


/** The GS1 plugin's settings, and the node that holds them.
 *
 * `enforceGtinConsistency` refuses an identifier whose AI 01 disagrees with
 * one the Asset already carries. On by default. It is an acceptance policy for
 * subsequent writes and nothing more: turning it off lets an instance record
 * conflicting GTINs it was told about and leaves the conflict visible, and it
 * never declares that one Asset is two trade items. Turning it back on is
 * refused while any Asset still holds a conflict, and removes nothing to make
 * it succeed. Syntax, check digits, uniqueness and the same-identifier-twice
 * rule do not depend on it.
 */
export type Gs1Settings = Readonly<{ enforceGtinConsistency: boolean }>;
export const defaultGs1Settings: Gs1Settings = Object.freeze({ enforceGtinConsistency: true });

/** Takes the write lock on the plugin's settings and reads them. Every
 * identifier write and every change of policy takes it before judging, so the
 * two are ordered: a write that commits after enforcement is switched back on
 * has been judged by it. */
const lockSettings = `MATCH (p:Gs1Settings {key: 'instance'}) SET p.revision = p.revision + 1
  RETURN p.enforceGtinConsistency AS enforceGtinConsistency`;

/** Brings one Asset's membership of the GTIN conflict set into line with the
 * identifiers it carries now.
 *
 * The set is `(:Gs1Settings {key: 'instance'})-[:HAS_GTIN_CONFLICT]->(:Asset)`:
 * references to the Assets whose AI 01 values name more than one trade item,
 * hung off the node that holds the policy they block. Every path that changes
 * an Asset's identifiers reaches this in the same transaction, after the
 * change and under the Asset lock, and it reads the identifiers back rather
 * than being told what they are, so membership is derived from the
 * relationships themselves and cannot be computed from a stale picture.
 * Whether they conflict is `hasGtinConflict`, the same rule enforcement
 * applies. Deleting an Asset takes the relationship with it. */
async function recordGtinConflict(tx: ManagedTransaction, assetKey: string): Promise<void> {
  const current = await tx.run(`${assetMatch} RETURN ${assetIdentifierRows} AS identifiers`,
    { assetId: assetKey });
  const identifiers = gs1Identifiers(current.records[0].get('identifiers') as StoredIdentifier[]);
  await tx.run(hasGtinConflict(identifiers)
    ? `MATCH (p:Gs1Settings {key: 'instance'}) ${assetMatch} MERGE (p)-[:HAS_GTIN_CONFLICT]->(a)`
    : `MATCH (:Gs1Settings {key: 'instance'})-[c:HAS_GTIN_CONFLICT]->(:Asset {id: $assetId}) DELETE c`,
  { assetId: assetKey });
}

/** Rebuilds the GTIN conflict set from the identifiers every Asset carries.
 *
 * Runs on every startup, after the settings node exists, so a database
 * written before the set was kept — or by a release that did not keep it —
 * starts out with every conflict it already holds, never with an empty set
 * that would let enforcement resume over them. Idempotent: it adds what is
 * missing, removes what no longer conflicts and leaves the rest. It reads
 * identifiers and writes only the set; no identifier association is changed.
 * It holds the settings lock for the whole rebuild, so no identifier write or
 * policy change interleaves with it. Only Assets carrying two or more
 * identifiers can conflict, so only those are read. */
async function reconcileGtinConflicts(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(lockSettings);
      const candidates = await tx.run(`MATCH (a:Asset)
        WHERE COUNT { (a)-[:IDENTIFIED_BY|CLASSIFIED_AS]->() } > 1
        RETURN a.id AS id, ${assetIdentifierRows} AS identifiers`);
      const conflicting = candidates.records
        .filter((row) => hasGtinConflict(gs1Identifiers(row.get('identifiers') as StoredIdentifier[])))
        .map((row) => row.get('id') as string);
      await tx.run(`MATCH (:Gs1Settings {key: 'instance'})-[c:HAS_GTIN_CONFLICT]->(a:Asset)
        WHERE NOT a.id IN $conflicting DELETE c`, { conflicting });
      await tx.run(`MATCH (p:Gs1Settings {key: 'instance'})
        UNWIND $conflicting AS id MATCH (a:Asset {id: id}) MERGE (p)-[:HAS_GTIN_CONFLICT]->(a)`, { conflicting });
    });
  } finally { await session.close(); }
}

/** Creates the plugin's settings node, and carries across the policy and the
 * conflict set an earlier release kept on core's own Settings node.
 *
 * That release stored `enforceGtinConsistency` as a core setting and hung the
 * conflict set off the core node. Both are GS1's, so they move here once: the
 * value is copied only when this node is first created, and the old property
 * and edges are then removed so core's node is left holding core's settings
 * alone. Nothing about any Asset or identifier changes. */
async function migrateSettings(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`OPTIONAL MATCH (s:Settings {key: 'instance'})
        MERGE (p:Gs1Settings {key: 'instance'})
          ON CREATE SET p.revision = 0,
            p.enforceGtinConsistency = coalesce(s.enforceGtinConsistency, $defaults.enforceGtinConsistency)
        WITH s WHERE s IS NOT NULL
        REMOVE s.enforceGtinConsistency
        WITH s
        OPTIONAL MATCH (s)-[c:HAS_GTIN_CONFLICT]->(:Asset)
        DELETE c`, { defaults: defaultGs1Settings });
    });
  } finally { await session.close(); }
}

/** GS1's part in a write that changes an Asset's identifiers.
 *
 * Before: the instance's GTIN consistency policy, read under its lock, and the
 * rule that a value Kannabi issued only ever returns to the Asset it was
 * issued for. After: the conflict set. An identifier of another scheme is not
 * GS1's to judge and passes untouched. */
export const gs1Participant: AssetWriteParticipant = Object.freeze({
  async beforeIdentifiers(tx: ManagedTransaction, write: Readonly<{
    assetId: string; existing: readonly Identifier[]; additions: readonly Identifier[] }>): Promise<void> {
    const additions = write.additions.filter((identifier) => isGs1Scheme(identifier.scheme)) as ExternalIdentifier[];
    if (!additions.length) return;
    const policy = await tx.run(lockSettings);
    const coherence = { enforceGtinConsistency: policy.records[0].get('enforceGtinConsistency') === true };
    const existing = write.existing.filter((identifier) => isGs1Scheme(identifier.scheme)) as ExternalIdentifier[];
    refuse(() => {
      if (existing.length) for (const addition of additions) assertAttachable(existing, addition, coherence);
      else assertCompatible(additions, coherence);
    });
    // A value Kannabi issued may only ever return to the Asset it was issued
    // for. One check for every scheme, matched on the canonical form: an
    // externally assigned value has no ledger row and keeps the ordinary
    // correction semantics of detaching from one Asset and attaching to
    // another. The ledger decides this, never the digits of the value.
    const issued = await tx.run(`MATCH (l:Gs1KeyIssuance) WHERE l.canonical IN $canonicals
      AND l.allocatedForAssetId <> $assetId RETURN l.canonical AS canonical LIMIT 1`,
    { canonicals: additions.map((identifier) => identifier.canonical), assetId: write.assetId });
    if (issued.records.length) throw new ValidationError('Kannabi issued that identifier for another Asset');
  },
  afterIdentifiers: recordGtinConflict,
});

export const gs1Persistence: PluginPersistence = Object.freeze({
  constraints: [
    { name: 'gs1_settings_key', label: 'Gs1Settings', properties: ['key'] },
    // One GCP has exactly one set of allocation counters, so a prefix can never
    // be configured twice and issue the same reference from two counters.
    { name: 'gs1_namespace_key', label: 'Gs1Namespace', properties: ['key'] },
    { name: 'gs1_namespace_gcp', label: 'Gs1Namespace', properties: ['gcp'] },
    // A class key is managed once. The canonical form carries the AI, so a GTIN
    // and a GRAI asset type made of the same digits are two different keys —
    // which is what section 2.3 says they are.
    { name: 'gs1_class_key_key', label: 'Gs1ClassKeyAllocation', properties: ['key'] },
    { name: 'gs1_class_key_canonical', label: 'Gs1ClassKeyAllocation', properties: ['canonical'] },
    // An issued value is issued once, and issuance is idempotent per scheme per
    // Asset. The second is a composite rather than a bare `allocatedForAssetId`
    // on purpose: it makes repeating one scheme's issuance a no-op while leaving
    // a GIAI, a serialised GRAI and an SGTIN free to coexist on one Asset.
    { name: 'gs1_issuance_key', label: 'Gs1KeyIssuance', properties: ['key'] },
    { name: 'gs1_issuance_canonical', label: 'Gs1KeyIssuance', properties: ['canonical'] },
    { name: 'gs1_issuance_asset', label: 'Gs1KeyIssuance', properties: ['scheme', 'allocatedForAssetId'] },
  ],
  async migrate(driver: Driver): Promise<void> {
    await migrateLegacyIdentifiers(driver);
    await migrateAllocation(driver);
    // Constraints from the GIAI-only schema, dropped once their nodes have been
    // migrated, so a database that carried them cannot keep enforcing a rule
    // the domain no longer holds — in particular one issuance per Asset, which
    // was only ever true because there was one scheme.
    const session = driver.session();
    try {
      for (const name of ['giai_namespace_key', 'giai_namespace_gcp', 'giai_allocation_value', 'giai_allocation_asset']) {
        await session.run(`DROP CONSTRAINT ${name} IF EXISTS`);
      }
    } finally { await session.close(); }
    await migrateSettings(driver);
    await reconcileGtinConflicts(driver);
  },
  verify: verifyAllocation,
});

/** One page of the conflicting Assets this reader can read, with the total
 * across the instance. Requires the settings lock or a read transaction. */
async function gtinConflictPage(tx: ManagedTransaction, actorKey: string,
  after: string | null): Promise<GtinConflictPage> {
  const counts = await tx.run(`MATCH (p:Gs1Settings {key: 'instance'})
    OPTIONAL MATCH (p)-[:HAS_GTIN_CONFLICT]->(a:Asset)
    RETURN count(a) AS total, count(CASE WHEN ${readableByViewer} THEN a END) AS readable`, { actorKey });
  const total = (counts.records[0].get('total') as Integer).toNumber();
  const readable = (counts.records[0].get('readable') as Integer).toNumber();
  const page = await tx.run(`MATCH (:Gs1Settings {key: 'instance'})-[:HAS_GTIN_CONFLICT]->(a:Asset)
    WHERE ${readableByViewer} AND ($after IS NULL OR a.id > $after)
    RETURN a { .id, .name } AS asset ORDER BY a.id LIMIT $limit`,
  { actorKey, after, limit: int(gtinConflictPageSize + 1) });
  const assets = page.records.map((row) => row.get('asset') as { id: string; name: string });
  const more = assets.length > gtinConflictPageSize;
  if (more) assets.pop();
  return { total, hidden: total - readable, assets, next: more ? assets[assets.length - 1].id : null };
}


/** An Asset beside the values Kannabi issued for it. The plugin's own view:
 * core's Asset carries no issuance, because core issues nothing. */
export type IssuedAsset = Asset & Readonly<{ issuances: readonly Gs1KeyIssuance[] }>;

/** The GS1 plugin's operations, bound to the open store. */
export class Gs1Store {
  constructor(private readonly core: IdentityStore) {}

  /** The Assets that block enforcing GTIN consistency, for an administrator.
   * Paged by native Asset ID; `after` is the `next` of the previous page. */
  async gtinConflicts(actorKey: string, after: unknown): Promise<GtinConflictPage> {
    if (after !== undefined && after !== null && !isAssetId(after)) throw new ValidationError('Invalid cursor');
    if (!await this.core.isAdministrator(actorKey)) throw new AdministrationError('Administrator access required');
    return this.core.read((tx) => gtinConflictPage(tx, actorKey, (after as string | undefined) ?? null));
  }

  /** The plugin's settings. Public, as core's own are: they say how this
   * instance accepts identifiers, and hold nothing about any Asset. */
  async settings(): Promise<Gs1Settings> {
    const result = await this.core.read((tx) => tx.run(
      "MATCH (p:Gs1Settings {key: 'instance'}) RETURN p.enforceGtinConsistency AS enforceGtinConsistency"));
    return { enforceGtinConsistency: result.records[0].get('enforceGtinConsistency') === true };
  }

  /** Change the settings a request names, and only those. An administrator's
   * operation: it decides how the instance accepts identifiers, and grants
   * no access to any Asset. */
  async updateSettings(actorKey: string, value: unknown): Promise<Gs1Settings> {
    const input = record(value, ['enforceGtinConsistency']);
    if (input.enforceGtinConsistency !== undefined && typeof input.enforceGtinConsistency !== 'boolean') {
      throw new ValidationError('enforceGtinConsistency must be true or false');
    }
    return this.core.write(async (tx) => {
      const admin = await tx.run("MATCH (u:User {key: $actorKey, role: 'admin'}) RETURN u.key", { actorKey });
      if (!admin.records.length) throw new AdministrationError('Administrator access required');
      // The settings lock is taken before the conflict set is read, and every
      // identifier write takes it before judging and recording, so a conflict
      // either committed before this check and blocks it, or is judged by the
      // policy this commits.
      const state = await tx.run(lockSettings);
      const current = { enforceGtinConsistency: state.records[0].get('enforceGtinConsistency') === true };
      const settings = { ...current, ...(input as Partial<Gs1Settings>) };
      // Resuming enforcement is refused while any Asset holds a conflict, and
      // nothing is reconciled to make it succeed.
      if (settings.enforceGtinConsistency && !current.enforceGtinConsistency) {
        const conflicts = await gtinConflictPage(tx, actorKey, null);
        if (conflicts.total > 0) throw new GtinConflictError(conflicts);
      }
      await tx.run("MATCH (p:Gs1Settings {key: 'instance'}) SET p.enforceGtinConsistency = $value",
        { value: settings.enforceGtinConsistency });
      return settings;
    });
  }

  /** Every value Kannabi issued for one Asset, ordered by canonical form.
   *
   * Found by the Asset id the ledger records rather than by a relationship,
   * which is what lets an issuance outlive the attachment. A list, because an
   * Asset may carry Kannabi-issued keys of several schemes at once: issuance
   * is idempotent per scheme, which is a guarantee about the operation and
   * never a claim that one scheme excludes another. The caller has already
   * established that its reader may see the Asset. */
  async issuancesFor(assetKey: string): Promise<Gs1KeyIssuance[]> {
    const result = await this.core.read((tx) => tx.run(`
      MATCH (issuance:Gs1KeyIssuance {allocatedForAssetId: $assetId})
      OPTIONAL MATCH (allocator:User {key: issuance.allocatedBy})
      RETURN ${issuanceProjection} AS issuance ORDER BY issuance.canonical`, { assetId: assetKey }));
    return result.records.map((row) => row.get('issuance') as Gs1KeyIssuance);
  }

  /** One Asset together with what Kannabi issued for it, as this audience
   * reads the Asset, or null when it may not. */
  async issuedAsset(assetKey: string, audience: AudienceInput): Promise<IssuedAsset | null> {
    const asset = await this.core.getAsset(assetKey, audience);
    return asset ? { ...asset, issuances: await this.issuancesFor(asset.id) } : null;
  }

  /** The same, for a reader named by audience: null when that reader may not
   * see the Asset, so the ledger never says more than the Asset would. */
  async readableIssuances(assetKey: string, audience: AudienceInput): Promise<Gs1KeyIssuance[] | null> {
    return await this.core.getAsset(assetKey, audience) ? this.issuancesFor(assetKey) : null;
  }

  /** GS1 namespaces the audience can reach, ordered by prefix. */
  async listGs1Namespaces(audience: NamedAudienceInput): Promise<Gs1Namespace[]> {
    const result = await this.core.read((tx) => tx.run(`
      MATCH (n:Gs1Namespace) WHERE ${visibleNamespace}
      RETURN DISTINCT ${namespaceProjection} AS namespace ORDER BY namespace.gcp`,
    audienceParameters(audience)));
    return result.records.map((row) => namespaceFrom(row.get('namespace')));
  }

  /** The class keys a namespace manages, ordered by canonical form.
   *
   * Reachable exactly where the namespace is. A class key is namespace
   * configuration, so it is neither Asset data nor visible through Asset
   * access, and knowing one grants nothing — serialising under it still
   * requires membership of the managing Group.
   */
  async listClassKeys(audience: NamedAudienceInput, namespaceKey: string,
    scheme?: ClassKeyScheme): Promise<Gs1ClassKeyAllocation[]> {
    const result = await this.core.read((tx) => tx.run(`
      MATCH (n:Gs1Namespace {key: $namespaceKey}) WHERE ${visibleNamespace}
      MATCH (classKey:Gs1ClassKeyAllocation)-[:IN_NAMESPACE]->(n)
      WHERE $scheme IS NULL OR classKey.scheme = $scheme
      OPTIONAL MATCH (asserter:User {key: classKey.assertedBy})
      RETURN ${classKeyProjection} AS classKey ORDER BY classKey.canonical`,
    { namespaceKey: requiredText(namespaceKey, 'namespace key'), scheme: scheme ?? null,
      ...audienceParameters(audience) }));
    return result.records.map((row) => classKeyFrom(row.get('classKey')));
  }

  /** Read a namespace's issuance ledger.
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
  async gs1Issuances(audience: NamedAudienceInput, request: Gs1LedgerRequest): Promise<Gs1LedgerPage> {
    const { namespaceKey, scheme, limit, after } = request;
    const parameters = audienceParameters(audience);
    {
      return this.core.read(async (tx) => {
        const found = await tx.run(`
          MATCH (n:Gs1Namespace {key: $namespaceKey}) WHERE ${visibleNamespace}
          OPTIONAL MATCH (issued:Gs1KeyIssuance)-[:ISSUED_FROM]->(n)
          WHERE $scheme IS NULL OR issued.scheme = $scheme
          RETURN ${namespaceProjection} AS namespace, count(issued) AS matching`,
        { namespaceKey, scheme, ...parameters });
        if (!found.records.length) throw new ReferenceError('Allocation namespace not found');
        const page = await tx.run(`
          MATCH (issuance:Gs1KeyIssuance)-[:ISSUED_FROM]->(:Gs1Namespace {key: $namespaceKey})
          WHERE ($scheme IS NULL OR issuance.scheme = $scheme)
            AND ($after IS NULL OR issuance.canonical > $after)
          WITH issuance ORDER BY issuance.canonical ASC LIMIT $fetchSize
          OPTIONAL MATCH (allocator:User {key: issuance.allocatedBy})
          WITH issuance, allocator ORDER BY issuance.canonical ASC
          RETURN collect(${issuanceProjection}) AS rows`,
        { namespaceKey, scheme, after, fetchSize: int(limit + 1) });
        const rows = page.records[0].get('rows') as Gs1KeyIssuance[];
        const issuances = rows.slice(0, limit);
        const readable = await this.core.readableAssets(tx,
          issuances.map((issuance) => issuance.allocatedForAssetId), audience);
        const assets = new Map(readable.map((asset) => [asset.id, asset]));
        return Object.freeze({
          namespace: namespaceFrom(found.records[0].get('namespace')),
          matching: found.records[0].get('matching').toNumber(),
          entries: issuances.map((issuance) => Object.freeze({
            issuance, asset: assets.get(issuance.allocatedForAssetId) ?? null })),
          nextCursor: rows.length > limit
            ? gs1LedgerCursor(namespaceKey, scheme, issuances.at(-1)!.canonical) : null,
        });
      });
    }
  }

  /** Configure a GCP namespace for a Group.
   *
   * The prefix is an assertion by an authorized member, recorded with who made
   * it. Kannabi cannot verify GS1 licensing and does not imply that it did.
   */
  async configureGs1Namespace(actorKey: string, groupKey: string, value: unknown): Promise<Gs1Namespace> {
    return refusing(() => this.configureGs1NamespaceRefused(actorKey, groupKey, value));
  }

  private async configureGs1NamespaceRefused(actorKey: string, groupKey: string, value: unknown): Promise<Gs1Namespace> {
    const input = record(value, ['gcp',
      ...namespaceCounters.map((counter) => `${counter}Exclusions`)]);
    const gcp = canonicalGcp(input.gcp);
    const params = {
      actorKey, groupKey: requiredText(groupKey, 'groupKey'), gcp, key: randomUUID(),
      ...Object.assign({}, ...namespaceCounters.map((counter) =>
        counterParams(counter, canonicalExclusions(input[`${counter}Exclusions`])))),
    };
    return this.core.write(async (tx) => {
      // Exact duplicates and prefix overlaps are one query, because they are
      // one rule: section 1.2.3.3 states that once a GS1 Company Prefix is
      // issued, no other beginning with the same digits SHALL be issued. Two
      // overlapping assertions therefore mean at least one of them is wrong.
      const owner = await tx.run(`MATCH (n:Gs1Namespace)
        WHERE n.gcp STARTS WITH $gcp OR $gcp STARTS WITH n.gcp
        RETURN n.gcp AS gcp, head([(n)<-[:MANAGES_NAMESPACE]-(g:Group) | g.key]) AS groupKey`, { gcp });
      if (owner.records.length) {
        const existing = owner.records[0].get('gcp') as string;
        if (existing !== gcp) {
          throw new DuplicateIdentityError(`GS1 Company Prefix ${existing} is already configured, and no two GS1 Company Prefixes may begin with the same digits`);
        }
        // One managed GCP belongs to one Group while Group membership is the
        // only authorization we have. Issue #20's privilege model can relax
        // this without touching any namespace or allocation record.
        throw new DuplicateIdentityError(owner.records[0].get('groupKey') === params.groupKey
          ? 'That GS1 Company Prefix is already configured for this Group'
          : 'That GS1 Company Prefix is already managed by another Group');
      }
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group {key: $groupKey})
        WHERE ${groupManaged}
        CREATE (g)-[:MANAGES_NAMESPACE]->(n:Gs1Namespace {
          key: $key, gcp: $gcp, active: true,
          ${namespaceCounters.map(counterAssignments).join(',\n          ')},
          configuredAt: datetime(), configuredBy: $actorKey })
        RETURN ${namespaceProjection} AS namespace`, params);
      if (!result.records.length) throw new ReferenceError('Group not found');
      return namespaceFrom(result.records[0].get('namespace'));
    });
  }

  /** Deactivate or reactivate a namespace. Deactivation stops new issuance and
   * nothing else: the counter, the exclusions and every ledger row remain, so
   * reactivation resumes the same namespace rather than starting a new one. */
  async setGs1NamespaceActive(actorKey: string, namespaceKey: string, active: unknown): Promise<Gs1Namespace> {
    if (typeof active !== 'boolean') throw new ValidationError('Namespace active state must be a boolean');
    return this.core.write(async (tx) => {
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)-[:MANAGES_NAMESPACE]->(n:Gs1Namespace {key: $key})
        WHERE ${groupManaged}
        SET n.active = $active
        RETURN ${namespaceProjection} AS namespace`,
      { actorKey, key: requiredText(namespaceKey, 'namespace key'), active });
      if (!result.records.length) throw new ReferenceError('Allocation namespace not found');
      return namespaceFrom(result.records[0].get('namespace'));
    });
  }

  /** Deactivate or reactivate one class key. Stops new serials under it and
   * nothing else: the serial counter, its exclusions and every value already
   * issued survive, so reactivation resumes the same key rather than starting
   * a new one. Configuration state, never allocation lifecycle. */
  async setClassKeyActive(actorKey: string, classKeyKey: string,
    active: unknown): Promise<Gs1ClassKeyAllocation> {
    if (typeof active !== 'boolean') throw new ValidationError('Class key active state must be a boolean');
    return this.core.write(async (tx) => {
      const result = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)-[:MANAGES_NAMESPACE]->(:Gs1Namespace)
          <-[:IN_NAMESPACE]-(classKey:Gs1ClassKeyAllocation {key: $key})
        WHERE ${groupManaged}
        SET classKey.active = $active
        WITH classKey
        OPTIONAL MATCH (asserter:User {key: classKey.assertedBy})
        RETURN ${classKeyProjection} AS classKey`,
      { actorKey, key: requiredText(classKeyKey, 'class key'), active });
      if (!result.records.length) throw new ReferenceError('Managed class key not found');
      return classKeyFrom(result.records[0].get('classKey'));
    });
  }

  /** Bring a class key into a namespace the actor's Group manages, either by
   * allocating a new reference from the namespace's counter or by adopting a
   * key the Group had already allocated elsewhere.
   *
   * One method for both, because the difference is a single recorded fact and
   * everything else — authority, locking, the serial counter it creates — is
   * identical. The fact itself is never inferred: `provenance` is stored
   * explicitly, so "Kannabi allocated this" can never be read off a value that
   * merely sits inside a managed prefix.
   *
   * Touches no Asset and grants no Asset access. Managing a class key is
   * namespace configuration; serialising under it is a separate operation with
   * its own Asset check.
   */
  async manageClassKey(actorKey: string, namespaceKey: string,
    value: unknown): Promise<Gs1ClassKeyAllocation> {
    return refusing(() => this.manageClassKeyRefused(actorKey, namespaceKey, value));
  }

  private async manageClassKeyRefused(actorKey: string, namespaceKey: string,
    value: unknown): Promise<Gs1ClassKeyAllocation> {
    const { serialExclusions: rawExclusions, ...input } = record(value,
      ['scheme', 'gtin', 'serial', 'assetType', 'assetReference', 'serialExclusions']);
    // Supplying the key's own value is what makes this an adoption: the Group
    // is asserting a key it already allocated, rather than asking Kannabi to
    // produce one. Allocation takes the scheme and nothing else, so a caller
    // can never hand Kannabi a value and have it recorded as Kannabi-issued.
    const adopting = Object.keys(input).some((field) => field !== 'scheme');
    const serialExclusions = canonicalExclusions(rawExclusions);
    const scheme = classKeyScheme(input.scheme);
    const key = requiredText(namespaceKey, 'namespace key');
    return this.core.write(async (tx) => {
      // Lock the namespace before reading anything the decision depends on,
      // so a concurrent allocation cannot read the same counter position.
      const locked = await tx.run(`MATCH (n:Gs1Namespace {key: $key}) SET n.lock = true
        RETURN n.gcp AS gcp, n.active AS active,
          ${counterProjection('n', classKeyCounter(scheme))} AS counter`, { key });
      if (!locked.records.length) throw new ReferenceError('Allocation namespace not found');
      const authorized = await tx.run(`
        MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)-[:MANAGES_NAMESPACE]->(:Gs1Namespace {key: $key})
        WHERE ${groupManaged}
        RETURN true AS ok`, { actorKey, key });
      if (!authorized.records.length) throw new ReferenceError('Allocation namespace not found');
      const gcp = locked.records[0].get('gcp') as string;
      if (locked.records[0].get('active') !== true) {
        throw new ValidationError('That GS1 Company Prefix namespace is deactivated');
      }
      refuseUnissuable(gcp);
      let identifier: ExternalIdentifier;
      let sequence: number | null = null;
      if (adopting) {
        identifier = adoptableClassKey(input);
        if (identifier.scheme !== scheme) {
          throw new ValidationError('The adopted class key does not match the requested scheme');
        }
        // Containment in the prefix this Group asserted, which is exactly as
        // strong as that assertion and is not a licensing check.
        if (!classKeyWithinGcp(identifier, gcp)) {
          throw new ValidationError(`That class key does not lie within GS1 Company Prefix ${gcp}`);
        }
      } else {
        const counter = counterFrom(locked.records[0].get('counter'));
        // Adoption records a key at whatever position its reference happens to
        // occupy, without moving the counter — the Group already allocated it,
        // so Kannabi must not claim that position as its own issuance. The
        // counter can therefore walk into a position an adopted key already
        // holds. Skip those here rather than letting the uniqueness constraint
        // reject the write: that rollback would undo the counter advance too,
        // so every later allocation would recompute the same position and fail
        // identically, with no way to recover through any API.
        //
        // Exclusions are still applied first, and `classReference` raises the
        // exhaustion error once the skipping passes the reference width, so
        // this terminates on a full namespace instead of spinning.
        let candidate = counter.nextSequence;
        for (;;) {
          sequence = allocatableSequence(candidate, counter.exclusions);
          identifier = scheme === 'grai'
            ? allocatedGraiAssetType(gcp, sequence) : allocatedGtin(gcp, sequence);
          const taken = await tx.run(`MATCH (c:Gs1ClassKeyAllocation {canonical: $canonical})
            RETURN c.key AS key`, { canonical: identifier.canonical });
          if (!taken.records.length) break;
          candidate = sequence + 1;
        }
        const property = counterProperties(classKeyCounter(scheme));
        await tx.run(`MATCH (n:Gs1Namespace {key: $key}) SET n.${property.nextSequence} = $next`,
          { key, next: int(sequence + 1) });
      }
      const params = {
        actorKey, key, classKey: randomUUID(), scheme, canonical: identifier.canonical, gcp,
        sequence: sequence === null ? null : int(sequence),
        provenance: adopting ? 'adopted' : 'allocated',
        ...counterParams('serial', serialExclusions),
      };
      try {
        const created = await tx.run(`
          MATCH (n:Gs1Namespace {key: $key})
          CREATE (classKey:Gs1ClassKeyAllocation {
            key: $classKey, scheme: $scheme, canonical: $canonical, gcp: $gcp,
            sequence: $sequence, provenance: $provenance, active: true,
            ${counterAssignments('serial')},
            assertedAt: datetime(), assertedBy: $actorKey })
          CREATE (classKey)-[:IN_NAMESPACE]->(n)
          WITH classKey
          OPTIONAL MATCH (asserter:User {key: $actorKey})
          RETURN ${classKeyProjection} AS classKey`, params);
        return classKeyFrom(created.records[0].get('classKey'));
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw new DuplicateIdentityError('That class key is already managed', { cause: error });
        }
        throw error;
      }
    });
  }

  /** Issue an individual key for an Asset from a managed namespace,
   * idempotently per scheme.
   *
   * One transaction, and the write lock is taken before anything is decided —
   * the Phase 1 lesson. A concurrent caller therefore blocks and then observes
   * the committed issuance at step 3, so a double-click returns the same value
   * without consuming a sequence number.
   *
   * After the counter, lock the Asset before checking authority. This also
   * serializes issuance through different namespaces with collaboration
   * revocation; the unique ledger constraints remain the persistence backstop.
   *
   * The three schemes differ only in where the sequence comes from and how the
   * value is built. A GIAI draws on the namespace's own counter; a serialised
   * GRAI and an SGTIN draw on the serial counter of a class key that must
   * already be managed in that namespace and active. That requirement is what
   * makes serialising a merely recorded GTIN unexpressible rather than merely
   * forbidden: recording an identifier creates no class key to issue under.
   */
  async issueKey(id: string, actorKey: string, scheme: IssuanceScheme, request: unknown,
    origin: ChangeOrigin = {}): Promise<IssuedAsset> {
    const asset = await refusing(() => this.issue(id, actorKey, scheme, request, origin));
    return { ...asset, issuances: await this.issuancesFor(asset.id) };
  }

  private async issue(id: string, actorKey: string, scheme: IssuanceScheme, request: unknown,
    origin: ChangeOrigin): Promise<Asset> {
    const input = record(request, ['namespaceKey', 'classKeyKey']);
    const assetKey = assetId(id);
    const key = requiredText(input.namespaceKey, 'namespace key');
    // Null for a GIAI, which is allocated straight from the prefix; otherwise
    // the class key this serial must be issued under, and the scheme that key
    // has to be. Carried together so neither can be considered without the
    // other.
    const classScheme = issuanceClassScheme[scheme];
    const under = classScheme === null ? null
      : { scheme: classScheme, key: requiredText(input.classKeyKey, 'class key') };
    const project = (tx: ManagedTransaction) => this.core.assetWithin(tx, assetKey, actorKey);
    try {
      return await this.core.write(async (tx) => {
        // 1. Lock the namespace, and the class key when one is involved,
        //    before reading anything the decision depends on.
        const locked = await tx.run(`MATCH (n:Gs1Namespace {key: $key}) SET n.lock = true
          RETURN n.gcp AS gcp, n.active AS active,
            ${counterProjection('n', 'giai')} AS counter`, { key });
        if (!locked.records.length) throw new ReferenceError('Allocation namespace not found');
        await tx.run(`${assetMatch} SET a.lock = true`, { assetId: assetKey });
        // 2. Authority comes from the Group that manages the namespace — its
        //    membership and its control, both required — and that Group must
        //    also collaborate on the Asset. Control is the organizational half
        //    and never stands in for the Asset half.
        const authorized = await tx.run(`
          MATCH (:User {key: $actorKey})-[:MEMBER_OF]->(g:Group)-[:MANAGES_NAMESPACE]->(:Gs1Namespace {key: $key})
          WHERE ${groupManaged}
          MATCH (g)-[:CAN_COLLABORATE]->(a:Asset {id: $assetId})
          RETURN a.id AS id`, { actorKey, key, assetId: assetKey });
        if (!authorized.records.length) throw new ReferenceError('Asset access or allocation namespace not found');
        // 3. An existing issuance of this scheme is returned as-is, whether or
        //    not the identifier is still attached, and consumes no sequence.
        //    Scoped to the scheme: another scheme's issuance is a different
        //    identity for the same Asset, not a reason to refuse this one.
        const existing = await tx.run(`MATCH (l:Gs1KeyIssuance {scheme: $scheme, allocatedForAssetId: $assetId})
          RETURN l.canonical AS canonical`, { scheme, assetId: assetKey });
        if (existing.records.length) return project(tx);
        if (locked.records[0].get('active') !== true) {
          throw new ValidationError('That GS1 Company Prefix namespace is deactivated');
        }
        const gcp = locked.records[0].get('gcp') as string;
        refuseUnissuable(gcp);

        let identifier: ExternalIdentifier;
        let sequence: number;
        if (under === null) {
          // 4a. A GIAI comes straight from the namespace's own counter.
          const counter = counterFrom(locked.records[0].get('counter'));
          sequence = allocatableSequence(counter.nextSequence, counter.exclusions);
          const property = counterProperties('giai');
          await tx.run(`MATCH (n:Gs1Namespace {key: $key}) SET n.${property.nextSequence} = $next`,
            { key, next: int(sequence + 1) });
          identifier = allocatedGiai(gcp, sequence);
        } else {
          // 4b. A serial comes from the class key's own counter, which is
          //     locked here for the same reason the namespace was.
          const managed = await tx.run(`
            MATCH (classKey:Gs1ClassKeyAllocation {key: $classKeyKey})-[:IN_NAMESPACE]->(:Gs1Namespace {key: $key})
            SET classKey.lock = true
            RETURN classKey.canonical AS canonical, classKey.scheme AS scheme,
              classKey.active AS active, ${counterProjection('classKey', 'serial')} AS counter`,
          { classKeyKey: under.key, key });
          if (!managed.records.length) {
            throw new ReferenceError('That class key is not managed in this namespace');
          }
          if (managed.records[0].get('scheme') !== under.scheme) {
            throw new ValidationError(`Issuing a ${scheme.toUpperCase()} requires a ${under.scheme.toUpperCase()} class key`);
          }
          if (managed.records[0].get('active') !== true) {
            throw new ValidationError('That managed class key is deactivated');
          }
          const counter = counterFrom(managed.records[0].get('counter'));
          sequence = allocatableSequence(counter.nextSequence, counter.exclusions);
          const property = counterProperties('serial');
          await tx.run(`MATCH (classKey:Gs1ClassKeyAllocation {key: $classKeyKey})
            SET classKey.${property.nextSequence} = $next`,
          { classKeyKey: under.key, next: int(sequence + 1) });
          // 5. Construction and validation belong to the GS1 boundary. The
          //    class key is re-parsed there rather than concatenated here.
          const classKey = storedIdentifier(under.scheme,
            managed.records[0].get('canonical') as string, gs1Policy.version);
          identifier = scheme === 'grai'
            ? allocatedGraiSerial(classKey.components.assetType, sequence)
            : allocatedSgtin(classKey.components.gtin, sequence);
        }
        // 6. The issuance record, which outlives the Asset and the attachment.
        await tx.run(`MATCH (n:Gs1Namespace {key: $key})
          CREATE (l:Gs1KeyIssuance { key: $issuanceKey, scheme: $scheme, canonical: $canonical,
            gcp: $gcp, sequence: $sequence, allocatedAt: datetime(),
            allocatedForAssetId: $assetId, allocatedBy: $actorKey })
          CREATE (l)-[:ISSUED_FROM]->(n)
          WITH l
          OPTIONAL MATCH (classKey:Gs1ClassKeyAllocation {key: $classKeyKey})
          FOREACH (c IN CASE WHEN classKey IS NULL THEN [] ELSE [classKey] END |
            CREATE (l)-[:ISSUED_UNDER]->(c))`,
        { key, issuanceKey: randomUUID(), scheme, canonical: identifier.canonical, gcp,
          sequence: int(sequence), assetId: assetKey, actorKey,
          classKeyKey: under === null ? null : under.key });
        // 7. Phase 2 attachment semantics, unchanged and not duplicated.
        await this.core.attachWithin(tx, assetKey, actorKey, identifier, origin);
        return project(tx);
      });
    } catch (error) {
      if (isConstraintViolation(error)) {
        // Another transaction issued this scheme for this Asset first. Return
        // its result rather than reporting a conflict the caller cannot act on.
        const settled = await this.core.getAsset(assetKey, actorKey);
        if (settled && (await this.issuancesFor(assetKey)).some((issuance) => issuance.scheme === scheme)) {
          return settled;
        }
        throw new DuplicateIdentityError('The allocated identifier is already claimed', { cause: error });
      }
      throw error;
    }
  }
}
