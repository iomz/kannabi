import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  classKeyConflictReason, identifierSchemes, schemeDescriptions, schemeInputs, schemeLabels,
  type IdentifierLevel, type IdentifierScheme,
} from '../server/gs1.js';
import type { AttachedIdentifier, Gs1KeyIssuance } from '../server/identity-store.js';
import { Icon } from './icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { ActionRow, Field, HelpTip, Hint, IconButton, NativeSelect, SubHeading } from './ui';

/** The scheme, with what it identifies available on demand.
 *
 * The name is the fact and stays plainly readable; what the scheme means and
 * what level it identifies at is the explanation, and goes where every other
 * explanation on this page goes. It used to hang off a dotted underline on the
 * name itself, which asked a reader to discover that the word was also a
 * control.
 */
function SchemeName({ scheme }: { scheme: IdentifierScheme }) {
  // One source, one sentence. `schemeDescriptions` already states what the
  // scheme identifies, so also appending the level said it twice: "Serialised
  // trade item — identifies this Asset. Identifies this Asset."
  return <span className="inline-flex items-center gap-1">
    <span className="font-semibold">{schemeLabels[scheme]}</span>
    <HelpTip label={'About ' + schemeLabels[scheme]}>{schemeDescriptions[scheme]}.</HelpTip>
  </span>;
}

export function IdentifierList({ identifiers, issuances, digitalLinks, showPolicyVersion, canEdit, busy, justIssued, onDetach }: {
  identifiers: readonly AttachedIdentifier[];
  /** The canonical form of an identifier issued a moment ago, highlighted so a
   * successful issuance is visible where the reader was already looking. */
  justIssued?: string | null;
  /** Kannabi's own issuance records for this Asset, at most one per scheme.
   * An identifier is Kannabi-issued when one of these carries its canonical
   * form — never because its digits fall inside a managed prefix. */
  issuances: readonly Gs1KeyIssuance[];
  /** The Digital Link URI for each identifier Kannabi also dereferences,
   * keyed by attachment. A class-level identifier has none: its URI is
   * constructible, and Kannabi does not answer it. */
  digitalLinks: Readonly<Record<string, string>>;
  showPolicyVersion: boolean;
  canEdit: boolean; busy: boolean;
  onDetach: (key: string) => void;
}) {
  if (!identifiers.length) return null;
  return <ul className="mb-6 grid gap-3">{identifiers.map((identifier) => {
    // One rule for every scheme: the ledger row carries the whole canonical
    // form, so nothing here compares a scheme-specific component.
    const issued = issuances.find((issuance) => issuance.canonical === identifier.canonical) ?? null;
    return <li key={identifier.key}
      className={'relative rounded-lg border bg-muted py-[.85rem] pr-12 pl-4'
        + (justIssued === identifier.canonical
          ? ' animate-arrival ring-2 ring-brand/45 motion-reduce:animate-none' : '')}>
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The scheme carries its own explanation rather than spelling the
            level out beside the provenance badge, where two sentences of
            different kinds ran together. */}
        <SchemeName scheme={identifier.scheme} />
        <Badge variant={issued ? 'brand' : 'outline'}>
          {issued ? 'Issued by Kannabi' : 'Recorded existing'}</Badge>
      </div>
      <code className="mt-[.35rem] block break-all">{identifier.canonical}</code>
      <dl className="mt-2 mb-0 flex flex-wrap gap-x-5 gap-y-1 [&_dd]:m-0 [&_dd]:break-all [&_dt]:text-[.75rem] [&_dt]:text-muted-foreground">
        {schemeInputs[identifier.scheme]
          .filter((input) => identifier.components[input.name] !== undefined)
          .map((input) => <div key={input.name}>
            <dt>{input.label}</dt><dd>{identifier.components[input.name]}</dd>
          </div>)}
        {digitalLinks[identifier.key] && <div>
          <dt>GS1 Digital Link</dt>
          <dd><a href={digitalLinks[identifier.key]}>{digitalLinks[identifier.key]}</a></dd>
        </div>}
      </dl>
      {issued && <p className="mt-2 text-[.82rem] text-muted-foreground">
        Issued from managed prefix <code>{issued.gcp}</code>
        {issued.classKeyCanonical
          ? <> under class key <code>{issued.classKeyCanonical}</code> as serial <code>{issued.sequence}</code>.</>
          : <> as reference <code>{issued.sequence}</code>.</>}</p>}
      {showPolicyVersion && <span className="mt-2 block text-[.72rem] text-muted-foreground">GS1 policy {identifier.policyVersion}</span>}
    </div>
    {/* An identifier is identity, not a mutable label, so the way to remove one
        does not sit beside it wearing a destructive box. The warning arrives on
        hover and focus, and the act itself asks first. */}
    {canEdit && <IconButton tone="destructive" disabled={busy}
      className="absolute top-[.5rem] right-[.5rem]"
      label={'Detach ' + schemeLabels[identifier.scheme] + ' ' + identifier.canonical}
      onClick={() => onDetach(identifier.key)}><Icon name="trash" /></IconButton>}
    </li>;
  })}</ul>;
}

/** A class key an Asset's issuance controls can serialise under, flattened
 * across every namespace the actor may issue from. */
export type IssuableClassKey = {
  key: string; namespaceKey: string; gcp: string; scheme: 'grai' | 'gtin'; canonical: string;
};

/** What each issuance scheme needs before Kannabi can produce a value.
 *
 * Each `hint` describes its own scheme and nothing else. The GIAI sentence
 * used to stand alone above the control with no stated referent, where it read
 * as a claim about issuance in general; allocation straight from the company
 * prefix is true of a GIAI and of neither of the others.
 */
const issuanceOptions = [
  { scheme: 'giai' as const, label: 'GIAI', classScheme: null,
    hint: 'Allocated straight from the company prefix. Identifies this Asset as an individual asset.' },
  { scheme: 'grai' as const, label: 'Serialised GRAI', classScheme: 'grai' as const,
    hint: 'A serial under a managed GRAI asset type, which names a series of identical returnable assets.' },
  { scheme: 'sgtin' as const, label: 'SGTIN', classScheme: 'gtin' as const,
    hint: 'A serial under a managed GTIN. Only a GTIN this Group manages in its own prefix can be serialised; a GTIN merely recorded on an Asset cannot.' },
];

/** Issuance is offered only with an active namespace managed by a
 * collaborating Group the actor belongs to, and for GRAI and SGTIN only with
 * an active class key inside one. Once a scheme has been issued, provenance
 * replaces its control: issuance is idempotent per scheme, so there is no
 * second value of that scheme to offer — and no bar to issuing another scheme.
 */
export function IssueIdentifier({ namespaces, classKeys, issuances, identifiers, busy, error }: {
  namespaces: readonly { key: string; gcp: string }[];
  classKeys: readonly IssuableClassKey[];
  issuances: readonly Gs1KeyIssuance[];
  identifiers: readonly AttachedIdentifier[];
  busy: boolean; error: string | null;
}) {
  const issued = new Map(issuances.map((issuance) => [issuance.scheme, issuance]));
  // A class key this Asset could actually be serialised under. An Asset is an
  // instance of at most one trade item and a member of at most one GRAI
  // asset-type series, so a key naming a different one would be refused at the
  // boundary; asking the boundary in advance is what stops the UI offering a
  // choice it already knows cannot succeed.
  const usable = (classKey: IssuableClassKey) =>
    classKeyConflictReason(classKey, identifiers) === null;
  const available = issuanceOptions.filter((option) => !issued.has(option.scheme)
    && (option.classScheme === null
      ? namespaces.length > 0
      : classKeys.some((classKey) => classKey.scheme === option.classScheme && usable(classKey))));
  const [scheme, setScheme] = useState(available[0]?.scheme ?? 'giai');
  const option = issuanceOptions.find((entry) => entry.scheme === scheme) ?? issuanceOptions[0];
  const eligible = option.classScheme === null ? []
    : classKeys.filter((classKey) => classKey.scheme === option.classScheme && usable(classKey));
  // Why a scheme that has a managed class key is still not on offer, taken
  // from the boundary rather than worded again here.
  const blocked = issuanceOptions.flatMap((entry) => {
    if (issued.has(entry.scheme) || entry.classScheme === null) return [];
    if (available.some((offer) => offer.scheme === entry.scheme)) return [];
    const conflict = classKeys
      .filter((classKey) => classKey.scheme === entry.classScheme)
      .map((classKey) => classKeyConflictReason(classKey, identifiers))
      .find((reason) => reason !== null);
    return conflict ? [{ label: entry.label, reason: conflict }] : [];
  });
  const [classKeyKey, setClassKeyKey] = useState(eligible[0]?.key ?? '');
  const selected = eligible.find((classKey) => classKey.key === classKeyKey) ?? eligible[0];
  const detached = issuances.filter((issuance) =>
    !identifiers.some((identifier) => identifier.canonical === issuance.canonical));
  return <>
    {detached.map((issuance) => <Hint key={issuance.key}>Kannabi-issued <code>{issuance.canonical}</code> is
      not currently recorded on this Asset. It stays bound to this Asset in the issuance ledger and is never reissued elsewhere.</Hint>)}
    {!available.length
      ? <Hint>{blocked.length
        ? <>No identifiers can currently be issued for this Asset.{' '}
          {blocked.map((entry) => `${entry.label}: ${entry.reason}.`).join(' ')}</>
        : issued.size >= issuanceOptions.length
          ? 'Kannabi has issued every identifier it can for this Asset.'
          : namespaces.length === 0
            ? <>Kannabi can issue nothing for this Asset yet: no collaborating Group you belong to has an
              active GS1 Company Prefix. <Link to="/groups">Configure one under Groups</Link>, then come back.</>
            : <>A serialised GRAI or an SGTIN is issued under a managed class key, and this Asset’s
              prefixes have no active one yet. <Link to="/groups">Allocate or adopt a class key under
              Groups</Link>, then come back to issue from it.</>}</Hint>
      : <fieldset disabled={busy} aria-busy={busy}>
        <input type="hidden" name="intent" value="issue-identifier" />
        <input type="hidden" name="scheme" value={scheme} />
        {available.length > 1
          ? <Field label={<>Choose the identifier scheme
            <HelpTip label={'About issuing a ' + option.label}>{option.hint}</HelpTip></>}>
            <NativeSelect value={scheme} onChange={(event) =>
              setScheme(event.target.value as typeof scheme)}>
              {available.map((entry) =>
                <option key={entry.scheme} value={entry.scheme}>{entry.label}</option>)}
            </NativeSelect>
          </Field>
          : <p className="mt-0 mb-4 flex items-center gap-1 text-[.875rem]">
            {option.label}
            <HelpTip label={'About issuing a ' + option.label}>{option.hint}</HelpTip>
          </p>}
        {option.classScheme === null ? (namespaces.length === 1
          ? <input type="hidden" name="namespaceKey" value={namespaces[0].key} />
          : <Field label="GS1 Company Prefix"><NativeSelect name="namespaceKey">
            {namespaces.map((namespace) =>
              <option key={namespace.key} value={namespace.key}>{namespace.gcp}</option>)}
          </NativeSelect></Field>)
          : <>
            <input type="hidden" name="namespaceKey" value={selected?.namespaceKey ?? ''} />
            <input type="hidden" name="classKeyKey" value={selected?.key ?? ''} />
            <Field label={option.classScheme === 'grai' ? 'Managed GRAI asset type' : 'Managed GTIN'}
              hint="Managed class keys are allocation records. Kannabi holds no product data for them.">
              <NativeSelect value={selected?.key ?? ''}
                onChange={(event) => setClassKeyKey(event.target.value)}>
                {eligible.map((classKey) => <option key={classKey.key} value={classKey.key}>
                  {classKey.gcp} · {classKey.canonical}</option>)}
              </NativeSelect>
            </Field>
          </>}
        {error && <p role="alert">{error}</p>}
        <ActionRow><Button type="submit">{busy ? 'Issuing…' : 'Issue ' + option.label}</Button></ActionRow>
      </fieldset>}
  </>;
}

export function IdentifierForm({ busy, error }: {
  busy: boolean; error: string | null;
}) {
  const [scheme, setScheme] = useState<IdentifierScheme>('sgtin');
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="attach-identifier" />
    <Field label="Choose the identifier scheme">
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
    {/* Not "Record existing": that is the tab a reader is already standing on,
        and two controls with one name in the same section is ambiguous for a
        person and for anything reading by accessible name. */}
    <ActionRow><Button type="submit">{busy ? 'Recording…' : 'Record identifier'}</Button></ActionRow>
  </fieldset>;
}

/** The two ways an identifier arrives, behind one folded heading.
 *
 * Both forms used to stand open under the recorded identifiers, so a page
 * opened to read one Asset presented two sets of fields nobody had asked for.
 * They are operations, and they wait until somebody wants to perform one.
 *
 * The choice comes before either form because the two are not variants of one
 * act: issuing exercises allocation authority Kannabi holds, recording states
 * that some other authority already assigned a value. Showing both at once
 * invited reading them as one form with two submit buttons, and the separation
 * is what now carries a distinction that used to need a paragraph.
 *
 * Radios rather than tabs: this is a choice between two named things, the
 * browser already groups and labels them, and the selected one is announced.
 */
export function AddIdentifier({ issue, record }: { issue: ReactNode; record: ReactNode }) {
  return <details className="mt-6 [&>summary]:cursor-pointer [&[open]>summary]:mb-4">
    <summary><SubHeading className="mt-0 mb-0 inline">Add identifier</SubHeading></summary>
    {/* Two operations, one at a time. Radios beside their own help buttons read
        as four similar round controls; tabs say "these are two modes of one
        thing", which is what they are. The primitive carries the roles, the
        arrow keys and the panel association. */}
    <Tabs defaultValue="issue">
      <TabsList>
        <TabsTab value="issue">Issue new</TabsTab>
        <TabsTab value="record">Record existing</TabsTab>
      </TabsList>
      {/* One sentence each, in normal prose. Which tab a reader chose already
          carries the distinction that used to need a paragraph: issuing
          exercises allocation authority Kannabi holds, recording states that
          another authority already assigned the value. */}
      <TabsPanel value="issue">
        <Hint className="mt-0 mb-4">Issue an identifier under a GS1 Company Prefix namespace
          managed by one of this Asset’s Groups.</Hint>
        {issue}
      </TabsPanel>
      <TabsPanel value="record">
        <Hint className="mt-0 mb-4">Record an identifier that has already been assigned outside
          Kannabi.</Hint>
        {record}
      </TabsPanel>
    </Tabs>
  </details>;
}
