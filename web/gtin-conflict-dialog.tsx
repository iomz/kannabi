import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from './api';
import { assetPath } from '../shared/asset-uri';
import type { GtinConflictPage } from '../server/identity-store';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

function assetCount(count: number): string {
  return count === 1 ? '1 Asset has' : `${count} Assets have`;
}

/** Why GTIN consistency could not be switched on, and which Assets stand in
 * the way.
 *
 * The refusal carries the first page; further pages load as the list is
 * scrolled to its end, as the inventory does, so a large conflict set never
 * arrives as one payload and the dialog keeps its single acknowledgement. The
 * count is the server's total across the instance. Only Assets this administrator can read are
 * named — administration grants no Asset access — and the rest are counted,
 * so the number that blocks the change is never understated.
 */
export function GtinConflictDialog({ conflicts, onClose }: {
  conflicts: GtinConflictPage | null;
  onClose(): void;
}) {
  const [pages, setPages] = useState<GtinConflictPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State rather than a ref: the list lives in a portal that mounts after the
  // dialog opens, so the observer has to start when the end marker appears.
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
  useEffect(() => {
    setPages(conflicts ? [conflicts] : []);
    setError(null);
  }, [conflicts]);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const assets = pages.flatMap((page) => page.assets);

  const more = useCallback(async () => {
    if (!last?.next) return;
    setLoading(true);
    setError(null);
    try {
      const { gtinConflicts } = await unwrap(await api.admin['gtin-conflicts'].$get({ query: { after: last.next } }));
      setPages((current) => [...current, gtinConflicts]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load more Assets');
    } finally { setLoading(false); }
  }, [last]);

  useEffect(() => {
    if (!sentinel || !last?.next || loading || error || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void more();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, last, loading, error, more]);

  return <AlertDialog open={conflicts !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Cannot enable GTIN consistency</AlertDialogTitle>
        {/* The refusal, in the callout shape the account deletion dialog uses
            for its warning, on the danger surface because this is a refusal
            rather than a caution. It stays the dialog's description, so it is
            what assistive technology announces with the title. The Assets go
            below it, outside the red, as things to act on. */}
        <AlertDialogDescription className={'w-full justify-self-stretch rounded-md border border-destructive/30'
          + ' bg-danger-surface px-3 py-2 text-left text-danger-text'}>
          {first ? assetCount(first.total) : ''} conflicting GTINs. Resolve these conflicts before enabling
          this setting.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {assets.length ? <ul aria-label="Assets with conflicting GTINs"
        className="m-0 max-h-64 list-none overflow-y-auto p-0 text-sm [&_li]:py-1">
        {assets.map((asset) => <li key={asset.id}>
          <Link to={assetPath(asset.id)} className="underline underline-offset-2">{asset.name}</Link>
        </li>)}
        {last?.next ? <li ref={setSentinel} aria-hidden={!loading} className="text-muted-foreground">
          {loading ? 'Loading…' : ''}</li> : null}
      </ul> : null}
      {first && first.hidden > 0 ? <p className="m-0 text-sm text-muted-foreground">
        {first.hidden === 1 ? '1 more is' : `${first.hidden} more are`} in Groups you do not belong to.
      </p> : null}
      {error ? <p role="alert" className="m-0 text-sm">{error}</p> : null}
      <AlertDialogFooter>
        <AlertDialogCancel variant="default">OK</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
