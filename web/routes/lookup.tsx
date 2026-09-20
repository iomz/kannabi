import { Form, Link, redirect, useNavigation } from 'react-router';
import { useState } from 'react';
import { api, unwrap } from '../api';
import { identifierSchemes, schemeInputs, schemeLabels, schemeDescriptions,
  type IdentifierScheme } from '../../server/gs1.js';
import { AssetRow } from '../asset-row';
import type { Route } from './+types/lookup';

type LookupKind = 'id' | IdentifierScheme;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  if (!(await unwrap(await api.me.$get())).user) throw redirect('/signin');
  const params = new URL(request.url).searchParams;
  const kind = (params.get('kind') ?? 'id') as LookupKind;
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
    <Link to="/" className="back-link">← Assets</Link>
    <div className="page-heading"><div><p className="eyebrow">Inventory</p><h1>Find by identity</h1>
      <p>Resolve a complete Asset ID or external identifier. This is exact resolution, not a search:
        a partial value finds nothing.</p></div></div>
    <section className="panel form-panel">
      <Form method="get"><fieldset disabled={busy}>
        <label>Identity
          <select name="kind" value={selected} onChange={(event) => setSelected(event.target.value as LookupKind)}>
            <option value="id">Asset ID — Kannabi native identity</option>
            {identifierSchemes.map((scheme) =>
              <option key={scheme} value={scheme}>{schemeLabels[scheme]} — {schemeDescriptions[scheme]}</option>)}
          </select>
        </label>
        {inputs.map((input) => <label key={input.name}>{input.label}
          <input name={input.name} required={!('required' in input) || input.required} />
          {input.hint && <span className="hint">{input.hint}</span>}
        </label>)}
        {error && <p role="alert">{error}</p>}
        <button>{busy ? 'Looking up…' : 'Look up'}</button>
      </fieldset></Form>
    </section>
    {result && <section className="panel"><h2>Result</h2>
      <p className="hint">
        {result.identity.kind === 'assetId'
          ? <>Asset ID <code>{result.identity.id}</code></>
          : <>{schemeLabels[result.identity.scheme]} <code>{result.identity.canonical}</code>
            {result.identity.level === 'class'
              ? ' — a class identifier, which may describe several Assets'
              : ' — an individual identifier, which identifies at most one Asset'}</>}
      </p>
      {!result.assets.length
        ? <p>No readable Asset carries that identity.</p>
        : <>
          <ul className="inventory-list">{result.assets.map((asset) =>
            <AssetRow key={asset.id} asset={asset} />)}</ul>
          <p className="hint">Showing {result.assets.length} of {result.matching} Assets
            that carry this identity.</p>
          {result.nextCursor && <Link className="button secondary" to={'/lookup?' + new URLSearchParams({
            ...Object.fromEntries(new URLSearchParams(location.search)), cursor: result.nextCursor,
          })}>Show more</Link>}
        </>}
    </section>}
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
