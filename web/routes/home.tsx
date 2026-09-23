import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import type { AssetPage, Entity } from '../../server/identity-store';
import { assetFilters, canonicalFilters, type AssetDirection, type AssetScope, type AssetSort }
  from '../../server/asset-page';
import { Icon } from '../icon';
import { AssetRow } from '../asset-row';
import { InventoryControls, inventoryPath, type InventoryView } from '../inventory-controls';
import type { Route } from './+types/home';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeading, Panel } from '../ui';

/** The API query for a URL, keeping repeated parameters intact.
 *
 * `group` and `scheme` may appear more than once, and collapsing them to one
 * entry would let the chips show a filter the request never applied. Both
 * request sites go through here so they cannot drift apart.
 */
function assetQuery(params: URLSearchParams): Record<string, string[]> {
  return Object.fromEntries([...new Set(params.keys())].map((key) => [key, params.getAll(key)]));
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  if (!(await unwrap(await api.me.$get())).user) throw redirect('/signin');
  const url = new URL(request.url);
  const params = url.searchParams;
  // The view is parsed with the same code the API validates against, so the
  // URL, the request and the cursor binding always agree on the filter state.
  const view: InventoryView = {
    q: params.get('q') ?? '',
    scope: (params.get('scope') ?? 'all') as AssetScope,
    sort: (params.get('sort') ?? 'name') as AssetSort,
    dir: (params.get('dir') ?? 'asc') as AssetDirection,
    filters: assetFilters(assetQuery(params)),
  };
  const [page, { groups }] = await Promise.all([
    unwrap(await api.assets.$get({ query: assetQuery(params) },
      { init: { signal: request.signal } })),
    unwrap(await api.groups.$get()),
  ]);
  return { page, view, groups };
}

export default function Assets({ loaderData: { page, view, groups } }: Route.ComponentProps) {
  return <Inventory key={JSON.stringify([view.q, view.scope, view.sort, view.dir,
    canonicalFilters(view.filters)])} initial={page} view={view} groups={groups} />;
}

function Inventory({ initial, view, groups }: {
  initial: AssetPage; view: InventoryView; groups: readonly Entity[];
}) {
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(initial);
    setError(false);
    setLoading(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [initial]);

  const loadMore = useCallback(async () => {
    if (!page.nextCursor || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(false);
    try {
      const next = await unwrap(await api.assets.$get(
        { query: { ...assetQuery(new URLSearchParams(inventoryPath(view).split('?')[1] ?? '')),
          cursor: page.nextCursor } },
        { init: { signal: controller.signal } }));
      if (controller.signal.aborted) return;
      setPage((previous) => {
        // Live edits can move an Asset in the name ordering. Keep one row per native Asset identity.
        const assets = new Map(previous.assets.map((asset) => [asset.id, asset]));
        next.assets.forEach((asset) => assets.set(asset.id, asset));
        return { ...next, assets: [...assets.values()] };
      });
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setLoading(false); }
    }
  }, [page.nextCursor, view]);

  useEffect(() => {
    if (!sentinel.current || !page.nextCursor || loading || error || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '300px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [page.nextCursor, loading, error, loadMore]);

  const { q, scope, filters } = view;
  const filtered = canonicalFilters(filters).length > 0;
  return <>
    <PageHeading eyebrow="Inventory" title="Assets"
      description={q ? `Results for “${q}”` : 'Physical things, shared knowledge, lasting identity.'}>
      <Button className="shrink-0" render={<Link to="/assets/report" />}><Icon name="plus" />Report Asset</Button>
    </PageHeading>
    <section aria-label="Asset inventory" aria-busy={loading}>
      <InventoryControls view={view} groups={groups} scopes={page.scopes} />
      {q && <p className="mt-2 mb-4 text-[.8rem]">
        <Link to={inventoryPath({ ...view, q: '' })}>Clear search</Link></p>}
      {!page.assets.length
        ? <Panel className="p-0"><EmptyState>
          <h2>{q || scope !== 'all' || filtered ? 'No matching Assets' : 'Your inventory starts here'}</h2>
          <p>{q || scope !== 'all' || filtered
            ? 'Try another scope, adjust the view, or search by name.'
            : 'Report an Asset and choose a Group to collaborate with.'}</p>
          {!q && scope === 'all' && !filtered && <Link to="/assets/report">Report your first Asset →</Link>}
        </EmptyState></Panel>
        : <ul className="overflow-hidden rounded border bg-card">{page.assets.map((asset) =>
          <AssetRow key={asset.id} asset={asset} detail={view.sort === 'reportedAt' ? 'reportedAt' : undefined} />)}</ul>}
      <div ref={sentinel} className="py-5 text-center text-[.85rem] text-muted-foreground [&>p]:flex [&>p]:items-center [&>p]:justify-center [&>p]:gap-3">
        {loading && <p role="status">
          <span aria-hidden="true" className="size-[1.1rem] animate-spin rounded-full border-2 border-border border-t-brand motion-reduce:animate-none" />
          Loading more assets…</p>}
        {error && <p role="alert">Could not load more Assets. Your current results are still here.</p>}
        {page.nextCursor && <Button variant={error ? 'outline' : 'link'} disabled={loading}
          className={loading ? 'hidden' : ''} onClick={() => void loadMore()}>
          {error ? 'Retry loading' : 'Load more Assets'}
        </Button>}
      </div>
    </section>
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
