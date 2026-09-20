import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, redirect } from 'react-router';
import { api, unwrap } from '../api';
import { assetPath, assetPhotoPath } from '../../shared/asset-uri';
import type { Asset, AssetPage } from '../../server/identity-store';
import type { AssetScope } from '../../server/asset-page';
import { Icon } from '../icon';
import { ReporterAttribution } from '../reporter-attribution';
import type { Route } from './+types/home';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  if (!(await unwrap(await api.me.$get())).user) throw redirect('/signin');
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  const scope = params.get('scope') ?? 'all';
  const page = await unwrap(await api.assets.$get({ query: { q, scope } }, { init: { signal: request.signal } }));
  return { page, q, scope: scope as AssetScope };
}

export default function Assets({ loaderData: { page, q, scope } }: Route.ComponentProps) {
  return <Inventory key={JSON.stringify([q, scope])} initial={page} q={q} scope={scope} />;
}

function Inventory({ initial, q, scope }: { initial: AssetPage; q: string; scope: AssetScope }) {
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
      const next = await unwrap(await api.assets.$get({ query: { q, scope, cursor: page.nextCursor } },
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
  }, [page.nextCursor, q, scope]);

  useEffect(() => {
    if (!sentinel.current || !page.nextCursor || loading || error || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '300px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [page.nextCursor, loading, error, loadMore]);

  const count = new Intl.NumberFormat();
  return <>
    <div className="page-heading"><div><p className="eyebrow">Inventory</p><h1>Assets</h1>
      <p>{q ? `Results for “${q}”` : 'Physical things, shared knowledge, lasting identity.'}</p></div>
      <Link to="/assets/report" className="button"><Icon name="plus" />Report Asset</Link>
    </div>
    <section className="inventory" aria-label="Asset inventory" aria-busy={loading}>
      <div className="inventory-toolbar">
        <nav className="inventory-scopes" aria-label="Asset scope">
          {([['all', 'All'], ['mine', 'Mine'], ['group', 'Group access'], ['public', 'Public']] as const).map(([value, label]) =>
            <Link key={value} to={'/?' + new URLSearchParams({ ...(q ? { q } : {}), scope: value })}
              aria-current={scope === value ? 'page' : undefined} className={scope === value ? 'active' : ''}
              title={value === 'mine' ? 'Readable Assets you originally reported' : undefined}>
              {label}<span>{count.format(page.scopes[value])}</span>
            </Link>)}
        </nav>
        <span className="inventory-count" role="status">{count.format(page.matching)} {page.matching === 1 ? 'asset' : 'assets'}</span>
      </div>
      {q && <p className="search-context"><Link to={'/?' + new URLSearchParams({ scope })}>Clear search</Link></p>}
      {!page.assets.length ? <div className="panel empty-state"><h2>{q || scope !== 'all' ? 'No matching Assets' : 'Your inventory starts here'}</h2>
        <p>{q || scope !== 'all' ? 'Try another scope or search by name.' : 'Report an Asset with its existing identifier and choose a Group to collaborate with.'}</p>
        {!q && scope === 'all' && <Link to="/assets/report">Report your first Asset →</Link>}</div>
        : <ul className="inventory-list">{page.assets.map((asset) => <li key={asset.id}>
          <Link className="inventory-row" to={assetPath(asset.id)}>
            <Thumbnail key={asset.photos[0]?.key ?? 'none'} asset={asset} />
            <div className="inventory-row-body"><strong>{asset.name}</strong>
              <span className="asset-identifier">{asset.identifier.scheme.toUpperCase()} · {asset.identifier.scheme === 'sgtin' ? `${asset.identifier.gtin} / ${asset.identifier.serial}` : asset.identifier.grai}</span>
              <span className="asset-context"><Icon name="groups" /><span>{asset.groups.map((group) => group.name).join(', ')}</span><span className="context-divider">·</span><span>Reported by <ReporterAttribution reporter={asset.reportedBy} /></span></span>
            </div>
              <span className={'badge ' + (asset.isPublic ? 'public' : '')}><Icon name={asset.isPublic ? 'globe' : 'lock'} />{asset.isPublic ? 'Public' : 'Group access'}</span>
          </Link>
        </li>)}</ul>}
      <div ref={sentinel} className="inventory-load">
        {loading && <p role="status"><span className="spinner" aria-hidden="true" />Loading more assets…</p>}
        {error && <p role="alert">Could not load more Assets. Your current results are still here.</p>}
        {page.nextCursor && <button className={error ? "secondary" : "load-more"} disabled={loading} onClick={() => void loadMore()}>
          {error ? 'Retry loading' : 'Load more Assets'}
        </button>}
      </div>
    </section>
  </>;
}

function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const photo = asset.photos[0];
  return <div className="asset-thumbnail">{photo && !failed
    ? <img src={assetPhotoPath(asset.id, photo.key)}
        alt={'Photo of ' + asset.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span title={failed ? 'Photo unavailable' : 'No photo'}><Icon name="photo" /><span className="sr-only">{failed ? 'Photo unavailable' : 'No photo'}</span></span>}</div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
