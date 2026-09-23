import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppSidebar, activeDestination } from '../web/app-sidebar.js';
import { SidebarProvider } from '../web/components/ui/sidebar.js';

const user = { key: 'u-1', name: 'Hanako', email: 'hanako@example.test' };

function render(props: Parameters<typeof AppSidebar>[0], at = '/') {
  const router = createMemoryRouter(
    [{ path: '*', element: createElement(SidebarProvider, null, createElement(AppSidebar, props)) }],
    { initialEntries: [at] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test('the brand block holds the brand and nothing that competes with it', () => {
  const markup = render({ user, isAdmin: false, avatarHash: null, busy: false });
  // The tagline was being squeezed into an ellipsis by a control sharing its
  // row. The control moved to the boundary, so the whole phrase is present.
  assert.match(markup, />Identity &amp; inventory</);
  assert.match(markup, />v[\w.]+</, 'the instance says which Kannabi it is');
  const header = /data-slot="sidebar-header"[\s\S]*?data-slot="sidebar-content"/.exec(markup);
  assert.ok(header, 'the header is rendered');
  assert.doesNotMatch(header[0], /Collapse|Expand|Toggle Sidebar/,
    'nothing in the brand block narrows the navigation');
});

test('Inventory is a category and Assets is the surface inside it', () => {
  const markup = render({ user, isAdmin: true, avatarHash: null, busy: false });
  for (const label of ['Inventory', 'Assets', 'Lookup', 'Groups', 'Members', 'Instance settings']) {
    assert.match(markup, new RegExp(`>${label}<`), `${label} is present`);
  }
  // The category is not a destination: there is nothing at Inventory, only
  // inside it, which is what lets another surface arrive there later.
  const links = [...markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>).)*?>([^<]+)<\/span>/gs)]
    .map(([, href, label]) => [label, href]);
  assert.ok(links.some(([label, href]) => label === 'Assets' && href === '/'), 'Assets is the destination');
  assert.ok(!links.some(([label]) => label === 'Inventory'), 'Inventory is not one');
  // Assets sits under Inventory rather than beside it.
  assert.match(markup, /data-slot="sidebar-menu-sub"/);
});

test('administration is only offered to an administrator', () => {
  const ordinary = render({ user, isAdmin: false, avatarHash: null, busy: false });
  assert.doesNotMatch(ordinary, />Members</);
  assert.doesNotMatch(ordinary, />Instance settings</);
});

test('the account opens over the shell rather than growing the footer', () => {
  const markup = render({ user, isAdmin: true, avatarHash: null, busy: false });
  // A disclosure expands in place and pushes the avatar up the screen as it
  // opens; a menu is anchored, so the trigger stays where it was clicked.
  assert.doesNotMatch(markup, /<details/);
  assert.match(markup, /data-slot="dropdown-menu-trigger"/);
  assert.match(markup, /aria-label="Account menu"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, />Hanako</);
});

test('a signed-out shell offers sign-in instead of an account', () => {
  const markup = render({ user: null, isAdmin: false, avatarHash: null, busy: false }, '/lookup');
  assert.match(markup, />Sign in</);
  assert.doesNotMatch(markup, /aria-label="Account menu"/);
  // Except on the sign-in page itself, where it would point at the page.
  assert.doesNotMatch(render({ user: null, isAdmin: false, avatarHash: null, busy: false }, '/signin'), />Sign in</);
});

test('Asset detail and reporting belong to the inventory, not to Lookup', () => {
  assert.equal(activeDestination('/'), '/');
  assert.equal(activeDestination('/asset/0199-abc'), '/');
  assert.equal(activeDestination('/assets/report'), '/');
  assert.equal(activeDestination('/lookup'), '/lookup');
  assert.equal(activeDestination('/groups'), '/groups');
  assert.equal(activeDestination('/admin/members'), '/admin/members');
  assert.equal(activeDestination('/settings'), null);
});

/** Opening the menu is the only way to find out whether it composes.
 *
 * A menu is anchored in a portal, so nothing of it exists until it is opened:
 * a shell that mounts, and a trigger that renders, say nothing about what
 * happens when somebody clicks. A mis-composed part throws during that render,
 * and React Router reports it at the root — which is how this surfaced, as the
 * whole application replaced by its Connection Error page.
 */
function open(props: Parameters<typeof AppSidebar>[0], at = '/') {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const router = createMemoryRouter(
    [{ path: '*', element: createElement(SidebarProvider, null, createElement(AppSidebar, props)) }],
    { initialEntries: [at] });
  act(() => { root.render(createElement(RouterProvider, { router })); });
  act(() => { document.querySelector<HTMLElement>('[aria-label="Account menu"]')?.click(); });
  return {
    items: () => [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
      .map((node) => node.textContent?.trim()),
    link: (name: string) => [...document.querySelectorAll('a')]
      .find((node) => node.textContent?.trim() === name) ?? null,
    text: () => document.body.textContent ?? '',
    stop: () => { act(() => root.unmount()); host.remove(); },
  };
}

test('the account menu opens and offers the account’s own destinations', () => {
  const view = open({ user, isAdmin: true, avatarHash: null, busy: false });
  assert.deepEqual(view.items(), ['View profile', 'Settings', 'Sign out']);
  // The identity the menu belongs to is stated in it, not left to the avatar.
  assert.match(view.text(), /hanako@example\.test/);
  assert.match(view.text(), /System administrator/);
  view.stop();
});

test('View profile reaches this account’s own User page', () => {
  const view = open({ user, isAdmin: false, avatarHash: null, busy: false });
  const profile = view.link('View profile');
  assert.ok(profile, 'the destination is a link, so it can be opened in a new tab');
  assert.equal(profile.getAttribute('href'), `/users/${user.key}`);
  assert.equal(view.link('Settings')?.getAttribute('href'), '/settings');
  // Signing out is an action, not a destination, so it is deliberately not one.
  assert.equal(view.link('Sign out'), null);
  view.stop();
});

test('an ordinary member is not told they are an administrator', () => {
  const view = open({ user, isAdmin: false, avatarHash: null, busy: false });
  assert.doesNotMatch(view.text(), /System administrator/);
  view.stop();
});

test('narrowing the navigation leaves every surface reachable', () => {
  // A category has nothing to show in a column of icons, so its surfaces stand
  // in its place; collapsing must not take Assets away with Inventory.
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const router = createMemoryRouter([{
    path: '*',
    element: createElement(SidebarProvider, { defaultOpen: false } as never,
      createElement(AppSidebar, { user, isAdmin: false, avatarHash: null, busy: false })),
  }], { initialEntries: ['/'] });
  act(() => { root.render(createElement(RouterProvider, { router })); });

  const labels = [...document.querySelectorAll('[data-slot="sidebar-menu-button"] span')]
    .map((node) => node.textContent);
  assert.ok(labels.includes('Assets'), 'Assets is a destination in its own right');
  assert.ok(!labels.includes('Inventory'), 'and the category it belongs to is not shown');
  assert.equal(document.querySelector('[data-slot="sidebar-menu-sub"]'), null);
  act(() => root.unmount());
  host.remove();
});
