import { ValidationError, record } from './identity.js';
import {
  checkDigit, cset82, csum, entries, enforcedLinters, syntaxDictionaryRelease,
  unenforcedLinters, zero,
} from './gs1-syntax.js';
import { restrictedPrefixReason } from './gs1-prefixes.js';

/** The single GS1 boundary. GS1 syntax and association rules are enforced here
 * and nowhere else; the rest of Kannabi treats an identifier as opaque data
 * plus a derived level. Kannabi's internal model is not the GS1 ontology.
 */

export type IdentifierScheme = 'gtin' | 'sgtin' | 'grai' | 'giai';
export type IdentifierLevel = 'individual' | 'class';
export type IdentifierComponents = Readonly<Record<string, string>>;

/** One AI and its value as a GS1 Digital Link expresses it. */
export type DigitalLinkSegment = Readonly<{ ai: string; value: string }>;

/** What a scheme contributes to a GS1 Digital Link URI, structurally rather
 * than as a formatted string.
 *
 * `attributes` is the query-string position. It is always empty today because
 * Kannabi constructs one URI per identifier and never unions values across an
 * Asset's identifiers, which would assert a relationship `assertCompatible`
 * deliberately does not establish. It exists because the standard does define
 * compound forms — section 5.11 expresses a GIAI and a GTIN in one URI — so a
 * later justified compound form is an addition here rather than a rewrite.
 */
export type DigitalLinkKey = Readonly<{
  primary: DigitalLinkSegment;
  qualifiers: readonly DigitalLinkSegment[];
  attributes: readonly DigitalLinkSegment[];
}>;

export type ExternalIdentifier = Readonly<{
  scheme: IdentifierScheme;
  /** Stable GS1 element-string rendering. The persistence key and the only
   * stored form of the value; components are always parsed back from it. */
  canonical: string;
  components: IdentifierComponents;
  /** Derived from GS1 semantics, never supplied by a caller. */
  level: IdentifierLevel;
  /** The GS1 policy version that accepted this value. */
  policyVersion: string;
}>;

/** Kannabi's GS1 policy identity.
 *
 * `syntaxDictionaryRelease` is GS1's own release label. GS1 does not publish a
 * mapping from a dictionary release to a General Specifications release, so
 * `generalSpecificationsRelease` is Kannabi's assertion and is marked as such
 * by `assertedBy`. Never present it as a GS1 statement.
 *
 * Version semantics, independent of the Kannabi package version:
 *
 *  - Pinning a newer Syntax Dictionary release changes
 *    `syntaxDictionaryRelease` and resets the suffix to `+kannabi.1`.
 *  - Changing anything in this overlay — a scheme, a derivation, a Kannabi
 *    rule — while the pinned release is unchanged increments `+kannabi.N`.
 *
 * A new policy governs future acceptance only. Stored identifiers are never
 * revalidated or rewritten, and their `policyVersion` is historical
 * provenance: it records which policy accepted that value, and is not a claim
 * that the value would still be accepted today.
 *
 * One thing a version bump may NOT change: a scheme's canonical layout. Stored
 * identifiers keep only their canonical form and are re-parsed with the active
 * scheme definition, so altering a layout is a breaking data change requiring
 * migration, not a policy bump.
 */
export const gs1Policy = {
  version: `${syntaxDictionaryRelease}+kannabi.3`,
  syntaxDictionaryRelease,
  generalSpecificationsRelease: '26.0',
  assertedBy: 'kannabi',
  enforcedLinters,
  unenforcedLinters,
} as const;

export const identifierSchemes: readonly IdentifierScheme[] = ['gtin', 'sgtin', 'grai', 'giai'];

/** The schemes Kannabi issues, at each of the two levels it allocates.
 *
 * A class key names a class and is not an Asset's identity: a GTIN names a
 * trade item, an unserialised GRAI a returnable asset type. An individual key
 * identifies one Asset, and two of the three are reached only through a class
 * key — an SGTIN serialises a GTIN, a serialised GRAI serialises an asset
 * type — while a GIAI is allocated straight from the prefix.
 *
 * These lists are Kannabi's issuance surface, not a GS1 taxonomy. GS1 defines
 * many more keys, and a licensed GS1 Company Prefix entitles its holder to
 * allocate all of them (§1.5); these are the ones Kannabi implements.
 */
export const classKeySchemes = ['gtin', 'grai'] as const;
export type ClassKeyScheme = (typeof classKeySchemes)[number];
export const issuanceSchemes = ['giai', 'grai', 'sgtin'] as const;
export type IssuanceScheme = (typeof issuanceSchemes)[number];

/** The class key an individual key is issued under, or null when the scheme
 * is allocated directly from the prefix. */
export const issuanceClassScheme: Readonly<Record<IssuanceScheme, ClassKeyScheme | null>> = {
  giai: null, grai: 'grai', sgtin: 'gtin',
};

/** Every field any supported scheme accepts. The single list transports
 * identifier input across the API without restating a GS1 rule. */
export const identifierInputFields = ['scheme', 'gtin', 'serial', 'assetType', 'assetReference'] as const;

function numeric(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length !== length || /\D/.test(value)) {
    throw new ValidationError(`${field} must contain exactly ${length} digits`);
  }
  return value;
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.length || value.length > max || !cset82.test(value)) {
    throw new ValidationError(`${field} must contain 1–${max} GS1 CSET 82 characters`);
  }
  return value;
}

/** GTIN-8, UPC-A, EAN-13 and GTIN-14 all normalise to 14 digits. */
export function canonicalGtin(value: unknown): string {
  if (typeof value !== 'string' || ![8, 12, 13, 14].includes(value.length) || /\D/.test(value)
      || !csum(value)) {
    throw new ValidationError('GTIN/JAN must contain 8, 12, 13, or 14 digits with a valid check digit');
  }
  return value.padStart(14, '0');
}

function assetType(value: unknown): string {
  const digits = numeric(value, 13, 'GRAI asset type');
  if (!csum(digits)) throw new ValidationError('GRAI asset type requires a valid check digit');
  return digits;
}

type SchemeDefinition = {
  /** Application Identifiers this scheme contributes to an Asset. The first is
   * the GS1 Digital Link primary key; any that follow are its key qualifiers,
   * in the order the Syntax Dictionary declares. */
  ais: readonly string[];
  fields: readonly string[];
  build(input: Record<string, unknown>): { components: IdentifierComponents; canonical: string };
  parse(canonical: string): IdentifierComponents;
  level(components: IdentifierComponents): IdentifierLevel;
  /** This identifier as GS1 Digital Link path data. */
  digitalLink(components: IdentifierComponents): DigitalLinkKey;
  /** The inverse: the identifier input a Digital Link path's primary value and
   * qualifiers represent, or `undefined` when that shape is not this scheme's.
   *
   * Only shape is decided here. Every value is handed to `canonicalIdentifier`
   * afterwards, so a Digital Link address is validated by exactly the rules an
   * attached identifier is, and the two can never diverge.
   */
  digitalLinkInput(ai: string, value: string,
    qualifiers: readonly DigitalLinkSegment[]): Record<string, unknown> | undefined;
};

// AI 8003 begins with a zero filler that the standard fixes; Kannabi stores the
// 13-digit asset type without it and restores it when rendering the canonical.
const graiFiller = '0';

const schemes: Readonly<Record<IdentifierScheme, SchemeDefinition>> = {
  gtin: {
    ais: ['01'],
    fields: ['scheme', 'gtin'],
    build(input) {
      const gtin = canonicalGtin(input.gtin);
      return { components: { gtin }, canonical: `(01)${gtin}` };
    },
    parse: (canonical) => ({ gtin: canonical.slice(4, 18) }),
    // A GTIN identifies a trade item, never an individual instance of one.
    level: () => 'class',
    digitalLink: (components) => digitalLinkKey('01', components.gtin),
    digitalLinkInput: (ai, value, qualifiers) =>
      ai === '01' && !qualifiers.length ? { scheme: 'gtin', gtin: value } : undefined,
  },
  sgtin: {
    ais: ['01', '21'],
    fields: ['scheme', 'gtin', 'serial'],
    build(input) {
      const gtin = canonicalGtin(input.gtin);
      const serial = text(input.serial, 20, 'Serial');
      return { components: { gtin, serial }, canonical: `(01)${gtin}(21)${serial}` };
    },
    parse: (canonical) => ({ gtin: canonical.slice(4, 18), serial: canonical.slice(22) }),
    level: () => 'individual',
    // AI 01 is the primary key and AI 21 its qualifier: an SGTIN's Digital
    // Link path is rooted in a trade-item key, not in a key of its own.
    digitalLink: (components) =>
      digitalLinkKey('01', components.gtin, [{ ai: '21', value: components.serial }]),
    digitalLinkInput: (ai, value, qualifiers) =>
      ai === '01' && qualifiers.length === 1 && qualifiers[0].ai === '21'
        ? { scheme: 'sgtin', gtin: value, serial: qualifiers[0].value } : undefined,
  },
  grai: {
    ais: ['8003'],
    fields: ['scheme', 'assetType', 'serial'],
    build(input) {
      const type = assetType(input.assetType);
      const serial = input.serial === undefined || input.serial === ''
        ? undefined : text(input.serial, 16, 'GRAI serial');
      const components: Record<string, string> = { assetType: type };
      if (serial !== undefined) components.serial = serial;
      return { components, canonical: `(8003)${graiFiller}${type}${serial ?? ''}` };
    },
    parse(canonical) {
      const payload = canonical.slice(6);
      const serial = payload.slice(14);
      const components: Record<string, string> = { assetType: payload.slice(1, 14) };
      if (serial) components.serial = serial;
      return components;
    },
    // GS1 makes the GRAI serial optional: without it the key identifies the
    // returnable asset type, with it an individual asset within that type.
    level: (components) => (components.serial === undefined ? 'class' : 'individual'),
    // The Digital Link path carries the whole AI 8003 value, zero filler
    // included, which is exactly what the canonical form holds after `(8003)`.
    digitalLink: (components) =>
      digitalLinkKey('8003', graiFiller + components.assetType + (components.serial ?? '')),
    digitalLinkInput(ai, value, qualifiers) {
      if (ai !== '8003' || qualifiers.length) return undefined;
      // `canonicalIdentifier` never sees the filler, so the `zero` linter has
      // to be applied to it here or a path could smuggle a non-zero filler in
      // and be silently accepted as the GRAI it is not.
      if (!zero(value.slice(0, 1))) throw new ValidationError('A GRAI begins with a zero filler digit');
      const serial = value.slice(14);
      return { scheme: 'grai', assetType: value.slice(1, 14), serial: serial || undefined };
    },
  },
  giai: {
    ais: ['8004'],
    fields: ['scheme', 'assetReference'],
    build(input) {
      const assetReference = text(input.assetReference, 30, 'GIAI');
      return { components: { assetReference }, canonical: `(8004)${assetReference}` };
    },
    parse: (canonical) => ({ assetReference: canonical.slice(6) }),
    level: () => 'individual',
    digitalLink: (components) => digitalLinkKey('8004', components.assetReference),
    digitalLinkInput: (ai, value, qualifiers) =>
      ai === '8004' && !qualifiers.length ? { scheme: 'giai', assetReference: value } : undefined,
  },
};

function digitalLinkKey(ai: string, value: string,
  qualifiers: readonly DigitalLinkSegment[] = []): DigitalLinkKey {
  return Object.freeze({
    primary: Object.freeze({ ai, value }),
    qualifiers: Object.freeze(qualifiers.map((segment) => Object.freeze(segment))),
    attributes: Object.freeze([]),
  });
}

/** This identifier as GS1 Digital Link path data. Assembling a URI from it is
 * `gs1-digital-link.ts`; deciding what it contains is policy and stays here. */
export function digitalLinkKeyFor(
  identifier: Pick<ExternalIdentifier, 'scheme' | 'components'>): DigitalLinkKey {
  return schemes[identifier.scheme].digitalLink(identifier.components);
}

/** Resolve a Digital Link path's primary key and qualifiers back to an
 * identifier, or `null` when no supported scheme has that shape.
 *
 * A shape no scheme claims is `null` — the caller decides whether that is a
 * 404 for an address Kannabi does not serve. A shape a scheme claims but whose
 * values do not validate throws, because that is a malformed identifier rather
 * than an unknown one.
 */
export function identifierFromDigitalLink(primary: DigitalLinkSegment,
  qualifiers: readonly DigitalLinkSegment[]): ExternalIdentifier | null {
  for (const scheme of identifierSchemes) {
    const input = schemes[scheme].digitalLinkInput(primary.ai, primary.value, qualifiers);
    if (input) return canonicalIdentifier(input);
  }
  return null;
}

function definition(scheme: unknown): SchemeDefinition {
  if (typeof scheme !== 'string' || !(scheme in schemes)) {
    throw new ValidationError(`Supported identifier schemes are ${identifierSchemes.join(', ')}`);
  }
  return schemes[scheme as IdentifierScheme];
}

/** Validate one external identifier and derive everything else from it. */
export function canonicalIdentifier(value: unknown): ExternalIdentifier {
  const input = record(value, identifierInputFields);
  const scheme = input.scheme as IdentifierScheme;
  const definitionFor = definition(input.scheme);
  record(input, definitionFor.fields);
  const { components, canonical } = definitionFor.build(input);
  assertAiAssociations(definitionFor.ais);
  return Object.freeze({
    scheme, canonical, components: Object.freeze(components),
    level: definitionFor.level(components), policyVersion: gs1Policy.version,
  });
}

/** Rebuild an identifier from its persisted canonical form. The components and
 * the level are always derived, so neither can drift from the stored value. */
export function storedIdentifier(scheme: unknown, canonical: unknown, policyVersion: unknown): ExternalIdentifier {
  const definitionFor = definition(scheme);
  if (typeof canonical !== 'string') throw new ValidationError('Stored identifier is missing its canonical form');
  // Never substitute the active policy for a missing stamp: that would claim
  // this policy accepted a value it never saw.
  if (typeof policyVersion !== 'string' || !policyVersion) {
    throw new ValidationError('Stored identifier is missing its accepting GS1 policy version');
  }
  const components = definitionFor.parse(canonical);
  return Object.freeze({
    scheme: scheme as IdentifierScheme, canonical, components: Object.freeze(components),
    level: definitionFor.level(components), policyVersion,
  });
}

/** GS1 `req=` / `ex=` association rules, evaluated over the AIs of ONE
 * identifier — the coherent AI element-string unit Kannabi models as a scheme
 * (SGTIN is AI 01 with AI 21; GRAI is AI 8003; GIAI is AI 8004).
 *
 * The Syntax Dictionary scopes these rules to "the combined data received from
 * all GS1 carriers marking a physical item", which is AI-formatted carrier
 * data. An Asset's identifiers are not that: they are independent records
 * attached at different times from different sources, and most are not marked
 * on the item at all. Applying carrier-level association rules across them
 * would invalidate legitimate combinations such as a manufacturer's SGTIN
 * alongside an owner-assigned GIAI, so Kannabi does not.
 */
export function assertAiAssociations(ais: readonly string[]): void {
  const present = new Set(ais);
  for (const ai of present) {
    const entry = entries[ai];
    if (!entry) continue;
    for (const excluded of entry.excludes ?? []) {
      if (present.has(excluded)) {
        throw new ValidationError(`GS1 does not permit AI (${ai}) alongside AI (${excluded})`);
      }
    }
    if (entry.requires && !entry.requires.some((group) => group.every((required) => present.has(required)))) {
      const options = entry.requires.map((group) => group.map((one) => `(${one})`).join('+')).join(' or ');
      throw new ValidationError(`GS1 requires AI (${ai}) to accompany ${options}`);
    }
  }
}

/** Canonical forms are parsed back positionally, which is only unambiguous
 * while every component a scheme renders before its last one has a fixed
 * length. That holds for all four supported schemes: AI 01 is N14, AI 8003's
 * filler and key are N1 and N13, and the one variable-length component of each
 * scheme (AI 21 serial, AI 8003 serial, AI 8004 reference) is terminal — so a
 * serial may itself contain "(21)" or parentheses without ambiguity.
 *
 * A scheme that placed a variable-length component before another component
 * would silently break that. This guard makes such a scheme a test failure
 * rather than a corrupt read; the fix would be to store components explicitly
 * rather than to parse ambiguously.
 */
export function assertReversibleSchemes(): void {
  for (const scheme of identifierSchemes) {
    const { ais } = schemes[scheme];
    ais.forEach((ai, index) => {
      const entry = entries[ai];
      if (!entry) throw new Error(`Scheme ${scheme} references AI (${ai}), which the policy does not define`);
      const lastAi = index === ais.length - 1;
      entry.components.forEach((component, position) => {
        const terminal = lastAi && position === entry.components.length - 1;
        if (!terminal && component.length === undefined) {
          throw new Error(`Scheme ${scheme} is not reversible: AI (${ai}) component ${position} `
            + 'has variable length but is not the final component of the canonical form');
        }
      });
    });
  }
}

/** Every supported scheme must be expressible as a GS1 Digital Link primary
 * key followed by an ordered subsequence of one of that key's declared
 * qualifier groups.
 *
 * Qualifiers are optional but their order is fixed, so skipping is conformant
 * and reordering is not: AI 01 declares `22,10,21`, and Kannabi's SGTIN uses
 * `21` alone, which is a valid subsequence of it. A scheme that reordered
 * qualifiers, or used one the dictionary does not list for its primary key,
 * would still produce a plausible-looking URI, so this is a test failure
 * rather than a comment.
 */
export function assertDigitalLinkSchemes(): void {
  for (const scheme of identifierSchemes) {
    const [primary, ...qualifiers] = schemes[scheme].ais;
    const entry = entries[primary];
    if (!entry?.digitalLinkPrimaryKey) {
      throw new Error(`Scheme ${scheme} leads with AI (${primary}), which the policy does not `
        + 'declare as a GS1 Digital Link primary key');
    }
    if (!qualifiers.length) continue;
    const groups = entry.digitalLinkQualifiers ?? [];
    const ordered = groups.some((group) => {
      let position = 0;
      return qualifiers.every((ai) => {
        const found = group.indexOf(ai, position);
        if (found < 0) return false;
        position = found + 1;
        return true;
      });
    });
    if (!ordered) {
      throw new Error(`Scheme ${scheme} qualifies AI (${primary}) with ${qualifiers.map((ai) => `(${ai})`).join('')}, `
        + 'which is not an ordered subsequence of any qualifier group the policy declares for it');
    }
  }
}

export function canonicalIdentifiers(value: unknown): ExternalIdentifier[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Identifiers must be a list');
  const identifiers = value.map(canonicalIdentifier);
  assertCompatible(identifiers);
  return identifiers;
}

/** Kannabi's own coherence rules for the set of identifiers on one Asset.
 *
 * Asset-level cardinality is permissive by design: any number of independent
 * identifiers may describe the same Asset, and identifiers of different
 * schemes coexist freely — a Kannabi-issued GIAI, a serialised GRAI and an
 * SGTIN on one Asset are three identities from three schemes, not a conflict.
 * Deliberately absent here is any GS1 `req=` / `ex=` evaluation, which belongs
 * to a single AI element string and is applied per identifier by
 * `assertAiAssociations`. Only these three rules are Kannabi's, and all are
 * about the Asset rather than about AI syntax.
 */
const conflictingGtins = 'Identifiers claim conflicting GTINs for one Asset';
const conflictingAssetTypes = 'Identifiers claim conflicting GRAI asset types for one Asset';

/** The trade item or asset-type series an Asset is already committed to, by
 * the component that names it. Requires nothing but the identifiers it is
 * given, and answers null when they commit to nothing. */
function committedComponent(
  identifiers: readonly ExternalIdentifier[], component: 'gtin' | 'assetType'): string | null {
  for (const identifier of identifiers) {
    const value = identifier.components[component];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** Why issuing under this class key would be refused for an Asset already
 * carrying these identifiers, or null when it would be accepted.
 *
 * This is `assertCompatible` asked in advance rather than a second rule. An
 * Asset is an instance of at most one trade item and a member of at most one
 * GRAI asset-type series, so a serial minted under a class key naming a
 * different one would be refused at the boundary; knowing that before the
 * value is allocated is the difference between not offering a choice and
 * offering one that cannot succeed.
 *
 * The messages are shared with `assertCompatible` so the answer given in
 * advance and the answer given on submission can never drift apart. A scheme
 * with no class key — a GIAI comes straight from the prefix — shares no
 * component with anything and so never conflicts.
 */
export function classKeyConflictReason(
  classKey: { scheme: ClassKeyScheme; canonical: string } | null,
  identifiers: readonly ExternalIdentifier[]): string | null {
  if (!classKey) return null;
  const component = classKey.scheme === 'gtin' ? 'gtin' : 'assetType';
  const key = definition(classKey.scheme).parse(classKey.canonical)[component];
  const committed = committedComponent(identifiers, component);
  if (typeof key !== 'string' || committed === null || committed === key) return null;
  return component === 'gtin' ? conflictingGtins : conflictingAssetTypes;
}

export function assertCompatible(identifiers: readonly ExternalIdentifier[]): void {
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    if (seen.has(identifier.canonical)) {
      throw new ValidationError('An Asset cannot carry the same identifier twice');
    }
    seen.add(identifier.canonical);
  }
  // An Asset is an instance of at most one trade item, so any AI 01 it carries
  // — alone as a GTIN or inside an SGTIN — must name the same trade item.
  const gtins = new Set(identifiers.flatMap((identifier) =>
    typeof identifier.components.gtin === 'string' ? [identifier.components.gtin] : []));
  if (gtins.size > 1) throw new ValidationError(conflictingGtins);
  // The same rule one scheme along. A GRAI asset type names a series of
  // identical returnable assets, so an Asset belongs to at most one: carrying
  // two would claim it is a member of one series and an instance within
  // another. This is coherence within AI 8003 for one Asset, and says nothing
  // about which other schemes may sit beside it.
  const assetTypes = new Set(identifiers.flatMap((identifier) =>
    typeof identifier.components.assetType === 'string' ? [identifier.components.assetType] : []));
  if (assetTypes.size > 1) throw new ValidationError(conflictingAssetTypes);
}

/** A GS1 Company Prefix as a Kannabi namespace configures it.
 *
 * Two rules, both normative, and neither the GCP Length Table:
 *
 *  - A GS1 Company Prefix is four to twelve digits (General Specifications
 *    26.0 §1.2.3.3). Publishing that range is not the same as being able to
 *    locate a prefix boundary inside an arbitrary key, which is what the GCP
 *    Length Table answers and what GS1 does not publish openly. `gcppos1` and
 *    `gcppos2` therefore stay unenforced for values Kannabi did not build.
 *  - Restricted Circulation Number prefix space is refused, because an RCN
 *    SHALL NOT be encoded using any GS1 Application Identifier (§1.2.2.2.1)
 *    and every value Kannabi issues is an AI element string.
 *
 * What a namespace may go on to issue is a separate question: see
 * `classReferenceWidth`. A prefix too long to leave a class reference is
 * capability-limited, not invalid.
 */
export const gcpLengths = { min: 4, max: 12 } as const;

/** Why this prefix cannot be managed, or null when it can.
 *
 * Separate from `canonicalGcp` because the same question is asked in two
 * situations that must answer differently. Configuring a namespace refuses a
 * bad prefix outright. Reading one configured under an earlier, looser policy
 * must not: that namespace exists, its issuance ledger is real, and a
 * deployment holding one has to keep starting and keep reading its history.
 * It simply cannot issue anything new, which is a reported capability rather
 * than a reason to reject the record or refuse to boot.
 */
export function gcpRefusalReason(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return 'A GS1 Company Prefix is a string of digits';
  }
  if (value.length < gcpLengths.min || value.length > gcpLengths.max) {
    return `A GS1 Company Prefix is ${gcpLengths.min} to ${gcpLengths.max} digits`;
  }
  const restricted = restrictedPrefixReason(value);
  if (restricted) {
    return `That GS1 Prefix ${restricted}, so it cannot be managed as a GS1 Company Prefix`;
  }
  return null;
}

export function canonicalGcp(value: unknown): string {
  const refusal = gcpRefusalReason(value);
  if (refusal) throw new ValidationError(refusal);
  return value as string;
}

/** Digits left for a class-level reference inside a GCP, before the check
 * digit. A GTIN and a GRAI asset type both carry twelve digits plus a check
 * digit, so both draw on the same width — from the same prefix, but never from
 * the same counter, because §2.3 states that a GTIN and a GRAI sharing the
 * same digits do not conflict.
 *
 * Zero or less means this namespace cannot issue class keys at all. That is a
 * reduced capability, never an invalid namespace: it stays fully usable for
 * GIAI, whose reference is alphanumeric and up to thirty characters.
 */
export const classReferenceDigits = 12;
export function classReferenceWidth(gcp: string): number {
  return classReferenceDigits - gcp.length;
}
export function canIssueClassKey(gcp: string): boolean {
  return classReferenceWidth(gcp) >= 1;
}

/** The class-level reference shared by a GRAI asset type and a base GTIN:
 * the prefix, a zero-padded sequence filling the remaining digits, and the
 * modulo-10 check digit.
 *
 * Shared because the arithmetic is genuinely identical, and shared as a
 * function rather than as a scheme table — each caller below names its own
 * scheme, so no generic key builder exists for a future scheme to be bolted
 * onto by accident.
 */
function classReference(gcp: string, sequence: number): string {
  const prefix = canonicalGcp(gcp);
  const width = classReferenceWidth(prefix);
  if (width < 1) {
    throw new ValidationError(
      `A ${prefix.length}-digit GS1 Company Prefix leaves no room for a ${classReferenceDigits}-digit class reference`);
  }
  const reference = allocatedSequence(sequence, 'class reference');
  if (reference.length > width) {
    throw new ValidationError('The namespace has exhausted its allocatable class references');
  }
  const body = prefix + reference.padStart(width, '0');
  return body + checkDigit(body);
}

/** A whole allocated sequence number as its decimal digits. */
function allocatedSequence(sequence: number, what: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ValidationError(`An allocated ${what} is a whole number of at least 1`);
  }
  return String(sequence);
}

/** Construct a GIAI Kannabi is issuing from a managed namespace.
 *
 * The single construction point: no caller concatenates a GIAI itself. Unlike a
 * GIAI Kannabi merely stores, this value's prefix boundary is known by
 * construction — Kannabi built it from a configured prefix. That is a statement
 * about construction, not about GS1 licensing: `gcppos1` stays unenforced for
 * identifiers Kannabi did not build, because their boundary is unknown.
 */
export function allocatedGiai(gcp: string, sequence: number): ExternalIdentifier {
  const prefix = canonicalGcp(gcp);
  // Unpadded decimal: the reference is terminal, so no width is needed, and a
  // fixed width would impose a ceiling. Ordering is by the stored sequence.
  const identifier = canonicalIdentifier({
    scheme: 'giai', assetReference: prefix + allocatedSequence(sequence, 'asset reference') });
  if (!identifier.components.assetReference.startsWith(prefix)) {
    throw new Error('Allocated GIAI does not begin with its configured prefix');
  }
  return identifier;
}

/** Construct a GRAI asset type Kannabi is allocating from a managed namespace.
 *
 * Class level by construction: the result carries no serial, so it names a
 * returnable asset type — a series of identical returnable assets — and not
 * any individual asset (§1.3.6.1, §4.4.2.1).
 */
export function allocatedGraiAssetType(gcp: string, sequence: number): ExternalIdentifier {
  return canonicalIdentifier({ scheme: 'grai', assetType: classReference(gcp, sequence) });
}

/** Construct a base GTIN Kannabi is allocating from a managed namespace.
 *
 * Base only. An indicator digit of 1 to 8 identifies a trade item grouping
 * derived from a base GTIN's own digits with a recomputed check digit
 * (§2.1.7), which is not an allocation from a prefix at all, and 9 is reserved
 * for variable measure trade items whose measure data completes the identity
 * (§2.1.10). Neither is constructible here, by design.
 */
export function allocatedGtin(gcp: string, sequence: number): ExternalIdentifier {
  return canonicalIdentifier({ scheme: 'gtin', gtin: classReference(gcp, sequence) });
}

/** Which GTIN format a namespace's own allocations take.
 *
 * A GS1 Company Prefix beginning with zero forms a U.P.C. Company Prefix,
 * which SHALL only construct twelve-digit trade item identifiers; any other
 * prefix yields a GTIN-13 (§1.2.3.3, §1.2.3.5). Both normalise to the same
 * fourteen-digit value with the same check digit, because the leading zeroes
 * are filler that does not change the GTIN data element value (§1.3.1, Table
 * 1-9). So this is presentation for whoever prints the symbol, derived from
 * the namespace on every read and never stored.
 */
export function allocatedGtinFormat(gcp: string): 'GTIN-12' | 'GTIN-13' {
  return gcp.startsWith('0') ? 'GTIN-12' : 'GTIN-13';
}

/** A class key a Group is asserting into a namespace it manages, so Kannabi
 * may issue serials under it. Validated by exactly the rules an attached
 * identifier is, plus the two refusals adoption owns.
 */
export function adoptableClassKey(value: unknown): ExternalIdentifier {
  const input = record(value, identifierInputFields);
  if (input.scheme === 'gtin' && typeof input.gtin === 'string' && input.gtin.length === 8) {
    // A GTIN-8 comes from a GS1-8 Prefix, which GS1 allocates to Member
    // Organisations rather than to companies (§1.2.3.2), so it is never
    // issued from a GS1 Company Prefix and has no serial space here. It stays
    // recordable through the ordinary identifier path, which claims nothing.
    throw new ValidationError('A GTIN-8 is issued from a GS1-8 Prefix, not from a GS1 Company Prefix, so it cannot be adopted into a namespace');
  }
  const identifier = canonicalIdentifier(input);
  if (identifier.scheme === 'gtin' && identifier.components.gtin[0] !== '0') {
    throw new ValidationError('A GTIN-14 with an indicator digit identifies a trade item grouping or a variable measure trade item, which this namespace does not manage');
  }
  if (identifier.scheme !== 'gtin' && identifier.scheme !== 'grai') {
    throw new ValidationError('A managed class key is a GTIN or a GRAI asset type');
  }
  if (identifier.level !== 'class') {
    throw new ValidationError('A managed class key is class level; a serialised GRAI identifies one Asset and is not one');
  }
  return identifier;
}

/** Whether a class key lies inside the prefix a namespace asserts.
 *
 * One rule for every GTIN format. In the fourteen-digit representation the
 * leading filler of a GTIN-8, GTIN-12 or GTIN-13 and the indicator of a true
 * GTIN-14 occupy the same position, so the prefix always begins at the second
 * digit (§1.3.1, Table 1-9). A GRAI asset type carries no filler, so its
 * prefix begins at the first.
 *
 * This establishes containment in the prefix the Group asserted, with exactly
 * the standing of that assertion. It is not a licensing check.
 */
export function classKeyWithinGcp(identifier: ExternalIdentifier, gcp: string): boolean {
  const digits = identifier.scheme === 'gtin'
    ? identifier.components.gtin.slice(1)
    : identifier.components.assetType;
  return typeof digits === 'string' && digits.startsWith(gcp);
}

/** Construct the serialised GRAI Kannabi is issuing under an asset type it
 * manages. The serial distinguishes an individual asset within that type and
 * is assigned by the asset owner or manager (§4.4.2.2). */
export function allocatedGraiSerial(assetType: string, sequence: number): ExternalIdentifier {
  return canonicalIdentifier({
    scheme: 'grai', assetType, serial: allocatedSequence(sequence, 'serial') });
}

/** Construct the SGTIN Kannabi is issuing under a GTIN it manages. Serial
 * non-duplication for a GTIN is the GTIN allocator's responsibility (§3.5.2);
 * Kannabi discharges it for the serials it issues and records, and cannot
 * speak for serials issued elsewhere for the same GTIN. */
export function allocatedSgtin(gtin: string, sequence: number): ExternalIdentifier {
  return canonicalIdentifier({
    scheme: 'sgtin', gtin, serial: allocatedSequence(sequence, 'serial') });
}

/** Rendering descriptors. Presentation only; the policy above remains the sole
 * authority on validity, so no caller re-implements a GS1 rule to draw a form. */
export type SchemeInput = Readonly<{
  name: string; label: string; required: boolean; numeric?: true; maxLength?: number; hint?: string;
}>;
export const schemeInputs: Readonly<Record<IdentifierScheme, readonly SchemeInput[]>> = {
  gtin: [{ name: 'gtin', label: 'GTIN / JAN', required: true, numeric: true, maxLength: 14 }],
  sgtin: [
    { name: 'gtin', label: 'GTIN / JAN', required: true, numeric: true, maxLength: 14 },
    { name: 'serial', label: 'Serial', required: true, maxLength: 20 },
  ],
  grai: [
    { name: 'assetType', label: 'Asset type', required: true, numeric: true, maxLength: 13,
      hint: '13 digits including the check digit, without the AI 8003 zero filler.' },
    { name: 'serial', label: 'Serial', required: false, maxLength: 16,
      hint: 'Optional. Without a serial the GRAI identifies the asset type, not this Asset.' },
  ],
  giai: [{ name: 'assetReference', label: 'GIAI value (AI 8004)', required: true, maxLength: 30,
    hint: 'Enter the complete value already assigned by an external authority, including its company prefix. Kannabi validates GS1 syntax, but does not verify who assigned it or who controls its prefix.' }],
};
export const schemeLabels: Readonly<Record<IdentifierScheme, string>> = {
  gtin: 'GTIN', sgtin: 'SGTIN', grai: 'GRAI', giai: 'GIAI',
};
export const schemeDescriptions: Readonly<Record<IdentifierScheme, string>> = {
  gtin: 'Trade item — describes what this Asset is',
  sgtin: 'Serialised trade item — identifies this Asset',
  grai: 'Returnable asset — identifies this Asset when serialised',
  giai: 'Individual asset — identifies this Asset',
};
/** Where GS1 itself defines each scheme.
 *
 * Kannabi explains Kannabi; what an SGTIN or a GIAI *is* belongs to GS1, and
 * pointing at the standard is more honest than paraphrasing it. These are
 * GS1's own Application Identifier reference pages, which is the right
 * granularity because a scheme here is exactly one AI element string.
 *
 * Each scheme links to the AI that distinguishes it rather than to its primary
 * key: AI 01 alone is a GTIN, so a serialised GTIN is identified by AI 21,
 * which is the association that makes it one. GS1 publishes no key page for a
 * serialised GTIN — "SGTIN" is the common name for that association, not a GS1
 * key — so there is nothing more specific to point at.
 */
export const schemeReference: Readonly<Record<IdentifierScheme, string>> = {
  gtin: 'https://ref.gs1.org/ai/01',
  sgtin: 'https://ref.gs1.org/ai/21',
  grai: 'https://ref.gs1.org/ai/8003',
  giai: 'https://ref.gs1.org/ai/8004',
};
export const levelLabels: Readonly<Record<IdentifierLevel, string>> = {
  individual: 'Identifies this Asset',
  class: 'Describes a class this Asset belongs to',
};
export { zero };
