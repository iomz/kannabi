import { publicShellHandle } from '../anonymous-shell';
import { AssetView, loadAsset, submitAsset } from '../asset-view';
import type { Route } from './+types/asset';

/** The native Asset URI. Always valid, for every Asset, and unchanged by any
 * identifier the Asset gains or loses.
 *
 * When the Asset has an eligible GS1 identity the server answers this address
 * with a temporary redirect to the surfaced Digital Link URI, so a document
 * request rarely arrives here. A client-side navigation still can, and this
 * route renders the same view either way.
 */
export const handle = publicShellHandle;

export function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  return loadAsset(params.id, request);
}

/** Identity comes from the submission, not from this route's parameters, so
 * a mutation behaves identically however the page was addressed. */
export function clientAction({ request }: Route.ClientActionArgs) {
  return submitAsset(request);
}

export default function AssetPage({ loaderData }: Route.ComponentProps) {
  return <AssetView {...loaderData} />;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
