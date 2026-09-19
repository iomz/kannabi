import { Form, redirect, useNavigation } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { api, unwrap } from '../api';
import { DestructiveConfirmation } from '../destructive-confirmation';
import { displayInstant } from '../../server/settings';
import { filterMembers } from '../member-filter';
import { memberAccessLabel } from '../member-access';
import { TransientSuccess } from '../transient-success';
import type { Member } from '../../server/identity-store';
import type { Route } from './+types/members';

type MemberAction = { intent: string; key: string | null; saved: boolean; message?: string; error: string | null };

export async function clientLoader() {
  const response = await api.members.$get();
  if (response.status === 401) throw redirect('/signin');
  if (response.status === 403) throw new Response('Administrator access required.', { status: 403 });
  const [{ members }, { settings }, account] = await Promise.all([
    unwrap(response), unwrap(await api.settings.$get()), unwrap(await api.me.$get()),
  ]);
  return { members, settings, actorKey: account.user?.key ?? null };
}

export async function clientAction({ request }: Route.ClientActionArgs): Promise<MemberAction> {
  const data = await request.formData();
  const intent = String(data.get('intent') ?? '');
  const key = data.get('key') ? String(data.get('key')) : null;
  try {
    if (intent === 'create') {
      await unwrap(await api.members.$post({ json: { name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''), isAdmin: data.get('isAdmin') === 'on' } }));
      return { intent, key: null, saved: true, message: 'Member created and setup email requested.', error: null };
    }
    if (!key) throw new Error('Member is required');
    if (intent === 'identity') {
      await unwrap(await api.members[':key'].$patch({ param: { key }, json: {
        name: String(data.get('name') ?? ''), email: String(data.get('email') ?? ''),
      } }));
      return { intent, key, saved: true, message: 'Member saved.', error: null };
    }
    if (intent === 'role') {
      await unwrap(await api.members[':key'].role.$patch({ param: { key }, json: { isAdmin: data.get('isAdmin') === 'on' } }));
      return { intent, key, saved: true, message: 'Role saved.', error: null };
    }
    if (intent === 'recovery') {
      await unwrap(await api.members[':key'].recovery.$post({ param: { key } }));
      return { intent, key, saved: true, message: 'Email requested.', error: null };
    }
    if (intent === 'delete') {
      await unwrap(await api.members[':key'].$delete({ param: { key } }));
      return { intent, key, saved: true, message: 'Member deleted.', error: null };
    }
    throw new Error('Unsupported member action');
  } catch (error) {
    return { intent, key, saved: false, error: error instanceof Error ? error.message : 'Member action failed' };
  }
}

function Feedback({ actionData, intent, memberKey }: { actionData?: MemberAction; intent: string; memberKey: string | null }) {
  if (actionData?.intent !== intent || actionData.key !== memberKey) return <div className="member-action-status" />;
  return <div className="member-action-status" aria-live="polite">{actionData.saved
    ? <TransientSuccess trigger={actionData} label={actionData.message ?? 'Saved'} />
    : <span className="settings-status-pill error" role="alert">{actionData.error}</span>}</div>;
}

function AccessBadge({ member }: { member: Member }) {
  return <span className={'badge member-access' + (member.credentialState === 'established' ? ' established' : '')}>
    {memberAccessLabel(member.credentialState)}</span>;
}

function CreateMemberDialog({ actionData, onDismiss }: { actionData?: MemberAction; onDismiss(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useNavigation().state !== 'idle';
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus(); }, []);
  useEffect(() => { if (actionData?.intent === 'create' && actionData.saved) dialog.current?.close(); }, [actionData]);
  return <dialog ref={dialog} className="member-dialog" aria-labelledby="create-member-title" onClose={onDismiss}>
    <div className="member-dialog-card"><div className="member-dialog-heading"><div><p className="eyebrow">Member account</p><h2 id="create-member-title">Create member</h2></div>
      <button type="button" className="dialog-close" aria-label="Close" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="hint">Kannabi sends a secure setup link. Administrators never handle member passwords.</p>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="create" />
        <label>Name<input name="name" required maxLength={200} autoComplete="name" /></label>
        <label>Email<input name="email" required maxLength={254} type="email" autoComplete="email" /></label>
        <label className="checkbox"><input name="isAdmin" type="checkbox" />System administrator</label>
        <div className="profile-action-row"><button>Create member</button><Feedback actionData={actionData} intent="create" memberKey={null} /></div>
      </fieldset></Form></div></dialog>;
}

function MemberDialog({ member, actorKey, actionData, onDismiss }: { member: Member; actorKey: string | null;
  actionData?: MemberAction; onDismiss(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useNavigation().state !== 'idle';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const self = member.key === actorKey;
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus(); }, []);
  return <dialog ref={dialog} className="member-dialog" aria-labelledby="member-dialog-title" onClose={onDismiss}><div className="member-dialog-card">
    <div className="member-dialog-heading"><div><p className="eyebrow">Member account</p><h2 id="member-dialog-title">Edit {member.name}</h2></div>
      <button type="button" className="dialog-close" aria-label="Close member editor" onClick={() => dialog.current?.close()}>×</button></div>
    <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="identity" /><input type="hidden" name="key" value={member.key} />
      <label>Name<input name="name" defaultValue={member.name} required maxLength={200} autoComplete="name" /></label>
      <label>Email<input name="email" defaultValue={member.email} readOnly={self} required maxLength={254} type="email" autoComplete="email" /></label>
      {self && <p className="hint">Change your own email from Profile.</p>}
      <div className="profile-action-row"><button>Save member</button><Feedback actionData={actionData} intent="identity" memberKey={member.key} /></div>
    </fieldset></Form>
    <section className="member-account-section" aria-labelledby="member-role-heading"><h3 id="member-role-heading">System role</h3>
      <p className="hint">Role changes are saved separately from name and email.</p>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="role" /><input type="hidden" name="key" value={member.key} />
        <label className="checkbox"><input name="isAdmin" type="checkbox" defaultChecked={member.isAdmin} />System administrator</label>
        <div className="profile-action-row"><button>Save role</button><Feedback actionData={actionData} intent="role" memberKey={member.key} /></div>
      </fieldset></Form></section>
    <section className="member-account-section" aria-labelledby="member-credential-heading"><h3 id="member-credential-heading">Account access</h3>
      <p><AccessBadge member={member} /></p>
      <p className="hint">{member.credentialState === 'established'
        ? 'Send a single-use link so this member can reset their own password.'
        : 'Resend the single-use link so this member can finish account setup.'}</p>
      <Form method="post"><input type="hidden" name="intent" value="recovery" /><input type="hidden" name="key" value={member.key} />
        <div className="profile-action-row"><button disabled={busy}>{member.credentialState === 'established'
          ? 'Send password reset email' : 'Resend setup email'}</button><Feedback actionData={actionData} intent="recovery" memberKey={member.key} /></div></Form></section>
    <section className="member-account-section member-danger" aria-labelledby="member-delete-heading"><h3 id="member-delete-heading">Delete member</h3>
      <p className="hint">Disables sign-in, removes personal account data and Group memberships, and preserves Asset provenance.</p>
      {self ? <p className="hint">Delete your own account from Profile.</p>
        : <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>Delete member</button>}
      <DestructiveConfirmation open={confirmDelete} onClose={() => setConfirmDelete(false)} displayName={member.name}
        email={member.email} mode="member" confirmLabel="Delete member" fields={{ intent: 'delete', key: member.key }} busy={busy}
        error={actionData?.intent === 'delete' && actionData.key === member.key ? actionData.error : undefined} />
    </section>
  </div></dialog>;
}

export default function Members({ loaderData: { members, settings, actorKey }, actionData }: Route.ComponentProps) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const matching = filterMembers(members, query);
  const selected = members.find((member) => member.key === selectedKey) ?? null;
  return <><div className="page-heading"><div><p className="eyebrow">Administration</p><h1>Members</h1><p>{members.length} active members</p></div>
    <button onClick={() => setCreating(true)}>Create member</button></div>
    <div className="member-toolbar"><label htmlFor="member-search" className="sr-only">Search members by name or email</label>
      <input id="member-search" type="search" placeholder="Search members by name or email…" value={query} onChange={(event) => setQuery(event.currentTarget.value)} autoComplete="off" />
      {query && <span aria-live="polite">{matching.length} matching</span>}</div>
    {matching.length ? <div className="member-table-frame"><table className="member-table"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Access</th><th>Role</th></tr></thead>
      <tbody>{matching.map((member) => <tr key={member.key}><td data-label="Name"><button type="button" className="member-name-button" onClick={() => setSelectedKey(member.key)}>{member.name}</button></td>
        <td data-label="Email">{member.email}</td><td data-label="Joined">{member.createdAt ? <time dateTime={member.createdAt}>{displayInstant(member.createdAt, settings.displayTimezone)}</time> : <span aria-label="Unknown">—</span>}</td>
        <td data-label="Access"><AccessBadge member={member} /></td>
        <td data-label="Role"><span className={'member-role badge' + (member.isAdmin ? ' administrator' : '')}>{member.isAdmin ? 'System administrator' : 'Member'}</span></td></tr>)}</tbody></table></div>
      : <div className="empty-state member-empty"><p>No members match “{query.trim()}”.</p></div>}
    {creating && <CreateMemberDialog actionData={actionData} onDismiss={() => setCreating(false)} />}
    {selected && <MemberDialog member={selected} actorKey={actorKey} actionData={actionData} onDismiss={() => setSelectedKey(null)} />}
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
