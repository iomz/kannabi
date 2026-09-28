import { assetPath } from '../shared/asset-uri.js';
import { digitalLinkPath } from './gs1-digital-link.js';
import type { ExternalIdentifier, IdentifierScheme } from './gs1.js';

/** Which URI Kannabi puts in front of a person.
 *
 * This is Kannabi presentation policy, not GS1 policy. The Digital Link
 * standard expresses a GIAI and a GTIN in either order and says the two are
 * not equivalent, so it defines what each form means without choosing between
 * them; the choice is necessarily Kannabi's. Constructing a URI stays in the
 * GS1 boundary, and this module only decides which one is shown.
 *
 * Nothing here is identity. `Asset.id` and the native Asset URI are unchanged
 * and always valid, the result is derived on every read and never stored, and
 * no equivalence is asserted between the forms. Detaching the preferred
 * identifier changes what is surfaced and nothing else.
 */

/** Only an identifier whose referent is this Asset may be surfaced for it.
 *
 * GIAI and GRAI are primary keys that denote the individual asset. An SGTIN's
 * primary key is a trade-item key carrying a serial qualifier, so preferring
 * the other two keeps the surfaced URI's path rooted in the Asset rather than
 * in the trade item it is an instance of.
 *
 * A class-level identifier is never eligible, whatever its scheme: a GTIN-only
 * Digital Link denotes a trade item, and surfacing one as an Asset's URI would
 * flatten exactly the Item/Asset distinction the identifier model protects.
 * That is a rule about what may be surfaced *for an Asset*, and not a claim
 * that a GTIN can never identify a Kannabi-managed referent.
 */
const surfacingOrder: readonly IdentifierScheme[] = ['giai', 'grai', 'sgtin'];

export type SurfaceableIdentifier =
  Pick<ExternalIdentifier, 'scheme' | 'level' | 'components' | 'canonical'>;

/** The identifier whose Digital Link URI Kannabi surfaces, or `null`.
 *
 * Deterministic: eligible identifiers are ranked by scheme, and a tie within
 * one scheme breaks on the canonical form. Canonical order is used rather than
 * the order the store happened to return, so the same Asset surfaces the same
 * URI on every read regardless of how its identifiers were projected.
 *
 * Issuance is deliberately absent. Kannabi issuing a GIAI is provenance, and
 * provenance grants nothing — including precedence over a recorded existing
 * identifier.
 */
export function preferredDigitalLinkIdentifier<T extends SurfaceableIdentifier>(
  identifiers: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = surfacingOrder.length;
  for (const identifier of identifiers) {
    if (identifier.level !== 'individual') continue;
    const rank = surfacingOrder.indexOf(identifier.scheme);
    if (rank < 0) continue;
    if (best === null || rank < bestRank
      || (rank === bestRank && identifier.canonical < best.canonical)) {
      best = identifier;
      bestRank = rank;
    }
  }
  return best;
}

/** The path Kannabi surfaces for this Asset: its preferred Digital Link when
 * one exists, and its native Asset URI otherwise.
 *
 * An Asset with no eligible identifier is not a lesser case. Its native URI is
 * what it has always been, and is presented without qualification.
 */
export function surfacedAssetPath(id: string,
  identifiers: readonly SurfaceableIdentifier[]): string {
  const preferred = preferredDigitalLinkIdentifier(identifiers);
  return preferred ? digitalLinkPath(preferred) : assetPath(id);
}
