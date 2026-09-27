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
import { AllocateGiai, IdentifierForm } from '../web/asset-identifiers.js';
import { InventoryControls, noFilters } from '../web/inventory-controls.js';
import { assetPageRequest } from './asset-page.js';

const group = { key: 'workshop', name: 'Workshop' };
const namespaces = [true, false].map((active) => ({ key: active ? 'active' : 'inactive',
  gcp: active ? '0614141' : '9521234', active, nextSequence: 1, exclusions: [], group }));

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
      controlledGroups: [group], namespaces } } as never),
    action: (args) => groupAction(args as never),
  }], { initialEntries: ['/groups'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    document.querySelector('details')!.open = true;
    for (const [label, fields, path, method, body] of [
      ['Create Group', { name: 'New team' }, '/api/groups', 'POST', { name: 'New team' }],
      ['Add member', { userKey: 'invitee' }, '/api/groups/workshop/members', 'POST', { userKey: 'invitee' }],
      ['Configure prefix', { gcp: '1234567', exclusions: '1-3' }, '/api/groups/workshop/giai-namespaces', 'POST',
        { gcp: '1234567', exclusions: [{ from: 1, to: 3 }] }],
      ['Deactivate', {}, '/api/giai-namespaces/active', 'PATCH', { active: false }],
      ['Reactivate', {}, '/api/giai-namespaces/inactive', 'PATCH', { active: true }],
      ['Leave Group', {}, '/api/groups/workshop/membership', 'DELETE', null],
    ] as const) {
      const button = view.button(label);
      assert.ok(button, label);
      for (const [name, value] of Object.entries(fields)) {
        button.form!.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
      }
      const before = calls.length;
      await settle(() => button.click());
      assert.equal(calls.length, before + 1, `${label} must reach the API exactly once`);
      assert.deepEqual(calls.at(-1), { path, method, body });
    }
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});

test('Asset Save changes submits both name and public visibility through its fetcher', async () => {
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
        identifiers: [], photos: [], allocation: null },
      settings: { displayTimezone: 'UTC' }, canEdit: true, authenticated: true, canViewReporterProfile: false,
      assetUri: `https://kannabi.test/assets/${id}`, namespaces: [{ key: 'eligible', gcp: '0614141' }], controlled: [], canGrant: false,
    } } as never), action: (args) => assetAction(args as never),
  }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.equal([...document.querySelectorAll('dt')].some((node) => node.textContent === 'Asset ID'), false,
      'native Asset ID hidden by default');
    assert.ok([...document.querySelectorAll('label')].some((label) => label.textContent === 'Asset URI'),
      'Asset URI remains separately available');
    view.field('input[name="name"]')!.value = 'After';
    // Use the switch's native checkbox: happy-dom does not implement checkbox
    // activation for the constructed PointerEvent Base UI forwards to it.
    await settle(() => view.field('input[name="isPublic"]')!.click());
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true');
    await settle(() => view.button('Save changes')!.click());
    assert.deepEqual(calls, [{ path: `/api/assets/${id}`, method: 'PATCH', body: { name: 'After', isPublic: true } }]);
    assert.match(view.text(), /Saved/);
    await settle(() => view.button('Issue GIAI')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/giai`, method: 'POST', body: { namespaceKey: 'eligible' } });
    view.field('input[name="gtin"]')!.value = '00614141123452';
    view.field('input[name="serial"]')!.value = 'fixture-1';
    await settle(() => view.button('Record existing identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'sgtin', gtin: '00614141123452', serial: 'fixture-1' } });
    const scheme = view.field('select[name="scheme"]')!;
    await settle(() => {
      scheme.value = 'giai';
      scheme.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.match(view.text(), /Existing GIAI \(complete AI 8004 value\)/);
    view.field('input[name="assetReference"]')!.value = '024';
    await settle(() => view.button('Record existing identifier')!.click());
    assert.deepEqual(calls.at(-1), { path: `/api/assets/${id}/identifiers`, method: 'POST',
      body: { scheme: 'giai', assetReference: '024' } });
    assert.ok(calls.slice(-1).every((call) => !call.path.endsWith('/giai')),
      'generic external identifier form must never invoke Kannabi issuance');
  } finally { view.stop(); router.dispose(); globalThis.fetch = originalFetch; }
});

test('enabling native Asset ID presentation shows UUID while retaining the Asset URI', () => {
  const id = newAssetId();
  const router = createMemoryRouter([{ path: '/assets/:id', element: createElement(AssetPage, { loaderData: {
    asset: { id, name: 'Presentation check', isPublic: false, owner: null, groups: [],
      reportedBy: { key: 'reporter', name: 'Reporter', status: 'active' }, reportedAt: '2026-01-01T00:00:00Z',
      identifiers: [], photos: [], allocation: null },
    settings: { displayTimezone: 'UTC', showAssetId: true, showIdentifierPolicyVersion: false },
    canEdit: false, authenticated: true, canViewReporterProfile: false, assetUri: `https://kannabi.test/assets/${id}`,
    namespaces: [], controlled: [], canGrant: false,
  } } as never) }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.ok([...document.querySelectorAll('dt')].some((node) => node.textContent === 'Asset ID'));
    assert.ok([...document.querySelectorAll('dd code')].some((node) => node.textContent === id));
    assert.ok([...document.querySelectorAll('label')].some((label) => label.textContent === 'Asset URI'));
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

test('GIAI empty state describes actor eligibility rather than a single Asset Group', () => {
  const view = mount(createElement(AllocateGiai, { namespaces: [], allocation: null, busy: false, error: null, saved: null }));
  try {
    assert.match(view.text(), /You have no eligible active GS1 Company Prefix for issuing a GIAI for this Asset/);
    assert.match(view.text(), /collaborating Group you belong to/);
    assert.equal(view.button('Issue GIAI'), null);
  } finally { view.stop(); }
});

test('generic identifier form explicitly records existing external identifiers only', async () => {
  const view = mount(createElement(IdentifierForm, { busy: false, error: null, saved: null }));
  try {
    assert.match(view.text(), /Record an existing identifier already assigned by an external authority/);
    assert.match(view.text(), /never issues identifiers/);
    assert.equal(view.field('input[name="assetReference"]'), null, 'SGTIN starts selected');
    const select = view.field('select[name="scheme"]')!;
    select.value = 'giai';
    await settle(() => select.dispatchEvent(new Event('change', { bubbles: true })));
    assert.match(view.text(), /Existing GIAI \(complete AI 8004 value\)/);
    assert.match(view.text(), /already assigned by an external authority, including its company prefix/);
    assert.match(view.text(), /Kannabi does not issue or verify it/);
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
