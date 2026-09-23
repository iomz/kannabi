import { useState } from 'react';
import {
  identifierSchemes, levelLabels, schemeDescriptions, schemeInputs, schemeLabels,
  type IdentifierScheme,
} from '../server/gs1.js';
import type { AttachedIdentifier, GiaiAllocation } from '../server/identity-store.js';
import { Icon } from './icon';
import { TransientSuccess } from './transient-success';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, ActionStatus, Field, Hint, NativeSelect } from './ui';

export function IdentifierList({ identifiers, canEdit, busy, onDetach }: {
  identifiers: readonly AttachedIdentifier[]; canEdit: boolean; busy: boolean;
  onDetach: (key: string) => void;
}) {
  if (!identifiers.length) {
    return <p>No external identifiers. This Asset is identified by its Asset ID.</p>;
  }
  return <ul className="mb-6 grid gap-3">{identifiers.map((identifier) => <li key={identifier.key}
    className="relative rounded-lg border bg-muted py-[.85rem] pr-12 pl-4">
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{schemeLabels[identifier.scheme]}</strong>
        <Badge variant={identifier.level === 'individual' ? 'default' : 'secondary'}>
          {levelLabels[identifier.level]}
        </Badge>
      </div>
      <code className="mt-[.35rem] block break-all">{identifier.canonical}</code>
      <dl className="mt-2 mb-0 flex flex-wrap gap-x-5 gap-y-1 [&_dd]:m-0 [&_dd]:break-all [&_dt]:text-[.75rem] [&_dt]:text-muted-foreground">
        {schemeInputs[identifier.scheme]
          .filter((input) => identifier.components[input.name] !== undefined)
          .map((input) => <div key={input.name}>
            <dt>{input.label}</dt><dd>{identifier.components[input.name]}</dd>
          </div>)}
      </dl>
      <span className="mt-2 block text-[.72rem] text-muted-foreground">GS1 policy {identifier.policyVersion}</span>
    </div>
    {canEdit && <Button type="button" variant="outline" size="icon-sm" disabled={busy}
      className="absolute top-[.6rem] right-[.6rem] bg-card text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive [&_.icon]:size-4"
      aria-label={'Detach ' + schemeLabels[identifier.scheme] + ' ' + identifier.canonical}
      onClick={() => onDetach(identifier.key)}><Icon name="trash" /></Button>}
  </li>)}</ul>;
}

/** Allocation is offered only when the Asset's Group actually manages an active
 * namespace. Once Kannabi has issued one, provenance replaces the control:
 * there is no second allocation to offer. */
export function AllocateGiai({ namespaces, allocation, busy, error, saved }: {
  namespaces: readonly { key: string; gcp: string }[];
  allocation: GiaiAllocation | null;
  busy: boolean; error: string | null; saved: string | null;
}) {
  if (allocation) {
    return <p className="mt-0 mb-6 text-[.85rem] text-muted-foreground">Kannabi issued <code>{allocation.value}</code> for
      this Asset from prefix <code>{allocation.gcp}</code> as reference {allocation.sequence}.</p>;
  }
  if (!namespaces.length) {
    return <Hint>This Asset’s Group has no active GS1 Company Prefix, so Kannabi cannot
      allocate a GIAI for it. Configure one from Groups.</Hint>;
  }
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="allocate-giai" />
    {namespaces.length === 1
      ? <input type="hidden" name="namespaceKey" value={namespaces[0].key} />
      : <Field label="GS1 Company Prefix"><NativeSelect name="namespaceKey">
        {namespaces.map((namespace) =>
          <option key={namespace.key} value={namespace.key}>{namespace.gcp}</option>)}
      </NativeSelect></Field>}
    {error && <p role="alert">{error}</p>}
    <ActionRow><Button>{busy ? 'Allocating…' : 'Allocate GIAI'}</Button>
      <ActionStatus className="w-26"><TransientSuccess trigger={saved} label="Allocated" /></ActionStatus>
    </ActionRow>
  </fieldset>;
}

export function IdentifierForm({ busy, error, saved }: {
  busy: boolean; error: string | null; saved: string | null;
}) {
  const [scheme, setScheme] = useState<IdentifierScheme>('sgtin');
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="attach-identifier" />
    <Field label="Identifier scheme">
      <NativeSelect name="scheme" value={scheme} onChange={(event) => setScheme(event.target.value as IdentifierScheme)}>
        {identifierSchemes.map((value) =>
          <option key={value} value={value}>{schemeLabels[value]} — {schemeDescriptions[value]}</option>)}
      </NativeSelect>
    </Field>
    {schemeInputs[scheme].map((input) => <Field key={input.name} hint={input.hint}
      label={input.label + (input.required ? '' : ' (optional)')}>
      <Input name={input.name} required={input.required} maxLength={input.maxLength}
        inputMode={input.numeric ? 'numeric' : undefined} />
    </Field>)}
    {error && <p role="alert">{error}</p>}
    <ActionRow><Button>{busy ? 'Adding…' : 'Add identifier'}</Button>
      <ActionStatus className="w-26"><TransientSuccess trigger={saved} label="Added" /></ActionStatus>
    </ActionRow>
  </fieldset>;
}
