import './dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppSidebar } from '../web/app-sidebar.js';
import { WorkspaceHeader } from '../web/workspace-header.js';
import { SidebarInset, SidebarProvider } from '../web/components/ui/sidebar.js';
import { Toaster } from '../web/components/ui/sonner.js';
import { mount, withTheme } from './dom-render.js';

const user = { key: 'u-1', name: 'Hanako', email: 'hanako@example.test' };

/** The whole shell, assembled the way the root route assembles it. */
function shell(at: string, { search = true, isAdmin = false } = {}) {
  const element = createElement(SidebarProvider, null,
    createElement(AppSidebar, { user, isAdmin, avatarHash: null, busy: false }),
    createElement(SidebarInset, null,
      createElement(WorkspaceHeader, { enabled: true, search })),
    createElement(Toaster, { seconds: 5 }));
  return mount(withTheme(createElement(RouterProvider, {
    router: createMemoryRouter([{ path: '*', element }], { initialEntries: [at] }),
  })));
}

test('the shell mounts as one piece, with navigation and workspace beside each other', () => {
  const view = shell('/');
  assert.ok(document.querySelector('[data-slot="sidebar"]'), 'the navigation is present');
  assert.ok(document.querySelector('[data-slot="sidebar-inset"]'), 'the workspace is present');
  // Sonner's region is present from the start and holds nothing until there is
  // something to say, which is why it is the region and not a toast.
  assert.ok(document.querySelector('section[aria-live="polite"]'), 'and one place for messages');
  view.stop();
});

test('the navigation carries the control that narrows it', () => {
  const view = shell('/');
  const trigger = document.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]');
  assert.ok(trigger, 'there is a visible control');
  // It belongs to the navigation by construction: it is inside it, in its own
  // header, and nothing of it sits in the workspace beside the search field.
  assert.ok(trigger.closest('[data-slot="sidebar-header"]'), 'the control is in the navigation');
  assert.equal(trigger.closest('header'), null, 'and not in the workspace');
  assert.match(trigger.textContent ?? '', /Toggle Sidebar/, 'named for anybody who cannot see it');

  assert.equal(document.querySelector('[data-slot="sidebar-rail"]'), null,
    'no boundary rail duplicates the explicit control');
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
  // The same control puts it back, and it is still there to be clicked —
  // narrowing the navigation must not take away the way to widen it.
  const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
  assert.ok(trigger?.closest('[data-slot="sidebar-header"]'), 'still in the navigation');
  view.click(trigger);
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
