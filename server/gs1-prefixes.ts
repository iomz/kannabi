/** Restricted GS1 Prefix ranges, transcribed from the GS1 General
 * Specifications. Mechanical content only.
 *
 * Source:  GS1 General Specifications Standard
 * Release: 26.0, Ratified, Jan 26
 * Section: 1.2.3.1, Table 1-4 (Synopsis of GS1 Prefix ranges)
 *
 * Only the ranges Kannabi must refuse as a managed GS1 Company Prefix are
 * transcribed. Everything else is left alone deliberately: a range this file
 * does not list is permitted, so a transcription gap fails open into ordinary
 * behaviour rather than rejecting a prefix an operator legitimately holds.
 *
 * Why these ranges and no others. Section 1.2.2.2.1 states that Restricted
 * Circulation Numbers SHALL NOT be used globally or in open environments, and
 * SHALL NOT be encoded using any GS1 Application Identifier. Kannabi expresses
 * every identifier as an AI element string, so an RCN can never be a value
 * Kannabi issues, and a namespace built on one could only produce values that
 * are non-conformant by construction.
 *
 * Table 1-5's GS1-8 Prefixes are not transcribed. They issue GTIN-8s and are
 * allocated to GS1 Member Organisations rather than to companies, so they are
 * never a GS1 Company Prefix in the first place; `canonicalGcp` rejects them
 * by their GS1 Prefix, and GTIN-8 has its own refusal at the GTIN boundary.
 *
 * Deliberately not rejected here, although Table 1-4 does not designate them
 * for GS1 Company Prefix issuance either: the ISBN, ISMN and ISSN ranges, the
 * coupon and refund-receipt ranges, the reserved ranges, and the discontinued
 * EPC General Identifier range. Refusing them would be defensible, and is
 * outside what this milestone decided; they are not restricted-circulation
 * space, which is the rule with the normative basis quoted above.
 *
 * Prefix 952 — "Used for demonstrations and examples of the GS1 system" — is
 * likewise permitted, and is what Kannabi's own fixtures and demo data use.
 */

/** One transcribed range, as equal-length digit strings so the comparison is
 * a plain string comparison at a fixed prefix length. */
type PrefixRange = Readonly<{ from: string; to: string; reason: string }>;

const restrictedPrefixes: readonly PrefixRange[] = Object.freeze([
  { from: '0000000', to: '0000000',
    reason: 'issues Restricted Circulation Numbers within a company' },
  // Not restricted-circulation space, but never a GS1 Company Prefix either:
  // the range exists so GTIN-8 values cannot collide with longer keys.
  { from: '0000001', to: '0000099',
    reason: 'is unused, to avoid collision with GTIN-8' },
  { from: '02', to: '02',
    reason: 'issues Restricted Circulation Numbers within a geographic region' },
  { from: '04', to: '04',
    reason: 'issues Restricted Circulation Numbers within a company' },
  { from: '20', to: '29',
    reason: 'issues Restricted Circulation Numbers within a geographic region' },
].map((range) => Object.freeze(range)));

/** Why this value's GS1 Prefix may not serve as a managed namespace, or null.
 *
 * Every transcribed range is checked at its own length. The General
 * Specifications guarantee the ranges cannot overlap — section 1.2.3.1 states
 * that once a GS1 Prefix is issued, no other GS1 Prefix beginning with the
 * same digits SHALL be issued — so at most one can match.
 */
export function restrictedPrefixReason(gcp: string): string | null {
  for (const range of restrictedPrefixes) {
    const candidate = gcp.slice(0, range.from.length);
    if (candidate.length === range.from.length
      && candidate >= range.from && candidate <= range.to) {
      return range.reason;
    }
  }
  return null;
}
