import { digitalLinkPath } from './gs1-digital-link.js';
import type { AssertingCredential } from './change-provenance.js';
import type { ExternalIdentifier } from './gs1.js';
import type { Asset, Entity, ReporterAttribution } from './identity-store.js';

/** An Asset as a structure whose shape says whose statement each value is.
 *
 * The first representation is the store's own `Asset`: correct, but flat, so
 * `reportedAt` and `sourceRecord.recordedAt` sit side by side as two instants
 * and only prose elsewhere says that one is Kannabi's clock, the other a
 * source's claim, and neither the time anything physical happened. Every
 * client had to be told that, and a client that had not been told could not
 * tell.
 *
 * Here the distinction is the structure. Everything Kannabi itself holds or
 * did is under `kannabi`; everything a pre-existing record states is under
 * `source.says`, beside the reference that identifies that record; the kinds
 * of fact Kannabi holds none of are named in `notRecorded`, so their absence
 * is stated rather than left to an empty field. Instants are not freestanding
 * values: each is the `at` of something that happened in Kannabi, or the
 * `recordedAt` a source says. There is no field a physical event's date could
 * occupy, so none can be mistaken for one.
 *
 * Version 2 of the Asset representation. It changes how the same facts are
 * presented, never what is stored: it is computed from `Asset` on every read,
 * and the HTTP API keeps serving `Asset` itself at its original paths, with
 * this one beside it under `/api/v2`. A summary is a strict subset at the same paths, and every page of
 * summaries says what it leaves out, so a search result never reads as the
 * whole record.
 */
export const assetRepresentation = 2;

/** Kinds of fact no Asset records. Each is a question Kannabi answers with "not
 * recorded here", never with an inference from the fields that are. */
export const notRecorded = [
  'acquisition', 'location', 'custody', 'ownership history', 'events', 'observations', 'condition',
] as const;

/** What a summary leaves out of the full record, by path. Stated once per page
 * rather than on every result. */
export const summaryOmits = [
  'kannabi.lastChange', 'kannabi.issued', 'kannabi.photos',
  'identifiers[].accepted', 'source.says', 'notRecorded',
] as const;

/** Something that happened in Kannabi, by Kannabi's clock. `via` is the API
 * credential that asserted it, null when a person acted directly; `basis` is
 * the opaque reference the request named, never evidence in itself. */
export type KannabiAct = Readonly<{
  at: string;
  by: ReporterAttribution;
  via: AssertingCredential | null;
  basis: string | null;
}>;

export type IdentifierRecord = Readonly<{
  scheme: ExternalIdentifier['scheme'];
  value: string;
  level: ExternalIdentifier['level'];
  components: ExternalIdentifier['components'];
  /** Who accepted it onto this Asset. Null for an association made before
   * Kannabi kept this, which is unknown rather than accepted by nobody. */
  accepted: (KannabiAct & Readonly<{ gs1Policy: string }>) | null;
  digitalLink: string | null;
}>;

export type AssetRecord = Readonly<{
  id: string;
  kannabi: Readonly<{
    name: string;
    owner: Entity | null;
    groups: readonly Entity[];
    public: boolean;
    /** Who reported the Asset to Kannabi, and when: for an Asset loaded from
     * another system, the load. Kannabi keeps no credential or basis for the
     * report apart from the latest change, so none is shown here. */
    reported: Readonly<{ at: string; by: ReporterAttribution }>;
    /** Null only for an Asset last written before Kannabi recorded this. */
    lastChange: KannabiAct | null;
    issued: readonly Readonly<{ scheme: string; value: string; at: string; by: ReporterAttribution }>[];
    photos: readonly Readonly<{ key: string; contentType: string; size: number; receivedAt: string | null }>[];
  }>;
  identifiers: readonly IdentifierRecord[];
  source: Readonly<{
    reference: string;
    says: Readonly<{ recordedAt: string | null; recordedBy: string | null; description: string | null }>;
  }> | null;
  notRecorded: typeof notRecorded;
}>;

export type AssetSummary = Readonly<{
  id: string;
  kannabi: Readonly<{ name: string; owner: Entity | null; groups: readonly Entity[]; public: boolean;
    reported: Readonly<{ at: string }> }>;
  identifiers: readonly Omit<IdentifierRecord, 'accepted' | 'digitalLink'>[];
  source: Readonly<{ reference: string }> | null;
  /** Where the query text matched, as paths into the full record. */
  matched: readonly string[];
}>;

const entity = (value: Entity): Entity => ({ key: value.key, name: value.name });
const attribution = (value: ReporterAttribution): ReporterAttribution =>
  ({ key: value.key, name: value.name, status: value.status });
const credential = (value: AssertingCredential | null): AssertingCredential | null =>
  value ? { id: value.id, label: value.label } : null;

function identifierBase(identifier: ExternalIdentifier) {
  return { scheme: identifier.scheme, value: identifier.canonical, level: identifier.level,
    components: identifier.components };
}

export function assetRecord(asset: Asset): AssetRecord {
  return {
    id: asset.id,
    kannabi: {
      name: asset.name,
      owner: asset.owner ? entity(asset.owner) : null,
      groups: asset.groups.map(entity),
      public: asset.isPublic,
      reported: { at: asset.reportedAt, by: attribution(asset.reportedBy) },
      lastChange: asset.provenance ? { at: asset.provenance.acceptedAt,
        by: attribution(asset.provenance.acceptedBy), via: credential(asset.provenance.assertedBy),
        basis: asset.provenance.basis } : null,
      issued: asset.issuances.map((issuance) => ({ scheme: issuance.scheme, value: issuance.canonical,
        at: issuance.allocatedAt, by: attribution(issuance.allocatedBy) })),
      photos: asset.photos.map((photo) => ({ key: photo.key, contentType: photo.contentType, size: photo.size,
        receivedAt: photo.createdAt })),
    },
    identifiers: asset.identifiers.map((identifier) => ({
      ...identifierBase(identifier),
      accepted: identifier.attachment ? { at: identifier.attachment.acceptedAt,
        by: attribution(identifier.attachment.acceptedBy), via: credential(identifier.attachment.assertedBy),
        basis: identifier.attachment.basis, gs1Policy: identifier.policyVersion } : null,
      // Only an individual-level identity has an address Kannabi dereferences.
      digitalLink: identifier.level === 'individual' ? digitalLinkPath(identifier) : null,
    })),
    source: asset.sourceRecord ? { reference: asset.sourceRecord.reference, says: {
      recordedAt: asset.sourceRecord.recordedAt, recordedBy: asset.sourceRecord.recordedBy,
      description: asset.sourceRecord.description } } : null,
    notRecorded,
  };
}

/** Where a search matched, in the vocabulary the full record uses. */
const matchPaths: Readonly<Record<string, string>> = {
  name: 'kannabi.name', sourceDescription: 'source.says.description',
};

export function assetSummary(asset: Asset, matched: readonly string[] = []): AssetSummary {
  return {
    id: asset.id,
    kannabi: { name: asset.name, owner: asset.owner ? entity(asset.owner) : null,
      groups: asset.groups.map(entity), public: asset.isPublic, reported: { at: asset.reportedAt } },
    identifiers: asset.identifiers.map(identifierBase),
    source: asset.sourceRecord ? { reference: asset.sourceRecord.reference } : null,
    matched: matched.map((field) => matchPaths[field] ?? field),
  };
}
