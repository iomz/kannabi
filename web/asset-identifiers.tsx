import { useState } from 'react';
import {
  identifierSchemes, levelLabels, schemeDescriptions, schemeInputs, schemeLabels,
  type IdentifierScheme,
} from '../server/gs1.js';
import type { AttachedIdentifier, GiaiAllocation } from '../server/identity-store.js';
import { Icon } from './icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, Field, Hint, NativeSelect } from './ui';

export function IdentifierList({ identifiers, allocation, showPolicyVersion, canEdit, busy, onDetach }: {
  identifiers: readonly AttachedIdentifier[]; allocation: GiaiAllocation | null; showPolicyVersion: boolean;
  canEdit: boolean; busy: boolean;
  onDetach: (key: string) => void;
}) {
  if (!identifiers.length) {
    return <p>No identifiers recorded. This Asset’s native Kannabi identity is its Asset ID.</p>;
  }
  return <ul className="mb-6 grid gap-3">{identifiers.map((identifier) => <li key={identifier.key}
    className="relative rounded-lg border bg-muted py-[.85rem] pr-12 pl-4">
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{schemeLabels[identifier.scheme]}</strong>
        <Badge variant={identifier.level === 'individual' ? 'brand' : 'secondary'}>
          {levelLabels[identifier.level]}
        </Badge>
        <Badge variant={identifier.scheme === 'giai' && identifier.components.assetReference === allocation?.value
          ? 'brand' : 'outline'}>{identifier.scheme === 'giai'
            && identifier.components.assetReference === allocation?.value ? 'Issued by Kannabi' : 'Recorded existing'}</Badge>
      </div>
      <code className="mt-[.35rem] block break-all">{identifier.canonical}</code>
      <dl className="mt-2 mb-0 flex flex-wrap gap-x-5 gap-y-1 [&_dd]:m-0 [&_dd]:break-all [&_dt]:text-[.75rem] [&_dt]:text-muted-foreground">
        {schemeInputs[identifier.scheme]
          .filter((input) => identifier.components[input.name] !== undefined)
          .map((input) => <div key={input.name}>
            <dt>{input.label}</dt><dd>{identifier.components[input.name]}</dd>
          </div>)}
      </dl>
      {identifier.scheme === 'giai' && identifier.components.assetReference === allocation?.value &&
        <p className="mt-2 text-[.82rem] text-muted-foreground">Issued from managed prefix <code>{allocation.gcp}</code>
          {' '}as reference <code>{allocation.sequence}</code>.</p>}
      {showPolicyVersion && <span className="mt-2 block text-[.72rem] text-muted-foreground">GS1 policy {identifier.policyVersion}</span>}
    </div>
    {canEdit && <Button type="button" variant="outline" size="icon-sm" disabled={busy}
      className="absolute top-[.6rem] right-[.6rem] bg-card text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive [&_.icon]:size-4"
      aria-label={'Detach ' + schemeLabels[identifier.scheme] + ' ' + identifier.canonical}
      onClick={() => onDetach(identifier.key)}><Icon name="trash" /></Button>}
  </li>)}</ul>;
}

/** Allocation is offered only with an active namespace managed by a
 * collaborating Group the actor belongs to. Once issued, provenance replaces the control:
 * there is no second allocation to offer. */
export function AllocateGiai({ namespaces, allocation, allocationAttached, busy, error }: {
  namespaces: readonly { key: string; gcp: string }[];
  allocation: GiaiAllocation | null;
  allocationAttached: boolean; busy: boolean; error: string | null;
}) {
  if (allocation) {
    return allocationAttached ? null : <Hint>Kannabi-issued GIAI <code>{allocation.value}</code> is not currently recorded
      on this Asset.</Hint>;
  }
  if (!namespaces.length) {
    return <Hint>You have no eligible active GS1 Company Prefix for issuing a GIAI for this Asset.
      The prefix must be managed by a collaborating Group you belong to. Manage prefixes from Groups.</Hint>;
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
    <ActionRow><Button type="submit">{busy ? 'Issuing…' : 'Issue GIAI'}</Button></ActionRow>
  </fieldset>;
}

export function IdentifierForm({ busy, error }: {
  busy: boolean; error: string | null;
}) {
  const [scheme, setScheme] = useState<IdentifierScheme>('sgtin');
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="attach-identifier" />
    <Hint>Record an existing identifier already assigned by an external authority. This form never issues identifiers. Use **Issue GIAI** above to have Kannabi issue a GIAI under an eligible managed prefix.</Hint>
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
    <ActionRow><Button type="submit">{busy ? 'Recording…' : 'Record existing identifier'}</Button></ActionRow>
  </fieldset>;
}
