import { Link, useLocation } from 'react-router';
import { useState } from 'react';
import { assetPath, assetPhotoPath } from '../shared/asset-uri';
import { schemeLabels } from '../server/gs1.js';
import type { Asset } from '../server/identity-store';
import { displayDate } from '../server/settings.js';
import { Icon } from './icon';
import { ReporterAttribution } from './reporter-attribution';
import { Badge } from '@/components/ui/badge';

/** One Asset as it appears in any list. Shared so the inventory and identity
 * lookup present Assets identically rather than drifting into two layouts. */
export function AssetRow({ asset, detail }: { asset: Asset; detail?: 'reportedAt' }) {
  const location = useLocation();
  return <li className="border-t first:border-t-0">
    {/* Carrying the complete location lets the Asset page return to the view it
        was opened from — the inventory query, or the lookup that resolved it. */}
    <Link to={assetPath(asset.id)} state={{ from: location.pathname + location.search }}
      className="grid min-h-24 grid-cols-[94px_minmax(0,1fr)_auto] items-center gap-[1.4rem] py-[.6rem] pr-[1.4rem] pl-[.65rem] text-inherit hover:bg-accent focus-visible:[outline-offset:-3px] [&:hover_strong]:underline [&:hover_strong]:[text-underline-offset:.2em] max-sm:grid-cols-[66px_minmax(0,1fr)] max-sm:gap-x-[.8rem] max-sm:gap-y-[.4rem] max-sm:p-[.7rem]">
      <Thumbnail key={asset.photos[0]?.key ?? 'none'} asset={asset} />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="text-base font-[650] text-foreground max-sm:text-[.9rem]">{asset.name}</strong>
        <span className="mt-1 block text-[.85rem] text-muted-foreground max-sm:text-[.72rem]">{asset.identifiers.length
          ? asset.identifiers.map((identifier) => schemeLabels[identifier.scheme] + ' ' + identifier.canonical).join(' · ')
          : 'No external identifier'}</span>
        <span className="mt-[.4rem] flex flex-wrap items-center gap-x-2 gap-y-[.35rem] text-[.8rem] text-muted-foreground max-sm:gap-x-[.35rem] max-sm:gap-y-[.25rem] max-sm:text-[.73rem] [&_.icon]:size-4"><Icon name="groups" />
          <span>{asset.groups.map((group) => group.name).join(', ')}</span>
          <span className="context-divider">·</span>
          <span>Reported by <ReporterAttribution reporter={asset.reportedBy} /></span>
          {detail === 'reportedAt' && <><span className="context-divider">·</span>
            <time dateTime={asset.reportedAt}>{displayDate(asset.reportedAt)}</time></>}
        </span>
      </div>
      <Badge variant={asset.isPublic ? 'default' : 'secondary'}
        className="gap-[.6rem] max-sm:col-start-2 max-sm:justify-self-start max-sm:text-[.67rem] [&_.icon]:size-4">
        <Icon name={asset.isPublic ? 'globe' : 'lock'} />{asset.isPublic ? 'Public' : 'Group access'}</Badge>
    </Link>
  </li>;
}

function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const photo = asset.photos[0];
  return <div className="grid h-[76px] w-[94px] place-items-center overflow-hidden rounded bg-muted text-muted-foreground max-sm:row-span-2 max-sm:size-[66px] max-sm:self-start [&>span>.icon]:size-[1.6rem]">{photo && !failed
    ? <img src={assetPhotoPath(asset.id, photo.key)} className="size-full object-contain"
      alt={'Photo of ' + asset.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span title={failed ? 'Photo unavailable' : 'No photo'}><Icon name="photo" />
      <span className="sr-only">{failed ? 'Photo unavailable' : 'No photo'}</span></span>}</div>;
}
