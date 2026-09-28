import { publicShellHandle } from '../anonymous-shell';
import { api, unwrap } from '../api';
import { AssetView, loadAsset, submitAsset } from '../asset-view';
import { parseDigitalLinkPath } from '../../server/gs1-digital-link.js';
import type { Route } from './+types/digital-link';

/** A GS1 Digital Link address, rendering the Asset it identifies.
 *
 * Every supported form lands here, and none of them redirects — not to the
 * native Asset URI, and not to the Asset's preferred Digital Link. Preference
 * decides what Kannabi shows; each supported form stays an independent
 * standards-defined entry point to the same referent, and keeping this route
 * render-only is what makes a redirect loop impossible.
 *
 * The server has already resolved the address and set the response status.
 * This resolves it again because the application is a single-page build with
 * no server render to hand the result to.
 */
export const handle = publicShellHandle;

/** The path is read raw, exactly as the server reads it: decoding before
 * splitting would lose the difference between a separator and a `%2F` inside
 * a GIAI or a serial. */
async function assetIdFor(url: string): Promise<string> {
  const unavailable = new Response('No Asset has this identity.', { status: 404 });
  let address;
  try {
    address = parseDigitalLinkPath(new URL(url).pathname);
  } catch {
    // Malformed. The server answered 400 already; the page says the same
    // thing it says for an address that names nothing.
    throw unavailable;
  }
  // A class-level identifier describes a trade item or an asset type rather
  // than an Asset, so there is nothing single for this route to render (#50).
  if (address?.kind !== 'identifier' || address.identifier.level !== 'individual') throw unavailable;
  const { scheme, components } = address.identifier;
  // The component names are the identifier input fields the lookup query
  // takes, so a resolved identity is asked for in exactly the form it was
  // accepted in, with no reformatting between the two.
  //
  // The cast is not about this call. Hono derives an endpoint's client-side
  // query type from its validator's return value, so /assets/lookup
  // advertises the parsed request rather than the fields it accepts. The
  // server validates what actually arrives through the same GS1 boundary.
  const query = { scheme, ...components } as never;
  const { assets } = await unwrap(await api.assets.lookup.$get({ query }));
  // Lookup runs over the reader-visible set, so an Asset that exists but is
  // not readable arrives here as no Asset at all — the same answer as one
  // that does not exist, which is what keeps a printed label from disclosing
  // that this instance is held here.
  const asset = assets[0];
  if (!asset) throw unavailable;
  return asset.id;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadAsset(await assetIdFor(request.url), request);
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  return submitAsset(await assetIdFor(request.url), request);
}

export default function DigitalLinkPage({ loaderData }: Route.ComponentProps) {
  return <AssetView {...loaderData} />;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
