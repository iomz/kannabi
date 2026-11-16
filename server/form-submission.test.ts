import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type FormEvent } from 'react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import Groups, { clientAction as groupAction } from '../web/routes/groups.js';
import AssetPage, { clientAction as assetAction } from '../web/routes/asset.js';
import { mount, settle } from './dom-render.js';
import { newAssetId } from './asset-id.js';
import { Button } from '../web/components/ui/button.js';
import { IdentifierForm } from '../web/asset-identifiers.js';
import { InventoryControls, noFilters } from '../web/inventory-controls.js';
import { assetPageRequest } from './asset-page.js';
import { composition } from './test-fixture.js';
const { schemes } = composition;

const group = { key: 'workshop', name: 'Workshop' };
test('creating a Group asks only for its name, then goes to its people', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ group: { key: 'fresh', name: 'New team' } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const router = createMemoryRouter([{ path: '/groups',
    element: createElement(Groups, { loaderData: { user: { key: 'actor' }, directory: 'everyone',
      groups: [{ ...group, role: 'manager', people: 3, assets: 12 }] } } as never),
    action: (args) => groupAction(args as never),
  }, { path: '/groups/:key/people', element: createElement('h1', null, 'People') }], { initialEntries: ['/groups'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    // The list says what each Group is to the reader.
    const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent!.includes('Workshop'))!;
    assert.match(row.textContent!, /Group Manager/);
    assert.equal(document.querySelector('a[href="/groups/workshop"]')?.textContent, 'Workshop');
    assert.equal(document.querySelector('#member-key'), null, 'no member key while anybody can be found by name');
    await settle(() => view.button('New Group')!.click());
    assert.equal(view.dialogName(), 'New Group');
    view.dialog()!.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'New team';
    await settle(() => view.button('Create Group')!.click());
    await settle(); await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/groups', method: 'POST', body: { name: 'New team' } });
    assert.equal(router.state.location.pathname, '/groups/fresh/people');
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});

test('with nobody to find them by name, a newcomer is offered their member key to copy', () => {
  const router = createMemoryRouter([{ path: '/groups',
    element: createElement(Groups, { loaderData: { user: { key: 'actor' }, directory: 'shared', groups: [] } } as never),
  }], { initialEntries: ['/groups'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.match(view.text(), /You are not in any Group yet/);
    assert.equal(document.querySelector<HTMLInputElement>('#member-key')?.value, 'actor');
    assert.ok(view.button('Copy your member key'));
  } finally { view.stop(); router.dispose(); }
});

/** A member who is not a Group Manager.
 *
 * Configuring a prefix, managing its class keys and issuing from it are the
 * Group Manager's (#20), so the view must not offer a mutation the server
 * will refuse. Reading is deliberately left alone: the prefixes a Group
 * manages are not secret from its members, and hiding them would leave
 * somebody unable to see what to ask a Group Manager for.
 */
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
        identifiers: [], formerIdentifiers: [], photos: [], issuances: [] },
      settings: { displayTimezone: 'UTC' }, canEdit: true, authenticated: true, canViewReporterProfile: false,
      nativeUri: `https://kannabi.test/asset/${id}`, surfacedUri: `https://kannabi.test/asset/${id}`,
      plugins: { shelf: {} }, digitalLinks: {}, controlled: [], canGrant: false,
    } } as never), action: (args) => assetAction(args as never),
  }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.equal([...document.querySelectorAll('dt')].some((node) => node.textContent === 'Kannabi ID'), false,
      'Kannabi ID hidden by default');
    // The native Asset URI spells the same reference, so the one setting
    // governs both and this Asset has no other address to surface instead.
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
    // The plugin's way of adding and recording are two tabs, not two forms
    // standing open, so the recording form exists only once somebody has
    // selected it.
    await settle(() => [...document.querySelectorAll('summary')]
      .find((node) => node.textContent?.trim() === 'Add identifier')!.click());
    assert.ok(view.field('input[name="code"]') === null, 'recording is not offered until chosen');
    const recordTab = [...document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent?.trim() === 'Record existing') as HTMLElement;
    await settle(() => recordTab.click());
    view.field('input[name="code"]')!.value = 'T-7';
    await settle(() => view.button('Record identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'tag', code: 'T-7' } });
    const scheme = view.field('select[name="scheme"]')!;
    await settle(() => {
      scheme.value = 'model';
      scheme.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Changing the scheme changes the fields: one scheme's are never sent
    // under another's name.
    assert.equal(view.field('input[name="code"]'), null);
    view.field('input[name="series"]')!.value = 'drill';
    await settle(() => view.button('Record identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'model', series: 'drill' } });
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});

test('enabling Kannabi ID presentation shows UUID while retaining the Asset URI', () => {
  const id = newAssetId();
  const router = createMemoryRouter([{ path: '/assets/:id', element: createElement(AssetPage, { loaderData: {
    asset: { id, name: 'Presentation check', isPublic: false, owner: null, groups: [],
      reportedBy: { key: 'reporter', name: 'Reporter', status: 'active' }, reportedAt: '2026-01-01T00:00:00Z',
      identifiers: [], formerIdentifiers: [], photos: [], issuances: [] },
    settings: { displayTimezone: 'UTC', showAssetId: true, showIdentifierPolicyVersion: false },
    canEdit: false, authenticated: true, canViewReporterProfile: false,
    nativeUri: `https://kannabi.test/asset/${id}`, surfacedUri: `https://kannabi.test/asset/${id}`,
    plugins: { shelf: {} }, digitalLinks: {}, controlled: [], canGrant: false,
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

test('generic identifier form explicitly records existing external identifiers only', async () => {
  const view = mount(createElement(IdentifierForm, { busy: false, error: null }));
  try {
    // The lead sentence belongs to the tab panel that chose this mode, so the
    // form itself carries no standing explanation of what it is not.
    assert.doesNotMatch(view.text(), /never issues identifiers/);
    assert.ok(view.field('input[name="code"]'), 'the first installed scheme starts selected');
    assert.equal(view.field('input[name="series"]'), null);
    const select = view.field('select[name="scheme"]')!;
    assert.deepEqual([...select.querySelectorAll('option')].map((option) => option.value), ['tag', 'model']);
    select.value = 'model';
    await settle(() => select.dispatchEvent(new Event('change', { bubbles: true })));
    assert.ok(view.field('input[name="series"]'), 'the fields follow the scheme');
    assert.equal(view.field('input[name="code"]'), null);
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
      const parsed = assetPageRequest(Object.fromEntries(new URLSearchParams(router.state.location.search)), schemes.ids);
      assert.equal(parsed.scope, scope);
      assert.equal(parsed.q, 'bench');
      assert.deepEqual(parsed.filters.groups, ['workshop']);
      assert.equal(parsed.sort, 'reportedAt');
      assert.equal(parsed.dir, 'desc');
    }
  } finally { view.stop(); router.dispose(); }
});
