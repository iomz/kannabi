import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
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

test('every destination keeps a name when the navigation is narrowed', () => {
  const markup = render({ user, isAdmin: true, avatarHash: null, busy: false });
  for (const label of ['Inventory', 'Lookup', 'Groups', 'Members', 'Instance settings']) {
    assert.match(markup, new RegExp(`>${label}<`), `${label} is reachable`);
  }
  // Collapsing hides the words, so each destination carries its own tooltip
  // rather than becoming an unnamed icon.
  const buttons = markup.match(/data-slot="sidebar-menu-button"/g) ?? [];
  assert.ok(buttons.length >= 6, 'the brand, five destinations and the account are all menu buttons');
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
  // The menu itself is anchored in a portal and only exists once opened, so
  // what is asserted here is the trigger and its resting state.
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
