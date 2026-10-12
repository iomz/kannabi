import './dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Help, { clientLoader, handle } from '../web/routes/help.js';
import { activeDestination } from '../web/app-sidebar.js';
import { isPublicShellHandle } from '../web/anonymous-shell.js';
import { mount } from './dom-render.js';

function show(directory: 'everyone' | 'names' | 'shared') {
  const router = createMemoryRouter([{ path: '/help',
    element: createElement(Help, { loaderData: { directory } } as never) }], { initialEntries: ['/help'] });
  return { view: mount(createElement(RouterProvider, { router })), router };
}

test('Help explains the two roles with the verified table, and this instance’s directory', () => {
  const { view, router } = show('everyone');
  try {
    const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent);
    for (const topic of ['What Kannabi does', 'Assets and Inventory', 'Groups', 'Member and Group Manager',
      'Adding people', 'People and email addresses']) assert.ok(headings.includes(topic), topic);
    assert.ok(!headings.includes('The member key'), 'no member key while anybody can be found by name');
    assert.match(view.text(), /Everybody in a Group is a member/);
    const rows = Object.fromEntries([...document.querySelectorAll('tbody tr')].map((row) => [
      row.querySelector('th')!.textContent, [...row.querySelectorAll('td')].map((cell) => cell.textContent)]));
    // A Group Manager is a member who also manages: every member capability,
    // and the management ones besides.
    assert.deepEqual(rows['Read and edit the Group’s private Assets'], ['Yes', 'Yes']);
    assert.deepEqual(rows['See everybody in the Group and their role'], ['Yes', 'Yes']);
    assert.deepEqual(rows['Add or remove people'], ['No', 'Yes']);
    assert.deepEqual(rows['Make someone a Group Manager, or remove the role'], ['No', 'Yes']);
    assert.deepEqual(rows['Manage the Group’s GS1 Company Prefixes'], ['No', 'Yes']);
    assert.match(view.text(), /can find everybody else, by name or email/);
  } finally { view.stop(); router.dispose(); }

  const shared = show('shared');
  try {
    assert.match(shared.view.text(), /add anybody else by member key/);
    assert.ok([...document.querySelectorAll('h2')].some((h) => h.textContent === 'The member key'));
  } finally { shared.view.stop(); shared.router.dispose(); }
});

test('Help is reachable from the navigation and readable signed out', async (t) => {
  assert.equal(activeDestination('/help'), '/help');
  assert.match(readFileSync('web/app-sidebar.tsx', 'utf8'), /\{ to: '\/help', icon: 'info', label: 'Help' \}/);
  assert.match(readFileSync('web/routes.ts', 'utf8'), /route\('help', 'routes\/help\.tsx'\)/);
  assert.ok(isPublicShellHandle(handle));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({ settings: { peopleDirectory: 'names' } }),
    { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await clientLoader(), { directory: 'names' });
});
