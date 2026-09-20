import { Link, useLocation } from 'react-router';
import { useState } from 'react';
import { assetPath, assetPhotoPath } from '../shared/asset-uri';
import { schemeLabels } from '../server/gs1.js';
import type { Asset } from '../server/identity-store';
import { displayDate } from '../server/settings.js';
import { Icon } from './icon';
import { ReporterAttribution } from './reporter-attribution';

/** One Asset as it appears in any list. Shared so the inventory and identity
 * lookup present Assets identically rather than drifting into two layouts. */
export function AssetRow({ asset, detail }: { asset: Asset; detail?: 'reportedAt' }) {
  const location = useLocation();
  return <li>
    {/* Carrying the current query lets the Asset page return to the same
        inventory view rather than to a default one. */}
    <Link className="inventory-row" to={assetPath(asset.id)} state={{ from: location.search }}>
      <Thumbnail key={asset.photos[0]?.key ?? 'none'} asset={asset} />
      <div className="inventory-row-body"><strong>{asset.name}</strong>
        <span className="asset-identifier">{asset.identifiers.length
          ? asset.identifiers.map((identifier) => schemeLabels[identifier.scheme] + ' ' + identifier.canonical).join(' · ')
          : 'No external identifier'}</span>
        <span className="asset-context"><Icon name="groups" />
          <span>{asset.groups.map((group) => group.name).join(', ')}</span>
          <span className="context-divider">·</span>
          <span>Reported by <ReporterAttribution reporter={asset.reportedBy} /></span>
          {detail === 'reportedAt' && <><span className="context-divider">·</span>
            <time dateTime={asset.reportedAt}>{displayDate(asset.reportedAt)}</time></>}
        </span>
      </div>
      <span className={'badge ' + (asset.isPublic ? 'public' : '')}>
        <Icon name={asset.isPublic ? 'globe' : 'lock'} />{asset.isPublic ? 'Public' : 'Group access'}</span>
    </Link>
  </li>;
}

function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const photo = asset.photos[0];
  return <div className="asset-thumbnail">{photo && !failed
    ? <img src={assetPhotoPath(asset.id, photo.key)}
      alt={'Photo of ' + asset.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <span title={failed ? 'Photo unavailable' : 'No photo'}><Icon name="photo" />
      <span className="sr-only">{failed ? 'Photo unavailable' : 'No photo'}</span></span>}</div>;
}
