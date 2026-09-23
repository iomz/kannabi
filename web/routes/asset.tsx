import { Link, useFetcher, useLocation } from 'react-router';
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
import { notify } from '../notify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, ActionStatus, Field, Hint, PageHeading, Panel } from '../ui';
import { AllocateGiai, IdentifierForm, IdentifierList } from '../asset-identifiers';
import type { Route } from './+types/asset';

export const handle = publicShellHandle;

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const id = params.id;
  const [response, account] = await Promise.all([
    api.assets[':id'].$get({ param: { id } }),
    unwrap(await api.me.$get()),
  ]);
  // Display only: the server re-checks the Group join on every allocation.
  const { namespaces } = account.user
    ? await unwrap(await api['giai-namespaces'].$get()) : { namespaces: [] };
  if (!response.ok) throw new Response('Asset not found or access unavailable.', { status: response.status });
  const result = await response.json();
  if (!('asset' in result)) throw new Response('Asset not found.', { status: 404 });
  const { settings } = await unwrap(await api.settings.$get());
  const groupKeys = new Set(result.asset.groups.map((group) => group.key));
  return { ...result, settings, authenticated: account.user !== null,
    namespaces: namespaces.filter((namespace) =>
      namespace.active && namespace.group && groupKeys.has(namespace.group.key)),
    assetUri: new URL(assetPath(result.asset.id), request.url).toString() };
}
export async function clientAction({ params, request }: Route.ClientActionArgs) {
  const data = await request.formData();
  const intent = data.get('intent');
  const kind = intent === 'photo' ? 'photo' as const
    : intent === 'delete-photo' ? 'delete-photo' as const
      : intent === 'attach-identifier' ? 'attach-identifier' as const
        : intent === 'detach-identifier' ? 'detach-identifier' as const
          : intent === 'allocate-giai' ? 'allocate-giai' as const : 'edit' as const;
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
    if (kind === 'attach-identifier') {
      const identifier = Object.fromEntries([...data.entries()]
        .filter(([field, value]) => field !== 'intent' && typeof value === 'string' && value !== '')
        .map(([field, value]) => [field, String(value)]));
      await unwrap(await api.assets[':id'].identifiers.$post({ param: { id }, json: identifier }));
      return { kind, saved: true as const, error: null, photoKey: null };
    }
    if (kind === 'detach-identifier') {
      await unwrap(await api.assets[':id'].identifiers[':key'].$delete({
        param: { id, key: String(data.get('identifierKey') ?? '') } }));
      return { kind, saved: true as const, error: null, photoKey: null };
    }
    if (kind === 'allocate-giai') {
      await unwrap(await api.assets[':id'].giai.$post({ param: { id },
        json: { namespaceKey: String(data.get('namespaceKey') ?? '') } }));
      return { kind, saved: true as const, error: null, photoKey: null };
    }
    await unwrap(await api.assets[':id'].$patch({ param: { id }, json: {
      name: String(data.get('name') ?? ''), isPublic: data.get('isPublic') === 'on',
    } }));
    return { kind, saved: true as const, error: null, photoKey: null };
  } catch (error) {
    return { kind, saved: false as const,
      error: error instanceof Error ? error.message
        : kind === 'photo' ? 'Upload failed'
          : kind === 'delete-photo' ? 'Delete failed'
            : kind === 'attach-identifier' ? 'Identifier could not be added'
              : kind === 'detach-identifier' ? 'Identifier could not be detached'
                : kind === 'allocate-giai' ? 'GIAI could not be allocated' : 'Update failed',
      photoKey: requestedPhotoKey };
  }
}
export default function AssetPage({ loaderData: { asset, canEdit, settings, authenticated, assetUri, namespaces } }: Route.ComponentProps) {
  const upload = useFetcher<typeof clientAction>();
  const edit = useFetcher<typeof clientAction>();
  const deletePhoto = useFetcher<typeof clientAction>();
  const identifiers = useFetcher<typeof clientAction>();
  // The row passes the complete location it was shown in, so going back returns
  // to that view — the inventory query, or the lookup that resolved this Asset.
  const from = (useLocation().state as { from?: string } | null)?.from;
  const back = from?.startsWith('/') ? from : '/';
  const allocate = useFetcher<typeof clientAction>();
  const [photoToDelete, setPhotoToDelete] = useState<string | null>(null);
  const uploadForm = useRef<HTMLFormElement>(null);
  const uploadResult = upload.data?.kind === 'photo' ? upload.data : null;
  const editResult = edit.data?.kind === 'edit' ? edit.data : null;
  const deleteResult = deletePhoto.data?.kind === 'delete-photo' ? deletePhoto.data : null;
  const identifierResult = identifiers.data?.kind === 'attach-identifier'
    || identifiers.data?.kind === 'detach-identifier' ? identifiers.data : null;
  const identifierBusy = identifiers.state !== 'idle';
  const allocateResult = allocate.data?.kind === 'allocate-giai' ? allocate.data : null;
  const allocateBusy = allocate.state !== 'idle';
  const uploadBusy = upload.state !== 'idle';
  const editBusy = edit.state !== 'idle';
  const deleteBusy = deletePhoto.state !== 'idle';
  useEffect(() => {
    if (uploadResult?.saved) uploadForm.current?.reset();
  }, [uploadResult]);
  useEffect(() => {
    // The photo has left the grid and the dialog that asked has closed, so
    // there is nothing left on screen to put the confirmation beside.
    if (deleteResult?.saved) { setPhotoToDelete(null); notify('Photo deleted'); }
  }, [deleteResult]);
  useEffect(() => {
    // Likewise a detached identifier: the row it named is no longer there.
    if (identifiers.data?.kind === 'detach-identifier' && identifiers.data.saved) notify('Identifier detached');
  }, [identifiers.data]);
  return <>
    {authenticated && <Link to={back} className="mb-6 inline-block text-[.85rem]">{back.startsWith('/lookup') ? '← Lookup' : '← Assets'}</Link>}
    <PageHeading eyebrow="Asset" title={asset.name}>
      {authenticated ? <Badge variant={asset.isPublic ? 'default' : 'secondary'}>{asset.isPublic ? 'Public' : 'Group access'}</Badge>
        : <Button render={<Link to="/signin" />}>Sign in</Button>}
    </PageHeading>
    <Panel><h2>Asset identity</h2><dl className="grid grid-cols-[11rem_1fr] gap-[.8rem] text-[.9rem] [&_dt]:text-muted-foreground max-sm:grid-cols-1 max-sm:gap-[.2rem_0]">
      <dt>Asset ID</dt><dd><code>{asset.id}</code></dd>
      <dt>Visibility</dt><dd>{asset.isPublic ? 'Public — read access' : 'Private — Group access'}</dd>
      <dt>Owner</dt><dd>{asset.owner?.name ?? 'Not specified'}</dd>
      <dt>Collaboration Groups</dt><dd>{asset.groups.map((g) => g.name).join(', ')}</dd>
      <dt>Reported by</dt><dd><ReporterAttribution reporter={asset.reportedBy} /></dd>
      <dt>Reported at</dt><dd><time dateTime={asset.reportedAt}>{displayInstant(asset.reportedAt, settings.displayTimezone)}</time> ({settings.displayTimezone})</dd>
    </dl><AssetUri uri={assetUri} /></Panel>
    <Panel><h2>External identifiers</h2>
      <IdentifierList identifiers={asset.identifiers} canEdit={canEdit} busy={identifierBusy}
        onDetach={(key) => identifiers.submit({ intent: 'detach-identifier', identifierKey: key }, { method: 'post' })} />
      {canEdit && <allocate.Form method="post" className="mb-6">
        <AllocateGiai namespaces={namespaces} allocation={asset.allocation} busy={allocateBusy}
          error={allocateResult?.error ?? null}
          saved={allocateResult?.saved ? 'allocated' : null} />
      </allocate.Form>}
      {!canEdit && asset.allocation && <p className="mt-0 mb-6 text-[.85rem] text-muted-foreground">Kannabi issued
        <code> {asset.allocation.value} </code>for this Asset.</p>}
      {canEdit && <identifiers.Form method="post" key={asset.identifiers.map((i) => i.key).join()}>
        <IdentifierForm busy={identifierBusy}
          error={identifierResult?.error ?? null}
          saved={identifierResult?.kind === 'attach-identifier' && identifierResult.saved ? 'added' : null} />
      </identifiers.Form>}
    </Panel>
    <Panel><h2>Photos</h2>
      {!asset.photos.length && <p>No photos yet.</p>}
      <div className="mb-6 flex flex-wrap gap-4">{asset.photos.map((photo, index) => <div key={photo.key}
        className={'relative w-80 max-w-full' + (uploadResult?.saved && uploadResult.photoKey === photo.key
          ? ' animate-photo-reveal motion-reduce:animate-none' : '')}>
        <img src={assetPhotoPath(asset.id, photo.key)} alt={'Photo of ' + asset.name}
          className="block h-60 w-full rounded-lg bg-background object-contain" />
        {canEdit && <Button type="button" variant="outline" size="icon-sm" disabled={deleteBusy}
          className="absolute top-[.45rem] right-[.45rem] bg-card text-destructive shadow hover:border-destructive hover:bg-destructive/10 hover:text-destructive [&_.icon]:size-4"
          aria-label={'Delete photo ' + (index + 1)} onClick={() => setPhotoToDelete(photo.key)}>
          <Icon name="trash" />
        </Button>}
      </div>)}</div>
      {canEdit && <>
        <upload.Form ref={uploadForm} method="post" encType="multipart/form-data">
        <fieldset disabled={uploadBusy} aria-busy={uploadBusy}>
          <input type="hidden" name="intent" value="photo" />
          <Field label="Add photo" hint="JPEG, PNG, or WebP, up to 10 MiB.">
            <Input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required /></Field>
          {uploadResult?.error && <p role="alert">{uploadResult.error}</p>}
          <ActionRow><Button>{uploadBusy ? 'Uploading…' : 'Upload photo'}</Button>
            <ActionStatus className="w-26">
              <TransientSuccess trigger={uploadResult?.saved ? uploadResult.photoKey : null} label="Uploaded" />
            </ActionStatus>
          </ActionRow>
        </fieldset>
      </upload.Form>
      </>}
    </Panel>
    {canEdit && <PhotoDeleteConfirmation open={photoToDelete !== null} busy={deleteBusy}
      error={deleteResult?.error && deleteResult.photoKey === photoToDelete ? deleteResult.error : null}
      onClose={() => setPhotoToDelete(null)} onConfirm={() => {
        if (photoToDelete) deletePhoto.submit({ intent: 'delete-photo', photoKey: photoToDelete }, { method: 'post' });
      }} />}
    {canEdit && <Panel><h2>Edit Asset</h2>
      <edit.Form method="post" key={JSON.stringify([asset.name, asset.isPublic])}>
        <fieldset disabled={editBusy} aria-busy={editBusy}>
          <input type="hidden" name="intent" value="edit" />
          <Field label="Asset name"><Input name="name" defaultValue={asset.name} required /></Field>
          <Switch name="isPublic" defaultChecked={asset.isPublic} label="Public access" />
          <Hint className="mb-4">Anyone with access to this public page can view the information exposed here. Only Group members can edit.</Hint>
          {editResult?.error && <p role="alert">{editResult.error}</p>}
          <ActionRow><Button>{editBusy ? 'Saving…' : 'Save changes'}</Button>
            <ActionStatus className="w-26">
              <TransientSuccess trigger={editResult?.saved ? editResult : null} label="Saved" />
            </ActionStatus>
          </ActionRow>
        </fieldset>
      </edit.Form>
    </Panel>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
