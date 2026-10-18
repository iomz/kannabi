import { useState, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, NavLink, redirect, useNavigation, useRouteError, useSubmit } from 'react-router';
import { api, unwrap } from './api';
import { notify, notifyFailure } from './notify';
import { Avatar } from './avatar';
import type { GroupRelationship, ReporterAttribution } from '../server/identity-store.js';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from './ui';

/** Shared pieces of the Group destination, `/groups/:key`.
 *
 * The destination is one page in several addressable views — Overview,
 * Assets, People and GS1 prefixes — each its own route with its own loader,
 * so a view loads only what it shows and every view can be linked to, reloaded
 * and reached with Back and Forward.
 *
 * Nothing here is an authorization boundary. Every read and every mutation is
 * decided by the server; what this module hides, it hides because the server
 * would refuse it, never in place of the server refusing it.
 */

export type { GroupRelationship };

/** A read the Group destination depends on.
 *
 * An unknown Group and a Group this viewer may not reach are the same 404 from
 * the server, and become the same route error here, so nothing on screen can
 * tell them apart. A missing session goes to sign-in rather than being shown
 * as a missing Group.
 */
export async function groupRead<T>(response: { ok: boolean; status: number; json(): Promise<T> }): Promise<T> {
  if (response.status === 401) throw redirect('/signin');
  if (response.status === 404) throw new Response('Group not found', { status: 404 });
  return unwrap(response);
}

export async function loadRelationship(key: string): Promise<GroupRelationship> {
  return groupRead(await api.groups[':key'].$get({ param: { key } }));
}

/** Where the viewer stands after a mutation, read again from the server.
 *
 * Used both to explain a refusal — the commonest being that the viewer stopped
 * managing the Group between loading the page and submitting — and to notice
 * that a mutation has taken the Group out of their reach. */
export async function currentRelationship(key: string): Promise<GroupRelationship | null> {
  const response = await api.groups[':key'].$get({ param: { key } });
  if (response.status === 404) return null;
  return unwrap(response);
}

/** The result a Group view's action hands back to the form that submitted it. */
export type GroupActionResult = { intent: string; status: 'error' | 'unchanged' | 'done'; message: string; userKey?: string };

/** An error the API reported, keeping its status so a refusal can be told
 * apart from a failure. */
export async function mutation<T>(response: { ok: boolean; status: number; json(): Promise<T> }): Promise<T> {
  if (response.ok) return response.json();
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new MutationRefused(response.status, typeof data?.error === 'string' ? data.error : 'Request failed');
}

export class MutationRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Turn a refused management change into what actually happened.
 *
 * The API answers "you no longer manage this Group" and "nobody by that key"
 * with the same 404, deliberately, so it is never an oracle. The
 * viewer's own relationship is theirs to read, though, so it is read again to
 * say which applies. Nothing is retried. */
export async function explainRefusal(error: unknown, key: string, intent: string,
  notFoundTarget: string): Promise<GroupActionResult | Response> {
  if (!(error instanceof MutationRefused) || error.status !== 404) {
    return { intent, status: 'error', message: error instanceof Error ? error.message : 'Request failed' };
  }
  const now = await currentRelationship(key);
  if (!now) {
    notifyFailure('This Group is no longer available to you.');
    return redirect('/groups');
  }
  if (now.viewer.role !== 'manager') {
    return { intent, status: 'error',
      message: 'You no longer manage this Group, so this change was not made.' };
  }
  return { intent, status: 'error', message: notFoundTarget };
}

/** The viewer's role in the Group. A Group Manager is a member who also
 * manages; the API and the store call that role `manager`. */
export function Relationship({ viewer }: { viewer: GroupRelationship['viewer'] }) {
  return viewer.role === 'manager' ? <Badge variant="outline">Group Manager</Badge> : <Badge variant="brand">Member</Badge>;
}

/** The views of a Group, the same for every member.
 *
 * Links rather than tabs, as the Inventory's scope strip is: each view has an
 * address, so it is navigation with `aria-current`, not a choice held in
 * component state. What each view lets somebody change follows their role,
 * and the server decides that on every request.
 *
 * The strip scrolls sideways only when it is genuinely wider than the page.
 * Vertical overflow is clipped explicitly: an underline that sat one pixel
 * below the strip used to make the browser offer a vertical scrollbar too.
 */
export function GroupNavigation() {
  const views: [string, string][] = [['.', 'Overview'], ['assets', 'Assets'], ['people', 'People'],
    ['prefixes', 'GS1 prefixes']];
  return <nav aria-label="Group" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b">
    {views.map(([to, label]) => <NavLink key={to} to={to} end={to === '.'} preventScrollReset
      className={({ isActive }) => ['whitespace-nowrap border-b-2 px-4 py-[.7rem] text-[.85rem] no-underline hover:bg-accent',
        'max-sm:px-3', isActive
          ? 'border-selected-indicator font-semibold text-selected-text'
          : 'border-transparent text-foreground'].join(' ')}>
      {label}
    </NavLink>)}
  </nav>;
}

/** A person in a Group, linked to their profile: everybody in a Group the
 * viewer belongs to is in the viewer's People directory, whatever its
 * setting. The address appears only when the server sent one, which follows
 * the directory setting. */
export function PersonName({ person, self }: {
  person: ReporterAttribution & { email?: string | null }; self: boolean;
}) {
  return <span className="flex min-w-0 items-start gap-2">
    <Avatar name={person.name} size={26} />
    <span className="grid min-w-0">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/users/${person.key}`} className="min-w-0 [overflow-wrap:anywhere]">{person.name}</Link>
        {self && <Badge variant="secondary">You</Badge>}
      </span>
      {person.email && <a href={`mailto:${person.email}`}
        className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{person.email}</a>}
    </span>
  </span>;
}

export async function viewerKey(): Promise<string> {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  return user.key;
}

/** Submit one intent after a confirmation dialog.
 *
 * The dialog owns the explanation; submission goes through the route's own
 * action, so the result lands where every other result of that view does. */
export function ConfirmedAct({ open, title, description, confirmLabel, fields, onClose }: {
  open: boolean; title: string; description: ReactNode; confirmLabel: string;
  fields: Record<string, string>; onClose(): void;
}) {
  const submit = useSubmit();
  const busy = useNavigation().state !== 'idle';
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        {/* Cancel takes the resting focus: the safe answer should be the one a
            stray keypress gives. */}
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
          submit(fields, { method: 'post', preventScrollReset: true });
          onClose();
        }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

/** Leaving a Group, from wherever the destination offers it.
 *
 * Leaving ends the membership and any role with it. The last Group Manager
 * may leave; the Group stays valid, and the dialog says nobody will manage
 * it until an administrator promotes one of its members. */
export function LeaveGroup({ lastManager, size }: { lastManager: boolean; size?: 'sm' }) {
  const [open, setOpen] = useState(false);
  const busy = useNavigation().state !== 'idle';
  return <>
    <Button type="button" variant="outline" size={size} disabled={busy} onClick={() => setOpen(true)}>Leave Group</Button>
    <ConfirmedAct open={open} onClose={() => setOpen(false)} confirmLabel="Leave"
      title={lastManager ? 'Leave, and leave nobody managing this Group?' : 'Leave this Group?'}
      fields={{ intent: 'leave' }}
      description={<>You lose access to this Group’s private Assets, including those you reported, and you will
        no longer be able to open it.{' '}
        {lastManager ? 'You are its only Group Manager: nobody will be able to add or remove people or manage its GS1 Company Prefixes until a system administrator promotes one of its members.' : ''}</>} />
  </>;
}

/** Leave, as an action any Group view can answer. Leaving always takes the
 * Group out of reach, so it ends on the Groups list. */
export async function leaveAction(key: string): Promise<GroupActionResult | Response> {
  try {
    await mutation(await api.groups[':key'].membership.$delete({ param: { key } }));
  } catch (error) {
    if (error instanceof MutationRefused && error.status === 404) {
      notifyFailure('You were no longer a member of this Group.');
      return redirect('/groups');
    }
    return { intent: 'leave', status: 'error', message: error instanceof Error ? error.message : 'Request failed' };
  }
  notify('Left Group');
  return redirect('/groups');
}

/** A view of a Group this viewer can reach but not read, typically one whose
 * authority changed under them. The page and its navigation stay, because the
 * Group itself is still theirs to open. */
export function GroupViewError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return <Panel className="mt-0">
    <h2>{status === 404 ? 'Not available to you' : 'Unable to load this view'}</h2>
    <p className="mb-0">{status === 404
      ? 'This part of the Group is shown only to people whose relationship to the Group allows it.'
      : 'Check your connection and try again.'}</p>
  </Panel>;
}

/** A Group's name wherever one is mentioned, linked to its page only for a
 * viewer who can open that page — one of its members. For anybody else
 * it stays text, so no link ever leads somebody to "Group unavailable". */
export function GroupName({ group, reachable }: { group: { key: string; name: string }; reachable: boolean }) {
  return reachable ? <Link to={`/groups/${group.key}`}>{group.name}</Link> : <>{group.name}</>;
}
