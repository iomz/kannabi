import './dom';
import assert from 'node:assert/strict';
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

test('the control that narrows the navigation sits at the workspace boundary', () => {
  const view = shell('/');
  const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
  assert.ok(trigger, 'the control exists');
  // In the header, not in the brand block whose tagline it used to crowd.
  assert.ok(trigger.closest('header'), 'it is in the workspace header');
  assert.equal(trigger.closest('[data-slot="sidebar-header"]'), null);
  // Named for anybody who cannot see which way it points.
  assert.match(trigger.textContent ?? '', /Toggle Sidebar/);
  view.stop();
});

test('narrowing the navigation is a state the whole shell can see', () => {
  const view = shell('/');
  const sidebar = () => document.querySelector('[data-slot="sidebar"]');
  assert.equal(sidebar()?.getAttribute('data-state'), 'expanded');
  view.click(document.querySelector('[data-slot="sidebar-trigger"]'));
  assert.equal(sidebar()?.getAttribute('data-state'), 'collapsed');
  // Collapsed to icons rather than away: every destination stays reachable.
  assert.equal(sidebar()?.getAttribute('data-collapsible'), 'icon');
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
  // The header itself stays, because the navigation control lives in it.
  assert.ok(document.querySelector('[data-slot="sidebar-trigger"]'));
  settings.stop();
});
