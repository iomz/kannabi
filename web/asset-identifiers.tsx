import { useState } from 'react';
import {
  identifierSchemes, levelLabels, schemeDescriptions, schemeInputs, schemeLabels,
  type IdentifierScheme,
} from '../server/gs1.js';
import type { AttachedIdentifier, GiaiAllocation } from '../server/identity-store.js';
import { Icon } from './icon';
import { TransientSuccess } from './transient-success';

export function IdentifierList({ identifiers, canEdit, busy, onDetach }: {
  identifiers: readonly AttachedIdentifier[]; canEdit: boolean; busy: boolean;
  onDetach: (key: string) => void;
}) {
  if (!identifiers.length) {
    return <p>No external identifiers. This Asset is identified by its Asset ID.</p>;
  }
  return <ul className="identifier-list">{identifiers.map((identifier) => <li key={identifier.key}>
    <div className="identifier-body">
      <div className="identifier-heading">
        <strong>{schemeLabels[identifier.scheme]}</strong>
        <span className={'badge ' + (identifier.level === 'individual' ? 'public' : '')}>
          {levelLabels[identifier.level]}
        </span>
      </div>
      <code className="identifier-canonical">{identifier.canonical}</code>
      <dl className="identifier-components">
        {schemeInputs[identifier.scheme]
          .filter((input) => identifier.components[input.name] !== undefined)
          .map((input) => <div key={input.name}>
            <dt>{input.label}</dt><dd>{identifier.components[input.name]}</dd>
          </div>)}
      </dl>
      <span className="identifier-policy">GS1 policy {identifier.policyVersion}</span>
    </div>
    {canEdit && <button type="button" className="photo-delete" disabled={busy}
      aria-label={'Detach ' + schemeLabels[identifier.scheme] + ' ' + identifier.canonical}
      onClick={() => onDetach(identifier.key)}><Icon name="trash" /></button>}
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
    return <p className="giai-provenance">Kannabi issued <code>{allocation.value}</code> for this Asset
      from prefix <code>{allocation.gcp}</code> as reference {allocation.sequence}.</p>;
  }
  if (!namespaces.length) {
    return <p className="hint">This Asset’s Group has no active GS1 Company Prefix, so Kannabi cannot
      allocate a GIAI for it. Configure one from Groups.</p>;
  }
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="allocate-giai" />
    {namespaces.length === 1
      ? <input type="hidden" name="namespaceKey" value={namespaces[0].key} />
      : <label>GS1 Company Prefix<select name="namespaceKey">
        {namespaces.map((namespace) =>
          <option key={namespace.key} value={namespace.key}>{namespace.gcp}</option>)}
      </select></label>}
    {error && <p role="alert">{error}</p>}
    <div className="asset-action-row"><button>{busy ? 'Allocating…' : 'Allocate GIAI'}</button>
      <div className="asset-action-status" role="status" aria-live="polite" aria-atomic="true">
        <TransientSuccess trigger={saved} label="Allocated" />
      </div>
    </div>
  </fieldset>;
}

export function IdentifierForm({ busy, error, saved }: {
  busy: boolean; error: string | null; saved: string | null;
}) {
  const [scheme, setScheme] = useState<IdentifierScheme>('sgtin');
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="attach-identifier" />
    <label>Identifier scheme
      <select name="scheme" value={scheme} onChange={(event) => setScheme(event.target.value as IdentifierScheme)}>
        {identifierSchemes.map((value) =>
          <option key={value} value={value}>{schemeLabels[value]} — {schemeDescriptions[value]}</option>)}
      </select>
    </label>
    {schemeInputs[scheme].map((input) => <label key={input.name}>
      {input.label}{input.required ? '' : ' (optional)'}
      <input name={input.name} required={input.required} maxLength={input.maxLength}
        inputMode={input.numeric ? 'numeric' : undefined} />
      {input.hint && <span className="hint">{input.hint}</span>}
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div className="asset-action-row"><button>{busy ? 'Adding…' : 'Add identifier'}</button>
      <div className="asset-action-status" role="status" aria-live="polite" aria-atomic="true">
        <TransientSuccess trigger={saved} label="Added" />
      </div>
    </div>
  </fieldset>;
}
