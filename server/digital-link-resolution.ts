import { ValidationError } from './identity.js';
import { isAssetId } from './asset-id.js';
import { assetPath } from '../shared/asset-uri.js';
import { parseDigitalLinkPath } from './gs1-digital-link.js';
import { surfacedAssetPath, type SurfaceableIdentifier } from './surfaced-uri.js';
import type { AssetAudience } from './asset-audience.js';
import type { ExternalIdentifier } from './gs1.js';

/** Dereferencing an address to an Asset, and deciding where a person is sent.
 *
 * Kannabi answers the GS1 Digital Link forms it supports. That is Digital Link
 * dereferencing, not GS1-Conformant Resolver behaviour: Kannabi publishes no
 * resolver description file, declares no supported primary keys, and answers
 * no linkset. Nothing here may be described as conformant resolution.
 *
 * Two operations are kept apart, and the separation is what makes redirect
 * loops impossible rather than merely unlikely:
 *
 *   render    serve the Asset representation for an address that resolves
 *   surface   redirect to the URI Kannabi puts in front of a person
 *
 * Every Digital Link address renders. Only the native Asset URI surfaces. The
 * one redirect target is therefore always a render-only address, so a redirect
 * can never be followed by another.
 *
 * In particular a Digital Link form is never redirected to the preferred one.
 * Preference governs presentation; each supported form is an independent
 * standards-defined entry point to the same referent.
 */

/** What an address resolved to.
 *
 * `notFound` is deliberately returned both for an address naming nothing and
 * for one naming an Asset the reader may not see. A GTIN and serial are
 * printed on the object, so a distinguishable answer would let a label tell an
 * outsider that this instance exists in this deployment. Knowing how to
 * identify something never implies authority over information about it.
 */
export type AddressResolution =
  | Readonly<{ kind: 'render' }>
  | Readonly<{ kind: 'redirect'; location: string }>
  | Readonly<{ kind: 'notFound' }>
  | Readonly<{ kind: 'invalid'; message: string }>;

/** The Asset facts an address decision needs, and nothing else. */
export type ResolvableAsset = Readonly<{
  id: string;
  identifiers: readonly SurfaceableIdentifier[];
}>;

export type AssetResolver = {
  assetForIdentifier(audience: AssetAudience, identifier: ExternalIdentifier):
    Promise<ResolvableAsset | null>;
  assetById(audience: AssetAudience, id: string): Promise<ResolvableAsset | null>;
};

/** Resolve a raw request path in the Digital Link space.
 *
 * `null` means the path is not a Digital Link address, and the caller should
 * carry on with its ordinary routing. The path must be raw: decoding before
 * splitting loses the difference between a separator and a `%2F` in a value.
 */
export async function resolveDigitalLinkAddress(resolver: AssetResolver, audience: AssetAudience,
  rawPath: string): Promise<AddressResolution | null> {
  let address;
  try {
    address = parseDigitalLinkPath(rawPath);
  } catch (error) {
    if (error instanceof ValidationError) return Object.freeze({ kind: 'invalid' as const, message: error.message });
    throw error;
  }
  if (address === null) return null;
  // A well-formed address for a GS1 primary key Kannabi does not model. The
  // numeric path space belongs to Digital Link, so this is an address Kannabi
  // does not serve rather than an unrecognised application route.
  if (address.kind === 'unsupported') return notFound;
  const { identifier } = address;
  // A class-level identifier describes a trade item or an asset type, not an
  // Asset, so there is no single Asset for Kannabi to serve here. Whether a
  // GTIN becomes a Kannabi referent in its own right is #50's decision, and
  // answering with a list now would settle it by accident.
  if (identifier.level !== 'individual') return notFound;
  const asset = await resolver.assetForIdentifier(audience, identifier);
  return asset ? render : notFound;
}

/** Resolve the native Asset URI, which is the one address that may surface. */
export async function resolveNativeAddress(resolver: AssetResolver, audience: AssetAudience,
  id: string): Promise<AddressResolution> {
  // A malformed id is left to the application, which already renders its own
  // unavailable page for one. The native route's status behaviour is not part
  // of this change.
  if (!isAssetId(id)) return render;
  const asset = await resolver.assetById(audience, id);
  // Unknown or unreadable: render, so the native route keeps the behaviour and
  // the non-disclosure it already had. Redirecting here would announce that
  // the Asset exists and carries a Digital Link identity.
  if (!asset) return render;
  const surfaced = surfacedAssetPath(asset.id, asset.identifiers);
  return surfaced === assetPath(asset.id)
    ? render
    : Object.freeze({ kind: 'redirect' as const, location: surfaced });
}

const render: AddressResolution = Object.freeze({ kind: 'render' as const });
const notFound: AddressResolution = Object.freeze({ kind: 'notFound' as const });
