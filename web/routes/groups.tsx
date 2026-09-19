import { Form, redirect, useNavigation } from 'react-router';
import { useEffect, useRef } from 'react';
import { api, unwrap } from '../api';
import { TransientSuccess } from '../transient-success';
import type { Route } from './+types/groups';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const { groups } = await unwrap(await api.groups.$get());
  return { user, groups };
}
type GroupAction = { intent: string; groupKey: string | null;
  status: 'added' | 'already-member' | 'error'; message: string };

export async function clientAction({ request }: Route.ClientActionArgs): Promise<Response | GroupAction> {
  const data = await request.formData();
  const text = (key: string) => String(data.get(key) ?? '');
  const intent = text('intent');
  const groupKey = data.get('groupKey') ? text('groupKey') : null;
  try {
    switch (intent) {
      case 'group':
        await unwrap(await api.groups.$post({ json: { name: text('name') } }));
        break;
      case 'member':
        if (!groupKey) throw new Error('Group is required');
        const result = await unwrap(await api.groups[':key'].members.$post({ param: { key: groupKey }, json: { userKey: text('userKey') } }));
        return result.added
          ? { intent, groupKey, status: 'added', message: 'Member added' }
          : { intent, groupKey, status: 'already-member', message: 'Member is already in this Group' };
      case 'leave':
        await unwrap(await api.groups[':key'].membership.$delete({ param: { key: text('groupKey') } }));
        break;

      default: throw new Error('Unknown action');
    }
    return redirect('/groups');
  } catch (error) {
    return { intent, groupKey, status: 'error',
      message: error instanceof Error ? error.message : 'Group update failed' };
  }
}
export default function Groups({ loaderData: { user, groups }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== 'idle';
  return <>
    <div className="page-heading"><div><p className="eyebrow">Collaboration</p><h1>Groups</h1><p>Manage the people you share Asset access with.</p></div></div>
    {actionData?.status === 'error' && actionData.intent !== 'member' && <p role="alert">{actionData.message}</p>}
      <section className="panel">
        <h2>Your Groups</h2>
        <p className="hint">Your member key: <code>{user.key}</code>. Share it with a Group member to be added.</p>
        <Form method="post" className="inline"><input type="hidden" name="intent" value="group" />
          <label>New Group name<input name="name" required /></label><button disabled={busy}>Create Group</button>
        </Form>
        {!groups.length && <p>Create a Group, or ask an existing member to add you.</p>}
        {groups.map((group) => <details key={group.key}><summary>{group.name}</summary>
          <AddMemberForm groupKey={group.key} actionData={actionData} busy={busy} />
          <Form method="post"><input type="hidden" name="groupKey" value={group.key} />
            <p className="hint">Leaving removes your access to this Group’s private Assets, including those you reported.</p>
            <button name="intent" value="leave" disabled={busy} className="secondary">Leave Group</button>
          </Form>
        </details>)}
      </section>

  </>;
}

function AddMemberForm({ groupKey, actionData, busy }: { groupKey: string; actionData?: GroupAction; busy: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const result = actionData?.intent === 'member' && actionData.groupKey === groupKey ? actionData : null;
  useEffect(() => { if (result?.status === 'added') form.current?.reset(); }, [result]);
  return <Form ref={form} method="post" className="inline group-member-form">
    <input type="hidden" name="intent" value="member" /><input type="hidden" name="groupKey" value={groupKey} />
    <label>Member key<input name="userKey" required /></label><button disabled={busy}>Add member</button>
    <div className="group-member-status" aria-live="polite" aria-atomic="true">
      {result?.status === 'added' ? <TransientSuccess trigger={result} label={result.message} />
        : result?.status === 'already-member' ? <span className="settings-status-pill">{result.message}</span>
          : result?.status === 'error' ? <span className="settings-status-pill error" role="alert">{result.message}</span> : null}
    </div>
  </Form>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
