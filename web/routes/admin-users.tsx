import { Form, Link, redirect, useNavigation } from 'react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { api, unwrap } from '../api';
import { DestructiveConfirmation } from '../destructive-confirmation';
import { displayInstant } from '../../server/settings';
import { filterUsers } from '../user-filter';
import { userAccessLabel } from '../user-access';
import { TransientSuccess } from '../transient-success';
import type { UserAccount } from '../../server/identity-store';
import type { Route } from './+types/admin-users';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionRow, ActionStatus, EmptyState, Field, Hint, PageHeading, StatusPill,
  stackedTable, stackedTableFrame } from '../ui';

type UserAction = { intent: string; key: string | null; saved: boolean; message?: string; error: string | null };

export async function clientLoader() {
  const response = await api.admin.users.$get();
  if (response.status === 401) throw redirect('/signin');
  if (response.status === 403) throw new Response('Administrator access required.', { status: 403 });
  const [{ users }, { settings }, account] = await Promise.all([
    unwrap(response), unwrap(await api.settings.$get()), unwrap(await api.me.$get()),
  ]);
  return { users, settings, actorKey: account.user?.key ?? null };
}

export async function clientAction({ request }: Route.ClientActionArgs): Promise<UserAction> {
  const data = await request.formData();
  const intent = String(data.get('intent') ?? '');
  const key = data.get('key') ? String(data.get('key')) : null;
  try {
    if (intent === 'create') {
      await unwrap(await api.admin.users.$post({ json: { name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''), isAdmin: data.get('isAdmin') === 'on' } }));
      return { intent, key: null, saved: true, message: 'User created and setup email requested.', error: null };
    }
    if (!key) throw new Error('User is required');
    if (intent === 'identity') {
      await unwrap(await api.admin.users[':key'].$patch({ param: { key }, json: {
        name: String(data.get('name') ?? ''), email: String(data.get('email') ?? ''),
      } }));
      return { intent, key, saved: true, message: 'User saved.', error: null };
    }
    if (intent === 'role') {
      await unwrap(await api.admin.users[':key'].role.$patch({ param: { key }, json: { isAdmin: data.get('isAdmin') === 'on' } }));
      return { intent, key, saved: true, message: 'Role saved.', error: null };
    }
    if (intent === 'recovery') {
      await unwrap(await api.admin.users[':key'].recovery.$post({ param: { key } }));
      return { intent, key, saved: true, message: 'Email requested.', error: null };
    }
    if (intent === 'delete') {
      await unwrap(await api.admin.users[':key'].$delete({ param: { key } }));
      return { intent, key, saved: true, message: 'User deleted.', error: null };
    }
    throw new Error('Unsupported user action');
  } catch (error) {
    return { intent, key, saved: false, error: error instanceof Error ? error.message : 'User action failed' };
  }
}

function Feedback({ actionData, intent, userKey }: { actionData?: UserAction; intent: string; userKey: string | null }) {
  if (actionData?.intent !== intent || actionData.key !== userKey) return <ActionStatus />;
  return <ActionStatus>{actionData.saved
    ? <TransientSuccess trigger={actionData} label={actionData.message ?? 'Saved'} />
    : <StatusPill tone="error" role="alert">{actionData.error}</StatusPill>}</ActionStatus>;
}

function AccessBadge({ user }: { user: UserAccount }) {
  const established = user.credentialState === 'established';
  return <Badge variant="secondary"
    className={established ? 'bg-success-surface text-success-text' : undefined}>
    {userAccessLabel(user.credentialState)}</Badge>;
}

/** A section of a User account, each saved on its own. */
function AccountSection({ heading, headingId, children, danger = false }: {
  heading: string; headingId: string; children: ReactNode; danger?: boolean;
}) {
  return <section aria-labelledby={headingId}
    className={'mt-5 border-t pt-5' + (danger ? ' border-warning-border' : '')}>
    <h3 id={headingId} className="mt-0 mb-3 text-base">{heading}</h3>
    {children}
  </section>;
}

function CreateUserDialog({ actionData, onDismiss }: { actionData?: UserAction; onDismiss(): void }) {
  const busy = useNavigation().state !== 'idle';
  const created = actionData?.intent === 'create' && actionData.saved;
  useEffect(() => { if (created) onDismiss(); }, [created, onDismiss]);
  return <Dialog open onOpenChange={(next) => { if (!next) onDismiss(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Create user</DialogTitle>
        <DialogDescription>Kannabi sends a secure setup link. Administrators never handle user passwords.</DialogDescription>
      </DialogHeader>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="create" />
        <Field label="Name"><Input name="name" required maxLength={200} autoComplete="name" autoFocus /></Field>
        <Field label="Email"><Input name="email" required maxLength={254} type="email" autoComplete="email" /></Field>
        <Label className="mb-[1.15rem]"><Checkbox name="isAdmin" />System administrator</Label>
        <ActionRow><Button>Create user</Button><Feedback actionData={actionData} intent="create" userKey={null} /></ActionRow>
      </fieldset></Form>
    </DialogContent>
  </Dialog>;
}

function UserDialog({ user, actorKey, actionData, onDismiss }: { user: UserAccount; actorKey: string | null;
  actionData?: UserAction; onDismiss(): void }) {
  const busy = useNavigation().state !== 'idle';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const self = user.key === actorKey;
  return <Dialog open onOpenChange={(next) => { if (!next) onDismiss(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader className="gap-1">
        <DialogTitle className="mb-0">Edit {user.name}</DialogTitle>
      {/* The workspace page for the same person. It is a link out of User
          administration rather than part of it: nothing there is administrative,
          and opening it grants nothing this dialog did not already have. */}
        <Link to={`/users/${user.key}`} className="text-sm">View workspace profile →</Link>
      </DialogHeader>
    <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="identity" /><input type="hidden" name="key" value={user.key} />
      <Field label="Name"><Input name="name" defaultValue={user.name} required maxLength={200} autoComplete="name" autoFocus /></Field>
      <Field label="Email" hint={self ? 'Change your own email from Profile.' : undefined}>
        <Input name="email" defaultValue={user.email} readOnly={self} required maxLength={254} type="email" autoComplete="email" /></Field>
      <ActionRow><Button>Save user</Button><Feedback actionData={actionData} intent="identity" userKey={user.key} /></ActionRow>
    </fieldset></Form>
    <AccountSection heading="System role" headingId="member-role-heading">
      <Hint className="mb-3">Role changes are saved separately from name and email.</Hint>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="role" /><input type="hidden" name="key" value={user.key} />
        <Label className="mb-[1.15rem]"><Checkbox name="isAdmin" defaultChecked={user.isAdmin} />System administrator</Label>
        <ActionRow><Button>Save role</Button><Feedback actionData={actionData} intent="role" userKey={user.key} /></ActionRow>
      </fieldset></Form></AccountSection>
    <AccountSection heading="Account access" headingId="member-credential-heading">
      <p><AccessBadge user={user} /></p>
      <Hint className="mb-3">{user.credentialState === 'established'
        ? 'Send a single-use link so this user can reset their own password.'
        : 'Resend the single-use link so this user can finish account setup.'}</Hint>
      <Form method="post"><input type="hidden" name="intent" value="recovery" /><input type="hidden" name="key" value={user.key} />
        <ActionRow><Button disabled={busy}>{user.credentialState === 'established'
          ? 'Send password reset email' : 'Resend setup email'}</Button><Feedback actionData={actionData} intent="recovery" userKey={user.key} /></ActionRow></Form></AccountSection>
    <AccountSection heading="Delete user" headingId="user-delete-heading" danger>
      <Hint className="mb-3">Disables sign-in, removes personal account data and Group memberships, and preserves Asset provenance.</Hint>
      {self ? <Hint>Delete your own account from Profile.</Hint>
        : <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>Delete user</Button>}
      <DestructiveConfirmation open={confirmDelete} onClose={() => setConfirmDelete(false)} displayName={user.name}
        email={user.email} mode="user" confirmLabel="Delete user" fields={{ intent: 'delete', key: user.key }} busy={busy}
        error={actionData?.intent === 'delete' && actionData.key === user.key ? actionData.error : undefined} />
    </AccountSection>
    </DialogContent>
  </Dialog>;
}

export default function Users({ loaderData: { users, settings, actorKey }, actionData }: Route.ComponentProps) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const matching = filterUsers(users, query);
  const selected = users.find((user) => user.key === selectedKey) ?? null;
  return <>
    <PageHeading eyebrow="Administration" title="Users" description={`${users.length} active users`}>
      <Button onClick={() => setCreating(true)}>Create user</Button>
    </PageHeading>
    <div className="mb-4 flex max-w-[40rem] items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-[.45rem]">
      <Label htmlFor="user-search" className="sr-only">Search users by name or email</Label>
      <Input id="user-search" type="search" className="bg-card" placeholder="Search users by name or email…"
        value={query} onChange={(event) => setQuery(event.currentTarget.value)} autoComplete="off" />
      {query && <span aria-live="polite" className="whitespace-nowrap text-[.8rem] text-muted-foreground">{matching.length} matching</span>}</div>
    {matching.length ? <div className={stackedTableFrame}><Table className={stackedTable}>
      <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead>
        <TableHead>Joined</TableHead><TableHead>Access</TableHead><TableHead>Role</TableHead></TableRow></TableHeader>
      <TableBody>{matching.map((user) => <TableRow key={user.key}>
        <TableCell data-label="Name"><Button type="button" variant="link" className="h-auto p-0 font-semibold underline underline-offset-2"
          onClick={() => setSelectedKey(user.key)}>{user.name}</Button></TableCell>
        <TableCell data-label="Email">{user.email}</TableCell>
        <TableCell data-label="Joined">{user.createdAt ? <time dateTime={user.createdAt}>{displayInstant(user.createdAt, settings.displayTimezone)}</time> : <span aria-label="Unknown">—</span>}</TableCell>
        <TableCell data-label="Access"><AccessBadge user={user} /></TableCell>
        <TableCell data-label="Role"><Badge variant={user.isAdmin ? 'brand' : 'secondary'}>{user.isAdmin ? 'System administrator' : 'User'}</Badge></TableCell>
      </TableRow>)}</TableBody></Table></div>
      : <EmptyState className="rounded-lg border bg-card"><p>No users match “{query.trim()}”.</p></EmptyState>}
    {creating && <CreateUserDialog actionData={actionData} onDismiss={() => setCreating(false)} />}
    {selected && <UserDialog user={selected} actorKey={actorKey} actionData={actionData} onDismiss={() => setSelectedKey(null)} />}
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
