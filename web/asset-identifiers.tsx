import { useState, type ReactNode } from 'react';
import type { AttachedIdentifier } from '../server/identity-store.js';
import { web } from './plugins';
import type { IdentifierStanding } from './plugin';
import { displayInstant } from '../server/settings.js';
import { Icon } from './icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { ActionRow, Field, Hint, IconButton, NativeSelect, SubHeading } from './ui';

/** The scheme, and where it is defined.
 *
 * A scheme is not a Kannabi concept, so it does not take Kannabi's help
 * affordance. What an identifier of a scheme is belongs to whoever defines the
 * scheme: where the plugin that presents it names a reference, the name links
 * there, which is more honest than Kannabi paraphrasing a standard it does not
 * own. The one-line description stays beside it as orientation, not as
 * definition.
 */
function SchemeName({ scheme }: { scheme: string }) {
  const presented = web.scheme(scheme);
  // A scheme no installed plugin presents is named by its id and nothing more.
  if (!presented) return <span className="font-semibold">{scheme}</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-x-2">
    {/* The link treatment carries it. An outbound glyph beside every scheme on
        every card was tested and read as clutter: four of them on one Asset
        decorate the names rather than telling a reader anything the colour and
        the underline on hover do not. The accessible name still says where it
        goes and that it opens elsewhere. */}
    {presented.reference
      ? <a href={presented.reference.href} target="_blank" rel="noreferrer noopener"
        aria-label={presented.label + ' — ' + presented.reference.label + ' (opens in a new tab)'}
        className="font-semibold no-underline hover:underline">
        {presented.label}
      </a>
      : <span className="font-semibold">{presented.label}</span>}
    <span className="text-[.8rem] text-muted-foreground">{presented.description}</span>
  </span>;
}

export function IdentifierList({ identifiers, standing, digitalLinks, showPolicyVersion, canEdit, busy, justIssued, onDetach,
  displayTimezone = 'UTC' }: {
  identifiers: readonly AttachedIdentifier[];
  /** The instance display timezone, for when each identifier was accepted. */
  displayTimezone?: string;
  /** The canonical form of an identifier issued a moment ago, highlighted so a
   * successful issuance is visible where the reader was already looking. */
  justIssued?: string | null;
  /** What an installed plugin says about one of these identifiers, or null
   * when none says anything: then it is simply a recorded one. */
  standing: (identifier: AttachedIdentifier) => IdentifierStanding | null;
  /** The address of each identifier Kannabi also dereferences, keyed by
   * attachment. An identifier whose scheme supplies none has no entry. */
  digitalLinks: Readonly<Record<string, string>>;
  showPolicyVersion: boolean;
  canEdit: boolean; busy: boolean;
  onDetach: (key: string) => void;
}) {
  if (!identifiers.length) return null;
  return <ul className="mb-6 grid gap-3">{identifiers.map((identifier) => {
    const said = standing(identifier);
    const presented = web.scheme(identifier.scheme);
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
        <Badge variant={said ? 'brand' : 'outline'}>{said?.badge ?? 'Recorded existing'}</Badge>
      </div>
      <code className="mt-[.35rem] block break-all">{identifier.canonical}</code>
      <dl className="mt-2 mb-0 flex flex-wrap gap-x-5 gap-y-1 [&_dd]:m-0 [&_dd]:break-all [&_dt]:text-[.75rem] [&_dt]:text-muted-foreground">
        {(presented?.inputs ?? [])
          .filter((input) => identifier.components[input.name] !== undefined)
          .map((input) => <div key={input.name}>
            <dt>{input.label}</dt><dd>{identifier.components[input.name]}</dd>
          </div>)}
        {digitalLinks[identifier.key] && <div>
          <dt>{presented?.addressLabel ?? 'Address'}</dt>
          <dd><a href={digitalLinks[identifier.key]}>{digitalLinks[identifier.key]}</a></dd>
        </div>}
      </dl>
      {said && <p className="mt-2 text-[.82rem] text-muted-foreground">{said.note}</p>}
      {/* Who accepted this identifier onto the Asset and on what stated
          basis. An acceptance, not a verification, and not issuance, which
          only the plugin that issued a value describes, in the line above. Absent for an association recorded
          before Kannabi kept this, and then nothing is claimed instead. */}
      {identifier.attachment && <p className="mt-2 mb-0 text-[.82rem] text-muted-foreground">
        Accepted by {identifier.attachment.acceptedBy.name}
        {identifier.attachment.acceptedBy.status === 'deleted' ? ' (deleted account)' : ''}
        {identifier.attachment.assertedBy ? <> via <q>{identifier.attachment.assertedBy.label}</q></> : null}
        {' · '}<time dateTime={identifier.attachment.acceptedAt}>
          {displayInstant(identifier.attachment.acceptedAt, displayTimezone)}</time>
        {identifier.attachment.basis ? <> · basis <code className="break-all">{identifier.attachment.basis}</code></> : null}
      </p>}
      {showPolicyVersion && <span className="mt-2 block text-[.72rem] text-muted-foreground">
        {presented?.policyLabel ?? 'Policy'} {identifier.policyVersion}</span>}
    </div>
    {/* An identifier is identity, not a mutable label, so the way to remove one
        does not sit beside it wearing a destructive box. The warning arrives on
        hover and focus, and the act itself asks first. */}
    {canEdit && <IconButton tone="destructive" disabled={busy}
      className="absolute top-[.5rem] right-[.5rem]"
      label={'Detach ' + web.schemeLabel(identifier.scheme) + ' ' + identifier.canonical}
      onClick={() => onDetach(identifier.key)}><Icon name="trash" /></IconButton>}
    </li>;
  })}</ul>;
}

export function IdentifierForm({ busy, error }: {
  busy: boolean; error: string | null;
}) {
  // The scheme a person most often has in hand is offered first where it is
  // installed; otherwise the first installed one.
  const [scheme, setScheme] = useState(web.scheme('sgtin')?.id ?? web.schemes[0]?.id ?? '');
  return <fieldset disabled={busy} aria-busy={busy}>
    <input type="hidden" name="intent" value="attach-identifier" />
    <Field label="Choose the identifier scheme">
      <NativeSelect name="scheme" value={scheme} onChange={(event) => setScheme(event.target.value)}>
        {web.schemes.map((value) =>
          <option key={value.id} value={value.id}>{value.label} — {value.description}</option>)}
      </NativeSelect>
    </Field>
    {(web.scheme(scheme)?.inputs ?? []).map((input) => <Field key={input.name} hint={input.hint}
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
export function AddIdentifier({ panels, record }: {
  /** The ways of adding an identifier an installed plugin contributes, such
   * as issuing one. Each owns its own lead sentence: only the panel knows
   * whether what it offers is possible. */
  panels: readonly Readonly<{ id: string; label: string; content: ReactNode }>[];
  /** The form recording an identifier assigned elsewhere, or null when no
   * identifier scheme is installed to record one in. */
  record: ReactNode | null;
}) {
  if (!panels.length && record === null) return null;
  return <details className="mt-6 [&>summary]:cursor-pointer [&[open]>summary]:mb-4">
    <summary><SubHeading className="mt-0 mb-0 inline">Add identifier</SubHeading></summary>
    {/* Operations, one at a time. Radios beside their own help buttons read
        as similar round controls; tabs say "these are modes of one thing",
        which is what they are. The primitive carries the roles, the arrow
        keys and the panel association. */}
    <Tabs defaultValue={panels[0]?.id ?? 'record'}>
      <TabsList>
        {panels.map((panel) => <TabsTab key={panel.id} value={panel.id}>{panel.label}</TabsTab>)}
        {record !== null && <TabsTab value="record">Record existing</TabsTab>}
      </TabsList>
      {panels.map((panel) => <TabsPanel key={panel.id} value={panel.id}>{panel.content}</TabsPanel>)}
      {record !== null && <TabsPanel value="record">
        <Hint className="mt-0 mb-4">Record an identifier that has already been assigned outside
          Kannabi.</Hint>
        {record}
      </TabsPanel>}
    </Tabs>
  </details>;
}
