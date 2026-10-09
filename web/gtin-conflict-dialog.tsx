import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from './api';
import { assetPath } from '../shared/asset-uri';
import type { GtinConflictPage } from '../server/identity-store';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

function assetCount(count: number): string {
  return count === 1 ? '1 Asset has' : `${count} Assets have`;
}

/** Why GTIN consistency could not be switched on, and which Assets stand in
 * the way.
 *
 * The refusal carries the first page; further pages are read on request, so a
 * large conflict set never arrives as one payload. The count is the server's
 * total across the instance. Only Assets this administrator can read are
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
  useEffect(() => {
    setPages(conflicts ? [conflicts] : []);
    setError(null);
  }, [conflicts]);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const assets = pages.flatMap((page) => page.assets);

  async function more() {
    if (!last?.next) return;
    setLoading(true);
    setError(null);
    try {
      const { gtinConflicts } = await unwrap(await api.admin['gtin-conflicts'].$get({ query: { after: last.next } }));
      setPages((current) => [...current, gtinConflicts]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load more Assets');
    } finally { setLoading(false); }
  }

  return <AlertDialog open={conflicts !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Cannot enable GTIN consistency</AlertDialogTitle>
        <AlertDialogDescription>
          {first ? assetCount(first.total) : ''} conflicting GTINs. Resolve these conflicts before enabling
          this setting.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {assets.length ? <ul aria-label="Assets with conflicting GTINs"
        className="m-0 max-h-64 list-none overflow-y-auto p-0 text-sm [&_li]:py-1">
        {assets.map((asset) => <li key={asset.id}>
          <Link to={assetPath(asset.id)} className="underline underline-offset-2">{asset.name}</Link>
        </li>)}
      </ul> : null}
      {first && first.hidden > 0 ? <p className="m-0 text-sm text-muted-foreground">
        {first.hidden === 1 ? '1 more is' : `${first.hidden} more are`} in Groups you do not belong to.
      </p> : null}
      {error ? <p role="alert" className="m-0 text-sm">{error}</p> : null}
      <AlertDialogFooter>
        {last?.next ? <Button type="button" variant="outline" disabled={loading} onClick={() => { void more(); }}>
          {loading ? 'Loading…' : 'Show more'}</Button> : null}
        <AlertDialogCancel>Close</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
