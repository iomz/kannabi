import { Link, useFetcher } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { displayInstant } from '../../server/settings.js';
import { api, unwrap } from '../api';
import { assetPath, assetPhotoPath } from '../../shared/asset-uri';
import { ReporterAttribution } from '../reporter-attribution';
import { publicShellHandle } from '../anonymous-shell';
import { AssetUri } from '../asset-uri';
import { Switch } from '../switch';
import { Icon } from '../icon';
import { PhotoDeleteConfirmation } from '../photo-delete-confirmation';
import { TransientSuccess } from '../transient-success';
import type { Route } from './+types/asset';

export const handle = publicShellHandle;

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const id = params.id;
  const [response, account] = await Promise.all([
    api.assets[':id'].$get({ param: { id } }),
    unwrap(await api.me.$get()),
  ]);
  if (!response.ok) throw new Response('Asset not found or access unavailable.', { status: response.status });
  const result = await response.json();
  if (!('asset' in result)) throw new Response('Asset not found.', { status: 404 });
  const { settings } = await unwrap(await api.settings.$get());
  return { ...result, settings, authenticated: account.user !== null,
    assetUri: new URL(assetPath(result.asset.id), request.url).toString() };
}
export async function clientAction({ params, request }: Route.ClientActionArgs) {
  const data = await request.formData();
  const intent = data.get('intent');
  const kind = intent === 'photo' ? 'photo' as const : intent === 'delete-photo' ? 'delete-photo' as const : 'edit' as const;
  const requestedPhotoKey = kind === 'delete-photo' ? String(data.get('photoKey') ?? '') : null;
  try {
    const id = params.id;
    if (kind === 'photo') {
      const form = new FormData();
      const photo = data.get('photo');
      if (!(photo instanceof File)) throw new Error('Select a photo');
      form.set('photo', photo);
      const result = await unwrap<{ asset: { photos: Array<{ key: string }> } }>(
        await fetch('/api/assets/' + id + '/photos', { method: 'POST', body: form }));
      return { kind, saved: true as const, error: null, photoKey: result.asset.photos.at(-1)?.key ?? null };
    }
    if (kind === 'delete-photo') {
      await unwrap(await api.assets[':id'].photos[':key'].$delete({ param: { id, key: requestedPhotoKey! } }));
      return { kind, saved: true as const, error: null, photoKey: requestedPhotoKey };
    }
    await unwrap(await api.assets[':id'].$patch({ param: { id }, json: {
      name: String(data.get('name') ?? ''), isPublic: data.get('isPublic') === 'on',
    } }));
    return { kind, saved: true as const, error: null, photoKey: null };
  } catch (error) {
    return { kind, saved: false as const,
      error: error instanceof Error ? error.message : kind === 'photo' ? 'Upload failed' : kind === 'delete-photo' ? 'Delete failed' : 'Update failed',
      photoKey: requestedPhotoKey };
  }
}
export default function AssetPage({ loaderData: { asset, canEdit, settings, authenticated, assetUri } }: Route.ComponentProps) {
  const upload = useFetcher<typeof clientAction>();
  const edit = useFetcher<typeof clientAction>();
  const deletePhoto = useFetcher<typeof clientAction>();
  const [photoToDelete, setPhotoToDelete] = useState<string | null>(null);
  const uploadForm = useRef<HTMLFormElement>(null);
  const uploadResult = upload.data?.kind === 'photo' ? upload.data : null;
  const editResult = edit.data?.kind === 'edit' ? edit.data : null;
  const deleteResult = deletePhoto.data?.kind === 'delete-photo' ? deletePhoto.data : null;
  const uploadBusy = upload.state !== 'idle';
  const editBusy = edit.state !== 'idle';
  const deleteBusy = deletePhoto.state !== 'idle';
  useEffect(() => {
    if (uploadResult?.saved) uploadForm.current?.reset();
  }, [uploadResult]);
  useEffect(() => {
    if (deleteResult?.saved) setPhotoToDelete(null);
  }, [deleteResult]);
  return <>
    {authenticated && <Link to="/" className="back-link">← Assets</Link>}<div className="page-heading"><div><p className="eyebrow">Asset</p><h1>{asset.name}</h1></div>
      {authenticated ? <span className={'badge ' + (asset.isPublic ? 'public' : '')}>{asset.isPublic ? 'Public' : 'Group access'}</span>
        : <Link to="/signin" className="button">Sign in</Link>}</div>
    <section className="panel"><h2>Asset identity</h2><dl>
      <dt>Asset ID</dt><dd><code>{asset.id}</code></dd>
      <dt>Scheme</dt><dd>{asset.identifier.scheme.toUpperCase()}</dd>
      {asset.identifier.scheme === 'sgtin' ? <><dt>GTIN</dt><dd>{asset.identifier.gtin}</dd>
        <dt>Serial</dt><dd>{asset.identifier.serial}</dd></> : <><dt>GRAI</dt><dd>{asset.identifier.grai}</dd></>}
      <dt>Visibility</dt><dd>{asset.isPublic ? 'Public — read access' : 'Private — Group access'}</dd>
      <dt>Owner</dt><dd>{asset.owner?.name ?? 'Not specified'}</dd>
      <dt>Collaboration Groups</dt><dd>{asset.groups.map((g) => g.name).join(', ')}</dd>
      <dt>Reported by</dt><dd><ReporterAttribution reporter={asset.reportedBy} /></dd>
      <dt>Reported at</dt><dd><time dateTime={asset.reportedAt}>{displayInstant(asset.reportedAt, settings.displayTimezone)}</time> ({settings.displayTimezone})</dd>
    </dl><AssetUri uri={assetUri} /></section>
    <section className="panel"><h2>Photos</h2>
      {!asset.photos.length && <p>No photos yet.</p>}
      <div className="photos">{asset.photos.map((photo, index) => <div key={photo.key}
        className={'photo-item' + (uploadResult?.saved && uploadResult.photoKey === photo.key ? ' newly-uploaded' : '')}>
        <img src={assetPhotoPath(asset.id, photo.key)} alt={'Photo of ' + asset.name} />
        {canEdit && <button type="button" className="photo-delete" disabled={deleteBusy}
          aria-label={'Delete photo ' + (index + 1)} onClick={() => setPhotoToDelete(photo.key)}>
          <Icon name="trash" />
        </button>}
      </div>)}</div>
      {canEdit && <>
        <div className="asset-photo-status" role="status" aria-live="polite" aria-atomic="true">
          <TransientSuccess trigger={deleteResult?.saved ? deleteResult.photoKey : null} label="Deleted" />
        </div>
        <upload.Form ref={uploadForm} method="post" encType="multipart/form-data">
        <fieldset disabled={uploadBusy} aria-busy={uploadBusy}>
          <input type="hidden" name="intent" value="photo" />
          <label>Add photo<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required /></label>
          <p className="hint">JPEG, PNG, or WebP, up to 10 MiB.</p>
          {uploadResult?.error && <p role="alert">{uploadResult.error}</p>}
          <div className="asset-action-row"><button>{uploadBusy ? 'Uploading…' : 'Upload photo'}</button>
            <div className="asset-action-status" role="status" aria-live="polite" aria-atomic="true">
              <TransientSuccess trigger={uploadResult?.saved ? uploadResult.photoKey : null} label="Uploaded" />
            </div>
          </div>
        </fieldset>
      </upload.Form>
      </>}
    </section>
    {canEdit && <PhotoDeleteConfirmation open={photoToDelete !== null} busy={deleteBusy}
      error={deleteResult?.error && deleteResult.photoKey === photoToDelete ? deleteResult.error : null}
      onClose={() => setPhotoToDelete(null)} onConfirm={() => {
        if (photoToDelete) deletePhoto.submit({ intent: 'delete-photo', photoKey: photoToDelete }, { method: 'post' });
      }} />}
    {canEdit && <section className="panel"><h2>Edit Asset</h2>
      <edit.Form method="post" key={JSON.stringify([asset.name, asset.isPublic])}>
        <fieldset disabled={editBusy} aria-busy={editBusy}>
          <input type="hidden" name="intent" value="edit" />
          <label>Asset name<input name="name" defaultValue={asset.name} required /></label>
          <Switch name="isPublic" defaultChecked={asset.isPublic} label="Public access" />
          <p className="hint">Anyone with access to this public page can view the information exposed here. Only Group members can edit.</p>
          {editResult?.error && <p role="alert">{editResult.error}</p>}
          <div className="asset-action-row"><button>{editBusy ? 'Saving…' : 'Save changes'}</button>
            <div className="asset-action-status" role="status" aria-live="polite" aria-atomic="true">
              <TransientSuccess trigger={editResult?.saved ? editResult : null} label="Saved" />
            </div>
          </div>
        </fieldset>
      </edit.Form>
    </section>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
