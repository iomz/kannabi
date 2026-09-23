import { Form, redirect, useNavigation } from 'react-router';
import { useEffect, useRef } from 'react';
import { api, unwrap } from '../api';
import { TransientSuccess } from '../transient-success';
import { formatExclusionRanges, parseExclusionRanges } from '../../server/giai-allocation.js';
import type { GiaiNamespace } from '../../server/identity-store.js';
import type { Route } from './+types/groups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Hint, PageHeading, Panel, StatusPill } from '../ui';

/** Controls that read as one line: a field, and the action that uses it. */
const inlineForm = 'flex flex-wrap items-center gap-4 [&_label]:m-0 [&_label]:flex-1 [&_button]:self-end';

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
    <PageHeading eyebrow="Collaboration" title="Groups"
      description="Manage the people you share Asset access with." />
    {actionData?.status === 'error' && actionData.intent !== 'member' && <p role="alert">{actionData.message}</p>}
      <Panel>
        <h2>Your Groups</h2>
        <Hint className="mb-4">Your member key: <code>{user.key}</code>. Share it with a Group member to be added.</Hint>
        <Form method="post" className={inlineForm}><input type="hidden" name="intent" value="group" />
          <Field label="New Group name"><Input name="name" required /></Field>
          <Button disabled={busy}>Create Group</Button>
        </Form>
        {!groups.length && <p>Create a Group, or ask an existing member to add you.</p>}
        {groups.map((group) => <details key={group.key}
          className="mt-5 border-t pt-5 [&>summary]:mb-4 [&>summary]:cursor-pointer [&>summary]:font-semibold">
          <summary>{group.name}</summary>
          <AddMemberForm groupKey={group.key} actionData={actionData} busy={busy} />
          <GiaiNamespaces groupKey={group.key} busy={busy}
            namespaces={namespaces.filter((namespace) => namespace.group?.key === group.key)} />
          <Form method="post"><input type="hidden" name="groupKey" value={group.key} />
            <Hint className="mb-3">Leaving removes your access to this Group’s private Assets, including those you reported.</Hint>
            <Button name="intent" value="leave" disabled={busy} variant="outline">Leave Group</Button>
          </Form>
        </details>)}
      </Panel>
  </>;
}

function AddMemberForm({ groupKey, actionData, busy }: { groupKey: string; actionData?: GroupAction; busy: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const result = actionData?.intent === 'member' && actionData.groupKey === groupKey ? actionData : null;
  useEffect(() => { if (result?.status === 'added') form.current?.reset(); }, [result]);
  return <Form ref={form} method="post" className={inlineForm}>
    <input type="hidden" name="intent" value="member" /><input type="hidden" name="groupKey" value={groupKey} />
    <Field label="Member key"><Input name="userKey" required /></Field>
    <Button disabled={busy}>Add member</Button>
    <div className="flex min-h-8 basis-full items-center" aria-live="polite" aria-atomic="true">
      {result?.status === 'added' ? <TransientSuccess trigger={result} label={result.message} />
        : result?.status === 'already-member' ? <StatusPill className="whitespace-normal">{result.message}</StatusPill>
          : result?.status === 'error' ? <StatusPill tone="error" className="whitespace-normal" role="alert">{result.message}</StatusPill> : null}
    </div>
  </Form>;
}

function GiaiNamespaces({ groupKey, namespaces, busy }: {
  groupKey: string; namespaces: GiaiNamespace[]; busy: boolean;
}) {
  return <div className="my-4">
    <h3 className="mt-0 mb-1 text-[.95rem]">GS1 Company Prefixes</h3>
    <Hint className="mb-3">Configuring a prefix lets this Group allocate GIAIs for its Assets.
      Kannabi records the prefix you assert here; it cannot verify who licensed it.</Hint>
    {!namespaces.length ? <p>No prefix configured. This Group cannot allocate GIAIs.</p>
      : <ul className="my-2 grid gap-2">{namespaces.map((namespace) => <li key={namespace.key}
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted px-[.8rem] py-[.6rem]">
        <div className="flex flex-wrap items-center gap-2">
          <code>{namespace.gcp}</code>
          <Badge variant={namespace.active ? 'brand' : 'secondary'}>
            {namespace.active ? 'Active' : 'Inactive'}</Badge>
          <Hint>Next reference {namespace.nextSequence}
            {namespace.exclusions.length
              ? ` · existing use ${formatExclusionRanges(namespace.exclusions)}` : ''}</Hint>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="namespace-active" />
          <input type="hidden" name="namespaceKey" value={namespace.key} />
          <input type="hidden" name="active" value={namespace.active ? 'false' : 'true'} />
          <Button variant="outline" size="sm" disabled={busy}>{namespace.active ? 'Deactivate' : 'Reactivate'}</Button>
        </Form>
      </li>)}</ul>}
    <Form method="post" className={inlineForm}>
      <input type="hidden" name="intent" value="namespace" />
      <input type="hidden" name="groupKey" value={groupKey} />
      <Field label="GS1 Company Prefix"><Input name="gcp" inputMode="numeric" required /></Field>
      <Field label="Already-used references"
        hint="Optional. References issued before Kannabi, which it must never allocate.">
        <Input name="exclusions" placeholder="1-4,9-11,200-300" />
      </Field>
      <Button disabled={busy}>Configure prefix</Button>
    </Form>
  </div>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
