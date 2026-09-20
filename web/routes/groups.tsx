import { Form, redirect, useNavigation } from 'react-router';
import { useEffect, useRef } from 'react';
import { api, unwrap } from '../api';
import { TransientSuccess } from '../transient-success';
import { formatExclusionRanges, parseExclusionRanges } from '../../server/giai-allocation.js';
import type { GiaiNamespace } from '../../server/identity-store.js';
import type { Route } from './+types/groups';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  const [{ groups }, { namespaces }] = await Promise.all([
    api.groups.$get().then(unwrap), api['giai-namespaces'].$get().then(unwrap)]);
  return { user, groups, namespaces };
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
      case 'namespace':
        if (!groupKey) throw new Error('Group is required');
        await unwrap(await api.groups[':key']['giai-namespaces'].$post({ param: { key: groupKey },
          json: { gcp: text('gcp'), exclusions: parseExclusionRanges(text('exclusions')) } }));
        break;
      case 'namespace-active':
        await unwrap(await api['giai-namespaces'][':key'].$patch({ param: { key: text('namespaceKey') },
          json: { active: text('active') === 'true' } }));
        break;

      default: throw new Error('Unknown action');
    }
    return redirect('/groups');
  } catch (error) {
    return { intent, groupKey, status: 'error',
      message: error instanceof Error ? error.message : 'Group update failed' };
  }
}
export default function Groups({ loaderData: { user, groups, namespaces }, actionData }: Route.ComponentProps) {
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
          <GiaiNamespaces groupKey={group.key} busy={busy}
            namespaces={namespaces.filter((namespace) => namespace.group?.key === group.key)} />
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

function GiaiNamespaces({ groupKey, namespaces, busy }: {
  groupKey: string; namespaces: GiaiNamespace[]; busy: boolean;
}) {
  return <div className="giai-namespaces">
    <h3>GS1 Company Prefixes</h3>
    <p className="hint">Configuring a prefix lets this Group allocate GIAIs for its Assets.
      Kannabi records the prefix you assert here; it cannot verify who licensed it.</p>
    {!namespaces.length ? <p>No prefix configured. This Group cannot allocate GIAIs.</p>
      : <ul className="giai-namespace-list">{namespaces.map((namespace) => <li key={namespace.key}>
        <div>
          <code>{namespace.gcp}</code>
          <span className={'badge ' + (namespace.active ? 'public' : '')}>
            {namespace.active ? 'Active' : 'Inactive'}</span>
          <span className="hint">Next reference {namespace.nextSequence}
            {namespace.exclusions.length
              ? ` · existing use ${formatExclusionRanges(namespace.exclusions)}` : ''}</span>
        </div>
        <Form method="post" className="inline">
          <input type="hidden" name="intent" value="namespace-active" />
          <input type="hidden" name="namespaceKey" value={namespace.key} />
          <input type="hidden" name="active" value={namespace.active ? 'false' : 'true'} />
          <button className="secondary" disabled={busy}>{namespace.active ? 'Deactivate' : 'Reactivate'}</button>
        </Form>
      </li>)}</ul>}
    <Form method="post" className="inline">
      <input type="hidden" name="intent" value="namespace" />
      <input type="hidden" name="groupKey" value={groupKey} />
      <label>GS1 Company Prefix<input name="gcp" inputMode="numeric" required /></label>
      <label>Already-used references<input name="exclusions" placeholder="1-4,9-11,200-300" />
        <span className="hint">Optional. References issued before Kannabi, which it must never allocate.</span>
      </label>
      <button disabled={busy}>Configure prefix</button>
    </Form>
  </div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
