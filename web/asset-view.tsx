import { Link, redirect, useFetcher, useLocation } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { displayInstant } from '../server/settings.js';
import { api, unwrap } from './api';
import { assetPath, assetPhotoPath } from '../shared/asset-uri';
import { assetId } from '../server/asset-id.js';
import { digitalLinkPath } from '../server/gs1-digital-link.js';
import { surfacedAssetPath, surfacedTransition, type SurfaceableIdentifier } from '../server/surfaced-uri.js';
import { ReporterAttribution } from './reporter-attribution';
import { publicShellHandle } from './anonymous-shell';
import { AssetUri } from './asset-uri';
import { AssetCollaboration } from './asset-collaboration';
import { Switch } from './switch';
import { Icon } from './icon';
import { PhotoDeleteConfirmation } from './photo-delete-confirmation';
import { notify } from './notify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, Field, Hint, PageHeading, Panel } from './ui';
import { IdentifierForm, IdentifierList, IssueIdentifier } from './asset-identifiers';


export async function loadAsset(id: string, request: Request) {
  const [response, account] = await Promise.all([
    api.assets[':id'].$get({ param: { id } }),
    unwrap(await api.me.$get()),
  ]);
  // Display only: the server re-checks the Group join on every issuance.
  const { namespaces } = account.user
    ? await unwrap(await api['gs1-namespaces'].$get()) : { namespaces: [] };
  if (!response.ok) throw new Response('Asset not found or access unavailable.', { status: response.status });
  const result = await response.json();
  if (!('asset' in result)) throw new Response('Asset not found.', { status: 404 });
  const { settings } = await unwrap(await api.settings.$get());
  const groupKeys = new Set(result.asset.groups.map((group) => group.key));
  const [{ groups: memberships }, { groups: controlled }] = account.user
    ? await Promise.all([api.groups.$get().then(unwrap), api.groups.controlled.$get().then(unwrap)])
    : [{ groups: [] }, { groups: [] }];
  const canGrant = memberships.some((g) => groupKeys.has(g.key) && controlled.some((c) => c.key === g.key));
  const absolute = (path: string) => new URL(path, request.url).toString();
  // A Digital Link URI is shown only where Kannabi also answers it, so a
  // class-level identifier gets none: `/01/{gtin}` is constructible and valid,
  // and Kannabi does not dereference it (#50).
  const digitalLinks = Object.fromEntries(result.asset.identifiers
    .filter((identifier) => identifier.level === 'individual')
    .map((identifier) => [identifier.key, absolute(digitalLinkPath(identifier))]));
  // Only namespaces this Asset's Groups manage, and only active ones. The
  // server re-checks the Group join and the active state on every issuance;
  // this narrows what is offered, never what is permitted.
  const eligible = namespaces.filter((namespace) =>
    namespace.active && namespace.group && groupKeys.has(namespace.group.key));
  // The class keys those namespaces manage, flattened with the prefix each
  // belongs to, so a serialised GRAI or an SGTIN can name the one it is
  // issued under. Inactive class keys are left out for the same reason
  // inactive namespaces are.
  const classKeys = (await Promise.all(eligible.map(async (namespace) => {
    const { classKeys: managed } = await unwrap(
      await api['gs1-namespaces'][':key']['class-keys'].$get({
        param: { key: namespace.key }, query: { scheme: undefined } }));
    return managed.filter((classKey) => classKey.active).map((classKey) => ({
      key: classKey.key, namespaceKey: namespace.key, gcp: namespace.gcp,
      scheme: classKey.scheme, canonical: classKey.canonical,
    }));
  }))).flat();
  return { ...result, settings, authenticated: account.user !== null,
    controlled, canGrant,
    namespaces: eligible,
    classKeys,
    digitalLinks,
    // The native URI is always present and always valid. The surfaced one is
    // what Kannabi puts in front of a person, and is the native URI again when
    // the Asset has no eligible Digital Link identity.
    nativeUri: absolute(assetPath(result.asset.id)),
    surfacedUri: absolute(surfacedAssetPath(result.asset.id, result.asset.identifiers)) };
}
/** Fields every submission carries to route and address itself, which are
 * never part of the payload any API is given. */
const submissionFields = new Set(['intent', 'assetId', 'at']);

/** An Asset as a mutation response returns it, which is all a transition needs. */
type MutatedAsset = { id: string; identifiers: readonly SurfaceableIdentifier[] };

/** Leave an address that no longer serves this Asset.
 *
 * An identifier mutation can retire the very address the viewer is standing
 * on — detaching the GIAI whose Digital Link they navigated to — and can give
 * an Asset viewed at its native URI a Digital Link the server would now
 * redirect that URI to. Either way the page they are on is no longer where
 * the Asset is served, so it is recomputed and navigated to.
 *
 * A viewer at a valid non-preferred Digital Link stays. That address still
 * serves the Asset, and moving them to the preferred one would do by
 * navigation what resolution is deliberately forbidden to do by redirect.
 *
 * The acknowledgement is raised here rather than by the component's effect,
 * because an action that redirects returns the fetcher no data to react to.
 */
function transition(asset: MutatedAsset, message: string, at: string) {
  const target = surfacedTransition(at, asset.id, asset.identifiers);
  if (!target) return null;
  notify(message);
  return redirect(target);
}

export async function submitAsset(request: Request) {
  const data = await request.formData();
  // The Asset's own identity, carried by the submission. Never taken from
  // the address: a Digital Link path is a presentation address, and React
  // Router re-encodes a form's action URL, so `%2F` inside a serial arrives
  // as `%252F` and would resolve to a different identifier or to none. The
  // native id is what every Asset-scoped API call is addressed by.
  const id = assetId(data.get('assetId'));
  // Where the viewer is standing, from the router's location rather than
  // from that same re-encoded URL.
  const at = String(data.get('at') ?? '');
  const intent = data.get('intent');
  if (intent === 'grant-collaboration' || intent === 'revoke-collaboration') {
    try {
      const param = { id, groupKey: String(data.get('groupKey') ?? '') };
      const endpoint = api.assets[':id'].collaboration[':groupKey'];
      await unwrap(intent === 'grant-collaboration' ? await endpoint.$put({ param }) : await endpoint.$delete({ param }));
      const response = await api.assets[':id'].$get({ param: { id } });
      if (response.status === 404) return redirect('/');
      return { kind: 'collaboration' as const, saved: true as const, error: null, photoKey: null };
    } catch (error) {
      return { kind: 'collaboration' as const, saved: false as const,
        error: error instanceof Error ? error.message : 'Collaboration change failed', photoKey: null };
    }
  }
  const kind = intent === 'photo' ? 'photo' as const
    : intent === 'delete-photo' ? 'delete-photo' as const
      : intent === 'attach-identifier' ? 'attach-identifier' as const
        : intent === 'detach-identifier' ? 'detach-identifier' as const
          : intent === 'issue-identifier' ? 'issue-identifier' as const : 'edit' as const;
  const requestedPhotoKey = kind === 'delete-photo' ? String(data.get('photoKey') ?? '') : null;
  try {
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
      // Only the scheme's own fields reach the GS1 boundary. The intent and
      // the identity this submission carries are how the form was routed,
      // not part of the identifier, and that boundary rejects what it does
      // not recognise.
      const identifier = Object.fromEntries([...data.entries()]
        .filter(([field, value]) => !submissionFields.has(field) && typeof value === 'string' && value !== '')
        .map(([field, value]) => [field, String(value)]));
      const { asset } = await unwrap<{ asset: MutatedAsset }>(
        await api.assets[':id'].identifiers.$post({ param: { id }, json: identifier }));
      return transition(asset, 'Identifier recorded', at)
        ?? { kind, saved: true as const, error: null, photoKey: null };
    }
    if (kind === 'detach-identifier') {
      const { asset } = await unwrap<{ asset: MutatedAsset }>(
        await api.assets[':id'].identifiers[':key'].$delete({
          param: { id, key: String(data.get('identifierKey') ?? '') } }));
      return transition(asset, 'Identifier detached', at)
        ?? { kind, saved: true as const, error: null, photoKey: null };
    }
    if (kind === 'issue-identifier') {
      // One route per scheme, because the three take different inputs: a GIAI
      // names only a namespace, while a serialised GRAI and an SGTIN each name
      // the managed class key they are issued under.
      const scheme = String(data.get('scheme') ?? 'giai');
      const namespaceKey = String(data.get('namespaceKey') ?? '');
      const classKeyKey = String(data.get('classKeyKey') ?? '');
      const { asset } = await unwrap<{ asset: MutatedAsset }>(
        scheme === 'grai'
          ? await api.assets[':id'].grai.$post({ param: { id }, json: { namespaceKey, classKeyKey } })
          : scheme === 'sgtin'
            ? await api.assets[':id'].sgtin.$post({ param: { id }, json: { namespaceKey, classKeyKey } })
            : await api.assets[':id'].giai.$post({ param: { id }, json: { namespaceKey } }));
      return transition(asset, 'Identifier issued', at)
        ?? { kind, saved: true as const, error: null, photoKey: null };
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
                : kind === 'issue-identifier' ? 'Identifier could not be issued' : 'Update failed',
      photoKey: requestedPhotoKey };
  }
}
export type AssetViewData = Awaited<ReturnType<typeof loadAsset>>;

export function AssetView({ asset, canEdit, canViewReporterProfile, settings, authenticated,
  nativeUri, surfacedUri, digitalLinks, namespaces, classKeys, controlled, canGrant }: AssetViewData) {
  const collaboration = useFetcher<typeof submitAsset>();
  const upload = useFetcher<typeof submitAsset>();
  const edit = useFetcher<typeof submitAsset>();
  const deletePhoto = useFetcher<typeof submitAsset>();
  const identifiers = useFetcher<typeof submitAsset>();
  // The row passes the complete location it was shown in, so going back returns
  // to that view — the inventory query, or the lookup that resolved this Asset.
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const back = from?.startsWith('/') ? from : '/';
  /** What every mutation carries with it.
   *
   * The Asset's own identity, because the address a form posts to is a
   * presentation address: React Router re-encodes it, so a Digital Link
   * carrying `%2F` in a serial arrives at the action as `%252F`. Identity
   * must not depend on that, and the page already knows it.
   *
   * And the address the viewer is standing on, taken from the router's
   * location, which is faithful — so a surfaced-URI transition still knows
   * whether the current page is one that still serves this Asset. */
  const identity = { assetId: asset.id, at: location.pathname };
  const identityFields = <>
    <input type="hidden" name="assetId" value={identity.assetId} />
    <input type="hidden" name="at" value={identity.at} />
  </>;
  const issue = useFetcher<typeof submitAsset>();
  const [photoToDelete, setPhotoToDelete] = useState<string | null>(null);
  const uploadForm = useRef<HTMLFormElement>(null);
  const uploadResult = upload.data?.kind === 'photo' ? upload.data : null;
  const editResult = edit.data?.kind === 'edit' ? edit.data : null;
  const deleteResult = deletePhoto.data?.kind === 'delete-photo' ? deletePhoto.data : null;
  const identifierResult = identifiers.data?.kind === 'attach-identifier'
    || identifiers.data?.kind === 'detach-identifier' ? identifiers.data : null;
  const identifierBusy = identifiers.state !== 'idle';
  const issueResult = issue.data?.kind === 'issue-identifier' ? issue.data : null;
  const issueBusy = issue.state !== 'idle';
  const uploadBusy = upload.state !== 'idle';
  const editBusy = edit.state !== 'idle';
  const deleteBusy = deletePhoto.state !== 'idle';
  useEffect(() => {
    if (uploadResult?.saved) { uploadForm.current?.reset(); notify('Photo uploaded'); }
  }, [uploadResult]);
  useEffect(() => {
    if (editResult?.saved) notify('Asset changes saved');
  }, [editResult]);
  useEffect(() => {
    // The photo has left the grid and the dialog that asked has closed, so
    // there is nothing left on screen to put the confirmation beside.
    if (deleteResult?.saved) { setPhotoToDelete(null); notify('Photo deleted'); }
  }, [deleteResult]);
  useEffect(() => {
    if (identifiers.data?.kind === 'attach-identifier' && identifiers.data.saved) notify('Identifier recorded');
    if (identifiers.data?.kind === 'detach-identifier' && identifiers.data.saved) notify('Identifier detached');
  }, [identifiers.data]);
  useEffect(() => {
    if (issueResult?.saved) notify('Identifier issued');
  }, [issueResult]);
  useEffect(() => {
    if (collaboration.data?.saved) notify('Collaboration updated');
  }, [collaboration.data]);
  return <>
    {authenticated && <Link to={back} className="mb-6 inline-block text-[.85rem]">{back.startsWith('/lookup') ? '← Lookup' : '← Assets'}</Link>}
    <PageHeading eyebrow="Asset" title={asset.name}>
      {authenticated ? <Badge variant={asset.isPublic ? 'brand' : 'secondary'}>{asset.isPublic ? 'Public' : 'Group access'}</Badge>
        : <Button render={<Link to="/signin" />}>Sign in</Button>}
    </PageHeading>
    <Panel><h2>Asset identity</h2><dl className="grid grid-cols-[11rem_1fr] gap-[.8rem] text-[.9rem] [&_dt]:text-muted-foreground max-sm:grid-cols-1 max-sm:gap-[.2rem_0]">
      {settings.showAssetId && <><dt>Kannabi ID</dt><dd><code>{asset.id}</code></dd></>}
      <dt>Visibility</dt><dd>{asset.isPublic ? 'Public — read access' : 'Private — Group access'}</dd>
      <dt>Owner</dt><dd>{asset.owner?.name ?? 'Not specified'}</dd>
      <dt>Collaboration Groups</dt><dd>{asset.groups.map((g) => g.name).join(', ')}</dd>
      <dt>Reported by</dt><dd><ReporterAttribution reporter={asset.reportedBy}
        link={canViewReporterProfile} /></dd>
      <dt>Reported at</dt><dd><time dateTime={asset.reportedAt}>{displayInstant(asset.reportedAt, settings.displayTimezone)}</time> ({settings.displayTimezone})</dd>
    </dl><AssetUri surfacedUri={surfacedUri} nativeUri={nativeUri}
      showNativeUri={settings.showAssetId} /></Panel>
    <AssetCollaboration groups={asset.groups} controlled={controlled} canEdit={canEdit} canGrant={canGrant}
      busy={collaboration.state !== 'idle'} error={collaboration.data?.error ?? null}
      onChange={(groupKey, grant) => collaboration.submit({ ...identity, groupKey,
        intent: grant ? 'grant-collaboration' : 'revoke-collaboration' }, { method: 'post' })} />
    <Panel><h2>Identifiers</h2>
      <IdentifierList identifiers={asset.identifiers} issuances={asset.issuances}
        digitalLinks={digitalLinks}
        showPolicyVersion={settings.showIdentifierPolicyVersion} canEdit={canEdit} busy={identifierBusy}
        onDetach={(key) => identifiers.submit({ ...identity, intent: 'detach-identifier', identifierKey: key },
          { method: 'post' })} />
      {canEdit && <issue.Form method="post" className="mb-6"
        key={asset.issuances.map((issuance) => issuance.key).join()}>
        {identityFields}
        <IssueIdentifier namespaces={namespaces} classKeys={classKeys}
          issuances={asset.issuances} identifiers={asset.identifiers}
          busy={issueBusy} error={issueResult?.error ?? null} />
      </issue.Form>}
      {canEdit && <identifiers.Form method="post" key={asset.identifiers.map((i) => i.key).join()}>
        {identityFields}
        <IdentifierForm busy={identifierBusy}
          error={identifierResult?.error ?? null} />
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
        {identityFields}
        <fieldset disabled={uploadBusy} aria-busy={uploadBusy}>
          <input type="hidden" name="intent" value="photo" />
          <Field label="Add photo" hint="JPEG, PNG, or WebP, up to 10 MiB.">
            <Input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required /></Field>
          {uploadResult?.error && <p role="alert">{uploadResult.error}</p>}
          <ActionRow><Button type="submit">{uploadBusy ? 'Uploading…' : 'Upload photo'}</Button></ActionRow>
        </fieldset>
      </upload.Form>
      </>}
    </Panel>
    {canEdit && <PhotoDeleteConfirmation open={photoToDelete !== null} busy={deleteBusy}
      error={deleteResult?.error && deleteResult.photoKey === photoToDelete ? deleteResult.error : null}
      onClose={() => setPhotoToDelete(null)} onConfirm={() => {
        if (photoToDelete) {
          deletePhoto.submit({ ...identity, intent: 'delete-photo', photoKey: photoToDelete }, { method: 'post' });
        }
      }} />}
    {canEdit && <Panel><h2>Edit Asset</h2>
      <edit.Form method="post" key={JSON.stringify([asset.name, asset.isPublic])}>
        {identityFields}
        <fieldset disabled={editBusy} aria-busy={editBusy}>
          <input type="hidden" name="intent" value="edit" />
          <Field label="Asset name"><Input name="name" defaultValue={asset.name} required /></Field>
          <Switch name="isPublic" defaultChecked={asset.isPublic} label="Public access" />
          <Hint className="mb-4">Anyone with access to this public page can view the information exposed here. Only Group members can edit.</Hint>
          {editResult?.error && <p role="alert">{editResult.error}</p>}
          <ActionRow><Button type="submit">{editBusy ? 'Saving…' : 'Save changes'}</Button></ActionRow>
        </fieldset>
      </edit.Form>
    </Panel>}
  </>;
}

