import { Link, useOutletContext } from 'react-router';
import { api } from '../api';
import { AssetRow } from '../asset-row';
import { groupRead, GroupViewError, type GroupRelationship } from '../group-destination';
import { EmptyState, Hint, Panel } from '../ui';
import type { Route } from './+types/group-assets';

/** How many Assets the Group page shows before handing over to Inventory.
 *
 * This view is a glance, not a browser: enough to recognise what the Group
 * holds without leaving it. Searching, filtering, ordering and paging stay
 * with Inventory, one link away, rather than growing a second copy here. */
export const glanceSize = 5;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  // The inventory's own Group filter, ordered by the Asset chronology, so the
  // rows and the count are exactly what this viewer can read through the
  // Group.
  const page = await api.assets.$get({ query: { group: [params.key], sort: ['reportedAt'], dir: ['desc'],
    limit: [String(glanceSize)] } }).then(groupRead);
  return { assets: page.assets, matching: page.matching };
}

export default function GroupAssets({ loaderData: { assets, matching } }: Route.ComponentProps) {
  const { group } = useOutletContext<GroupRelationship>();
  const inventory = `/?group=${encodeURIComponent(group.key)}`;
  const count = new Intl.NumberFormat().format(matching);
  if (!assets.length) {
    return <Panel className="mt-0 p-0"><EmptyState>
      <h2>No Assets yet</h2>
      <p>Assets reported with this Group, or shared with it later, appear here.</p>
    </EmptyState></Panel>;
  }
  return <Panel className="mt-0 p-0">
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-6 py-3 max-sm:px-4">
      <Hint>Most recently reported · {assets.length} of {count}</Hint>
      <Link to={inventory} className="text-sm">
        {matching > assets.length ? `Open all ${count} in Inventory` : 'Open in Inventory'}</Link>
    </div>
    <ul>{assets.map((asset) => <AssetRow key={asset.id} asset={asset} detail="reportedAt" />)}</ul>
  </Panel>;
}

export { GroupViewError as ErrorBoundary };
