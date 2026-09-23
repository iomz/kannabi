import { Form, redirect, useNavigation } from 'react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { api, unwrap } from '../api';
import { DestructiveConfirmation } from '../destructive-confirmation';
import { displayInstant } from '../../server/settings';
import { filterMembers } from '../member-filter';
import { memberAccessLabel } from '../member-access';
import { TransientSuccess } from '../transient-success';
import type { Member } from '../../server/identity-store';
import type { Route } from './+types/members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ActionRow, ActionStatus, EmptyState, Field, Hint, PageHeading, StatusPill,
  stackedTable, stackedTableFrame } from '../ui';

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
  if (actionData?.intent !== intent || actionData.key !== memberKey) return <ActionStatus />;
  return <ActionStatus>{actionData.saved
    ? <TransientSuccess trigger={actionData} label={actionData.message ?? 'Saved'} />
    : <StatusPill tone="error" role="alert">{actionData.error}</StatusPill>}</ActionStatus>;
}

function AccessBadge({ member }: { member: Member }) {
  const established = member.credentialState === 'established';
  return <Badge variant="secondary"
    className={established ? 'bg-success-surface text-success-text' : undefined}>
    {memberAccessLabel(member.credentialState)}</Badge>;
}

/** A section of a member's account, each saved on its own. */
function AccountSection({ heading, headingId, children, danger = false }: {
  heading: string; headingId: string; children: ReactNode; danger?: boolean;
}) {
  return <section aria-labelledby={headingId}
    className={'mt-5 border-t pt-5' + (danger ? ' border-warning-border' : '')}>
    <h3 id={headingId} className="mt-0 mb-3 text-base">{heading}</h3>
    {children}
  </section>;
}

function CreateMemberDialog({ actionData, onDismiss }: { actionData?: MemberAction; onDismiss(): void }) {
  const busy = useNavigation().state !== 'idle';
  const created = actionData?.intent === 'create' && actionData.saved;
  useEffect(() => { if (created) onDismiss(); }, [created, onDismiss]);
  return <Dialog open onOpenChange={(next) => { if (!next) onDismiss(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Create member</DialogTitle>
        <DialogDescription>Kannabi sends a secure setup link. Administrators never handle member passwords.</DialogDescription>
      </DialogHeader>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="create" />
        <Field label="Name"><Input name="name" required maxLength={200} autoComplete="name" autoFocus /></Field>
        <Field label="Email"><Input name="email" required maxLength={254} type="email" autoComplete="email" /></Field>
        <Label className="mb-[1.15rem]"><Checkbox name="isAdmin" />System administrator</Label>
        <ActionRow><Button>Create member</Button><Feedback actionData={actionData} intent="create" memberKey={null} /></ActionRow>
      </fieldset></Form>
    </DialogContent>
  </Dialog>;
}

function MemberDialog({ member, actorKey, actionData, onDismiss }: { member: Member; actorKey: string | null;
  actionData?: MemberAction; onDismiss(): void }) {
  const busy = useNavigation().state !== 'idle';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const self = member.key === actorKey;
  return <Dialog open onOpenChange={(next) => { if (!next) onDismiss(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
    <DialogHeader>
      <DialogTitle>Edit {member.name}</DialogTitle>
      <DialogDescription>Each part of a member account is saved on its own.</DialogDescription>
    </DialogHeader>
    <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="identity" /><input type="hidden" name="key" value={member.key} />
      <Field label="Name"><Input name="name" defaultValue={member.name} required maxLength={200} autoComplete="name" autoFocus /></Field>
      <Field label="Email" hint={self ? 'Change your own email from Profile.' : undefined}>
        <Input name="email" defaultValue={member.email} readOnly={self} required maxLength={254} type="email" autoComplete="email" /></Field>
      <ActionRow><Button>Save member</Button><Feedback actionData={actionData} intent="identity" memberKey={member.key} /></ActionRow>
    </fieldset></Form>
    <AccountSection heading="System role" headingId="member-role-heading">
      <Hint className="mb-3">Role changes are saved separately from name and email.</Hint>
      <Form method="post"><fieldset disabled={busy}><input type="hidden" name="intent" value="role" /><input type="hidden" name="key" value={member.key} />
        <Label className="mb-[1.15rem]"><Checkbox name="isAdmin" defaultChecked={member.isAdmin} />System administrator</Label>
        <ActionRow><Button>Save role</Button><Feedback actionData={actionData} intent="role" memberKey={member.key} /></ActionRow>
      </fieldset></Form></AccountSection>
    <AccountSection heading="Account access" headingId="member-credential-heading">
      <p><AccessBadge member={member} /></p>
      <Hint className="mb-3">{member.credentialState === 'established'
        ? 'Send a single-use link so this member can reset their own password.'
        : 'Resend the single-use link so this member can finish account setup.'}</Hint>
      <Form method="post"><input type="hidden" name="intent" value="recovery" /><input type="hidden" name="key" value={member.key} />
        <ActionRow><Button disabled={busy}>{member.credentialState === 'established'
          ? 'Send password reset email' : 'Resend setup email'}</Button><Feedback actionData={actionData} intent="recovery" memberKey={member.key} /></ActionRow></Form></AccountSection>
    <AccountSection heading="Delete member" headingId="member-delete-heading" danger>
      <Hint className="mb-3">Disables sign-in, removes personal account data and Group memberships, and preserves Asset provenance.</Hint>
      {self ? <Hint>Delete your own account from Profile.</Hint>
        : <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>Delete member</Button>}
      <DestructiveConfirmation open={confirmDelete} onClose={() => setConfirmDelete(false)} displayName={member.name}
        email={member.email} mode="member" confirmLabel="Delete member" fields={{ intent: 'delete', key: member.key }} busy={busy}
        error={actionData?.intent === 'delete' && actionData.key === member.key ? actionData.error : undefined} />
    </AccountSection>
    </DialogContent>
  </Dialog>;
}

export default function Members({ loaderData: { members, settings, actorKey }, actionData }: Route.ComponentProps) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const matching = filterMembers(members, query);
  const selected = members.find((member) => member.key === selectedKey) ?? null;
  return <>
    <PageHeading eyebrow="Administration" title="Members" description={`${members.length} active members`}>
      <Button onClick={() => setCreating(true)}>Create member</Button>
    </PageHeading>
    <div className="mb-4 flex max-w-[40rem] items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-[.45rem]">
      <Label htmlFor="member-search" className="sr-only">Search members by name or email</Label>
      <Input id="member-search" type="search" className="bg-card" placeholder="Search members by name or email…"
        value={query} onChange={(event) => setQuery(event.currentTarget.value)} autoComplete="off" />
      {query && <span aria-live="polite" className="whitespace-nowrap text-[.8rem] text-muted-foreground">{matching.length} matching</span>}</div>
    {matching.length ? <div className={stackedTableFrame}><Table className={stackedTable}>
      <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead>
        <TableHead>Joined</TableHead><TableHead>Access</TableHead><TableHead>Role</TableHead></TableRow></TableHeader>
      <TableBody>{matching.map((member) => <TableRow key={member.key}>
        <TableCell data-label="Name"><Button type="button" variant="link" className="h-auto p-0 font-semibold underline underline-offset-2"
          onClick={() => setSelectedKey(member.key)}>{member.name}</Button></TableCell>
        <TableCell data-label="Email">{member.email}</TableCell>
        <TableCell data-label="Joined">{member.createdAt ? <time dateTime={member.createdAt}>{displayInstant(member.createdAt, settings.displayTimezone)}</time> : <span aria-label="Unknown">—</span>}</TableCell>
        <TableCell data-label="Access"><AccessBadge member={member} /></TableCell>
        <TableCell data-label="Role"><Badge variant={member.isAdmin ? 'default' : 'secondary'}>{member.isAdmin ? 'System administrator' : 'Member'}</Badge></TableCell>
      </TableRow>)}</TableBody></Table></div>
      : <EmptyState className="rounded-lg border bg-card"><p>No members match “{query.trim()}”.</p></EmptyState>}
    {creating && <CreateMemberDialog actionData={actionData} onDismiss={() => setCreating(false)} />}
    {selected && <MemberDialog member={selected} actorKey={actorKey} actionData={actionData} onDismiss={() => setSelectedKey(null)} />}
  </>;
}
export { WorkspaceError as ErrorBoundary } from '../route-error';
