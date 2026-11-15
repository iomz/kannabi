import '../../../server/dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, type ComponentType } from 'react';
import { createMemoryRouter, RouterProvider, useActionData, useLoaderData } from 'react-router';
import Group, { clientLoader as groupLoader, ErrorBoundary as GroupError } from '../../../web/routes/group.js';
import Overview, { clientAction as overviewAction, clientLoader as overviewLoader,
  controllerSummary } from '../../../web/routes/group-overview.js';
import Assets, { clientLoader as assetsLoader } from '../../../web/routes/group-assets.js';
import People, { clientAction as peopleAction, clientLoader as peopleLoader } from '../../../web/routes/group-people.js';
import Prefixes, { clientAction as prefixesAction, clientLoader as prefixesLoader } from '../web/group-prefixes.js';
import { GroupViewError } from '../../../web/group-destination.js';
import { mount, settle } from '../../../server/dom-render.js';

/** A Group's page, read the way a person meets it: by address, through its
 * loaders and actions, against a stub of the HTTP API that answers each
 * viewer the way the server does. Authorization itself is the server's and is
 * proved in group-roles.integration.test.ts; this proves the page never offers
 * more than the server would allow, and handles what it answers. */

type Role = 'member' | 'manager';
type Person = { key: string; name: string; status: 'active'; email: string | null; role: Role };
const person = (key: string, name: string, role: Role = 'member', email: string | null = null): Person =>
  ({ key, name, status: 'active', email, role });
const me = person('me', 'Alex Demo', 'manager');
const group = { key: 'g1', name: 'Demo Workshop' };
const counter = { nextSequence: 1, exclusions: [] };
const namespace = { key: 'ns', gcp: '4512345', active: true, group, classKeyIssuable: true,
  unissuableReason: null, gtinFormat: 'GTIN-13', counters: { giai: counter, graiType: counter, gtinItem: counter } };
const asset = (n: number) => ({ id: `01a12000-0000-7000-8000-00000000000${n}`,
  name: `Bench ${n}`, isPublic: false, owner: null, photos: [], issuances: [], identifiers: [], groups: [group],
  reportedBy: person('u2', 'Mira Castell'), reportedAt: `2026-09-2${n}T00:00:00.000Z` });

/** Everybody the stub People directory can find. */
const directory = [person('u4', 'Mira Castell', 'member', 'mira@example.test'), person('u5', 'Lena Holm'),
  person('u1', 'Rin Aoki')];

type World = {
  /** The viewer's role; null means not a member, which is also an unknown Group. */
  role: Role | null;
  members: Person[]; matching: number;
  peopleDirectory?: 'everyone' | 'names' | 'shared';
  /** Per-mutation answers: status and body. */
  answers?: Record<string, [number, unknown]>;
  /** Called after a mutation, so a test can change where the viewer stands. */
  after?: (method: string, path: string) => void;
};

function serve(world: World) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } });
  const missing = () => json({ error: 'Resource or Group access not found' }, 404);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'https://kannabi.test');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = world.answers?.[`${method} ${path}`];
    if (answer) { world.after?.(method, path); return json(answer[1], answer[0]); }
    const member = world.role !== null;
    if (path === '/api/me') return json({ user: { key: me.key, name: me.name, email: 'me@example.com' } });
    if (path === '/api/settings') return json({ settings: { peopleDirectory: world.peopleDirectory ?? 'everyone' } });
    if (path === '/api/groups/g1') return member ? json({ group, viewer: { role: world.role } }) : missing();
    if (path === '/api/groups/g1/members' && method === 'GET') return member ? json({ members: world.members }) : missing();
    if (path === '/api/people') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({ people: directory.filter((p) => p.name.toLowerCase().includes(q)), more: false });
    }
    if (path === '/api/assets') {
      const limit = Number(url.searchParams.get('limit'));
      return json({ assets: Array.from({ length: Math.min(limit, world.matching) }, (_, n) => asset(n)),
        matching: world.matching, total: world.matching, matchedFields: {},
        scopes: { all: world.matching, mine: 0, group: 0, public: 0 }, nextCursor: null });
    }
    if (path === '/api/gs1/namespaces') return json({ namespaces: member ? [namespace] : [] });
    if (path === '/api/gs1/namespaces/ns/class-keys') return json({ classKeys: [] });
    world.after?.(method, path);
    if (method === 'POST' && path === '/api/groups/g1/members') return json({ ok: true, added: true });
    return json({ changed: true });
  };
  return calls;
}

/** Framework-mode route modules take their data as props; a plain data router
 * hands it through hooks instead. */
function routeComponent(component: ComponentType<never>) {
  return function RouteComponent() {
    return createElement(component, { loaderData: useLoaderData(), actionData: useActionData() } as never);
  };
}

function open(path: string) {
  const router = createMemoryRouter([
    { path: '/groups/:key', Component: routeComponent(Group as never), loader: groupLoader as never,
      ErrorBoundary: GroupError, children: [
        { index: true, Component: routeComponent(Overview as never), loader: overviewLoader as never,
          action: overviewAction as never, ErrorBoundary: GroupViewError },
        { path: 'assets', Component: routeComponent(Assets as never), loader: assetsLoader as never,
          ErrorBoundary: GroupViewError },
        { path: 'people', Component: routeComponent(People as never), loader: peopleLoader as never,
          action: peopleAction as never, ErrorBoundary: GroupViewError },
        { path: 'prefixes', Component: routeComponent(Prefixes as never), loader: prefixesLoader as never,
          action: prefixesAction as never, ErrorBoundary: GroupViewError },
      ] },
    { path: '/groups', element: createElement('h1', null, 'Groups list') },
    { path: '/users/:key', element: createElement('h1', null, 'Profile') },
    { path: '/', element: createElement('h1', null, 'Inventory') },
  ], { initialEntries: [path] });
  const view = mount(createElement(RouterProvider, { router }));
  return { view, router, stop() { view.stop(); router.dispose(); } };
}

const originalFetch = globalThis.fetch;
async function loaded() { for (let n = 0; n < 6; n += 1) await settle(); }
const heading = () => document.querySelector('h1')?.textContent;
const navLabels = () => [...document.querySelectorAll('nav[aria-label="Group"] a')].map((a) => a.textContent);
const dt = (label: string) => [...document.querySelectorAll('dt')].find((node) => node.textContent === label);
const dd = (label: string) => dt(label)?.nextElementSibling?.textContent ?? null;
const link = (href: string) => document.querySelector(`a[href="${href}"]`);
const dialogButton = (name: string) => [...(document.querySelector('[role="alertdialog"]')
  ?.querySelectorAll('button') ?? [])].find((button) => button.textContent === name) as HTMLButtonElement | undefined;
const rowOf = (name: string) => [...document.querySelectorAll('tbody tr')].find((row) => row.textContent!.includes(name))!;
const writes = (calls: ReturnType<typeof serve>) =>
  calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);

/** Open one person's Change menu and read its items. Any menu left open by an
 * earlier step is closed first, so only this one is read. */
async function menu(page: ReturnType<typeof open>, name: string) {
  for (const open of document.querySelectorAll('[role="menu"]')) {
    act(() => { open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  }
  await settle();
  page.view.click(page.view.button(name));
  await settle();
  return [...[...document.querySelectorAll('[role="menu"]')].at(-1)!.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}
const item = (items: HTMLElement[], name: string) => items.find((node) => node.textContent === name)!;

const roster = [me, person('u1', 'Rin Aoki', 'manager'), person('u3', 'Sam Okafor')];
const base: World = { role: 'manager', members: roster, matching: 23 };

test('somebody outside a Group and an unknown Group get the same single answer, on every view', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const path of ['/groups/g1', '/groups/g1/assets', '/groups/g1/people', '/groups/g1/prefixes']) {
    serve({ ...base, role: null });
    const page = open(path);
    try {
      await loaded();
      assert.equal(heading(), 'Group unavailable', path);
      assert.match(document.body.textContent!, /does not exist, or you are not one of its members/);
      assert.equal(document.querySelector('nav[aria-label="Group"]'), null, 'no navigation reveals the Group');
      assert.doesNotMatch(document.body.textContent!, /Demo Workshop/);
    } finally { page.stop(); }
  }
});

test('every member gets the same addressable views, and the header names their one role', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const role of ['member', 'manager'] as const) {
    serve({ ...base, role, members: role === 'member' ? [{ ...me, role }, ...roster.slice(1)] : roster });
    const page = open('/groups/g1/people');
    try {
      await loaded();
      assert.equal(heading(), 'Demo Workshop');
      assert.deepEqual(navLabels(), ['Overview', 'Assets', 'People', 'GS1 prefixes']);
      const current = document.querySelector('nav[aria-label="Group"] [aria-current="page"]');
      assert.equal(current?.getAttribute('href'), '/groups/g1/people');
      const header = document.querySelector('h1')!.parentElement!.parentElement!.textContent!;
      assert.match(header, role === 'manager' ? /Group Manager/ : /Member/);
      assert.doesNotMatch(document.body.textContent!, /Controller|Not a member/);
    } finally { page.stop(); }
  }
});

test('Overview says who manages the Group, how many are in it, and leaving warns the last Group Manager', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const twelve = Array.from({ length: 12 }, (_, n) => person(`c${n}`, `Manager ${n}`, 'manager'));
  assert.equal(controllerSummary(twelve, 'me'), 'Manager 0, Manager 1 and 10 others');
  assert.equal(controllerSummary([me], 'me'), 'you');
  serve({ ...base, role: 'member', members: [{ ...me, role: 'member' }, ...roster.slice(1)] });
  let page = open('/groups/g1');
  try {
    await loaded();
    assert.equal(dd('Managed by'), 'Rin Aoki · 3 people');
    assert.equal(dt('Managed by')!.nextElementSibling!.querySelector('a')?.getAttribute('href'), '/groups/g1/people');
    assert.match(dd('Assets')!, /You can read 23 Assets through this Group/);
    assert.match(dd('GS1 Company Prefixes')!, /4512345/);
    assert.ok(document.querySelector('dt:last-of-type')?.textContent === 'Group key', 'the key comes last');
    page.view.click(page.view.button('Leave Group'));
    await settle();
    assert.equal(page.view.dialogName(), 'Leave this Group?');
    page.view.click(dialogButton('Cancel')!);
  } finally { page.stop(); }

  // The only Group Manager is told what leaving does to the Group.
  const world: World = { ...base, members: [me, person('u3', 'Sam Okafor')] };
  world.after = (method) => { if (method === 'DELETE') world.role = null; };
  const calls = serve(world);
  page = open('/groups/g1');
  try {
    await loaded();
    assert.equal(dd('Managed by'), 'you · 2 people');
    page.view.click(page.view.button('Leave Group'));
    await settle();
    assert.equal(page.view.dialogName(), 'Leave, and leave nobody managing this Group?');
    assert.match(page.view.dialog()!.textContent!, /until a system administrator promotes one of its members/);
    await settle(() => dialogButton('Leave')!.click()); await loaded();
    assert.deepEqual(writes(calls), ['DELETE /api/groups/g1/membership'], 'leaving is its own route');
    assert.equal(page.router.state.location.pathname, '/groups', 'and it always ends on the Groups list');
  } finally { page.stop(); }

  serve({ ...base, members: [me].map((p) => ({ ...p, role: 'member' as const })), role: 'member' });
  page = open('/groups/g1');
  try {
    await loaded();
    assert.equal(dd('Managed by'), 'Nobody · 1 person');
  } finally { page.stop(); }
});






/** The open Add people dialog, read and driven the way a person would. */
const addDialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const addButton = () => [...addDialog()!.querySelectorAll('button')]
  .find((button) => /^Add as/.test(button.textContent!)) as HTMLButtonElement;
const radio = (name: string) => [...addDialog()!.querySelectorAll('label')]
  .find((label) => label.textContent!.includes(name))!.querySelector('input') as HTMLInputElement;
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function search(text: string) {
  type(addDialog()!.querySelector('input[type="search"]')!, text);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await loaded();
}



test('GS1 prefixes: every member reads them, and only a Group Manager is offered a change', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const role of ['member', 'manager'] as const) {
    serve({ ...base, role });
    const page = open('/groups/g1/prefixes');
    try {
      await loaded();
      assert.match(document.body.textContent!, /4512345/);
      assert.equal(Boolean(page.view.button('Configure prefix')), role === 'manager', role);
      assert.equal(Boolean(page.view.button('Deactivate')), role === 'manager', role);
    } finally { page.stop(); }
  }
});
