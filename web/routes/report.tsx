import { Form, Link, redirect, useNavigation } from 'react-router';
import { api, unwrap } from '../api';
import { assetPath } from '../../shared/asset-uri';
import type { Route } from './+types/report';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const [{ groups }, { settings }] = await Promise.all([api.groups.$get().then(unwrap), api.settings.$get().then(unwrap)]);
  return { groups, settings };
}
export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.formData();
  const text = (key: string) => String(data.get(key) ?? '');
  try {
    const form = new FormData();
    form.set('report', JSON.stringify({ name: text('name'), groupKey: text('groupKey') }));
    const photo = data.get('photo');
    if (photo instanceof File && photo.size) form.set('photo', photo);
    const { asset } = await unwrap(await fetch('/api/reports', { method: 'POST', body: form }));
    return redirect(assetPath(asset.id));
  } catch (error) { return { error: error instanceof Error ? error.message : 'Report failed' }; }
}
export default function Report({ loaderData: { groups, settings }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== 'idle';
  return <>
    <Link to="/" className="back-link">← Assets</Link>
    <div className="page-heading"><div><p className="eyebrow">Assets</p><h1>Report Asset</h1><p>Give an existing physical thing a place in your inventory.</p></div></div>
    {actionData?.error && <p role="alert">{actionData.error}</p>}
    {!groups.length ? <section className="panel"><h2>A reporting Group is required</h2><p>Create a Group or ask an existing member to add you.</p><Link to="/groups" className="button">Go to Groups</Link></section>
      : <section className="panel form-panel">
        <Form method="post" encType="multipart/form-data"><fieldset disabled={busy}>
          <input type="hidden" name="intent" value="report" />
          <label>Reporting Group<select name="groupKey" required defaultValue={groups.length === 1 ? groups[0].key : ''}>
            <option value="" disabled>Choose a Group</option>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select></label>
          <label>Asset name<input name="name" required /></label>
          <p className="hint">New Assets are private to the selected Group. GS1 identifiers are optional and can be added later from the Asset page.</p>
          <label>Photo{settings.requirePhoto ? " (required)" : " (optional)"}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required={settings.requirePhoto} /></label>
          <p className="hint">JPEG, PNG, or WebP, up to 10 MiB.</p>
          <button>Report Asset</button>
        </fieldset></Form>

      </section>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
