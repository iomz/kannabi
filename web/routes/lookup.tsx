import { Form, Link, redirect, useNavigation } from 'react-router';
import { useState } from 'react';
import { api, unwrap } from '../api';
import { identifierSchemes, schemeInputs, schemeLabels, schemeDescriptions,
  type IdentifierScheme } from '../../server/gs1.js';
import { AssetRow } from '../asset-row';
import type { Route } from './+types/lookup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Hint, NativeSelect, PageHeading, Panel } from '../ui';

type LookupKind = 'id' | IdentifierScheme;

/** An unrecognised `kind` is a bad request, not a broken page: indexing the
 * scheme table with it would throw inside the loader and surface the generic
 * error boundary instead of telling the caller what was wrong. */
function lookupKind(value: string | null): LookupKind | null {
  if (value === null || value === 'id') return 'id';
  return (identifierSchemes as readonly string[]).includes(value) ? value as IdentifierScheme : null;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  if (!(await unwrap(await api.me.$get())).user) throw redirect('/signin');
  const params = new URL(request.url).searchParams;
  const kind = lookupKind(params.get('kind'));
  if (kind === null) {
    return { kind: 'id' as LookupKind, result: null, error: 'That is not an identity Kannabi can resolve.' };
  }
  // Only the fields the chosen kind actually uses are sent, so the deterministic
  // query never receives an ambiguous mixture of identity inputs.
  const fields = kind === 'id' ? ['id'] : schemeInputs[kind].map((input) => input.name);
  const supplied = Object.fromEntries(fields
    .map((field) => [field, params.get(field) ?? ''])
    .filter(([, value]) => value !== ''));
  if (!Object.keys(supplied).length) return { kind, result: null, error: null };
  const cursor = params.get('cursor');
  const query = { ...(kind === 'id' ? supplied : { scheme: kind, ...supplied }),
    ...(cursor ? { cursor } : {}) };
  try {
    return { kind, error: null, result: await unwrap(await api.assets.lookup.$get({ query })) };
  } catch (error) {
    return { kind, result: null, error: error instanceof Error ? error.message : 'Lookup failed' };
  }
}

export default function Lookup({ loaderData: { kind, result, error } }: Route.ComponentProps) {
  const busy = useNavigation().state !== 'idle';
  const [selected, setSelected] = useState<LookupKind>(kind);
  const inputs = selected === 'id'
    ? [{ name: 'id', label: 'Asset ID', hint: 'The Asset’s native Kannabi identity.' }]
    : schemeInputs[selected];
  return <>
    <Link to="/" className="mb-6 inline-block text-[.85rem]">← Assets</Link>
    <PageHeading eyebrow="Inventory" title="Find by identity"
      description="Resolve a complete Asset ID or external identifier. This is exact resolution, not a search: a partial value finds nothing." />
    <Panel form>
      <Form method="get"><fieldset disabled={busy}>
        <Field label="Identity">
          <NativeSelect name="kind" value={selected} onChange={(event) => setSelected(event.target.value as LookupKind)}>
            <option value="id">Asset ID — Kannabi native identity</option>
            {identifierSchemes.map((scheme) =>
              <option key={scheme} value={scheme}>{schemeLabels[scheme]} — {schemeDescriptions[scheme]}</option>)}
          </NativeSelect>
        </Field>
        {inputs.map((input) => <Field key={input.name} label={input.label} hint={input.hint}>
          <Input name={input.name} required={!('required' in input) || input.required} />
        </Field>)}
        {error && <p role="alert">{error}</p>}
        <Button>{busy ? 'Looking up…' : 'Look up'}</Button>
      </fieldset></Form>
    </Panel>
    {result && <Panel><h2>Result</h2>
      <Hint className="mb-4">
        {result.identity.kind === 'assetId'
          ? <>Asset ID <code>{result.identity.id}</code></>
          : <>{schemeLabels[result.identity.scheme]} <code>{result.identity.canonical}</code>
            {result.identity.level === 'class'
              ? ' — a class identifier, which may describe several Assets'
              : ' — an individual identifier, which identifies at most one Asset'}</>}
      </Hint>
      {!result.assets.length
        ? <p>No readable Asset carries that identity.</p>
        : <>
          <ul className="overflow-hidden rounded border bg-card">{result.assets.map((asset) =>
            <AssetRow key={asset.id} asset={asset} />)}</ul>
          {/* Each page replaces the last, so this is navigation rather than an
              append; the browser's Back button returns to the previous page. */}
          <Hint className="mt-4">Showing {result.assets.length} of {result.matching} Assets
            that carry this identity.</Hint>
          {result.nextCursor && <Button variant="outline" className="mt-3" render={
            <Link to={'/lookup?' + new URLSearchParams({
              ...Object.fromEntries(new URLSearchParams(location.search)), cursor: result.nextCursor,
            })} />}>Next page</Button>}
        </>}
    </Panel>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
