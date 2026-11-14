import { isAssetId } from './asset-id.js';
import { assetPath } from '../shared/asset-uri.js';
import type { AssetAudience } from './asset-audience.js';
import type { Identifier } from './identifier.js';
import type { AddressClaim } from './plugin.js';

/** Dereferencing an address to an Asset, and deciding where a person is sent.
 *
 * Core has one address of its own, the native Asset URI. A plugin may claim
 * further root-level paths and say which Asset each names; core then decides
 * whether the reader may see that Asset. Resolving therefore grants no access
 * whoever claimed the path.
 *
 * Two operations are kept apart, and the separation is what makes redirect
 * loops impossible rather than merely unlikely:
 *
 *   render    serve the Asset representation for an address that resolves
 *   surface   redirect to the address put in front of a person
 *
 * Every claimed address renders. Only the native Asset URI surfaces. The one
 * redirect target is therefore always a render-only address, so a redirect
 * can never be followed by another, and no claimed address is ever redirected
 * to another one.
 */

/** What an address resolved to.
 *
 * `notFound` is deliberately returned both for an address naming nothing and
 * for one naming an Asset the reader may not see. An identifier is often
 * printed on the object, so a distinguishable answer would let a label tell an
 * outsider that the object exists in this deployment. Knowing how to identify
 * something never implies authority over information about it.
 */
export type AddressResolution =
  | Readonly<{ kind: 'render' }>
  | Readonly<{ kind: 'redirect'; location: string }>
  | Readonly<{ kind: 'notFound' }>
  | Readonly<{ kind: 'invalid'; message: string }>;

/** The Asset facts an address decision needs, and nothing else. */
export type ResolvableAsset = Readonly<{ id: string; identifiers: readonly Identifier[] }>;

export type AssetResolver = {
  assetForIdentifier(audience: AssetAudience, identifier: Identifier): Promise<ResolvableAsset | null>;
  assetById(audience: AssetAudience, id: string): Promise<ResolvableAsset | null>;
};

/** Decide a path a plugin claimed. The plugin read the path; this applies the
 * reader's access, so an Asset the reader may not see answers exactly as an
 * address naming nothing. */
export async function resolveClaimedAddress(resolver: AssetResolver, audience: AssetAudience,
  claim: AddressClaim): Promise<AddressResolution> {
  if (claim.kind === 'invalid') return Object.freeze({ kind: 'invalid' as const, message: claim.message });
  if (claim.kind === 'notFound') return notFound;
  const asset = claim.kind === 'asset'
    ? (isAssetId(claim.id) ? await resolver.assetById(audience, claim.id) : null)
    : await resolver.assetForIdentifier(audience, claim.identifier);
  return asset ? render : notFound;
}

/** Resolve the native Asset URI, which is the one address that may surface.
 * `surfaced` is the installed plugins' answer to which address to put in front
 * of a person for this Asset, or null for the native URI itself. */
export async function resolveNativeAddress(resolver: AssetResolver, audience: AssetAudience,
  id: string, surfaced: (asset: ResolvableAsset) => string | null): Promise<AddressResolution> {
  // A malformed id is left to the application, which already renders its own
  // unavailable page for one.
  if (!isAssetId(id)) return render;
  const asset = await resolver.assetById(audience, id);
  // Unknown or unreadable: render, so the native route keeps the behaviour and
  // the non-disclosure it already had. Redirecting here would announce that
  // the Asset exists and carries another address.
  if (!asset) return render;
  const location = surfaced(asset);
  return location === null || location === assetPath(asset.id)
    ? render
    : Object.freeze({ kind: 'redirect' as const, location });
}

const render: AddressResolution = Object.freeze({ kind: 'render' as const });
const notFound: AddressResolution = Object.freeze({ kind: 'notFound' as const });
