import { ValidationError, record } from './identity.js';
import {
  cset82, csum, entries, enforcedLinters, syntaxDictionaryRelease, unenforcedLinters, zero,
} from './gs1-syntax.js';

/** The single GS1 boundary. GS1 syntax and association rules are enforced here
 * and nowhere else; the rest of Kannabi treats an identifier as opaque data
 * plus a derived level. Kannabi's internal model is not the GS1 ontology.
 */

export type IdentifierScheme = 'gtin' | 'sgtin' | 'grai' | 'giai';
export type IdentifierLevel = 'individual' | 'class';
export type IdentifierComponents = Readonly<Record<string, string>>;

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
  version: `${syntaxDictionaryRelease}+kannabi.1`,
  syntaxDictionaryRelease,
  generalSpecificationsRelease: '26.0',
  assertedBy: 'kannabi',
  enforcedLinters,
  unenforcedLinters,
} as const;

export const identifierSchemes: readonly IdentifierScheme[] = ['gtin', 'sgtin', 'grai', 'giai'];

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
  /** Application Identifiers this scheme contributes to an Asset. */
  ais: readonly string[];
  fields: readonly string[];
  build(input: Record<string, unknown>): { components: IdentifierComponents; canonical: string };
  parse(canonical: string): IdentifierComponents;
  level(components: IdentifierComponents): IdentifierLevel;
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
  },
};

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
 * identifiers may describe the same Asset. Deliberately absent here is any GS1
 * `req=` / `ex=` evaluation, which belongs to a single AI element string and is
 * applied per identifier by `assertAiAssociations`. Only these two rules are
 * Kannabi's, and both are about the Asset rather than about AI syntax.
 */
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
  if (gtins.size > 1) throw new ValidationError('Identifiers claim conflicting GTINs for one Asset');
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
  giai: [{ name: 'assetReference', label: 'Asset reference', required: true, maxLength: 30,
    hint: 'The complete AI 8004 value, including the company prefix.' }],
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
export const levelLabels: Readonly<Record<IdentifierLevel, string>> = {
  individual: 'Identifies this Asset',
  class: 'Describes a class this Asset belongs to',
};
export { zero };
