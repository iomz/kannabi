import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { unwrap } from '../../../web/api';
import type {
  AddressedAsset, AssetPageContext, AssetPageSlot, CarriedIdentifier, IdentifierStanding,
} from '../../../web/plugin';
import { ActionRow, Field, HelpTip, Hint, NativeSelect } from '../../../web/ui';
import type { Gs1KeyIssuance, Gs1Settings } from '../adapter/store.js';
import { classKeyConflictReason } from '../toolkit/gs1.js';
import { gs1Api } from './api';

/** What the GS1 plugin shows on an Asset page: the ledger rows bound to the
 * Asset, the acceptance policy its issuance controls must agree with, and the
 * namespaces and class keys this reader could issue from. */
export type Gs1AssetData = Readonly<{
  issuances: readonly Gs1KeyIssuance[];
  settings: Gs1Settings;
  namespaces: readonly { key: string; gcp: string }[];
  classKeys: readonly IssuableClassKey[];
}>;

export async function loadGs1AssetData(context: AssetPageContext): Promise<Gs1AssetData> {
  const [{ issuances }, { settings }] = await Promise.all([
    unwrap(await gs1Api.assets[':id'].issuances.$get({ param: { id: context.asset.id } })),
    unwrap(await gs1Api.settings.$get()),
  ]);
  // A waiting account or a visitor has no Groups or namespaces yet, and the
  // server refuses to list them. Display only either way: the server re-checks
  // the Group join on every issuance.
  const { namespaces } = context.participant
    ? await unwrap(await gs1Api.namespaces.$get()) : { namespaces: [] };
  // Only namespaces this Asset's Groups manage, only active ones, and only
  // those whose managing Group this reader is a Group Manager of. Issuing is
  // authority over what a Group manages, so membership alone does not carry
  // it (#20); a member can still see the namespace and still cannot issue
  // from it. The server re-checks the Group join, the control and the active
  // state on every issuance; this narrows what is offered, never what is
  // permitted.
  const eligible = namespaces.filter((namespace) =>
    namespace.active && namespace.group && context.assetGroups.includes(namespace.group.key)
    && context.managedGroups.includes(namespace.group.key));
  // The class keys those namespaces manage, flattened with the prefix each
  // belongs to, so a serialised GRAI or an SGTIN can name the one it is
  // issued under. Inactive class keys are left out for the same reason
  // inactive namespaces are.
  const classKeys = (await Promise.all(eligible.map(async (namespace) => {
    const { classKeys: managed } = await unwrap(
      await gs1Api.namespaces[':key']['class-keys'].$get({
        param: { key: namespace.key }, query: { scheme: undefined } }));
    return managed.filter((classKey) => classKey.active).map((classKey) => ({
      key: classKey.key, namespaceKey: namespace.key, gcp: namespace.gcp,
      scheme: classKey.scheme, canonical: classKey.canonical,
    }));
  }))).flat();
  return { issuances, settings, classKeys,
    namespaces: eligible.map((namespace) => ({ key: namespace.key, gcp: namespace.gcp })) };
}

/** An identifier is Kannabi-issued when the ledger carries its canonical form
 * — never because its digits fall inside a managed prefix. One rule for every
 * scheme, so nothing here compares a scheme-specific component. */
export function issuedStanding(issuances: readonly Gs1KeyIssuance[],
  identifier: CarriedIdentifier): IdentifierStanding | null {
  const issued = issuances.find((issuance) => issuance.canonical === identifier.canonical);
  if (!issued) return null;
  return {
    badge: 'Issued by Kannabi',
    note: <>Issued from managed prefix <code>{issued.gcp}</code>
      {issued.classKeyCanonical
        ? <> under class key <code>{issued.classKeyCanonical}</code> as serial <code>{issued.sequence}</code>.</>
        : <> as reference <code>{issued.sequence}</code>.</>}</>,
    // Detaching an issued value is not a release, and the dialog says so
    // rather than letting somebody infer that the number returns to a pool.
    detachConsequence: 'Kannabi issued this value, so it stays bound to this Asset in the issuance ledger and is never issued for anything else. It can only ever return here.',
  };
}

/** One route per scheme, because the three take different inputs: a GIAI
 * names only a namespace, while a serialised GRAI and an SGTIN each name the
 * managed class key they are issued under. */
async function issue(assetId: string, fields: FormData) {
  const scheme = String(fields.get('scheme') ?? 'giai');
  const namespaceKey = String(fields.get('namespaceKey') ?? '');
  const classKeyKey = String(fields.get('classKeyKey') ?? '');
  const param = { id: assetId };
  const { asset, issuances } = await unwrap<{ asset: AddressedAsset;
    issuances: readonly { scheme: string; canonical: string }[] }>(
    scheme === 'grai'
      ? await gs1Api.assets[':id'].grai.$post({ param, json: { namespaceKey, classKeyKey } })
      : scheme === 'sgtin'
        ? await gs1Api.assets[':id'].sgtin.$post({ param, json: { namespaceKey, classKeyKey } })
        : await gs1Api.assets[':id'].giai.$post({ param, json: { namespaceKey } }));
  // Which value this issuance produced, so the card for it can be picked out
  // where the reader was already looking.
  return { asset, added: issuances.find((issuance) => issuance.scheme === scheme)?.canonical ?? null };
}

export const gs1AssetPage: AssetPageSlot<Gs1AssetData> = {
  load: loadGs1AssetData,
  standing: (data, identifier) => issuedStanding(data.issuances, identifier),
  // Issuing exercises allocation authority Kannabi holds; recording states
  // that some other authority already assigned a value. They are separate
  // operations with separate controls.
  add: {
    label: 'Issue new',
    Panel: ({ data, asset, busy, error }) => <IssueIdentifier namespaces={data.namespaces}
      classKeys={data.classKeys} issuances={data.issuances} identifiers={asset.identifiers}
      enforceGtinConsistency={data.settings.enforceGtinConsistency} busy={busy} error={error} />,
    submit: issue,
    done: 'Identifier issued',
    failed: 'Identifier could not be issued',
  },
  revision: (data) => data.issuances.map((issuance) => issuance.key).join(),
};

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
export function IssueIdentifier({ namespaces, classKeys, issuances, identifiers, busy, error,
  enforceGtinConsistency = true }: {
  namespaces: readonly { key: string; gcp: string }[];
  /** The instance's acceptance policy, so the UI offers exactly what the
   * boundary would accept. */
  enforceGtinConsistency?: boolean;
  classKeys: readonly IssuableClassKey[];
  issuances: readonly Gs1KeyIssuance[];
  identifiers: readonly CarriedIdentifier[];
  busy: boolean; error: string | null;
}) {
  const issued = new Map(issuances.map((issuance) => [issuance.scheme, issuance]));
  // A class key this Asset could actually be serialised under. An Asset is an
  // instance of at most one trade item and a member of at most one GRAI
  // asset-type series, so a key naming a different one would be refused at the
  // boundary; asking the boundary in advance is what stops the UI offering a
  // choice it already knows cannot succeed.
  const policy = { enforceGtinConsistency };
  const usable = (classKey: IssuableClassKey) =>
    classKeyConflictReason(classKey, identifiers, policy) === null;
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
      .map((classKey) => classKeyConflictReason(classKey, identifiers, policy))
      .find((reason) => reason !== null);
    return conflict ? [{ label: entry.label, reason: conflict }] : [];
  });
  const [classKeyKey, setClassKeyKey] = useState(eligible[0]?.key ?? '');
  const selected = eligible.find((classKey) => classKey.key === classKeyKey) ?? eligible[0];
  const detached = issuances.filter((issuance) =>
    !identifiers.some((identifier) => identifier.canonical === issuance.canonical));
  // Nothing issuable means nothing to explain about issuing. Describing how
  // issuance works, then a value that is no longer attached, and only then
  // saying none of it is available, made a reader work through two paragraphs
  // about a capability to reach the sentence telling them it is unavailable.
  if (!available.length) {
    return <Hint className="mt-0">{blocked.length
      ? <>No identifiers can currently be issued for this Asset.{' '}
        {blocked.map((entry) => `${entry.label}: ${entry.reason}.`).join(' ')}</>
      : issued.size >= issuanceOptions.length
        ? 'Kannabi has issued every identifier it can for this Asset.'
        : namespaces.length === 0
          ? <>No identifiers can currently be issued for this Asset: no collaborating Group you
            manage has an active GS1 Company Prefix. <Link to="/groups">Configure one on the
            Group’s page</Link>, then come back — or ask a Group Manager of one of this Asset’s
            Groups.</>
          : <>No identifiers can currently be issued for this Asset. A serialised GRAI or an SGTIN
            is issued under a managed class key, and this Asset’s prefixes have no active
            one yet. <Link to="/groups">Allocate or adopt a class key on the Group’s page</Link>, then
            come back to issue from it.</>}</Hint>;
  }
  return <>
    {/* The lead belongs to this form rather than to the tab holding it, so the
        form that knows whether issuing is possible is the one that decides
        whether to describe it. */}
    <Hint className="mt-0 mb-4">Issue an identifier under a GS1 Company Prefix namespace managed by
      one of this Asset’s Groups.</Hint>
    {detached.map((issuance) => <Hint key={issuance.key}>Kannabi-issued <code>{issuance.canonical}</code> is
      not currently recorded on this Asset. It stays bound to this Asset in the issuance ledger and is never reissued elsewhere.</Hint>)}
    <fieldset disabled={busy} aria-busy={busy}>
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
    </fieldset>
  </>;
}
