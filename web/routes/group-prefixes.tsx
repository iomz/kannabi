import { Form, Link, useNavigation, useOutletContext } from 'react-router';
import { api, unwrap } from '../api';
import { groupRead, GroupViewError, type GroupRelationship } from '../group-destination';
import { notify } from '../notify';
import { formatExclusionRanges, parseExclusionRanges } from '../../server/reference-allocation.js';
import type { Gs1ClassKeyAllocation, Gs1Namespace } from '../../server/identity-store.js';
import type { Route } from './+types/group-prefixes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, Field, Hint, NativeSelect, Panel } from '../ui';

/** The GS1 Company Prefixes a Group manages, on the Group's own page.
 *
 * Every member reads them; configuring a prefix and managing its class keys
 * are its Group Managers', and the server decides that on every request. They
 * lived on the Groups list until a Group had a page of its own; their
 * redesign is still #58's, and this is the same interface in its new home.
 */

/** A class key together with the namespace it belongs to, which the flat list
 * the loader returns needs in order to group them again. */
type ManagedClassKey = Gs1ClassKeyAllocation & { namespaceKey: string };

/** Controls that read as one line: a field, and the action that uses it. */
const inlineForm = 'flex flex-wrap items-center gap-4 [&_label]:m-0 [&_label]:flex-1 [&_button]:self-end';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const all = (await groupRead(await api['gs1-namespaces'].$get())).namespaces;
  const namespaces = all.filter((namespace) => namespace.group?.key === params.key);
  // Class keys are namespace configuration, so they are read alongside the
  // namespaces that hold them rather than from anywhere Asset-shaped.
  const classKeys = (await Promise.all(namespaces.map(async (namespace) => {
    const { classKeys: managed } = await unwrap(await api['gs1-namespaces'][':key']['class-keys']
      .$get({ param: { key: namespace.key }, query: { scheme: undefined } }));
    return managed.map((classKey) => ({ ...classKey, namespaceKey: namespace.key }));
  }))).flat();
  return { namespaces, classKeys };
}

type GroupAction = { intent: string; groupKey: string;
  status: 'error' | 'saved'; message: string;
  /** The record this submission created, so the row for it can be picked out
   * where the reader was already working. */
  createdKey?: string };

export async function clientAction({ request, params }: Route.ClientActionArgs): Promise<Response | GroupAction> {
  const data = await request.formData();
  const text = (key: string) => String(data.get(key) ?? '');
  const intent = text('intent');
  const groupKey = params.key;
  try {
    switch (intent) {
      case 'namespace':
        await unwrap(await api.groups[':key']['gs1-namespaces'].$post({ param: { key: groupKey },
          json: { gcp: text('gcp'), giaiExclusions: parseExclusionRanges(text('giaiExclusions')) } }));
        notify('GS1 Company Prefix configured');
        break;
      // Allocating and adopting are separate intents, because they are
      // separate assertions: one asks Kannabi to produce a reference, the
      // other tells it that this Group already produced one elsewhere. The
      // API is a single operation whose recorded provenance says which
      // happened; the two intents keep the choice explicit rather than
      // inferring it from whether a field was left blank.
      case 'class-key-allocate':
      case 'class-key-adopt': {
        const scheme = text('scheme');
        const adopting = intent === 'class-key-adopt';
        const existing = text('value');
        if (adopting && !existing) throw new Error('Enter the key this Group already allocated');
        const { classKey } = await unwrap(await api['gs1-namespaces'][':key']['class-keys'].$post({
          param: { key: text('namespaceKey') },
          json: { scheme,
            ...(adopting ? scheme === 'gtin' ? { gtin: existing } : { assetType: existing } : {}),
            serialExclusions: parseExclusionRanges(text('serialExclusions')) } }));
        notify(adopting ? 'Class key adopted' : 'Class key allocated');
        return { intent, groupKey, status: 'saved', message: '', createdKey: classKey.key };
      }
      case 'class-key-active':
        await unwrap(await api['gs1-namespaces'][':key']['class-keys'][':classKeyKey'].$patch({
          param: { key: text('namespaceKey'), classKeyKey: text('classKeyKey') },
          json: { active: text('active') === 'true' } }));
        notify(text('active') === 'true' ? 'Class key reactivated' : 'Class key deactivated');
        break;
      case 'namespace-active':
        await unwrap(await api['gs1-namespaces'][':key'].$patch({ param: { key: text('namespaceKey') },
          json: { active: text('active') === 'true' } }));
        notify(text('active') === 'true' ? 'GS1 Company Prefix reactivated' : 'GS1 Company Prefix deactivated');
        break;

      default: throw new Error('Unknown action');
    }
    // Data rather than a redirect, so the form's own `preventScrollReset`
    // holds; returning data still revalidates the loader in place.
    return { intent, groupKey, status: 'saved', message: '' };
  } catch (error) {
    return { intent, groupKey, status: 'error',
      message: error instanceof Error ? error.message : 'Group update failed' };
  }
}

export default function GroupPrefixes({ loaderData: { namespaces, classKeys }, actionData }: Route.ComponentProps) {
  const { group, viewer } = useOutletContext<GroupRelationship>();
  const busy = useNavigation().state !== 'idle';
  // The class key this submission just created, while it is still the newest.
  const justAdded = actionData?.status === 'saved' ? actionData.createdKey ?? null : null;
  return <>
    {actionData?.status === 'error' && <p role="alert">{actionData.message}</p>}
    <Gs1Namespaces groupKey={group.key} busy={busy} classKeys={classKeys} justAdded={justAdded}
      canManage={viewer.role === 'manager'} namespaces={namespaces} />
  </>;
}

function Gs1Namespaces({ groupKey, namespaces, classKeys, busy, justAdded, canManage }: {
  groupKey: string; namespaces: Gs1Namespace[]; classKeys: ManagedClassKey[]; busy: boolean;
  justAdded: string | null;
  /** Whether this reader is one of the Group's Managers, which is what
   * configuring a prefix, managing its class keys and issuing from it require.
   * Every member still reads everything here: the prefixes a Group manages are
   * not secret from its members, and hiding them would leave somebody unable
   * to see what they need to ask a Group Manager for. */
  canManage: boolean;
}) {
  return <Panel className="mt-0">
    <h2 className="mt-0 mb-1">GS1 Company Prefixes</h2>
    <Hint className="mb-3">Configuring a prefix lets this Group have Kannabi issue GS1 identifiers for
      its Assets. Kannabi records the prefix you assert here; it cannot verify who licensed it.</Hint>
    {!namespaces.length ? <p>No prefix configured. Kannabi can issue nothing for this Group.</p>
      : <ul className="my-2 grid gap-2">{namespaces.map((namespace) => <li key={namespace.key}
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted px-[.8rem] py-[.6rem]">
        <div className="flex flex-wrap items-center gap-2">
          <code>{namespace.gcp}</code>
          <Badge variant={namespace.active ? 'brand' : 'secondary'}>
            {namespace.active ? 'Active' : 'Inactive'}</Badge>
          {/* One counter per key type, because a GTIN and a GRAI asset type
              made of the same digits are different keys and never share
              numbers. */}
          {namespace.unissuableReason
            ? <Hint>Configured before the current prefix rules and can no longer
              issue: {namespace.unissuableReason.replace(/^A GS1 Company Prefix/, 'a GS1 Company Prefix')}.
              Everything it already issued stays valid.</Hint>
            : <Hint>Next GIAI reference {namespace.counters.giai.nextSequence}
            {namespace.counters.giai.exclusions.length
              ? ` (existing use ${formatExclusionRanges(namespace.counters.giai.exclusions)})` : ''}
            {namespace.classKeyIssuable
              ? ` · next GRAI asset type ${namespace.counters.graiType.nextSequence}`
                + ` · next ${namespace.gtinFormat} item reference ${namespace.counters.gtinItem.nextSequence}`
              : ' · too long for a class reference, so GIAI only'}</Hint>}
        </div>
        {canManage && <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="namespace-active" />
          <input type="hidden" name="namespaceKey" value={namespace.key} />
          <input type="hidden" name="active" value={namespace.active ? 'false' : 'true'} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>{namespace.active ? 'Deactivate' : 'Reactivate'}</Button>
        </Form>}
        {namespace.classKeyIssuable
          && <ClassKeys namespaceKey={namespace.key} justAdded={justAdded} canManage={canManage}
            classKeys={classKeys
              .filter((classKey) => classKey.namespaceKey === namespace.key)} busy={busy} />}
      </li>)}</ul>}
    {canManage
      ? <Form method="post" preventScrollReset className={inlineForm}>
        <input type="hidden" name="intent" value="namespace" />
        <input type="hidden" name="groupKey" value={groupKey} />
        <Field label="GS1 Company Prefix"
          hint="Four to twelve digits. Restricted-circulation prefix space is not a company prefix and is refused.">
          <Input name="gcp" inputMode="numeric" required /></Field>
        <Field label="Already-used GIAI references"
          hint="Optional. References issued before Kannabi, which it must never allocate.">
          <Input name="giaiExclusions" placeholder="1-4,9-11,200-300" />
        </Field>
        <Button type="submit" disabled={busy}>Configure prefix</Button>
      </Form>
      : <Hint>Configuring a prefix for this Group, and issuing from one, is for its Group Managers.
        Ask <Link to="../people" relative="path">one of them</Link>.</Hint>}
  </Panel>;
}

/** Class keys inside one namespace: the GTINs and GRAI asset types Kannabi may
 * issue serials under.
 *
 * Shown by their own value rather than by a name. A class key here is an
 * allocation record and nothing more — Kannabi holds no product data for it,
 * and giving it a label would make it look like master data it is not.
 */
function ClassKeys({ namespaceKey, classKeys, busy, justAdded, canManage }: {
  namespaceKey: string; classKeys: ManagedClassKey[]; busy: boolean;
  /** The key added a moment ago, highlighted where the reader was working. */
  justAdded: string | null;
  /** Whether this reader manages the Group that manages the prefix. */
  canManage: boolean;
}) {
  return <div className="basis-full">
    <Hint className="mb-2">Class keys under this prefix. Kannabi issues SGTIN serials under a managed
      GTIN and serialised GRAI serials under a managed asset type. A GTIN merely recorded on an Asset
      is not managed here and cannot be serialised.</Hint>
    {!classKeys.length ? <p className="my-2 text-[.85rem]">None yet.</p>
      : <ul className="my-2 grid gap-2">{classKeys.map((classKey) => <li key={classKey.key}
        className={'flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-[.7rem] py-[.5rem]'
          + (justAdded === classKey.key
            ? ' animate-arrival ring-2 ring-brand/45 motion-reduce:animate-none' : '')}>
        <div className="flex flex-wrap items-center gap-2">
          <code>{classKey.canonical}</code>
          <Badge variant="secondary">{classKey.scheme === 'gtin' ? 'GTIN' : 'GRAI asset type'}</Badge>
          <Badge variant={classKey.provenance === 'allocated' ? 'brand' : 'outline'}>
            {classKey.provenance === 'allocated' ? 'Allocated by Kannabi' : 'Adopted'}</Badge>
          <Badge variant={classKey.active ? 'brand' : 'secondary'}>
            {classKey.active ? 'Active' : 'Inactive'}</Badge>
          <Hint>Next serial {classKey.serial.nextSequence}
            {classKey.serial.exclusions.length
              ? ` · existing use ${formatExclusionRanges(classKey.serial.exclusions)}` : ''}</Hint>
        </div>
        {canManage && <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="class-key-active" />
          <input type="hidden" name="namespaceKey" value={namespaceKey} />
          <input type="hidden" name="classKeyKey" value={classKey.key} />
          <input type="hidden" name="active" value={classKey.active ? 'false' : 'true'} />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {classKey.active ? 'Deactivate' : 'Reactivate'}</Button>
        </Form>}
      </li>)}</ul>}
    {/* Two actions, because they are two assertions. Allocating asks Kannabi
        to produce the next reference from this prefix. Adopting tells Kannabi
        that this Group already produced one elsewhere, and hands it only the
        serial space underneath. Collapsing them into one form where an empty
        field meant "allocate" hid exactly the distinction the domain keeps. */}
    {canManage && <div className="mt-4 grid gap-3 md:grid-cols-2">
      <Form method="post" preventScrollReset
        className="rounded-lg border border-dashed p-4 [&_label]:m-0">
        <input type="hidden" name="intent" value="class-key-allocate" />
        <input type="hidden" name="namespaceKey" value={namespaceKey} />
        <h5 className="mt-0 mb-1 text-[.85rem] font-semibold">Allocate a new key</h5>
        <Hint className="mb-3">Kannabi takes the next reference from this prefix and records that it
          allocated it.</Hint>
        <Field label="Kind"><NativeSelect name="scheme">
          <option value="gtin">GTIN — a trade item this Group allocates for</option>
          <option value="grai">GRAI asset type — a series of identical returnable assets</option>
        </NativeSelect></Field>
        <ActionRow><Button type="submit" disabled={busy}>Allocate</Button></ActionRow>
      </Form>
      <Form method="post" preventScrollReset
        className="rounded-lg border border-dashed p-4 [&_label]:m-0">
        <input type="hidden" name="intent" value="class-key-adopt" />
        <input type="hidden" name="namespaceKey" value={namespaceKey} />
        <h5 className="mt-0 mb-1 text-[.85rem] font-semibold">Adopt a key you already allocated</h5>
        <Hint className="mb-3">For a key this Group allocated elsewhere. Kannabi records that it did
          not allocate it and manages only its serials.</Hint>
        <Field label="Kind"><NativeSelect name="scheme">
          <option value="gtin">GTIN</option>
          <option value="grai">GRAI asset type</option>
        </NativeSelect></Field>
        <Field label="Its value" hint="Must lie inside this prefix.">
          <Input name="value" inputMode="numeric" required /></Field>
        <Field label="Serials already used"
          hint="Optional. Decimal serials issued under it elsewhere, which Kannabi must never repeat.">
          <Input name="serialExclusions" placeholder="1-100" /></Field>
        <ActionRow><Button type="submit" variant="outline" disabled={busy}>Adopt</Button></ActionRow>
      </Form>
    </div>}
  </div>;
}

export { GroupViewError as ErrorBoundary };
