import '../../../server/dom.js';

/** What the GS1 plugin's loader hands the Asset page when it has nothing to show. */
const gs1Data = { issuances: [], settings: { enforceGtinConsistency: true }, namespaces: [], classKeys: [] };
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type FormEvent } from 'react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import Groups, { clientAction as groupAction } from '../../../web/routes/groups.js';
import GroupPrefixes, { clientAction as prefixesAction } from '../web/group-prefixes.js';
import AssetPage, { clientAction as assetAction } from '../../../web/routes/asset.js';
import { mount, settle } from '../../../server/dom-render.js';
import { newAssetId } from '../../../server/asset-id.js';
import { Button } from '../../../web/components/ui/button.js';
import { IdentifierForm } from '../../../web/asset-identifiers.js';
import { IssueIdentifier } from '../web/asset-page.js';
import { InventoryControls, noFilters } from '../../../web/inventory-controls.js';
import { assetPageRequest } from '../../../server/asset-page.js';
import { composition } from '../testing.js';
const { schemes } = composition;

const group = { key: 'workshop', name: 'Workshop' };
const counter = { nextSequence: 1, exclusions: [] };
const namespaces = [true, false].map((active) => ({ key: active ? 'active' : 'inactive',
  gcp: active ? '0614141' : '9521234', active,
  counters: { giai: counter, graiType: counter, gtinItem: counter },
  classKeyIssuable: true, unissuableReason: null, gtinFormat: 'GTIN-12', group }));

/** A Group's GS1 prefixes view, inside the Group page that supplies who the
 * viewer is to it. */
function prefixesRouter(role: 'member' | 'manager', loaderData: object) {
  return createMemoryRouter([{ path: '/groups/:key',
    element: createElement(Outlet, { context: { group, viewer: { role } } }),
    children: [{ path: 'prefixes', element: createElement(GroupPrefixes, { loaderData } as never),
      action: (args) => prefixesAction(args as never) }],
  }], { initialEntries: ['/groups/workshop/prefixes'] });
}

/** Click the rendered control: calling a route action directly misses broken
 * submit semantics between Base UI, the browser form, and React Router. */
test('every existing GS1 prefix form submits its intended API mutation on click', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ added: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  const router = prefixesRouter('manager', { namespaces, classKeys: [] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    for (const [label, fields, path, method, body] of [
      ['Configure prefix', { gcp: '1234567', giaiExclusions: '1-3' }, '/api/gs1/groups/workshop/namespaces', 'POST',
        { gcp: '1234567', giaiExclusions: [{ from: 1, to: 3 }] }],
      ['Deactivate', {}, '/api/gs1/namespaces/active', 'PATCH', { active: false }],
      ['Reactivate', {}, '/api/gs1/namespaces/inactive', 'PATCH', { active: true }],
    ] as const) {
      const button = view.button(label);
      assert.ok(button, label);
      for (const [name, value] of Object.entries(fields)) {
        button.form!.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
      }
      const before = calls.length;
      await settle(() => button.click());
      await settle();
      assert.equal(calls.length, before + 1, `${label} must reach the API exactly once`);
      assert.deepEqual(calls.at(-1), { path, method, body });
    }
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});



/** A member who is not a Group Manager.
 *
 * Configuring a prefix, managing its class keys and issuing from it are the
 * Group Manager's (#20), so the view must not offer a mutation the server
 * will refuse. Reading is deliberately left alone: the prefixes a Group
 * manages are not secret from its members, and hiding them would leave
 * somebody unable to see what to ask a Group Manager for.
 */
test('the GS1 prefixes view offers a member nothing they cannot do', () => {
  const classKey = { key: 'class', scheme: 'gtin' as const, canonical: '06141410000176',
    gcp: '0614141', namespaceKey: 'active', sequence: 1, provenance: 'allocated' as const,
    active: true, serial: counter, assertedAt: '2026-01-01T00:00:00Z',
    assertedBy: { key: 'actor', name: 'Reporter', status: 'active' as const } };
  const router = prefixesRouter('member', { namespaces, classKeys: [classKey] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.match(view.text(), /0614141/);
    assert.match(view.text(), /06141410000176/);
    assert.match(view.text(), /is for its Group Managers\.\s+Ask one of them/);
    assert.equal(document.querySelector('a[href="/groups/workshop/people"]')?.textContent, 'one of them');
    for (const label of ['Configure prefix', 'Deactivate', 'Reactivate', 'Allocate', 'Adopt']) {
      assert.equal(view.button(label), null, `${label} must not be offered to a member`);
    }
  } finally { view.stop(); router.dispose(); }
});

test('Asset name and visibility submit independently through their own fetchers', async () => {
  const id = newAssetId();
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ asset: {} }), { headers: { 'Content-Type': 'application/json' } });
  };
  const router = createMemoryRouter([{ path: '/assets/:id',
    element: createElement(AssetPage, { loaderData: {
      asset: { id, name: 'Before', isPublic: false, owner: null, groups: [group],
        reportedBy: { key: 'actor', name: 'Reporter', status: 'active' }, reportedAt: '2026-01-01T00:00:00Z',
        identifiers: [], photos: [], issuances: [] },
      settings: { displayTimezone: 'UTC' }, canEdit: true, authenticated: true, canViewReporterProfile: false,
      nativeUri: `https://kannabi.test/asset/${id}`, surfacedUri: `https://kannabi.test/asset/${id}`,
      plugins: { gs1: { ...gs1Data, namespaces: [{ key: 'eligible', gcp: '0614141' }] } }, digitalLinks: {}, controlled: [], canGrant: false,
    } } as never), action: (args) => assetAction(args as never),
  }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.equal([...document.querySelectorAll('dt')].some((node) => node.textContent === 'Kannabi ID'), false,
      'Kannabi ID hidden by default');
    // The native Asset URI spells the same reference, so the one setting
    // governs both and this Asset has no Digital Link to surface instead.
    assert.equal([...document.querySelectorAll('label')].some((label) => label.textContent === 'Asset URI'), false,
      'native Asset URI follows the Kannabi ID setting');
    // Renaming happens on the heading itself. Each control sends only its own
    // field, so neither can write back a value the person never touched.
    await settle(() => view.button('Rename Before')!.click());
    view.field('input[name="name"]')!.value = 'After';
    await settle(() => view.button('Save name')!.click());
    await settle();
    assert.deepEqual(calls, [{ path: `/api/assets/${id}`, method: 'PATCH', body: { name: 'After' } }]);
    // Publishing is consequential, so it is named and confirmed rather than
    // toggled.
    await settle(() => view.button('Change visibility')!.click());
    await settle(() => view.button('Make public')!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}`, method: 'PATCH', body: { isPublic: true } });
    await settle(() => view.button('Issue GIAI')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/gs1/assets/${id}/giai`, method: 'POST', body: { namespaceKey: 'eligible' } });
    // Issuing and recording are two tabs, not two forms standing open, so the
    // recording form exists only once somebody has selected it.
    assert.ok(view.field('input[name="gtin"]') === null, 'recording is not offered until chosen');
    const recordTab = [...document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent?.trim() === 'Record existing') as HTMLElement;
    await settle(() => recordTab.click());
    view.field('input[name="gtin"]')!.value = '00614141123452';
    view.field('input[name="serial"]')!.value = 'fixture-1';
    await settle(() => view.button('Record identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'sgtin', gtin: '00614141123452', serial: 'fixture-1' } });
    const scheme = view.field('select[name="scheme"]')!;
    await settle(() => {
      scheme.value = 'giai';
      scheme.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.match(view.text(), /GIAI value \(AI 8004\)/);
    view.field('input[name="assetReference"]')!.value = '024';
    await settle(() => view.button('Record identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'giai', assetReference: '024' } });
    assert.ok(calls.slice(-1).every((call) => !call.path.endsWith('/giai')),
      'generic external identifier form must never invoke Kannabi issuance');
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});



/** The empty state links to where the missing thing is created, so it needs a
 * router. Rendered through one rather than avoiding the link: a first-time
 * reader should not have to discover Groups on their own. */
function issuanceState(props: Parameters<typeof IssueIdentifier>[0]) {
  return createMemoryRouter([{ path: '/', element: createElement(IssueIdentifier, props) }],
    { initialEntries: ['/'] });
}

test('allocating and adopting a class key stay separate assertions in the UI', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ classKey: { key: 'created' } }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const router = prefixesRouter('manager', { namespaces: [namespaces[0]], classKeys: [] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    await settle();
    // Two distinct controls, not one form whose meaning turns on an empty field.
    const allocate = view.button('Allocate');
    const adopt = view.button('Adopt');
    assert.ok(allocate, 'allocation is its own action');
    assert.ok(adopt, 'adoption is its own action');
    assert.notEqual(allocate!.form, adopt!.form, 'and they are separate forms');

    // Allocating asks Kannabi to produce a reference: it sends no value.
    await settle(() => allocate!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/gs1/namespaces/active/class-keys', method: 'POST',
      body: { scheme: 'gtin', serialExclusions: [] } });

    // Adopting asserts a key this Group already allocated: it sends the value,
    // and the scheme decides which field of the GS1 boundary it lands in.
    const value = adopt!.form!.querySelector<HTMLInputElement>('[name="value"]')!;
    value.value = '0614141000012';
    await settle(() => adopt!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/gs1/namespaces/active/class-keys', method: 'POST',
      body: { scheme: 'gtin', gtin: '0614141000012', serialExclusions: [] } });

    // Adoption without a value never reaches the API. The browser's own
    // validation stops it, which is the right control for a missing required
    // field; the action keeps a guard of its own for callers that are not a
    // browser form.
    const before = calls.length;
    value.value = '';
    assert.equal(value.required, true);
    assert.equal(value.validity.valueMissing, true);
    await settle(() => adopt!.click());
    await settle();
    assert.equal(calls.length, before, 'no request for an adoption with nothing to adopt');
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});

test('the issuance empty state says what is missing and links to where it is created', () => {
  // No prefix at all: the Group has nothing to issue from.
  const noPrefix = issuanceState({ namespaces: [], classKeys: [],
    issuances: [], identifiers: [], busy: false, error: null });
  const first = mount(createElement(RouterProvider, { router: noPrefix }));
  try {
    // Issuing is authority over what a Group manages, so the empty state names
    // control as well as membership (#20); a member without control is told to
    // ask a controller rather than sent to configure a prefix they cannot.
    assert.match(first.text(),
      /no collaborating Group you\s+manage has an active GS1 Company Prefix/);
    assert.match(first.text(), /ask a Group Manager of one of this Asset’s\s+Groups/);
    assert.equal(document.querySelector('a[href="/groups"]')?.textContent,
      'Configure one on the Group’s page');
    assert.equal(first.button('Issue GIAI'), null);
  } finally { first.stop(); noPrefix.dispose(); }

  // A prefix but no class key: GIAI is offered, and the class-level schemes
  // say where their prerequisite comes from instead of silently vanishing.
  const noClassKey = issuanceState({ namespaces: [{ key: 'eligible', gcp: '0614141' }],
    classKeys: [], issuances: [], identifiers: [], busy: false, error: null });
  const second = mount(createElement(RouterProvider, { router: noClassKey }));
  try {
    assert.ok(second.button('Issue GIAI'), 'a GIAI needs no class key');
    assert.doesNotMatch(second.text(), /Allocate or adopt a class key/);
  } finally { second.stop(); noClassKey.dispose(); }
});

test('generic identifier form explicitly records existing external identifiers only', async () => {
  const view = mount(createElement(IdentifierForm, { busy: false, error: null }));
  try {
    // The lead sentence belongs to the tab panel that chose this mode, so the
    // form itself carries no standing explanation of what it is not.
    assert.doesNotMatch(view.text(), /never issues identifiers/);
    assert.doesNotMatch(view.text(), /already assigned by an external authority/);
    assert.equal(view.field('input[name="assetReference"]'), null, 'SGTIN starts selected');
    const select = view.field('select[name="scheme"]')!;
    select.value = 'giai';
    await settle(() => select.dispatchEvent(new Event('change', { bubbles: true })));
    assert.match(view.text(), /GIAI value \(AI 8004\)/);
    assert.match(view.text(), /already assigned by an external authority, including its company prefix/);
    assert.match(view.text(), /Kannabi validates GS1 syntax/);
    assert.match(view.text(), /does not verify who assigned it or who controls its prefix/);
  } finally { view.stop(); }
});
