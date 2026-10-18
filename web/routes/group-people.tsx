import { useEffect, useId, useState } from 'react';
import { useNavigation, useOutletContext, useSubmit } from 'react-router';
import { api, unwrap } from '../api';
import { ConfirmedAct, explainRefusal, groupRead, GroupViewError, leaveAction, mutation, PersonName, viewerKey,
  type GroupActionResult, type GroupRelationship,
} from '../group-destination';
import { notify } from '../notify';
import { Avatar } from '../avatar';
import type { GroupPerson, GroupRole } from '../../server/identity-store.js';
import type { PeopleDirectory } from '../../server/settings.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field, Hint, Panel, StatusPill } from '../ui';
import type { Route } from './+types/group-people';

/** A Group's people and their roles.
 *
 * One relationship with a role: a Group Manager is a member who also adds and
 * removes people, changes roles and manages the Group's GS1 Company
 * Prefixes. Every member reads the roster — they already share this Group
 * with everybody on it — and only Group Managers change it.
 *
 * Nothing here decides access. Every read and every change is the server's to
 * allow; what this view leaves out, it leaves out because the server would
 * refuse it.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const [{ members }, { settings }, self] = await Promise.all([
    api.groups[':key'].members.$get({ param: { key: params.key } }).then(groupRead),
    api.settings.$get().then(unwrap),
    viewerKey(),
  ]);
  return { members: members as GroupPerson[], directory: settings.peopleDirectory, self };
}

export const roleLabel: Record<GroupRole, string> = { member: 'Member', manager: 'Group Manager' };

export async function clientAction({ request, params }: Route.ClientActionArgs): Promise<GroupActionResult | Response> {
  const data = await request.formData();
  const intent = String(data.get('intent') ?? '');
  const key = params.key;
  if (intent === 'leave') return leaveAction(key);
  const userKey = String(data.get('userKey') ?? '').trim();
  const who = String(data.get('name') ?? '').trim() || 'That person';
  const self = data.get('self') === 'on';
  if (!userKey) return { intent, status: 'error', message: 'Choose a person, or enter their member key.' };
  const setRole = async (role: GroupRole) => (await mutation(await api.groups[':key'].members[':userKey']
    .$patch({ param: { key, userKey }, json: { role } }))).changed;
  try {
    if (intent === 'add') {
      const role: GroupRole = data.get('role') === 'manager' ? 'manager' : 'member';
      const { added } = await mutation(await api.groups[':key'].members.$post({ param: { key }, json: { userKey, role } }));
      if (!added) return { intent, status: 'unchanged', userKey, message: `${who} is already in this Group. Change their role from the list.` };
      notify(role === 'manager' ? `${who} added as Group Manager` : `${who} added as member`);
      return { intent, status: 'done', userKey, message: '' };
    }
    if (intent === 'promote' || intent === 'demote') {
      const changed = await setRole(intent === 'promote' ? 'manager' : 'member');
      if (!changed) return { intent, status: 'unchanged', userKey, message: intent === 'promote'
        ? `${who} already is a Group Manager.` : `${who} already was not a Group Manager.` };
      notify(intent === 'promote' ? `${who} is now a Group Manager`
        : self ? 'You stepped down as Group Manager' : `${who} is no longer a Group Manager`);
      return { intent, status: 'done', userKey, message: '' };
    }
    if (intent === 'remove') {
      const { changed } = await mutation(await api.groups[':key'].members[':userKey'].$delete({ param: { key, userKey } }));
      if (!changed) return { intent, status: 'unchanged', userKey, message: `${who} was no longer in this Group.` };
      notify(`${who} was removed from the Group`);
      return { intent, status: 'done', userKey, message: '' };
    }
    return { intent, status: 'error', message: 'Unknown action' };
  } catch (error) {
    // A 404 is either "nobody by that key" or "you no longer manage this
    // Group", deliberately alike from the server; explainRefusal reads the
    // viewer's own standing to say which.
    return explainRefusal(error, key, intent, intent === 'add'
      ? 'Nobody with that key can be added.' : 'That person is no longer in this Group.');
  }
}

type Removal = { kind: 'remove' | 'demote' | 'step-down' | 'leave'; person: GroupPerson };

/** What each consequential change costs, in one place. Each says what goes,
 * what stays, and that access through other Groups is untouched. */
export function removalCopy({ kind, person }: Removal, managerCount: number): {
  title: string; description: string; confirmLabel: string;
} {
  const orphan = 'Nobody will be able to add or remove people or manage its GS1 Company Prefixes until a system '
    + 'administrator promotes one of its members.';
  const sole = person.role === 'manager' && managerCount === 1;
  if (kind === 'remove') {
    return { title: `Remove ${person.name} from this Group?`, confirmLabel: 'Remove',
      description: 'They lose access to this Group’s private Assets on their next request. Access through other '
        + 'Groups, and to public Assets, is unchanged.'
        + (person.role === 'manager' ? ' They also stop being a Group Manager.' : '') };
  }
  if (kind === 'demote') {
    return { title: `Remove ${person.name}’s Group Manager role?`, confirmLabel: 'Remove role',
      description: `${person.name} will no longer be able to add or remove people, change roles, or manage GS1 `
        + 'Company Prefixes. They stay a member, with the same access to this Group’s Assets.' };
  }
  if (kind === 'step-down') {
    return { title: sole ? 'Step down, and leave nobody managing this Group?' : 'Step down as Group Manager?',
      confirmLabel: 'Step down',
      description: (sole ? `You are its only Group Manager. ${orphan} `
        : 'You will no longer be able to add or remove people, change roles, or manage GS1 Company Prefixes. ')
        + 'You stay a member, with the same access to its Assets.' };
  }
  return { title: sole ? 'Leave, and leave nobody managing this Group?' : 'Leave this Group?', confirmLabel: 'Leave',
    description: 'You lose access to this Group’s private Assets, including those you reported, and you will no '
      + 'longer be able to open it.' + (sole ? ` You are its only Group Manager. ${orphan}` : '') };
}

export default function GroupPeople({ loaderData: { members, directory, self }, actionData }: Route.ComponentProps) {
  const { viewer } = useOutletContext<GroupRelationship>();
  const manages = viewer.role === 'manager';
  const busy = useNavigation().state !== 'idle';
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const result = actionData && typeof actionData === 'object' && 'status' in actionData
    ? actionData as GroupActionResult : undefined;
  const people = [...members].sort((left, right) => Number(right.key === self) - Number(left.key === self)
    || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  const managerCount = members.filter((person) => person.role === 'manager').length;
  const count = (n: number, one: string, many: string) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;
  const copy = removing ? removalCopy(removing, managerCount) : null;

  return <Panel className="mt-0">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="m-0">People</h2>
      {manages && <Button type="button" disabled={busy} onClick={() => setAdding(true)}>Add people</Button>}
    </div>
    <Hint className="mt-0 mb-4">{count(members.length, 'person', 'people')} · {count(managerCount, 'Group Manager',
      'Group Managers')}. Members read and edit this Group’s private Assets. Group Managers are members who also add
      and remove people and manage its GS1 Company Prefixes.</Hint>
    {result?.message && <StatusPill tone={result.status === 'error' ? 'error' : 'info'}
      role={result.status === 'error' ? 'alert' : 'status'} className="mb-4 whitespace-normal">{result.message}</StatusPill>}
    {managerCount === 0 && <StatusPill tone="error" role="status" className="mb-4 whitespace-normal">
      Nobody manages this Group. A system administrator can promote one of its members.</StatusPill>}
    {/* A table on a wide screen; on a phone each row becomes a card holding
        the name, the role and the actions. Utilities sit on the elements
        themselves so the card layout needs no second copy of the roster. */}
    <div className="rounded-lg border bg-card max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent">
      <table className="w-full text-sm max-sm:block">
        <caption className="sr-only">People in this Group and their roles</caption>
        <thead className="max-sm:sr-only"><tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="px-4 py-2 font-medium">Person</th>
          <th scope="col" className="px-4 py-2 font-medium">Role</th>
          <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody className="max-sm:grid max-sm:gap-3">{people.map((person) => {
          const isSelf = person.key === self;
          return <tr key={person.key} className="border-b last:border-b-0 max-sm:grid
            max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-start max-sm:gap-3 max-sm:rounded-lg max-sm:border
            max-sm:bg-card max-sm:p-4 max-sm:last:border-b">
            <td className="px-4 py-3 align-top max-sm:p-0">
              <PersonName person={person} self={isSelf} />
              <span className="mt-2 flex sm:hidden"><RoleBadge role={person.role} /></span>
            </td>
            <td className="px-4 py-3 align-top max-sm:hidden">{roleLabel[person.role]}</td>
            <td className="px-4 py-3 text-right align-top max-sm:p-0">
              {(manages || isSelf) && <ChangeMenu person={person} self={isSelf} manages={manages} busy={busy}
                onRemove={setRemoving} />}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {!manages && <Hint className="mt-4">To add someone or change a role, ask one of this Group’s Group Managers.</Hint>}

    {adding && <AddPeople members={members} self={self} directory={directory} onClose={() => setAdding(false)} />}
    <ConfirmedAct open={removing !== null} onClose={() => setRemoving(null)}
      title={copy?.title ?? ''} confirmLabel={copy?.confirmLabel ?? ''} description={copy?.description ?? ''}
      fields={removing ? removalFields(removing) : {}} />
  </Panel>;
}

function removalFields({ kind, person }: Removal): Record<string, string> {
  const intent = kind === 'step-down' ? 'demote' : kind;
  return { intent, userKey: person.key, name: person.name, ...kind === 'step-down' ? { self: 'on' } : {} };
}

function RoleBadge({ role }: { role: GroupRole }) {
  return role === 'manager' ? <Badge variant="outline">Group Manager</Badge> : <Badge variant="secondary">Member</Badge>;
}

/** Every change for one person. Making somebody a Group Manager is immediate
 * and reported; taking anything away is confirmed, because it takes access or
 * authority from somebody — usually not the person clicking. Your own
 * membership ends by leaving, the act every member has. */
function ChangeMenu({ person, self, manages, busy, onRemove }: {
  person: GroupPerson; self: boolean; manages: boolean; busy: boolean; onRemove(removal: Removal): void;
}) {
  const submit = useSubmit();
  const promote = () => submit({ intent: 'promote', userKey: person.key, name: person.name },
    { method: 'post', preventScrollReset: true });
  return <DropdownMenu>
    <DropdownMenuTrigger disabled={busy} render={<Button type="button" variant="outline" size="sm"
      aria-label={self ? 'Change your role in this Group' : `Change ${person.name}’s role in this Group`} />}>
      Change
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-auto min-w-60">
      {manages && (person.role === 'manager'
        ? <DropdownMenuItem variant="destructive" onClick={() => onRemove({ kind: self ? 'step-down' : 'demote', person })}>
          {self ? 'Step down as Group Manager…' : 'Remove Group Manager role…'}</DropdownMenuItem>
        : <DropdownMenuItem onClick={promote}>Make Group Manager</DropdownMenuItem>)}
      {manages && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={() => onRemove({ kind: self ? 'leave' : 'remove', person })}>
        {self ? 'Leave Group…' : 'Remove from Group…'}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

type Candidate = { key: string; name: string; email: string | null };

/** Find somebody in the People directory, then choose their role.
 *
 * The search is the server's: it reaches exactly who this viewer may find
 * under the instance's People directory setting, by name, and by email where
 * addresses are shown. Where the directory is limited to shared Groups, a
 * newcomer who shares no Group with anybody is reached by the member key they
 * copy from their Groups page, and only then.
 *
 * Native radios rather than a scripted combobox: the results are few, and a
 * radio group already gives every reader arrow-key movement, a name and a
 * checked state. */
function AddPeople({ members, self, directory, onClose }: {
  members: GroupPerson[]; self: string; directory: PeopleDirectory; onClose(): void;
}) {
  const submit = useSubmit();
  const radios = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; people: Candidate[]; more: boolean } | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [typedKey, setTypedKey] = useState('');
  const [role, setRole] = useState<GroupRole>('member');
  useEffect(() => {
    const q = query.trim();
    if (!q) { setFound(null); return; }
    let current = true;
    // A short pause, so a search is one request per thought rather than per key.
    const timer = setTimeout(async () => {
      const response = await api.people.$get({ query: { q, limit: '8' } });
      if (!current || !response.ok) return;
      const { people, more } = await response.json();
      if (current) setFound({ query: q, people: people.filter((person) => person.key !== self), more });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [query, self]);
  const userKey = chosen?.key ?? typedKey.trim();
  const already = members.find((person) => person.key === userKey);
  const action = role === 'manager' ? 'Add as Group Manager' : 'Add as member';

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add people</DialogTitle>
        <DialogDescription>{directory === 'shared'
          ? 'Find somebody you already share a Group with, or use their member key.'
          : `Find anybody on this instance by name${directory === 'everyone' ? ' or email' : ''}.`}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-3">
        <Field className="mb-0" label="Find a person">
          <Input type="search" value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <fieldset className="max-h-64 overflow-y-auto rounded-lg border">
          <legend className="sr-only">People found</legend>
          {!found ? <p className="m-0 p-3 text-sm text-muted-foreground">{query.trim() ? 'Searching…'
            : `Type a name${directory === 'everyone' ? ' or an email address' : ''}.`}</p>
            : found.people.length === 0 ? <p className="m-0 p-3 text-sm text-muted-foreground">Nobody {directory === 'shared'
              ? 'you share a Group with' : 'on this instance'} matches “{found.query}”.</p>
              : found.people.map((person) => {
                const member = members.find((existing) => existing.key === person.key);
                return <label key={person.key} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2
                  last:border-b-0 hover:bg-accent has-[:checked]:bg-accent">
                  <input type="radio" name={radios} checked={chosen?.key === person.key}
                    onChange={() => { setChosen(person); setTypedKey(''); }} />
                  <Avatar name={person.name} size={26} />
                  <span className="grid min-w-0 flex-1">
                    <span className="[overflow-wrap:anywhere]">{person.name}</span>
                    {person.email && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{person.email}</span>}
                  </span>
                  {member && <RoleBadge role={member.role} />}
                </label>;
              })}
          {found?.more && <p className="m-0 border-t px-3 py-2 text-xs text-muted-foreground">More people match — keep
            typing to narrow.</p>}
        </fieldset>
        {directory === 'shared' && <details className="rounded-lg border px-3 py-2 text-sm" open={typedKey !== ''}>
          <summary className="cursor-pointer font-[550]">Not listed? Use their member key</summary>
          <Field className="mt-3 mb-1" label="Member key" hint="They can copy it from their Groups page.">
            <Input value={typedKey} autoComplete="off" spellCheck={false} className="font-mono text-xs"
              onChange={(event) => { setTypedKey(event.target.value); setChosen(null); }} />
          </Field>
        </details>}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-[550]">Role in this Group</legend>
        {(['member', 'manager'] as const).map((kind) => <label key={kind}
          className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-[:checked]:bg-accent">
          <input type="radio" name={`${radios}-role`} className="mt-1" checked={role === kind} onChange={() => setRole(kind)} />
          <span className="grid gap-1">
            <strong className="font-[600]">{roleLabel[kind]}</strong>
            <span className="text-muted-foreground">{kind === 'member'
              ? 'Reads and edits this Group’s private Assets and reports new ones into it.'
              : 'Everything a member can do, plus adding and removing people, changing roles and managing GS1 Company Prefixes.'}</span>
          </span>
        </label>)}
      </fieldset>
      {already && <StatusPill tone="info" role="status" className="whitespace-normal">{already.name} is already
        {already.role === 'manager' ? ' a Group Manager' : ' a member'} here. Change their role from the list.</StatusPill>}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={!userKey || Boolean(already)} onClick={() => {
          submit({ intent: 'add', userKey, role, name: chosen?.name ?? '' }, { method: 'post', preventScrollReset: true });
          onClose();
        }}>{chosen ? `${action}: ${chosen.name}` : action}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export { GroupViewError as ErrorBoundary };
