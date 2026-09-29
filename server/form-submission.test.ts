import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type FormEvent } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Groups, { clientAction as groupAction } from '../web/routes/groups.js';
import AssetPage, { clientAction as assetAction } from '../web/routes/asset.js';
import { mount, settle } from './dom-render.js';
import { newAssetId } from './asset-id.js';
import { Button } from '../web/components/ui/button.js';
import { IdentifierForm, IssueIdentifier } from '../web/asset-identifiers.js';
import { InventoryControls, noFilters } from '../web/inventory-controls.js';
import { assetPageRequest } from './asset-page.js';

const group = { key: 'workshop', name: 'Workshop' };
const counter = { nextSequence: 1, exclusions: [] };
const namespaces = [true, false].map((active) => ({ key: active ? 'active' : 'inactive',
  gcp: active ? '0614141' : '9521234', active,
  counters: { giai: counter, graiType: counter, gtinItem: counter },
  classKeyIssuable: true, unissuableReason: null, gtinFormat: 'GTIN-12', group }));

/** Click the rendered control: calling a route action directly misses broken
 * submit semantics between Base UI, the browser form, and React Router. */
test('every existing Group form submits its intended API mutation on click', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ added: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  const router = createMemoryRouter([{ path: '/groups',
    element: createElement(Groups, { loaderData: { user: { key: 'actor' }, groups: [group],
      controlledGroups: [group], namespaces, classKeys: [] } } as never),
    action: (args) => groupAction(args as never),
  }], { initialEntries: ['/groups'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    document.querySelector('details')!.open = true;
    for (const [label, fields, path, method, body] of [
      ['Create Group', { name: 'New team' }, '/api/groups', 'POST', { name: 'New team' }],
      ['Add member', { userKey: 'invitee' }, '/api/groups/workshop/members', 'POST', { userKey: 'invitee' }],
      ['Configure prefix', { gcp: '1234567', giaiExclusions: '1-3' }, '/api/groups/workshop/gs1-namespaces', 'POST',
        { gcp: '1234567', giaiExclusions: [{ from: 1, to: 3 }] }],
      ['Deactivate', {}, '/api/gs1-namespaces/active', 'PATCH', { active: false }],
      ['Reactivate', {}, '/api/gs1-namespaces/inactive', 'PATCH', { active: true }],
      ['Leave Group', {}, '/api/groups/workshop/membership', 'DELETE', null],
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
      digitalLinks: {}, namespaces: [{ key: 'eligible', gcp: '0614141' }], classKeys: [], controlled: [], canGrant: false,
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
    // Visibility is a switch whose state is also written out beside it. Use
    // the native checkbox underneath: happy-dom does not implement checkbox
    // activation for the constructed PointerEvent Base UI forwards to it.
    await settle(() => view.field('input[name="isPublic"]')!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}`, method: 'PATCH', body: { isPublic: true } });
    await settle(() => view.button('Issue GIAI')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/giai`, method: 'POST', body: { namespaceKey: 'eligible' } });
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

test('enabling Kannabi ID presentation shows UUID while retaining the Asset URI', () => {
  const id = newAssetId();
  const router = createMemoryRouter([{ path: '/assets/:id', element: createElement(AssetPage, { loaderData: {
    asset: { id, name: 'Presentation check', isPublic: false, owner: null, groups: [],
      reportedBy: { key: 'reporter', name: 'Reporter', status: 'active' }, reportedAt: '2026-01-01T00:00:00Z',
      identifiers: [], photos: [], issuances: [] },
    settings: { displayTimezone: 'UTC', showAssetId: true, showIdentifierPolicyVersion: false },
    canEdit: false, authenticated: true, canViewReporterProfile: false,
    nativeUri: `https://kannabi.test/asset/${id}`, surfacedUri: `https://kannabi.test/asset/${id}`,
    digitalLinks: {}, namespaces: [], classKeys: [], controlled: [], canGrant: false,
  } } as never) }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.ok([...document.querySelectorAll('dt')].some((node) => node.textContent === 'Kannabi ID'));
    assert.ok([...document.querySelectorAll('dd code')].some((node) => node.textContent === id));
    // Named by a heading now rather than a form label, and still named for
    // assistive technology by the field's own accessible name.
    assert.ok([...document.querySelectorAll('h3')].some((node) => node.textContent?.startsWith('Asset URI')));
    assert.ok([...document.querySelectorAll('input')]
      .some((field) => field.getAttribute('aria-label') === 'Asset URI'));
  } finally { view.stop(); router.dispose(); }
});

test('explicit submit buttons preserve validation, submitter data, and non-submit actions', () => {
  const submissions: FormData[] = [];
  const view = mount(createElement('form', { onSubmit: (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submissions.push(new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement));
  } }, createElement('input', { name: 'required', required: true }),
  createElement(Button, { type: 'submit', name: 'intent', value: 'save' }, 'Save'),
  createElement(Button, {}, 'Local action')));
  try {
    view.click(view.button('Save'));
    assert.equal(submissions.length, 0, 'required fields still block submission');
    view.field('input')!.value = 'ready';
    view.click(view.button('Local action'));
    assert.equal(submissions.length, 0, 'default Button must stay non-submitting');
    view.click(view.button('Save'));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].get('intent'), 'save');
  } finally { view.stop(); }
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
  const router = createMemoryRouter([{ path: '/groups',
    element: createElement(Groups, { loaderData: { user: { key: 'actor' }, groups: [group],
      controlledGroups: [group], namespaces: [namespaces[0]], classKeys: [] } } as never),
    action: (args) => groupAction(args as never),
  }], { initialEntries: ['/groups'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    document.querySelector('details')!.open = true;
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
    assert.deepEqual(calls.at(-1), { path: '/api/gs1-namespaces/active/class-keys', method: 'POST',
      body: { scheme: 'gtin', serialExclusions: [] } });

    // Adopting asserts a key this Group already allocated: it sends the value,
    // and the scheme decides which field of the GS1 boundary it lands in.
    const value = adopt!.form!.querySelector<HTMLInputElement>('[name="value"]')!;
    value.value = '0614141000012';
    await settle(() => adopt!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/gs1-namespaces/active/class-keys', method: 'POST',
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
    assert.match(first.text(), /no collaborating Group you belong to has an\s+active GS1 Company Prefix/);
    assert.equal(document.querySelector('a[href="/groups"]')?.textContent,
      'Configure one under Groups');
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

test('existing visibility scopes navigate without losing search, filters, or ordering', async () => {
  const router = createMemoryRouter([{ path: '/', element: createElement(InventoryControls, {
    view: { q: 'bench', scope: 'all', sort: 'reportedAt', dir: 'desc', filters: { ...noFilters, groups: ['workshop'] } },
    groups: [group], scopes: { all: 3, mine: 1, group: 2, public: 1 },
  }) }]);
  const view = mount(createElement(RouterProvider, { router }));
  try {
    for (const scope of ['public', 'group'] as const) {
      const link = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Asset scope"] a')]
        .find((node) => new URL(node.href).searchParams.get('scope') === scope)!;
      assert.ok(link);
      await settle(() => link.click());
      const parsed = assetPageRequest(Object.fromEntries(new URLSearchParams(router.state.location.search)));
      assert.equal(parsed.scope, scope);
      assert.equal(parsed.q, 'bench');
      assert.deepEqual(parsed.filters.groups, ['workshop']);
      assert.equal(parsed.sort, 'reportedAt');
      assert.equal(parsed.dir, 'desc');
    }
  } finally { view.stop(); router.dispose(); }
});
