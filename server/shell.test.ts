import './dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppSidebar } from '../web/app-sidebar.js';
import { WorkspaceHeader } from '../web/workspace-header.js';
import { SidebarInset, SidebarProvider } from '../web/components/ui/sidebar.js';
import { Toaster } from '../web/components/ui/toast.js';
import { mount } from './dom-render.js';

const user = { key: 'u-1', name: 'Hanako', email: 'hanako@example.test' };

/** The whole shell, assembled the way the root route assembles it. */
function shell(at: string, { search = true, isAdmin = false } = {}) {
  const element = createElement(Toaster, { timeout: 5000 },
    createElement(SidebarProvider, null,
      createElement(AppSidebar, { user, isAdmin, avatarHash: null, busy: false }),
      createElement(SidebarInset, null,
        createElement(WorkspaceHeader, { enabled: true, search }))));
  return mount(createElement(RouterProvider, {
    router: createMemoryRouter([{ path: '*', element }], { initialEntries: [at] }),
  }));
}

test('the shell mounts as one piece, with navigation and workspace beside each other', () => {
  const view = shell('/');
  assert.ok(document.querySelector('[data-slot="sidebar"]'), 'the navigation is present');
  assert.ok(document.querySelector('[data-slot="sidebar-inset"]'), 'the workspace is present');
  assert.ok(document.querySelector('[data-slot="toast-viewport"]'), 'and one place for messages');
  view.stop();
});

test('the navigation is narrowed by its own rail, not by a control in the workspace', () => {
  const view = shell('/');
  const rail = document.querySelector<HTMLButtonElement>('[data-slot="sidebar-rail"]');
  assert.ok(rail, 'the rail is present');
  // It belongs to the navigation by construction: it is inside it.
  assert.ok(rail.closest('[data-slot="sidebar"]'), 'the rail is part of the navigation');
  assert.equal(rail.closest('header'), null, 'and nothing of it is in the workspace');
  // Named and reachable: a pointer finds it on the boundary, a keyboard finds
  // it in the tab order, and either way it says what it does.
  assert.equal(rail.getAttribute('aria-label'), 'Toggle Sidebar');
  assert.equal(rail.tabIndex, 0);
  // On a wide screen the workspace header carries no sidebar control at all.
  assert.equal(document.querySelector('header [data-slot="sidebar-trigger"]'), null);
  view.stop();
});

test('narrowing the navigation is a state the whole shell can see', () => {
  const view = shell('/');
  const sidebar = () => document.querySelector('[data-slot="sidebar"]');
  assert.equal(sidebar()?.getAttribute('data-state'), 'expanded');
  view.click(document.querySelector('[data-slot="sidebar-rail"]'));
  assert.equal(sidebar()?.getAttribute('data-state'), 'collapsed');
  // Collapsed to icons rather than away: every destination stays reachable.
  assert.equal(sidebar()?.getAttribute('data-collapsible'), 'icon');
  // And the same control puts it back, so nothing has to be found elsewhere.
  view.click(document.querySelector('[data-slot="sidebar-rail"]'));
  assert.equal(sidebar()?.getAttribute('data-state'), 'expanded');
  view.stop();
});

test('Asset search is offered where looking an Asset up is the thing to do', () => {
  const workspace = shell('/');
  assert.ok(document.querySelector('[role="search"]'), 'the inventory has search');
  workspace.stop();

  // Settings and Administration are management contexts; a search toolbar over
  // them reads as leftover workspace chrome.
  const settings = shell('/settings', { search: false });
  assert.equal(document.querySelector('[role="search"]'), null);
  // With nothing to put in it, the bar itself goes rather than leaving a rule
  // across the top of the page.
  assert.equal(document.querySelector('header'), null);
  settings.stop();
});

test('a narrow screen keeps the only way into the navigation it has', () => {
  // There is no rail on a phone: the navigation is a sheet that is not on the
  // page until it is asked for, and the workspace header is the only place
  // left to ask from.
  const header = readFileSync('web/workspace-header.tsx', 'utf8');
  assert.match(header, /\{isMobile && <>[\s\S]*?<SidebarTrigger/,
    'the trigger is offered exactly where the rail cannot reach');
  assert.match(header, /if \(!search && !isMobile\) return null;/);
});
