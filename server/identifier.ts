import { record, ValidationError } from './identity.js';

/** Kannabi's own model of an external identifier, and the contract a scheme
 * meets to supply one.
 *
 * Core knows that an Asset may carry identifiers, that each belongs to a
 * scheme, and whether one identifies a single Asset or describes many. It
 * knows nothing about what a scheme's values mean or how they are built: no
 * application identifier, check digit, prefix or resolver address appears
 * here. A scheme is supplied from outside, and with none installed an Asset is
 * still complete, because carrying no identifier is an ordinary state.
 *
 * Core records identifiers and never issues one. Whether a value was issued,
 * by whom, and whether it may ever be reused are facts and policy of whatever
 * issued it.
 */

/** Whether an identifier identifies exactly one Asset or describes a class of
 * them. A scheme derives it from the value; a caller never supplies it. The
 * two words are the vocabulary the API and the persistence labels already use.
 */
export type IdentifierLevel = 'individual' | 'class';
export const identifierLevels: readonly IdentifierLevel[] = ['individual', 'class'];

export type IdentifierComponents = Readonly<Record<string, string>>;

export type Identifier = Readonly<{
  /** The id of the scheme that accepted the value. */
  scheme: string;
  /** The only stored form of the value. Everything else is derived from it. */
  canonical: string;
  /** The scheme's own reading of the canonical form. Opaque to core. */
  components: IdentifierComponents;
  level: IdentifierLevel;
  /** The version of the scheme's policy that accepted the value. Historical
   * provenance: never a claim that today's policy would accept it. */
  policyVersion: string;
}>;

export type IdentifierScheme = Readonly<{
  /** Stable and lowercase. Stored with every identifier of the scheme. */
  id: string;
  /** The fields a caller may supply for this scheme, beside `scheme`. */
  fields: readonly string[];
  /** Validate caller input and derive the identifier. Strict: a value the
   * scheme cannot justify is refused, never repaired. */
  accept(input: Record<string, unknown>): Identifier;
  /** Rebuild an identifier from what was stored. Never revalidates: a stored
   * value was accepted by the policy version it carries, and stays accepted. */
  restore(canonical: unknown, policyVersion: unknown): Identifier;
  /** A path at which Kannabi dereferences this identifier, or null when it
   * has none. Derived on read and never stored. */
  address?(identifier: Identifier): string | null;
}>;

/** What a rule is told about the instance when it judges an Asset's
 * identifiers: the acceptance settings read in the same transaction as the
 * write, or null before that transaction opens. Given null, a rule applies
 * only what does not depend on a setting. Core passes it through unread. */
export type AcceptanceSettings = Readonly<Record<string, unknown>> | null;

/** A rule over the identifiers of one Asset, owned by whoever owns the meaning
 * the rule is about. Core applies every installed rule inside the write and
 * has no cross-identifier rule of its own beyond refusing an exact repeat. */
export type IdentifierRule = Readonly<{
  /** Refuse the complete set of identifiers an Asset is reported with. */
  assertSet(identifiers: readonly Identifier[], settings: AcceptanceSettings): void;
  /** Refuse one more identifier joining those an Asset already carries. */
  assertAddition(existing: readonly Identifier[], addition: Identifier, settings: AcceptanceSettings): void;
}>;

export type IdentifierSchemes = Readonly<{
  /** Installed scheme ids, in installation order. */
  ids: readonly string[];
  /** `scheme` and every field any installed scheme accepts: the one list that
   * carries identifier input across the API. */
  inputFields: readonly string[];
  has(id: unknown): id is string;
  /** Validate one identifier a caller supplied. */
  accept(value: unknown): Identifier;
  /** Validate a list a caller supplied, and apply every rule that does not
   * depend on instance settings. */
  acceptAll(value: unknown): Identifier[];
  restore(scheme: unknown, canonical: unknown, policyVersion: unknown): Identifier;
  address(identifier: Identifier): string | null;
  assertSet(identifiers: readonly Identifier[], settings: AcceptanceSettings): void;
  assertAddition(existing: readonly Identifier[], addition: Identifier, settings: AcceptanceSettings): void;
}>;

const repeated = 'An Asset cannot carry the same identifier twice';

/** Assemble the installed schemes and rules into the registry core consults.
 *
 * Built once where the application is composed and handed to whatever needs
 * it. It is a value rather than a global, so two differently composed stores
 * can exist side by side, which is what a test of Kannabi without any scheme
 * needs. */
export function identifierSchemes(schemes: readonly IdentifierScheme[],
  rules: readonly IdentifierRule[] = []): IdentifierSchemes {
  const byId = new Map<string, IdentifierScheme>();
  for (const scheme of schemes) {
    if (!/^[a-z][a-z0-9-]*$/.test(scheme.id)) throw new Error(`Identifier scheme id "${scheme.id}" is not a lowercase token`);
    if (byId.has(scheme.id)) throw new Error(`Identifier scheme "${scheme.id}" is installed twice`);
    if (scheme.fields.includes('scheme')) throw new Error(`Identifier scheme "${scheme.id}" declares the reserved field "scheme"`);
    byId.set(scheme.id, scheme);
  }
  const ids = Object.freeze([...byId.keys()]);
  const inputFields = Object.freeze(['scheme', ...new Set(schemes.flatMap((scheme) => scheme.fields))]);
  const installed = (id: unknown): IdentifierScheme => {
    const scheme = typeof id === 'string' ? byId.get(id) : undefined;
    if (!scheme) {
      throw new ValidationError(ids.length
        ? `Supported identifier schemes are ${ids.join(', ')}`
        : 'No identifier scheme is installed');
    }
    return scheme;
  };
  const accept = (value: unknown): Identifier => {
    // Said before any field is judged: with nothing installed, every field a
    // caller names is unknown, and that would hide the actual reason.
    if (!ids.length) throw new ValidationError('No identifier scheme is installed');
    const input = record(value, inputFields);
    return installed(input.scheme).accept(input);
  };
  const assertSet = (identifiers: readonly Identifier[], settings: AcceptanceSettings): void => {
    const seen = new Set<string>();
    for (const identifier of identifiers) {
      if (seen.has(identifier.canonical)) throw new ValidationError(repeated);
      seen.add(identifier.canonical);
    }
    for (const rule of rules) rule.assertSet(identifiers, settings);
  };
  return Object.freeze({
    ids,
    inputFields,
    has: (id: unknown): id is string => typeof id === 'string' && byId.has(id),
    accept,
    acceptAll(value: unknown): Identifier[] {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) throw new ValidationError('Identifiers must be a list');
      const identifiers = value.map(accept);
      assertSet(identifiers, null);
      return identifiers;
    },
    restore: (scheme, canonical, policyVersion) => installed(scheme).restore(canonical, policyVersion),
    address: (identifier) => byId.get(identifier.scheme)?.address?.(identifier) ?? null,
    assertSet,
    assertAddition(existing, addition, settings) {
      if (existing.some((identifier) => identifier.canonical === addition.canonical)) {
        throw new ValidationError(repeated);
      }
      for (const rule of rules) rule.assertAddition(existing, addition, settings);
    },
  });
}
