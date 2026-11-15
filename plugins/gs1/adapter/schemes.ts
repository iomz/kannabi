import type { Identifier, IdentifierRule, IdentifierScheme } from '../../../server/identifier.js';
import {
  assertAttachable, assertCompatible, canonicalIdentifier, identifierSchemes, schemeInputs, storedIdentifier,
  type ExternalIdentifier,
} from '../toolkit/gs1.js';
import { digitalLinkPath } from '../toolkit/digital-link.js';
import { refuse } from './refusal.js';

/** GS1, as Kannabi core sees it: four identifier schemes and one rule.
 *
 * Everything GS1 means stays behind `gs1.ts`. This file only presents it in
 * the shape core's registry asks for, so core can accept, restore and address
 * a GS1 identifier without importing anything GS1.
 */

const ids: ReadonlySet<string> = new Set(identifierSchemes);

/** The registry dispatches by scheme id, so an identifier reaching a GS1
 * scheme's own functions was built by `gs1.ts`. */
const gs1 = (identifier: Identifier): ExternalIdentifier => identifier as ExternalIdentifier;

/** The GS1 identifiers among an Asset's. A GS1 rule reads GS1 components, and
 * another scheme's component of the same name is not a GS1 statement. */
const ownOnly = (identifiers: readonly Identifier[]): ExternalIdentifier[] =>
  identifiers.filter((identifier) => ids.has(identifier.scheme)).map(gs1);

export const gs1Schemes: readonly IdentifierScheme[] = identifierSchemes.map((id) => Object.freeze({
  id,
  fields: schemeInputs[id].map((input) => input.name),
  accept: (input: Record<string, unknown>) => refuse(() => canonicalIdentifier(input)),
  restore: (canonical: unknown, policyVersion: unknown) => refuse(() => storedIdentifier(id, canonical, policyVersion)),
  // Only an individual-level identity has an address Kannabi dereferences.
  address: (identifier: Identifier) =>
    (identifier.level === 'individual' ? digitalLinkPath(gs1(identifier)) : null),
}));

/** What can be judged from the identifiers alone, before any setting is read:
 * every coherence rule but GTIN consistency, which is an instance policy and
 * is applied inside the write by the plugin's participant. */
const unconditional = Object.freeze({ enforceGtinConsistency: false });

/** Kannabi's GS1 coherence rules for one Asset that hold whatever the instance
 * is configured to accept, such as at most one GRAI asset-type series. */
export const gs1Rule: IdentifierRule = Object.freeze({
  assertSet: (identifiers: readonly Identifier[]) =>
    refuse(() => assertCompatible(ownOnly(identifiers), unconditional)),
  assertAddition: (existing: readonly Identifier[], addition: Identifier) => {
    if (ids.has(addition.scheme)) refuse(() => assertAttachable(ownOnly(existing), gs1(addition), unconditional));
  },
});
